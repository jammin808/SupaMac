// The storage routes the service calls, as request builders and response
// schemas (packages/sdk/specs/storage.json is their contract; the tests
// check every builder against it).
//
// Invariants:
// - A builder makes a request and sends nothing; `SupaMacClient.send` sends
//   it. Every id that goes into a path is checked to be a UUID first, so no
//   text from a document or a model can reach a path.
// - Response schemas keep only the fields the service reads, and read open
//   sets (data types, layout kinds, change kinds) as strings, so a new value
//   on the server is compared, never a parse failure.

import { z } from 'zod';
import { type ApiRequest, SupaMacError } from './client';

export const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The id, when it is a UUID; a request error otherwise. */
export function checkId(what: string, id: string): string {
  if (!UUID_RE.test(id)) {
    throw new SupaMacError('request', what, `${what} must be a UUID`);
  }
  return id;
}

const Uuid = z.string().regex(UUID_RE, 'a UUID');
const NullableString = z.string().nullable().optional();

// ---------------------------------------------------------------------------
// Documents.

export const UploadFileResponseSchema = z.object({
  documentId: Uuid,
  sizeBytes: z.number().int().nonnegative(),
});
export type UploadFileResponse = z.infer<typeof UploadFileResponseSchema>;

export const DOCUMENT_CONTENT_STATES = ['unknown', 'pending', 'ready'] as const;
export type DocumentContentState = (typeof DOCUMENT_CONTENT_STATES)[number];

export const GetDocumentResponseSchema = z.object({
  error: z.literal(false),
  data: z.object({
    documentMetadata: z.object({
      documentId: z.string(),
      documentName: z.string(),
      owner: z.string(),
      fileType: NullableString,
      projectId: NullableString,
      deletedAt: NullableString,
      content: z.object({ state: z.string() }),
    }),
    userAccessLevel: z.string(),
  }),
});
export type GetDocumentResponse = z.infer<typeof GetDocumentResponseSchema>;

export const EditDocumentResponseSchema = z.object({
  error: z.literal(false),
  data: z.object({ success: z.boolean() }),
});

export const ExportDocumentResponseSchema = z.object({
  presigned_url: z.string().min(1),
});

/** The longest an upload of up to 25 MiB may take through the gateway. */
const UPLOAD_TIMEOUT_MS = 120_000;

export function uploadFileRequest(
  fileName: string,
  bytes: Uint8Array,
  projectId?: string
): ApiRequest<UploadFileResponse> {
  const query: Record<string, string> = { fileName };
  if (projectId !== undefined)
    query.projectId = checkId('projectId', projectId);
  return {
    method: 'POST',
    template: '/documents/upload',
    params: {},
    query,
    body: { kind: 'bytes', value: bytes },
    response: UploadFileResponseSchema,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    // The route answers 401 for no edit access to the destination folder.
    statusKinds: { 401: 'forbidden' },
  };
}

export function getDocumentRequest(
  documentId: string
): ApiRequest<GetDocumentResponse> {
  return {
    method: 'GET',
    template: '/documents/{document_id}',
    params: { document_id: checkId('document_id', documentId) },
    query: {},
    response: GetDocumentResponseSchema,
  };
}

/** Moves a document into a folder (`PATCH /documents/{id}` with `projectId`). */
export function moveDocumentRequest(
  documentId: string,
  projectId: string
): ApiRequest<z.infer<typeof EditDocumentResponseSchema>> {
  return {
    method: 'PATCH',
    template: '/documents/{document_id}',
    params: { document_id: checkId('document_id', documentId) },
    query: {},
    body: {
      kind: 'json',
      value: { projectId: checkId('projectId', projectId) },
    },
    response: EditDocumentResponseSchema,
  };
}

export function exportDocumentRequest(
  documentId: string
): ApiRequest<z.infer<typeof ExportDocumentResponseSchema>> {
  return {
    method: 'GET',
    template: '/documents/{document_id}/export',
    params: { document_id: checkId('document_id', documentId) },
    query: {},
    response: ExportDocumentResponseSchema,
  };
}

// ---------------------------------------------------------------------------
// Folders (projects).

export const ProjectSchema = z.object({
  id: Uuid,
  name: z.string(),
  userId: z.string(),
  parentId: NullableString,
  createdAt: NullableString,
  deletedAt: NullableString,
});
export type Project = z.infer<typeof ProjectSchema>;

export const GetProjectsResponseSchema = z.object({
  error: z.literal(false),
  data: z.array(ProjectSchema),
});

export const GetProjectResponseSchema = z.object({
  error: z.literal(false),
  data: z.object({
    projectMetadata: ProjectSchema,
    userAccessLevel: z.string(),
  }),
});

export const CreateProjectResponseSchema = z.object({
  error: z.literal(false),
  data: ProjectSchema,
});

export const DocumentItemSchema = z.object({
  type: z.literal('document'),
  id: z.string(),
  name: z.string(),
  owner: z.string(),
  fileType: NullableString,
  projectId: NullableString,
  createdAt: NullableString,
  deletedAt: NullableString,
});

/** A folder's item: a document as read, anything else (chat, folder, a later kind) by its type. */
export const ContentItemSchema = z.union([
  DocumentItemSchema,
  z.object({
    type: z.string().refine((t) => t !== 'document', 'a document item'),
  }),
]);

export const GetProjectContentResponseSchema = z.object({
  error: z.literal(false),
  data: z.array(
    z.object({ item: ContentItemSchema, userAccessLevel: z.string() })
  ),
});

export function listProjectsRequest(): ApiRequest<
  z.infer<typeof GetProjectsResponseSchema>
> {
  return {
    method: 'GET',
    template: '/projects',
    params: {},
    query: {},
    response: GetProjectsResponseSchema,
  };
}

export function getProjectRequest(
  projectId: string
): ApiRequest<z.infer<typeof GetProjectResponseSchema>> {
  return {
    method: 'GET',
    template: '/projects/{id}',
    params: { id: checkId('project id', projectId) },
    query: {},
    response: GetProjectResponseSchema,
  };
}

export function projectContentRequest(
  projectId: string
): ApiRequest<z.infer<typeof GetProjectContentResponseSchema>> {
  return {
    method: 'GET',
    template: '/projects/{id}/content',
    params: { id: checkId('project id', projectId) },
    query: {},
    response: GetProjectContentResponseSchema,
  };
}

export function createProjectRequest(
  name: string
): ApiRequest<z.infer<typeof CreateProjectResponseSchema>> {
  return {
    method: 'POST',
    template: '/projects',
    params: {},
    query: {},
    body: { kind: 'json', value: { name } },
    response: CreateProjectResponseSchema,
  };
}

// ---------------------------------------------------------------------------
// Sharing.

export type ShareEntityType = 'database' | 'project';
export type GrantLevel = 'view' | 'comment' | 'edit';

export const DirectAccessListSchema = z.array(
  z.object({ userId: z.string(), accessLevel: z.string() })
);

export function directAccessRequest(
  entityType: ShareEntityType,
  entityId: string
): ApiRequest<z.infer<typeof DirectAccessListSchema>> {
  return {
    method: 'GET',
    template: '/entities/{entity_type}/{entity_id}/direct-access',
    params: {
      entity_type: entityType,
      entity_id: checkId('entity_id', entityId),
    },
    query: {},
    response: DirectAccessListSchema,
  };
}

/** The Macro user id of an account's email address, as grants name it. */
export function userIdForEmail(email: string): string {
  const address = email.trim().toLowerCase();
  if (!/^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(address)) {
    throw new SupaMacError(
      'request',
      'owner email',
      'the owner email is not an address'
    );
  }
  return `macro|${address}`;
}

export function setDirectAccessRequest(
  entityType: ShareEntityType,
  entityId: string,
  userId: string,
  level: GrantLevel
): ApiRequest<unknown> {
  if (!userId.startsWith('macro|')) {
    throw new SupaMacError(
      'request',
      'user_id',
      'a grant names a macro| user id'
    );
  }
  return {
    method: 'PUT',
    template: '/entities/{entity_type}/{entity_id}/direct-access/{user_id}',
    params: {
      entity_type: entityType,
      entity_id: checkId('entity_id', entityId),
      user_id: userId,
    },
    query: {},
    body: { kind: 'json', value: { accessLevel: level } },
    response: z.unknown(),
  };
}

// ---------------------------------------------------------------------------
// Databases.

export const DatabaseSchema = z.object({
  id: Uuid,
  name: z.string(),
  owner_id: z.string(),
  created_at: z.string(),
  trashed_at: z.string().nullable(),
  project_id: z.string().nullable(),
});
export type Database = z.infer<typeof DatabaseSchema>;

export const TableSchema = z.object({
  id: Uuid,
  database_id: Uuid,
  name: z.string(),
  position: z.string(),
  version: z.number().int(),
});
export type Table = z.infer<typeof TableSchema>;

export const ListedDatabaseSchema = z.object({
  database: DatabaseSchema,
  grant: z.string(),
  tables: z.array(TableSchema),
});
export const ListDatabasesResponseSchema = z.array(ListedDatabaseSchema);

export const PropertyOptionSchema = z.object({
  id: Uuid,
  display_order: z.number().int(),
  value: z.discriminatedUnion('type', [
    z.object({ type: z.literal('string'), value: z.string() }),
    z.object({ type: z.literal('number'), value: z.number() }),
  ]),
});
export type PropertyOption = z.infer<typeof PropertyOptionSchema>;

export const ColumnDetailSchema = z.object({
  column: z.object({
    id: Uuid,
    table_id: Uuid,
    display_name: z.string().nullable(),
    position: z.string(),
    config: z
      .object({
        kind: z.string(),
        table_id: z.string().optional(),
        database_id: z.string().optional(),
      })
      .nullable(),
  }),
  sql_name: z.string(),
  definition: z.object({
    definition: z.object({
      id: Uuid,
      display_name: z.string(),
      data_type: z.string(),
      is_multi_select: z.boolean(),
      specific_entity_type: z.string().nullable(),
    }),
    property_options: z.array(PropertyOptionSchema),
  }),
  writable: z.boolean(),
});
export type ColumnDetail = z.infer<typeof ColumnDetailSchema>;

export const DatabaseViewSchema = z.object({
  id: Uuid,
  databaseId: Uuid,
  tableId: Uuid,
  name: z.string(),
  layout: z.object({ kind: z.string() }),
});
export type DatabaseView = z.infer<typeof DatabaseViewSchema>;

export const TableDetailSchema = z.object({
  table: TableSchema,
  sql_name: z.string(),
  columns: z.array(ColumnDetailSchema),
  views: z.array(DatabaseViewSchema),
});
export type TableDetail = z.infer<typeof TableDetailSchema>;

export const DatabaseDetailSchema = z.object({
  database: DatabaseSchema,
  grant: z.string(),
  tables: z.array(TableDetailSchema),
});
export type DatabaseDetail = z.infer<typeof DatabaseDetailSchema>;

export function createDatabaseRequest(
  name: string,
  firstTable: string
): ApiRequest<Database> {
  return {
    method: 'POST',
    template: '/databases',
    params: {},
    query: {},
    body: { kind: 'json', value: { name, firstTable } },
    response: DatabaseSchema,
  };
}

export function listDatabasesRequest(): ApiRequest<
  z.infer<typeof ListDatabasesResponseSchema>
> {
  return {
    method: 'GET',
    template: '/databases',
    params: {},
    query: {},
    response: ListDatabasesResponseSchema,
  };
}

export function getDatabaseRequest(
  databaseId: string
): ApiRequest<DatabaseDetail> {
  return {
    method: 'GET',
    template: '/databases/{id}',
    params: { id: checkId('database id', databaseId) },
    query: {},
    response: DatabaseDetailSchema,
  };
}

// --- SQL.

export const SqlCellSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string() }),
  z.object({ type: z.literal('number'), value: z.number() }),
  z.object({ type: z.literal('bool'), value: z.boolean() }),
  z.object({ type: z.literal('date'), value: z.string() }),
  z.object({
    type: z.literal('dateRange'),
    value: z.object({ start: z.string(), end: z.string() }),
  }),
  z.object({ type: z.literal('options'), value: z.array(z.string()) }),
  z.object({ type: z.literal('entities'), value: z.array(z.string()) }),
  z.object({ type: z.literal('row'), value: z.string() }),
]);
export type SqlCell = z.infer<typeof SqlCellSchema>;

export const ResultSetSchema = z.object({
  columns: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      options: z
        .array(z.object({ id: z.string(), label: z.string() }))
        .optional(),
    })
  ),
  rowIds: z.array(z.string()),
  rows: z.array(z.array(SqlCellSchema.nullable())),
});
export type ResultSet = z.infer<typeof ResultSetSchema>;

const VersionMap = z.record(z.string(), z.number().int());

export const SqlOutcomeSchema = z.object({
  changesApplied: z.number().int().nonnegative(),
  insertedRowIds: z.array(z.string()),
  newVersions: VersionMap,
  readVersions: VersionMap,
  truncatedTables: z.array(z.string()),
  result: ResultSetSchema.nullable().optional(),
  statement: z.object({ kind: z.string() }),
});
export type SqlOutcome = z.infer<typeof SqlOutcomeSchema>;

export interface QueryBody {
  readonly sql: string;
  readonly databaseId: string;
  readonly baseVersions?: Readonly<Record<string, number>> | undefined;
}

/** `POST /databases/query`: one statement, always with its database. */
export function queryRequest(body: QueryBody): ApiRequest<SqlOutcome> {
  const value: Record<string, unknown> = {
    sql: body.sql,
    databaseId: checkId('databaseId', body.databaseId),
  };
  if (body.baseVersions !== undefined) {
    for (const table of Object.keys(body.baseVersions))
      checkId('baseVersions table', table);
    value.baseVersions = body.baseVersions;
  }
  return {
    method: 'POST',
    template: '/databases/query',
    params: {},
    query: {},
    body: { kind: 'json', value },
    response: SqlOutcomeSchema,
  };
}

// --- Ops (saved views).

export type LaneKey =
  | { readonly kind: 'option'; readonly id: string }
  | { readonly kind: 'none' };

export type FilterTest = {
  readonly kind: 'options';
  readonly operator: 'isAnyOf' | 'isNoneOf';
  readonly options: readonly string[];
};

export interface ViewQuery {
  readonly filter: {
    readonly conjunction: 'and' | 'or';
    readonly conditions: readonly {
      readonly kind: 'condition';
      readonly column: string;
      readonly test: FilterTest;
    }[];
  } | null;
  readonly sort: readonly {
    readonly column: string;
    readonly direction: 'ascending' | 'descending';
  }[];
}

export type RequestedLayout =
  | {
      readonly kind: 'table';
      readonly columns: readonly {
        readonly column: string;
        readonly width: number | null;
      }[];
    }
  | {
      readonly kind: 'board';
      readonly groupBy: string;
      readonly title?: string;
      readonly lanes: readonly {
        readonly key: LaneKey;
        readonly hidden?: boolean;
      }[];
      readonly cardFields: readonly string[];
      readonly hideEmptyLanes: boolean;
    }
  | {
      readonly kind: 'timeline';
      readonly range: string;
      readonly title?: string;
      readonly groupBy: string | null;
      readonly colorBy: string | null;
      readonly barFields?: readonly string[];
    };

export interface NewView {
  readonly name: string;
  readonly query: ViewQuery;
  readonly layout: RequestedLayout;
}

/** The one op kind the service sends: create a saved view. */
export interface CreateViewOp {
  readonly kind: 'view';
  readonly table: string;
  readonly view: string;
  readonly change: { readonly kind: 'create'; readonly view: NewView };
}

export const ApplyOpsResponseSchema = z.object({
  results: z.array(
    z.object({
      kind: z.string(),
      view: z.string().optional(),
      tableVersion: z.number().int().optional(),
      change: z.object({ kind: z.string() }),
    })
  ),
  changes: z.array(z.unknown()),
});
export type ApplyOpsResponse = z.infer<typeof ApplyOpsResponseSchema>;

export function applyOpsRequest(
  databaseId: string,
  ops: readonly CreateViewOp[]
): ApiRequest<ApplyOpsResponse> {
  for (const op of ops) {
    checkId('op table', op.table);
    checkId('op view', op.view);
  }
  return {
    method: 'POST',
    template: '/databases/{id}/ops',
    params: { id: checkId('database id', databaseId) },
    query: {},
    body: { kind: 'json', value: { ops } },
    response: ApplyOpsResponseSchema,
  };
}

// --- Changes and row history.

export const TableChangesSchema = z.object({
  version: z.number().int(),
  complete: z.boolean(),
  truncated: z.boolean(),
  rows: z.array(z.object({ row: z.string(), kind: z.string() })),
  columns: z.array(z.object({ column: z.string(), kind: z.string() })),
});
export type TableChanges = z.infer<typeof TableChangesSchema>;

export const HistoryCellSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string() }),
  z.object({ type: z.literal('number'), value: z.number() }),
  z.object({ type: z.literal('boolean'), value: z.boolean() }),
  z.object({ type: z.literal('date'), value: z.string() }),
  z.object({
    type: z.literal('date_range'),
    value: z.object({ start: z.string(), end: z.string() }),
  }),
  z.object({ type: z.literal('link'), value: z.array(z.string()) }),
  z.object({
    type: z.literal('options'),
    value: z.array(
      z.union([z.object({ id: z.string() }), z.object({ label: z.string() })])
    ),
  }),
  z.object({
    type: z.literal('entities'),
    value: z.array(z.object({ entityType: z.string(), entityId: z.string() })),
  }),
  z.object({ type: z.literal('rows'), value: z.array(z.string()) }),
  z.object({ type: z.literal('clear') }),
]);
export type HistoryCell = z.infer<typeof HistoryCellSchema>;

export const RowHistoryEntrySchema = z.object({
  change: z.number().int(),
  version: z.number().int(),
  actor: z.string().nullable(),
  actingBot: z.string().nullable(),
  at: z.string(),
  kind: z.string(),
  columns: z.array(z.string()),
  before: z.record(z.string(), HistoryCellSchema),
  after: z.record(z.string(), HistoryCellSchema),
});
export type RowHistoryEntry = z.infer<typeof RowHistoryEntrySchema>;

export const RowHistoryResponseSchema = z.object({
  changes: z.array(RowHistoryEntrySchema),
});

export function tableChangesRequest(
  databaseId: string,
  tableId: string,
  since: number
): ApiRequest<TableChanges> {
  if (!Number.isSafeInteger(since) || since < 0) {
    throw new SupaMacError(
      'request',
      'since',
      'since must be a whole table version'
    );
  }
  return {
    method: 'GET',
    template: '/databases/{id}/tables/{table_id}/changes',
    params: {
      id: checkId('database id', databaseId),
      table_id: checkId('table id', tableId),
    },
    query: { since: String(since) },
    response: TableChangesSchema,
  };
}

export function rowHistoryRequest(
  databaseId: string,
  tableId: string,
  rowId: string
): ApiRequest<z.infer<typeof RowHistoryResponseSchema>> {
  return {
    method: 'GET',
    template: '/databases/{id}/tables/{table_id}/rows/{row_id}/history',
    params: {
      id: checkId('database id', databaseId),
      table_id: checkId('table id', tableId),
      row_id: checkId('row id', rowId),
    },
    query: {},
    response: RowHistoryResponseSchema,
  };
}
