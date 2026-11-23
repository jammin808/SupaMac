// An in-memory JobsStore for the pipeline's tests: the four tables as rows of
// column-keyed values, a version per table, a journal of every change with
// its actor and acting agent (as row history records them), documents in the
// two folders, and failures a test can queue. Writes made through the store
// are the service's; `edit` makes the owner's or an agent's.

import { randomUUID } from 'node:crypto';
import type { HistoryCell, RowHistoryEntry } from '../../src/supamac/api';
import {
  type Attribution,
  authorOf,
  type RowChange,
  type TableChangeReport,
} from '../../src/supamac/changes';
import { SupaMacError } from '../../src/supamac/client';
import {
  type FolderDocument,
  sanitizeFileName,
  type Uploaded,
} from '../../src/supamac/documents';
import { quoteIdent } from '../../src/supamac/sql';
import {
  columnsOf,
  type FolderKey,
  type JobsSchema,
  optionsOf,
  type ResolvedColumn,
  type ResolvedOption,
  type ResolvedTable,
  type RowInput,
  TABLE_ORDER,
  TABLES,
  type TableKey,
} from '../../src/supamac/tables';
import {
  type DetailFilter,
  type DetailRow,
  detailFromValues,
  type JobRow,
  type JobsStore,
  jobFromValues,
  type Read,
  type SourceFilter,
  type SourceRow,
  type StatusValues,
  sourceFromValues,
  type WriteHook,
} from '../../src/pipeline/store';

export const SERVICE_USER = 'macro|jobs@example.com';
export const OWNER_EMAIL = 'sam.price@example.com';
export const OWNER_USER = `macro|${OWNER_EMAIL}`;

let counter = 0;
/** A UUID that sorts in the order it was made. */
export function uuid(): string {
  counter++;
  return `0190d5a8-0000-7000-8000-${counter.toString(16).padStart(12, '0')}`;
}

/** A schema as ensureJobsSchema would resolve it, with fresh ids. */
export function memorySchema(): JobsSchema {
  const tables: Record<string, ResolvedTable> = {};
  for (const key of TABLE_ORDER) {
    const columns: Record<string, ResolvedColumn> = {};
    for (const [columnKey, spec] of columnsOf(key)) {
      const options = new Map<string, ResolvedOption>(
        optionsOf(spec).map((label) => [label, { id: uuid(), label }])
      );
      columns[columnKey] = {
        key: columnKey,
        id: uuid(),
        name: columnKey,
        sqlName: quoteIdent(columnKey),
        spec,
        options,
      };
    }
    tables[key] = {
      key,
      id: uuid(),
      name: TABLES[key].name,
      sqlName: quoteIdent(TABLES[key].name),
      columns: columns as ResolvedTable['columns'],
    };
  }
  return {
    databaseId: uuid(),
    serviceUserId: SERVICE_USER,
    ownerUserId: OWNER_USER,
    tables: tables as unknown as JobsSchema['tables'],
    views: {},
    folders: { intake: uuid(), sources: uuid() },
  };
}

type Values = Record<string, unknown>;

interface MemoryTable {
  version: number;
  rows: Map<string, Values>;
  history: Map<string, RowHistoryEntry[]>;
}

export interface MemoryDocument {
  id: string;
  name: string;
  folder: FolderKey;
  owner: string;
  bytes: Uint8Array;
  fileType: string;
  readiness: 'ready' | 'pending';
  markdown?: string | undefined;
  revision: number;
}

export type Failure = Error | 'hang';

export type Actor = 'service' | 'owner' | 'agent';

export class MemoryStore implements JobsStore {
  readonly schema: JobsSchema;
  readonly tables = new Map<TableKey, MemoryTable>();
  readonly documents = new Map<string, MemoryDocument>();
  /** Failures to raise, by method name, oldest first. */
  readonly failures = new Map<string, Failure[]>();
  /** Every call, by method name. */
  readonly calls: string[] = [];
  /** Tables whose journal reports it cannot list every change. */
  readonly incomplete = new Set<TableKey>();
  onWrite: WriteHook | undefined;
  clock: () => Date = () => new Date('2027-03-05T10:00:00Z');
  private change = 0;

  constructor(schema: JobsSchema = memorySchema()) {
    this.schema = schema;
    for (const key of TABLE_ORDER)
      this.tables.set(key, { version: 1, rows: new Map(), history: new Map() });
  }

  /** Queues a failure for the next call of `method`. */
  fail(method: string, failure: Failure): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), failure]);
  }

  private async enter(method: string): Promise<void> {
    this.calls.push(method);
    const queue = this.failures.get(method);
    const next = queue?.shift();
    if (next === undefined) return;
    if (next === 'hang') await new Promise<never>(() => undefined);
    throw next;
  }

  private table(key: TableKey): MemoryTable {
    return this.tables.get(key) as MemoryTable;
  }

  private column(table: TableKey, key: string): ResolvedColumn {
    const columns = this.schema.tables[table].columns as Readonly<
      Record<string, ResolvedColumn>
    >;
    const column = columns[key];
    if (column === undefined) throw new Error(`no ${key} column in ${table}`);
    return column;
  }

  /** A logical value as row history writes it. */
  private cell(column: ResolvedColumn, value: unknown): HistoryCell {
    if (
      value === null ||
      value === undefined ||
      (Array.isArray(value) && value.length === 0)
    )
      return { type: 'clear' };
    switch (column.spec.kind) {
      case 'text':
        return { type: 'text', value: String(value) };
      case 'number':
        return { type: 'number', value: Number(value) };
      case 'date':
        return { type: 'date', value: String(value) };
      case 'date_range': {
        const r = value as { start: string; end: string };
        return { type: 'date_range', value: { start: r.start, end: r.end } };
      }
      case 'select':
        return {
          type: 'options',
          value: [
            { id: column.options.get(String(value))?.id ?? String(value) },
          ],
        };
      case 'tag':
        return {
          type: 'options',
          value: (value as string[]).map((v) => ({
            id: column.options.get(v)?.id ?? v,
          })),
        };
      case 'document':
        return {
          type: 'entities',
          value: [{ entityType: 'document', entityId: String(value) }],
        };
      case 'relation':
        return { type: 'link', value: [...(value as string[])] };
    }
  }

  /** Applies a write to a row and journals it; returns the new table version. */
  write(
    table: TableKey,
    rowId: string,
    values: Values,
    actor: Actor,
    kind: 'insert' | 'update' | 'delete' = 'update',
    version?: number
  ): number {
    const t = this.table(table);
    const before = t.rows.get(rowId) ?? {};
    if (kind !== 'insert' && !t.rows.has(rowId))
      throw new Error(`no row ${rowId} in ${table}`);
    t.version = version ?? t.version + 1;
    const keys = Object.keys(values).filter((k) => values[k] !== undefined);
    for (const k of keys) this.column(table, k);
    const next: Values = kind === 'delete' ? {} : { ...before };
    for (const k of keys) {
      const v = values[k];
      next[k] = Array.isArray(v) ? [...v] : v;
    }
    if (kind === 'delete') t.rows.delete(rowId);
    else t.rows.set(rowId, next);
    const entry: RowHistoryEntry = {
      change: ++this.change,
      version: t.version,
      actor: actor === 'service' ? SERVICE_USER : OWNER_USER,
      actingBot: actor === 'agent' ? 'assistant' : null,
      at: this.clock().toISOString(),
      kind,
      columns: keys.map((k) => this.column(table, k).id),
      before: Object.fromEntries(
        keys.map((k) => [
          this.column(table, k).id,
          this.cell(this.column(table, k), before[k]),
        ])
      ),
      after: Object.fromEntries(
        keys.map((k) => [
          this.column(table, k).id,
          this.cell(this.column(table, k), next[k]),
        ])
      ),
    };
    t.history.set(rowId, [...(t.history.get(rowId) ?? []), entry]);
    return t.version;
  }

  private async serviceWrite(
    table: TableKey,
    rowId: string,
    values: Values,
    kind: 'insert' | 'update' = 'update'
  ): Promise<void> {
    const version = this.write(table, rowId, values, 'service', kind);
    await this.onWrite?.([{ tableId: this.schema.tables[table].id, version }]);
  }

  /** The owner's or an agent's edit in SupaMac. */
  edit(
    table: TableKey,
    rowId: string,
    values: Values,
    by: 'owner' | 'agent'
  ): void {
    this.write(table, rowId, values, by);
  }

  /** A row the owner or an agent adds. */
  add(table: TableKey, values: Values, by: 'owner' | 'agent'): string {
    const id = uuid();
    this.write(table, id, values, by, 'insert');
    return id;
  }

  rows(table: TableKey): [string, Values][] {
    return [...this.table(table).rows];
  }

  values(table: TableKey, rowId: string): Values | undefined {
    return this.table(table).rows.get(rowId);
  }

  // --- JobsStore.

  async insertSource(values: RowInput<'sources'>): Promise<string> {
    await this.enter('insertSource');
    const id = uuid();
    await this.serviceWrite('sources', id, values as Values, 'insert');
    return id;
  }

  async updateSource(id: string, values: RowInput<'sources'>): Promise<void> {
    await this.enter('updateSource');
    await this.serviceWrite('sources', id, values as Values);
  }

  async sources(filter: SourceFilter): Promise<Read<SourceRow>> {
    await this.enter('sources');
    const rows = this.rows('sources')
      .filter(([id, v]) => {
        const jobs = (v.Job as string[] | undefined) ?? [];
        return (
          (filter.ids === undefined || filter.ids.includes(id)) &&
          (filter.hash === undefined || v.Hash === filter.hash) &&
          (filter.messageId === undefined ||
            v['Message ID'] === filter.messageId) &&
          (filter.documentId === undefined ||
            v.Document === filter.documentId) &&
          (filter.statuses === undefined ||
            filter.statuses.includes(v.Status as never)) &&
          (filter.jobId === undefined || jobs.includes(filter.jobId)) &&
          (filter.filed !== true || jobs.length > 0)
        );
      })
      .map(([id, v]) => sourceFromValues(id, v));
    return { rows, partial: false };
  }

  async insertDetails(rows: readonly RowInput<'details'>[]): Promise<string[]> {
    await this.enter('insertDetails');
    const ids: string[] = [];
    // One statement: one version for every row.
    const version = this.table('details').version + 1;
    for (const values of rows) {
      const id = uuid();
      ids.push(id);
      this.write('details', id, values as Values, 'service', 'insert', version);
    }
    await this.onWrite?.([{ tableId: this.schema.tables.details.id, version }]);
    return ids;
  }

  async updateDetail(id: string, values: RowInput<'details'>): Promise<void> {
    await this.enter('updateDetail');
    await this.serviceWrite('details', id, values as Values);
  }

  async details(filter: DetailFilter): Promise<Read<DetailRow>> {
    await this.enter('details');
    const rows = this.rows('details')
      .filter(([id, v]) => {
        const jobs = (v.Job as string[] | undefined) ?? [];
        const sources = (v['Source row'] as string[] | undefined) ?? [];
        return (
          (filter.ids === undefined || filter.ids.includes(id)) &&
          (filter.jobId === undefined || jobs.includes(filter.jobId)) &&
          (filter.sourceId === undefined ||
            sources.includes(filter.sourceId)) &&
          (filter.statuses === undefined ||
            filter.statuses.includes(v.Status as never))
        );
      })
      .map(([id, v]) => detailFromValues(id, v));
    return { rows, partial: false };
  }

  async insertJob(values: RowInput<'jobs'>): Promise<string> {
    await this.enter('insertJob');
    const id = uuid();
    await this.serviceWrite('jobs', id, values as Values, 'insert');
    return id;
  }

  async updateJob(
    id: string,
    values: RowInput<'jobs'>,
    options: { readonly baseVersion?: number | undefined } = {}
  ): Promise<void> {
    await this.enter('updateJob');
    const t = this.table('jobs');
    if (
      options.baseVersion !== undefined &&
      options.baseVersion !== t.version
    ) {
      throw new SupaMacError(
        'conflict',
        'POST /databases/query',
        'the Jobs table moved on',
        {
          status: 409,
        }
      );
    }
    await this.serviceWrite('jobs', id, values as Values);
  }

  async jobs(ids?: readonly string[]): Promise<Read<JobRow>> {
    await this.enter('jobs');
    const rows = this.rows('jobs')
      .filter(([id]) => ids === undefined || ids.includes(id))
      .map(([id, v]) => jobFromValues(id, v));
    return { rows, partial: false };
  }

  async job(id: string): Promise<{ row: JobRow; version: number } | undefined> {
    await this.enter('job');
    const v = this.values('jobs', id);
    if (v === undefined) return undefined;
    return { row: jobFromValues(id, v), version: this.table('jobs').version };
  }

  async writeStatus(
    rowId: string | undefined,
    values: StatusValues
  ): Promise<string> {
    await this.enter('writeStatus');
    if (rowId !== undefined && this.values('status', rowId) !== undefined) {
      this.write('status', rowId, values as Values, 'service');
      return rowId;
    }
    const id = uuid();
    this.write('status', id, values as Values, 'service', 'insert');
    return id;
  }

  async tableVersions(): Promise<Readonly<Record<TableKey, number>>> {
    await this.enter('tableVersions');
    return Object.fromEntries(
      TABLE_ORDER.map((k) => [k, this.table(k).version])
    ) as Record<TableKey, number>;
  }

  async tableChanges(
    table: TableKey,
    since: number,
    who: Attribution
  ): Promise<TableChangeReport> {
    await this.enter('tableChanges');
    const t = this.table(table);
    const tableId = this.schema.tables[table].id;
    const changes: RowChange[] = [];
    let skipped = 0;
    for (const [rowId, entries] of t.history) {
      for (const entry of entries) {
        if (entry.version <= since || entry.version > t.version) continue;
        const author = authorOf(entry, tableId, who);
        if (author === 'service') {
          skipped++;
          continue;
        }
        changes.push({
          rowId,
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
    changes.sort((a, b) => a.version - b.version || a.change - b.change);
    return {
      tableId,
      since,
      version: t.version,
      needsFullRead: this.incomplete.has(table),
      columns: [],
      changes,
      skipped,
    };
  }

  // --- Documents.

  private addDocument(
    name: string,
    folder: FolderKey,
    bytes: Uint8Array,
    owner: string
  ): MemoryDocument {
    const fileType = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    const doc: MemoryDocument = {
      id: uuid(),
      name,
      folder,
      owner,
      bytes,
      fileType,
      readiness: 'ready',
      revision: 1,
      ...(fileType === 'md'
        ? { markdown: new TextDecoder().decode(bytes) }
        : {}),
    };
    this.documents.set(doc.id, doc);
    return doc;
  }

  /** A document the owner drops into a folder. */
  drop(
    name: string,
    bytes: Uint8Array,
    folder: FolderKey = 'intake',
    owner = OWNER_USER
  ): MemoryDocument {
    return this.addDocument(name, folder, bytes, owner);
  }

  inFolder(folder: FolderKey): MemoryDocument[] {
    return [...this.documents.values()].filter((d) => d.folder === folder);
  }

  async uploadFile(
    name: string,
    bytes: Uint8Array,
    folder: FolderKey
  ): Promise<Uploaded> {
    await this.enter('uploadFile');
    const fileName = sanitizeFileName(name);
    const doc = this.addDocument(fileName, folder, bytes, SERVICE_USER);
    return { documentId: doc.id, sizeBytes: bytes.byteLength, fileName };
  }

  async uploadMarkdown(
    name: string,
    markdown: string,
    folder: FolderKey
  ): Promise<Uploaded> {
    await this.enter('uploadMarkdown');
    const fileName = sanitizeFileName(`${name}.md`);
    const bytes = new TextEncoder().encode(markdown);
    const doc = this.addDocument(fileName, folder, bytes, SERVICE_USER);
    return { documentId: doc.id, sizeBytes: bytes.byteLength, fileName };
  }

  async folderDocuments(folder: FolderKey): Promise<FolderDocument[]> {
    await this.enter('folderDocuments');
    return this.inFolder(folder).map((d) => ({
      id: d.id,
      name: d.name.replace(/\.[^.]+$/, ''),
      owner: d.owner,
      fileType: d.fileType,
      createdAt: undefined,
      readiness: d.readiness,
    }));
  }

  async downloadDocument(id: string): Promise<Uint8Array> {
    await this.enter('downloadDocument');
    const doc = this.documents.get(id);
    if (doc === undefined)
      throw new SupaMacError(
        'not_found',
        'GET /documents/{document_id}/export',
        'no such document',
        { status: 404 }
      );
    return doc.bytes;
  }

  async moveDocument(id: string, folder: FolderKey): Promise<void> {
    await this.enter('moveDocument');
    const doc = this.documents.get(id);
    if (doc === undefined)
      throw new SupaMacError(
        'not_found',
        'PATCH /documents/{document_id}',
        'no such document',
        { status: 404 }
      );
    doc.folder = folder;
  }

  async readMarkdown(
    id: string
  ): Promise<{ markdown: string; revision: string }> {
    await this.enter('readMarkdown');
    const doc = this.documents.get(id);
    if (doc?.markdown === undefined)
      throw new SupaMacError(
        'not_found',
        'GET /documents/{document_id}/markdown',
        'no such document',
        { status: 404 }
      );
    return { markdown: doc.markdown, revision: String(doc.revision) };
  }

  async writeMarkdown(
    id: string,
    markdown: string,
    revision: string
  ): Promise<void> {
    await this.enter('writeMarkdown');
    const doc = this.documents.get(id);
    if (doc?.markdown === undefined)
      throw new SupaMacError(
        'not_found',
        'PUT /documents/{document_id}/markdown',
        'no such document',
        { status: 404 }
      );
    if (String(doc.revision) !== revision)
      throw new SupaMacError(
        'conflict',
        'PUT /documents/{document_id}/markdown',
        'changed since read',
        { status: 409 }
      );
    doc.markdown = markdown;
    doc.revision++;
  }
}

/** A random id for tests that need one outside the store's sequence. */
export function freshId(): string {
  return randomUUID();
}
