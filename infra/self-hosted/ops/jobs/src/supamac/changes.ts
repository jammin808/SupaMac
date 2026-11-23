// What changed in a Jobs table since the service last looked, and who
// changed it (docs/supamac/jobs.md, "Edits in SupaMac").
//
// Invariants:
// - A change is the service's own when its table version is one the
//   service's writes produced, or its actor is the jobs account with no
//   agent acting; those are skipped. Every other change is reported, oldest
//   first, with who made it:
//   - `owner`: the owner's account, with no agent the journal records;
//   - `agent`: any account with an agent the journal records acting for it,
//     the owner's included;
//   - `other`: anyone else, or an internal caller (no actor). Only the
//     owner decides, so the reader treats `other` as it treats `agent`.
// - Only changes after `since` and up to the version the changes reach are
//   reported; a row's history before `since` was seen already.
// - When the server cannot list every changed row (its journal is not
//   complete, the rows are truncated, or there are more than the reader
//   reads one by one), `needsFullRead` says the table must be read whole;
//   the rows it did list are still attributed.
// - Option values are given as the spec's labels through the pinned option
//   ids; an option the owner added is reported by its label as `foreign`.
//
// Limit: the journal's `actingBot` is the only sign of an agent, and the
// server sets it only where it records one: the SupaMac assistant's own SQL
// tool does. A write through `POST /databases/query` or
// `POST /databases/{id}/ops` is journaled as the account alone, with no
// agent, even when an SDK or code-mode token carries one (a routine, or the
// assistant running code with the owner's key). Such a change reads as
// `owner` here, and nothing in the journal tells it apart from the owner's
// own edit. Until the server records the token's agent on those routes, an
// `owner` change means "made with the owner's account, by no agent the
// server named", not proof that the owner made it.

import type { DetailStatus } from '../model';
import {
  type HistoryCell,
  type RowHistoryEntry,
  rowHistoryRequest,
  tableChangesRequest,
} from './api';
import type { SupaMacClient } from './client';
import { readDate } from './sql';
import type { ResolvedColumn, ResolvedTable, TableKey } from './tables';

/** Rows whose history the reader fetches one by one before it asks for a full read. */
export const MAX_ROWS_READ = 200;

/**
 * Who made a change, as the journal records it. `owner` is the owner's
 * account with no recorded agent: see the limit in this module's header.
 */
export type ChangeAuthor = 'service' | 'owner' | 'agent' | 'other';

export interface Attribution {
  /** The jobs account's user id. */
  readonly serviceUserId: string;
  /** The owner's user id (`macro|<email>`). */
  readonly ownerUserId: string;
  /** Whether a version of a table was produced by one of the service's writes. */
  readonly isServiceVersion: (tableId: string, version: number) => boolean;
}

function same(a: string | null, b: string): boolean {
  return a !== null && a.toLowerCase() === b.toLowerCase();
}

/** Who made one change of a row's history. */
export function authorOf(
  entry: RowHistoryEntry,
  tableId: string,
  who: Attribution
): ChangeAuthor {
  if (who.isServiceVersion(tableId, entry.version)) return 'service';
  const bot = entry.actingBot !== null && entry.actingBot.trim() !== '';
  if (bot) return 'agent';
  if (same(entry.actor, who.serviceUserId)) return 'service';
  if (same(entry.actor, who.ownerUserId)) return 'owner';
  return 'other';
}

export interface RowChange {
  readonly rowId: string;
  /** The change's id in the journal. */
  readonly change: number;
  readonly version: number;
  readonly at: string;
  readonly kind: string;
  readonly author: Exclude<ChangeAuthor, 'service'>;
  readonly actor: string | null;
  readonly actingBot: string | null;
  /** The column ids it wrote. */
  readonly columns: readonly string[];
  readonly before: Readonly<Record<string, HistoryCell>>;
  readonly after: Readonly<Record<string, HistoryCell>>;
}

export interface TableChangeReport {
  readonly tableId: string;
  readonly since: number;
  /** The version the report reaches; the next read starts there. */
  readonly version: number;
  readonly needsFullRead: boolean;
  /** Columns whose shape changed (added, renamed, retyped, options): verify the schema again. */
  readonly columns: readonly {
    readonly column: string;
    readonly kind: string;
  }[];
  /** Changes by anyone but the service, oldest first. */
  readonly changes: readonly RowChange[];
  /** How many changes in range were the service's own. */
  readonly skipped: number;
}

/** Reads a table's changes since a version and attributes each. */
export async function readTableChanges(
  client: SupaMacClient,
  input: {
    readonly databaseId: string;
    readonly tableId: string;
    readonly since: number;
    readonly who: Attribution;
    readonly maxRows?: number;
  }
): Promise<TableChangeReport> {
  const changes = await client.send(
    tableChangesRequest(input.databaseId, input.tableId, input.since)
  );
  const maxRows = input.maxRows ?? MAX_ROWS_READ;
  const rows = changes.rows.slice(0, maxRows);
  const needsFullRead =
    !changes.complete || changes.truncated || changes.rows.length > maxRows;
  const out: RowChange[] = [];
  let skipped = 0;
  for (const touched of rows) {
    const history = await client.send(
      rowHistoryRequest(input.databaseId, input.tableId, touched.row)
    );
    for (const entry of history.changes) {
      if (entry.version <= input.since || entry.version > changes.version)
        continue;
      const author = authorOf(entry, input.tableId, input.who);
      if (author === 'service') {
        skipped++;
        continue;
      }
      out.push({
        rowId: touched.row,
        change: entry.change,
        version: entry.version,
        at: entry.at,
        kind: entry.kind,
        author,
        actor: entry.actor,
        actingBot: entry.actingBot,
        columns: entry.columns,
        before: entry.before,
        after: entry.after,
      });
    }
  }
  out.sort((a, b) => a.version - b.version || a.change - b.change);
  return {
    tableId: input.tableId,
    since: input.since,
    version: Math.max(changes.version, input.since),
    needsFullRead,
    columns: changes.columns,
    changes: out,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Reading a change's cells.

export type CellText =
  | { readonly kind: 'empty' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'other'; readonly type: string };

/** A text, date or number cell of a change as text; a date as the service writes it. */
export function cellText(cell: HistoryCell | undefined): CellText {
  if (cell === undefined || cell.type === 'clear') return { kind: 'empty' };
  if (cell.type === 'text') return { kind: 'text', text: cell.value };
  if (cell.type === 'date') return { kind: 'text', text: readDate(cell.value) };
  if (cell.type === 'number') return { kind: 'text', text: String(cell.value) };
  return { kind: 'other', type: cell.type };
}

export type CellOption<O extends string> =
  | { readonly kind: 'empty' }
  | { readonly kind: 'option'; readonly option: O }
  | { readonly kind: 'foreign'; readonly label: string };

/** A single-select cell of a change, as one of the column's spec labels. */
export function cellOption<O extends string>(
  column: ResolvedColumn,
  cell: HistoryCell | undefined
): CellOption<O> {
  if (cell === undefined || cell.type === 'clear') return { kind: 'empty' };
  if (cell.type !== 'options') return { kind: 'foreign', label: cell.type };
  const ref = cell.value[0];
  if (ref === undefined) return { kind: 'empty' };
  for (const [logical, option] of column.options) {
    if (
      'id' in ref
        ? ref.id === option.id
        : ref.label.toLowerCase() === option.label.toLowerCase()
    ) {
      return { kind: 'option', option: logical as O };
    }
  }
  return { kind: 'foreign', label: 'id' in ref ? ref.id : ref.label };
}

export interface CellEdit<V> {
  readonly before: V;
  readonly after: V;
}

/** A Details row change in the terms "Edits in SupaMac" decides by. */
export interface DetailEdit {
  readonly status?: CellEdit<CellOption<DetailStatus>> | undefined;
  readonly value?: CellEdit<CellText> | undefined;
  readonly quote?: CellEdit<CellText> | undefined;
  readonly day?: CellEdit<CellText> | undefined;
  /** Keys of the other spec columns it wrote. */
  readonly others: readonly string[];
  /** Ids of columns it wrote that are not the service's (the owner's own). */
  readonly unpinned: readonly string[];
}

/** What a change to a Details row did to Status, Value, Quote and Day. */
export function detailEdit(
  change: RowChange,
  details: ResolvedTable<'details'>
): DetailEdit {
  const byId = new Map<string, string>(
    Object.values(details.columns).map((c: ResolvedColumn) => [c.id, c.key])
  );
  const touched = (key: 'Status' | 'Value' | 'Quote' | 'Day'): boolean =>
    change.columns.includes(details.columns[key].id);
  const text = (
    key: 'Value' | 'Quote' | 'Day'
  ): CellEdit<CellText> | undefined => {
    if (!touched(key)) return undefined;
    const id = details.columns[key].id;
    return {
      before: cellText(change.before[id]),
      after: cellText(change.after[id]),
    };
  };
  const statusColumn = details.columns.Status;
  const status = touched('Status')
    ? {
        before: cellOption<DetailStatus>(
          statusColumn,
          change.before[statusColumn.id]
        ),
        after: cellOption<DetailStatus>(
          statusColumn,
          change.after[statusColumn.id]
        ),
      }
    : undefined;
  const named = new Set(['Status', 'Value', 'Quote', 'Day']);
  const others: string[] = [];
  const unpinned: string[] = [];
  for (const id of change.columns) {
    const key = byId.get(id);
    if (key === undefined) unpinned.push(id);
    else if (!named.has(key)) others.push(key);
  }
  return {
    status,
    value: text('Value'),
    quote: text('Quote'),
    day: text('Day'),
    others,
    unpinned,
  };
}

/** The table keys whose changes the edit poll reads. */
export const WATCHED_TABLES: readonly TableKey[] = [
  'details',
  'jobs',
  'sources',
];
