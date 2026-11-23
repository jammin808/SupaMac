// The mail intake as main.ts starts it: settings to policy and proxy, and a
// forwarded booking email through the fake mailbox and the real pipeline
// (in-memory SupaMac, scripted model, in-process extraction).

import { sleep as pause } from 'bun';
import { afterEach, describe, expect, test } from 'bun:test';
import { loadConfig } from '../../src/config';
import {
  egressProxy,
  MailIntake,
  mailIntakes,
  mailPolicy,
} from '../../src/mail/index';
import type { IntakeContext } from '../../src/pipeline/intake';
import { extract } from '../../src/text/extract';
import {
  EMAIL_REPLY,
  INVITE_PDF_REPLY,
  inviteEmail,
} from '../pipeline/fixtures';
import { cleanup, makeWorld, type World } from '../pipeline/harness';
import { FakeImapServer, loginRefused } from './fake-imap';
import { SIG_B } from './fixtures';

const PASSWORD = 'app-password-not-real-0002'; // secret-scan: fixture

const ENV = {
  JOBS_SUPAMAC_API_KEY: 'test-api-key-not-real', // secret-scan: fixture
  JOBS_OWNER_EMAIL: 'sam.price@example.com',
  ANTHROPIC_API_KEY: 'sk-ant-api03-example-key', // secret-scan: fixture
  JOBS_MONTHLY_LIMIT_USD: '20',
  JOBS_MAIL_HOST: 'imap.example.com',
  JOBS_MAIL_USER: 'Jobs@example.com',
  JOBS_MAIL_PASSWORD: PASSWORD,
  JOBS_MAIL_AUTHSERV_ID: 'mx.example.com',
  JOBS_MAIL_ALLOWED_SENDERS: 'jo@acme-productions.example.com',
};

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await cleanup(w);
});

/** The booking email as the provider delivers it: its results and the sender's signature on top. */
function delivered(): Uint8Array {
  const head = [
    'Authentication-Results: mx.example.com;',
    '       dkim=pass header.i=@acme-productions.example.com header.s=s1 header.b=AbCdEf12;',
    '       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=acme-productions.example.com',
    'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=acme-productions.example.com; s=s1;',
    `        h=from:to:subject:date:message-id; bh=eA==; b=${SIG_B}`,
    '',
  ].join('\r\n');
  const head8 = new TextEncoder().encode(head);
  const body = inviteEmail();
  const out = new Uint8Array(head8.length + body.length);
  out.set(head8);
  out.set(body, head8.length);
  return out;
}

async function until(
  condition: () => boolean,
  what: string,
  ms = 10_000
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return;
    await pause(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function contextOf(w: World, signal: AbortSignal): IntakeContext {
  return {
    pipeline: w.pipeline,
    ai: w.ctx.ai,
    state: w.state,
    notifier: w.notifier,
    logger: w.ctx.logger,
    config: loadConfig({ ...ENV, JOBS_STATE_DIR: w.dir }),
    health: w.ctx.health,
    clock: w.ctx.clock,
    timeZone: w.ctx.timeZone,
    signal,
  };
}

describe('the mail intake', () => {
  test('reads a forwarded booking through the pipeline, files it, and a second forward only once', async () => {
    const w = await makeWorld(
      [
        { marker: 'S1: "Leeds Lights Gala - booking"', reply: EMAIL_REPLY },
        { marker: 'S1: "invite.pdf"', reply: INVITE_PDF_REPLY },
      ],
      { extract: (bytes, hint) => extract(bytes, hint) }
    );
    worlds.push(w);
    const config = loadConfig({ ...ENV, JOBS_STATE_DIR: w.dir });
    const server = new FakeImapServer();
    const first = server.deliver(delivered());
    const intake = new MailIntake({
      settings: config.mail as NonNullable<typeof config.mail>,
      connect: () => server.factory(),
      pollMs: 10,
    });
    const abort = new AbortController();
    await intake.start(contextOf(w, abort.signal));
    await until(
      () =>
        server.uids('Processed').includes(first) &&
        w.state.value.health.connections.mail !== undefined,
      'the first message and the mailbox’s health'
    );
    const sources = w.store.rows('sources').map(([, v]) => v);
    expect(sources.map((s) => [s.Name, s.Via, s.Status])).toEqual([
      ['Leeds Lights Gala - booking', 'Email', 'Processed'],
      ['invite.pdf', 'Email', 'Needs review'],
    ]);
    expect(sources[0]?.From).toBe('jo@acme-productions.example.com');
    expect(w.state.value.health.connections.mail?.up).toBe(true);

    // The same email forwarded again is recorded once and filed too.
    w.now += 10_000;
    const second = server.deliver(delivered());
    await until(
      () => server.uids('Processed').includes(second),
      'the second message'
    );
    expect(w.store.rows('sources')).toHaveLength(2);
    expect(w.model.count('S1: "Leeds Lights Gala - booking"')).toBe(1);

    await intake.stop();
    expect(server.count('logout')).toBe(1);
    const commands = server.commands.length;
    await pause(30);
    expect(server.commands.length).toBe(commands);
    expect(w.lines.join('\n')).not.toContain(PASSWORD);
  });

  test('a mailbox that refuses the login keeps the service up, says so, and stops cleanly', async () => {
    const w = await makeWorld([], {
      extract: (bytes, hint) => extract(bytes, hint),
    });
    worlds.push(w);
    const config = loadConfig({ ...ENV, JOBS_STATE_DIR: w.dir });
    const server = new FakeImapServer();
    server.connectError = loginRefused();
    const intake = new MailIntake({
      settings: config.mail as NonNullable<typeof config.mail>,
      connect: () => server.factory(),
      pollMs: 10,
    });
    const abort = new AbortController();
    await intake.start(contextOf(w, abort.signal));
    await until(
      () => w.notifier.of('connection').length > 0,
      'the connection note'
    );
    expect(w.notifier.of('connection')).toEqual([
      {
        connection: 'mail',
        up: false,
        since: new Date(w.now).toISOString(),
        detail:
          'the mailbox refused the login: check JOBS_MAIL_USER and JOBS_MAIL_PASSWORD (an app password)',
      },
    ]);
    await intake.stop();
    expect(server.count('connect')).toBe(1);
  });

  test('checks the login for the setup document, before or after it starts', async () => {
    const config = loadConfig(ENV);
    const server = new FakeImapServer();
    const intake = new MailIntake({
      settings: config.mail as NonNullable<typeof config.mail>,
      connect: () => server.factory(),
    });
    expect(await intake.check()).toEqual({
      setting: 'Mailbox login',
      ok: true,
      text: 'logged in to imap.example.com; mail from 1 allowed sender is read',
    });
  });
});

describe('the mail settings', () => {
  test('the jobs address is JOBS_MAIL_USER when it is an address', () => {
    const config = loadConfig(ENV);
    const mail = config.mail as NonNullable<typeof config.mail>;
    expect(mailPolicy(mail)).toEqual({
      authservId: 'mx.example.com',
      allowedSenders: ['jo@acme-productions.example.com'],
      jobsAddresses: ['jobs@example.com'],
    });
    expect(mailPolicy({ ...mail, user: 'jobs' }).jobsAddresses).toEqual([]);
  });

  test('the intake exists only when the mailbox settings are all there', () => {
    expect(mailIntakes(loadConfig(ENV), {}).map((i) => i.name)).toEqual([
      'mail',
    ]);
    const { JOBS_MAIL_AUTHSERV_ID: _gone, ...partial } = ENV;
    expect(mailIntakes(loadConfig(partial), {})).toEqual([]);
  });

  test('the egress proxy is HTTPS_PROXY unless NO_PROXY covers the mailbox', () => {
    const host = 'imap.example.com';
    expect(egressProxy({}, host)).toBeUndefined();
    expect(egressProxy({ HTTPS_PROXY: 'http://egress-proxy:3128' }, host)).toBe(
      'http://egress-proxy:3128'
    );
    expect(
      egressProxy({ https_proxy: 'socks5://egress-proxy:1080' }, host)
    ).toBe('socks5://egress-proxy:1080');
    expect(
      egressProxy(
        {
          HTTPS_PROXY: 'http://egress-proxy:3128',
          NO_PROXY: 'gateway, .example.com',
        },
        host
      )
    ).toBeUndefined();
    expect(
      egressProxy(
        { HTTPS_PROXY: 'http://egress-proxy:3128', NO_PROXY: 'gateway' },
        host
      )
    ).toBe('http://egress-proxy:3128');
  });

  test('a proxy setting imapflow cannot use stops the start without repeating it', () => {
    const secret = 'http://user:proxy-secret@egress-proxy:3128';
    expect(() =>
      egressProxy(
        { HTTPS_PROXY: secret.replace('http', 'ftp') },
        'imap.example.com'
      )
    ).toThrow('HTTPS_PROXY must be an http, https or socks proxy URL');
    try {
      egressProxy(
        { HTTPS_PROXY: 'not a url proxy-secret' },
        'imap.example.com'
      );
      throw new Error('accepted');
    } catch (error) {
      expect(String(error)).not.toContain('proxy-secret');
      expect((error as { kind?: string }).kind).toBe('proxy');
    }
  });
});
