// What the pipeline reads and writes in SupaMac, as one interface: the rows of
// the four Jobs tables, the documents of the two folders, and each watched
// table's changes (docs/supamac/jobs.md, "The Jobs database", "Edits in
// SupaMac"). `SupaMacStore` (supamac-store.ts) implements it over the gateway;
// the tests implement it in memory.
//
// Invariants:
// - Writes take the typed row values of tables.ts, so only spec columns and
//   spec options can be named; reads give rows decoded into the shapes below.
// - Every write reports the table versions it produced to `onWrite`, so the
//   change poll can skip them.
// - A read the server cut short says so (`partial`); the pipeline never reads
//   an empty partial answer as "nothing there".
// - `updateJob` with a base version fails with a `conflict` SupaMacError when
//   the Jobs table moved on since it was read.

import type { CellValue, DateRangeCell } from '../derive';
import {
  BOOKING_OPTIONS,
  type Booking,
  DERIVED_COLUMNS,
  type DerivedColumn,
  DETAIL_STATUSES,
  type DetailStatus,
  FIELD_NAMES,
  type FieldName,
  SOURCE_KINDS,
  SOURCE_STATUSES,
  type SourceKind,
  type SourceStatus,
  VIA_OPTIONS,
  type Via,
} from '../model';
import type { Attribution, TableChangeReport } from '../supamac/changes';
import type { FolderDocument, Uploaded } from '../supamac/documents';
import {
  type FolderKey,
  type JobsSchema,
  NOT_CONFIRMED_OPTIONS,
  type RowInput,
  type TableKey,
} from '../supamac/tables';

export interface Read<T> {
  readonly rows: readonly T[];
  /** The server read only part of a table: rows may be missing. */
  readonly partial: boolean;
}

export interface SourceRow {
  readonly id: string;
  readonly name: string;
  readonly documentId?: string | undefined;
  readonly textDocumentId?: string | undefined;
  readonly kind?: SourceKind | undefined;
  readonly via?: Via | undefined;
  readonly from?: string | undefined;
  readonly sent?: string | undefined;
  readonly received?: string | undefined;
  readonly jobIds: readonly string[];
  readonly status?: SourceStatus | undefined;
  readonly hash?: string | undefined;
  readonly messageId?: string | undefined;
  readonly threadIds: readonly string[];
  readonly attempts?: number | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly note?: string | undefined;
}

export interface DetailRow {
  readonly id: string;
  readonly name: string;
  readonly jobIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly field?: FieldName | undefined;
  readonly label: string;
  readonly value: string;
  readonly day?: string | undefined;
  readonly quote: string;
  readonly documentId?: string | undefined;
  readonly page?: number | undefined;
  readonly status?: DetailStatus | undefined;
  readonly check: string;
  readonly received?: string | undefined;
}

export type JobCells = Partial<Record<DerivedColumn, CellValue>>;

export interface JobRow {
  readonly id: string;
  readonly name: string;
  readonly booking?: Booking | undefined;
  readonly cells: JobCells;
}

export interface SourceFilter {
  readonly ids?: readonly string[] | undefined;
  readonly hash?: string | undefined;
  readonly messageId?: string | undefined;
  readonly documentId?: string | undefined;
  readonly statuses?: readonly SourceStatus[] | undefined;
  readonly jobId?: string | undefined;
  /** Only sources filed under some job. */
  readonly filed?: boolean | undefined;
}

export interface DetailFilter {
  readonly ids?: readonly string[] | undefined;
  readonly jobId?: string | undefined;
  readonly sourceId?: string | undefined;
  readonly statuses?: readonly DetailStatus[] | undefined;
}

export type StatusValues = RowInput<'status'>;

export interface WriteHook {
  (
    versions: readonly { tableId: string; version: number }[]
  ): Promise<void> | void;
}

export interface JobsStore {
  readonly schema: JobsSchema;

  insertSource(values: RowInput<'sources'>): Promise<string>;
  updateSource(id: string, values: RowInput<'sources'>): Promise<void>;
  sources(filter: SourceFilter): Promise<Read<SourceRow>>;

  /** One multi-row INSERT (split only when it cannot fit one statement); ids in order. */
  insertDetails(rows: readonly RowInput<'details'>[]): Promise<string[]>;
  updateDetail(id: string, values: RowInput<'details'>): Promise<void>;
  details(filter: DetailFilter): Promise<Read<DetailRow>>;

  insertJob(values: RowInput<'jobs'>): Promise<string>;
  /** With `baseVersion`, refused (`conflict`) when the Jobs table moved on. */
  updateJob(
    id: string,
    values: RowInput<'jobs'>,
    options?: { readonly baseVersion?: number | undefined }
  ): Promise<void>;
  jobs(ids?: readonly string[]): Promise<Read<JobRow>>;
  /** One job and the Jobs table's version it was read at. */
  job(id: string): Promise<{ row: JobRow; version: number } | undefined>;

  /** Writes the Status row: the given one, or a new one; returns its id. */
  writeStatus(rowId: string | undefined, values: StatusValues): Promise<string>;

  /** The current version of each table. */
  tableVersions(): Promise<Readonly<Record<TableKey, number>>>;
  tableChanges(
    table: TableKey,
    since: number,
    who: Attribution
  ): Promise<TableChangeReport>;

  uploadFile(
    name: string,
    bytes: Uint8Array,
    folder: FolderKey
  ): Promise<Uploaded>;
  uploadMarkdown(
    name: string,
    markdown: string,
    folder: FolderKey
  ): Promise<Uploaded>;
  folderDocuments(folder: FolderKey): Promise<FolderDocument[]>;
  downloadDocument(id: string): Promise<Uint8Array>;
  moveDocument(id: string, folder: FolderKey): Promise<void>;
  readMarkdown(id: string): Promise<{ markdown: string; revision: string }>;
  writeMarkdown(id: string, markdown: string, revision: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Decoding rows read by column key.

type Values = Readonly<Record<string, unknown>>;

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function ids(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string')
    : [];
}

function oneOf<T extends string>(
  list: readonly T[],
  v: unknown
): T | undefined {
  return typeof v === 'string' && (list as readonly string[]).includes(v)
    ? (v as T)
    : undefined;
}

/** Thread IDs are kept as one text cell, space separated. */
export function threadIdsText(threadIds: readonly string[]): string | null {
  return threadIds.length === 0 ? null : threadIds.join(' ');
}

export function sourceFromValues(id: string, v: Values): SourceRow {
  return {
    id,
    name: text(v.Name) ?? '',
    documentId: text(v.Document),
    textDocumentId: text(v.Text),
    kind: oneOf(SOURCE_KINDS, v.Kind),
    via: oneOf(VIA_OPTIONS, v.Via),
    from: text(v.From),
    sent: text(v.Sent),
    received: text(v.Received),
    jobIds: ids(v.Job),
    status: oneOf(SOURCE_STATUSES, v.Status),
    hash: text(v.Hash),
    messageId: text(v['Message ID']),
    threadIds: (text(v['Thread IDs']) ?? '')
      .split(/\s+/)
      .filter((t) => t !== ''),
    attempts: num(v.Attempts),
    inputTokens: num(v['Input tokens']),
    outputTokens: num(v['Output tokens']),
    note: text(v.Note),
  };
}

export function detailFromValues(id: string, v: Values): DetailRow {
  return {
    id,
    name: text(v.Name) ?? '',
    jobIds: ids(v.Job),
    sourceIds: ids(v['Source row']),
    field: oneOf(FIELD_NAMES, v.Field),
    label: text(v.Label) ?? '',
    value: text(v.Value) ?? '',
    day: text(v.Day),
    quote: text(v.Quote) ?? '',
    documentId: text(v.Source),
    page: num(v.Page),
    status: oneOf(DETAIL_STATUSES, v.Status),
    check: text(v.Check) ?? '',
    received: text(v.Received),
  };
}

function rangeCell(v: unknown): DateRangeCell | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as { start?: unknown; end?: unknown };
  return typeof r.start === 'string' && typeof r.end === 'string'
    ? { start: r.start, end: r.end }
    : null;
}

export function jobFromValues(id: string, v: Values): JobRow {
  const cells: Record<string, CellValue> = {};
  for (const column of DERIVED_COLUMNS) {
    const raw = v[column];
    if (column === 'Dates') cells[column] = rangeCell(raw);
    else if (column === 'Not confirmed') cells[column] = ids(raw);
    else if (column === 'Rate' || column === 'Needs review')
      cells[column] = num(raw) ?? null;
    else cells[column] = typeof raw === 'string' ? raw : null;
  }
  return {
    id,
    name: text(v.Name) ?? '',
    booking: oneOf(BOOKING_OPTIONS, v.Booking),
    cells: cells as JobCells,
  };
}

/** The Jobs row values that write derived cells, by each column's type. */
export function jobCellsInput(cells: JobCells): RowInput<'jobs'> {
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(cells) as [
    DerivedColumn,
    CellValue,
  ][]) {
    if (column === 'Dates') {
      out[column] =
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? {
              start: (value as DateRangeCell).start,
              end: (value as DateRangeCell).end,
            }
          : null;
    } else if (column === 'Not confirmed') {
      out[column] = Array.isArray(value)
        ? (value as readonly string[]).filter((c) =>
            (NOT_CONFIRMED_OPTIONS as readonly string[]).includes(c)
          )
        : [];
    } else if (column === 'Rate' || column === 'Needs review') {
      out[column] = typeof value === 'number' ? value : null;
    } else {
      out[column] =
        typeof value === 'string'
          ? value
          : Array.isArray(value)
            ? (value as readonly string[]).join(', ')
            : typeof value === 'number'
              ? String(value)
              : null;
    }
  }
  return out as RowInput<'jobs'>;
}
