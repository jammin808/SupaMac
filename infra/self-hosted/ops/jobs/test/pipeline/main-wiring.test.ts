// The service as main() composes it: given neither a notifier nor intakes,
// startService makes the Telegram bot the owner's notifier and starts both
// ways in. Only the transports are fakes (the Bot API, the IMAP server,
// SupaMac's store and the model); what picks and wires the real parts is
// the code that ships.

import { sleep } from 'bun';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '../../src/log';
import { type Service, startService } from '../../src/main';
import type { EnsureSchemaResult, JobsPins } from '../../src/supamac/schema';
import { extract } from '../../src/text/extract';
import { FakeImapServer, loginRefused } from '../mail/fake-imap';
import { SIG_B } from '../mail/fixtures';
import { FakeBotApi, OWNER, TOKEN } from '../telegram/fake-bot-api';
import { EMAIL_REPLY, INVITE_PDF_REPLY, inviteEmail } from './fixtures';
import { ScriptedModel } from './harness';
import { MemoryStore, OWNER_USER, SERVICE_USER } from './memory-store';

const ENV = {
  JOBS_SUPAMAC_API_KEY: 'test-api-key-not-real', // secret-scan: fixture
  JOBS_OWNER_EMAIL: 'sam.price@example.com',
  ANTHROPIC_API_KEY: 'sk-ant-api03-example-key', // secret-scan: fixture
  JOBS_MONTHLY_LIMIT_USD: '20',
  JOBS_TELEGRAM_BOT_TOKEN: TOKEN,
  JOBS_TELEGRAM_OWNER_ID: String(OWNER),
  JOBS_MAIL_HOST: 'imap.example.com',
  JOBS_MAIL_USER: 'Jobs@example.com',
  JOBS_MAIL_PASSWORD: 'app-password-not-real-0003', // secret-scan: fixture
  JOBS_MAIL_AUTHSERV_ID: 'mx.example.com',
  JOBS_MAIL_ALLOWED_SENDERS: 'jo@acme-productions.example.com',
};

const services: Service[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function until(
  condition: () => boolean,
  what: string,
  ms = 10_000
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

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

function pinsOf(store: MemoryStore): JobsPins {
  return {
    version: 1,
    serviceUserId: SERVICE_USER,
    ownerUserId: OWNER_USER,
    databaseId: store.schema.databaseId,
    databaseCreatedAt: '2027-03-01T09:00:00.000Z',
    complete: true,
    tables: {},
    views: {},
    folders: {
      intake: store.schema.folders.intake,
      sources: store.schema.folders.sources,
    },
  };
}

async function startWired(
  store: MemoryStore,
  bot: FakeBotApi,
  mail: FakeImapServer,
  model: ScriptedModel
): Promise<Service> {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-wiring-'));
  dirs.push(dir);
  const service = await startService({
    env: { ...ENV, JOBS_STATE_DIR: dir },
    logger: new Logger({ sink: () => undefined }),
    store: () => store,
    ensureSchema: async (input): Promise<EnsureSchemaResult> => {
      const pins = pinsOf(store);
      await input.save(pins);
      return {
        pins,
        schema: store.schema,
        changes: [],
        notes: ['a schema note for the owner'],
      };
    },
    messages: model,
    extract: (bytes, hint) => extract(bytes, hint),
    telegramFetch: bot.fetch,
    mailConnect: () => mail.factory(),
    mailPollMs: 10,
    loops: false,
    listen: false,
  });
  services.push(service);
  return service;
}

describe('the service as main() wires it', () => {
  test('the bot is the owner’s notifier, both ways in start, and forwarded mail reaches the Jobs database', async () => {
    const store = new MemoryStore();
    const bot = new FakeBotApi();
    const mail = new FakeImapServer();
    const model = new ScriptedModel([
      { marker: 'S1: "Leeds Lights Gala - booking"', reply: EMAIL_REPLY },
      { marker: 'S1: "invite.pdf"', reply: INVITE_PDF_REPLY },
    ]);
    const first = mail.deliver(delivered());
    await startWired(store, bot, mail, model);

    // The schema's note went to the owner through the bot.
    expect(
      bot.sent.some(
        (m) =>
          m.chatId === OWNER && m.text.includes('a schema note for the owner')
      )
    ).toBe(true);
    // The Telegram way in polls.
    await until(
      () => bot.calls.some((c) => c.method === 'getUpdates'),
      'the bot’s first poll'
    );
    // The mailbox way in reads the forward into the Jobs database.
    await until(
      () => mail.uids('Processed').includes(first),
      'the forwarded email'
    );
    const sources = store.rows('sources').map(([, v]) => [v.Name, v.Via]);
    expect(sources).toContainEqual(['Leeds Lights Gala - booking', 'Email']);
    // Its summary reached the owner through the bot as well.
    await until(
      () =>
        bot.sent.some(
          (m) => m.chatId === OWNER && m.text.includes('Leeds Lights Gala')
        ),
      'the summary'
    );
  });

  test('a refused mailbox login is the Status row’s last error', async () => {
    const store = new MemoryStore();
    const bot = new FakeBotApi();
    const mail = new FakeImapServer();
    mail.connectError = loginRefused();
    const service = await startWired(store, bot, mail, new ScriptedModel([]));
    await until(() => mail.count('connect') > 0, 'the login');
    await until(
      () =>
        service.health.report().loops.some((l) => l.lastError !== undefined),
      'the failed poll'
    );
    await service.tick();
    const values = store.rows('status')[0]?.[1] as Record<string, unknown>;
    expect(String(values['Last error'])).toContain(
      'mail: the mailbox refused the login'
    );
    expect(String(values['Last error'])).not.toContain(ENV.JOBS_MAIL_PASSWORD);
  });
});
