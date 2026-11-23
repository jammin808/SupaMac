// An independent review of the pipeline unit (src/pipeline/, src/config.ts,
// src/main.ts) against docs/supamac/jobs.md: rule zero, Edits in SupaMac,
// Operations (State, Restarts, Health), Security and §1, §3, §5, §6.
//
// Each test states what the design or the unit's own header requires. A test
// marked `test.failing` reproduces a defect the review reported: its
// assertions are the required behaviour and fail today; remove `.failing`
// once it is fixed. The crash matrices stop the service at every SupaMac call
// and every state write, before the call lands and after it landed with its
// answer lost, then restart on the same state directory and store, deliver
// the source again as its way in would, and resume.
// Every name, company, address and number is a placeholder.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtractionReplyWire } from '../../src/ai/extract';
import { Logger } from '../../src/log';
import { Loop, startService } from '../../src/main';
import type { Intake, IntakeContext } from '../../src/pipeline/intake';
import { Pipeline } from '../../src/pipeline/pipeline';
import { RecordingNotifier } from '../../src/pipeline/notify';
import { sha256 } from '../../src/pipeline/process';
import { SETUP_NAME } from '../../src/pipeline/setup';
import {
  STATE_FILE,
  type State,
  StateError,
  StateStore,
} from '../../src/pipeline/state';
import type { DetailRow, JobsStore } from '../../src/pipeline/store';
import { SupaMacError } from '../../src/supamac/client';
import type { EnsureSchemaResult, JobsPins } from '../../src/supamac/schema';
import { extract } from '../../src/text/extract';
import { httpError } from '../ai/fake';
import {
  CALL_SHEET_PDF,
  CALL_SHEET_REPLY,
  EMAIL_REPLY,
  HOTEL_PDF,
  HOTEL_REPLY,
  INVITE_PDF,
  INVITE_PDF_REPLY,
  inviteEmail,
  PHOTO,
  PO_PDF,
  PO_REPLY,
} from './fixtures';
import {
  cleanup,
  makeWorld,
  restart,
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
const HOUR = 60 * MINUTE;
const worlds: World[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await cleanup(w);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const inProcess = (
  bytes: Uint8Array,
  hint: Parameters<typeof extract>[1]
): ReturnType<typeof extract> => extract(bytes, hint);

type Script = { marker: string; reply: Scripted }[];

async function world(script: Script): Promise<World> {
  const w = await makeWorld(script, { extract: inProcess });
  worlds.push(w);
  return w;
}

type Row = Record<string, unknown> & { id: string };

function row(
  w: World,
  table: 'sources' | 'details' | 'jobs',
  name: string
): Row {
  const found = w.store.rows(table).find(([, v]) => v.Name === name);
  if (found === undefined) throw new Error(`no ${table} row ${name}`);
  return { ...found[1], id: found[0] };
}

function detailOf(w: World, sourceName: string, field: string): Row {
  const src = row(w, 'sources', sourceName);
  const found = w.store
    .rows('details')
    .find(
      ([, v]) =>
        ((v['Source row'] as string[] | undefined) ?? []).includes(src.id) &&
        v.Field === field
    );
  if (found === undefined) throw new Error(`no ${field} of ${sourceName}`);
  return { ...found[1], id: found[0] };
}

function onlyJob(w: World): Row {
  const jobs = w.store.rows('jobs');
  expect(jobs).toHaveLength(1);
  const [id, values] = jobs[0] as [string, Record<string, unknown>];
  return { ...values, id };
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

// ---------------------------------------------------------------------------
// Stopping the service at a step.

const STORE_METHODS = new Set([
  'insertSource',
  'updateSource',
  'sources',
  'insertDetails',
  'updateDetail',
  'details',
  'insertJob',
  'updateJob',
  'jobs',
  'job',
  'writeStatus',
  'tableVersions',
  'tableChanges',
  'uploadFile',
  'uploadMarkdown',
  'folderDocuments',
  'downloadDocument',
  'moveDocument',
  'readMarkdown',
  'writeMarkdown',
]);

type Around = (
  method: string,
  args: unknown[],
  call: () => Promise<unknown>
) => Promise<unknown>;

/** The store with every JobsStore call passed through `around`. */
function wrapStore(store: MemoryStore, around: Around): JobsStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (
        typeof prop !== 'string' ||
        !STORE_METHODS.has(prop) ||
        typeof value !== 'function'
      )
        return value;
      return (...args: unknown[]): Promise<unknown> =>
        around(prop, args, () =>
          (value as (...a: unknown[]) => Promise<unknown>).apply(target, args)
        );
    },
  }) as unknown as JobsStore;
}

function useStore(w: World, store: JobsStore): void {
  w.ctx = { ...w.ctx, store };
  w.pipeline = new Pipeline(w.ctx);
}

type Mode = 'before' | 'after';

interface Stop {
  /** Every call or write, as it was made. */
  readonly log: string[];
  /** Settles once the service is stopped. */
  readonly reached: Promise<void>;
}

/** Stops the service (the call never answers) at the call `at` picks. */
function stopAtCall(
  w: World,
  mode: Mode,
  at: (method: string, n: number, args: unknown[]) => boolean
): Stop {
  let n = 0;
  let signal: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const log: string[] = [];
  useStore(
    w,
    wrapStore(w.store, (method, args, call) => {
      n++;
      log.push(method);
      if (!at(method, n, args)) return call();
      if (mode === 'before') {
        signal();
        return never();
      }
      return call().then(() => {
        signal();
        return never();
      });
    })
  );
  return { log, reached };
}

/** Who made a state write, from the stack: the two frames above `update`. */
function writer(stack: string): string {
  return stack
    .split('\n')
    .slice(2, 4)
    .map((l) => {
      const m = /at (?:async )?([\w.<>]+) \(.*\/([\w-]+)\.ts:/.exec(l);
      return m ? `${m[1]}@${m[2]}` : '?';
    })
    .join('>');
}

/** Stops the service at the `at`-th state write. */
function stopAtWrite(w: World, mode: Mode, at: number): Stop {
  let n = 0;
  let signal: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const log: string[] = [];
  const state = w.state;
  const original = state.update.bind(state);
  state.update = <T>(change: (draft: State) => T): Promise<T> => {
    n++;
    log.push(writer(new Error().stack ?? ''));
    if (n !== at) return original(change);
    if (mode === 'before') {
      signal();
      return never<T>();
    }
    return original(change).then(() => {
      signal();
      return never<T>();
    });
  };
  return { log, reached };
}

/**
 * A stop at these state writes makes the model answer the source twice: the
 * spend ledger's, inside the AI client between the paid answer and its
 * return, and the save itself before it lands. The Anthropic health record
 * comes after the save (see 'a health note to the owner does not stand
 * between the model’s paid answer and saving it').
 */
const PAID_WINDOW = new Set([
  'record@state>send@anthropic',
  'modelReply@process>stages@process',
]);

// ---------------------------------------------------------------------------

const INVITE = {
  via: 'Telegram' as const,
  name: 'invite.pdf',
  bytes: INVITE_PDF,
};
const INVITE_SCRIPT: Script = [
  { marker: 'S1: "invite.pdf"', reply: INVITE_PDF_REPLY },
];
const EMAIL_SCRIPT: Script = [
  { marker: 'S1: "Leeds Lights Gala - booking"', reply: EMAIL_REPLY },
  { marker: 'S1: "invite.pdf"', reply: INVITE_PDF_REPLY },
];
const EMAIL = {
  raw: inviteEmail(),
  from: 'jo@acme-productions.example.com',
};

interface Outcome {
  readonly sources: number;
  readonly details: number;
  readonly distinctDetails: number;
  /** Distinct Job cells among the details. */
  readonly detailJobs: number;
  readonly jobs: number;
  readonly emptyJobs: number;
  readonly statuses: string[];
  readonly filing: number;
}

function outcome(w: World): Outcome {
  const details = w.store.rows('details');
  const withJob = new Set(
    details.flatMap(([, v]) => (v.Job as string[] | undefined) ?? [])
  );
  const jobs = w.store.rows('jobs');
  return {
    sources: w.store.rows('sources').length,
    details: details.length,
    distinctDetails: new Set(
      details.map(([, v]) =>
        JSON.stringify([v['Source row'], v.Field, v.Value, v.Day ?? null])
      )
    ).size,
    detailJobs: new Set(details.map(([, v]) => JSON.stringify(v.Job ?? [])))
      .size,
    jobs: jobs.length,
    emptyJobs: jobs.filter(([id]) => !withJob.has(id)).length,
    statuses: w.store.rows('sources').map(([, v]) => String(v.Status)),
    filing: Object.keys(w.state.value.filing).length,
  };
}

/** Lets every retry that is due run, as the resume loop would. */
async function settle(w: World, rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    w.now += 30 * MINUTE;
    await w.pipeline.resume();
  }
}

describe('crashes at every step boundary', () => {
  test('a Telegram file stopped at any SupaMac call, before or after it lands, recovers to one source, its five details once and one job; only an extra empty job may be left', async () => {
    const probe = await world(INVITE_SCRIPT);
    const calls = stopAtCall(probe, 'before', () => false);
    await probe.pipeline.processSource(INVITE);
    expect(calls.log.length).toBeGreaterThan(15);
    const extraJobs: string[] = [];
    for (const mode of ['before', 'after'] as const) {
      for (let k = 1; k <= calls.log.length; k++) {
        const w = await world(INVITE_SCRIPT);
        const stop = stopAtCall(w, mode, (_m, n) => n === k);
        void w.pipeline.processSource(INVITE);
        await stop.reached;
        await restart(w, inProcess);
        await w.pipeline.processSource(INVITE);
        await settle(w);
        const o = outcome(w);
        const where = `${mode} ${stop.log[k - 1]}`;
        expect({
          where,
          ...o,
          model: w.model.count('S1: "invite.pdf"'),
        }).toEqual({
          where,
          sources: 1,
          details: 5,
          distinctDetails: 5,
          detailJobs: 1,
          jobs: o.jobs,
          emptyJobs: o.jobs - 1,
          statuses: ['Needs review'],
          filing: 0,
          model: 1,
        });
        if (o.jobs > 1) extraJobs.push(where);
        const filed = w.store
          .rows('jobs')
          .find(([, v]) => v['PO number'] === '4500123');
        expect(filed?.[1]['Call times']).toBe(
          'Fri 12 Mar 2027: 07:00; Sat 13 Mar 2027: 07:30'
        );
      }
    }
    // The one window the header allows: a job made, its id not yet saved.
    expect(extraJobs).toEqual(['after insertJob']);
  }, 120_000);

  test('a Telegram file stopped at any state write recovers the same way; the model is asked twice only when the stop falls between its answer and saving it', async () => {
    const probe = await world(INVITE_SCRIPT);
    const writes = stopAtWrite(probe, 'before', -1);
    await probe.pipeline.processSource(INVITE);
    const twice: string[] = [];
    for (const mode of ['before', 'after'] as const) {
      for (let k = 1; k <= writes.log.length; k++) {
        const w = await world(INVITE_SCRIPT);
        const stop = stopAtWrite(w, mode, k);
        void w.pipeline.processSource(INVITE);
        await stop.reached;
        await restart(w, inProcess);
        await w.pipeline.processSource(INVITE);
        await settle(w);
        const o = outcome(w);
        const where = `${mode} ${stop.log[k - 1]}`;
        expect({ where, ...o }).toEqual({
          where,
          sources: 1,
          details: 5,
          distinctDetails: 5,
          detailJobs: 1,
          jobs: o.jobs,
          emptyJobs: o.jobs - 1,
          statuses: ['Needs review'],
          filing: 0,
        });
        expect(o.jobs).toBeLessThanOrEqual(2);
        if (w.model.count('S1: "invite.pdf"') > 1)
          twice.push(stop.log[k - 1] as string);
      }
    }
    expect(new Set(twice)).toEqual(PAID_WINDOW);
  }, 120_000);

  test('an email with its attachment stopped anywhere, resumed and then delivered again, keeps two sources, ten details once and one job holding both, but for one window', async () => {
    const probe = await world(EMAIL_SCRIPT);
    const calls = stopAtCall(probe, 'before', () => false);
    const writes = stopAtWrite(probe, 'before', -1);
    await probe.pipeline.processEmail(EMAIL);
    const plan: { kind: 'call' | 'write'; k: number; mode: Mode }[] = [];
    for (const mode of ['before', 'after'] as const) {
      for (let k = 1; k <= calls.log.length; k++)
        plan.push({ kind: 'call', k, mode });
      for (let k = 1; k <= writes.log.length; k++)
        plan.push({ kind: 'write', k, mode });
    }
    const twice: string[] = [];
    const unfiled: number[] = [];
    for (const p of plan) {
      const w = await world(EMAIL_SCRIPT);
      const stop =
        p.kind === 'call'
          ? stopAtCall(w, p.mode, (_m, n) => n === p.k)
          : stopAtWrite(w, p.mode, p.k);
      void w.pipeline.processEmail(EMAIL);
      await stop.reached;
      const rowsWritten = w.store.rows('sources').length;
      await restart(w, inProcess);
      await settle(w);
      await w.pipeline.processEmail(EMAIL);
      await settle(w, 2);
      const o = outcome(w);
      const where = `${p.mode} ${stop.log[p.k - 1]} (${p.kind} ${p.k})`;
      expect({ where, sources: o.sources, details: o.details }).toEqual({
        where,
        sources: 2,
        details: 10,
      });
      expect(o.distinctDetails).toBe(10);
      expect(o.jobs - o.emptyJobs).toBe(1);
      const models = [
        w.model.count('S1: "Leeds Lights Gala - booking"'),
        w.model.count('S1: "invite.pdf"'),
      ];
      if (models.some((m) => m > 1)) twice.push(stop.log[p.k - 1] as string);
      if (o.detailJobs !== 1) unfiled.push(rowsWritten);
    }
    expect(new Set(twice)).toEqual(PAID_WINDOW);
    // Never unfiled, not even where the attachment's row had landed and its
    // state record had not (see 'an attachment whose state record was lost
    // after its row was written still files with its email').
    expect(unfiled).toEqual([]);
  }, 300_000);
});

// ---------------------------------------------------------------------------

describe('state file corruption or loss', () => {
  test('a state file that is not JSON, or of another version, stops the start and is left as it is', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jobs-review-u5-'));
    dirs.push(dir);
    const path = join(dir, STATE_FILE);
    await writeFile(path, '{"version":1,"pins":');
    const corrupt = await StateStore.open(dir).catch((e: unknown) => e);
    expect(corrupt).toBeInstanceOf(StateError);
    expect((corrupt as StateError).kind).toBe('corrupt');
    expect(await readFile(path, 'utf8')).toBe('{"version":1,"pins":');
    await writeFile(path, '{"version":2}');
    const newer = await StateStore.open(dir).catch((e: unknown) => e);
    expect((newer as StateError).kind).toBe('version');
    expect(await readFile(path, 'utf8')).toBe('{"version":2}');
  });

  test('a state restored from an older backup still marks every Found value of the Jobs row as not confirmed', async () => {
    const INVOICE = new TextEncoder().encode(
      'PO: 4500123\nClient: Example Arts Trust\nInvoice to: Acme Productions Ltd, 1 Example Road, Leeds ZZ3 3ZZ\n'
    );
    const INVOICE_REPLY: ExtractionReplyWire = {
      source_kind: 'Purchase order',
      jobs: [
        { names: ['Leeds Lights Gala'], references: ['4500123'], dates: [] },
      ],
      details: [
        {
          field: 'PO number',
          label: 'PO',
          value: '4500123',
          quote: 'PO: 4500123',
        },
        {
          field: 'Client',
          label: 'Client',
          value: 'Example Arts Trust',
          quote: 'Client: Example Arts Trust',
        },
        {
          field: 'Invoice to',
          label: 'Invoice to',
          value: 'Acme Productions Ltd, 1 Example Road, Leeds ZZ3 3ZZ',
          quote:
            'Invoice to: Acme Productions Ltd, 1 Example Road, Leeds ZZ3 3ZZ',
        },
      ],
    };
    const w = await world([
      ...EMAIL_SCRIPT,
      { marker: 'S1: "PO-4500123.pdf"', reply: PO_REPLY },
      { marker: 'S1: "invoice-to.txt"', reply: INVOICE_REPLY },
    ]);
    await w.pipeline.processEmail(EMAIL);
    const backup = await readFile(join(w.dir, STATE_FILE));
    await w.pipeline.processSource({
      via: 'Telegram',
      name: 'PO-4500123.pdf',
      bytes: PO_PDF,
    });
    expect(onlyJob(w)['Not confirmed']).toContain('Payment terms');
    // The state volume is restored from the backup taken before the PO.
    await writeFile(join(w.dir, STATE_FILE), backup);
    await restart(w, inProcess);
    await w.pipeline.processSource({
      via: 'Telegram',
      name: 'invoice-to.txt',
      bytes: INVOICE,
    });
    const job = onlyJob(w);
    expect(detailOf(w, 'invoice-to.txt', 'Invoice to').Status).toBe('Found');
    expect(job['Invoice to']).toBe(
      'Acme Productions Ltd, 1 Example Road, Leeds ZZ3 3ZZ'
    );
    // Rule zero: the Jobs row marks which of its values are not confirmed.
    expect(job['Not confirmed']).toContain('Invoice to');
  });
});

// ---------------------------------------------------------------------------

describe('duplicate deliveries and two sources about one job', () => {
  test('a file sent again while it waits for its retry is the same source and asks the model nothing', async () => {
    const w = await world([
      {
        marker: 'S1: "invite.pdf"',
        reply: httpError(529, 'overloaded_error'),
      },
    ]);
    expect((await w.pipeline.processSource(INVITE)).kind).toBe('waiting');
    const again = await w.pipeline.processSource({ ...INVITE, name: 'b.pdf' });
    expect(again.kind).toBe('duplicate');
    expect(w.model.requests).toHaveLength(1);
    expect(w.store.rows('sources').map(([, v]) => v.Status)).toEqual([
      'Processing',
    ]);
  });

  test('an email whose own reading waits for a retry, fetched again by the next mail poll, still files its attachment with it', async () => {
    const emailEntry: { marker: string; reply: Scripted } = {
      marker: 'S1: "Leeds Lights Gala - booking"',
      reply: httpError(529, 'overloaded_error'),
    };
    const w = await world([
      emailEntry,
      { marker: 'S1: "invite.pdf"', reply: INVITE_PDF_REPLY },
    ]);
    const first = await w.pipeline.processEmail(EMAIL);
    // Not finished: the mail unit leaves the message in the mailbox.
    expect(first.kind).toBe('waiting');
    emailEntry.reply = EMAIL_REPLY;
    // The next minute's mail poll reads the same message again.
    await w.pipeline.processEmail(EMAIL);
    w.now += 2 * MINUTE;
    await w.pipeline.resume();
    const email = row(w, 'sources', 'Leeds Lights Gala - booking');
    const pdf = row(w, 'sources', 'invite.pdf');
    // Design §5: an attachment files with its email unless its own references conflict.
    expect(w.state.value.filing).toEqual({});
    const job = onlyJob(w);
    expect(email.Job).toEqual([job.id]);
    expect(pdf.Job).toEqual([job.id]);
  });

  test('an attachment whose state record was lost after its row was written still files with its email', async () => {
    const w = await world(EMAIL_SCRIPT);
    // Stopped after the attachment's Sources row landed, before its record was saved.
    const stop = stopAtCall(
      w,
      'after',
      (m) => m === 'insertSource' && w.store.rows('sources').length === 1
    );
    void w.pipeline.processEmail(EMAIL);
    await stop.reached;
    expect(w.store.rows('sources')).toHaveLength(2);
    await restart(w, inProcess);
    await settle(w);
    const email = row(w, 'sources', 'Leeds Lights Gala - booking');
    const pdf = row(w, 'sources', 'invite.pdf');
    expect(email.Job).toHaveLength(1);
    expect(pdf.Job).toEqual(email.Job);
    expect(w.state.value.filing).toEqual({});
  });

  test('a call sheet that arrives while the invite for the same PO waits to write its details files under the invite’s job, not a second one', async () => {
    const w = await world([
      ...INVITE_SCRIPT,
      { marker: 'S1: "call-sheet-v2.pdf"', reply: CALL_SHEET_REPLY },
    ]);
    w.store.fail(
      'insertDetails',
      new SupaMacError('unavailable', 'POST /databases/query', 'down')
    );
    expect((await w.pipeline.processSource(INVITE)).kind).toBe('waiting');
    await w.pipeline.processSource({
      via: 'Telegram',
      name: 'call-sheet-v2.pdf',
      bytes: CALL_SHEET_PDF,
    });
    w.now += 2 * MINUTE;
    await w.pipeline.resume();
    const withPo = w.store
      .rows('jobs')
      .filter(([, v]) => v['PO number'] === '4500123');
    expect(withPo).toHaveLength(1);
    expect(w.store.rows('jobs')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('a retry never pays for the same source twice', () => {
  test('a health note to the owner does not stand between the model’s paid answer and saving it', async () => {
    const w = await world(INVITE_SCRIPT);
    const twoHoursAgo = new Date(w.now - 2 * HOUR).toISOString();
    // Anthropic was down and the owner was told so.
    await w.state.update((s) => {
      s.health.connections.anthropic = {
        up: false,
        since: twoHoursAgo,
        notifiedUp: false,
        notifiedAt: twoHoursAgo,
      };
    });
    let signal: () => void = () => undefined;
    const hung = new Promise<void>((resolve) => {
      signal = resolve;
    });
    // Telegram does not answer the recovery note, and the service is stopped.
    w.notifier.connection = (): Promise<void> => {
      signal();
      return never();
    };
    void w.pipeline.processSource(INVITE);
    await hung;
    expect(w.model.count('S1: "invite.pdf"')).toBe(1);
    Reflect.deleteProperty(w.notifier, 'connection');
    await restart(w, inProcess);
    await w.pipeline.processSource(INVITE);
    await settle(w);
    expect(row(w, 'sources', 'invite.pdf').Status).toBe('Needs review');
    expect(w.model.count('S1: "invite.pdf"')).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('a partial INSERT', () => {
  test('a resumed write that reads the source’s details only in part does not insert them again', async () => {
    const w = await world(INVITE_SCRIPT);
    const stop = stopAtCall(w, 'after', (m) => m === 'insertDetails');
    void w.pipeline.processSource(INVITE);
    await stop.reached;
    expect(w.store.rows('details')).toHaveLength(5);
    await restart(w, inProcess);
    let cut = false;
    useStore(
      w,
      wrapStore(w.store, async (method, args, call) => {
        const result = await call();
        const filter = args[0] as { sourceId?: string } | undefined;
        if (method !== 'details' || cut || filter?.sourceId === undefined)
          return result;
        cut = true;
        // The server cut the read short: two of five rows came back.
        const read = result as { rows: DetailRow[] };
        return { rows: read.rows.slice(0, 2), partial: true };
      })
    );
    await settle(w);
    expect(cut).toBe(true);
    expect(w.store.rows('details')).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------

describe('Jobs writes racing the owner', () => {
  test('a Jobs write whose base version moved reads the row again and keeps the cell the owner typed meanwhile', async () => {
    const w = await world(INVITE_SCRIPT);
    let raced = false;
    useStore(
      w,
      wrapStore(w.store, async (method, args, call) => {
        if (method === 'updateJob' && !raced) {
          raced = true;
          // The owner types the job's Accommodation while the service plans.
          w.store.edit(
            'jobs',
            args[0] as string,
            { Accommodation: 'Staying with family' },
            'owner'
          );
        }
        return call();
      })
    );
    await w.pipeline.processSource(INVITE);
    expect(raced).toBe(true);
    const job = onlyJob(w);
    expect(job.Accommodation).toBe('Staying with family');
    expect(job['PO number']).toBe('4500123');
    expect(w.store.calls.filter((c) => c === 'updateJob').length).toBe(2);
  });

  test('undoing an agent’s Jobs edit does not overwrite what the owner typed in that cell after the change poll read the journal', async () => {
    const w = await world(EMAIL_SCRIPT);
    await w.pipeline.processEmail(EMAIL);
    await w.pipeline.pollEdits();
    const jobId = onlyJob(w).id;
    w.store.edit('jobs', jobId, { Venue: 'Acme Arena, Hall B' }, 'agent');
    let typed = false;
    useStore(
      w,
      wrapStore(w.store, (method, args, call) => {
        if (method === 'job' && !typed && args[0] === jobId) {
          typed = true;
          w.store.edit(
            'jobs',
            jobId,
            { Venue: 'Example Hall, Leeds' },
            'owner'
          );
        }
        return call();
      })
    );
    await w.pipeline.pollEdits();
    await w.pipeline.pollEdits();
    expect(typed).toBe(true);
    expect(onlyJob(w).Venue).toBe('Example Hall, Leeds');
  });
});

// ---------------------------------------------------------------------------

describe('Found only from the service’s own checks', () => {
  test('a Status set to Found in SupaMac (by the owner’s account, as code mode is recorded) is not taken as found', async () => {
    const w = await world(INVITE_SCRIPT);
    await w.pipeline.processSource(INVITE);
    await w.pipeline.pollEdits();
    const hotel = detailOf(w, 'invite.pdf', 'Hotel');
    expect(hotel.Status).toBe('Needs review');
    expect(onlyJob(w).Accommodation ?? null).toBeNull();
    w.store.edit('details', hotel.id, { Status: 'Found' }, 'owner');
    await w.pipeline.pollEdits();
    // "Hotel TBC, likely the Example Hotel" failed check 3; only the checks make Found.
    expect(detailOf(w, 'invite.pdf', 'Hotel').Status).not.toBe('Found');
    expect(onlyJob(w).Accommodation ?? null).toBeNull();
  });

  test('an agent that changes a Found detail’s Field does not leave it Found under a field its quote was never checked for', async () => {
    const w = await world(EMAIL_SCRIPT);
    await w.pipeline.processEmail(EMAIL);
    await w.pipeline.pollEdits();
    const venue = detailOf(w, 'Leeds Lights Gala - booking', 'Venue');
    expect(venue.Status).toBe('Found');
    w.store.edit('details', venue.id, { Field: 'Hotel' }, 'agent');
    const poll = await w.pipeline.pollEdits();
    expect(poll.report.agent[0]?.rowId).toBe(venue.id);
    const after = w.store.values('details', venue.id);
    // Check 2: "Venue: Acme Arena, …" holds no label word for Hotel.
    expect(after?.Field === 'Hotel' && after.Status === 'Found').toBe(false);
    expect(onlyJob(w).Accommodation ?? null).toBeNull();
  });

  test('an agent that files a waiting source’s detail under a job does not put it in that job’s row before the owner answers', async () => {
    const w = await world([
      ...EMAIL_SCRIPT,
      { marker: 'S1: "hotel.pdf"', reply: HOTEL_REPLY },
    ]);
    await w.pipeline.processEmail(EMAIL);
    await w.pipeline.processSource({
      via: 'Telegram',
      name: 'hotel.pdf',
      bytes: HOTEL_PDF,
    });
    await w.pipeline.pollEdits();
    const hotelSource = row(w, 'sources', 'hotel.pdf');
    expect(w.state.value.filing[hotelSource.id]).toBeDefined();
    const before = onlyJob(w);
    const hotel = detailOf(w, 'hotel.pdf', 'Hotel');
    w.store.edit('details', hotel.id, { Job: [before.id] }, 'agent');
    await w.pipeline.pollEdits();
    // Design §5: its details do not touch any Jobs row until the owner answers.
    expect(onlyJob(w).Accommodation ?? null).toBe(
      (before.Accommodation as string | undefined) ?? null
    );
  });

  test('once the owner edits the Not confirmed tags, a later Found value still gets its mark', async () => {
    const w = await world([
      ...EMAIL_SCRIPT,
      { marker: 'S1: "PO-4500123.pdf"', reply: PO_REPLY },
    ]);
    await w.pipeline.processEmail(EMAIL);
    await w.pipeline.pollEdits();
    const job = onlyJob(w);
    const tags = job['Not confirmed'] as string[];
    expect(tags).toContain('Venue');
    w.store.edit(
      'jobs',
      job.id,
      { 'Not confirmed': tags.filter((t) => t !== 'Venue') },
      'owner'
    );
    await w.pipeline.pollEdits();
    await w.pipeline.processSource({
      via: 'Telegram',
      name: 'PO-4500123.pdf',
      bytes: PO_PDF,
    });
    const after = onlyJob(w);
    expect(after['Payment terms']).toBe('30 days end of month');
    expect(detailOf(w, 'PO-4500123.pdf', 'Payment terms').Status).toBe('Found');
    expect(after['Not confirmed']).toContain('Payment terms');
  });

  test('a new job is not named with words the model wrote that the source does not hold', async () => {
    const text = 'Job ref: LLG-27014\nPO: 4500123\n';
    const reply: ExtractionReplyWire = {
      source_kind: 'Invite',
      jobs: [
        {
          names: ['Grand Example Festival'],
          references: ['LLG-27014', '4500123'],
          dates: [],
        },
      ],
      details: [
        {
          field: 'Job reference',
          label: 'Job ref',
          value: 'LLG-27014',
          quote: 'Job ref: LLG-27014',
        },
        {
          field: 'PO number',
          label: 'PO',
          value: '4500123',
          quote: 'PO: 4500123',
        },
      ],
    };
    const w = await world([{ marker: 'S1: "refs.txt"', reply }]);
    await w.pipeline.processSource({
      via: 'Telegram',
      name: 'refs.txt',
      bytes: new TextEncoder().encode(text),
    });
    const name = String(onlyJob(w).Name);
    // Rule zero: nothing is invented.
    expect(text.includes(name) || name === 'refs.txt').toBe(true);
  });

  test('a detail read from a photo is Needs review, carries the image line, and reaches no Jobs cell', async () => {
    const reply: ExtractionReplyWire = {
      source_kind: 'Call sheet',
      jobs: [
        { names: ['Leeds Lights Gala'], references: ['LLG-27014'], dates: [] },
      ],
      details: [
        {
          field: 'Job reference',
          label: 'Job ref',
          value: 'LLG-27014',
          quote: 'Job ref: LLG-27014',
          page: 1,
        },
        {
          field: 'Venue',
          label: 'Venue',
          value: 'Acme Arena',
          quote: 'Venue: Acme Arena',
          page: 1,
        },
      ],
    };
    const w = await world([{ marker: 'S1: "photo.png"', reply }]);
    await w.pipeline.processSource({
      via: 'Telegram',
      name: 'photo.png',
      bytes: PHOTO,
    });
    const details = w.store.rows('details').map(([, v]) => v);
    expect(details.map((d) => d.Status)).toEqual([
      'Needs review',
      'Needs review',
    ]);
    const cards = await w.pipeline.reviewCards();
    expect(cards.map((c) => c.imageNote)).toEqual([
      'read by the model from an image; no text was checked',
      'read by the model from an image; no text was checked',
    ]);
    for (const [, job] of w.store.rows('jobs')) {
      expect(job.Venue ?? null).toBeNull();
      expect(job['Job reference'] ?? null).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------

describe('the owner’s Review and filing answers', () => {
  test('a Confirm on a detail whose value an agent changed since the card was sent reports it instead', async () => {
    const w = await world(INVITE_SCRIPT);
    await w.pipeline.processSource(INVITE);
    const [card] = await w.pipeline.reviewCards();
    expect(card?.field).toBe('Hotel');
    const detailId = card?.detailId as string;
    w.store.edit(
      'details',
      detailId,
      { Value: 'Example Hotel Leeds' },
      'agent'
    );
    const pressed = await w.pipeline.applyReview({
      detailId,
      action: 'confirm',
      fingerprint: card?.fingerprint as string,
    });
    expect(pressed.kind).toBe('changed');
    expect(w.store.values('details', detailId)?.Status).toBe('Needs review');
  });

  test('a Confirm on a detail an agent moved to another job since the card was sent reports it instead', async () => {
    const w = await world(INVITE_SCRIPT);
    await w.pipeline.processSource(INVITE);
    const [card] = await w.pipeline.reviewCards();
    const detailId = card?.detailId as string;
    const other = w.store.add('jobs', { Name: 'York Light Night' }, 'agent');
    w.store.edit('details', detailId, { Job: [other] }, 'agent');
    const pressed = await w.pipeline.applyReview({
      detailId,
      action: 'confirm',
      fingerprint: card?.fingerprint as string,
    });
    expect(pressed.kind).toBe('changed');
  });

  test('a filing question never answered touches no Jobs row, is asked once, and still waits after a restart and a month', async () => {
    const w = await world([
      ...EMAIL_SCRIPT,
      { marker: 'S1: "hotel.pdf"', reply: HOTEL_REPLY },
    ]);
    await w.pipeline.processEmail(EMAIL);
    const before = structuredClone(onlyJob(w));
    await w.pipeline.processSource({
      via: 'Telegram',
      name: 'hotel.pdf',
      bytes: HOTEL_PDF,
    });
    const hotel = row(w, 'sources', 'hotel.pdf');
    await restart(w, inProcess);
    w.now += 30 * 24 * HOUR;
    await settle(w);
    await w.pipeline.pollEdits();
    expect(w.notifier.of('filing').map((q) => q.sourceId)).toEqual([hotel.id]);
    expect(onlyJob(w)).toEqual(before);
    expect(row(w, 'sources', 'hotel.pdf').Status).toBe('Needs review');
    expect(w.state.value.filing[hotel.id]?.parts[0]?.answer).toBeUndefined();
  });

  test('an answer saved before the service stopped is filed after the restart, not reported as already answered', async () => {
    const w = await world([
      ...EMAIL_SCRIPT,
      { marker: 'S1: "hotel.pdf"', reply: HOTEL_REPLY },
    ]);
    await w.pipeline.processEmail(EMAIL);
    await w.pipeline.processSource({
      via: 'Telegram',
      name: 'hotel.pdf',
      bytes: HOTEL_PDF,
    });
    const hotel = row(w, 'sources', 'hotel.pdf');
    const jobId = onlyJob(w).id;
    // Stopped at the first read of the source's details, after the answer was saved.
    const stop = stopAtCall(w, 'before', (m) => m === 'details');
    const answer = {
      sourceId: hotel.id,
      part: null,
      choice: { kind: 'job' as const, jobId },
    };
    void w.pipeline.answerFiling(answer);
    await stop.reached;
    expect(w.state.value.filing[hotel.id]?.parts[0]?.answer?.jobId).toBe(jobId);
    await restart(w, inProcess);
    // Telegram delivers the unacknowledged button press again.
    const again = await w.pipeline.answerFiling(answer);
    await settle(w);
    expect(again.kind).toBe('filed');
    for (const [, d] of w.store.rows('details')) {
      if (((d['Source row'] as string[] | undefined) ?? []).includes(hotel.id))
        expect(d.Job).toEqual([jobId]);
    }
  });
});

// ---------------------------------------------------------------------------

describe('the monthly cap and lost bytes', () => {
  test('the cap reached by an email leaves its attachment waiting without an attempt, says so once, and files it with its email next month', async () => {
    const w = await world(EMAIL_SCRIPT);
    const month = new Date(w.now).toISOString().slice(0, 7);
    const stream = w.model.beta.messages.stream;
    w.model.beta.messages.stream = (body) => {
      const s = stream(body);
      if (!ScriptedModel.textOf(body).includes('S1: "Leeds Lights Gala'))
        return s;
      return {
        ...s,
        finalMessage: async () => {
          const message = await s.finalMessage();
          await w.state.update((st) => {
            st.spend.months[month] = 49.99;
          });
          return message;
        },
      };
    };
    const result = await w.pipeline.processEmail(EMAIL);
    expect(result.kind).toBe('finished');
    expect(result.children[0]).toMatchObject({ kind: 'waiting', paused: true });
    expect(row(w, 'sources', 'invite.pdf')).toMatchObject({
      Status: 'Processing',
      Attempts: 0,
    });
    w.now += 2 * HOUR;
    await w.pipeline.resume();
    expect(w.model.count('S1: "invite.pdf"')).toBe(0);
    expect(
      w.notifier.of('note').filter((n) => n.kind === 'spend_limit')
    ).toHaveLength(1);
    w.now = Date.parse('2027-04-01T09:00:00Z');
    await w.pipeline.resume();
    expect(w.model.count('S1: "invite.pdf"')).toBe(1);
    const job = onlyJob(w);
    expect(row(w, 'sources', 'invite.pdf').Job).toEqual([job.id]);
    expect(row(w, 'sources', 'Leeds Lights Gala - booking').Job).toEqual([
      job.id,
    ]);
  });

  test('a source failed with “send it again” is read when it is sent again', async () => {
    const w = await world(INVITE_SCRIPT);
    w.store.fail(
      'insertDetails',
      new SupaMacError('unavailable', 'POST /databases/query', 'down')
    );
    await w.pipeline.processSource(INVITE);
    // The spool file is gone (a restore without it, or its retention).
    await w.state.deleteSpool(sha256(INVITE_PDF));
    await restart(w, inProcess);
    await settle(w, 1);
    const failed = row(w, 'sources', 'invite.pdf');
    expect(failed.Status).toBe('Failed');
    expect(String(failed.Note)).toContain('send it again');
    const again = await w.pipeline.processSource(INVITE);
    await settle(w, 1);
    expect(again.kind).not.toBe('duplicate');
    expect(w.store.rows('details')).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------

describe('the Job intake folder', () => {
  test('a document that repeats a recorded source is moved to Job sources on a later poll when its first move failed', async () => {
    const w = await world([
      { marker: 'S1: "PO-4500123.pdf"', reply: PO_REPLY },
    ]);
    w.store.drop('PO-4500123.pdf', PO_PDF);
    await w.pipeline.pollFolder();
    const copy = w.store.drop('PO-4500123 copy.pdf', PO_PDF);
    w.store.fail(
      'moveDocument',
      new SupaMacError('unavailable', 'PATCH /documents/{document_id}', 'down')
    );
    await w.pipeline.pollFolder();
    expect(w.store.documents.get(copy.id)?.folder).toBe('intake');
    await w.pipeline.pollFolder();
    await w.pipeline.pollFolder();
    expect(w.store.documents.get(copy.id)?.folder).toBe('sources');
  });
});

// ---------------------------------------------------------------------------

const BOT = '123456789:AAEexampleexampleexampleexample00'; // secret-scan: fixture
const ENV = {
  JOBS_SUPAMAC_API_KEY: 'test-api-key-not-real', // secret-scan: fixture
  JOBS_OWNER_EMAIL: OWNER_EMAIL,
  ANTHROPIC_API_KEY: 'sk-ant-api03-example-key', // secret-scan: fixture
  JOBS_MONTHLY_LIMIT_USD: '20',
  JOBS_TELEGRAM_BOT_TOKEN: BOT,
};

class FailingCheckIntake implements Intake {
  readonly name = 'telegram' as const;
  async start(_context: IntakeContext): Promise<void> {}
  async stop(): Promise<void> {}
  async check(): Promise<never> {
    throw new Error(
      `getMe did not answer: https://api.telegram.org/bot${BOT}/getMe`
    );
  }
}

describe('a pinned database trashed', () => {
  test('a pinned database that is gone while the service runs is said to the owner, not only logged', async () => {
    const w = await world(INVITE_SCRIPT);
    await w.pipeline.processSource(INVITE);
    const told = w.notifier.notices.length;
    // Every statement on the pinned database is now refused as not found.
    useStore(
      w,
      wrapStore(w.store, () =>
        Promise.reject(
          new SupaMacError(
            'not_found',
            'POST /databases/query',
            'the database was not found',
            { status: 404 }
          )
        )
      )
    );
    const loops = [
      new Loop(
        'resume',
        MINUTE,
        async () => {
          await w.pipeline.resume();
        },
        w.ctx.health,
        w.ctx.logger
      ),
      new Loop(
        'edits',
        MINUTE,
        async () => {
          await w.pipeline.pollEdits();
        },
        w.ctx.health,
        w.ctx.logger
      ),
    ];
    for (let minute = 0; minute < 90; minute++) {
      w.now += MINUTE;
      for (const loop of loops) await loop.once();
    }
    expect(w.state.value.notes.lastError?.text).toContain('not found');
    expect(w.notifier.notices.length).toBeGreaterThan(told);
  });
});

describe('secrets', () => {
  test('the Jobs setup document never carries a setting’s value, even inside a check’s error', async () => {
    const store = new MemoryStore();
    const dir = await mkdtemp(join(tmpdir(), 'jobs-review-u5-'));
    dirs.push(dir);
    const lines: string[] = [];
    const service = await startService({
      env: { ...ENV, JOBS_STATE_DIR: dir },
      notifier: new RecordingNotifier(),
      intakes: [new FailingCheckIntake()],
      logger: new Logger({ sink: (line) => lines.push(line) }),
      store: () => store,
      ensureSchema: async (input): Promise<EnsureSchemaResult> => {
        const pins: JobsPins = {
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
        await input.save(pins);
        return { pins, schema: store.schema, changes: [], notes: [] };
      },
      messages: new ScriptedModel([]),
      extract: inProcess,
      loops: false,
      listen: false,
    });
    try {
      const doc = store
        .inFolder('sources')
        .find((d) => d.name === `${SETUP_NAME}.md`);
      expect(doc?.markdown).toContain('✗ Telegram');
      for (const line of lines) expect(line).not.toContain(BOT);
      expect(doc?.markdown).not.toContain(BOT);
      expect(doc?.markdown).not.toContain(BOT.split(':')[1] as string);
    } finally {
      await service.stop();
    }
  });
});
