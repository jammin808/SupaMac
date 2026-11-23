// The Jobs database as the service creates it (docs/supamac/jobs.md, "The
// Jobs database"): its tables, their columns and select options, its saved
// views and its two folders.
//
// Invariants:
// - Names here are used once, when the database is first made; afterwards
//   the service finds every table, column, option and view by the id it
//   pinned, so the owner may rename any of them.
// - A table's first column is its row title.
// - Select and tag options are this module's fixed lists, taken from
//   model.ts; nothing a document or a model writes becomes an option.
// - Each column's key is the name the rest of the service uses for it, and
//   equals its name here.
//
// Choices where the design is silent:
// - The Status table holds, beside the design's values, when the last error
//   happened and which ways in are off ("A way in whose settings are missing
//   is off; the Status row says which").
// - The spend column is named as computed, and holds US dollars.
// - Sources Problems shows Failed, Needs review and Skipped sources; Details
//   Needs review and Sources Problems sort the newest received first.

import {
  BOOKING_OPTIONS,
  DERIVED_COLUMNS,
  DETAIL_STATUSES,
  FIELD_NAMES,
  type JobsColumn,
  SOURCE_KINDS,
  SOURCE_STATUSES,
  VIA_OPTIONS,
} from '../model';

export type ColumnKind =
  | 'text'
  | 'number'
  | 'date'
  | 'date_range'
  | 'select'
  | 'tag'
  | 'document'
  | 'relation';

export type TableKey = 'jobs' | 'sources' | 'details' | 'status';

export type ColumnSpec =
  | { readonly kind: 'text' | 'number' | 'date' | 'date_range' | 'document' }
  | { readonly kind: 'select' | 'tag'; readonly options: readonly string[] }
  | { readonly kind: 'relation'; readonly target: TableKey };

/** The Jobs columns whose values say which other columns are not confirmed. */
export const NOT_CONFIRMED_OPTIONS = DERIVED_COLUMNS.filter(
  (c) => c !== 'Not confirmed' && c !== 'Needs review'
);

const JOBS_COLUMN_SPECS = {
  Name: { kind: 'text' },
  Booking: { kind: 'select', options: BOOKING_OPTIONS },
  Dates: { kind: 'date_range' },
  Days: { kind: 'text' },
  Client: { kind: 'text' },
  'Production company': { kind: 'text' },
  Event: { kind: 'text' },
  Role: { kind: 'text' },
  Venue: { kind: 'text' },
  'Venue address': { kind: 'text' },
  'Call times': { kind: 'text' },
  Travel: { kind: 'text' },
  Accommodation: { kind: 'text' },
  Contacts: { kind: 'text' },
  'PO number': { kind: 'text' },
  'Job reference': { kind: 'text' },
  Rate: { kind: 'number' },
  Currency: { kind: 'text' },
  'Rate basis': { kind: 'text' },
  'Payment terms': { kind: 'text' },
  'Invoice to': { kind: 'text' },
  'Not confirmed': { kind: 'tag', options: NOT_CONFIRMED_OPTIONS },
  'Needs review': { kind: 'number' },
  Updated: { kind: 'date' },
} as const satisfies Record<JobsColumn, ColumnSpec>;

const SOURCES_COLUMN_SPECS = {
  Name: { kind: 'text' },
  Document: { kind: 'document' },
  Text: { kind: 'document' },
  Kind: { kind: 'select', options: SOURCE_KINDS },
  Via: { kind: 'select', options: VIA_OPTIONS },
  From: { kind: 'text' },
  Sent: { kind: 'date' },
  Received: { kind: 'date' },
  Job: { kind: 'relation', target: 'jobs' },
  Status: { kind: 'select', options: SOURCE_STATUSES },
  Hash: { kind: 'text' },
  'Message ID': { kind: 'text' },
  'Thread IDs': { kind: 'text' },
  Attempts: { kind: 'number' },
  'Input tokens': { kind: 'number' },
  'Output tokens': { kind: 'number' },
  Note: { kind: 'text' },
} as const satisfies Record<string, ColumnSpec>;

const DETAILS_COLUMN_SPECS = {
  Name: { kind: 'text' },
  Job: { kind: 'relation', target: 'jobs' },
  'Source row': { kind: 'relation', target: 'sources' },
  Field: { kind: 'select', options: FIELD_NAMES },
  Label: { kind: 'text' },
  Value: { kind: 'text' },
  Day: { kind: 'date' },
  Quote: { kind: 'text' },
  Source: { kind: 'document' },
  Page: { kind: 'number' },
  Status: { kind: 'select', options: DETAIL_STATUSES },
  Check: { kind: 'text' },
  Received: { kind: 'date' },
} as const satisfies Record<string, ColumnSpec>;

const STATUS_COLUMN_SPECS = {
  Name: { kind: 'text' },
  'Last mail check': { kind: 'date' },
  'Last Telegram poll': { kind: 'date' },
  'Last change poll': { kind: 'date' },
  'Last error': { kind: 'text' },
  'Last error at': { kind: 'date' },
  'Ways in off': { kind: 'text' },
  'AI spend this month (computed, USD)': { kind: 'number' },
} as const satisfies Record<string, ColumnSpec>;

export const TABLES = {
  jobs: { name: 'Jobs', columns: JOBS_COLUMN_SPECS },
  sources: { name: 'Sources', columns: SOURCES_COLUMN_SPECS },
  details: { name: 'Details', columns: DETAILS_COLUMN_SPECS },
  status: { name: 'Status', columns: STATUS_COLUMN_SPECS },
} as const;

/** Tables in the order they are made: a relation's target comes first. */
export const TABLE_ORDER: readonly TableKey[] = [
  'jobs',
  'sources',
  'details',
  'status',
];

export const DATABASE_NAME = 'Jobs';

export type Tables = typeof TABLES;
export type ColumnKey<T extends TableKey> = keyof Tables[T]['columns'] & string;
export type ColumnSpecOf<
  T extends TableKey,
  K extends ColumnKey<T>,
> = Tables[T]['columns'][K];

/** The columns of a table, in order, with their specs. */
export function columnsOf(table: TableKey): readonly [string, ColumnSpec][] {
  return Object.entries(TABLES[table].columns) as [string, ColumnSpec][];
}

/** A column's spec by its key; only the table's own keys, never an inherited one. */
export function columnSpec(
  table: TableKey,
  key: string
): ColumnSpec | undefined {
  const columns = TABLES[table].columns as Readonly<Record<string, ColumnSpec>>;
  return Object.hasOwn(columns, key) ? columns[key] : undefined;
}

/** Option labels of a select or tag column; empty for any other. */
export function optionsOf(spec: ColumnSpec): readonly string[] {
  return spec.kind === 'select' || spec.kind === 'tag' ? spec.options : [];
}

// ---------------------------------------------------------------------------
// Saved views.

export type ViewKey =
  | 'jobsTimeline'
  | 'jobsBoard'
  | 'detailsNeedsReview'
  | 'sourcesProblems';

export type ViewSpec =
  | {
      readonly table: 'jobs';
      readonly name: string;
      readonly layout: 'timeline';
      readonly range: ColumnKey<'jobs'>;
      readonly colorBy: ColumnKey<'jobs'>;
      readonly barFields: readonly ColumnKey<'jobs'>[];
    }
  | {
      readonly table: 'jobs';
      readonly name: string;
      readonly layout: 'board';
      readonly groupBy: ColumnKey<'jobs'>;
      readonly cardFields: readonly ColumnKey<'jobs'>[];
    }
  | {
      readonly table: 'details' | 'sources';
      readonly name: string;
      readonly layout: 'table';
      readonly statusIn: readonly string[];
      readonly sortDescending: 'Received';
    };

export const VIEWS: Readonly<Record<ViewKey, ViewSpec>> = {
  jobsTimeline: {
    table: 'jobs',
    name: 'Timeline',
    layout: 'timeline',
    range: 'Dates',
    colorBy: 'Booking',
    barFields: ['Venue', 'Role'],
  },
  jobsBoard: {
    table: 'jobs',
    name: 'Board',
    layout: 'board',
    groupBy: 'Booking',
    cardFields: ['Dates', 'Venue', 'Client', 'Needs review'],
  },
  detailsNeedsReview: {
    table: 'details',
    name: 'Needs review',
    layout: 'table',
    statusIn: ['Needs review'],
    sortDescending: 'Received',
  },
  sourcesProblems: {
    table: 'sources',
    name: 'Problems',
    layout: 'table',
    statusIn: ['Failed', 'Needs review', 'Skipped'],
    sortDescending: 'Received',
  },
};

export const VIEW_ORDER: readonly ViewKey[] = [
  'jobsTimeline',
  'jobsBoard',
  'detailsNeedsReview',
  'sourcesProblems',
];

// ---------------------------------------------------------------------------
// Folders.

export type FolderKey = 'intake' | 'sources';

export const FOLDERS: Readonly<Record<FolderKey, string>> = {
  intake: 'Job intake',
  sources: 'Job sources',
};

export const FOLDER_ORDER: readonly FolderKey[] = ['intake', 'sources'];

// ---------------------------------------------------------------------------
// The database as found: every pinned id with the name it goes by now.

export interface DateRangeValue {
  readonly start: string;
  readonly end: string;
}

/** What a statement writes into a column of this spec. */
export type CellInput<S> = S extends { readonly kind: 'text' }
  ? string | null
  : S extends { readonly kind: 'number' }
    ? number | null
    : S extends { readonly kind: 'date' }
      ? string | null
      : S extends { readonly kind: 'date_range' }
        ? DateRangeValue | null
        : S extends {
              readonly kind: 'select';
              readonly options: readonly (infer O)[];
            }
          ? O | null
          : S extends {
                readonly kind: 'tag';
                readonly options: readonly (infer O)[];
              }
            ? readonly O[]
            : S extends { readonly kind: 'document' }
              ? string | null
              : S extends { readonly kind: 'relation' }
                ? readonly string[]
                : never;

/**
 * What a read gives for a column of this spec: dates as `YYYY-MM-DD` when
 * they fall on midnight UTC (how a date is stored), else the instant.
 */
export type CellRead<S> = S extends {
  readonly kind: 'tag';
  readonly options: readonly (infer O)[];
}
  ? O[]
  : S extends { readonly kind: 'relation' }
    ? string[]
    : CellInput<S>;

export type RowInput<T extends TableKey> = {
  readonly [K in ColumnKey<T>]?: CellInput<ColumnSpecOf<T, K>>;
};

export interface ResolvedOption {
  readonly id: string;
  /** The label it goes by now, which SQL writes. */
  readonly label: string;
}

export interface ResolvedColumn {
  readonly key: string;
  readonly id: string;
  /** The name it goes by now. */
  readonly name: string;
  /** That name, quoted for SQL. */
  readonly sqlName: string;
  readonly spec: ColumnSpec;
  /** For a select or tag column: each of the spec's labels, as pinned. */
  readonly options: ReadonlyMap<string, ResolvedOption>;
}

export interface ResolvedTable<T extends TableKey = TableKey> {
  readonly key: T;
  readonly id: string;
  readonly name: string;
  /** The table's name quoted for SQL, unqualified: statements name their database. */
  readonly sqlName: string;
  readonly columns: { readonly [K in ColumnKey<T>]: ResolvedColumn };
}

export interface JobsSchema {
  readonly databaseId: string;
  readonly serviceUserId: string;
  readonly ownerUserId: string;
  readonly tables: { readonly [T in TableKey]: ResolvedTable<T> };
  /** A view the owner deleted after setup is absent. */
  readonly views: Readonly<Partial<Record<ViewKey, string>>>;
  readonly folders: Readonly<Record<FolderKey, string>>;
}
