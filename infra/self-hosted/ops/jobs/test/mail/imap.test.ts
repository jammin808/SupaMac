import { sleep as pause } from 'bun';
import { describe, expect, test } from 'bun:test';
import { Logger } from '../../src/log';
import {
  checkLogin,
  classifyMailError,
  type EmailSink,
  type MailHealth,
  MailboxReader,
  MAX_MESSAGE_BYTES,
  placementOf,
  type Sleep,
} from '../../src/mail/imap';
import type { Connection } from '../../src/pipeline/notify';
import { RecordingNotifier } from '../../src/pipeline/notify';
import type { EmailInput, SourceResult } from '../../src/pipeline/process';
import {
  type FakeImapClient,
  FakeImapServer,
  headerBlockOf,
  loginRefused,
  socketError,
} from './fake-imap';
import { gmail, OWNER, POLICY, withBody } from './fixtures';

const PASSWORD = 'app-password-not-real-0001'; // secret-scan: fixture
const START = Date.parse('2027-03-01T17:01:00Z');

function finished(
  status: 'Processed' | 'Failed' | 'Needs review' | 'Not a job',
  children: SourceResult[] = []
): SourceResult {
  return { kind: 'finished', sourceId: 'src-1', status, children };
}

function waiting(): SourceResult {
  return {
    kind: 'waiting',
    sourceId: 'src-1',
    reason: 'the model is overloaded',
    paused: false,
    children: [],
  };
}

function duplicate(
  status?: 'Processed' | 'Failed' | 'Processing'
): SourceResult {
  return {
    kind: 'duplicate',
    sourceId: 'src-1',
    ...(status !== undefined ? { status } : {}),
    children: [],
  };
}

class FakePipeline implements EmailSink {
  readonly inputs: EmailInput[] = [];
  readonly results: (SourceResult | Error)[] = [];
  async processEmail(input: EmailInput): Promise<SourceResult> {
    this.inputs.push(input);
    const next = this.results.shift() ?? finished('Processed');
    if (next instanceof Error) throw next;
    return next;
  }
}

class FakeHealth implements MailHealth {
  readonly loops: string[] = [];
  readonly connections: {
    name: Connection;
    up: boolean;
    detail?: string | undefined;
  }[] = [];
  succeeded(name: string): void {
    this.loops.push(`ok ${name}`);
  }
  failed(name: string, error: string): void {
    this.loops.push(`failed ${name}: ${error}`);
  }
  async connection(
    name: Connection,
    up: boolean,
    detail?: string
  ): Promise<void> {
    this.connections.push({ name, up, detail });
  }
}

function setup(options: { sleep?: Sleep; maxPerPoll?: number } = {}) {
  const server = new FakeImapServer();
  const pipeline = new FakePipeline();
  const notifier = new RecordingNotifier();
  const health = new FakeHealth();
  const lines: string[] = [];
  const logger = new Logger({ sink: (l) => lines.push(l), level: 'debug' });
  logger.addSecret(PASSWORD);
  const clock = { now: START };
  const reader = new MailboxReader({
    host: 'imap.example.com',
    policy: POLICY,
    connect: server.factory(),
    pipeline,
    notifier,
    health,
    logger,
    clock: () => new Date(clock.now),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    ...(options.maxPerPoll !== undefined
      ? { maxPerPoll: options.maxPerPoll }
      : {}),
  });
  return { server, pipeline, notifier, health, lines, logger, clock, reader };
}

const GOOD = withBody(gmail());
const STRANGER = withBody(gmail({ from: 'Mallory <mallory@example.net>' }));

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await pause(2);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('the mailbox reader', () => {
  test('makes its folders, hands an accepted message to the pipeline whole, and files it under Processed', async () => {
    const { server, pipeline, reader } = setup();
    const uid = server.deliver(GOOD);
    const report = await reader.poll();
    expect(report).toEqual({
      seen: 1,
      refused: 0,
      processed: 1,
      failed: 0,
      kept: 0,
      errors: 0,
    });
    expect(server.commands.filter((c) => c.op === 'create')).toEqual([
      { op: 'create', path: 'Processed' },
      { op: 'create', path: 'Refused' },
      { op: 'create', path: 'Failed' },
    ]);
    expect(server.uids('Processed')).toEqual([uid]);
    expect(server.inbox).toEqual([]);
    expect(pipeline.inputs).toHaveLength(1);
    const input = pipeline.inputs[0] as EmailInput;
    expect(Buffer.from(input.raw).equals(Buffer.from(GOOD))).toBe(true);
    expect(input.from).toBe(OWNER);
    expect(input.received).toBe('2027-03-01T17:00:05.000Z');
    // The header-only fetch never asks for the source.
    const fetch = server.commands.find((c) => c.op === 'fetch');
    expect(fetch).toEqual({
      op: 'fetch',
      range: String(uid),
      query: {
        uid: true,
        size: true,
        flags: true,
        internalDate: true,
        headers: true,
      },
    });
  });

  test('refuses on the headers alone: Refused, unread, the owner told the sender and the check, the body never fetched', async () => {
    const { server, pipeline, notifier, reader } = setup();
    const uid = server.deliver(STRANGER, { flags: ['\\Seen', '\\Flagged'] });
    const report = await reader.poll();
    expect(report.refused).toBe(1);
    expect(server.uids('Refused')).toEqual([uid]);
    expect([...(server.folder('Refused')[0]?.flags ?? [])]).toEqual([
      '\\Flagged',
    ]);
    expect(server.count('fetchOne')).toBe(0);
    expect(pipeline.inputs).toEqual([]);
    expect(notifier.of('refused')).toEqual([
      {
        from: 'mallory@example.net',
        check:
          'Sender: mallory@example.net is not in JOBS_MAIL_ALLOWED_SENDERS',
      },
    ]);
    expect(JSON.stringify(notifier.notices)).not.toContain('Leeds Lights');
  });

  test('refuses a message over 40 MB with a note, without fetching it', async () => {
    const { server, pipeline, notifier, reader } = setup();
    const uid = server.deliver(GOOD, { size: 45_000_000 });
    await reader.poll();
    expect(server.uids('Refused')).toEqual([uid]);
    expect(server.count('fetchOne')).toBe(0);
    expect(pipeline.inputs).toEqual([]);
    expect(notifier.of('refused')).toEqual([
      {
        from: OWNER,
        check: 'Size: the message is 45.0 MB, over the 40.0 MB limit',
      },
    ]);
    expect(MAX_MESSAGE_BYTES).toBe(40_000_000);
  });

  test('leaves a message in INBOX while its source is processing, and hands it over again with backoff', async () => {
    const { server, pipeline, reader, clock } = setup();
    const uid = server.deliver(GOOD);
    pipeline.results.push(waiting(), duplicate(), duplicate('Processed'));
    expect((await reader.poll()).kept).toBe(1);
    expect(server.uids('INBOX')).toEqual([uid]);
    clock.now += 30_000;
    await reader.poll();
    expect(pipeline.inputs).toHaveLength(1);
    clock.now += 31_000;
    // A recorded source with no status yet is still processing.
    expect((await reader.poll()).kept).toBe(1);
    expect(pipeline.inputs).toHaveLength(2);
    clock.now += 61_000;
    await reader.poll();
    expect(pipeline.inputs).toHaveLength(2);
    clock.now += 60_000;
    expect((await reader.poll()).processed).toBe(1);
    expect(pipeline.inputs).toHaveLength(3);
    expect(server.uids('Processed')).toEqual([uid]);
  });

  test('files under Failed when the email or one of its attachments Failed, and waits for an attachment still processing', async () => {
    const { server, pipeline, reader } = setup();
    const a = server.deliver(GOOD);
    const b = server.deliver(GOOD);
    const c = server.deliver(GOOD);
    pipeline.results.push(
      finished('Failed'),
      finished('Processed', [finished('Failed')]),
      finished('Needs review', [waiting()])
    );
    expect(await reader.poll()).toEqual({
      seen: 3,
      refused: 0,
      processed: 0,
      failed: 2,
      kept: 1,
      errors: 0,
    });
    expect(server.uids('Failed')).toEqual([a, b]);
    expect(server.uids('INBOX')).toEqual([c]);
  });

  test('a pipeline step that throws leaves the message in INBOX for later', async () => {
    const { server, pipeline, reader, clock, health } = setup();
    const uid = server.deliver(GOOD);
    pipeline.results.push(new Error('SupaMac did not answer'));
    expect((await reader.poll()).errors).toBe(1);
    expect(server.uids('INBOX')).toEqual([uid]);
    clock.now += 61_000;
    expect((await reader.poll()).processed).toBe(1);
    expect(health.connections).toEqual([]);
  });

  test('checks the full source again: a source whose headers differ from the header fetch is refused', async () => {
    const { server, pipeline, notifier, reader } = setup();
    const uid = server.deliver(STRANGER, { headers: headerBlockOf(GOOD) });
    expect((await reader.poll()).refused).toBe(1);
    expect(server.uids('Refused')).toEqual([uid]);
    expect(pipeline.inputs).toEqual([]);
    expect(notifier.of('refused')[0]?.from).toBe('mallory@example.net');
  });

  test('uses folders that are already there, under the server’s prefix', async () => {
    const { server, reader } = setup();
    server.prefix = 'INBOX.';
    for (const f of ['Processed', 'Refused', 'Failed'])
      server.folders.set(`INBOX.${f}`, []);
    const uid = server.deliver(GOOD);
    await reader.poll();
    expect(server.count('create')).toBe(0);
    expect(server.uids('INBOX.Processed')).toEqual([uid]);
  });

  test('a CREATE the server answers with an error is fine once the folder lists', async () => {
    const { server, reader } = setup();
    server.createFails = true;
    server.deliver(GOOD);
    expect((await reader.poll()).processed).toBe(1);
    expect(server.count('create')).toBe(3);
  });

  test('reads at most twenty messages a poll, oldest first', async () => {
    const { server, reader } = setup();
    const uids = Array.from({ length: 25 }, () => server.deliver(GOOD));
    expect((await reader.poll()).processed).toBe(20);
    expect(server.uids('Processed')).toEqual(uids.slice(0, 20));
    expect((await reader.poll()).processed).toBe(5);
    expect(server.uids('Processed')).toEqual(uids);
  });

  test('a message the server gives without headers is left and tried later', async () => {
    const { server, reader, clock } = setup();
    server.omitHeaders = true;
    const uid = server.deliver(GOOD);
    expect((await reader.poll()).errors).toBe(1);
    server.omitHeaders = false;
    clock.now += 61_000;
    await reader.poll();
    expect(server.uids('Processed')).toEqual([uid]);
  });

  test('a new UIDVALIDITY forgets every backoff', async () => {
    const { server, pipeline, reader } = setup();
    server.deliver(GOOD);
    pipeline.results.push(waiting());
    await reader.poll();
    server.uidValidity = 8n;
    expect((await reader.poll()).processed).toBe(1);
    expect(pipeline.inputs).toHaveLength(2);
  });

  test('a refusal the notifier could not deliver stays in INBOX until it is told, then moves, told once', async () => {
    const { server, notifier, reader, clock } = setup();
    notifier.failing = true;
    const a = server.deliver(STRANGER);
    const b = server.deliver(STRANGER);
    const good = server.deliver(GOOD);
    // The first note fails; the second waits for the next try; good mail
    // after them is read.
    expect(await reader.poll()).toEqual({
      seen: 3,
      refused: 0,
      processed: 1,
      failed: 0,
      kept: 0,
      errors: 2,
    });
    expect(server.uids('INBOX')).toEqual([a, b]);
    expect(server.uids('Processed')).toEqual([good]);
    expect(server.uids('Refused')).toEqual([]);
    notifier.failing = false;
    // Not before its backoff.
    expect((await reader.poll()).seen).toBe(0);
    clock.now += 61_000;
    expect((await reader.poll()).refused).toBe(2);
    expect(server.uids('Refused')).toEqual([a, b]);
    clock.now += 61_000;
    await reader.poll();
    expect(notifier.of('refused')).toHaveLength(2);
  });

  test('a refusal whose note was told but whose move failed is not told again', async () => {
    const { server, notifier, reader, clock } = setup();
    const uid = server.deliver(STRANGER);
    server.unmovable.add(uid);
    expect((await reader.poll()).errors).toBe(1);
    expect(notifier.of('refused')).toHaveLength(1);
    server.unmovable.delete(uid);
    notifier.failing = true;
    clock.now += 61_000;
    expect((await reader.poll()).refused).toBe(1);
    expect(server.uids('Refused')).toEqual([uid]);
  });

  test('a message whose FETCH the server refuses is left, the rest are read, and the owner is told once after three tries', async () => {
    const { server, pipeline, notifier, reader, clock } = setup();
    const bad = server.deliver(GOOD);
    const good = server.deliver(GOOD);
    const client = (): FakeImapClient => server.client as FakeImapClient;
    const no = (): Error =>
      Object.assign(new Error('Command failed'), {
        responseStatus: 'NO',
        responseText: 'Some messages could not be FETCHed (Failure)',
      });
    server.beforeFetch = (range) => {
      if (range.split(',').map(Number).includes(bad)) throw no();
    };
    const first = await reader.poll();
    expect(first).toMatchObject({ seen: 1, processed: 1, errors: 1 });
    expect(server.uids('Processed')).toEqual([good]);
    expect(pipeline.inputs).toHaveLength(1);
    expect(client().usable).toBe(true);
    // The batch, then each message alone.
    expect(
      server.commands.flatMap((c) => (c.op === 'fetch' ? [c.range] : []))
    ).toEqual([`${bad},${good}`, String(bad), String(good)]);
    for (const wait of [61_000, 121_000, 241_000, 481_000]) {
      clock.now += wait;
      expect((await reader.poll()).errors).toBe(1);
    }
    expect(server.uids('INBOX')).toEqual([bad]);
    const notes = notifier.of('note');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind).toBe('error');
    expect(notes[0]?.text).toContain(
      'the mailbox would not give its header block (3 tries)'
    );
    // A refused FETCH is not the mailbox failing: the session is kept.
    expect(server.count('connect')).toBe(1);
  });

  test('a message whose source the server refuses is left, naming its sender after three tries', async () => {
    const { server, pipeline, notifier, reader, clock } = setup();
    const bad = server.deliver(GOOD);
    const good = server.deliver(GOOD);
    server.beforeFetchOne = (range) => {
      if (Number(range) === bad)
        throw Object.assign(new Error('Command failed'), {
          responseStatus: 'NO',
        });
    };
    expect(await reader.poll()).toMatchObject({ processed: 1, errors: 1 });
    expect(server.uids('Processed')).toEqual([good]);
    for (const wait of [61_000, 121_000]) {
      clock.now += wait;
      await reader.poll();
    }
    expect(pipeline.inputs).toHaveLength(1);
    expect(notifier.of('note')[0]?.text).toContain(
      `A message from ${OWNER} in the jobs mailbox cannot be read: the mailbox would not give its source (3 tries)`
    );
  });

  test('a lost connection during a FETCH is still the mailbox failing', async () => {
    const { server, reader } = setup();
    server.deliver(GOOD);
    server.beforeFetch = () => {
      throw socketError('ECONNRESET');
    };
    await expect(reader.poll()).rejects.toMatchObject({
      kind: 'unreachable',
    });
  });

  test('a message the server will not move stays, and the owner is told once', async () => {
    const { server, notifier, reader, clock } = setup();
    const uid = server.deliver(STRANGER);
    server.unmovable.add(uid);
    await reader.poll();
    expect(server.uids('INBOX')).toEqual([uid]);
    clock.now += 61_000;
    await reader.poll();
    server.unmovable.delete(uid);
    clock.now += 121_000;
    await reader.poll();
    expect(server.uids('Refused')).toEqual([uid]);
    expect(notifier.of('refused')).toHaveLength(1);
  });

  test('a dropped connection is opened again at the next poll', async () => {
    const { server, reader } = setup();
    await reader.poll();
    server.client?.drop();
    const uid = server.deliver(GOOD);
    await reader.poll();
    expect(server.clients).toHaveLength(2);
    expect(server.uids('Processed')).toEqual([uid]);
  });

  test('an error inside a poll drops the connection, and the next poll connects again', async () => {
    const { server, reader } = setup();
    server.deliver(GOOD);
    server.openError = socketError('ECONNRESET');
    await expect(reader.poll()).rejects.toMatchObject({
      name: 'MailError',
      kind: 'unreachable',
      message: 'the mailbox did not answer (ECONNRESET)',
    });
    expect(server.clients[0]?.closed).toBe(true);
    expect((await reader.poll()).processed).toBe(1);
    expect(server.count('connect')).toBe(2);
  });

  test('close logs out', async () => {
    const { server, reader } = setup();
    await reader.poll();
    await reader.close();
    expect(server.count('logout')).toBe(1);
    await reader.close();
    expect(server.count('logout')).toBe(1);
  });
});

describe('the reader’s loop and the mailbox’s health', () => {
  /** A sleep that records each wait and stops the loop after `rounds` of them. */
  function rounds(
    n: number,
    abort: AbortController,
    each: (i: number) => void = () => undefined
  ): { sleep: Sleep; waits: number[] } {
    const waits: number[] = [];
    return {
      waits,
      sleep: async (ms) => {
        waits.push(ms);
        each(waits.length);
        if (waits.length >= n) abort.abort();
      },
    };
  }

  test('a refused login is told as the mailbox down, with no password, and backs off from five minutes', async () => {
    const abort = new AbortController();
    let s: ReturnType<typeof setup> | undefined;
    const { sleep, waits } = rounds(3, abort, (i) => {
      if (i === 2 && s !== undefined) s.server.connectError = undefined;
    });
    s = setup({ sleep });
    s.server.connectError = loginRefused();
    await s.reader.run(abort.signal);
    expect(waits).toEqual([300_000, 600_000, 60_000]);
    const detail =
      'the mailbox refused the login: check JOBS_MAIL_USER and JOBS_MAIL_PASSWORD (an app password)';
    expect(s.health.connections).toEqual([
      { name: 'mail', up: false, detail },
      { name: 'mail', up: false, detail },
      { name: 'mail', up: true, detail: undefined },
    ]);
    expect(s.health.loops).toEqual([
      `failed mail: ${detail}`,
      `failed mail: ${detail}`,
      'ok mail',
    ]);
    expect(s.lines.join('\n')).not.toContain(PASSWORD);
  });

  test('an error that carries the password is masked everywhere', async () => {
    const abort = new AbortController();
    const { sleep } = rounds(1, abort);
    const s = setup({ sleep });
    s.server.connectError = new Error(`LOGIN jobs@example.com ${PASSWORD}`);
    await s.reader.run(abort.signal);
    const detail = s.health.connections[0]?.detail ?? '';
    expect(detail).toContain('[REDACTED]');
    expect(detail).not.toContain(PASSWORD);
    expect(s.lines.join('\n')).not.toContain(PASSWORD);
    expect(s.lines.join('\n')).toContain('mailbox check failed');
  });

  test('a connection that drops mid-poll is opened again at once, and the mailbox is not called down', async () => {
    const abort = new AbortController();
    let s: ReturnType<typeof setup> | undefined;
    const { sleep, waits } = rounds(2, abort, (i) => {
      if (i === 1 && s !== undefined)
        s.server.openError = socketError('ECONNRESET');
    });
    s = setup({ sleep });
    await s.reader.run(abort.signal);
    expect(waits).toEqual([60_000, 60_000]);
    expect(s.health.connections.map((c) => c.up)).toEqual([true, true]);
    expect(s.server.count('connect')).toBe(2);
    expect(s.server.count('open')).toBe(3);
    expect(s.server.clients[0]?.closed).toBe(true);
  });

  test('a mailbox that does not answer backs off from a minute to fifteen', async () => {
    const abort = new AbortController();
    const { sleep, waits } = rounds(6, abort);
    const s = setup({ sleep });
    s.server.connectError = socketError('ECONNREFUSED');
    await s.reader.run(abort.signal);
    expect(waits).toEqual([
      60_000, 120_000, 240_000, 480_000, 900_000, 900_000,
    ]);
    expect(s.health.connections[0]?.detail).toBe(
      'the mailbox did not answer (ECONNREFUSED)'
    );
  });

  test('new mail seen while idle wakes the loop early, after the minimum gap', async () => {
    const abort = new AbortController();
    const waits: number[] = [];
    const sleep: Sleep = (ms, signal) => {
      waits.push(ms);
      if (ms < 60_000) return Promise.resolve();
      return new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    };
    const s = setup({ sleep });
    const running = s.reader.run(abort.signal);
    await until(
      () => s.server.count('open') === 1 && waits.length === 1,
      'the first poll'
    );
    const uid = s.server.deliver(GOOD);
    await until(() => s.server.uids('Processed').includes(uid), 'the message');
    abort.abort();
    await running;
    expect(waits.slice(0, 2)).toEqual([60_000, 5_000]);
    expect(s.server.count('open')).toBe(2);
  });

  test('errors are named by what failed', () => {
    expect(classifyMailError(loginRefused()).kind).toBe('login');
    expect(classifyMailError(socketError('CERT_HAS_EXPIRED')).message).toBe(
      'TLS with the mailbox failed (CERT_HAS_EXPIRED)'
    );
    expect(
      classifyMailError(socketError('ERR_TLS_CERT_ALTNAME_INVALID')).kind
    ).toBe('tls');
    expect(classifyMailError(socketError('EPROXY')).message).toBe(
      'the egress proxy did not open a connection to the mailbox (EPROXY)'
    );
    expect(classifyMailError(socketError('CONNECT_TIMEOUT')).kind).toBe(
      'unreachable'
    );
    expect(classifyMailError(new Error('BAD command')).message).toBe(
      'the mailbox failed: BAD command'
    );
  });
});

describe('where a message goes', () => {
  test('by the pipeline’s result and every attachment’s', () => {
    expect(placementOf(finished('Processed'))).toBe('Processed');
    expect(placementOf(finished('Not a job'))).toBe('Processed');
    expect(placementOf(duplicate('Processed'))).toBe('Processed');
    expect(placementOf(finished('Failed'))).toBe('Failed');
    expect(placementOf(duplicate('Failed'))).toBe('Failed');
    expect(placementOf(finished('Processed', [duplicate('Failed')]))).toBe(
      'Failed'
    );
    expect(placementOf(waiting())).toBe('stay');
    expect(placementOf(duplicate())).toBe('stay');
    expect(placementOf(duplicate('Processing'))).toBe('stay');
    expect(placementOf(finished('Failed', [waiting()]))).toBe('stay');
  });
});

describe('the setup document’s mailbox line', () => {
  test('logs in and out, and says what it found', async () => {
    const { server, logger } = setup();
    expect(
      await checkLogin({
        host: 'imap.example.com',
        policy: POLICY,
        connect: server.factory(),
        logger,
      })
    ).toEqual({
      setting: 'Mailbox login',
      ok: true,
      text: 'logged in to imap.example.com; mail from 3 allowed senders is read',
    });
    expect(server.commands).toEqual([{ op: 'connect', verifyOnly: true }]);
  });

  test('a refused login and an unknown jobs address are not ok', async () => {
    const { server, logger } = setup();
    const check = (policy = POLICY) =>
      checkLogin({
        host: 'imap.example.com',
        policy,
        connect: server.factory(),
        logger,
      });
    server.connectError = loginRefused();
    expect((await check()).ok).toBe(false);
    expect((await check()).text).toContain('refused the login');
    server.connectError = undefined;
    const unknown = await check({ ...POLICY, jobsAddresses: [] });
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain('JOBS_MAIL_USER is not an email address');
  });
});
