// The Jobs database: made once, pinned by id, verified on every start
// (docs/supamac/jobs.md, "The Jobs database").
//
// Invariants:
// - There is never a second Jobs database or folder. The account is the
//   service's own, so with nothing pinned, any untrashed database it owns
//   (but the example the web app makes on its first sign-in, untouched), or
//   a folder by one of the service's names it owns, is an earlier setup
//   whose pins were lost: the service stops (`unpinned_existing`) before it
//   makes anything. A trashed database is not listed and cannot be seen;
//   its folders still stop the start while they remain. During setup, a
//   folder by the service's name that cannot be shown to be from this setup
//   stops it too. The database id is pinned (saved) right after it is made,
//   and every other id right after it is found, so a restart resumes where
//   setup stopped.
// - While setup is unfinished nobody else can open the database (it is
//   shared last), so a table, column, option or view found there by its name
//   is the service's own and is adopted. Once setup is finished, names are
//   never used to find anything: only pinned ids, and every rename is
//   followed.
// - On every start the pinned database, tables and folders must exist, be
//   owned by this account and not be trashed, or the service stops with a
//   `SchemaError` saying which. A pinned column whose type changed, or that
//   SQL can no longer write as the spec means (not writable, a formula, a
//   percentage), stops it too, since its values could no longer be written
//   as they mean.
// - A column or option of the spec that is missing (never made, or deleted
//   by the owner) is added; a column under a name the table already uses
//   gets a free name. The name a column is added under is saved before the
//   ADD COLUMN is sent, so a column whose answer was lost is adopted by that
//   name on the next start, during setup or after it, never added twice.
//   Columns, options and views the owner added are never changed or
//   removed, and only one case is used: an option carrying a
//   spec label the service's own option lost, which is adopted because a
//   column holds each label once (ignoring case) and SQL writes by label.
//   A saved view the owner deleted after setup stays deleted, and the
//   result says so.
// - The database and both folders are shared with the owner, with edit
//   access, and the grant is checked on every start. The service grants
//   nothing to anyone else and never widens, copies or removes a grant
//   someone else holds: each start names every such grant in its notes (a
//   former owner's included), for the owner to remove in SupaMac.
// - The schema a start returns is resolved from what the server lists after
//   the start's last change, so it names every view the start made.

import { randomUUIDv7 } from 'bun';
import { z } from 'zod';
import type { Logger } from '../log';
import {
  type ColumnDetail,
  createDatabaseRequest,
  createProjectRequest,
  type CreateViewOp,
  type DatabaseDetail,
  directAccessRequest,
  getDatabaseRequest,
  getProjectRequest,
  listDatabasesRequest,
  type ListedDatabaseSchema,
  listProjectsRequest,
  type NewView,
  type PropertyOption,
  type ShareEntityType,
  setDirectAccessRequest,
  type TableDetail,
  UUID_RE,
  userIdForEmail,
  applyOpsRequest,
} from './api';
import { type ApiRequest, type SupaMacClient, SupaMacError } from './client';
import {
  addColumnSql,
  addOptionsSql,
  createTableSql,
  execute,
  quoteIdent,
  type Statement,
} from './sql';
import {
  type ColumnSpec,
  columnsOf,
  DATABASE_NAME,
  FOLDER_ORDER,
  FOLDERS,
  type FolderKey,
  type JobsSchema,
  optionsOf,
  type ResolvedColumn,
  type ResolvedOption,
  type ResolvedTable,
  TABLE_ORDER,
  TABLES,
  type TableKey,
  VIEW_ORDER,
  VIEWS,
  type ViewKey,
  type ViewSpec,
} from './tables';

const Uuid = z.string().regex(UUID_RE);

const PinnedColumnSchema = z.object({
  id: Uuid,
  /** Spec label → option id, for select and tag columns. */
  options: z.record(z.string(), Uuid).optional(),
});

const PinnedTableSchema = z.object({
  id: Uuid,
  /** Column key → its pin. */
  columns: z.record(z.string(), PinnedColumnSchema),
});

const TableKeySchema = z.enum(['jobs', 'sources', 'details', 'status']);

/** An ADD COLUMN sent and not yet pinned: the name it was sent with. */
const AddingColumnSchema = z.object({
  table: TableKeySchema,
  column: z.string().min(1),
  name: z.string().min(1),
});

/** What the state volume keeps about the Jobs database. */
export const JobsPinsSchema = z.object({
  version: z.literal(1),
  serviceUserId: z.string().min(1),
  ownerUserId: z.string().min(1),
  databaseId: Uuid,
  databaseCreatedAt: z.string(),
  /** Set once every table, column, option, view, folder and share is made. */
  complete: z.boolean(),
  tables: z.object({
    jobs: PinnedTableSchema.optional(),
    sources: PinnedTableSchema.optional(),
    details: PinnedTableSchema.optional(),
    status: PinnedTableSchema.optional(),
  }),
  views: z.object({
    jobsTimeline: Uuid.optional(),
    jobsBoard: Uuid.optional(),
    detailsNeedsReview: Uuid.optional(),
    sourcesProblems: Uuid.optional(),
  }),
  folders: z.object({ intake: Uuid.optional(), sources: Uuid.optional() }),
  /** Columns being added: absent when none is. */
  adding: z.array(AddingColumnSchema).optional(),
});
export type JobsPins = z.infer<typeof JobsPinsSchema>;
type AddingColumn = z.infer<typeof AddingColumnSchema>;
type PinnedTable = z.infer<typeof PinnedTableSchema>;
type PinnedColumn = z.infer<typeof PinnedColumnSchema>;

export type SchemaErrorKind =
  /** Something by the service's name exists unpinned; it is not made twice. */
  | 'unpinned_existing'
  | 'database_missing'
  | 'database_trashed'
  /** A pinned database or folder is not this account's own. */
  | 'not_owned'
  | 'table_missing'
  /** A pinned column now has another type. */
  | 'column_changed'
  /** Two pinned columns or options now go by the same name. */
  | 'ambiguous_name'
  | 'folder_missing'
  | 'folder_trashed'
  /** The owner's address is not one the service can share with. */
  | 'owner_invalid'
  /** The server did not show what it had just made. */
  | 'unexpected';

export class SchemaError extends Error {
  readonly kind: SchemaErrorKind;
  constructor(
    kind: SchemaErrorKind,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'SchemaError';
    this.kind = kind;
  }
}

export interface EnsureSchemaInput {
  readonly client: SupaMacClient;
  /** What the state volume holds, or undefined on the first start. */
  readonly pins: JobsPins | undefined;
  /** `JOBS_OWNER_EMAIL`: the owner's SupaMac account. */
  readonly ownerEmail: string;
  /** Writes the pins to the state volume; called after every new pin. */
  readonly save: (pins: JobsPins) => Promise<void>;
  /** Mints view ids (UUIDv7). */
  readonly newId?: (() => string) | undefined;
  readonly logger?: Logger | undefined;
}

export interface EnsureSchemaResult {
  readonly pins: JobsPins;
  readonly schema: JobsSchema;
  /** What this start made or added, one line each. */
  readonly changes: readonly string[];
  /** What it found and left alone, one line each. */
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// Reading what the server holds.

export function columnName(column: ColumnDetail): string {
  return (
    column.column.display_name ?? column.definition.definition.display_name
  );
}

export function optionText(option: PropertyOption): string {
  return option.value.type === 'string'
    ? option.value.value
    : String(option.value.value);
}

/** Names match as the server matches them: ignoring case. */
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function freeName(base: string, taken: readonly string[]): string {
  if (!taken.some((t) => sameName(t, base))) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.some((t) => sameName(t, candidate))) return candidate;
  }
}

/**
 * Whether a column as stored holds what the spec says it does, as SQL
 * writes it: writable, of the spec's type, and with no placement config but
 * a relation's link (a formula computes its cells; a percentage shows a
 * number a hundred times over).
 */
export function columnFits(
  spec: ColumnSpec,
  column: ColumnDetail,
  tableIds: Readonly<Partial<Record<TableKey, string>>>
): boolean {
  if (!column.writable) return false;
  const d = column.definition.definition;
  const config = column.column.config;
  if (spec.kind === 'relation') {
    const target = tableIds[spec.target];
    return (
      config?.kind === 'link' &&
      target !== undefined &&
      config.table_id === target
    );
  }
  if (config !== null) return false;
  switch (spec.kind) {
    case 'text':
      return d.data_type === 'STRING' && !d.is_multi_select;
    case 'number':
      return d.data_type === 'NUMBER';
    case 'date':
      return d.data_type === 'DATE';
    case 'date_range':
      return d.data_type === 'DATE_RANGE';
    case 'select':
      return d.data_type === 'SELECT_STRING' && !d.is_multi_select;
    case 'tag':
      return d.data_type === 'TAG';
    case 'document':
      return (
        d.data_type === 'ENTITY' &&
        d.specific_entity_type === 'DOCUMENT' &&
        !d.is_multi_select
      );
  }
}

function tableById(
  detail: DatabaseDetail,
  id: string
): TableDetail | undefined {
  return detail.tables.find((t) => t.table.id === id);
}

/** The pins with these columns being added; without the field when none is. */
function withAdding(pins: JobsPins, adding: readonly AddingColumn[]): JobsPins {
  const next: JobsPins = { ...pins };
  if (adding.length === 0) delete next.adding;
  else next.adding = [...adding];
  return next;
}

function pinnedTableIds(pins: JobsPins): Partial<Record<TableKey, string>> {
  const out: Partial<Record<TableKey, string>> = {};
  for (const key of TABLE_ORDER) {
    const id = pins.tables[key]?.id;
    if (id !== undefined) out[key] = id;
  }
  return out;
}

/**
 * The tables as the statements need them: every pinned id with the name it
 * goes by now. Refuses pins that do not all resolve, a column whose type
 * changed, or two columns or options of one table that now share a name.
 */
export function resolveTables(
  pins: JobsPins,
  detail: DatabaseDetail
): JobsSchema['tables'] {
  const tableIds = pinnedTableIds(pins);
  const resolveTable = <T extends TableKey>(key: T): ResolvedTable<T> => {
    const pinned = pins.tables[key];
    const table =
      pinned === undefined ? undefined : tableById(detail, pinned.id);
    if (pinned === undefined || table === undefined) {
      throw new SchemaError(
        'table_missing',
        `the ${TABLES[key].name} table is missing`
      );
    }
    const columns: Record<string, ResolvedColumn> = {};
    const names: string[] = [];
    for (const [columnKey, spec] of columnsOf(key)) {
      const pin = pinned.columns[columnKey];
      const column =
        pin === undefined
          ? undefined
          : table.columns.find((c) => c.column.id === pin.id);
      if (pin === undefined || column === undefined) {
        throw new SchemaError(
          'table_missing',
          `the ${columnKey} column of ${table.table.name} is missing`
        );
      }
      if (!columnFits(spec, column, tableIds)) {
        throw new SchemaError(
          'column_changed',
          `the ${columnName(column)} column of ${table.table.name} no longer holds ${spec.kind} values the service can write`
        );
      }
      const name = columnName(column);
      if (names.some((n) => sameName(n, name))) {
        throw new SchemaError(
          'ambiguous_name',
          `two columns of ${table.table.name} are called ${name}; rename one`
        );
      }
      names.push(name);
      const options = new Map<string, ResolvedOption>();
      for (const label of optionsOf(spec)) {
        const id = pin.options?.[label];
        const option =
          id === undefined
            ? undefined
            : column.definition.property_options.find((o) => o.id === id);
        if (id === undefined || option === undefined) {
          throw new SchemaError(
            'table_missing',
            `the ${label} option of ${table.table.name}.${name} is missing`
          );
        }
        const text = optionText(option);
        if ([...options.values()].some((o) => sameName(o.label, text))) {
          throw new SchemaError(
            'ambiguous_name',
            `two options of ${table.table.name}.${name} are called ${text}; rename one`
          );
        }
        options.set(label, { id: option.id, label: text });
      }
      columns[columnKey] = {
        key: columnKey,
        id: column.column.id,
        name,
        sqlName: quoteIdent(name),
        spec,
        options,
      };
    }
    return {
      key,
      id: table.table.id,
      name: table.table.name,
      sqlName: quoteIdent(table.table.name),
      columns: columns as ResolvedTable<T>['columns'],
    };
  };
  return {
    jobs: resolveTable('jobs'),
    sources: resolveTable('sources'),
    details: resolveTable('details'),
    status: resolveTable('status'),
  };
}

/** The whole schema: tables, the views still there, and the folders. */
export function resolveSchema(
  pins: JobsPins,
  detail: DatabaseDetail
): JobsSchema {
  const tables = resolveTables(pins, detail);
  const intake = pins.folders.intake;
  const sources = pins.folders.sources;
  if (intake === undefined || sources === undefined) {
    throw new SchemaError('folder_missing', 'a Jobs folder is not pinned yet');
  }
  const views: Partial<Record<ViewKey, string>> = {};
  for (const key of VIEW_ORDER) {
    const id = pins.views[key];
    if (id === undefined) continue;
    const table = tableById(detail, tables[VIEWS[key].table].id);
    if (table?.views.some((v) => v.id === id) === true) views[key] = id;
  }
  return {
    databaseId: pins.databaseId,
    serviceUserId: pins.serviceUserId,
    ownerUserId: pins.ownerUserId,
    tables,
    views,
    folders: { intake, sources },
  };
}

/** Sends a request, turning a not-found answer into the given schema error. */
async function sendOrMissing<T>(
  client: SupaMacClient,
  request: ApiRequest<T>,
  missing: () => SchemaError
): Promise<T> {
  try {
    return await client.send(request);
  } catch (error) {
    if (error instanceof SupaMacError && error.kind === 'not_found') {
      const mapped = missing();
      throw new SchemaError(mapped.kind, mapped.message, { cause: error });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Making and verifying.

class Setup {
  private pins: JobsPins;
  private detail: DatabaseDetail | undefined;
  readonly changes: string[] = [];
  readonly notes: string[] = [];

  constructor(
    private readonly input: EnsureSchemaInput,
    pins: JobsPins
  ) {
    this.pins = pins;
  }

  private get client(): SupaMacClient {
    return this.input.client;
  }

  private get setupDone(): boolean {
    return this.pins.complete;
  }

  private async pin(next: JobsPins): Promise<void> {
    this.pins = next;
    await this.input.save(next);
  }

  private changed(line: string): void {
    this.changes.push(line);
    this.input.logger?.info('jobs database changed', { change: line });
  }

  private noted(line: string): void {
    this.notes.push(line);
    this.input.logger?.warn('jobs database note', { note: line });
  }

  private current(): DatabaseDetail {
    if (this.detail === undefined)
      throw new SchemaError('unexpected', 'the database was not read');
    return this.detail;
  }

  /** Reads the pinned database and checks it is this account's, untrashed. */
  async refresh(): Promise<DatabaseDetail> {
    let detail: DatabaseDetail;
    try {
      detail = await sendOrMissing(
        this.client,
        getDatabaseRequest(this.pins.databaseId),
        () =>
          new SchemaError(
            'database_missing',
            'the pinned Jobs database no longer exists; the service will not make a second one'
          )
      );
    } catch (error) {
      if (error instanceof SupaMacError && error.kind === 'forbidden') {
        throw new SchemaError(
          'not_owned',
          'this account can no longer open the pinned Jobs database',
          {
            cause: error,
          }
        );
      }
      throw error;
    }
    if (detail.database.trashed_at !== null) {
      throw new SchemaError(
        'database_trashed',
        `the Jobs database is in the trash (since ${detail.database.trashed_at}); restore it, the service will not make a second one`
      );
    }
    if (
      detail.grant !== 'owner' ||
      !sameName(detail.database.owner_id, this.pins.serviceUserId)
    ) {
      throw new SchemaError(
        'not_owned',
        'the pinned Jobs database is not owned by this account'
      );
    }
    this.detail = detail;
    return detail;
  }

  private async run(statement: Statement): Promise<void> {
    await execute(this.client, statement);
  }

  private tableDetail(key: TableKey): TableDetail | undefined {
    const pinned = this.pins.tables[key];
    return pinned === undefined
      ? undefined
      : tableById(this.current(), pinned.id);
  }

  private tableName(key: TableKey): string {
    const table = this.tableDetail(key);
    if (table === undefined)
      throw new SchemaError(
        'table_missing',
        `the ${TABLES[key].name} table is missing`
      );
    return table.table.name;
  }

  private async pinTable(key: TableKey, id: string): Promise<void> {
    await this.pin({
      ...this.pins,
      tables: { ...this.pins.tables, [key]: { id, columns: {} } },
    });
  }

  /** Pins a column, and forgets the name it was being added under. */
  private async pinColumn(
    key: TableKey,
    columnKey: string,
    column: PinnedColumn
  ): Promise<void> {
    const table = this.pins.tables[key] as PinnedTable;
    const next: JobsPins = {
      ...this.pins,
      tables: {
        ...this.pins.tables,
        [key]: { ...table, columns: { ...table.columns, [columnKey]: column } },
      },
    };
    const adding = (this.pins.adding ?? []).filter(
      (a) => !(a.table === key && a.column === columnKey)
    );
    await this.pin(withAdding(next, adding));
  }

  async ensureTables(): Promise<void> {
    for (const key of TABLE_ORDER) {
      const pinned = this.pins.tables[key];
      if (pinned !== undefined) {
        if (this.tableDetail(key) === undefined) {
          throw new SchemaError(
            'table_missing',
            `the ${TABLES[key].name} table of the Jobs database was deleted; the service stops rather than make it again`
          );
        }
        continue;
      }
      const claimed = new Set(
        Object.values(this.pins.tables).map((t) => t?.id)
      );
      const byName = this.current().tables.filter(
        (t) =>
          !claimed.has(t.table.id) && sameName(t.table.name, TABLES[key].name)
      );
      if (!this.setupDone && byName[0] !== undefined) {
        await this.pinTable(key, byName[0].table.id);
        continue;
      }
      if (key === 'jobs') {
        throw new SchemaError(
          'unexpected',
          'the Jobs database has no Jobs table'
        );
      }
      const name = freeName(
        TABLES[key].name,
        this.current().tables.map((t) => t.table.name)
      );
      const columns = columnsOf(key).map(([columnKey, spec]) => ({
        name: columnKey,
        spec,
      }));
      await this.run(
        createTableSql(this.pins.databaseId, name, columns, (target) =>
          this.tableName(target)
        )
      );
      await this.refresh();
      const made = this.current().tables.find(
        (t) => !claimed.has(t.table.id) && t.table.name === name
      );
      if (made === undefined)
        throw new SchemaError(
          'unexpected',
          `the new ${name} table is not listed`
        );
      await this.pinTable(key, made.table.id);
      this.changed(`made the ${name} table`);
    }
  }

  async ensureColumns(key: TableKey): Promise<void> {
    const tableIds = pinnedTableIds(this.pins);
    const additions: { columnKey: string; name: string; spec: ColumnSpec }[] =
      [];
    let table = this.tableDetail(key) as TableDetail;
    for (const [columnKey, spec] of columnsOf(key)) {
      const pinned = this.pins.tables[key]?.columns[columnKey];
      const found =
        pinned === undefined
          ? undefined
          : table.columns.find((c) => c.column.id === pinned.id);
      if (found !== undefined) {
        if (!columnFits(spec, found, tableIds)) {
          throw new SchemaError(
            'column_changed',
            `the ${columnName(found)} column of ${table.table.name} no longer holds ${spec.kind} values the service can write; change it back`
          );
        }
        continue;
      }
      const claimed = new Set(
        Object.values(this.pins.tables[key]?.columns ?? {}).map((c) => c.id)
      );
      const unclaimed = (name: string): ColumnDetail | undefined =>
        table.columns.find(
          (c) => !claimed.has(c.column.id) && sameName(columnName(c), name)
        );
      // A column this service added whose answer was lost goes by the name it
      // was sent with; one of another type by that name is not it.
      const sent = this.pins.adding?.find(
        (a) => a.table === key && a.column === columnKey
      );
      const added = sent === undefined ? undefined : unclaimed(sent.name);
      if (added !== undefined && columnFits(spec, added, tableIds)) {
        await this.pinColumn(key, columnKey, { id: added.column.id });
        this.changed(
          `added the ${columnName(added)} column to ${table.table.name}`
        );
        continue;
      }
      if (!this.setupDone) {
        const byName = unclaimed(columnKey);
        if (byName !== undefined) {
          if (!columnFits(spec, byName, tableIds)) {
            throw new SchemaError(
              'column_changed',
              `the ${columnName(byName)} column of ${table.table.name} does not hold ${spec.kind} values the service can write`
            );
          }
          await this.pinColumn(key, columnKey, { id: byName.column.id });
          continue;
        }
      }
      if (pinned !== undefined) {
        this.noted(
          `the ${columnKey} column of ${table.table.name} was deleted; it is added again`
        );
      }
      const taken = [
        ...table.columns.map(columnName),
        ...additions.map((a) => a.name),
      ];
      additions.push({ columnKey, name: freeName(columnKey, taken), spec });
    }
    if (additions.length > 0) {
      // Saved before any is sent, so a column whose answer is lost, or that
      // was made before a later one failed, is adopted on the next start.
      const sending: AddingColumn[] = additions.map((a) => ({
        table: key,
        column: a.columnKey,
        name: a.name,
      }));
      const kept = (this.pins.adding ?? []).filter(
        (a) =>
          !(a.table === key && additions.some((x) => x.columnKey === a.column))
      );
      await this.pin(withAdding(this.pins, [...kept, ...sending]));
      for (const addition of additions) {
        await this.run(
          addColumnSql(
            this.pins.databaseId,
            this.tableName(key),
            { name: addition.name, spec: addition.spec },
            (target) => this.tableName(target)
          )
        );
      }
      await this.refresh();
      table = this.tableDetail(key) as TableDetail;
      for (const addition of additions) {
        const claimed = new Set(
          Object.values(this.pins.tables[key]?.columns ?? {}).map((c) => c.id)
        );
        const made = table.columns.find(
          (c) =>
            !claimed.has(c.column.id) && sameName(columnName(c), addition.name)
        );
        if (made === undefined) {
          throw new SchemaError(
            'unexpected',
            `the new ${addition.name} column is not listed`
          );
        }
        await this.pinColumn(key, addition.columnKey, { id: made.column.id });
        this.changed(
          `added the ${addition.name} column to ${table.table.name}`
        );
      }
    }
    await this.ensureOptions(key);
  }

  private async ensureOptions(key: TableKey): Promise<void> {
    for (const [columnKey, spec] of columnsOf(key)) {
      const labels = optionsOf(spec);
      if (labels.length === 0) continue;
      const pinOptions = async (): Promise<string[]> => {
        const pinned = this.pins.tables[key]?.columns[
          columnKey
        ] as PinnedColumn;
        const table = this.tableDetail(key) as TableDetail;
        const column = table.columns.find(
          (c) => c.column.id === pinned.id
        ) as ColumnDetail;
        const current = column.definition.property_options;
        const next: Record<string, string> = {};
        const missing: string[] = [];
        for (const label of labels) {
          const id = pinned.options?.[label];
          if (id !== undefined && current.some((o) => o.id === id)) {
            next[label] = id;
            continue;
          }
          const taken = new Set(Object.values(next));
          const byLabel = current.find(
            (o) => !taken.has(o.id) && sameName(optionText(o), label)
          );
          if (byLabel !== undefined) next[label] = byLabel.id;
          else missing.push(label);
          if (id !== undefined && byLabel === undefined) {
            this.noted(
              `the ${label} option of ${table.table.name}.${columnName(column)} was deleted; it is added again`
            );
          }
        }
        const before = JSON.stringify(pinned.options ?? {});
        if (JSON.stringify(next) !== before) {
          await this.pinColumn(key, columnKey, {
            id: pinned.id,
            options: next,
          });
        }
        return missing;
      };
      const missing = await pinOptions();
      if (missing.length === 0) continue;
      const table = this.tableDetail(key) as TableDetail;
      const pinned = this.pins.tables[key]?.columns[columnKey] as PinnedColumn;
      const column = table.columns.find(
        (c) => c.column.id === pinned.id
      ) as ColumnDetail;
      for (const label of missing) {
        if (
          column.definition.property_options.some((o) =>
            sameName(optionText(o), label)
          )
        ) {
          throw new SchemaError(
            'ambiguous_name',
            `another option of ${table.table.name}.${columnName(column)} was renamed to ${label}; rename it back`
          );
        }
      }
      await this.run(
        addOptionsSql(
          this.pins.databaseId,
          table.table.name,
          columnName(column),
          missing
        )
      );
      await this.refresh();
      const still = await pinOptions();
      if (still.length > 0) {
        throw new SchemaError(
          'unexpected',
          `the new options ${still.join(', ')} are not listed`
        );
      }
      this.changed(
        `added the options ${missing.join(', ')} to ${table.table.name}.${columnName(column)}`
      );
    }
  }

  private viewBody(
    key: ViewKey,
    name: string,
    schema: Pick<JobsSchema, 'tables'>
  ): NewView {
    const spec: ViewSpec = VIEWS[key];
    if (spec.layout === 'timeline') {
      const t = schema.tables.jobs;
      return {
        name,
        query: { filter: null, sort: [] },
        layout: {
          kind: 'timeline',
          range: t.columns[spec.range].id,
          title: t.columns.Name.id,
          groupBy: null,
          colorBy: t.columns[spec.colorBy].id,
          barFields: spec.barFields.map((c) => t.columns[c].id),
        },
      };
    }
    if (spec.layout === 'board') {
      const t = schema.tables.jobs;
      const group = t.columns[spec.groupBy];
      return {
        name,
        query: { filter: null, sort: [] },
        layout: {
          kind: 'board',
          groupBy: group.id,
          title: t.columns.Name.id,
          lanes: [
            { key: { kind: 'none' } },
            ...[...group.options.values()].map((o) => ({
              key: { kind: 'option' as const, id: o.id },
            })),
          ],
          cardFields: spec.cardFields.map((c) => t.columns[c].id),
          hideEmptyLanes: false,
        },
      };
    }
    const t =
      spec.table === 'details' ? schema.tables.details : schema.tables.sources;
    const status = t.columns.Status;
    return {
      name,
      query: {
        filter: {
          conjunction: 'and',
          conditions: [
            {
              kind: 'condition',
              column: status.id,
              test: {
                kind: 'options',
                operator: 'isAnyOf',
                options: spec.statusIn.map((label) => {
                  const option = status.options.get(label);
                  if (option === undefined)
                    throw new SchemaError('unexpected', `no ${label} option`);
                  return option.id;
                }),
              },
            },
          ],
        },
        sort: [
          {
            column: t.columns[spec.sortDescending].id,
            direction: 'descending',
          },
        ],
      },
      layout: { kind: 'table', columns: [] },
    };
  }

  async ensureViews(): Promise<void> {
    const partial = { tables: resolveTables(this.pins, this.current()) };
    const newId = this.input.newId ?? randomUUIDv7;
    let saved = false;
    for (const key of VIEW_ORDER) {
      const spec = VIEWS[key];
      const table = this.tableDetail(spec.table) as TableDetail;
      const pinned = this.pins.views[key];
      if (pinned !== undefined) {
        if (!table.views.some((v) => v.id === pinned)) {
          this.noted(
            `the ${table.table.name} view "${spec.name}" was deleted; it is left deleted`
          );
        }
        continue;
      }
      const claimed = new Set(Object.values(this.pins.views));
      if (!this.setupDone) {
        const byName = table.views.find(
          (v) => !claimed.has(v.id) && sameName(v.name, spec.name)
        );
        if (byName !== undefined) {
          await this.pin({
            ...this.pins,
            views: { ...this.pins.views, [key]: byName.id },
          });
          continue;
        }
      }
      const name = freeName(
        spec.name,
        table.views.map((v) => v.name)
      );
      const viewId = newId();
      const op: CreateViewOp = {
        kind: 'view',
        table: table.table.id,
        view: viewId,
        change: { kind: 'create', view: this.viewBody(key, name, partial) },
      };
      const answer = await this.client.send(
        applyOpsRequest(this.pins.databaseId, [op])
      );
      const made = answer.results[0]?.view ?? viewId;
      await this.pin({
        ...this.pins,
        views: { ...this.pins.views, [key]: made },
      });
      this.changed(`saved the ${table.table.name} view "${name}"`);
      saved = true;
    }
    // The schema this start returns lists the views it just saved.
    if (saved) await this.refresh();
  }

  async ensureFolders(): Promise<void> {
    for (const key of FOLDER_ORDER) {
      const pinned = this.pins.folders[key];
      if (pinned !== undefined) {
        await this.checkFolder(key, pinned);
        continue;
      }
      const listed = await this.client.send(listProjectsRequest());
      const mine = listed.data.filter(
        (p) =>
          sameName(p.userId, this.pins.serviceUserId) &&
          (p.deletedAt ?? null) === null &&
          (p.parentId ?? null) === null &&
          sameName(p.name, FOLDERS[key])
      );
      const madeSince = (p: (typeof mine)[number]): boolean =>
        p.createdAt !== null &&
        p.createdAt !== undefined &&
        Date.parse(p.createdAt) >= Date.parse(this.pins.databaseCreatedAt);
      const only = mine[0];
      if (only !== undefined) {
        if (!this.setupDone && mine.length === 1 && madeSince(only)) {
          await this.pin({
            ...this.pins,
            folders: { ...this.pins.folders, [key]: only.id },
          });
          continue;
        }
        throw new SchemaError(
          'unpinned_existing',
          `a folder named ${FOLDERS[key]} already exists and is not the service's; trash or rename it`
        );
      }
      const created = await this.client.send(
        createProjectRequest(FOLDERS[key])
      );
      await this.pin({
        ...this.pins,
        folders: { ...this.pins.folders, [key]: created.data.id },
      });
      this.changed(`made the ${FOLDERS[key]} folder`);
    }
  }

  private async checkFolder(key: FolderKey, id: string): Promise<void> {
    const answer = await sendOrMissing(
      this.client,
      getProjectRequest(id),
      () =>
        new SchemaError(
          'folder_missing',
          `the ${FOLDERS[key]} folder no longer exists; the service will not make a second one`
        )
    );
    const project = answer.data.projectMetadata;
    if ((project.deletedAt ?? null) !== null) {
      throw new SchemaError(
        'folder_trashed',
        `the ${FOLDERS[key]} folder is in the trash; restore it, the service will not make a second one`
      );
    }
    if (
      answer.data.userAccessLevel !== 'owner' ||
      !sameName(project.userId, this.pins.serviceUserId)
    ) {
      throw new SchemaError(
        'not_owned',
        `the ${FOLDERS[key]} folder is not owned by this account`
      );
    }
  }

  async ensureShares(): Promise<void> {
    const entities: { type: ShareEntityType; id: string; what: string }[] = [
      { type: 'database', id: this.pins.databaseId, what: 'the Jobs database' },
    ];
    for (const key of FOLDER_ORDER) {
      const id = this.pins.folders[key];
      if (id !== undefined)
        entities.push({
          type: 'project',
          id,
          what: `the ${FOLDERS[key]} folder`,
        });
    }
    for (const entity of entities) {
      const grants = await this.client.send(
        directAccessRequest(entity.type, entity.id)
      );
      for (const grant of grants) {
        if (
          sameName(grant.userId, this.pins.ownerUserId) ||
          sameName(grant.userId, this.pins.serviceUserId)
        ) {
          continue;
        }
        this.noted(
          `${entity.what} is also shared with ${grant.userId} (${grant.accessLevel}); the service shares only with the owner and leaves that grant as it is: remove it in SupaMac unless it is meant`
        );
      }
      const owner = grants.find((g) =>
        sameName(g.userId, this.pins.ownerUserId)
      );
      if (
        owner !== undefined &&
        (owner.accessLevel === 'edit' || owner.accessLevel === 'owner')
      )
        continue;
      await this.client.send(
        setDirectAccessRequest(
          entity.type,
          entity.id,
          this.pins.ownerUserId,
          'edit'
        )
      );
      this.changed(`shared ${entity.what} with the owner, with edit access`);
    }
  }

  async finish(): Promise<EnsureSchemaResult> {
    if (!this.pins.complete) {
      await this.pin({ ...this.pins, complete: true });
    }
    const schema = resolveSchema(this.pins, this.current());
    return {
      pins: this.pins,
      schema,
      changes: this.changes,
      notes: this.notes,
    };
  }

  get currentPins(): JobsPins {
    return this.pins;
  }
}

/**
 * The example database the web app makes for an account on its first
 * sign-in (crates/databases/src/domain/starter.rs). Setup signs in as the
 * jobs account to make its key, so the account may hold it; untouched, it is
 * not an earlier setup.
 */
const STARTER_DATABASE = { name: 'Getting started', table: 'Ideas' } as const;

type ListedDatabase = z.infer<typeof ListedDatabaseSchema>;

function isUntouchedStarter(listed: ListedDatabase): boolean {
  return (
    listed.database.name === STARTER_DATABASE.name &&
    listed.tables.length === 1 &&
    listed.tables[0]?.name === STARTER_DATABASE.table
  );
}

/**
 * With nothing pinned: stops when this account already owns a database
 * (other than the untouched example) or a folder by one of the service's
 * names, since either is an earlier setup whose pins were lost.
 */
async function refuseEarlierSetup(
  input: EnsureSchemaInput,
  ownerUserId: string
): Promise<void> {
  const listed = await input.client.send(listDatabasesRequest());
  const owned = listed.filter(
    (d) =>
      d.grant === 'owner' &&
      d.database.trashed_at === null &&
      !isUntouchedStarter(d)
  );
  const first = owned[0];
  if (first !== undefined) {
    const named =
      owned.find((d) => sameName(d.database.name, DATABASE_NAME)) ?? first;
    throw new SchemaError(
      'unpinned_existing',
      `this account already owns a database the service has not pinned (${JSON.stringify(named.database.name)}${owned.length > 1 ? ` and ${owned.length - 1} more` : ''}); restore the state volume with its pins, or trash it, so the service does not make a second one`
    );
  }
  const projects = await input.client.send(listProjectsRequest());
  for (const key of FOLDER_ORDER) {
    const candidates = projects.data.filter(
      (p) =>
        (p.deletedAt ?? null) === null &&
        (p.parentId ?? null) === null &&
        sameName(p.name, FOLDERS[key]) &&
        !sameName(p.userId, ownerUserId)
    );
    for (const candidate of candidates) {
      const answer = await input.client.send(getProjectRequest(candidate.id));
      if (answer.data.userAccessLevel === 'owner') {
        throw new SchemaError(
          'unpinned_existing',
          `this account already owns a folder named ${FOLDERS[key]} that the service has not pinned; restore the state volume with its pins, or trash or rename the folder, so the service does not make a second Jobs database`
        );
      }
    }
  }
}

async function createDatabase(
  input: EnsureSchemaInput,
  ownerUserId: string
): Promise<JobsPins> {
  await refuseEarlierSetup(input, ownerUserId);
  const database = await input.client.send(
    createDatabaseRequest(DATABASE_NAME, TABLES.jobs.name)
  );
  const pins: JobsPins = {
    version: 1,
    serviceUserId: database.owner_id,
    ownerUserId,
    databaseId: database.id,
    databaseCreatedAt: database.created_at,
    complete: false,
    tables: {},
    views: {},
    folders: {},
  };
  await input.save(pins);
  input.logger?.info('jobs database changed', {
    change: 'made the Jobs database',
  });
  return pins;
}

/**
 * Makes the Jobs database on the first start, resumes an unfinished setup,
 * and on every later start verifies the pinned ids, follows renames and adds
 * what is missing. Stops with a `SchemaError` rather than make anything twice.
 */
export async function ensureJobsSchema(
  input: EnsureSchemaInput
): Promise<EnsureSchemaResult> {
  let ownerUserId: string;
  try {
    ownerUserId = userIdForEmail(input.ownerEmail);
  } catch (error) {
    throw new SchemaError(
      'owner_invalid',
      'JOBS_OWNER_EMAIL is not an email address',
      { cause: error }
    );
  }
  const startChanges: string[] = [];
  const startNotes: string[] = [];
  let pins = input.pins;
  if (pins === undefined) {
    pins = await createDatabase(input, ownerUserId);
    startChanges.push('made the Jobs database');
  } else if (pins.ownerUserId !== ownerUserId) {
    startNotes.push(
      'the owner address changed; the new owner is given access, and the old one keeps theirs until it is removed in SupaMac'
    );
    pins = { ...pins, ownerUserId };
    await input.save(pins);
  }
  if (sameName(pins.ownerUserId, pins.serviceUserId)) {
    throw new SchemaError(
      'owner_invalid',
      'JOBS_OWNER_EMAIL is the jobs account itself; it must be the owner’s own account'
    );
  }
  const setup = new Setup(input, pins);
  setup.changes.push(...startChanges);
  setup.notes.push(...startNotes);
  await setup.refresh();
  await setup.ensureTables();
  for (const key of TABLE_ORDER) await setup.ensureColumns(key);
  await setup.ensureViews();
  await setup.ensureFolders();
  await setup.ensureShares();
  return setup.finish();
}
