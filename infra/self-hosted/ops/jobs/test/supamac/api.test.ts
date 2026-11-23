import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  applyOpsRequest,
  createDatabaseRequest,
  createProjectRequest,
  directAccessRequest,
  exportDocumentRequest,
  getDatabaseRequest,
  getDocumentRequest,
  getProjectRequest,
  listDatabasesRequest,
  listProjectsRequest,
  moveDocumentRequest,
  projectContentRequest,
  queryRequest,
  RowHistoryResponseSchema,
  rowHistoryRequest,
  SqlOutcomeSchema,
  setDirectAccessRequest,
  TableChangesSchema,
  tableChangesRequest,
  uploadFileRequest,
  userIdForEmail,
} from '../../src/supamac/api';
import {
  type ApiRequest,
  SupaMacClient,
  SupaMacError,
} from '../../src/supamac/client';
import {
  documentInfo,
  downloadDocument,
  listFolderDocuments,
  moveDocument,
  uploadFile,
  uploadMarkdown,
} from '../../src/supamac/documents';
import { ensureJobsSchema, type JobsPins } from '../../src/supamac/schema';
import {
  execute,
  insertRows,
  selectRows,
  updateRow,
} from '../../src/supamac/sql';
import { BASE, FakeDss, OWNER_EMAIL } from './fake-dss';
import {
  checkRequest,
  checkResponse,
  documentedStatuses,
  SPEC_PATH,
} from './spec';

const DB = '0190d5a8-0000-7000-8000-00000000000a';
const TABLE = '0190d5a8-0000-7000-8000-00000000000b';
const ROW = '0190d5a8-0000-7000-8000-00000000000c';
const DOC = '0190d5a8-0000-7000-8000-00000000000d';
const PROJECT = '0190d5a8-0000-7000-8000-00000000000e';
const VIEW = '0190d5a8-0000-7000-8000-00000000000f';
const KEY = ['mak', 'b2'.repeat(32)].join('_');

/** A client that records every request it is given before sending it. */
class RecordingClient extends SupaMacClient {
  readonly requests: ApiRequest<unknown>[] = [];
  override async send<T>(request: ApiRequest<T>): Promise<T> {
    this.requests.push(request as ApiRequest<unknown>);
    return super.send(request);
  }
}

test('the spec is the repository copy', () => {
  expect(existsSync(SPEC_PATH)).toBe(true);
});

describe('every request builder fits its route in the spec', () => {
  const builders: [string, ApiRequest<unknown>][] = [
    [
      'upload',
      uploadFileRequest('Call sheet.pdf', new Uint8Array([1]), PROJECT),
    ],
    [
      'upload at the top level',
      uploadFileRequest('Call sheet.pdf', new Uint8Array([1])),
    ],
    ['get document', getDocumentRequest(DOC)],
    ['move document', moveDocumentRequest(DOC, PROJECT)],
    ['export document', exportDocumentRequest(DOC)],
    ['list folders', listProjectsRequest()],
    ['get folder', getProjectRequest(PROJECT)],
    ['folder content', projectContentRequest(PROJECT)],
    ['create folder', createProjectRequest('Job intake')],
    ['direct access of a database', directAccessRequest('database', DB)],
    ['direct access of a folder', directAccessRequest('project', PROJECT)],
    [
      'share a database',
      setDirectAccessRequest(
        'database',
        DB,
        'macro|sam.price@example.com',
        'edit'
      ),
    ],
    [
      'share a folder',
      setDirectAccessRequest(
        'project',
        PROJECT,
        'macro|sam.price@example.com',
        'edit'
      ),
    ],
    ['create database', createDatabaseRequest('Jobs', 'Jobs')],
    ['list databases', listDatabasesRequest()],
    ['get database', getDatabaseRequest(DB)],
    [
      'query',
      queryRequest({ sql: 'SELECT "Name" FROM "Jobs"', databaseId: DB }),
    ],
    [
      'guarded query',
      queryRequest({
        sql: 'UPDATE "Jobs" SET "Name" = \'x\' WHERE row_id = \'r\'',
        databaseId: DB,
        baseVersions: { [TABLE]: 7 },
      }),
    ],
    [
      'save a view',
      applyOpsRequest(DB, [
        {
          kind: 'view',
          table: TABLE,
          view: VIEW,
          change: {
            kind: 'create',
            view: {
              name: 'Needs review',
              query: {
                filter: {
                  conjunction: 'and',
                  conditions: [
                    {
                      kind: 'condition',
                      column: ROW,
                      test: {
                        kind: 'options',
                        operator: 'isAnyOf',
                        options: [DOC],
                      },
                    },
                  ],
                },
                sort: [{ column: ROW, direction: 'descending' }],
              },
              layout: { kind: 'table', columns: [] },
            },
          },
        },
      ]),
    ],
    ['table changes', tableChangesRequest(DB, TABLE, 41)],
    ['row history', rowHistoryRequest(DB, TABLE, ROW)],
  ];
  for (const [name, request] of builders) {
    test(name, () => {
      expect(checkRequest(request)).toEqual([]);
    });
  }

  test('the checker itself catches a wrong body, query and path', () => {
    expect(
      checkRequest({
        ...createDatabaseRequest('Jobs', 'Jobs'),
        body: { kind: 'json', value: { title: 1 } },
      })
    ).not.toEqual([]);
    expect(
      checkRequest({ ...tableChangesRequest(DB, TABLE, 1), query: {} })
    ).toContain('required query since is missing');
    expect(
      checkRequest({
        ...getDatabaseRequest(DB),
        template: '/databases/{database}',
      }).length
    ).toBeGreaterThan(0);
    expect(
      checkRequest({ ...getDatabaseRequest(DB), params: { id: 'not-a-uuid' } })
    ).not.toEqual([]);
  });

  test('a path id must be a UUID before a request is built', () => {
    expect(() => getDatabaseRequest('../projects')).toThrow(SupaMacError);
    expect(() => rowHistoryRequest(DB, TABLE, "x' OR '1")).toThrow(
      'must be a UUID'
    );
    expect(() => moveDocumentRequest(DOC, 'Job sources')).toThrow(
      'must be a UUID'
    );
    expect(() => queryRequest({ sql: 'SELECT 1', databaseId: 'Jobs' })).toThrow(
      'must be a UUID'
    );
    expect(() => tableChangesRequest(DB, TABLE, -1)).toThrow(
      'whole table version'
    );
    expect(() =>
      setDirectAccessRequest('database', DB, 'sam.price@example.com', 'edit')
    ).toThrow('macro|');
  });

  test('an owner email becomes the user id grants name', () => {
    expect(userIdForEmail(' Sam.Price@Example.com ')).toBe(
      'macro|sam.price@example.com'
    );
    expect(() => userIdForEmail('sam price')).toThrow(SupaMacError);
    expect(() => userIdForEmail('a|b@example.com')).toThrow(SupaMacError);
  });
});

describe('the requests the service makes, end to end, fit the spec', () => {
  test('setup, documents and SQL', async () => {
    const dss = new FakeDss();
    const client = new RecordingClient({
      apiKey: KEY,
      baseUrl: BASE,
      fetch: dss.fetch,
    });
    let pins: JobsPins | undefined;
    const result = await ensureJobsSchema({
      client,
      pins,
      ownerEmail: OWNER_EMAIL,
      save: async (p) => {
        pins = p;
      },
    });
    const uploaded = await uploadFile(client, {
      fileName: 'Acme Productions call sheet.pdf',
      bytes: new Uint8Array([37, 80, 68, 70]),
      folderId: result.schema.folders.sources,
    });
    await uploadMarkdown(client, {
      name: 'Acme Productions call sheet.pdf · text',
      markdown: '# Call sheet\n\nCrew call 07:00',
      folderId: result.schema.folders.sources,
    });
    const intakeDoc = dss.addDocument(
      'Example Hotel confirmation',
      'pdf',
      result.schema.folders.intake,
      'macro|sam.price@example.com'
    );
    await listFolderDocuments(client, result.schema.folders.intake, {
      readiness: true,
    });
    await documentInfo(client, uploaded.documentId);
    await moveDocument(client, intakeDoc.id, result.schema.folders.sources);
    await downloadDocument(client, intakeDoc.id);

    const statements = [
      ...insertRows(result.schema, 'sources', [
        {
          Name: 'Call sheet',
          Via: 'Email',
          Status: 'Processing',
          Hash: 'ab12',
          Attempts: 0,
          Received: '2027-03-01T09:00:00Z',
        },
      ]),
      updateRow(result.schema, 'sources', ROW, { Status: 'Processed' }),
      selectRows(result.schema, 'details', ['Name', 'Status'], {
        where: { op: 'has', column: 'Job', value: ROW },
      }),
    ];
    for (const statement of statements) {
      // The fake runs schema statements only; the request is what is checked.
      await execute(client, statement).catch((error: unknown) => {
        if (!(error instanceof SupaMacError) || error.kind !== 'invalid')
          throw error;
      });
    }

    expect(pins).toBeDefined();
    const routes = new Set(
      client.requests.map((r) => `${r.method} ${r.template}`)
    );
    expect([...routes].sort()).toEqual([
      'GET /databases',
      'GET /databases/{id}',
      'GET /documents/{document_id}',
      'GET /documents/{document_id}/export',
      'GET /entities/{entity_type}/{entity_id}/direct-access',
      'GET /projects',
      'GET /projects/{id}/content',
      'PATCH /documents/{document_id}',
      'POST /databases',
      'POST /databases/query',
      'POST /databases/{id}/ops',
      'POST /documents/upload',
      'POST /projects',
      'PUT /entities/{entity_type}/{entity_id}/direct-access/{user_id}',
    ]);
    for (const request of client.requests) {
      expect({
        route: `${request.method} ${request.template}`,
        errors: checkRequest(request),
      }).toEqual({
        route: `${request.method} ${request.template}`,
        errors: [],
      });
    }
  });
});

describe('the fake answers as the spec says, and the schemas read the spec', () => {
  test('every answer of a full setup fits its documented answer', async () => {
    const dss = new FakeDss();
    const answers: {
      method: string;
      template: string;
      status: number;
      body: unknown;
    }[] = [];
    const client = new RecordingClient({
      apiKey: KEY,
      baseUrl: BASE,
      fetch: async (url, init) => {
        const response = await dss.fetch(url, init);
        const copy = response.clone();
        const text = await copy.text();
        const last = client.requests.at(-1);
        if (last !== undefined) {
          answers.push({
            method: last.method,
            template: last.template,
            status: response.status,
            body: text === '' ? null : JSON.parse(text),
          });
        }
        return response;
      },
    });
    const result = await ensureJobsSchema({
      client,
      pins: undefined,
      ownerEmail: OWNER_EMAIL,
      save: async () => {},
    });
    await uploadFile(client, {
      fileName: 'PO 4500123.pdf',
      bytes: new Uint8Array([1]),
      folderId: result.schema.folders.sources,
    });
    await listFolderDocuments(client, result.schema.folders.sources, {
      readiness: true,
    });
    await client.send(getProjectRequest(result.schema.folders.intake));
    expect(answers.length).toBeGreaterThan(10);
    for (const answer of answers) {
      expect(documentedStatuses(answer.method, answer.template)).toContain(
        answer.status
      );
      expect({
        route: `${answer.method} ${answer.template}`,
        errors: checkResponse(
          answer.method,
          answer.template,
          answer.status,
          answer.body
        ),
      }).toEqual({
        route: `${answer.method} ${answer.template}`,
        errors: [],
      });
    }
  });

  test('a SELECT outcome as the spec shapes it', () => {
    const outcome = {
      tableDatabases: { [TABLE]: DB },
      changesApplied: 0,
      insertedRowIds: [],
      newVersions: {},
      readVersions: { [TABLE]: 12 },
      truncatedTables: [],
      result: {
        columns: [
          { name: 'Name', kind: 'text' },
          {
            name: 'Status',
            kind: 'select',
            options: [{ id: VIEW, label: 'Found' }],
          },
          { name: 'Day', kind: 'date' },
          {
            name: 'Job',
            kind: 'entity',
            relatedTable: TABLE,
            target: 'DATABASE_ROW',
          },
          { name: 'Dates', kind: 'dateRange' },
          { name: 'Page', kind: 'number' },
        ],
        rowIds: [ROW],
        rows: [
          [
            { type: 'text', value: 'Call time: 07:00' },
            { type: 'options', value: [VIEW] },
            { type: 'date', value: '2027-03-13T00:00:00Z' },
            { type: 'entities', value: [ROW] },
            {
              type: 'dateRange',
              value: {
                start: '2027-03-13T00:00:00Z',
                end: '2027-03-15T00:00:00Z',
              },
            },
            null,
          ],
        ],
        sourceTable: TABLE,
      },
      statement: { kind: 'select' },
    };
    expect(checkResponse('POST', '/databases/query', 200, outcome)).toEqual([]);
    expect(SqlOutcomeSchema.parse(outcome).result?.rows[0]?.[1]).toEqual({
      type: 'options',
      value: [VIEW],
    });
    const insert = {
      ...outcome,
      result: null,
      insertedRowIds: [ROW],
      newVersions: { [TABLE]: 13 },
      changesApplied: 1,
      statement: { kind: 'insert', tableId: TABLE, tableName: 'Details' },
    };
    expect(checkResponse('POST', '/databases/query', 200, insert)).toEqual([]);
    expect(SqlOutcomeSchema.parse(insert).newVersions).toEqual({ [TABLE]: 13 });
  });

  test('table changes and row history as the spec shapes them', () => {
    const changes = {
      version: 44,
      complete: true,
      truncated: false,
      rows: [{ row: ROW, kind: 'update' }],
      columns: [{ column: VIEW, kind: 'rename' }],
    };
    expect(
      checkResponse(
        'GET',
        '/databases/{id}/tables/{table_id}/changes',
        200,
        changes
      )
    ).toEqual([]);
    expect(TableChangesSchema.parse(changes)).toEqual(changes);
    const history = {
      changes: [
        {
          change: 901,
          version: 44,
          actor: 'macro|sam.price@example.com',
          actingBot: null,
          at: '2027-03-13T07:30:00Z',
          kind: 'update',
          columns: [VIEW, DOC],
          before: {
            [VIEW]: { type: 'options', value: [{ id: PROJECT }] },
            [DOC]: { type: 'text', value: '07:00' },
          },
          after: {
            [VIEW]: { type: 'options', value: [{ label: 'Confirmed' }] },
          },
        },
        {
          change: 880,
          version: 40,
          actor: null,
          actingBot: 'bot|0190d5a8-0000-7000-8000-000000000123',
          at: '2027-03-12T07:30:00Z',
          kind: 'insert',
          columns: [DOC],
          before: {},
          after: {
            [DOC]: {
              type: 'date_range',
              value: {
                start: '2027-03-13T00:00:00Z',
                end: '2027-03-13T00:00:00Z',
              },
            },
            [ROW]: { type: 'rows', value: [ROW] },
            [TABLE]: {
              type: 'entities',
              value: [{ entityType: 'DOCUMENT', entityId: DOC }],
            },
          },
        },
      ],
    };
    expect(
      checkResponse(
        'GET',
        '/databases/{id}/tables/{table_id}/rows/{row_id}/history',
        200,
        history
      )
    ).toEqual([]);
    expect(RowHistoryResponseSchema.parse(history).changes).toHaveLength(2);
  });
});
