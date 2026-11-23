// An integration review of the pipeline (U5) against the contracts of the
// units it calls: text/, supamac/, ai/, checks.ts and derive.ts, and the
// hand-offs those units left for it. Tests marked `test.failing` reproduce a
// defect: each passes while the defect is there, and fails once it is fixed,
// so the fix removes `.failing`. Every fixture is a placeholder.

import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtractionReplyWire } from '../../src/ai/extract';
import { monthOf } from '../../src/ai/spend';
import { ConfigError, loadConfig } from '../../src/config';
import { Logger } from '../../src/log';
import { type Service, startService } from '../../src/main';
import type { Extractor, PipelineContext } from '../../src/pipeline/context';
import type { Intake, IntakeContext } from '../../src/pipeline/intake';
import { RecordingNotifier } from '../../src/pipeline/notify';
import { Pipeline } from '../../src/pipeline/pipeline';
import { filingFacts, sha256 } from '../../src/pipeline/process';
import { StateStore } from '../../src/pipeline/state';
import { SupaMacError } from '../../src/supamac/client';
import {
  type EnsureSchemaResult,
  type JobsPins,
  SchemaError,
} from '../../src/supamac/schema';
import type { RowInput } from '../../src/supamac/tables';
import { extract } from '../../src/text/extract';
import {
  type Extracted,
  type ExtractOutcome,
  LIMITS,
} from '../../src/text/types';
import { httpError } from '../ai/fake';
import { mime } from '../text/build';
import {
  INVITE_PDF,
  INVITE_PDF_REPLY,
  inviteEmail,
  PO_PDF,
  PO_REPLY,
} from './fixtures';
import {
  cleanup,
  makeWorld,
  type Scripted,
  ScriptedModel,
  type World,
} from './harness';
import {
  MemoryStore,
  OWNER_EMAIL,
  OWNER_USER,
  SERVICE_USER,
} from './memory-store';

const MINUTE = 60_000;
const BOT = '123456789:AAEexampleexampleexampleexample00'; // secret-scan: fixture

const ENV = {
  JOBS_SUPAMAC_API_KEY: 'test-api-key-not-real', // secret-scan: fixture
  JOBS_OWNER_EMAIL: OWNER_EMAIL,
  ANTHROPIC_API_KEY: 'sk-ant-api03-example-key', // secret-scan: fixture
  JOBS_MONTHLY_LIMIT_USD: '20',
  JOBS_TELEGRAM_BOT_TOKEN: BOT,
};

const MAIL_ENV = {
  JOBS_MAIL_HOST: 'imap.example.com',
  JOBS_MAIL_USER: 'jobs@example.com',
  JOBS_MAIL_PASSWORD: 'app-password-fixture', // secret-scan: fixture
  JOBS_MAIL_AUTHSERV_ID: 'mx.example.com',
  JOBS_MAIL_ALLOWED_SENDERS: OWNER_EMAIL,
};

const NOT_A_JOB: ExtractionReplyWire = {
  source_kind: 'Not about a job',
  jobs: [],
  details: [],
};

const dirs: string[] = [];
const services: Service[] = [];
const worlds: World[] = [];

afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  for (const w of worlds.splice(0)) await cleanup(w);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-review-u5-'));
  dirs.push(dir);
  return dir;
}

async function world(
  script: { marker: string; reply: Scripted }[],
  options: {
    extract?: Extractor;
    store?: MemoryStore;
  } = {}
): Promise<World> {
  const w = await makeWorld(script, {
    extract: options.extract ?? ((bytes, hint) => extract(bytes, hint)),
    ...(options.store !== undefined ? { store: options.store } : {}),
  });
  worlds.push(w);
  return w;
}

function sourceRow(w: World, id: string): Record<string, unknown> {
  const values = w.store.values('sources', id);
  if (values === undefined) throw new Error(`no Sources row ${id}`);
  return values;
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

class FakeIntake implements Intake {
  context: IntakeContext | undefined;
  stopped = false;
  constructor(
    readonly name: 'mail' | 'telegram',
    private readonly onStart?: (context: IntakeContext) => void
  ) {}
  async start(context: IntakeContext): Promise<void> {
    this.context = context;
    this.onStart?.(context);
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
}

class RefusingIntake implements Intake {
  constructor(readonly name: 'mail' | 'telegram') {}
  async start(): Promise<void> {
    throw new Error('the mailbox refused the login');
  }
  async stop(): Promise<void> {}
}

interface StartOptions {
  readonly env?: Record<string, string>;
  readonly dir?: string;
  readonly notes?: readonly string[];
  readonly intakes?: readonly Intake[];
  readonly notifier?: RecordingNotifier;
  readonly clock?: () => Date;
  readonly store?: MemoryStore;
  readonly loops?: boolean;
  readonly listen?: boolean;
  readonly ensureSchema?: () => Promise<EnsureSchemaResult>;
}

async function start(options: StartOptions = {}): Promise<{
  service: Service;
  store: MemoryStore;
  notifier: RecordingNotifier;
  dir: string;
}> {
  const dir = options.dir ?? (await tempDir());
  const store = options.store ?? new MemoryStore();
  const notifier = options.notifier ?? new RecordingNotifier();
  const service = await startService({
    env: { ...(options.env ?? ENV), JOBS_STATE_DIR: dir },
    notifier,
    intakes: options.intakes,
    logger: new Logger({ sink: () => undefined }),
    store: () => store,
    ensureSchema:
      options.ensureSchema ??
      (async (input): Promise<EnsureSchemaResult> => {
        const pins = pinsOf(store);
        await input.save(pins);
        return {
          pins,
          schema: store.schema,
          changes: [],
          notes: [...(options.notes ?? [])],
        };
      }),
    messages: new ScriptedModel([]),
    extract: (bytes, hint) => extract(bytes, hint),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    loops: options.loops ?? false,
    listen: options.listen ?? false,
    port: 0,
  });
  services.push(service);
  return { service, store, notifier, dir };
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function plainEmail(subject: string, date: string, body: string[]): Uint8Array {
  return mime([
    `From: Sam Price <${OWNER_EMAIL}>`,
    'To: Jobs <jobs@example.com>',
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <${sha256(subject).slice(0, 12)}@example.com>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    ...body,
    '',
  ]);
}

// ---------------------------------------------------------------------------
// Hand-offs the earlier units left, honoured.

describe('hand-offs from text/ and ai/', () => {
  test('Sources.Sent is the email’s own date with its written offset, not converted', async () => {
    const w = await world([{ marker: 'S1: "Offset check"', reply: NOT_A_JOB }]);
    const result = await w.pipeline.processEmail({
      raw: plainEmail('Offset check', 'Thu, 1 Apr 2027 10:30:00 +0100', [
        'Crew call 07:00 on Fri 12 March 2027.',
      ]),
      from: OWNER_EMAIL,
    });
    expect(result.kind).toBe('finished');
    const row = sourceRow(w, result.sourceId);
    expect(row.Status).toBe('Not a job');
    expect(row.Sent).toBe('2027-04-01T10:30:00+01:00');
  });

  test('a refusal takes REFUSAL_STATUS: a deterministic one is Skipped, a sandbox failure is Failed with Retry', async () => {
    const w = await world([]);
    const refused = (kind: 'too_large' | 'timeout', reason: string) =>
      new Pipeline({
        ...w.ctx,
        extract: async (): Promise<ExtractOutcome> => ({
          ok: false,
          refusal: { kind, reason },
        }),
      });
    const big = await refused(
      'too_large',
      'The file is over 64 MiB.'
    ).processSource({
      via: 'Telegram',
      name: 'pack.pdf',
      bytes: utf8('one'),
    });
    expect(big.kind === 'finished' && big.status).toBe('Skipped');
    expect(sourceRow(w, big.sourceId).Note).toBe('The file is over 64 MiB.');
    expect(w.notifier.of('failure')).toEqual([]);

    const slow = await refused(
      'timeout',
      'Reading the file took too long.'
    ).processSource({
      via: 'Telegram',
      name: 'pack2.pdf',
      bytes: utf8('two'),
    });
    expect(slow.kind === 'finished' && slow.status).toBe('Failed');
    expect(w.notifier.of('failure')).toMatchObject([
      { sourceId: slow.sourceId, retry: { sourceId: slow.sourceId } },
    ]);
    expect(w.model.requests).toHaveLength(0);
  });

  test('the Note says a file was read from its page text only', async () => {
    const w = await world(
      [{ marker: 'S1: "invite.pdf"', reply: INVITE_PDF_REPLY }],
      {
        extract: (bytes, hint) =>
          extract(bytes, hint, { ...LIMITS, pageTextOnlyBytes: 64 }),
      }
    );
    const result = await w.pipeline.processSource({
      via: 'Telegram',
      name: 'invite.pdf',
      bytes: INVITE_PDF,
    });
    expect(result.kind).toBe('finished');
    expect(String(sourceRow(w, result.sourceId).Note)).toContain(
      'Read from its page text only'
    );
  });

  test('a reply saved before a failure is read again on resume, with what the request left out, and never bought twice', async () => {
    // Fails the first write of the reply's Kind, after the reply is saved.
    class KindFails extends MemoryStore {
      left = 1;
      override async updateSource(
        id: string,
        values: RowInput<'sources'>
      ): Promise<void> {
        if ('Kind' in values && this.left-- > 0)
          throw new SupaMacError(
            'unavailable',
            'POST /databases/query',
            'the gateway did not answer',
            { status: 503 }
          );
        return super.updateSource(id, values);
      }
    }
    const scan: Extracted = {
      type: 'pdf',
      mediaType: 'application/pdf',
      text: {
        paged: true,
        pages: [{ page: 1, kind: 'scan', lines: [] }],
        pageTextOnly: false,
      },
      pageCount: 1,
      notes: [],
    };
    const w = await world([{ marker: 'S1: "scan.pdf"', reply: NOT_A_JOB }], {
      store: new KindFails(),
      extract: async () => ({ ok: true, value: scan }),
    });
    // 24 MiB: under the upload limit, but its base64 is over the request's 32 MB.
    const bytes = new Uint8Array(randomBytes(24 * 1024 * 1024));
    const first = await w.pipeline.processSource({
      via: 'Telegram',
      name: 'scan.pdf',
      bytes,
    });
    expect(first.kind).toBe('waiting');
    const saved = w.state.value.replies[sha256(bytes)];
    expect(saved?.attachmentsLeftOut).toHaveLength(1);

    w.now += 2 * MINUTE;
    const [again] = await w.pipeline.resume();
    expect(again?.kind).toBe('finished');
    expect(w.model.count('S1: "scan.pdf"')).toBe(1);
    expect(String(sourceRow(w, first.sourceId).Note)).toContain(
      'Not read: the PDF was not attached'
    );
  });
});

// ---------------------------------------------------------------------------
// main.ts: each way in off, and the loops.

describe('the service with ways in off', () => {
  test('with every way in off it starts its loops, answers /health, and stops cleanly', async () => {
    const mail = new FakeIntake('mail');
    const telegram = new FakeIntake('telegram');
    const { service, store } = await start({
      env: {
        JOBS_SUPAMAC_API_KEY: ENV.JOBS_SUPAMAC_API_KEY,
        JOBS_OWNER_EMAIL: OWNER_EMAIL,
        ...MAIL_ENV,
      },
      intakes: [mail, telegram],
      loops: true,
      listen: true,
    });
    expect(mail.context).toBeUndefined();
    expect(telegram.context).toBeUndefined();
    expect(service.config.off.map((o) => o.way).sort()).toEqual([
      'Email',
      'Folder',
      'Telegram',
    ]);
    for (let i = 0; i < 200 && store.rows('status').length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.rows('status')).toHaveLength(1);
    const health = await fetch(`http://127.0.0.1:${service.port}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { loops: { name: string }[] };
    expect(body.loops.map((l) => l.name).sort()).toEqual([
      'edits',
      'resume',
      'status',
    ]);
    await service.stop();
    const calls = store.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.calls.length).toBe(calls);
  });

  test('with only the AI on, the folder loop runs and no intake starts', async () => {
    const telegram = new FakeIntake('telegram');
    const { service } = await start({
      env: {
        JOBS_SUPAMAC_API_KEY: ENV.JOBS_SUPAMAC_API_KEY,
        JOBS_OWNER_EMAIL: OWNER_EMAIL,
        ANTHROPIC_API_KEY: ENV.ANTHROPIC_API_KEY,
        JOBS_MONTHLY_LIMIT_USD: '20',
      },
      intakes: [telegram],
      loops: true,
    });
    expect(telegram.context).toBeUndefined();
    expect(
      service.health
        .report()
        .loops.map((l) => l.name)
        .sort()
    ).toEqual(['edits', 'folder', 'resume', 'status']);
    await service.stop();
  });
});

// ---------------------------------------------------------------------------
// Defects.

describe('config refuses the internal secrets', () => {
  // The names bootstrap.compose.yaml writes into generated.env for the shared
  // internal service key and for the database URL; the jobs container must
  // carry none of them.
  const STACK_NAMES = [
    'INTERNAL_API_SECRET_KEY',
    'INTERNAL_API_KEY',
    'INTERNAL_AUTH_KEY',
    'AUTHENTICATION_SERVICE_SECRET_KEY',
    'SYNC_SERVICE_AUTH_KEY',
    'SERVICE_INTERNAL_AUTH_KEY',
    'DOCUMENT_STORAGE_SERVICE_AUTH_KEY',
    'DSS_INTERNAL_AUTH_KEY',
    'DATABASE_URL',
    'DATABASE_URL_READONLY',
    'MACRO_DB_URL',
  ];

  test('every name the stack gives its internal key or database URL stops the start', () => {
    const accepted = STACK_NAMES.filter((name) => {
      try {
        loadConfig({
          JOBS_SUPAMAC_API_KEY: ENV.JOBS_SUPAMAC_API_KEY,
          JOBS_OWNER_EMAIL: OWNER_EMAIL,
          [name]: 'value-from-generated-env',
        });
        return true;
      } catch (error) {
        return !(error instanceof ConfigError && error.kind === 'forbidden');
      }
    });
    expect(accepted).toEqual([]);
  });
});

describe('the Status row and the spend ledger', () => {
  test('the Status row’s spend this month is the month the AI client counts in (the owner’s zone)', async () => {
    // 00:30 on 1 July in London is still 30 June in UTC.
    const at = new Date('2027-06-30T23:30:00Z');
    expect(monthOf(at, 'Europe/London')).toBe('2027-07');
    const dir = await tempDir();
    const seed = await StateStore.open(dir);
    await seed.update((s) => {
      s.spend.months['2027-06'] = 9;
      s.spend.months['2027-07'] = 1.25;
    });
    const { service, store } = await start({ dir, clock: () => at });
    await service.tick();
    const values = store.rows('status')[0]?.[1] as Record<string, unknown>;
    expect(values['AI spend this month (computed, USD)']).toBe(1.25);
  });
});

describe('main starts and stops its intakes as one', () => {
  test('an intake that fails to start leaves no intake started before it running', async () => {
    const telegram = new FakeIntake('telegram');
    const error = await start({
      env: { ...ENV, ...MAIL_ENV },
      intakes: [telegram, new RefusingIntake('mail')],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(telegram.context).toBeDefined();
    // The service never returned, so nothing can stop the Telegram poller.
    expect(telegram.stopped).toBe(true);
    expect(telegram.context?.signal.aborted).toBe(true);
  });
});

describe('the notifier and the Telegram intake', () => {
  // The Telegram unit's notifier learns the linked owner from the state,
  // which the service opens and hands over only in the intake's context;
  // until then it cannot deliver.
  function gated(): { notifier: RecordingNotifier; telegram: FakeIntake } {
    const notifier = new RecordingNotifier();
    notifier.failing = true;
    const telegram = new FakeIntake('telegram', (context) => {
      if (context.state.ownerId !== undefined) notifier.failing = false;
    });
    return { notifier, telegram };
  }

  async function linkedDir(): Promise<string> {
    const dir = await tempDir();
    const seed = await StateStore.open(dir);
    await seed.setOwnerId(4242);
    return dir;
  }

  test('a schema note reaches the owner once the Telegram intake can deliver it', async () => {
    const dir = await linkedDir();
    const note = 'someone else holds edit access to Jobs';
    for (let restart = 0; restart < 2; restart++) {
      const { notifier, telegram } = gated();
      const { service } = await start({
        dir,
        notes: [note],
        notifier,
        intakes: [telegram],
      });
      expect(notifier.failing).toBe(false);
      await service.tick();
      await service.stop();
      if (notifier.of('note').some((n) => n.text === note)) return;
    }
    throw new Error('the schema note was never delivered');
  });

  test('a start stopped by the schema says so to a linked owner', async () => {
    const dir = await linkedDir();
    const { notifier, telegram } = gated();
    const error = await start({
      dir,
      notifier,
      intakes: [telegram],
      ensureSchema: async () => {
        throw new SchemaError(
          'database_trashed',
          'the Jobs database is in the trash'
        );
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SchemaError);
    expect(notifier.of('note').map((n) => n.kind)).toContain('error');
  });
});

describe('what an intake is given', () => {
  async function contextOf(): Promise<IntakeContext> {
    const telegram = new FakeIntake('telegram');
    await start({ intakes: [telegram] });
    if (telegram.context === undefined) throw new Error('not started');
    return telegram.context;
  }

  test('the intake context carries the service’s clock', async () => {
    const context = await contextOf();
    expect('clock' in context).toBe(true);
  });

  test('a question can be answered: the pipeline supplies the answer tools over the pinned tables', async () => {
    const context = await contextOf();
    const names = [
      ...Object.keys(context),
      ...Object.getOwnPropertyNames(Pipeline.prototype),
    ];
    expect(
      names.filter((n) => /answer(?!Filing)|ask|question|tools/i.test(n))
    ).not.toEqual([]);
  });
});

describe('an email delivered again while it waits', () => {
  test('its attachments still wait for the email to finish', async () => {
    // The mailbox keeps a message whose source is still Processing, so the
    // next poll hands the same email over again.
    const script: { marker: string; reply: Scripted }[] = [
      {
        marker: 'S1: "Leeds Lights Gala - booking"',
        reply: httpError(529, 'overloaded_error'),
      },
      { marker: 'S1: "invite.pdf"', reply: INVITE_PDF_REPLY },
    ];
    const w = await world(script);
    const raw = inviteEmail();
    const first = await w.pipeline.processEmail({
      raw,
      from: 'jo@acme-productions.example.com',
    });
    expect(first.kind).toBe('waiting');
    expect(w.store.rows('sources')).toHaveLength(1);

    const again = await w.pipeline.processEmail({
      raw,
      from: 'jo@acme-productions.example.com',
    });
    expect(again.kind).toBe('duplicate');
    // The attachment is recorded, read and filed by itself (it starts its own
    // job) while its email is still Processing; when the email then succeeds
    // it becomes a filing question instead of the job's first source.
    expect(w.store.rows('sources').map(([, v]) => v.Name)).toEqual([
      'Leeds Lights Gala - booking',
    ]);
    expect(w.store.rows('jobs')).toHaveLength(0);
  });
});

describe('call sites of supamac/documents', () => {
  test('an email whose subject holds a slash keeps its subject as its document’s name', async () => {
    const subject = 'Call sheet 12/03 - Acme Arena';
    const w = await world([
      { marker: `S1: ${JSON.stringify(subject)}`, reply: NOT_A_JOB },
    ]);
    const result = await w.pipeline.processEmail({
      raw: plainEmail(subject, 'Mon, 1 Mar 2027 09:00:00 +0000', [
        'Crew call 07:00 on Fri 12 March 2027.',
      ]),
      from: OWNER_EMAIL,
    });
    expect(sourceRow(w, result.sourceId).Name).toBe(subject);
    const names = w.store.inFolder('sources').map((d) => d.name);
    expect(names.some((n) => n.startsWith('Call sheet'))).toBe(true);
  });
});

describe('the model’s reply', () => {
  test('an invalid reply is saved, so the owner’s Retry does not pay for the source again', async () => {
    const invalid = {
      source_kind: 'Bogus',
      jobs: [],
      details: [],
    } as unknown as ExtractionReplyWire;
    const w = await world([{ marker: 'S1: "notes.txt"', reply: invalid }]);
    const first = await w.pipeline.processSource({
      via: 'Telegram',
      name: 'notes.txt',
      bytes: utf8('Crew call 07:00\n'),
    });
    expect(first.kind === 'finished' && first.status).toBe('Failed');
    await w.pipeline.retry(first.sourceId);
    expect(w.model.count('S1: "notes.txt"')).toBe(1);
  });

  test('while the AI is off, a waiting source is not read again every minute', async () => {
    const w = await world([]);
    let reads = 0;
    const ctx: PipelineContext = {
      ...w.ctx,
      ai: undefined,
      aiOff: 'ANTHROPIC_API_KEY is not set',
      extract: (bytes, hint) => {
        reads++;
        return extract(bytes, hint);
      },
    };
    const pipeline = new Pipeline(ctx);
    const first = await pipeline.processSource({
      via: 'Telegram',
      name: 'notes.txt',
      bytes: utf8('Crew call 07:00\n'),
    });
    expect(first.kind).toBe('waiting');
    for (let i = 0; i < 3; i++) {
      w.now += MINUTE + 1_000;
      await pipeline.resume();
    }
    expect(reads).toBe(1);
  });
});

describe('filing facts', () => {
  test('a Job intake document’s owner is not taken as the original sender of its job', async () => {
    const w = await world([
      { marker: 'S1: "PO-4500123.pdf"', reply: PO_REPLY },
    ]);
    w.store.drop('PO-4500123.pdf', PO_PDF);
    const polled = await w.pipeline.pollFolder();
    expect(polled.processed).toHaveLength(1);
    const { facts } = await filingFacts(w.ctx);
    expect(facts).toHaveLength(1);
    // example.com is the owner's own account domain (OWNER_USER), not a client's.
    expect(facts.flatMap((f) => f.senderDomains)).not.toContain('example.com');
  });
});
