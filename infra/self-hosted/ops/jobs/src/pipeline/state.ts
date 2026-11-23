// The service's state volume (docs/supamac/jobs.md, Operations: State): one
// JSON file, `state.json`, in the state directory, beside the spool of
// source bytes still being processed and the originals SupaMac cannot hold.
//
// Invariants:
// - The file is written atomically: a new file in the same directory,
//   fsynced, renamed over the old one, and the directory fsynced. A reader
//   (this process after a crash) sees the old state or the new one, whole.
// - It carries a schema version and is validated with zod on every load and
//   before every write. A file that does not validate, or of another version,
//   stops the start with a `StateError`; it is never overwritten, since it
//   holds the pins of the Jobs database and the owner's decisions.
// - Updates run one at a time: each takes the current value, applies a
//   change to a copy, validates and writes it, and only then makes it the
//   current value. A failed write leaves the current value as it was.
// - It holds the Telegram link, offset and processed update ids; the pins;
//   the table versions seen and written; saved model replies by content
//   hash; attempt counts; what each Details and Sources row needs that has no
//   column (model.ts); the spend ledger; the hash index; the single-use link
//   code; connection health; and the last notes.
// - It is bounded: processed update ids, the saved replies of sources that
//   finished as Processed and recordings never completed are pruned 90 days
//   on, table versions written at or below the version seen are dropped, the
//   ledger keeps 24 months of totals and its last 200 entries, and a spooled
//   source of a Failed source is deleted 90 days after it failed.
// - Spool and original files are named by a source's SHA-256 hex digest
//   only, so no name from a source reaches a path.
//
// Choices where the design is silent:
// - Source bytes are spooled before a Sources row is written and deleted
//   when the source finishes, except for a Failed source, whose bytes stay
//   for the owner's Retry. A `.docx`, and a file over the 25 MiB upload
//   limit, is kept under `originals/` for good (design, What it does not do).

import { randomBytes } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { SpendEntry, SpendLedger } from '../ai/spend';
import type { Logger } from '../log';
import {
  FIELD_NAMES,
  SOURCE_KINDS,
  SOURCE_STATUSES,
  VIA_OPTIONS,
} from '../model';
import { JobsPinsSchema } from '../supamac/schema';
import { SOURCE_TYPES } from '../text/types';

export const STATE_VERSION = 1;
export const DEFAULT_STATE_DIR = '/var/lib/supamac-jobs';
export const STATE_FILE = 'state.json';
/** How long processed update ids, replies of Processed sources and Failed spools are kept. */
export const RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;
const LEDGER_MONTHS = 24;
const LEDGER_ENTRIES = 200;

export type StateErrorKind = 'corrupt' | 'version' | 'io' | 'invalid';

export class StateError extends Error {
  readonly kind: StateErrorKind;
  constructor(
    kind: StateErrorKind,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'StateError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// The schema.

const CellValueSchema = z.union([
  z.string(),
  z.number(),
  z.object({ start: z.string(), end: z.string() }),
  z.array(z.string()),
  z.null(),
]);
const CellsSchema = z.record(z.string(), CellValueSchema);

export const DetailMetaSchema = z.object({
  /** The source's own date for this detail (model.ts StoredDetail.sourceDate). */
  sourceDate: z.string().optional(),
  history: z.boolean(),
  origin: z.enum(['document', 'note', 'owner']),
  decidedAt: z.string().optional(),
  decidedVia: z.enum(['telegram', 'supamac']).optional(),
  pageKind: z.enum(['text', 'scan', 'history']).optional(),
  dayQuote: z.string().optional(),
  /** CandidateDetail.job: which of the reply's jobs it describes. */
  jobIndex: z.number().int().nonnegative().optional(),
});
export type DetailMeta = z.infer<typeof DetailMetaSchema>;

const PlannedDetailSchema = z.object({
  /** A key of the plan's own, until the row id is known. */
  key: z.string(),
  field: z.enum(FIELD_NAMES),
  label: z.string(),
  value: z.string(),
  day: z.string().optional(),
  quote: z.string(),
  page: z.number().int().positive().optional(),
  status: z.enum([
    'Found',
    'Needs review',
    'Confirmed',
    'Rejected',
    'Replaced',
  ]),
  check: z.string(),
  documentId: z.string().optional(),
  jobId: z.string().optional(),
  meta: DetailMetaSchema,
});
export type PlannedDetail = z.infer<typeof PlannedDetailSchema>;

const ExistingJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  client: z.string().optional(),
  dates: z.object({ start: z.string(), end: z.string() }).optional(),
  days: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
});

export const SavedReplySchema = z.object({
  /** The reply's JSON text, as the model wrote it. */
  text: z.string(),
  savedAt: z.string(),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
  /** The owner's jobs as the request listed them, in order: J1 is the first. */
  jobs: z.array(ExistingJobSchema),
  attachmentsLeftOut: z.array(z.string()),
  /** Why the reply was not taken, for one that was paid for but invalid: it is never bought again. */
  invalid: z.string().optional(),
});
export type SavedReply = z.infer<typeof SavedReplySchema>;

const FilingCandidateSchema = z.object({
  jobId: z.string(),
  name: z.string(),
  why: z.string(),
});

const FilingPartSchema = z.object({
  /** The reply's job index the part files; null for a source of one job. */
  part: z.number().int().nonnegative().nullable(),
  names: z.array(z.string()),
  candidates: z.array(FilingCandidateSchema),
  reason: z.string(),
  answer: z
    .object({
      jobId: z.string(),
      choice: z.enum(['job', 'new_job']),
      at: z.string(),
      /** Set once the part's details are filed and the source written: a restart files an answer without it. */
      filed: z.boolean().optional(),
    })
    .optional(),
});
export type FilingPart = z.infer<typeof FilingPartSchema>;

export const PendingFilingSchema = z.object({
  sourceId: z.string(),
  askedAt: z.string(),
  /** Set for an attachment that waits with its email. */
  waitingFor: z.string().optional(),
  parts: z.array(FilingPartSchema),
  input: z.object({
    kind: z.enum(SOURCE_KINDS),
    jobsDescribed: z.number().int().nonnegative(),
    originalSender: z.string().optional(),
    threadIds: z.array(z.string()),
    proposals: z.array(z.object({ jobId: z.string(), words: z.string() })),
  }),
  notified: z.boolean(),
});
export type PendingFiling = z.infer<typeof PendingFilingSchema>;

export const SOURCE_STAGES = [
  /** The Sources row is written. */
  'recorded',
  /** Its documents are uploaded. */
  'uploaded',
  /** Its details are checked and filed, and the plan is saved. */
  'planned',
  /** Its Details rows are written. */
  'written',
  /** It reached its final status. */
  'done',
] as const;
export type SourceStage = (typeof SOURCE_STAGES)[number];

export const SourceMetaSchema = z.object({
  hash: z.string(),
  via: z.enum(VIA_OPTIONS),
  name: z.string(),
  contentType: z.string().optional(),
  /** Where it came from (an address, a Telegram account, a folder document's owner). */
  from: z.string().optional(),
  received: z.string(),
  /** The way in's own date of the source (a forward's date), ISO. */
  sent: z.string().optional(),
  /** model.ts SourceRecord.parentId: the email it came attached to. */
  parentId: z.string().optional(),
  /** A Job intake document, moved to Job sources once the source finishes. */
  folderDocumentId: z.string().optional(),
  stage: z.enum(SOURCE_STAGES),
  /** The stage a Failed source had reached: the owner's Retry resumes there. */
  resumeStage: z.enum(SOURCE_STAGES).optional(),
  /** The type its bytes are, once read. */
  type: z.enum(SOURCE_TYPES).optional(),
  documentId: z.string().optional(),
  textDocumentId: z.string().optional(),
  /** The document the Details rows name as their Source. */
  detailDocumentId: z.string().optional(),
  /** What the uploads could not do, for the Sources row's Note. */
  uploadNotes: z.array(z.string()),
  /** A job made for this source, pinned before its details are written. */
  newJobId: z.string().optional(),
  planned: z.array(PlannedDetailSchema).optional(),
  /** Existing details the plan replaces, with their new Check. */
  replaced: z.array(z.object({ id: z.string(), check: z.string() })).optional(),
  /** The plan's Sources row values, written when the details are. */
  outcome: z
    .object({
      status: z.enum(SOURCE_STATUSES),
      jobIds: z.array(z.string()),
      note: z.string(),
      kind: z.enum(SOURCE_KINDS).optional(),
      sent: z.string().optional(),
    })
    .optional(),
  /** Row ids of its details, in the plan's order. */
  detailIds: z.array(z.string()).optional(),
  status: z.enum(SOURCE_STATUSES).optional(),
  /** Why a Failed source failed. */
  failure: z.string().optional(),
  finishedAt: z.string().optional(),
  summaryPending: z.boolean().optional(),
  moved: z.boolean().optional(),
});
export type SourceMeta = z.infer<typeof SourceMetaSchema>;

/**
 * What a source's record says beyond its Sources row, kept by its hash from
 * before the row is written until the record is: a stop between the two
 * rebuilds the record from the row and this.
 */
export const RecordingSchema = z.object({
  contentType: z.string().optional(),
  sent: z.string().optional(),
  parentId: z.string().optional(),
  folderDocumentId: z.string().optional(),
  at: z.string(),
});
export type Recording = z.infer<typeof RecordingSchema>;

const AttemptSchema = z.object({
  count: z.number().int().nonnegative(),
  nextAt: z.string().optional(),
  lastReason: z.string().optional(),
  /** Set while the monthly limit holds the source back. */
  paused: z.boolean().optional(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

const ConnectionSchema = z.object({
  up: z.boolean(),
  since: z.string(),
  detail: z.string().optional(),
  /** The state the owner was last told of. */
  notifiedUp: z.boolean(),
  notifiedAt: z.string().optional(),
});
export type ConnectionState = z.infer<typeof ConnectionSchema>;

const LoopSchema = z.object({
  lastSuccess: z.string().optional(),
  lastError: z.string().optional(),
  lastErrorAt: z.string().optional(),
});

const DecisionNoteSchema = z.object({
  detailId: z.string(),
  status: z.string(),
  name: z.string(),
  at: z.string(),
});
export type DecisionNote = z.infer<typeof DecisionNoteSchema>;

export const StateSchema = z.object({
  version: z.literal(STATE_VERSION),
  pins: JobsPinsSchema.optional(),
  /** Schema notes already surfaced to the owner. */
  schemaNotes: z.array(z.string()),
  /** The owner's zone as `/tz` last set it. */
  timeZone: z.string().optional(),
  telegram: z.object({
    ownerId: z.number().int().positive().optional(),
    linkedAt: z.string().optional(),
    linkCode: z.object({ code: z.string(), createdAt: z.string() }).optional(),
    /** True once a code was spent: every later /start is ignored. */
    linkSpent: z.boolean(),
    offset: z.number().int().nonnegative().optional(),
    processed: z.array(z.object({ id: z.number().int(), at: z.string() })),
  }),
  /** By table id: the version the change poll reached, and versions the service wrote. */
  tables: z.record(
    z.string(),
    z.object({
      seen: z.number().int().nonnegative(),
      written: z.array(z.number().int()),
    })
  ),
  replies: z.record(z.string(), SavedReplySchema),
  attempts: z.record(z.string(), AttemptSchema),
  details: z.record(z.string(), DetailMetaSchema),
  sources: z.record(z.string(), SourceMetaSchema),
  /** Content hash → Sources row id. */
  hashIndex: z.record(z.string(), z.string()),
  /** By content hash: sources whose row may be written while their record is not yet. */
  recording: z.record(z.string(), RecordingSchema).default({}),
  /** Job intake document id → Sources row id. */
  folderDocs: z.record(z.string(), z.string()),
  filing: z.record(z.string(), PendingFilingSchema),
  /** By job id: the cells the service last wrote, and a write in flight. */
  jobs: z.record(
    z.string(),
    z.object({ lastWritten: CellsSchema, pending: CellsSchema.optional() })
  ),
  spend: z.object({
    months: z.record(z.string(), z.number().nonnegative()),
    entries: z.array(
      z.object({
        month: z.string(),
        at: z.string(),
        purpose: z.string(),
        key: z.string().optional(),
        model: z.string(),
        usd: z.number().nonnegative(),
        input: z.number().int().nonnegative(),
        output: z.number().int().nonnegative(),
      })
    ),
  }),
  health: z.object({
    connections: z.record(z.string(), ConnectionSchema),
    loops: z.record(z.string(), LoopSchema),
  }),
  notes: z.object({
    lastError: z.object({ text: z.string(), at: z.string() }).optional(),
    /** Details confirmed or rejected in SupaMac since the last summary. */
    decidedInSupamac: z.array(DecisionNoteSchema),
    /** The month the owner was told the spend limit was reached. */
    pausedMonth: z.string().optional(),
    lastSummaryAt: z.string().optional(),
  }),
  setup: z.object({
    documentId: z.string().optional(),
    /** SHA-256 of the Markdown last written. */
    hash: z.string().optional(),
  }),
  statusRowId: z.string().optional(),
});
export type State = z.infer<typeof StateSchema>;

export function emptyState(): State {
  return {
    version: STATE_VERSION,
    schemaNotes: [],
    telegram: { linkSpent: false, processed: [] },
    tables: {},
    replies: {},
    attempts: {},
    details: {},
    sources: {},
    hashIndex: {},
    recording: {},
    folderDocs: {},
    filing: {},
    jobs: {},
    spend: { months: {}, entries: [] },
    health: { connections: {}, loops: {} },
    notes: { decidedInSupamac: [] },
    setup: {},
  };
}

// ---------------------------------------------------------------------------
// Files.

const HASH_RE = /^[0-9a-f]{64}$/;

function checkHash(hash: string): string {
  if (!HASH_RE.test(hash))
    throw new StateError(
      'invalid',
      'a spool file is named by a SHA-256 hex digest'
    );
  return hash;
}

const EXTENSION_RE = /^[a-z0-9]{1,8}$/;

/** Writes `data` to `path` atomically: a temp file, fsync, rename, directory fsync. */
export async function writeFileAtomic(
  path: string,
  dir: string,
  data: string | Uint8Array
): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  const folder = await open(dir, 'r');
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The store.

export interface StateStoreOptions {
  readonly clock?: (() => Date) | undefined;
  readonly logger?: Logger | undefined;
}

export class StateStore {
  readonly dir: string;
  private current: State;
  private readonly clock: () => Date;
  private readonly logger: Logger | undefined;
  private lane: Promise<unknown> = Promise.resolve();

  private constructor(dir: string, state: State, options: StateStoreOptions) {
    this.dir = dir;
    this.current = state;
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger;
  }

  /** Opens the state in `dir`, making the directory and a fresh state when there is none. */
  static async open(
    dir: string,
    options: StateStoreOptions = {}
  ): Promise<StateStore> {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await mkdir(join(dir, 'spool'), { recursive: true, mode: 0o700 });
      await mkdir(join(dir, 'originals'), { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new StateError('io', 'the state directory cannot be made', {
        cause: error,
      });
    }
    const path = join(dir, STATE_FILE);
    let state: State;
    if (await exists(path)) {
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(path, 'utf8'));
      } catch (error) {
        throw new StateError(
          'corrupt',
          `${path} is not JSON; it is left as it is`,
          {
            cause: error,
          }
        );
      }
      const version =
        typeof raw === 'object' && raw !== null && 'version' in raw
          ? (raw as { version: unknown }).version
          : undefined;
      if (version !== STATE_VERSION) {
        throw new StateError(
          'version',
          `${path} has state version ${String(version)}; this service reads version ${STATE_VERSION}`
        );
      }
      const parsed = StateSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new StateError(
          'corrupt',
          `${path} does not validate${issue ? ` at ${issue.path.join('.') || 'the top'}: ${issue.message}` : ''}; it is left as it is`
        );
      }
      state = parsed.data;
    } else {
      state = emptyState();
    }
    const store = new StateStore(dir, state, options);
    await store.update((s) => store.pruneDraft(s));
    return store;
  }

  /** The current state. Treat it as read-only: change it with `update`. */
  get value(): State {
    return this.current;
  }

  /**
   * Applies `change` to a copy of the state, validates it, writes it
   * atomically and makes it current; runs after every earlier update.
   */
  update<T>(change: (draft: State) => T): Promise<T> {
    const run = this.lane.then(async () => {
      const draft = structuredClone(this.current);
      const result = change(draft);
      const parsed = StateSchema.safeParse(draft);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new StateError(
          'invalid',
          `a state update does not validate${issue ? ` at ${issue.path.join('.')}: ${issue.message}` : ''}`
        );
      }
      await writeFileAtomic(
        join(this.dir, STATE_FILE),
        this.dir,
        `${JSON.stringify(parsed.data)}\n`
      );
      this.current = parsed.data;
      return result;
    });
    this.lane = run.catch(() => undefined);
    return run;
  }

  /** Prunes what is past its retention (see the header). */
  prune(): Promise<void> {
    return this.update((s) => this.pruneDraft(s));
  }

  private pruneDraft(s: State): void {
    const now = this.clock().getTime();
    const cutoff = now - RETENTION_DAYS * DAY_MS;
    const old = (at: string | undefined): boolean =>
      at !== undefined && Date.parse(at) < cutoff;
    s.telegram.processed = s.telegram.processed.filter((u) => !old(u.at));
    for (const [hash, sourceId] of Object.entries(s.hashIndex)) {
      const meta = s.sources[sourceId];
      if (
        s.replies[hash] !== undefined &&
        meta?.status === 'Processed' &&
        old(meta.finishedAt)
      ) {
        delete s.replies[hash];
      }
    }
    for (const [hash, r] of Object.entries(s.recording))
      if (old(r.at)) delete s.recording[hash];
    for (const table of Object.values(s.tables))
      table.written = table.written.filter((v) => v > table.seen);
    const months = Object.keys(s.spend.months).sort();
    for (const month of months.slice(
      0,
      Math.max(0, months.length - LEDGER_MONTHS)
    ))
      delete s.spend.months[month];
    s.spend.entries = s.spend.entries.slice(-LEDGER_ENTRIES);
  }

  /** Deletes the spool of Failed sources past their retention. */
  async pruneSpool(): Promise<void> {
    const cutoff = this.clock().getTime() - RETENTION_DAYS * DAY_MS;
    for (const meta of Object.values(this.current.sources)) {
      if (
        meta.status === 'Failed' &&
        meta.finishedAt !== undefined &&
        Date.parse(meta.finishedAt) < cutoff
      ) {
        await this.deleteSpool(meta.hash);
      }
    }
  }

  // --- Spool and originals.

  private spoolPath(hash: string): string {
    return join(this.dir, 'spool', checkHash(hash));
  }

  /** Keeps a source's bytes until it finishes. */
  async spool(hash: string, bytes: Uint8Array): Promise<void> {
    const path = this.spoolPath(hash);
    if (await exists(path)) return;
    await writeFileAtomic(path, join(this.dir, 'spool'), bytes);
  }

  /** A spooled source's bytes, or undefined when they are no longer held. */
  async readSpool(hash: string): Promise<Uint8Array | undefined> {
    const path = this.spoolPath(hash);
    try {
      return new Uint8Array(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async deleteSpool(hash: string): Promise<void> {
    try {
      await unlink(this.spoolPath(hash));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /** Keeps an original SupaMac cannot hold; returns its path inside the state directory. */
  async keepOriginal(
    hash: string,
    extension: string,
    bytes: Uint8Array
  ): Promise<string> {
    if (!EXTENSION_RE.test(extension))
      throw new StateError(
        'invalid',
        'an original keeps a short lower-case extension'
      );
    const name = `${checkHash(hash)}.${extension}`;
    const path = join(this.dir, 'originals', name);
    if (!(await exists(path)))
      await writeFileAtomic(path, join(this.dir, 'originals'), bytes);
    return join('originals', name);
  }

  // --- Telegram.

  /** The linked owner's Telegram id, if any. */
  get ownerId(): number | undefined {
    return this.current.telegram.ownerId;
  }

  /** The single-use link code, made when no owner is linked and none was ever spent. */
  async linkCode(): Promise<string | undefined> {
    const t = this.current.telegram;
    if (t.ownerId !== undefined || t.linkSpent) return undefined;
    if (t.linkCode !== undefined) return t.linkCode.code;
    const code = linkCodeText();
    await this.update((s) => {
      s.telegram.linkCode = { code, createdAt: this.clock().toISOString() };
    });
    return code;
  }

  /**
   * Spends the link code: true when `code` is the current one, and the owner
   * is linked. Every later attempt, right or wrong, is false.
   */
  spendLinkCode(code: string, ownerId: number): Promise<boolean> {
    return this.update((s) => {
      const t = s.telegram;
      if (t.ownerId !== undefined || t.linkSpent || t.linkCode === undefined)
        return false;
      if (!timingSafeEqualText(t.linkCode.code, code.trim().toUpperCase()))
        return false;
      t.ownerId = ownerId;
      t.linkedAt = this.clock().toISOString();
      t.linkSpent = true;
      delete t.linkCode;
      return true;
    });
  }

  /** Sets the owner from `JOBS_TELEGRAM_OWNER_ID`; no code is ever needed then. */
  setOwnerId(ownerId: number): Promise<void> {
    return this.update((s) => {
      if (s.telegram.ownerId === ownerId) return;
      s.telegram.ownerId = ownerId;
      s.telegram.linkedAt = this.clock().toISOString();
      s.telegram.linkSpent = true;
      delete s.telegram.linkCode;
    });
  }

  isUpdateProcessed(updateId: number): boolean {
    return this.current.telegram.processed.some((u) => u.id === updateId);
  }

  /** Records a handled update and moves the offset past it. */
  markUpdateProcessed(updateId: number): Promise<void> {
    return this.update((s) => {
      if (!s.telegram.processed.some((u) => u.id === updateId))
        s.telegram.processed.push({
          id: updateId,
          at: this.clock().toISOString(),
        });
      s.telegram.offset = Math.max(s.telegram.offset ?? 0, updateId + 1);
    });
  }

  // --- Table versions.

  /** Whether one of the service's writes produced this version of a table. */
  isServiceVersion(tableId: string, version: number): boolean {
    return this.current.tables[tableId]?.written.includes(version) ?? false;
  }

  /** Records versions the service's writes produced. */
  recordWritten(
    versions: readonly { tableId: string; version: number }[]
  ): Promise<void> {
    if (versions.length === 0) return Promise.resolve();
    return this.update((s) => {
      for (const { tableId, version } of versions) {
        const table = s.tables[tableId] ?? { seen: 0, written: [] };
        if (!table.written.includes(version)) table.written.push(version);
        s.tables[tableId] = table;
      }
    });
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Ten characters from an unambiguous alphabet: about 50 bits. */
function linkCodeText(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function timingSafeEqualText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// The spend ledger the AI client reads, kept in the state.

/** Adds a spend entry to a draft of the state: the month's total and the entry. */
export function addSpend(s: State, entry: SpendEntry): void {
  s.spend.months[entry.month] = (s.spend.months[entry.month] ?? 0) + entry.usd;
  s.spend.entries.push({
    month: entry.month,
    at: entry.at,
    purpose: entry.purpose,
    ...(entry.key !== undefined ? { key: entry.key } : {}),
    model: entry.model,
    usd: entry.usd,
    input:
      entry.tokens.input +
      entry.tokens.cacheRead +
      entry.tokens.cacheWrite +
      entry.tokens.cacheWrite1h,
    output: entry.tokens.output,
  });
  s.spend.entries = s.spend.entries.slice(-LEDGER_ENTRIES);
}

export class StateLedger implements SpendLedger {
  constructor(private readonly state: StateStore) {}

  spent(month: string): number {
    return this.state.value.spend.months[month] ?? 0;
  }

  async record(entry: SpendEntry): Promise<void> {
    await this.state.update((s) => addSpend(s, entry));
  }
}
