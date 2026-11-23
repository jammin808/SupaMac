// SQL for the Jobs database, built by the service only (docs/supamac/jobs.md,
// Security, "SQL"; the dialect is crates/databases_sql/src/toolset/sql_guide.md).
//
// Invariants:
// - Every text a statement carries goes through `sqlText`, the one literal
//   function: NUL characters and unpaired surrogates are removed (the core's
//   `stripUnsafe`) and every `'` is doubled, which is the dialect's only
//   escape (crates/database_sql/src/parse/lexer.rs: `'([^']|'')*'`).
// - Identifiers are only the names the schema resolved for pinned ids,
//   quoted with `"` doubled; a name holding NUL or an unpaired surrogate is
//   refused rather than changed. Nothing a document or a model writes
//   becomes an identifier: a column key is looked up among the table's own
//   keys only, so a key every object inherits (`constructor`, `__proto__`)
//   is an unknown column like any other.
// - A select or tag value is one of the spec's fixed labels (model.ts),
//   written as the label its pinned option carries now; any other value is
//   refused. A document id, row id or relation value must be a UUID; a date
//   must be a calendar date or an RFC 3339 instant; a number must be finite.
// - Every statement carries its database id, so unqualified table names
//   resolve in the Jobs database only.
// - A statement is under 256 KiB of UTF-8 (the server refuses one over
//   262,144 bytes); inserts and updates of many rows are split into batches
//   under that size and at most `MAX_BATCH_ROWS` rows. A single row that
//   cannot fit is refused.
// - An empty list is never written as `[]` (the dialect has no empty list):
//   an empty tag or relation cell is written NULL, which clears it.

import { isCalendarDate } from '../model';
import { stripUnsafe } from '../normalize';
import {
  checkId,
  queryRequest,
  type ResultSet,
  type SqlCell,
  type SqlOutcome,
} from './api';
import type { SupaMacClient } from './client';
import type {
  CellRead,
  ColumnKey,
  ColumnSpec,
  ColumnSpecOf,
  DateRangeValue,
  JobsSchema,
  ResolvedColumn,
  ResolvedTable,
  RowInput,
  TableKey,
} from './tables';

/** The server refuses a statement longer than this many bytes. */
export const MAX_STATEMENT_BYTES = 256 * 1024;
/** Most rows one INSERT or UPDATE names. */
export const MAX_BATCH_ROWS = 500;

export type SqlErrorKind =
  | 'bad_identifier'
  | 'bad_value'
  | 'unknown_option'
  | 'unknown_column'
  | 'empty'
  | 'too_large'
  | 'bad_cell';

export class SqlError extends Error {
  readonly kind: SqlErrorKind;
  constructor(kind: SqlErrorKind, message: string) {
    super(message);
    this.name = 'SqlError';
    this.kind = kind;
  }
}

export type SqlSchema = Pick<JobsSchema, 'databaseId' | 'tables'>;

export interface Statement {
  readonly sql: string;
  readonly databaseId: string;
  readonly kind: 'select' | 'insert' | 'update' | 'schema';
  /** The table it reads or writes, for row statements. */
  readonly tableId?: string | undefined;
  /** Rows an INSERT adds, or rows an UPDATE names by id. */
  readonly rows?: number | undefined;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function checkSize(sql: string): void {
  if (byteLength(sql) >= MAX_STATEMENT_BYTES) {
    throw new SqlError(
      'too_large',
      `a statement of ${byteLength(sql)} bytes is over the ${MAX_STATEMENT_BYTES}-byte limit`
    );
  }
}

// ---------------------------------------------------------------------------
// Literals and identifiers.

/** The one text literal: NUL and unpaired surrogates removed, quotes doubled. */
export function sqlText(value: string): string {
  return `'${stripUnsafe(value).replaceAll("'", "''")}'`;
}

/** A name quoted for SQL; refused when it holds what a literal would strip. */
export function quoteIdent(name: string): string {
  if (name === '' || stripUnsafe(name) !== name) {
    throw new SqlError(
      'bad_identifier',
      'a table or column name is empty or not well formed'
    );
  }
  return `"${name.replaceAll('"', '""')}"`;
}

export function sqlNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new SqlError('bad_value', 'a number must be finite');
  }
  return String(Object.is(value, -0) ? 0 : value);
}

const INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** A calendar date (`YYYY-MM-DD`) or an RFC 3339 instant, as the dialect reads dates. */
export function checkDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (!isCalendarDate(value))
      throw new SqlError('bad_value', `${value} is not a calendar date`);
    return value;
  }
  if (
    INSTANT_RE.test(value) &&
    isCalendarDate(value.slice(0, 10)) &&
    !Number.isNaN(Date.parse(value))
  ) {
    return value;
  }
  throw new SqlError(
    'bad_value',
    'a date must be YYYY-MM-DD or an RFC 3339 instant'
  );
}

function dateOrder(value: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? Date.parse(`${value}T00:00:00Z`)
    : Date.parse(value);
}

function checkRange(range: DateRangeValue): string {
  const start = checkDate(range.start);
  const end = checkDate(range.end);
  if (dateOrder(end) < dateOrder(start)) {
    throw new SqlError(
      'bad_value',
      'a date range must not end before it starts'
    );
  }
  return `${start}/${end}`;
}

function uuid(what: string, value: string): string {
  try {
    return checkId(what, value);
  } catch {
    throw new SqlError('bad_value', `${what} must be a UUID`);
  }
}

function optionLabel(column: ResolvedColumn, logical: string): string {
  const option = column.options.get(logical);
  if (option === undefined) {
    throw new SqlError(
      'unknown_option',
      `"${logical}" is not an option of the ${column.key} column`
    );
  }
  return option.label;
}

function list(items: readonly string[]): string {
  return items.length === 0 ? 'NULL' : `[${items.join(', ')}]`;
}

/** A value for a column, as its spec writes it. */
export function cellLiteral(column: ResolvedColumn, value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  const spec = column.spec;
  const fail = (what: string): never => {
    throw new SqlError('bad_value', `the ${column.key} column takes ${what}`);
  };
  switch (spec.kind) {
    case 'text':
      return typeof value === 'string' ? sqlText(value) : fail('text');
    case 'number':
      return typeof value === 'number' ? sqlNumber(value) : fail('a number');
    case 'date':
      return typeof value === 'string'
        ? sqlText(checkDate(value))
        : fail('a date');
    case 'date_range': {
      if (
        typeof value !== 'object' ||
        !('start' in value) ||
        !('end' in value)
      ) {
        return fail('a date range');
      }
      const range = value as { start: unknown; end: unknown };
      if (typeof range.start !== 'string' || typeof range.end !== 'string') {
        return fail('a date range');
      }
      return sqlText(checkRange({ start: range.start, end: range.end }));
    }
    case 'select':
      return typeof value === 'string'
        ? sqlText(optionLabel(column, value))
        : fail('an option');
    case 'tag': {
      if (!Array.isArray(value)) return fail('a list of options');
      const labels = [...new Set(value as unknown[])].map((v) =>
        typeof v === 'string'
          ? sqlText(optionLabel(column, v))
          : fail('a list of options')
      );
      return list(labels);
    }
    case 'document':
      return typeof value === 'string'
        ? sqlText(uuid(`the ${column.key} document id`, value))
        : fail('a document id');
    case 'relation': {
      if (!Array.isArray(value)) return fail('a list of row ids');
      const ids = [...new Set(value as unknown[])].map((v) =>
        typeof v === 'string'
          ? sqlText(uuid(`a ${column.key} row id`, v))
          : fail('a list of row ids')
      );
      return list(ids);
    }
  }
}

// ---------------------------------------------------------------------------
// Conditions.

export type Comparison = '=' | '!=' | '<' | '<=' | '>' | '>=';

export type Condition<T extends TableKey> =
  | {
      readonly op: Comparison;
      readonly column: ColumnKey<T>;
      readonly value: string | number;
    }
  | {
      readonly op: 'in' | 'not in';
      readonly column: ColumnKey<T>;
      readonly values: readonly (string | number)[];
    }
  | {
      readonly op: 'has' | 'not has';
      readonly column: ColumnKey<T>;
      readonly value: string;
    }
  | { readonly op: 'is null' | 'is not null'; readonly column: ColumnKey<T> }
  /** `LIKE '%text%'`, ignoring case; `%` and `_` in the text match any run and any one character. */
  | {
      readonly op: 'contains';
      readonly column: ColumnKey<T>;
      readonly text: string;
    }
  | { readonly op: 'row_id in'; readonly ids: readonly string[] }
  | { readonly op: 'and' | 'or'; readonly conditions: readonly Condition<T>[] };

/** A column of the table by its spec key; a key the table does not own (an inherited one) is unknown. */
function resolvedColumn<T extends TableKey>(
  table: ResolvedTable<T>,
  key: string
): ResolvedColumn {
  const columns = table.columns as Readonly<Record<string, ResolvedColumn>>;
  const column = Object.hasOwn(columns, key) ? columns[key] : undefined;
  if (column === undefined) {
    throw new SqlError(
      'unknown_column',
      `the ${table.key} table has no ${JSON.stringify(key)} column`
    );
  }
  return column;
}

/** One value a condition compares a column with. */
function conditionValue(
  column: ResolvedColumn,
  value: string | number
): string {
  const spec = column.spec;
  switch (spec.kind) {
    case 'number':
      if (typeof value !== 'number')
        throw new SqlError('bad_value', `${column.key} compares with a number`);
      return sqlNumber(value);
    case 'text':
      if (typeof value !== 'string')
        throw new SqlError('bad_value', `${column.key} compares with text`);
      return sqlText(value);
    case 'date':
    case 'date_range':
      if (typeof value !== 'string')
        throw new SqlError('bad_value', `${column.key} compares with a date`);
      return sqlText(checkDate(value));
    case 'select':
    case 'tag':
      if (typeof value !== 'string')
        throw new SqlError(
          'bad_value',
          `${column.key} compares with an option`
        );
      return sqlText(optionLabel(column, value));
    case 'document':
    case 'relation':
      if (typeof value !== 'string')
        throw new SqlError('bad_value', `${column.key} compares with an id`);
      return sqlText(uuid(`a ${column.key} id`, value));
  }
}

function renderCondition<T extends TableKey>(
  table: ResolvedTable<T>,
  condition: Condition<T>
): string {
  switch (condition.op) {
    case 'and':
    case 'or': {
      if (condition.conditions.length === 0) {
        throw new SqlError(
          'empty',
          `an ${condition.op.toUpperCase()} needs a condition`
        );
      }
      const parts = condition.conditions.map((c) => renderCondition(table, c));
      return parts.length === 1
        ? (parts[0] as string)
        : `(${parts.join(` ${condition.op.toUpperCase()} `)})`;
    }
    case 'row_id in': {
      if (condition.ids.length === 0)
        throw new SqlError('empty', 'row_id IN needs an id');
      return `row_id IN (${condition.ids.map((id) => sqlText(uuid('a row id', id))).join(', ')})`;
    }
    case 'is null':
    case 'is not null': {
      const column = resolvedColumn(table, condition.column);
      return `${column.sqlName} ${condition.op === 'is null' ? 'IS NULL' : 'IS NOT NULL'}`;
    }
    case 'in':
    case 'not in': {
      const column = resolvedColumn(table, condition.column);
      if (column.spec.kind === 'relation' || column.spec.kind === 'tag') {
        throw new SqlError(
          'bad_value',
          `${column.key} holds several values: test it with HAS`
        );
      }
      if (condition.values.length === 0)
        throw new SqlError('empty', 'IN needs a value');
      const values = condition.values.map((v) => conditionValue(column, v));
      return `${column.sqlName} ${condition.op === 'in' ? 'IN' : 'NOT IN'} (${values.join(', ')})`;
    }
    case 'has':
    case 'not has': {
      const column = resolvedColumn(table, condition.column);
      if (column.spec.kind !== 'relation' && column.spec.kind !== 'tag') {
        throw new SqlError(
          'bad_value',
          `${column.key} holds one value: compare it with =`
        );
      }
      return `${column.sqlName} ${condition.op === 'has' ? 'HAS' : 'NOT HAS'} ${conditionValue(column, condition.value)}`;
    }
    case 'contains': {
      const column = resolvedColumn(table, condition.column);
      if (column.spec.kind !== 'text') {
        throw new SqlError('bad_value', `${column.key} is not a text column`);
      }
      return `${column.sqlName} LIKE ${sqlText(`%${condition.text}%`)}`;
    }
    default: {
      const column = resolvedColumn(table, condition.column);
      if (column.spec.kind === 'relation' || column.spec.kind === 'tag') {
        throw new SqlError(
          'bad_value',
          `${column.key} holds several values: test it with HAS`
        );
      }
      return `${column.sqlName} ${condition.op} ${conditionValue(column, condition.value)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Writes.

function tableOf<T extends TableKey>(
  schema: SqlSchema,
  table: T
): ResolvedTable<T> {
  return schema.tables[table] as ResolvedTable<T>;
}

function orderedKeys<T extends TableKey>(
  table: ResolvedTable<T>,
  keys: Iterable<string>
): string[] {
  const wanted = new Set(keys);
  for (const key of wanted) resolvedColumn(table, key);
  return Object.keys(table.columns).filter((k) => wanted.has(k));
}

function definedKeys(row: object): string[] {
  return Object.entries(row)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
}

/**
 * INSERTs for rows of one table, in as few statements as fit; the rows keep
 * their order, so the statements' `insertedRowIds` together follow it.
 */
export function insertRows<T extends TableKey>(
  schema: SqlSchema,
  tableKey: T,
  rows: readonly RowInput<T>[]
): Statement[] {
  if (rows.length === 0) return [];
  const table = tableOf(schema, tableKey);
  const keys = orderedKeys(
    table,
    rows.flatMap((r) => definedKeys(r))
  );
  const columns = keys.map((k) => resolvedColumn(table, k));
  const head =
    keys.length === 0
      ? `INSERT INTO ${table.sqlName} DEFAULT VALUES`
      : `INSERT INTO ${table.sqlName} (${columns.map((c) => c.sqlName).join(', ')}) VALUES `;
  if (keys.length === 0) {
    return rows.map(() => ({
      sql: head,
      databaseId: schema.databaseId,
      kind: 'insert' as const,
      tableId: table.id,
      rows: 1,
    }));
  }
  const tuples = rows.map((row) => {
    const values = row as Readonly<Record<string, unknown>>;
    return `(${columns.map((c) => cellLiteral(c, values[c.key])).join(', ')})`;
  });
  return batch(head, tuples, ', ', '').map(({ sql, count }) => ({
    sql,
    databaseId: schema.databaseId,
    kind: 'insert' as const,
    tableId: table.id,
    rows: count,
  }));
}

export function insertRow<T extends TableKey>(
  schema: SqlSchema,
  tableKey: T,
  row: RowInput<T>
): Statement {
  const [statement, ...rest] = insertRows(schema, tableKey, [row]);
  if (statement === undefined || rest.length > 0) {
    throw new SqlError('too_large', 'the row does not fit one statement');
  }
  return statement;
}

function setClause<T extends TableKey>(
  table: ResolvedTable<T>,
  values: RowInput<T>
): string {
  const keys = orderedKeys(table, definedKeys(values));
  if (keys.length === 0)
    throw new SqlError('empty', 'an UPDATE needs a value to set');
  const record = values as Readonly<Record<string, unknown>>;
  return keys
    .map((k) => {
      const column = resolvedColumn(table, k);
      return `${column.sqlName} = ${cellLiteral(column, record[k])}`;
    })
    .join(', ');
}

/** UPDATEs setting the same values on rows named by id, batched by size. */
export function updateRows<T extends TableKey>(
  schema: SqlSchema,
  tableKey: T,
  rowIds: readonly string[],
  values: RowInput<T>
): Statement[] {
  if (rowIds.length === 0) return [];
  const table = tableOf(schema, tableKey);
  const head = `UPDATE ${table.sqlName} SET ${setClause(table, values)} WHERE row_id IN (`;
  const ids = [...new Set(rowIds)].map((id) => sqlText(uuid('a row id', id)));
  return batch(head, ids, ', ', ')').map(({ sql, count }) => ({
    sql,
    databaseId: schema.databaseId,
    kind: 'update' as const,
    tableId: table.id,
    rows: count,
  }));
}

export function updateRow<T extends TableKey>(
  schema: SqlSchema,
  tableKey: T,
  rowId: string,
  values: RowInput<T>
): Statement {
  const table = tableOf(schema, tableKey);
  const sql = `UPDATE ${table.sqlName} SET ${setClause(table, values)} WHERE row_id = ${sqlText(uuid('a row id', rowId))}`;
  checkSize(sql);
  return {
    sql,
    databaseId: schema.databaseId,
    kind: 'update',
    tableId: table.id,
    rows: 1,
  };
}

/** Joins items after a head into statements under the size and row limits. */
function batch(
  head: string,
  items: readonly string[],
  separator: string,
  tail: string
): { sql: string; count: number }[] {
  const fixed = byteLength(head) + byteLength(tail);
  const sepBytes = byteLength(separator);
  const out: { sql: string; count: number }[] = [];
  let current: string[] = [];
  let size = fixed;
  for (const item of items) {
    const bytes = byteLength(item);
    if (fixed + bytes >= MAX_STATEMENT_BYTES) {
      throw new SqlError(
        'too_large',
        `one row of ${bytes} bytes does not fit a statement`
      );
    }
    const added = (current.length === 0 ? 0 : sepBytes) + bytes;
    if (
      current.length > 0 &&
      (size + added >= MAX_STATEMENT_BYTES || current.length >= MAX_BATCH_ROWS)
    ) {
      out.push({
        sql: `${head}${current.join(separator)}${tail}`,
        count: current.length,
      });
      current = [];
      size = fixed;
    }
    size += (current.length === 0 ? 0 : sepBytes) + bytes;
    current.push(item);
  }
  if (current.length > 0)
    out.push({
      sql: `${head}${current.join(separator)}${tail}`,
      count: current.length,
    });
  return out;
}

// ---------------------------------------------------------------------------
// Reads.

export interface SelectStatement<T extends TableKey, C extends ColumnKey<T>>
  extends Statement {
  readonly kind: 'select';
  readonly table: T;
  readonly columns: readonly C[];
}

export interface SelectOptions<T extends TableKey> {
  readonly where?: Condition<T> | undefined;
  readonly orderBy?:
    | readonly {
        readonly column: ColumnKey<T>;
        readonly descending?: boolean;
      }[]
    | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

function whole(what: string, n: number): string {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new SqlError('bad_value', `${what} must be a whole number`);
  return String(n);
}

export function selectRows<T extends TableKey, C extends ColumnKey<T>>(
  schema: SqlSchema,
  tableKey: T,
  columns: readonly C[],
  options: SelectOptions<T> = {}
): SelectStatement<T, C> {
  if (columns.length === 0)
    throw new SqlError('empty', 'a SELECT names a column');
  const table = tableOf(schema, tableKey);
  const items = columns.map((k) => resolvedColumn(table, k).sqlName);
  let sql = `SELECT ${items.join(', ')} FROM ${table.sqlName}`;
  if (options.where !== undefined)
    sql += ` WHERE ${renderCondition(table, options.where)}`;
  if (options.orderBy !== undefined && options.orderBy.length > 0) {
    sql += ` ORDER BY ${options.orderBy
      .map(
        (o) =>
          `${resolvedColumn(table, o.column).sqlName} ${o.descending === true ? 'DESC' : 'ASC'}`
      )
      .join(', ')}`;
  }
  if (options.limit !== undefined)
    sql += ` LIMIT ${whole('LIMIT', options.limit)}`;
  if (options.offset !== undefined) {
    if (options.limit === undefined)
      throw new SqlError('bad_value', 'OFFSET needs a LIMIT');
    sql += ` OFFSET ${whole('OFFSET', options.offset)}`;
  }
  checkSize(sql);
  return {
    sql,
    databaseId: schema.databaseId,
    kind: 'select',
    tableId: table.id,
    table: tableKey,
    columns,
  };
}

export interface ReadRow<T extends TableKey, C extends ColumnKey<T>> {
  readonly rowId: string;
  readonly values: { readonly [K in C]: CellRead<ColumnSpecOf<T, K>> };
  /**
   * Options in the row that are none of the spec's (an option the owner
   * added): their cell reads as empty here, and the label is kept here.
   */
  readonly foreign: readonly { readonly column: C; readonly label: string }[];
}

export interface ReadResult<T extends TableKey, C extends ColumnKey<T>> {
  readonly rows: readonly ReadRow<T, C>[];
  /**
   * The server read only part of a table (its row cap): rows may be missing,
   * so an empty answer does not show that nothing matches.
   */
  readonly partial: boolean;
  readonly readVersions: Readonly<Record<string, number>>;
}

const MIDNIGHT_RE = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?(?:Z|\+00:00)$/;

/** A stored date as the service writes it: the day of a midnight UTC, else the instant. */
export function readDate(value: string): string {
  const m = MIDNIGHT_RE.exec(value);
  return m === null ? value : (m[1] as string);
}

function badCell(column: ResolvedColumn, cell: SqlCell): never {
  throw new SqlError(
    'bad_cell',
    `the ${column.key} column returned a ${cell.type} cell`
  );
}

function decodeCell(
  column: ResolvedColumn,
  cell: SqlCell | null,
  labels: ReadonlyMap<string, string>,
  foreign: string[]
): unknown {
  const spec = column.spec;
  const multi = spec.kind === 'tag' || spec.kind === 'relation';
  if (cell === null) return multi ? [] : null;
  switch (spec.kind) {
    case 'text':
      return cell.type === 'text' ? cell.value : badCell(column, cell);
    case 'number':
      return cell.type === 'number' ? cell.value : badCell(column, cell);
    case 'date':
      return cell.type === 'date'
        ? readDate(cell.value)
        : badCell(column, cell);
    case 'date_range':
      return cell.type === 'dateRange'
        ? { start: readDate(cell.value.start), end: readDate(cell.value.end) }
        : badCell(column, cell);
    case 'select':
    case 'tag': {
      if (cell.type !== 'options') return badCell(column, cell);
      const byId = new Map(
        [...column.options].map(([logical, o]) => [o.id, logical])
      );
      const known: string[] = [];
      for (const id of cell.value) {
        const logical = byId.get(id);
        if (logical === undefined) foreign.push(labels.get(id) ?? id);
        else known.push(logical);
      }
      return spec.kind === 'tag' ? known : (known[0] ?? null);
    }
    case 'document':
      return cell.type === 'entities'
        ? (cell.value[0] ?? null)
        : badCell(column, cell);
    case 'relation':
      return cell.type === 'entities' ? [...cell.value] : badCell(column, cell);
  }
}

/** The rows a SELECT returned, decoded by the columns it named. */
export function decodeRows<T extends TableKey, C extends ColumnKey<T>>(
  schema: SqlSchema,
  statement: SelectStatement<T, C>,
  outcome: SqlOutcome
): ReadResult<T, C> {
  const result: ResultSet | null | undefined = outcome.result;
  if (result === null || result === undefined) {
    throw new SqlError('bad_cell', 'a SELECT returned no result set');
  }
  if (result.columns.length !== statement.columns.length) {
    throw new SqlError(
      'bad_cell',
      'a SELECT returned another number of columns than it named'
    );
  }
  if (result.rowIds.length !== result.rows.length) {
    throw new SqlError('bad_cell', 'a SELECT returned rows without their ids');
  }
  const table = tableOf(schema, statement.table);
  const columns = statement.columns.map((k) => resolvedColumn(table, k));
  const labels = result.columns.map(
    (c) => new Map((c.options ?? []).map((o) => [o.id, o.label] as const))
  );
  const rows = result.rows.map((cells, i) => {
    const values: Record<string, unknown> = {};
    const foreign: { column: C; label: string }[] = [];
    columns.forEach((column, j) => {
      const found: string[] = [];
      values[column.key] = decodeCell(
        column,
        cells[j] ?? null,
        labels[j] ?? new Map(),
        found
      );
      for (const label of found)
        foreign.push({ column: statement.columns[j] as C, label });
    });
    return {
      rowId: result.rowIds[i] as string,
      values: values as ReadRow<T, C>['values'],
      foreign,
    };
  });
  return {
    rows,
    partial: outcome.truncatedTables.length > 0,
    readVersions: outcome.readVersions,
  };
}

// ---------------------------------------------------------------------------
// Running statements.

export interface Executed {
  readonly outcome: SqlOutcome;
  /** The table versions this write produced; the change reader skips them. */
  readonly written: readonly {
    readonly tableId: string;
    readonly version: number;
  }[];
}

/** Runs one statement; a write is sent once and never retried here. */
export async function execute(
  client: SupaMacClient,
  statement: Statement,
  options: {
    readonly baseVersions?: Readonly<Record<string, number>> | undefined;
  } = {}
): Promise<Executed> {
  checkSize(statement.sql);
  const outcome = await client.send(
    queryRequest({
      sql: statement.sql,
      databaseId: statement.databaseId,
      baseVersions: options.baseVersions,
    })
  );
  const written = Object.entries(outcome.newVersions).map(
    ([tableId, version]) => ({ tableId, version })
  );
  return { outcome, written };
}

/** Runs a SELECT and decodes its rows. */
export async function read<T extends TableKey, C extends ColumnKey<T>>(
  client: SupaMacClient,
  schema: SqlSchema,
  statement: SelectStatement<T, C>
): Promise<ReadResult<T, C>> {
  const { outcome } = await execute(client, statement);
  return decodeRows(schema, statement, outcome);
}

// ---------------------------------------------------------------------------
// Schema statements (schema.ts runs them while making the database).

export interface ColumnDefinition {
  readonly name: string;
  readonly spec: ColumnSpec;
}

/** One column as CREATE TABLE and ADD COLUMN write it. */
export function columnDefinitionSql(
  definition: ColumnDefinition,
  tableName: (key: TableKey) => string
): string {
  const name = quoteIdent(definition.name);
  const spec = definition.spec;
  switch (spec.kind) {
    case 'text':
    case 'number':
    case 'date':
    case 'date_range':
      return `${name} ${spec.kind}`;
    case 'document':
      return `${name} entity(DOCUMENT)`;
    case 'relation':
      return `${name} relation(${quoteIdent(tableName(spec.target))})`;
    case 'select':
    case 'tag':
      return spec.options.length === 0
        ? `${name} ${spec.kind}`
        : `${name} ${spec.kind} OPTIONS (${spec.options.map((o) => sqlText(o)).join(', ')})`;
  }
}

function schemaStatement(databaseId: string, sql: string): Statement {
  checkSize(sql);
  return { sql, databaseId, kind: 'schema' };
}

export function createTableSql(
  databaseId: string,
  table: string,
  columns: readonly ColumnDefinition[],
  tableName: (key: TableKey) => string
): Statement {
  if (columns.length === 0)
    throw new SqlError('empty', 'a table needs a column');
  return schemaStatement(
    databaseId,
    `CREATE TABLE ${quoteIdent(table)} (${columns.map((c) => columnDefinitionSql(c, tableName)).join(', ')})`
  );
}

export function addColumnSql(
  databaseId: string,
  table: string,
  column: ColumnDefinition,
  tableName: (key: TableKey) => string
): Statement {
  return schemaStatement(
    databaseId,
    `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${columnDefinitionSql(column, tableName)}`
  );
}

export function addOptionsSql(
  databaseId: string,
  table: string,
  column: string,
  labels: readonly string[]
): Statement {
  if (labels.length === 0)
    throw new SqlError('empty', 'ADD OPTIONS needs a label');
  return schemaStatement(
    databaseId,
    `ALTER TABLE ${quoteIdent(table)} ALTER COLUMN ${quoteIdent(column)} ADD OPTIONS (${labels
      .map((l) => sqlText(l))
      .join(', ')})`
  );
}
