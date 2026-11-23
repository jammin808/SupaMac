// The pipeline's store over SupaMac's storage routes (store.ts), built from
// U3's pieces: sql.ts statements on the pinned schema, documents.ts for the
// folders, changes.ts for the change journal.
//
// Invariants:
// - Every statement names its database; every read names the columns it
//   decodes; a read the server cut short is reported partial.
// - Every write reports the versions it produced (`newVersions`) to the
//   write hook before it returns, so the change poll skips them.
// - A Markdown document is rewritten only at the revision it was read at
//   (`PUT /documents/{id}/markdown` with `expectedRevision`).

import { z } from 'zod';
import { checkId, getDatabaseRequest } from '../supamac/api';
import type { Attribution, TableChangeReport } from '../supamac/changes';
import { readTableChanges } from '../supamac/changes';
import type { ApiRequest, SupaMacClient } from '../supamac/client';
import {
  downloadDocument,
  type FolderDocument,
  listFolderDocuments,
  moveDocument,
  type Uploaded,
  uploadFile,
  uploadMarkdown,
} from '../supamac/documents';
import {
  type Condition,
  type Executed,
  execute,
  insertRow,
  insertRows,
  read,
  selectRows,
  updateRow,
} from '../supamac/sql';
import {
  type ColumnKey,
  columnsOf,
  type FolderKey,
  type JobsSchema,
  type RowInput,
  TABLE_ORDER,
  type TableKey,
} from '../supamac/tables';
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
} from './store';

const DocumentMarkdownSchema = z.object({
  markdown: z.string(),
  revision: z.string().min(1),
});
const MarkdownWrittenSchema = z.object({
  revision: z.string(),
  changed: z.boolean(),
});

export function readMarkdownRequest(
  documentId: string
): ApiRequest<z.infer<typeof DocumentMarkdownSchema>> {
  return {
    method: 'GET',
    template: '/documents/{document_id}/markdown',
    params: { document_id: checkId('document_id', documentId) },
    query: {},
    response: DocumentMarkdownSchema,
  };
}

export function writeMarkdownRequest(
  documentId: string,
  markdown: string,
  expectedRevision: string
): ApiRequest<z.infer<typeof MarkdownWrittenSchema>> {
  return {
    method: 'PUT',
    template: '/documents/{document_id}/markdown',
    params: { document_id: checkId('document_id', documentId) },
    query: {},
    body: { kind: 'json', value: { markdown, expectedRevision } },
    response: MarkdownWrittenSchema,
  };
}

function allColumns<T extends TableKey>(table: T): ColumnKey<T>[] {
  return columnsOf(table).map(([key]) => key as ColumnKey<T>);
}

function and<T extends TableKey>(
  conditions: Condition<T>[]
): Condition<T> | undefined {
  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return { op: 'and', conditions };
}

export interface SupaMacStoreOptions {
  readonly client: SupaMacClient;
  readonly schema: JobsSchema;
  readonly onWrite?: WriteHook | undefined;
}

export class SupaMacStore implements JobsStore {
  private current: JobsSchema;
  private readonly client: SupaMacClient;
  private readonly onWrite: WriteHook | undefined;

  constructor(options: SupaMacStoreOptions) {
    this.client = options.client;
    this.current = options.schema;
    this.onWrite = options.onWrite;
  }

  get schema(): JobsSchema {
    return this.current;
  }

  /** Follows a schema verified again (a column renamed or added since the start). */
  setSchema(schema: JobsSchema): void {
    this.current = schema;
  }

  private async written(executed: Executed): Promise<void> {
    if (this.onWrite !== undefined && executed.written.length > 0)
      await this.onWrite(executed.written);
  }

  // --- Sources.

  async insertSource(values: RowInput<'sources'>): Promise<string> {
    const done = await execute(
      this.client,
      insertRow(this.schema, 'sources', values)
    );
    await this.written(done);
    const id = done.outcome.insertedRowIds[0];
    if (id === undefined)
      throw new Error('the Sources insert returned no row id');
    return id;
  }

  async updateSource(id: string, values: RowInput<'sources'>): Promise<void> {
    await this.written(
      await execute(this.client, updateRow(this.schema, 'sources', id, values))
    );
  }

  async sources(filter: SourceFilter): Promise<Read<SourceRow>> {
    const where: Condition<'sources'>[] = [];
    if (filter.ids !== undefined) {
      if (filter.ids.length === 0) return { rows: [], partial: false };
      where.push({ op: 'row_id in', ids: filter.ids });
    }
    if (filter.hash !== undefined)
      where.push({ op: '=', column: 'Hash', value: filter.hash });
    if (filter.messageId !== undefined)
      where.push({ op: '=', column: 'Message ID', value: filter.messageId });
    if (filter.documentId !== undefined)
      where.push({ op: '=', column: 'Document', value: filter.documentId });
    if (filter.statuses !== undefined) {
      if (filter.statuses.length === 0) return { rows: [], partial: false };
      where.push({ op: 'in', column: 'Status', values: filter.statuses });
    }
    if (filter.jobId !== undefined)
      where.push({ op: 'has', column: 'Job', value: filter.jobId });
    if (filter.filed === true) where.push({ op: 'is not null', column: 'Job' });
    const statement = selectRows(
      this.schema,
      'sources',
      allColumns('sources'),
      {
        where: and(where),
      }
    );
    const result = await read(this.client, this.schema, statement);
    return {
      rows: result.rows.map((r) => sourceFromValues(r.rowId, r.values)),
      partial: result.partial,
    };
  }

  // --- Details.

  async insertDetails(rows: readonly RowInput<'details'>[]): Promise<string[]> {
    const out: string[] = [];
    for (const statement of insertRows(this.schema, 'details', rows)) {
      const done = await execute(this.client, statement);
      await this.written(done);
      out.push(...done.outcome.insertedRowIds);
    }
    if (out.length !== rows.length)
      throw new Error(
        `the Details insert returned ${out.length} ids for ${rows.length} rows`
      );
    return out;
  }

  async updateDetail(id: string, values: RowInput<'details'>): Promise<void> {
    await this.written(
      await execute(this.client, updateRow(this.schema, 'details', id, values))
    );
  }

  async details(filter: DetailFilter): Promise<Read<DetailRow>> {
    const where: Condition<'details'>[] = [];
    if (filter.ids !== undefined) {
      if (filter.ids.length === 0) return { rows: [], partial: false };
      where.push({ op: 'row_id in', ids: filter.ids });
    }
    if (filter.jobId !== undefined)
      where.push({ op: 'has', column: 'Job', value: filter.jobId });
    if (filter.sourceId !== undefined)
      where.push({ op: 'has', column: 'Source row', value: filter.sourceId });
    if (filter.statuses !== undefined) {
      if (filter.statuses.length === 0) return { rows: [], partial: false };
      where.push({ op: 'in', column: 'Status', values: filter.statuses });
    }
    const statement = selectRows(
      this.schema,
      'details',
      allColumns('details'),
      {
        where: and(where),
      }
    );
    const result = await read(this.client, this.schema, statement);
    return {
      rows: result.rows.map((r) => detailFromValues(r.rowId, r.values)),
      partial: result.partial,
    };
  }

  // --- Jobs.

  async insertJob(values: RowInput<'jobs'>): Promise<string> {
    const done = await execute(
      this.client,
      insertRow(this.schema, 'jobs', values)
    );
    await this.written(done);
    const id = done.outcome.insertedRowIds[0];
    if (id === undefined) throw new Error('the Jobs insert returned no row id');
    return id;
  }

  async updateJob(
    id: string,
    values: RowInput<'jobs'>,
    options: { readonly baseVersion?: number | undefined } = {}
  ): Promise<void> {
    const baseVersions =
      options.baseVersion === undefined
        ? undefined
        : { [this.schema.tables.jobs.id]: options.baseVersion };
    await this.written(
      await execute(this.client, updateRow(this.schema, 'jobs', id, values), {
        baseVersions,
      })
    );
  }

  async jobs(ids?: readonly string[]): Promise<Read<JobRow>> {
    if (ids !== undefined && ids.length === 0)
      return { rows: [], partial: false };
    const statement = selectRows(this.schema, 'jobs', allColumns('jobs'), {
      where: ids === undefined ? undefined : { op: 'row_id in', ids },
    });
    const result = await read(this.client, this.schema, statement);
    return {
      rows: result.rows.map((r) => jobFromValues(r.rowId, r.values)),
      partial: result.partial,
    };
  }

  async job(id: string): Promise<{ row: JobRow; version: number } | undefined> {
    const statement = selectRows(this.schema, 'jobs', allColumns('jobs'), {
      where: { op: 'row_id in', ids: [id] },
    });
    const result = await read(this.client, this.schema, statement);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      row: jobFromValues(row.rowId, row.values),
      version: result.readVersions[this.schema.tables.jobs.id] ?? 0,
    };
  }

  // --- Status.

  async writeStatus(
    rowId: string | undefined,
    values: StatusValues
  ): Promise<string> {
    if (rowId !== undefined) {
      const done = await execute(
        this.client,
        updateRow(this.schema, 'status', rowId, values)
      );
      if (done.outcome.changesApplied > 0) return rowId;
    }
    const done = await execute(
      this.client,
      insertRow(this.schema, 'status', values)
    );
    const id = done.outcome.insertedRowIds[0];
    if (id === undefined)
      throw new Error('the Status insert returned no row id');
    return id;
  }

  // --- Changes.

  async tableVersions(): Promise<Readonly<Record<TableKey, number>>> {
    const detail = await this.client.send(
      getDatabaseRequest(this.schema.databaseId)
    );
    const out: Partial<Record<TableKey, number>> = {};
    for (const key of TABLE_ORDER) {
      const id = this.schema.tables[key].id;
      out[key] =
        detail.tables.find((t) => t.table.id === id)?.table.version ?? 0;
    }
    return out as Record<TableKey, number>;
  }

  tableChanges(
    table: TableKey,
    since: number,
    who: Attribution
  ): Promise<TableChangeReport> {
    return readTableChanges(this.client, {
      databaseId: this.schema.databaseId,
      tableId: this.schema.tables[table].id,
      since,
      who,
    });
  }

  // --- Documents.

  uploadFile(
    name: string,
    bytes: Uint8Array,
    folder: FolderKey
  ): Promise<Uploaded> {
    return uploadFile(this.client, {
      fileName: name,
      bytes,
      folderId: this.schema.folders[folder],
    });
  }

  uploadMarkdown(
    name: string,
    markdown: string,
    folder: FolderKey
  ): Promise<Uploaded> {
    return uploadMarkdown(this.client, {
      name,
      markdown,
      folderId: this.schema.folders[folder],
    });
  }

  folderDocuments(folder: FolderKey): Promise<FolderDocument[]> {
    return listFolderDocuments(this.client, this.schema.folders[folder], {
      readiness: true,
    });
  }

  downloadDocument(id: string): Promise<Uint8Array> {
    return downloadDocument(this.client, id);
  }

  moveDocument(id: string, folder: FolderKey): Promise<void> {
    return moveDocument(this.client, id, this.schema.folders[folder]);
  }

  readMarkdown(id: string): Promise<{ markdown: string; revision: string }> {
    return this.client.send(readMarkdownRequest(id));
  }

  async writeMarkdown(
    id: string,
    markdown: string,
    revision: string
  ): Promise<void> {
    await this.client.send(writeMarkdownRequest(id, markdown, revision));
  }
}
