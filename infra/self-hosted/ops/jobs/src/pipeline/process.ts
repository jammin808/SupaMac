// One source end to end (docs/supamac/jobs.md §1 to §6, Operations:
// Restarts): record it, read its text, ask the model once, check every
// detail, file it, write its details and the job's row, and tell the owner.
//
// Invariants:
// - A source is recorded once: its content hash (SHA-256 of its bytes; for an
//   email, of its text pages and its attachments' hashes, so the same message
//   delivered again is the same source) is looked up in the state's index and
//   the Sources Hash column, and an email's Message-ID in the Message ID
//   column, before anything is written. A source already recorded is never
//   processed again, with one exception: a Failed source whose bytes the
//   service no longer holds is read again when they arrive again, since the
//   owner was told to send it again. When a finished email arrives again its
//   attachments are still each looked up, so one that was not recorded
//   before a crash is recorded now; an email still Processing runs its
//   attachments itself once it finishes.
// - The Sources row is written first, with status Processing, the hash, the
//   Message-ID and the thread references, after the bytes are spooled and
//   before any upload or model call; what the row has no column for (an
//   attachment's email, the content type, the way in's date) is kept by the
//   hash before it, so a record lost after the row landed is rebuilt whole.
//   An email is read (in the sandbox) once before its row, since its hash is
//   its text; until the row is written the mailbox still holds the message,
//   so nothing is lost if the service stops.
// - An email's attachments run once the email has finished, and a resumed
//   attachment waits for its email, so each files with its email (§5).
// - Every stage is saved in the state as it completes (recorded, uploaded,
//   planned, written, done), so a restart resumes each Processing source
//   from what its row and the state show: uploads are not repeated once
//   their ids are saved, and the model's reply is saved, keyed by the hash,
//   before anything else is written (a health note or a Sources write
//   included), with its cost when the AI client could not record it, so a
//   retry reads it again instead of paying for it twice. An invalid reply is
//   saved too, with why it was not taken: the owner's Retry reads it and
//   fails the same way rather than buy it again. The plan is saved before the
//   Details INSERT; a resumed write inserts only the planned details not
//   already there, and inserts nothing on a read cut short.
// - A source filed under a job whose details wait to be written (an INSERT
//   that failed) is written before another source is filed, so filing reads
//   that job with them.
// - A source's details are written in one multi-row INSERT carrying their
//   Source row, after the checks (checks.ts) and filing (derive.ts) on every
//   candidate. A source the rules cannot file becomes a question and its
//   details carry no Job, so no Jobs row changes until the owner answers.
// - A refused file is Skipped or Failed by REFUSAL_STATUS; a refusal, a cut
//   short or invalid reply, or any final error fails the source with its
//   reason; a retryable error keeps it Processing and retries with backoff
//   (1, 5 and 15 minutes); the third failed attempt fails it. Every Failed
//   source tells the owner once, with a Retry action. The monthly limit
//   pauses a source without counting an attempt; while the AI is off a
//   source that is read and uploaded waits without being read again.
// - A failure's reason reaches the Sources row and Telegram with every
//   secret masked.
// - The Sources row's Note carries what the source's reading left out: the
//   extraction's notes (page text only), attachments the request could not
//   carry, uploads that could not be made, and the source date's check when
//   it failed.
// - Sources.Sent is the source's own date as written: an email's Date (the
//   forwarded message's own, in a forward) with its offset kept, the way
//   in's own date of a forward, else the checked date the document writes.
//   Details from a quoted-history page take that page's own date instead.
//
// Choices where the design is silent, each the more cautious one:
// - A source with no details files nothing and makes no job: it is
//   Processed (or Not a job) with a note, and an email's attachments then
//   file by themselves. An attachment's source date is its own checked date
//   only; its email's date is not taken for it.
// - A new job is named from a Found Event detail, else the first name the
//   model gave the job that the source writes (in its text or its own name),
//   else the source's name. A name the source does not write is not kept for
//   the filing question either (rule zero).
// - Filing reads every job, every Found or Confirmed detail and every filed
//   source; a read the server cut short turns a filing or a new job into a
//   question, the job it chose a candidate. A filed source's sender is its
//   From only for an email, and never the owner's own address: a Telegram
//   account or a Job intake document's owner wrote none of the source.
// - A plain-text source (a forwarded Telegram message) cannot be stored as an
//   original, so its text document is; a `.docx` or a file over 25 MiB is
//   kept in the state volume and only its text document is uploaded.
// - A detail whose day check failed keeps the model's day when it is a
//   calendar date: it is Needs review, and its Check says why.
// - A crash between an upload and saving its id, or between making a job and
//   saving its id, can leave one extra document or one empty job; nothing
//   else is ever written twice.

import { createHash } from 'node:crypto';
import {
  extractionDisposition,
  extractSource,
  type ExistingJob,
  type ExtractionReply,
  interpretExtractionReply,
} from '../ai/extract';
import { monthOf } from '../ai/spend';
import { checkDetail, indexSource } from '../checks';
import { findRuns, termsOf } from '../normalize';
import {
  type Candidate,
  decideFiling,
  detailName,
  type FilingDecision,
  type FilingInput,
  type FiledSource,
  jobFacts,
  settle,
} from '../derive';
import {
  isCalendarDate,
  type SourceStatus,
  type StoredDetail,
  type Via,
} from '../model';
import { SupaMacError } from '../supamac/client';
import {
  DocumentError,
  MAX_UPLOAD_BYTES,
  pdfPageLink,
  markdownLink,
  databaseLink,
  textDocumentName,
} from '../supamac/documents';
import type { RowInput } from '../supamac/tables';
import { emailDocument, textDocument } from '../text/markdown';
import {
  type Extracted,
  REFUSAL_STATUS,
  type Refusal,
  type SourceType,
} from '../text/types';
import {
  errorText,
  isRetryable,
  noteText,
  type PipelineContext,
  PipelineError,
  sqlInstant,
} from './context';
import { type JobUpdate, recomputeJob, storedDetails } from './jobs';
import type { FilingQuestion, SourceSummary } from './notify';
import {
  addSpend,
  type PendingFiling,
  type PlannedDetail,
  type SavedReply,
  type SourceMeta,
} from './state';
import { type SourceRow, threadIdsText } from './store';

/** Attempts before a retryable failure fails the source. */
export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [60_000, 300_000, 900_000];
const PAUSE_MS = 3_600_000;

export interface SourceInput {
  readonly via: Exclude<Via, 'Email'>;
  /** The file's name, or a name for a forwarded message or a note. */
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly contentType?: string | undefined;
  /** Who sent it: a Telegram account, a folder document's owner. */
  readonly from?: string | undefined;
  /** When it arrived; now unless given. */
  readonly received?: string | undefined;
  /** The way in's own date of the source (a forward's date), ISO. */
  readonly sent?: string | undefined;
  /** A Job intake document: the source's Document, moved to Job sources once it finishes. */
  readonly folderDocumentId?: string | undefined;
}

export interface EmailInput {
  /** The message as fetched, headers and all. */
  readonly raw: Uint8Array;
  /** The From address the mail check accepted. */
  readonly from?: string | undefined;
  readonly received?: string | undefined;
}

export type SourceResult =
  | {
      readonly kind: 'duplicate';
      readonly sourceId: string;
      readonly status?: SourceStatus | undefined;
      readonly children: readonly SourceResult[];
    }
  | {
      readonly kind: 'finished';
      readonly sourceId: string;
      readonly status: SourceStatus;
      readonly children: readonly SourceResult[];
    }
  /** Still Processing: retried later (`resume`), or held by the spend limit. */
  | {
      readonly kind: 'waiting';
      readonly sourceId: string;
      readonly reason: string;
      readonly paused: boolean;
      readonly children: readonly SourceResult[];
    };

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** An email's content hash: its text pages and its attachments, not its headers. */
export function emailHash(extracted: Extracted): string {
  const pages = extracted.text.pages.map((p) =>
    p.kind === 'history'
      ? {
          kind: p.kind,
          date: p.date ?? null,
          from: p.from ?? null,
          lines: p.lines,
        }
      : { kind: p.kind, lines: p.lines }
  );
  const attachments = (extracted.email?.attachments ?? [])
    .filter((a) => a.send)
    .map((a) => sha256(a.bytes));
  return sha256(JSON.stringify({ email: true, pages, attachments }));
}

// ---------------------------------------------------------------------------
// Recording.

async function findDuplicate(
  ctx: PipelineContext,
  hash: string,
  messageId?: string
): Promise<
  SourceRow | { id: string; status?: SourceStatus | undefined } | undefined
> {
  const indexed = ctx.state.value.hashIndex[hash];
  if (indexed !== undefined) {
    return { id: indexed, status: ctx.state.value.sources[indexed]?.status };
  }
  const byHash = await ctx.store.sources({ hash });
  const found = byHash.rows[0];
  if (found !== undefined) {
    await ctx.state.update((s) => {
      s.hashIndex[hash] = found.id;
    });
    return found;
  }
  if (messageId !== undefined) {
    const byMessage = await ctx.store.sources({ messageId });
    const row = byMessage.rows[0];
    if (row !== undefined) return row;
  }
  return undefined;
}

interface Recording {
  readonly hash: string;
  readonly bytes: Uint8Array;
  readonly via: Via;
  readonly name: string;
  readonly contentType?: string | undefined;
  readonly from?: string | undefined;
  readonly received: string;
  readonly sent?: string | undefined;
  readonly parentId?: string | undefined;
  readonly folderDocumentId?: string | undefined;
  readonly messageId?: string | undefined;
  readonly threadIds?: readonly string[] | undefined;
}

async function record(ctx: PipelineContext, r: Recording): Promise<string> {
  await ctx.state.spool(r.hash, r.bytes);
  // What the row cannot carry is kept by the hash first, so a stop after the
  // row lands and before the record is saved loses none of it (metaOf).
  if (
    r.contentType !== undefined ||
    r.sent !== undefined ||
    r.parentId !== undefined ||
    r.folderDocumentId !== undefined
  ) {
    await ctx.state.update((s) => {
      s.recording[r.hash] = {
        ...(r.contentType !== undefined ? { contentType: r.contentType } : {}),
        ...(r.sent !== undefined ? { sent: r.sent } : {}),
        ...(r.parentId !== undefined ? { parentId: r.parentId } : {}),
        ...(r.folderDocumentId !== undefined
          ? { folderDocumentId: r.folderDocumentId }
          : {}),
        at: ctx.clock().toISOString(),
      };
    });
  }
  const values: RowInput<'sources'> = {
    Name: r.name,
    Via: r.via,
    From: r.from ?? null,
    Received: sqlInstant(r.received) ?? null,
    Status: 'Processing',
    Hash: r.hash,
    'Message ID': r.messageId ?? null,
    'Thread IDs': threadIdsText(r.threadIds ?? []),
    Attempts: 0,
    ...(r.folderDocumentId !== undefined
      ? { Document: r.folderDocumentId }
      : {}),
  };
  const id = await ctx.store.insertSource(values);
  const meta: SourceMeta = {
    hash: r.hash,
    via: r.via,
    name: r.name,
    received: r.received,
    stage: 'recorded',
    uploadNotes: [],
    ...(r.contentType !== undefined ? { contentType: r.contentType } : {}),
    ...(r.from !== undefined ? { from: r.from } : {}),
    ...(r.sent !== undefined ? { sent: r.sent } : {}),
    ...(r.parentId !== undefined ? { parentId: r.parentId } : {}),
    ...(r.folderDocumentId !== undefined
      ? { folderDocumentId: r.folderDocumentId, documentId: r.folderDocumentId }
      : {}),
  };
  await ctx.state.update((s) => {
    s.sources[id] = meta;
    s.hashIndex[r.hash] = id;
    delete s.recording[r.hash];
    if (r.folderDocumentId !== undefined) s.folderDocs[r.folderDocumentId] = id;
  });
  ctx.logger.info('source recorded', { sourceId: id, via: r.via });
  return id;
}

/**
 * The state record of a source, rebuilt from its row and the recording kept
 * by its hash (record) when a stop lost it.
 */
async function metaOf(
  ctx: PipelineContext,
  sourceId: string
): Promise<SourceMeta | undefined> {
  const saved = ctx.state.value.sources[sourceId];
  if (saved !== undefined) return saved;
  const row = (await ctx.store.sources({ ids: [sourceId] })).rows[0];
  if (row === undefined || row.hash === undefined || row.via === undefined)
    return undefined;
  const hash = row.hash;
  const kept = ctx.state.value.recording[hash];
  const folderDocumentId =
    kept?.folderDocumentId ??
    (row.via === 'Folder' ? row.documentId : undefined);
  const meta: SourceMeta = {
    hash,
    via: row.via,
    name: row.name,
    received: row.received ?? ctx.clock().toISOString(),
    stage: 'recorded',
    uploadNotes: [],
    ...(row.from !== undefined ? { from: row.from } : {}),
    ...(kept?.contentType !== undefined
      ? { contentType: kept.contentType }
      : {}),
    ...(kept?.sent !== undefined ? { sent: kept.sent } : {}),
    ...(kept?.parentId !== undefined ? { parentId: kept.parentId } : {}),
    ...(folderDocumentId !== undefined
      ? { folderDocumentId, documentId: folderDocumentId }
      : {}),
  };
  await ctx.state.update((s) => {
    s.sources[sourceId] = meta;
    s.hashIndex[hash] = sourceId;
    delete s.recording[hash];
    if (folderDocumentId !== undefined)
      s.folderDocs[folderDocumentId] = sourceId;
  });
  return meta;
}

async function saveMeta(
  ctx: PipelineContext,
  sourceId: string,
  change: Partial<SourceMeta>
): Promise<SourceMeta> {
  return ctx.state.update((s) => {
    const meta = s.sources[sourceId];
    if (meta === undefined)
      throw new PipelineError('final', 'the source has no state record');
    const next = { ...meta, ...change };
    s.sources[sourceId] = next;
    return next;
  });
}

// ---------------------------------------------------------------------------
// Entry points.

/** A file, photo, forwarded message or note (design §1). */
export async function processSource(
  ctx: PipelineContext,
  input: SourceInput
): Promise<SourceResult> {
  const hash = sha256(input.bytes);
  const dup = await findDuplicate(ctx, hash);
  if (dup !== undefined) {
    const revived = await revive(ctx, dup.id, hash, input.bytes);
    if (revived !== undefined) return revived;
    ctx.logger.info('source already recorded', { sourceId: dup.id });
    const children = await duplicateChildren(
      ctx,
      dup.id,
      input.bytes,
      input.name,
      input.contentType
    );
    return {
      kind: 'duplicate',
      sourceId: dup.id,
      status: dup.status,
      children,
    };
  }
  const id = await record(ctx, {
    hash,
    bytes: input.bytes,
    via: input.via,
    name: input.name,
    contentType: input.contentType,
    from: input.from,
    received: input.received ?? ctx.clock().toISOString(),
    sent: input.sent,
    folderDocumentId: input.folderDocumentId,
  });
  return run(ctx, id);
}

/** An email and each of its attachments (design §1). */
export async function processEmail(
  ctx: PipelineContext,
  input: EmailInput
): Promise<SourceResult> {
  const received = input.received ?? ctx.clock().toISOString();
  const outcome = await ctx.extract(input.raw, {
    name: 'message.eml',
    contentType: 'message/rfc822',
  });
  if (!outcome.ok || outcome.value.email === undefined) {
    const hash = sha256(input.raw);
    const dup = await findDuplicate(ctx, hash);
    if (dup !== undefined)
      return {
        kind: 'duplicate',
        sourceId: dup.id,
        status: dup.status,
        children: [],
      };
    const id = await record(ctx, {
      hash,
      bytes: input.raw,
      via: 'Email',
      name: 'Email',
      contentType: 'message/rfc822',
      from: input.from,
      received,
    });
    return run(ctx, id, outcome.ok ? undefined : outcome.refusal);
  }
  const extracted = outcome.value;
  const email = extracted.email as NonNullable<Extracted['email']>;
  const hash = emailHash(extracted);
  const dup = await findDuplicate(ctx, hash, email.messageId);
  if (dup !== undefined) {
    const revived = await revive(ctx, dup.id, hash, input.raw);
    if (revived !== undefined) return revived;
    ctx.logger.info('email already recorded', { sourceId: dup.id });
    // Its attachments run once the email has finished (run), never before.
    const children = finished(ctx, dup)
      ? await attachmentsOf(ctx, dup.id, extracted, {
          via: 'Email',
          from: extracted.text.originalSender ?? input.from ?? email.from,
          received,
        })
      : [];
    return {
      kind: 'duplicate',
      sourceId: dup.id,
      status: dup.status,
      children,
    };
  }
  const id = await record(ctx, {
    hash,
    bytes: input.raw,
    via: 'Email',
    name: email.subject?.trim() || '(no subject)',
    contentType: 'message/rfc822',
    // Sources.From: the original sender, when the email forwards a message.
    from: extracted.text.originalSender ?? input.from ?? email.from,
    received,
    messageId: email.messageId,
    threadIds: email.threadIds,
  });
  return run(ctx, id, undefined, extracted);
}

/** Whether a recorded source has reached its final status. */
function finished(
  ctx: PipelineContext,
  dup: { readonly id: string; readonly status?: SourceStatus | undefined }
): boolean {
  const meta = ctx.state.value.sources[dup.id];
  if (meta !== undefined) return meta.stage === 'done';
  return dup.status !== undefined && dup.status !== 'Processing';
}

/**
 * A source sent again that Failed because its bytes were no longer held (or
 * were pruned): the bytes arrived again, so it is read again, as the owner's
 * Retry would read it. Undefined for any other recorded source.
 */
async function revive(
  ctx: PipelineContext,
  sourceId: string,
  hash: string,
  bytes: Uint8Array
): Promise<SourceResult | undefined> {
  const meta = ctx.state.value.sources[sourceId];
  if (meta?.status !== 'Failed' || meta.hash !== hash) return undefined;
  if ((await ctx.state.readSpool(hash)) !== undefined) return undefined;
  await ctx.state.spool(hash, bytes);
  ctx.logger.info('failed source sent again; reading it again', { sourceId });
  const result = await retry(ctx, sourceId);
  return result.kind === 'not_failed' ? undefined : result;
}

/** A recorded source's attachments, when a duplicate of it arrives. */
async function duplicateChildren(
  ctx: PipelineContext,
  sourceId: string,
  bytes: Uint8Array,
  name: string,
  contentType: string | undefined
): Promise<SourceResult[]> {
  const meta = ctx.state.value.sources[sourceId];
  if (meta === undefined || meta.type !== 'eml' || meta.stage !== 'done')
    return [];
  const outcome = await ctx.extract(bytes, { name, contentType });
  if (!outcome.ok || outcome.value.email === undefined) return [];
  return attachmentsOf(ctx, sourceId, outcome.value, meta);
}

/** Records and runs each attachment of an email that is sent to the model (design §2). */
async function attachmentsOf(
  ctx: PipelineContext,
  parentId: string,
  extracted: Extracted,
  parent: Pick<SourceMeta, 'via' | 'from' | 'received'>
): Promise<SourceResult[]> {
  const out: SourceResult[] = [];
  for (const attachment of extracted.email?.attachments ?? []) {
    if (!attachment.send) continue;
    const hash = sha256(attachment.bytes);
    const dup = await findDuplicate(ctx, hash);
    if (dup !== undefined) {
      out.push({
        kind: 'duplicate',
        sourceId: dup.id,
        status: dup.status,
        children: [],
      });
      continue;
    }
    const id = await record(ctx, {
      hash,
      bytes: attachment.bytes,
      via: parent.via,
      name: attachment.name,
      contentType: attachment.contentType,
      from: parent.from,
      received: parent.received,
      parentId,
    });
    out.push(await run(ctx, id));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Running a recorded source.

/** Runs (or resumes) a recorded source from its saved stage. */
export async function run(
  ctx: PipelineContext,
  sourceId: string,
  refusal?: Refusal,
  extractedAlready?: Extracted
): Promise<SourceResult> {
  const meta = await metaOf(ctx, sourceId);
  if (meta === undefined)
    throw new PipelineError('final', 'the source is not recorded');
  if (meta.stage === 'done') {
    await sendPendingSummary(ctx, sourceId);
    return {
      kind: 'finished',
      sourceId,
      status: meta.status ?? 'Processed',
      children: [],
    };
  }
  let extracted = extractedAlready;
  let result: SourceResult;
  try {
    if (refusal !== undefined)
      return await finishRefused(ctx, sourceId, refusal);
    if (
      extracted === undefined &&
      ctx.ai === undefined &&
      meta.stage === 'uploaded' &&
      ctx.state.value.replies[meta.hash] === undefined
    ) {
      // Read and uploaded already: nothing to do until the AI is on.
      return aiOffResult(ctx, sourceId);
    }
    if (extracted === undefined) {
      const bytes = await ctx.state.readSpool(meta.hash);
      if (bytes === undefined) {
        return await finishFailed(
          ctx,
          sourceId,
          'the source’s bytes are no longer held by the service; send it again'
        );
      }
      const outcome = await ctx.extract(bytes, {
        name: meta.name,
        contentType: meta.contentType,
      });
      if (!outcome.ok)
        return await finishRefused(ctx, sourceId, outcome.refusal);
      extracted = outcome.value;
    }
    result = await stages(ctx, sourceId, extracted);
  } catch (error) {
    result = await failAttempt(ctx, sourceId, error);
  }
  // An email's attachments run once the email has finished, however it ended.
  if (result.kind !== 'finished' || extracted?.email === undefined)
    return result;
  const parent = ctx.state.value.sources[sourceId] as SourceMeta;
  const children = await attachmentsOf(ctx, sourceId, extracted, parent);
  await adoptChildrenJob(ctx, sourceId, children);
  return { ...result, children };
}

async function stages(
  ctx: PipelineContext,
  sourceId: string,
  extracted: Extracted
): Promise<SourceResult> {
  let meta = (await metaOf(ctx, sourceId)) as SourceMeta;
  if (meta.type !== extracted.type)
    meta = await saveMeta(ctx, sourceId, { type: extracted.type });
  if (meta.stage === 'recorded')
    meta = await uploads(ctx, sourceId, meta, extracted);
  if (meta.stage === 'uploaded' && isEmptyEmail(extracted)) {
    const note =
      'The email has no text of its own; its attachments are read as sources of their own.';
    await ctx.store.updateSource(sourceId, { Status: 'Processed', Note: note });
    await saveMeta(ctx, sourceId, {
      outcome: { status: 'Processed', jobIds: [], note },
    });
    await finalise(ctx, sourceId, 'Processed');
    await saveMeta(ctx, sourceId, { summaryPending: false });
    return { kind: 'finished', sourceId, status: 'Processed', children: [] };
  }
  if (meta.stage === 'uploaded') {
    const replied = await modelReply(ctx, sourceId, meta, extracted);
    if (replied.kind !== 'reply') return replied.result;
    meta = await plan(
      ctx,
      sourceId,
      meta,
      extracted,
      replied.reply,
      replied.leftOut
    );
  }
  if (meta.stage === 'planned') meta = await writeDetails(ctx, sourceId, meta);
  const updates =
    meta.stage === 'written' ? await finishWritten(ctx, sourceId, meta) : [];
  const status = ctx.state.value.sources[sourceId]?.status ?? 'Processed';
  await sendFilingQuestion(ctx, sourceId);
  await sendPendingSummary(ctx, sourceId, updates);
  return { kind: 'finished', sourceId, status, children: [] };
}

/** An email with no line of text on any page: nothing for the model to read. */
function isEmptyEmail(extracted: Extracted): boolean {
  return (
    extracted.type === 'eml' &&
    extracted.text.pages.every((p) => p.lines.every((l) => l.trim() === ''))
  );
}

// --- Uploads.

const EXTENSIONS: Readonly<Record<SourceType, string>> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  csv: 'csv',
  txt: 'txt',
  eml: 'eml',
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  ics: 'ics',
};

/** The name with the extension its bytes are, so the upload's type is the sniffed one. */
export function nameFor(name: string, type: SourceType): string {
  const ext = EXTENSIONS[type];
  const base = name.trim() === '' ? 'source' : name.trim();
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  const own = m?.[1]?.toLowerCase();
  if (own === ext || (type === 'jpeg' && own === 'jpeg')) return base;
  return `${base}.${ext}`;
}

/**
 * A subject as a document's name: a slash would read as a folder and cut the
 * name at it (documents.ts keeps a file name's last part), so it is a dash.
 */
export function documentStem(subject: string): string {
  return subject.replace(/[\\/]/g, '-');
}

const TEXT_DOCUMENT_TYPES: ReadonlySet<SourceType> = new Set([
  'pdf',
  'docx',
  'xlsx',
  'txt',
]);

async function uploads(
  ctx: PipelineContext,
  sourceId: string,
  meta: SourceMeta,
  extracted: Extracted
): Promise<SourceMeta> {
  const notes = [...meta.uploadNotes];
  let documentId = meta.documentId;
  let textDocumentId = meta.textDocumentId;
  const attempt = async <T>(
    what: string,
    upload: () => Promise<T>
  ): Promise<T | undefined> => {
    try {
      return await upload();
    } catch (error) {
      if (error instanceof DocumentError) {
        notes.push(`${what} was not stored in SupaMac: ${error.message}`);
        return undefined;
      }
      throw error;
    }
  };
  const fileName = nameFor(meta.name, extracted.type);
  if (meta.via !== 'Note') {
    if (
      extracted.type === 'eml' &&
      documentId === undefined &&
      extracted.email !== undefined
    ) {
      const email = extracted.email;
      const doc = await attempt('the email document', () =>
        ctx.store.uploadMarkdown(
          documentStem(email.subject?.trim() || meta.name),
          emailDocument(email, extracted.text),
          'sources'
        )
      );
      documentId = doc?.documentId;
      if (documentId !== undefined)
        await saveMeta(ctx, sourceId, { documentId });
    } else if (
      extracted.type !== 'eml' &&
      meta.folderDocumentId === undefined &&
      documentId === undefined
    ) {
      const bytes = await ctx.state.readSpool(meta.hash);
      const keep =
        extracted.type === 'docx' ||
        extracted.type === 'txt' ||
        (bytes !== undefined && bytes.byteLength > MAX_UPLOAD_BYTES);
      if (bytes !== undefined && keep && extracted.type !== 'txt') {
        await ctx.state.keepOriginal(
          meta.hash,
          EXTENSIONS[extracted.type],
          bytes
        );
        notes.push(
          extracted.type === 'docx'
            ? 'the Word original cannot be opened in SupaMac; it is kept by the service and its text document is the source'
            : 'the original is over 25 MiB; it is kept by the service and its text document is the source'
        );
      } else if (bytes !== undefined && !keep) {
        const doc = await attempt('the original', () =>
          ctx.store.uploadFile(fileName, bytes, 'sources')
        );
        documentId = doc?.documentId;
        if (documentId !== undefined)
          await saveMeta(ctx, sourceId, { documentId });
      }
    }
    if (
      TEXT_DOCUMENT_TYPES.has(extracted.type) &&
      textDocumentId === undefined
    ) {
      const doc = await attempt('the text document', () =>
        ctx.store.uploadMarkdown(
          textDocumentName(fileName),
          textDocument(fileName, extracted.text),
          'sources'
        )
      );
      textDocumentId = doc?.documentId;
      if (textDocumentId !== undefined)
        await saveMeta(ctx, sourceId, { textDocumentId });
    }
  }
  const detailDocumentId =
    extracted.type === 'pdf' || !TEXT_DOCUMENT_TYPES.has(extracted.type)
      ? (documentId ?? textDocumentId)
      : (textDocumentId ?? documentId);
  await ctx.store.updateSource(sourceId, {
    Document: documentId ?? null,
    Text: textDocumentId ?? null,
  });
  return saveMeta(ctx, sourceId, {
    stage: 'uploaded',
    uploadNotes: notes,
    ...(documentId !== undefined ? { documentId } : {}),
    ...(textDocumentId !== undefined ? { textDocumentId } : {}),
    ...(detailDocumentId !== undefined ? { detailDocumentId } : {}),
  });
}

// --- The model.

/** An existing job as the saved reply keeps it. */
function savedJob(job: ExistingJob): SavedReply['jobs'][number] {
  return {
    id: job.id,
    name: job.name,
    ...(job.client !== undefined ? { client: job.client } : {}),
    ...(job.dates !== undefined
      ? { dates: { start: job.dates.start, end: job.dates.end } }
      : {}),
    ...(job.days !== undefined ? { days: [...job.days] } : {}),
    ...(job.references !== undefined
      ? { references: [...job.references] }
      : {}),
  };
}

async function existingJobs(ctx: PipelineContext): Promise<ExistingJob[]> {
  const jobs = await ctx.store.jobs();
  return jobs.rows.map((j) => {
    const client = j.cells.Client;
    const dates = j.cells.Dates;
    const references = [j.cells['PO number'], j.cells['Job reference']].filter(
      (r): r is string => typeof r === 'string' && r.trim() !== ''
    );
    return {
      id: j.id,
      name: j.name || '(no name)',
      ...(typeof client === 'string' && client.trim() !== '' ? { client } : {}),
      ...(dates !== null && typeof dates === 'object' && !Array.isArray(dates)
        ? { dates: dates as { start: string; end: string } }
        : {}),
      ...(references.length > 0 ? { references } : {}),
    };
  });
}

type Replied =
  | { kind: 'reply'; reply: ExtractionReply; leftOut: readonly string[] }
  | { kind: 'stopped'; result: SourceResult };

async function modelReply(
  ctx: PipelineContext,
  sourceId: string,
  meta: SourceMeta,
  extracted: Extracted
): Promise<Replied> {
  const saved = ctx.state.value.replies[meta.hash];
  if (saved?.invalid !== undefined) {
    // A reply paid for and not taken is read the same way again, not bought again.
    return {
      kind: 'stopped',
      result: await finishFailed(ctx, sourceId, saved.invalid),
    };
  }
  if (saved !== undefined) {
    const read = interpretExtractionReply(saved.text, {
      text: extracted.text,
      existingJobs: saved.jobs,
    });
    if (!read.ok) {
      return {
        kind: 'stopped',
        result: await finishFailed(
          ctx,
          sourceId,
          `the saved reply cannot be read: ${read.reason}`
        ),
      };
    }
    return {
      kind: 'reply',
      reply: read.value,
      leftOut: saved.attachmentsLeftOut,
    };
  }
  if (ctx.ai === undefined)
    return { kind: 'stopped', result: aiOffResult(ctx, sourceId) };
  const jobs = await existingJobs(ctx);
  const bytes =
    extracted.type === 'pdf' || extracted.image !== undefined
      ? await ctx.state.readSpool(meta.hash)
      : undefined;
  const outcome = await extractSource(ctx.ai, {
    key: meta.hash,
    name: meta.name,
    via: meta.via,
    text: extracted.text,
    ...(extracted.type === 'pdf' && bytes !== undefined ? { pdf: bytes } : {}),
    ...(extracted.image !== undefined && bytes !== undefined
      ? {
          images: [
            { page: 1, mediaType: extracted.image.mediaType, data: bytes },
          ],
        }
      : {}),
    existingJobs: jobs,
  });
  // A reply that was paid for is saved first, keyed by the hash, with its
  // cost when the AI client could not record it: nothing else is written
  // before it, so a stop or a failure after this never pays for it again.
  const tokens =
    'spend' in outcome
      ? {
          input:
            outcome.spend.tokens.input +
            outcome.spend.tokens.cacheRead +
            outcome.spend.tokens.cacheWrite +
            outcome.spend.tokens.cacheWrite1h,
          output: outcome.spend.tokens.output,
        }
      : undefined;
  if ('spend' in outcome) {
    const text =
      outcome.kind === 'extracted' || outcome.kind === 'invalid'
        ? outcome.text
        : undefined;
    const owed = outcome.ledgerError !== undefined ? outcome.spend : undefined;
    if (text !== undefined || owed !== undefined) {
      await ctx.state.update((s) => {
        if (text !== undefined) {
          s.replies[meta.hash] = {
            text,
            savedAt: ctx.clock().toISOString(),
            model: outcome.servedBy,
            inputTokens: tokens?.input ?? 0,
            outputTokens: tokens?.output ?? 0,
            usd: outcome.spend.usd,
            jobs: jobs.map(savedJob),
            attachmentsLeftOut:
              outcome.kind === 'extracted'
                ? [...outcome.attachmentsLeftOut]
                : [],
            ...(outcome.kind === 'invalid' ? { invalid: outcome.reason } : {}),
          };
        }
        if (owed !== undefined) addSpend(s, owed);
      });
    }
  }
  if (outcome.kind === 'error') {
    const k = outcome.error.kind;
    const down =
      k === 'connection' ||
      k === 'timeout' ||
      k === 'overloaded' ||
      k === 'server';
    await ctx.health.connection('anthropic', !down, outcome.reason);
  } else if (outcome.kind !== 'over_cap') {
    await ctx.health.connection('anthropic', true);
  }
  if (outcome.kind === 'extracted') {
    await ctx.store.updateSource(sourceId, {
      Kind: outcome.reply.kind,
      'Input tokens': tokens?.input ?? null,
      'Output tokens': tokens?.output ?? null,
    });
    return {
      kind: 'reply',
      reply: outcome.reply,
      leftOut: outcome.attachmentsLeftOut,
    };
  }
  if (tokens !== undefined) {
    await ctx.store.updateSource(sourceId, {
      'Input tokens': tokens.input,
      'Output tokens': tokens.output,
    });
  }
  const disposition = extractionDisposition(outcome);
  switch (disposition.action) {
    case 'failed':
      return {
        kind: 'stopped',
        result: await finishFailed(ctx, sourceId, disposition.reason),
      };
    case 'retry':
      throw new PipelineError('retryable', disposition.reason);
    case 'paused':
      return {
        kind: 'stopped',
        result: await pause(
          ctx,
          sourceId,
          disposition.reason,
          outcome.kind === 'over_cap'
            ? outcome.month
            : monthOf(ctx.clock(), ctx.timeZone())
        ),
      };
    case 'done':
      throw new PipelineError(
        'final',
        'the reply was read as done without a value'
      );
  }
}

// --- Checks and filing.

/** The source's own date as Sent takes it (see the header). */
function sourceSent(
  meta: SourceMeta,
  extracted: Extracted,
  reply: ExtractionReply
): string | undefined {
  const email = extracted.email;
  const headerDate = email ? (email.forwarded?.date ?? email.date) : undefined;
  const checked =
    reply.sourceDate?.check.status === 'Found'
      ? reply.sourceDate.check.date
      : undefined;
  return headerDate ?? meta.sent ?? checked;
}

/** A day's slack for zones and clocks before a source date counts as later than its arrival. */
const FUTURE_SLACK_MS = 86_400_000;

/**
 * A source date no later than the source's arrival (and a day), else
 * undefined: a date in the future would make the source "newer" than every
 * genuine update after it, so its order is taken as unknown instead.
 */
export function boundedDate(
  date: string | undefined,
  received: string
): string | undefined {
  if (date === undefined) return undefined;
  const at = Date.parse(date);
  const arrived = Date.parse(received);
  if (Number.isNaN(at) || Number.isNaN(arrived)) return date;
  return at > arrived + FUTURE_SLACK_MS ? undefined : date;
}

function plannedDetails(
  meta: SourceMeta,
  extracted: Extracted,
  reply: ExtractionReply,
  sent: string | undefined
): PlannedDetail[] {
  const index = indexSource(extracted.text);
  return reply.details.map((candidate, i) => {
    const result = checkDetail(candidate, index);
    const day =
      result.day ??
      (candidate.day !== undefined && isCalendarDate(candidate.day)
        ? candidate.day
        : undefined);
    const page = candidate.page ?? result.page;
    const history = result.pageKind === 'history';
    const sourceDate = history
      ? boundedDate(result.historyDate, meta.received)
      : sent;
    return {
      key: `p${i}`,
      field: candidate.field,
      label: candidate.label.trim() || result.label,
      value: candidate.value,
      ...(day !== undefined ? { day } : {}),
      quote: candidate.quote,
      ...(page !== undefined ? { page } : {}),
      status: result.status,
      check: result.text,
      ...(meta.detailDocumentId !== undefined
        ? { documentId: meta.detailDocumentId }
        : {}),
      meta: {
        ...(sourceDate !== undefined ? { sourceDate } : {}),
        history,
        origin: meta.via === 'Note' ? 'note' : 'document',
        ...(result.pageKind !== undefined ? { pageKind: result.pageKind } : {}),
        ...(candidate.day_quote !== undefined
          ? { dayQuote: candidate.day_quote }
          : {}),
        ...(candidate.job !== undefined ? { jobIndex: candidate.job } : {}),
      },
    };
  });
}

/** A planned detail as the core reads it, under a key until its row id is known. */
export function plannedStored(
  p: PlannedDetail,
  sourceId: string,
  received: string
): StoredDetail {
  return {
    id: p.key,
    jobId: p.jobId,
    sourceId,
    field: p.field,
    label: p.label,
    value: p.value,
    day: p.day,
    quote: p.quote,
    page: p.page,
    status: p.status,
    check: p.check,
    received,
    documentId: p.documentId,
    sourceDate: p.meta.sourceDate,
    history: p.meta.history,
    origin: p.meta.origin,
    pageKind: p.meta.pageKind,
    dayQuote: p.meta.dayQuote,
  };
}

/** What filing needs to know of every job on file. */
export async function filingFacts(ctx: PipelineContext): Promise<{
  facts: ReturnType<typeof jobFacts>[];
  names: Map<string, string>;
  partial: boolean;
}> {
  const [jobs, current, filed] = await Promise.all([
    ctx.store.jobs(),
    ctx.store.details({ statuses: ['Found', 'Confirmed'] }),
    ctx.store.sources({ filed: true }),
  ]);
  const details = await storedDetails(ctx, current.rows);
  const sources: FiledSource[] = filed.rows.flatMap((s) =>
    s.jobIds.map((jobId) => ({
      jobId,
      // Only an email's From is a sender: a Telegram account or a Job intake
      // document's owner handed the source over and wrote none of it.
      originalSender: originalSenderOf(
        ctx,
        s.via === 'Email' ? s.from : undefined
      ),
      messageId: s.messageId,
    }))
  );
  return {
    facts: jobs.rows.map((j) =>
      jobFacts({ id: j.id, name: j.name }, details, sources)
    ),
    names: new Map(jobs.rows.map((j) => [j.id, j.name])),
    partial: jobs.partial || current.partial || filed.partial,
  };
}

/** The owner's own SupaMac address, from the account the database is shared with. */
function ownerAddress(ctx: PipelineContext): string {
  return ctx.store.schema.ownerUserId.replace(/^[^|]*\|/, '').toLowerCase();
}

/**
 * A sender as filing reads it (design §5: the original sender's domain):
 * never the owner's own address, which says nothing of the client.
 */
export function originalSenderOf(
  ctx: PipelineContext,
  from: string | undefined
): string | undefined {
  if (from === undefined) return undefined;
  const address = /([^\s<>]+@[^\s<>]+)/.exec(from)?.[1]?.toLowerCase();
  return address === ownerAddress(ctx) ? undefined : from;
}

/**
 * A decision made on a read the server cut short files nothing by itself: a
 * job missing from the read could hold the same reference, or be the job a
 * new one would duplicate. It becomes a question, the job it chose a candidate.
 */
export function partialGuard(
  decision: FilingDecision,
  partial: boolean
): FilingDecision {
  if (!partial || (decision.action !== 'file' && decision.action !== 'new_job'))
    return decision;
  return {
    action: 'ask',
    candidates:
      decision.action === 'file'
        ? [{ jobId: decision.jobId, why: decision.reason }]
        : [],
    reason:
      'the Jobs database was read only in part, so nothing is filed by itself',
  };
}

/** What an attachment's email became, for filing (design §5). */
export function attachmentState(
  ctx: PipelineContext,
  meta: SourceMeta
): FilingInput['attachmentOf'] {
  if (meta.parentId === undefined) return undefined;
  const pending = ctx.state.value.filing[meta.parentId];
  if (
    pending !== undefined &&
    pending.parts.some((p) => p.answer === undefined)
  )
    return { state: 'waiting' };
  const parent = ctx.state.value.sources[meta.parentId];
  const jobs = parent?.outcome?.jobIds ?? [];
  return jobs.length === 1
    ? { state: 'filed', jobId: jobs[0] as string }
    : undefined;
}

/**
 * The names the model gave a job that the source itself writes, in its text
 * or its own name (an email's subject, a file's name): no other words of the
 * model's name a job or reach the owner (rule zero).
 */
export function writtenNames(
  text: Extracted['text'],
  sourceName: string,
  names: readonly string[]
): string[] {
  const lines = [sourceName, ...text.pages.flatMap((p) => p.lines)].map(
    termsOf
  );
  return names.filter((name) => {
    const needle = termsOf(name);
    return (
      needle.length > 0 && lines.some((l) => findRuns(l, needle).length > 0)
    );
  });
}

/**
 * The words a proposal gives for a job on file, kept only when the source
 * writes them; otherwise empty, so no sentence the model made up reaches the
 * owner as the reason.
 */
export function writtenWords(
  text: Extracted['text'],
  sourceName: string,
  words: string
): string {
  return writtenNames(text, sourceName, [words.trim()])[0] ?? '';
}

/** The name a new job takes (see the header); `names` are written ones only. */
export function newJobName(
  details: readonly Pick<PlannedDetail, 'field' | 'status' | 'value'>[],
  names: readonly string[],
  fallback: string
): string {
  const event = details.find(
    (d) =>
      d.field === 'Event' && (d.status === 'Found' || d.status === 'Confirmed')
  );
  return (
    event?.value.trim() ||
    names[0]?.trim() ||
    fallback.trim() ||
    'New job'
  ).slice(0, 200);
}

function candidatesOf(
  decision: FilingDecision,
  names: ReadonlyMap<string, string>
): { jobId: string; name: string; why: string }[] {
  const list: readonly Candidate[] =
    decision.action === 'ask'
      ? decision.candidates
      : decision.action === 'file'
        ? [{ jobId: decision.jobId, why: decision.reason }]
        : [];
  return list.map((c) => ({
    jobId: c.jobId,
    name: names.get(c.jobId) ?? '(a job)',
    why: c.why,
  }));
}

/** Settles planned details filed under a job against the job's own (design §6). */
export async function settleUnder(
  ctx: PipelineContext,
  jobId: string,
  incoming: readonly StoredDetail[]
): Promise<{
  details: readonly StoredDetail[];
  replaced: { id: string; check: string }[];
}> {
  const existing = await ctx.store.details({ jobId });
  if (existing.partial) {
    throw new PipelineError(
      'retryable',
      'the job’s details were read only in part, so nothing was filed under it'
    );
  }
  const own = await storedDetails(ctx, existing.rows);
  const ids = new Set(incoming.map((d) => d.id));
  const settlement = settle(
    own.filter((d) => !ids.has(d.id)),
    incoming.map((d) => ({ ...d, jobId })),
    { timeZone: ctx.timeZone() }
  );
  return {
    details: settlement.details,
    replaced: settlement.replaced.map((r) => ({ id: r.id, check: r.check })),
  };
}

async function plan(
  ctx: PipelineContext,
  sourceId: string,
  meta: SourceMeta,
  extracted: Extracted,
  reply: ExtractionReply,
  leftOut: readonly string[]
): Promise<SourceMeta> {
  const claimedSent = sourceSent(meta, extracted, reply);
  const sent = boundedDate(claimedSent, meta.received);
  let planned = plannedDetails(meta, extracted, reply, sent);
  const notes: (string | undefined)[] = [
    ...extracted.notes,
    ...meta.uploadNotes,
    ...leftOut.map((l) => `Not read: ${l}.`),
    reply.sourceDate !== undefined && reply.sourceDate.check.status !== 'Found'
      ? `The source's own date was not taken: ${reply.sourceDate.check.text}`
      : undefined,
    reply.problems.length > 0
      ? `Left out of the reply: ${reply.problems.join('; ')}.`
      : undefined,
    claimedSent !== undefined && sent === undefined
      ? 'The source is dated after it arrived, so its date is not used: its values are not taken as newer than any other, and one that differs needs review.'
      : undefined,
  ];
  // The reply's job names, kept only where the source writes them.
  const jobNames = reply.jobs.map((j) =>
    writtenNames(extracted.text, meta.name, j.names)
  );
  let jobIds: string[] = [];
  let pending: PendingFiling | undefined;
  let status: SourceStatus | undefined;
  let replaced: { id: string; check: string }[] = [];
  let newJobId = meta.newJobId;

  if (reply.kind === 'Not about a job' || planned.length === 0) {
    status = reply.kind === 'Not about a job' ? 'Not a job' : 'Processed';
    notes.push(
      reply.kind === 'Not about a job'
        ? 'Not about a job; nothing was filed.'
        : 'No details were found; nothing was filed.'
    );
    planned = [];
  } else {
    await flushPlanned(ctx, sourceId);
    const { facts, names, partial } = await filingFacts(ctx);
    const input: FilingInput = {
      kind: reply.kind,
      jobsDescribed: reply.jobs.length,
      details: planned.map((p) => ({
        field: p.field,
        value: p.value,
        day: p.day,
        status: p.status,
        quote: p.quote,
      })),
      originalSender: originalSenderOf(
        ctx,
        extracted.text.originalSender ??
          (meta.via === 'Email' ? meta.from : undefined)
      ),
      threadIds: extracted.email?.threadIds ?? [],
      attachmentOf: attachmentState(ctx, meta),
      proposals: reply.jobs.flatMap((j) =>
        j.existing
          ? [
              {
                jobId: j.existing.jobId,
                words: writtenWords(
                  extracted.text,
                  meta.name,
                  j.existing.words
                ),
              },
            ]
          : []
      ),
    };
    const decision = partialGuard(decideFiling(input, facts), partial);
    notes.push(`Filing: ${decision.reason}.`);
    const pendingInput: PendingFiling['input'] = {
      kind: input.kind,
      jobsDescribed: input.jobsDescribed,
      ...(input.originalSender !== undefined
        ? { originalSender: input.originalSender }
        : {}),
      threadIds: [...input.threadIds],
      proposals: input.proposals.map((p) => ({ ...p })),
    };
    if (decision.action === 'file' || decision.action === 'new_job') {
      let jobId: string;
      if (decision.action === 'file') {
        jobId = decision.jobId;
      } else {
        if (newJobId === undefined) {
          newJobId = await ctx.store.insertJob({
            Name: newJobName(planned, jobNames[0] ?? [], meta.name),
          });
          await saveMeta(ctx, sourceId, { newJobId });
          ctx.logger.info('job created', { jobId: newJobId, sourceId });
        }
        jobId = newJobId;
      }
      jobIds = [jobId];
      const settled = await settleUnder(
        ctx,
        jobId,
        planned.map((p) => plannedStored(p, sourceId, meta.received))
      );
      planned = planned.map((p) => {
        const d = settled.details.find((x) => x.id === p.key);
        return d === undefined
          ? p
          : { ...p, jobId, status: d.status, check: d.check };
      });
      replaced = settled.replaced;
    } else if (decision.action === 'ask' || decision.action === 'wait') {
      const parts: PendingFiling['parts'] = [];
      const withEmail =
        reply.jobs.length <= 1 &&
        decision.action === 'wait' &&
        input.attachmentOf?.state === 'waiting' &&
        meta.parentId !== undefined;
      if (withEmail) {
        parts.push({
          part: null,
          names: [...(jobNames[0] ?? [])],
          candidates: [],
          reason: decision.reason,
        });
      } else if (reply.jobs.length > 1) {
        reply.jobs.forEach((job, index) => {
          const mine = planned.filter((p) => p.meta.jobIndex === index);
          const partDecision = decideFiling(
            {
              kind: reply.kind,
              jobsDescribed: 1,
              details: mine.map((p) => ({
                field: p.field,
                value: p.value,
                day: p.day,
                status: p.status,
                quote: p.quote,
              })),
              originalSender: input.originalSender,
              threadIds: [],
              proposals: job.existing
                ? [
                    {
                      jobId: job.existing.jobId,
                      words: writtenWords(
                        extracted.text,
                        meta.name,
                        job.existing.words
                      ),
                    },
                  ]
                : [],
            },
            facts
          );
          parts.push({
            part: index,
            names: [...(jobNames[index] ?? [])],
            candidates: candidatesOf(partDecision, names),
            reason: partDecision.reason,
          });
        });
        if (planned.some((p) => p.meta.jobIndex === undefined)) {
          notes.push(
            'Some details name none of the jobs the source describes; they stay unfiled.'
          );
        }
      } else {
        parts.push({
          part: null,
          names: [...(jobNames[0] ?? [])],
          candidates: candidatesOf(decision, names),
          reason: decision.reason,
        });
      }
      pending = {
        sourceId,
        askedAt: ctx.clock().toISOString(),
        ...(withEmail ? { waitingFor: meta.parentId } : {}),
        parts,
        input: pendingInput,
        notified: false,
      };
    } else {
      status = 'Not a job';
    }
  }
  status ??=
    pending !== undefined || planned.some((p) => p.status === 'Needs review')
      ? 'Needs review'
      : 'Processed';
  const outcome = {
    status,
    jobIds,
    note: noteText(notes),
    kind: reply.kind,
    ...(sent !== undefined ? { sent } : {}),
  };
  return ctx.state.update((s) => {
    const current = s.sources[sourceId] as SourceMeta;
    const next: SourceMeta = {
      ...current,
      stage: 'planned',
      planned,
      replaced,
      outcome,
      ...(newJobId !== undefined ? { newJobId } : {}),
    };
    s.sources[sourceId] = next;
    if (pending !== undefined) s.filing[sourceId] = pending;
    return next;
  });
}

// --- Writing.

/**
 * Writes the details of every other source that was filed under a job but
 * waits to write them (an INSERT that failed), so filing reads that job with
 * them and a source about the same job files under it, not under a new one.
 * A failure here fails this source's attempt too: it would file on a read
 * that misses them.
 */
async function flushPlanned(
  ctx: PipelineContext,
  sourceId: string
): Promise<void> {
  for (const [id, meta] of Object.entries(ctx.state.value.sources)) {
    if (
      id === sourceId ||
      meta.stage !== 'planned' ||
      (meta.outcome?.jobIds.length ?? 0) === 0
    )
      continue;
    ctx.logger.info('writing a waiting source first', {
      sourceId: id,
      before: sourceId,
    });
    const written = await writeDetails(ctx, id, meta);
    const updates = await finishWritten(ctx, id, written);
    await sendPendingSummary(ctx, id, updates);
  }
}

/** The Details row of a planned detail. */
export function detailRow(
  p: PlannedDetail,
  sourceId: string,
  received: string
): RowInput<'details'> {
  return {
    Name: detailName(p.field, p.value, p.status),
    Job: p.jobId === undefined ? [] : [p.jobId],
    'Source row': [sourceId],
    Field: p.field,
    Label: p.label === '' ? null : p.label,
    Value: p.value,
    Day: p.day ?? null,
    Quote: p.quote,
    Source: p.documentId ?? null,
    Page: p.page ?? null,
    Status: p.status,
    Check: p.check,
    Received: sqlInstant(received) ?? null,
  };
}

function plannedKey(p: {
  field?: string | undefined;
  value: string;
  quote: string;
  page?: number | undefined;
  label: string;
}): string {
  return JSON.stringify([
    p.field ?? '',
    p.value,
    p.quote,
    p.page ?? null,
    p.label,
  ]);
}

async function writeDetails(
  ctx: PipelineContext,
  sourceId: string,
  meta: SourceMeta
): Promise<SourceMeta> {
  const planned = meta.planned ?? [];
  const ids: (string | undefined)[] = planned.map(() => undefined);
  if (planned.length > 0) {
    // A resumed write keeps what an earlier INSERT already wrote; a read cut
    // short could hide some of it, so nothing is inserted on one.
    const there = await ctx.store.details({ sourceId });
    if (there.partial) {
      throw new PipelineError(
        'retryable',
        'the source’s details were read only in part, so none were written again'
      );
    }
    const free = there.rows.map((r) => ({ id: r.id, key: plannedKey(r) }));
    planned.forEach((p, i) => {
      const at = free.findIndex((f) => f.key === plannedKey(p));
      if (at >= 0) {
        ids[i] = free[at]?.id;
        free.splice(at, 1);
      }
    });
    const missing = planned.flatMap((p, i) =>
      ids[i] === undefined ? [{ p, i }] : []
    );
    if (missing.length > 0) {
      const inserted = await ctx.store.insertDetails(
        missing.map(({ p }) => detailRow(p, sourceId, meta.received))
      );
      missing.forEach(({ i }, k) => {
        ids[i] = inserted[k];
      });
    }
  }
  const detailIds = ids.map((id) => id as string);
  return ctx.state.update((s) => {
    planned.forEach((p, i) => {
      const id = detailIds[i] as string;
      s.details[id] = { ...p.meta };
    });
    const next: SourceMeta = {
      ...(s.sources[sourceId] as SourceMeta),
      stage: 'written',
      detailIds,
    };
    s.sources[sourceId] = next;
    return next;
  });
}

/** Applies replacements, rewrites the jobs' rows and gives the source its final status. */
async function finishWritten(
  ctx: PipelineContext,
  sourceId: string,
  meta: SourceMeta
): Promise<JobUpdate[]> {
  const replaced = meta.replaced ?? [];
  if (replaced.length > 0) {
    const rows = await ctx.store.details({ ids: replaced.map((r) => r.id) });
    for (const r of replaced) {
      const row = rows.rows.find((x) => x.id === r.id);
      if (row === undefined || row.field === undefined) continue;
      await ctx.store.updateDetail(r.id, {
        Status: 'Replaced',
        Check: r.check,
        Name: detailName(row.field, row.value, 'Replaced'),
      });
    }
  }
  const outcome = meta.outcome ?? {
    status: 'Processed' as const,
    jobIds: [],
    note: '',
  };
  const updates: JobUpdate[] = [];
  for (const jobId of outcome.jobIds) {
    const update = await recomputeJob(ctx, jobId);
    if (update !== undefined) updates.push(update);
  }
  await ctx.store.updateSource(sourceId, {
    Status: outcome.status,
    Job: [...outcome.jobIds],
    Note: outcome.note === '' ? null : outcome.note,
    ...(outcome.kind !== undefined ? { Kind: outcome.kind } : {}),
    Sent:
      outcome.sent !== undefined ? (sqlInstant(outcome.sent) ?? null) : null,
    Attempts: ctx.state.value.attempts[sourceId]?.count ?? 0,
  });
  await finalise(ctx, sourceId, outcome.status);
  return updates;
}

/**
 * Marks a source done: its state, its spool, its folder document. A Failed
 * source keeps its plan, its bytes and the stage it reached, for Retry.
 */
async function finalise(
  ctx: PipelineContext,
  sourceId: string,
  status: SourceStatus,
  failure?: string
): Promise<void> {
  const meta = await ctx.state.update((s) => {
    const current = s.sources[sourceId] as SourceMeta;
    const next: SourceMeta = {
      ...current,
      stage: 'done',
      status,
      finishedAt: ctx.clock().toISOString(),
      summaryPending: status !== 'Failed',
    };
    if (status === 'Failed') {
      if (current.stage !== 'done') next.resumeStage = current.stage;
      if (failure !== undefined) next.failure = failure;
    } else {
      delete next.planned;
      delete next.resumeStage;
      delete next.failure;
      delete s.attempts[sourceId];
    }
    s.sources[sourceId] = next;
    return next;
  });
  if (status !== 'Failed') await ctx.state.deleteSpool(meta.hash);
  await moveFolderDocument(ctx, sourceId);
  ctx.logger.info('source finished', { sourceId, status });
}

/** Moves a finished Job intake document to Job sources; the folder poll tries again if this fails. */
export async function moveFolderDocument(
  ctx: PipelineContext,
  sourceId: string
): Promise<void> {
  const meta = ctx.state.value.sources[sourceId];
  if (
    meta?.folderDocumentId === undefined ||
    meta.moved === true ||
    meta.stage !== 'done'
  )
    return;
  try {
    await ctx.store.moveDocument(meta.folderDocumentId, 'sources');
    await saveMeta(ctx, sourceId, { moved: true });
  } catch (error) {
    ctx.logger.warn('intake document not moved yet', { sourceId, error });
  }
}

async function finishRefused(
  ctx: PipelineContext,
  sourceId: string,
  refusal: Refusal
): Promise<SourceResult> {
  const status = REFUSAL_STATUS[refusal.kind];
  if (status === 'Failed') return finishFailed(ctx, sourceId, refusal.reason);
  await ctx.store.updateSource(sourceId, {
    Status: status,
    Note: noteText([refusal.reason]),
  });
  await saveMeta(ctx, sourceId, {
    outcome: { status, jobIds: [], note: refusal.reason },
  });
  await finalise(ctx, sourceId, status);
  await saveMeta(ctx, sourceId, { summaryPending: false });
  return { kind: 'finished', sourceId, status, children: [] };
}

/** Fails a source with its reason and tells the owner, with a Retry action. */
export async function finishFailed(
  ctx: PipelineContext,
  sourceId: string,
  why: string
): Promise<SourceResult> {
  // The reason reaches the Sources row and Telegram: no secret in it.
  const reason = ctx.logger.secrets.mask(why);
  const attempts = ctx.state.value.attempts[sourceId]?.count ?? 0;
  await ctx.store.updateSource(sourceId, {
    Status: 'Failed',
    Note: noteText([reason]),
    Attempts: attempts,
  });
  await finalise(ctx, sourceId, 'Failed', reason);
  await ctx.health.recordError(reason);
  const meta = ctx.state.value.sources[sourceId] as SourceMeta;
  try {
    await ctx.notifier.failure({
      sourceId,
      name: meta.name,
      reason,
      attempts,
      retry: { sourceId },
    });
  } catch (error) {
    ctx.logger.warn('failure note not delivered', { sourceId, error });
  }
  return { kind: 'finished', sourceId, status: 'Failed', children: [] };
}

/** A source held while the AI is off: nothing is attempted or counted. */
function aiOffResult(ctx: PipelineContext, sourceId: string): SourceResult {
  return {
    kind: 'waiting',
    sourceId,
    reason: ctx.aiOff ?? 'the AI settings are missing',
    paused: true,
    children: [],
  };
}

/** Holds a source while the monthly limit is reached; `month` is the AI client's, in its zone. */
async function pause(
  ctx: PipelineContext,
  sourceId: string,
  reason: string,
  month: string
): Promise<SourceResult> {
  const next = new Date(ctx.clock().getTime() + PAUSE_MS).toISOString();
  await ctx.state.update((s) => {
    const a = s.attempts[sourceId] ?? { count: 0 };
    s.attempts[sourceId] = {
      ...a,
      nextAt: next,
      lastReason: reason,
      paused: true,
    };
  });
  if (ctx.state.value.notes.pausedMonth !== month) {
    try {
      await ctx.notifier.note({
        kind: 'spend_limit',
        text: `The model is not being called: ${reason}. Sources wait until the limit allows them.`,
      });
      await ctx.state.update((s) => {
        s.notes.pausedMonth = month;
      });
    } catch (error) {
      ctx.logger.warn('spend limit note not delivered', { error });
    }
  }
  return { kind: 'waiting', sourceId, reason, paused: true, children: [] };
}

/** Counts a failed attempt: retried with backoff, or Failed on the third or a final error. */
async function failAttempt(
  ctx: PipelineContext,
  sourceId: string,
  error: unknown
): Promise<SourceResult> {
  const reason = ctx.logger.secrets.mask(errorText(error));
  const done = ctx.state.value.sources[sourceId];
  if (done?.stage === 'done') {
    // Only telling the owner failed: the source itself is finished.
    ctx.logger.warn('a finished source’s follow-up failed', {
      sourceId,
      error,
    });
    return {
      kind: 'finished',
      sourceId,
      status: done.status ?? 'Processed',
      children: [],
    };
  }
  if (error instanceof SupaMacError) {
    const down =
      error.kind === 'unavailable' ||
      error.kind === 'timeout' ||
      error.kind === 'server';
    if (down) await ctx.health.connection('supamac', false, reason);
  }
  const retryable = isRetryable(error);
  const count = (ctx.state.value.attempts[sourceId]?.count ?? 0) + 1;
  ctx.logger.warn('source attempt failed', {
    sourceId,
    attempt: count,
    retryable,
    error,
  });
  if (!retryable || count >= MAX_ATTEMPTS) {
    await ctx.state.update((s) => {
      s.attempts[sourceId] = { count, lastReason: reason };
    });
    const why = retryable ? `${reason} (after ${count} attempts)` : reason;
    try {
      return await finishFailed(ctx, sourceId, why);
    } catch (inner) {
      ctx.logger.error('source could not be marked Failed', {
        sourceId,
        error: inner,
      });
      return { kind: 'waiting', sourceId, reason, paused: false, children: [] };
    }
  }
  const nextAt = new Date(
    ctx.clock().getTime() + (BACKOFF_MS[count - 1] ?? 900_000)
  ).toISOString();
  await ctx.state.update((s) => {
    s.attempts[sourceId] = { count, nextAt, lastReason: reason };
  });
  try {
    await ctx.store.updateSource(sourceId, {
      Attempts: count,
      Note: noteText([`Attempt ${count} failed: ${reason}; trying again.`]),
    });
  } catch (inner) {
    ctx.logger.warn('attempt count not written', { sourceId, error: inner });
  }
  return { kind: 'waiting', sourceId, reason, paused: false, children: [] };
}

// --- Telling the owner.

export async function sendFilingQuestion(
  ctx: PipelineContext,
  sourceId: string
): Promise<void> {
  const pending = ctx.state.value.filing[sourceId];
  if (
    pending === undefined ||
    pending.notified ||
    pending.waitingFor !== undefined
  )
    return;
  const meta = ctx.state.value.sources[sourceId];
  const question: FilingQuestion = {
    sourceId,
    sourceName: meta?.name ?? '',
    parts: pending.parts
      .filter((p) => p.answer === undefined)
      .map((p) => ({
        part: p.part,
        names: p.names,
        candidates: p.candidates,
        reason: p.reason,
      })),
  };
  try {
    await ctx.notifier.filingQuestion(question);
    await ctx.state.update((s) => {
      const f = s.filing[sourceId];
      if (f !== undefined) f.notified = true;
    });
  } catch (error) {
    ctx.logger.warn('filing question not delivered', { sourceId, error });
  }
}

/** Builds and sends a finished source's summary; the SupaMac decisions it lists are drained once it is delivered. */
export async function sendPendingSummary(
  ctx: PipelineContext,
  sourceId: string,
  updates: readonly JobUpdate[] = []
): Promise<void> {
  try {
    await summarise(ctx, sourceId, updates);
  } catch (error) {
    ctx.logger.warn('summary not built', { sourceId, error });
  }
}

async function summarise(
  ctx: PipelineContext,
  sourceId: string,
  updates: readonly JobUpdate[]
): Promise<void> {
  const meta = ctx.state.value.sources[sourceId];
  if (meta === undefined || meta.summaryPending !== true) return;
  const ids = meta.detailIds ?? [];
  const rows = ids.length > 0 ? (await ctx.store.details({ ids })).rows : [];
  const jobIds = meta.outcome?.jobIds ?? [];
  const jobRows = jobIds.length > 0 ? (await ctx.store.jobs(jobIds)).rows : [];
  const decided = [...ctx.state.value.notes.decidedInSupamac];
  const review = ids.filter(
    (id) => rows.find((r) => r.id === id)?.status === 'Needs review'
  );
  const summary: SourceSummary = {
    sourceId,
    name: meta.name,
    via: meta.via,
    kind: meta.outcome?.kind,
    status: meta.status ?? 'Processed',
    jobs: jobIds.map((id) => ({
      id,
      name:
        jobRows.find((j) => j.id === id)?.name ??
        updates.find((u) => u.jobId === id)?.name ??
        '',
      created: meta.newJobId === id,
    })),
    counts: {
      details: rows.length,
      found: rows.filter((r) => r.status === 'Found').length,
      needsReview: review.length,
      replaced:
        (meta.replaced ?? []).length +
        rows.filter((r) => r.status === 'Replaced').length,
    },
    changes: updates.flatMap((u) => u.changes),
    kept: updates.flatMap((u) => u.plan.kept),
    notes: updates.flatMap((u) =>
      u.derivation.notes.map((n) => `${n.column}: ${n.text}`)
    ),
    review,
    sourceNote: meta.outcome?.note || undefined,
    decidedInSupamac: decided,
    ...(ctx.webApp !== undefined
      ? { links: summaryLinks(ctx, meta, jobIds[0]) }
      : {}),
  };
  try {
    await ctx.notifier.sourceSummary(summary);
  } catch (error) {
    ctx.logger.warn('summary not delivered', { sourceId, error });
    return;
  }
  await ctx.state.update((s) => {
    const m = s.sources[sourceId];
    if (m !== undefined) m.summaryPending = false;
    const sent = new Set(decided.map((d) => `${d.detailId}|${d.at}`));
    s.notes.decidedInSupamac = s.notes.decidedInSupamac.filter(
      (d) => !sent.has(`${d.detailId}|${d.at}`)
    );
    s.notes.lastSummaryAt = ctx.clock().toISOString();
  });
}

function summaryLinks(
  ctx: PipelineContext,
  meta: SourceMeta,
  jobId: string | undefined
): SourceSummary['links'] {
  const base = ctx.webApp;
  if (base === undefined) return undefined;
  const schema = ctx.store.schema;
  const source =
    meta.type === 'pdf' && meta.documentId !== undefined
      ? pdfPageLink(base, meta.documentId)
      : meta.type === 'eml' && meta.documentId !== undefined
        ? markdownLink(base, meta.documentId)
        : meta.textDocumentId !== undefined
          ? markdownLink(base, meta.textDocumentId)
          : undefined;
  const job =
    jobId !== undefined
      ? databaseLink(base, schema.databaseId, {
          tableId: schema.tables.jobs.id,
        })
      : undefined;
  return { job, source };
}

/** When an email's attachments all filed under one job, the email files there too. */
async function adoptChildrenJob(
  ctx: PipelineContext,
  sourceId: string,
  children: readonly SourceResult[]
): Promise<void> {
  const meta = ctx.state.value.sources[sourceId];
  if (
    meta === undefined ||
    (meta.outcome?.jobIds.length ?? 0) > 0 ||
    meta.outcome?.status === 'Not a job'
  )
    return;
  if (
    ctx.state.value.filing[sourceId] !== undefined ||
    (meta.detailIds ?? []).length > 0
  )
    return;
  const jobs = new Set(
    children.flatMap(
      (c) => ctx.state.value.sources[c.sourceId]?.outcome?.jobIds ?? []
    )
  );
  if (jobs.size !== 1) return;
  const jobId = [...jobs][0] as string;
  await ctx.store.updateSource(sourceId, { Job: [jobId] });
  await ctx.state.update((s) => {
    const m = s.sources[sourceId];
    if (m?.outcome !== undefined) m.outcome = { ...m.outcome, jobIds: [jobId] };
  });
}

// ---------------------------------------------------------------------------
// Resuming and retrying.

/**
 * Resumes every Processing source whose next attempt is due, one at a time,
 * and sends the summaries and filing questions a failed delivery still owes.
 */
export async function resume(ctx: PipelineContext): Promise<SourceResult[]> {
  const now = ctx.clock().getTime();
  const processing = await ctx.store.sources({ statuses: ['Processing'] });
  const ids = new Set(processing.rows.map((r) => r.id));
  for (const [id, meta] of Object.entries(ctx.state.value.sources)) {
    if (meta.stage !== 'done' && meta.status === undefined) ids.add(id);
  }
  const out: SourceResult[] = [];
  for (const id of ids) {
    const attempt = ctx.state.value.attempts[id];
    if (attempt?.nextAt !== undefined && Date.parse(attempt.nextAt) > now)
      continue;
    // An attachment runs once its email has finished, so it files with it.
    const parentId = ctx.state.value.sources[id]?.parentId;
    const parent =
      parentId === undefined ? undefined : ctx.state.value.sources[parentId];
    if (parent !== undefined && parent.stage !== 'done') continue;
    out.push(await run(ctx, id));
  }
  for (const [id, meta] of Object.entries(ctx.state.value.sources)) {
    if (meta.stage === 'done' && meta.summaryPending === true)
      await sendPendingSummary(ctx, id);
  }
  for (const id of Object.keys(ctx.state.value.filing))
    await sendFilingQuestion(ctx, id);
  return out;
}

/** The owner's Retry: a Failed source runs again from its saved stage. */
export async function retry(
  ctx: PipelineContext,
  sourceId: string
): Promise<
  SourceResult | { kind: 'not_failed'; status?: SourceStatus | undefined }
> {
  const meta = await metaOf(ctx, sourceId);
  if (meta === undefined || meta.status !== 'Failed')
    return { kind: 'not_failed', status: meta?.status };
  if ((await ctx.state.readSpool(meta.hash)) === undefined) {
    return { kind: 'not_failed', status: 'Failed' };
  }
  await ctx.state.update((s) => {
    const m = s.sources[sourceId] as SourceMeta;
    const next: SourceMeta = { ...m, stage: m.resumeStage ?? 'recorded' };
    delete next.status;
    delete next.finishedAt;
    delete next.resumeStage;
    delete next.failure;
    next.summaryPending = false;
    s.sources[sourceId] = next;
    delete s.attempts[sourceId];
  });
  await ctx.store.updateSource(sourceId, {
    Status: 'Processing',
    Attempts: 0,
    Note: null,
  });
  return run(ctx, sourceId);
}
