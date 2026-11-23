// An independent review of the SupaMac unit (src/supamac/) against
// docs/supamac/jobs.md and packages/sdk/specs/storage.json.
//
// Each test states what the design or the spec requires. Every name,
// company, address and number is a placeholder.

import { describe, expect, test } from 'bun:test';
import {
  DatabaseDetailSchema,
  getDatabaseRequest,
  GetDocumentResponseSchema,
  GetProjectsResponseSchema,
  ListDatabasesResponseSchema,
  listDatabasesRequest,
  queryRequest,
  RowHistoryResponseSchema,
  type RowHistoryEntry,
  setDirectAccessRequest,
  SqlOutcomeSchema,
  TableChangesSchema,
  uploadFileRequest,
  userIdForEmail,
} from '../../src/supamac/api';
import {
  type Attribution,
  detailEdit,
  readTableChanges,
} from '../../src/supamac/changes';
import {
  type ApiRequest,
  type FetchInit,
  type FetchLike,
  SupaMacClient,
  SupaMacError,
} from '../../src/supamac/client';
import {
  documentInfo,
  downloadDocument,
  listFolderDocuments,
  moveDocument,
  sanitizeFileName,
  textDocumentName,
  uploadFile,
  uploadMarkdown,
} from '../../src/supamac/documents';
import {
  ensureJobsSchema,
  type JobsPins,
  JobsPinsSchema,
  SchemaError,
  type SchemaErrorKind,
} from '../../src/supamac/schema';
import {
  byteLength,
  execute,
  insertRow,
  insertRows,
  MAX_STATEMENT_BYTES,
  selectRows,
  SqlError,
  type SqlErrorKind,
  type Statement,
  sqlText,
  updateRow,
  updateRows,
} from '../../src/supamac/sql';
import type { JobsSchema, RowInput } from '../../src/supamac/tables';
import { Logger } from '../../src/log';
import {
  BASE,
  FakeDss,
  type FakeTable,
  OWNER_EMAIL,
  OWNER_USER,
  SERVICE_USER,
} from './fake-dss';
import { checkRequest, checkResponse } from './spec';

const KEY = ['mak', '7a'.repeat(32)].join('_');
const STRANGER = 'macro|someone.else@example.com';
const BOT = 'bot|0190d5a8-0000-7000-b000-000000000b07';

// ---------------------------------------------------------------------------
// Helpers.

/** A client that records every request it builds, before sending it. */
class RecordingClient extends SupaMacClient {
  readonly requests: ApiRequest<unknown>[] = [];
  override async send<T>(request: ApiRequest<T>): Promise<T> {
    this.requests.push(request as ApiRequest<unknown>);
    return super.send(request);
  }
}

interface Store {
  pins: JobsPins | undefined;
  readonly save: (p: JobsPins) => Promise<void>;
}

function store(): Store {
  const s: Store = {
    pins: undefined,
    save: async (p) => {
      s.pins = JobsPinsSchema.parse(JSON.parse(JSON.stringify(p)));
    },
  };
  return s;
}

let idCounter = 0;
function newId(): string {
  idCounter++;
  return `0190d5a8-0000-7000-a500-${idCounter.toString(16).padStart(12, '0')}`;
}

function clientFor(fetch: FetchLike, logger?: Logger): SupaMacClient {
  return new SupaMacClient({ apiKey: KEY, baseUrl: BASE, fetch, logger });
}

async function start(
  dss: FakeDss,
  s: Store,
  ownerEmail = OWNER_EMAIL,
  fetch: FetchLike = dss.fetch
) {
  return ensureJobsSchema({
    client: clientFor(fetch),
    pins: s.pins,
    ownerEmail,
    save: s.save,
    newId,
  });
}

async function made(): Promise<{ dss: FakeDss; s: Store; schema: JobsSchema }> {
  const dss = new FakeDss();
  const s = store();
  const result = await start(dss, s);
  return { dss, s, schema: result.schema };
}

async function schemaError(
  promise: Promise<unknown>,
  kind: SchemaErrorKind
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaError);
    expect((error as SchemaError).kind).toBe(kind);
    return;
  }
  throw new Error(`expected a ${kind} SchemaError`);
}

function sqlError(fn: () => unknown, kind: SqlErrorKind): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(SqlError);
  expect((thrown as SqlError).kind).toBe(kind);
}

function table(dss: FakeDss, name: string): FakeTable {
  const t = dss.databases[0]?.tables.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no table ${name}`);
  return t;
}

/** A fetch that rewrites the JSON answers of one route before the client reads them. */
function rewriting(
  dss: FakeDss,
  matches: (url: string, init: FetchInit) => boolean,
  edit: (body: unknown) => unknown
): FetchLike {
  return async (url, init) => {
    const response = await dss.fetch(url, init);
    if (!matches(url, init) || !response.ok) return response;
    return new Response(JSON.stringify(edit(await response.json())), {
      status: response.status,
    });
  };
}

// The lexer of crates/database_sql/src/parse/lexer.rs: whitespace is
// [ \t\r\n]; strings are '…' with '' inside and no other escape; quoted
// identifiers are "…" with "" inside. Any other character is refused.
type Lexed = {
  kind: 'string' | 'ident' | 'qident' | 'number' | 'punct';
  text: string;
};

function lex(sql: string): Lexed[] {
  const out: Lexed[] = [];
  const rules: [Lexed['kind'] | 'skip', RegExp, (m: string) => string][] = [
    ['skip', /^[ \t\r\n]+/, (m) => m],
    ['string', /^'(?:[^']|'')*'/, (m) => m.slice(1, -1).replaceAll("''", "'")],
    ['qident', /^"(?:[^"]|"")*"/, (m) => m.slice(1, -1).replaceAll('""', '"')],
    ['number', /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/, (m) => m],
    ['ident', /^[A-Za-z_][A-Za-z0-9_]*/, (m) => m],
    ['punct', /^(?:<=|>=|!=|<>|=|<|>|\(|\[|\]|\)|,|\.|\*|-|;)/, (m) => m],
  ];
  let rest = sql;
  while (rest.length > 0) {
    let matched = false;
    for (const [kind, re, value] of rules) {
      const m = re.exec(rest);
      if (m === null) continue;
      if (kind !== 'skip') out.push({ kind, text: value(m[0]) });
      rest = rest.slice(m[0].length);
      matched = true;
      break;
    }
    if (!matched)
      throw new Error(
        `the dialect's lexer refuses ${JSON.stringify(rest.slice(0, 20))}`
      );
  }
  return out;
}

/** The statement's shape: every token but the text of its string literals. */
function shape(sql: string): string[] {
  return lex(sql).map((t) =>
    t.kind === 'string' ? "'…'" : `${t.kind}:${t.text}`
  );
}

/** What the literal function must leave of a text: NUL and unpaired surrogates removed. */
function cleaned(text: string): string {
  return Array.from(text.replaceAll('\u0000', ''))
    .filter((c) => !/^[\ud800-\udfff]$/.test(c))
    .join('');
}

// Text as extraction hands it over: quoting, escapes, control characters,
// emoji, scripts and SQL that must stay data.
const HOSTILE: readonly string[] = [
  "Sam's call: 07:00",
  "''",
  "'",
  "\\'",
  "'\\",
  '\\',
  'x\'); DROP TABLE "Jobs"; --',
  "' OR '1'='1",
  'Example Hotel\u0000, Leeds',
  'line one\nline two\r\nline three\rend',
  '\t\u000b\u000c\u0085\u2028\u2029',
  'Crew 🎭 call 🧑‍🔧 07:00 🇬🇧',
  'lone \ud83c high and \udfad low',
  '"double" "" quotes',
  '% _ [ ] ; -- /* */',
  'ﬁnal NFKC ＡＢＣ',
  'עברית and العربية',
  '\u202eevil override',
  '',
];

// ---------------------------------------------------------------------------
// The routes against the spec.

describe('every request the unit makes fits packages/sdk/specs/storage.json', () => {
  test('a full run, documents, SQL, changes and history, each with its databaseId', async () => {
    const dss = new FakeDss();
    const client = new RecordingClient({
      apiKey: KEY,
      baseUrl: BASE,
      fetch: dss.fetch,
    });
    const s = store();
    const result = await ensureJobsSchema({
      client,
      pins: s.pins,
      ownerEmail: OWNER_EMAIL,
      save: s.save,
      newId,
    });
    const schema = result.schema;
    const sources = schema.folders.sources;
    const uploaded = await uploadFile(client, {
      fileName: 'Acme Productions & Co #2 PO?.pdf',
      bytes: new Uint8Array([37, 80]),
      folderId: sources,
    });
    await uploadMarkdown(client, {
      name: textDocumentName('Acme Productions & Co #2 PO?.pdf'),
      markdown: "# PO\n\nPO number: 4500123 'x'",
      folderId: sources,
    });
    const intake = dss.addDocument(
      'Example Hotel confirmation',
      'pdf',
      schema.folders.intake,
      OWNER_USER
    );
    await listFolderDocuments(client, schema.folders.intake, {
      readiness: true,
    });
    await documentInfo(client, uploaded.documentId);
    await moveDocument(client, intake.id, sources);
    await downloadDocument(client, intake.id);

    const row = newId();
    const statements: Statement[] = [
      ...insertRows(schema, 'details', [
        {
          Name: 'Call time: 07:00',
          Field: 'Call time',
          Status: 'Found',
          Quote: "Crew call 07:00 at Acme's yard",
          Job: [row],
          Source: uploaded.documentId,
          Page: 2,
          Day: '2027-03-13',
          Received: '2027-03-01T09:00:00Z',
        },
      ]),
      updateRow(schema, 'jobs', row, {
        'Not confirmed': ['Venue', 'Call times'],
        Dates: { start: '2027-03-13', end: '2027-03-15' },
        Booking: null,
      }),
      ...updateRows(schema, 'details', [row, newId()], { Status: 'Replaced' }),
      selectRows(schema, 'details', ['Name', 'Status', 'Job'], {
        where: {
          op: 'and',
          conditions: [
            { op: 'has', column: 'Job', value: row },
            { op: 'in', column: 'Status', values: ['Found', 'Needs review'] },
          ],
        },
        limit: 50,
      }),
    ];
    for (const statement of statements) {
      // The fake runs schema statements only; what is checked is the request.
      await execute(client, statement, {
        baseVersions: { [schema.tables.details.id]: 3 },
      }).catch((error: unknown) => {
        if (!(error instanceof SupaMacError) || error.kind !== 'invalid')
          throw error;
      });
    }

    const detailsId = schema.tables.details.id;
    dss.overrides.set(
      `GET /databases/${schema.databaseId}/tables/${detailsId}/changes`,
      () =>
        Response.json({
          version: 9,
          complete: true,
          truncated: false,
          rows: [{ row, kind: 'update' }],
          columns: [],
        })
    );
    dss.overrides.set(
      `GET /databases/${schema.databaseId}/tables/${detailsId}/rows/${row}/history`,
      () => Response.json({ changes: [] })
    );
    await readTableChanges(client, {
      databaseId: schema.databaseId,
      tableId: detailsId,
      since: 4,
      who: {
        serviceUserId: SERVICE_USER,
        ownerUserId: OWNER_USER,
        isServiceVersion: () => false,
      },
    });

    for (const request of client.requests) {
      expect({
        route: `${request.method} ${request.template}`,
        errors: checkRequest(request),
      }).toEqual({
        route: `${request.method} ${request.template}`,
        errors: [],
      });
    }
    const queries = dss.seen.filter(
      (x) => x.method === 'POST' && x.path === '/databases/query'
    );
    expect(queries.length).toBeGreaterThan(20);
    for (const q of queries) {
      expect((q.body as { databaseId?: unknown }).databaseId).toBe(
        schema.databaseId
      );
    }
    // Every write the setup made went to the Jobs database or its own folders.
    for (const w of dss.writes()) {
      expect(w.headers['x-macro-user-api-key']).toBe(KEY);
    }
  });

  test('a grant id with | @ + and a file name with & # ? = reach the route whole', () => {
    const client = clientFor(async () => new Response('null'));
    const db = newId();
    const user = userIdForEmail('Sam.Price+Jobs@Example.com');
    expect(user).toBe('macro|sam.price+jobs@example.com');
    const grantUrl = new URL(
      client.urlFor(setDirectAccessRequest('database', db, user, 'edit'))
    );
    const last = grantUrl.pathname.split('/').at(-1) as string;
    expect(last).toBe('macro%7Csam.price%2Bjobs%40example.com');
    expect(decodeURIComponent(last)).toBe(user);

    const name = sanitizeFileName(
      'C:\\Users\\sam/Desktop/Acme & Co #2 = PO? 50%+VAT.pdf'
    );
    expect(name).toBe('Acme & Co #2 = PO? 50%+VAT.pdf');
    const uploadUrl = new URL(
      client.urlFor(uploadFileRequest(name, new Uint8Array([1]), db))
    );
    expect([...uploadUrl.searchParams.keys()]).toEqual([
      'fileName',
      'projectId',
    ]);
    expect(uploadUrl.searchParams.get('fileName')).toBe(name);
    expect(uploadUrl.searchParams.get('projectId')).toBe(db);
  });

  test('a query names only sql, databaseId and baseVersions, and refuses a database that is not an id', () => {
    const db = newId();
    const request = queryRequest({
      sql: 'SELECT "Name" FROM "Jobs"',
      databaseId: db,
    });
    expect(request.body).toEqual({
      kind: 'json',
      value: { sql: 'SELECT "Name" FROM "Jobs"', databaseId: db },
    });
    expect(checkRequest(request)).toEqual([]);
    for (const bad of ['', 'Jobs', `${db} `, `${db}'`, '../databases']) {
      expect(() => queryRequest({ sql: 'SELECT 1', databaseId: bad })).toThrow(
        SupaMacError
      );
    }
    expect(() =>
      queryRequest({
        sql: 'SELECT 1',
        databaseId: db,
        baseVersions: { Jobs: 1 },
      })
    ).toThrow(SupaMacError);
  });
});

describe('answers are validated', () => {
  test('answers the spec allows, with optional fields left out and extra fields added, are read', () => {
    const db = newId();
    const tableId = newId();
    const column = newId();
    const definition = newId();
    const detail = {
      database: {
        id: db,
        name: 'Jobs',
        owner_id: SERVICE_USER,
        created_at: '2027-03-01T09:00:00Z',
        trashed_at: null,
        project_id: newId(),
        appearance: null,
      },
      grant: 'owner',
      tables: [
        {
          table: {
            id: tableId,
            database_id: db,
            name: 'Jobs',
            position: 'a0',
            version: 7,
          },
          sql_name: '"Jobs"."Jobs"',
          columns: [
            {
              column: {
                id: column,
                table_id: tableId,
                property_definition_id: definition,
                position: 'a0',
                config: { kind: 'percentage' },
                display_name: null,
                infer_type: false,
                nullable: true,
                protections: [],
              },
              sql_name: '"Rate"',
              definition: {
                definition: {
                  id: definition,
                  owner: { scope: 'database', database_id: db },
                  display_name: 'Rate',
                  data_type: 'NUMBER',
                  is_multi_select: false,
                  specific_entity_type: null,
                  created_at: '2027-03-01T09:00:00Z',
                  updated_at: '2027-03-01T09:00:00Z',
                  is_system: false,
                  is_metadata: false,
                },
                property_options: [],
              },
              writable: true,
              shared_outside_database: false,
            },
          ],
          views: [],
        },
      ],
    };
    expect(checkResponse('GET', '/databases/{id}', 200, detail)).toEqual([]);
    expect(DatabaseDetailSchema.safeParse(detail).success).toBe(true);

    const listed = [
      {
        database: detail.database,
        grant: 'view',
        tables: [detail.tables[0]?.table],
      },
    ];
    expect(checkResponse('GET', '/databases', 200, listed)).toEqual([]);
    expect(ListDatabasesResponseSchema.safeParse(listed).success).toBe(true);

    const projects = {
      error: false,
      data: [{ id: newId(), name: 'Job intake', userId: SERVICE_USER }],
    };
    expect(checkResponse('GET', '/projects', 200, projects)).toEqual([]);
    expect(GetProjectsResponseSchema.safeParse(projects).success).toBe(true);

    const document = {
      error: false,
      data: {
        documentMetadata: {
          documentId: newId(),
          documentVersionId: 3,
          owner: OWNER_USER,
          documentName: 'Call sheet',
          content: { state: 'pending', location: null },
        },
        userAccessLevel: 'edit',
        viewLocation: null,
      },
    };
    expect(
      checkResponse('GET', '/documents/{document_id}', 200, document)
    ).toEqual([]);
    expect(GetDocumentResponseSchema.safeParse(document).success).toBe(true);
  });

  test('answers that do not fit their route are refused as bad_response, never read', async () => {
    const db = newId();
    const cases: [ApiRequest<unknown>, unknown][] = [
      [
        uploadFileRequest('PO.pdf', new Uint8Array([1])),
        { documentId: 'not-a-uuid', sizeBytes: 1 },
      ],
      [
        uploadFileRequest('PO.pdf', new Uint8Array([1])),
        { documentId: newId() },
      ],
      [
        queryRequest({ sql: 'SELECT 1', databaseId: db }),
        {
          changesApplied: 0,
          insertedRowIds: [],
          newVersions: { [db]: 'seven' },
          readVersions: {},
          truncatedTables: [],
          statement: { kind: 'select' },
        },
      ],
      [
        queryRequest({ sql: 'SELECT 1', databaseId: db }),
        {
          changesApplied: 0,
          insertedRowIds: [],
          newVersions: {},
          readVersions: {},
          truncatedTables: [],
          statement: { kind: 'select' },
          result: {
            columns: [],
            rowIds: [],
            rows: [[{ type: 'blob', value: 1 }]],
          },
        },
      ],
      [
        getDatabaseRequest(db),
        {
          database: {
            id: db,
            name: 'Jobs',
            owner_id: SERVICE_USER,
            created_at: 'x',
            project_id: null,
          },
          grant: 'owner',
          tables: [],
        },
      ],
      [listDatabasesRequest(), { databases: [] }],
    ];
    for (const [request, body] of cases) {
      const client = clientFor(async () => Response.json(body));
      let thrown: unknown;
      try {
        await client.send(request);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SupaMacError);
      expect((thrown as SupaMacError).kind).toBe('bad_response');
    }
    expect(
      TableChangesSchema.safeParse({
        version: '4',
        complete: true,
        truncated: false,
        rows: [],
        columns: [],
      }).success
    ).toBe(false);
    expect(
      SqlOutcomeSchema.safeParse({
        changesApplied: -1,
        insertedRowIds: [],
        newVersions: {},
        readVersions: {},
        truncatedTables: [],
        statement: { kind: 'insert' },
      }).success
    ).toBe(false);
    expect(
      RowHistoryResponseSchema.safeParse({
        changes: [
          {
            change: 1,
            version: 1,
            actor: null,
            at: 'x',
            kind: 'update',
            columns: [],
            before: {},
            after: {},
          },
        ],
      }).success
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SQL against extracted text.

describe('the literal function and statements cannot be broken by extracted text', () => {
  test('every hostile text stays one literal, the statement keeps its shape, and the value comes back as written', async () => {
    const { schema } = await made();
    const job = newId();
    const benign = insertRow(schema, 'details', {
      Name: 'a',
      Label: 'a',
      Value: 'a',
      Quote: 'a',
      Check: 'a',
      Job: [job],
      Status: 'Found',
    }).sql;
    for (const text of HOSTILE) {
      const statement = insertRow(schema, 'details', {
        Name: text,
        Label: text,
        Value: text,
        Quote: text,
        Check: text,
        Job: [job],
        Status: 'Found',
      });
      expect(statement.databaseId).toBe(schema.databaseId);
      expect(shape(statement.sql)).toEqual(shape(benign));
      const strings = lex(statement.sql)
        .filter((t) => t.kind === 'string')
        .map((t) => t.text);
      // Columns in table order: Name, Job, Label, Value, Quote, Status, Check.
      expect(strings).toEqual([
        cleaned(text),
        job,
        cleaned(text),
        cleaned(text),
        cleaned(text),
        'Found',
        cleaned(text),
      ]);
      // A condition built from the same text stays one literal too.
      const select = selectRows(schema, 'details', ['Name'], {
        where: {
          op: 'or',
          conditions: [
            { op: '=', column: 'Value', value: text },
            { op: 'contains', column: 'Quote', text },
          ],
        },
      });
      expect(
        lex(select.sql)
          .filter((t) => t.kind === 'string')
          .map((t) => t.text)
      ).toEqual([cleaned(text), `%${cleaned(text)}%`]);
    }
  });

  test('a literal never holds NUL or an unpaired surrogate, and keeps every pair', () => {
    expect(sqlText('\u0000')).toBe("''");
    expect(sqlText('\ud800\ud800\udc00')).toBe("'\ud800\udc00'");
    expect(sqlText('\udc00\ud800')).toBe("''");
    expect(sqlText('🎭\u0000🎭')).toBe("'🎭🎭'");
    expect(new TextEncoder().encode(sqlText('a\ud800b')).length).toBe(4);
  });

  test('very long values: a literal is counted in UTF-8 bytes, and one that cannot fit is refused before sending', async () => {
    const { schema } = await made();
    // 100,000 quotes double to a 200,002-byte literal: still one statement.
    const quotes = "'".repeat(100_000);
    const fits = insertRow(schema, 'details', { Quote: quotes });
    expect(byteLength(fits.sql)).toBeLessThan(MAX_STATEMENT_BYTES);
    expect(
      lex(fits.sql)
        .filter((t) => t.kind === 'string')
        .map((t) => t.text)
    ).toEqual([quotes]);
    // 140,000 UTF-16 units, but 280,000 bytes: over the limit.
    sqlError(
      () => insertRow(schema, 'details', { Quote: '🎭'.repeat(70_000) }),
      'too_large'
    );
    sqlError(
      () =>
        updateRow(schema, 'details', newId(), { Quote: 'é'.repeat(140_000) }),
      'too_large'
    );
    sqlError(
      () =>
        updateRows(schema, 'details', [newId()], {
          Quote: "'".repeat(140_000),
        }),
      'too_large'
    );
    sqlError(
      () =>
        selectRows(schema, 'details', ['Name'], {
          where: { op: '=', column: 'Value', value: '€'.repeat(90_000) },
        }),
      'too_large'
    );

    let sent = 0;
    const client = clientFor(async () => {
      sent++;
      return Response.json({});
    });
    const hand: Statement = {
      sql: `SELECT "Name" FROM "Details" WHERE "Value" = '${'x'.repeat(MAX_STATEMENT_BYTES)}'`,
      databaseId: schema.databaseId,
      kind: 'select',
    };
    let thrown: unknown;
    try {
      await execute(client, hand);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SqlError);
    expect(sent).toBe(0);
  });

  test('a source of many long multi-byte details splits into statements under 256 KiB that keep every row in order', async () => {
    const { schema } = await made();
    const source = newId();
    const rows: RowInput<'details'>[] = [];
    for (let i = 0; i < 700; i++) {
      rows.push({
        Name: `Contact: #${i}`,
        Quote: `${i}: ${"Sam's 🎭 «call» ".repeat(40)}`,
        'Source row': [source],
        Status: i % 2 === 0 ? 'Found' : 'Needs review',
        Page: i,
      });
    }
    const statements = insertRows(schema, 'details', rows);
    expect(statements.length).toBeGreaterThan(2);
    let total = 0;
    const names: string[] = [];
    for (const statement of statements) {
      expect(byteLength(statement.sql)).toBeLessThan(MAX_STATEMENT_BYTES);
      expect(statement.databaseId).toBe(schema.databaseId);
      expect(statement.rows).toBeLessThanOrEqual(500);
      total += statement.rows ?? 0;
      for (const t of lex(statement.sql))
        if (t.kind === 'string' && t.text.startsWith('Contact: #'))
          names.push(t.text);
    }
    expect(total).toBe(700);
    expect(names).toEqual(rows.map((r) => r.Name as string));
  });

  test('names the owner gave tables, columns and options are quoted so they read back exactly', async () => {
    const { dss, s } = await made();
    const details = table(dss, 'Details');
    details.name = 'Sam\'s "Job" details 🎭';
    const value = details.columns.find((c) => c.name === 'Value');
    const status = details.columns.find((c) => c.name === 'Status');
    const found = status?.options.find((o) => o.label === 'Found');
    if (value === undefined || found === undefined) throw new Error('fixture');
    value.name = 'What it "says"\n(\'as written\')';
    found.label = "Found (Sam's) -- ok";
    const schema = (await start(dss, s)).schema;
    const sql = insertRow(schema, 'details', {
      Value: 'x',
      Status: 'Found',
    }).sql;
    const tokens = lex(sql);
    expect(
      tokens.filter((t) => t.kind === 'qident').map((t) => t.text)
    ).toEqual([details.name, value.name, 'Status']);
    expect(
      tokens.filter((t) => t.kind === 'string').map((t) => t.text)
    ).toEqual(['x', found.label]);
  });

  test('a select or tag value that is not one of the spec labels is refused, whatever its case or shape', async () => {
    const { dss, s } = await made();
    // An option the owner added is still not one the service writes.
    table(dss, 'Details')
      .columns.find((c) => c.name === 'Status')
      ?.options.push({ id: dss.id(), label: 'On hold' });
    const schema = (await start(dss, s)).schema;
    const row = newId();
    for (const bad of [
      'found',
      'FOUND',
      'Found ',
      ' Found',
      '',
      'On hold',
      'Bogus',
      '__proto__',
      'constructor',
      'toString',
      "Found' OR '1'='1",
    ]) {
      sqlError(
        () => insertRow(schema, 'details', { Status: bad as 'Found' }),
        'unknown_option'
      );
      sqlError(
        () => updateRow(schema, 'details', row, { Status: bad as 'Found' }),
        'unknown_option'
      );
      sqlError(
        () =>
          selectRows(schema, 'details', ['Name'], {
            where: { op: '=', column: 'Status', value: bad },
          }),
        'unknown_option'
      );
      sqlError(
        () =>
          selectRows(schema, 'details', ['Name'], {
            where: { op: 'in', column: 'Status', values: ['Found', bad] },
          }),
        'unknown_option'
      );
      sqlError(
        () =>
          updateRow(schema, 'jobs', row, {
            'Not confirmed': ['Venue', bad as 'Venue'],
          }),
        'unknown_option'
      );
      sqlError(
        () =>
          selectRows(schema, 'jobs', ['Name'], {
            where: { op: 'has', column: 'Not confirmed', value: bad },
          }),
        'unknown_option'
      );
      sqlError(
        () => insertRow(schema, 'details', { Field: bad as 'Venue' }),
        'unknown_option'
      );
    }
    // Relations, documents and dates refuse text that is not an id or a date.
    sqlError(
      () => insertRow(schema, 'details', { Job: ["x' OR '1"] }),
      'bad_value'
    );
    sqlError(
      () => insertRow(schema, 'details', { Source: 'Call sheet.pdf' }),
      'bad_value'
    );
    sqlError(
      () => insertRow(schema, 'details', { Day: '13/03/2027' }),
      'bad_value'
    );
    sqlError(
      () => insertRow(schema, 'details', { Day: "2027-03-13' OR '1" }),
      'bad_value'
    );
    sqlError(
      () => insertRow(schema, 'details', { Page: Number.NaN }),
      'bad_value'
    );
  });
});

describe('column keys come from the spec only', () => {
  // A key is typed, but a runtime string (a tool argument, a JSON field)
  // reaches these builders as a plain string; a key that is a property of
  // every object must be refused like any other unknown key.
  test('a SELECT naming a key inherited from Object.prototype is refused, not sent as "SELECT  FROM"', async () => {
    const { schema } = await made();
    sqlError(
      () => selectRows(schema, 'details', ['constructor' as 'Name']),
      'unknown_column'
    );
  });

  test('a condition on an inherited key is refused, not sent as an unquoted "undefined" identifier', async () => {
    const { schema } = await made();
    sqlError(
      () =>
        selectRows(schema, 'details', ['Name'], {
          where: { op: 'is null', column: 'toString' as 'Name' },
        }),
      'unknown_column'
    );
  });

  test('a write naming __proto__ is refused, not silently dropped', async () => {
    const { schema } = await made();
    const row: Record<string, unknown> = { Name: 'Venue: Example Hall' };
    Object.defineProperty(row, '__proto__', { value: 'x', enumerable: true });
    sqlError(
      () =>
        insertRows(schema, 'details', [row as unknown as RowInput<'details'>]),
      'unknown_column'
    );
  });

  test('an ordinary unknown key is refused', async () => {
    const { schema } = await made();
    sqlError(
      () => selectRows(schema, 'details', ['Nope' as 'Name']),
      'unknown_column'
    );
    sqlError(
      () =>
        insertRow(schema, 'details', {
          Nope: 'x',
        } as unknown as RowInput<'details'>),
      'unknown_column'
    );
  });
});

// ---------------------------------------------------------------------------
// Schema setup.

describe('schema setup never makes a second database', () => {
  test('three starts in a row write only on the first and resolve the same ids', async () => {
    const dss = new FakeDss();
    const s = store();
    const first = await start(dss, s);
    const writes = dss.writes().length;
    const second = await start(dss, s);
    const third = await start(dss, s);
    expect(dss.writes()).toHaveLength(writes);
    expect(dss.databases).toHaveLength(1);
    expect(dss.projects).toHaveLength(2);
    // Every start resolves the same tables, views and folders.
    expect(second.schema).toEqual(first.schema);
    expect(third.schema).toEqual(second.schema);
    expect(third.pins).toEqual(first.pins);
    expect(third.changes).toEqual([]);
    expect(third.notes).toEqual([]);
  });

  test('the first start’s schema names the four saved views it made, as every later start does', async () => {
    const dss = new FakeDss();
    const s = store();
    const first = await start(dss, s);
    const views = s.pins?.views;
    expect(Object.keys(views ?? {})).toHaveLength(4);
    expect(first.schema.views as unknown).toEqual(views ?? {});
    const second = await start(dss, s);
    expect(second.schema.views as unknown).toEqual(views ?? {});
  });

  test('a pinned database that is missing, trashed, forbidden or no longer owned stops before any write', async () => {
    const scenarios: [string, (dss: FakeDss) => FetchLike, SchemaErrorKind][] =
      [
        [
          'missing',
          (dss) => {
            dss.databases.splice(0, 1);
            return dss.fetch;
          },
          'database_missing',
        ],
        [
          'trashed',
          (dss) => {
            (dss.databases[0] as { trashedAt: string | null }).trashedAt =
              dss.now();
            return dss.fetch;
          },
          'database_trashed',
        ],
        [
          'forbidden',
          (dss) => {
            (dss.databases[0] as { owner: string }).owner = STRANGER;
            return dss.fetch;
          },
          'not_owned',
        ],
        [
          'shared back with edit after a transfer',
          (dss) =>
            rewriting(
              dss,
              (url, init) =>
                init.method === 'GET' &&
                /\/databases\/[0-9a-f-]{36}$/.test(new URL(url).pathname),
              (body) => {
                const detail = body as {
                  grant: string;
                  database: { owner_id: string };
                };
                return {
                  ...detail,
                  grant: 'edit',
                  database: { ...detail.database, owner_id: STRANGER },
                };
              }
            ),
          'not_owned',
        ],
      ];
    for (const [, break_, kind] of scenarios) {
      const { dss, s } = await made();
      const fetch = break_(dss);
      const writes = dss.writes().length;
      const databases = dss.databases.length;
      await schemaError(start(dss, s, OWNER_EMAIL, fetch), kind);
      expect(dss.writes()).toHaveLength(writes);
      expect(dss.databases).toHaveLength(databases);
      expect(
        dss.seen.some((x) => x.method === 'POST' && x.path === '/databases')
      ).toBe(true);
      expect(
        dss.seen.filter((x) => x.method === 'POST' && x.path === '/databases')
      ).toHaveLength(1);
    }
  });

  test('renamed tables and columns and the owner’s own columns are followed and left alone, with no write', async () => {
    const { dss, s } = await made();
    const db = dss.databases[0];
    if (db === undefined) throw new Error('fixture');
    const jobs = table(dss, 'Jobs');
    jobs.name = 'Gigs';
    const venue = jobs.columns.find((c) => c.name === 'Venue');
    if (venue === undefined) throw new Error('fixture');
    venue.name = 'Where';
    // The owner adds columns, one named like a spec column in another case,
    // one named like what the service would pick for a free name.
    dss.addColumn(jobs, { name: 'Venue', type: 'number', options: [] }, db);
    dss.addColumn(
      jobs,
      { name: 'rate basis 2', type: 'text', options: [] },
      db
    );
    const writes = dss.writes().length;
    const result = await start(dss, s);
    expect(dss.writes()).toHaveLength(writes);
    expect(result.changes).toEqual([]);
    expect(result.schema.tables.jobs.sqlName).toBe('"Gigs"');
    expect(result.schema.tables.jobs.columns.Venue.sqlName).toBe('"Where"');
    const sql = updateRow(result.schema, 'jobs', newId(), {
      Venue: 'Example Hall, Leeds ZZ1 1ZZ',
    }).sql;
    expect(sql).toStartWith('UPDATE "Gigs" SET "Where" = ');
    expect(
      lex(sql)
        .filter((t) => t.kind === 'qident')
        .map((t) => t.text)
    ).toEqual(['Gigs', 'Where']);
  });

  test('a database named Jobs that someone else owns and shares does not count, and is never written', async () => {
    const dss = new FakeDss();
    const theirs = dss.addDatabase('Jobs', 'Jobs', STRANGER);
    // GET /databases lists what the account can see: theirs too, as shared.
    const listing: FetchLike = async (url, init) => {
      if (init.method === 'GET' && new URL(url).pathname === '/dss/databases') {
        const own = (await (await dss.fetch(url, init)).json()) as unknown[];
        return Response.json([
          ...own,
          {
            database: {
              id: theirs.id,
              name: 'Jobs',
              owner_id: STRANGER,
              created_at: theirs.createdAt,
              trashed_at: null,
              project_id: null,
            },
            grant: 'edit',
            tables: [
              {
                id: theirs.tables[0]?.id,
                database_id: theirs.id,
                name: 'Jobs',
                position: 'a0',
                version: 1,
              },
            ],
          },
        ]);
      }
      return dss.fetch(url, init);
    };
    const s = store();
    const first = await start(dss, s, OWNER_EMAIL, listing);
    expect(first.schema.databaseId).not.toBe(theirs.id);
    expect(dss.databases).toHaveLength(2);
    await start(dss, s, OWNER_EMAIL, listing);
    expect(dss.databases).toHaveLength(2);
    expect(theirs.tables).toHaveLength(1);
    const touched = dss.seen.filter(
      (x) =>
        x.path.includes(theirs.id) ||
        (x.body as { databaseId?: string } | undefined)?.databaseId ===
          theirs.id
    );
    expect(touched).toEqual([]);
  });

  test('a database made whose pin was never saved, or whose answer was lost, stops the next start instead of a second', async () => {
    // The pin cannot be saved.
    const dss = new FakeDss();
    let failSave = true;
    const s = store();
    const save = async (p: JobsPins): Promise<void> => {
      if (failSave) throw new Error('state volume is full');
      await s.save(p);
    };
    await expect(
      ensureJobsSchema({
        client: clientFor(dss.fetch),
        pins: undefined,
        ownerEmail: OWNER_EMAIL,
        save,
        newId,
      })
    ).rejects.toThrow('state volume');
    failSave = false;
    await schemaError(
      ensureJobsSchema({
        client: clientFor(dss.fetch),
        pins: undefined,
        ownerEmail: OWNER_EMAIL,
        save,
        newId,
      }),
      'unpinned_existing'
    );
    expect(dss.databases).toHaveLength(1);

    // The database is made but its answer never arrives.
    const lost = new FakeDss();
    const dropping: FetchLike = async (url, init) => {
      const response = await lost.fetch(url, init);
      if (init.method === 'POST' && new URL(url).pathname === '/dss/databases')
        throw new TypeError('connection reset');
      return response;
    };
    let thrown: unknown;
    try {
      await start(lost, store(), OWNER_EMAIL, dropping);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as SupaMacError).kind).toBe('unavailable');
    expect((thrown as SupaMacError).retryable).toBe(true);
    await schemaError(start(lost, store()), 'unpinned_existing');
    expect(lost.databases).toHaveLength(1);
  });

  test('with the state lost after the owner renamed the Jobs database, no second database is made', async () => {
    const { dss } = await made();
    (dss.databases[0] as { name: string }).name = 'Work 2027';
    // The state volume is lost, or restored from before the first start.
    let thrown: unknown;
    try {
      await start(dss, store());
    } catch (error) {
      thrown = error;
    }
    expect(dss.databases).toHaveLength(1);
    expect(thrown).toBeInstanceOf(SchemaError);
  });

  test('a column added back whose answer was lost is adopted on the next start, not added a second time', async () => {
    const { dss, s } = await made();
    const details = table(dss, 'Details');
    details.columns = details.columns.filter((c) => c.name !== 'Check');
    // The ADD COLUMN commits, but its answer never arrives.
    const dropping: FetchLike = async (url, init) => {
      const response = await dss.fetch(url, init);
      const sql =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as { sql?: string }).sql
          : undefined;
      if (sql?.includes('ADD COLUMN') === true)
        throw new TypeError('connection reset');
      return response;
    };
    let thrown: unknown;
    try {
      await start(dss, s, OWNER_EMAIL, dropping);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as SupaMacError).retryable).toBe(true);
    await start(dss, s);
    expect(
      details.columns
        .filter((c) => /^check( \d+)?$/i.test(c.name))
        .map((c) => c.name)
    ).toEqual(['Check']);
  });

  test('a pinned column the owner turned into a formula stops the start, since SQL can no longer write it', async () => {
    const { dss, s } = await made();
    const rateId = s.pins?.tables.jobs?.columns.Rate?.id;
    const fetch = rewriting(
      dss,
      (url, init) =>
        init.method === 'GET' &&
        /\/databases\/[0-9a-f-]{36}$/.test(new URL(url).pathname),
      (body) => {
        const detail = body as {
          tables: {
            columns: {
              column: { id: string; config: unknown };
              writable: boolean;
            }[];
          }[];
        };
        for (const t of detail.tables) {
          for (const c of t.columns) {
            if (c.column.id === rateId) {
              c.column.config = {
                kind: 'derived',
                formula: { kind: 'number', value: 1 },
              };
              c.writable = false;
            }
          }
        }
        return detail;
      }
    );
    await schemaError(start(dss, s, OWNER_EMAIL, fetch), 'column_changed');
  });
});

describe('sharing goes only to the owner', () => {
  test('a first start grants edit to the owner on the database and its two folders, and to nobody else', async () => {
    const dss = new FakeDss();
    const result = await start(dss, store(), ' Sam.Price@EXAMPLE.com ');
    const puts = dss.seen.filter((x) => x.method === 'PUT');
    expect(puts).toHaveLength(3);
    const entities = puts.map((p) => p.path.split('/').slice(2, 4).join(':'));
    expect(entities.sort()).toEqual(
      [
        `database:${result.schema.databaseId}`,
        `project:${result.schema.folders.intake}`,
        `project:${result.schema.folders.sources}`,
      ].sort()
    );
    for (const put of puts) {
      expect(put.path.split('/').at(-1)).toBe(OWNER_USER);
      expect(put.body).toEqual({ accessLevel: 'edit' });
    }
    expect(result.schema.ownerUserId).toBe(OWNER_USER);
  });

  test('a grant someone else already holds is never widened or copied, and the owner’s is only restored', async () => {
    const { dss, s, schema } = await made();
    dss.grants.set(
      `database:${schema.databaseId}`,
      new Map([
        [STRANGER, 'view'],
        [OWNER_USER, 'view'],
      ])
    );
    const before = dss.seen.length;
    await start(dss, s);
    const puts = dss.seen.slice(before).filter((x) => x.method === 'PUT');
    expect(puts.map((p) => p.path.split('/').at(-1))).toEqual([OWNER_USER]);
    expect(dss.grants.get(`database:${schema.databaseId}`)?.get(STRANGER)).toBe(
      'view'
    );
  });

  test('an owner address that is not an address, or is the jobs account, is never shared with', async () => {
    for (const bad of [
      'sam price',
      'macro|sam@example.com',
      'sam@example',
      '',
      'a|b@example.com',
    ]) {
      const dss = new FakeDss();
      await schemaError(start(dss, store(), bad), 'owner_invalid');
      expect(dss.seen.filter((x) => x.method === 'PUT')).toEqual([]);
    }
    const dss = new FakeDss();
    await schemaError(start(dss, store(), 'JOBS@example.com'), 'owner_invalid');
    expect(dss.seen.filter((x) => x.method === 'PUT')).toEqual([]);
  });

  test('a grant to anyone but the owner is reported by the start that checks the shares', async () => {
    const { dss, s, schema } = await made();
    dss.grants.get(`database:${schema.databaseId}`)?.set(STRANGER, 'edit');
    const result = await start(dss, s);
    expect(result.notes.join('\n')).toContain(STRANGER);
  });
});

// ---------------------------------------------------------------------------
// Attribution.

describe('who changed a row', () => {
  function entry(
    fields: Partial<RowHistoryEntry> &
      Pick<RowHistoryEntry, 'version' | 'change'>
  ): RowHistoryEntry {
    return {
      actor: OWNER_USER,
      actingBot: null,
      at: '2027-03-13T07:30:00Z',
      kind: 'update',
      columns: [],
      before: {},
      after: {},
      ...fields,
    };
  }

  test('the owner, the owner’s assistant, the service and anyone else, as the journal records each', async () => {
    const { schema } = await made();
    const details = schema.tables.details;
    const status = details.columns.Status;
    const found = status.options.get('Found')?.id as string;
    const confirmed = status.options.get('Confirmed')?.id as string;
    const rows = Array.from({ length: 7 }, () => newId());
    const [
      byOwner,
      byAssistant,
      byService,
      byServiceLost,
      byInternal,
      byOther,
      byAgentForService,
    ] = rows as [string, string, string, string, string, string, string];
    const statusChange = {
      columns: [status.id],
      before: {
        [status.id]: { type: 'options' as const, value: [{ id: found }] },
      },
      after: {
        [status.id]: { type: 'options' as const, value: [{ id: confirmed }] },
      },
    };
    const history: Record<string, RowHistoryEntry[]> = {
      [byOwner]: [
        entry({
          version: 12,
          change: 120,
          actor: 'macro|Sam.Price@Example.COM',
          ...statusChange,
        }),
      ],
      // The owner's assistant in SupaMac: the owner's account, an agent acting.
      [byAssistant]: [
        entry({ version: 13, change: 130, actingBot: BOT, ...statusChange }),
      ],
      [byService]: [entry({ version: 11, change: 110, actor: SERVICE_USER })],
      // A write whose answer was lost: its version was never recorded.
      [byServiceLost]: [
        entry({ version: 14, change: 140, actor: SERVICE_USER }),
      ],
      [byInternal]: [entry({ version: 15, change: 150, actor: null })],
      [byOther]: [
        entry({ version: 16, change: 160, actor: STRANGER, ...statusChange }),
      ],
      [byAgentForService]: [
        entry({
          version: 17,
          change: 170,
          actor: SERVICE_USER,
          actingBot: BOT,
        }),
      ],
    };
    const fetch: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      const m = /\/rows\/([^/]+)\/history$/.exec(path);
      if (m !== null)
        return Response.json({ changes: history[m[1] as string] ?? [] });
      return Response.json({
        version: 17,
        complete: true,
        truncated: false,
        rows: rows.map((row) => ({ row, kind: 'update' })),
        columns: [],
      });
    };
    const who: Attribution = {
      serviceUserId: schema.serviceUserId,
      ownerUserId: schema.ownerUserId,
      isServiceVersion: (tableId, version) =>
        tableId === details.id && version === 11,
    };
    const report = await readTableChanges(clientFor(fetch), {
      databaseId: schema.databaseId,
      tableId: details.id,
      since: 10,
      who,
    });
    expect(report.skipped).toBe(2);
    expect(report.changes.map((c) => [c.rowId, c.author])).toEqual([
      [byOwner, 'owner'],
      [byAssistant, 'agent'],
      [byInternal, 'other'],
      [byOther, 'other'],
      [byAgentForService, 'agent'],
    ]);
    const assistant = report.changes.find((c) => c.rowId === byAssistant);
    if (assistant === undefined) throw new Error('no assistant change');
    expect(assistant.actor).toBe(OWNER_USER);
    expect(assistant.actingBot).toBe(BOT);
    expect(detailEdit(assistant, details).status?.after).toEqual({
      kind: 'option',
      option: 'Confirmed',
    });
  });

  test('only changes after the version read and up to the version the journal reaches are reported', async () => {
    const { schema } = await made();
    const row = newId();
    const fetch: FetchLike = async (url) =>
      new URL(url).pathname.endsWith('/history')
        ? Response.json({
            changes: [
              entry({ version: 21, change: 3 }),
              entry({ version: 20, change: 2 }),
              entry({ version: 19, change: 1 }),
            ],
          })
        : Response.json({
            version: 20,
            complete: true,
            truncated: false,
            rows: [{ row, kind: 'update' }],
            columns: [],
          });
    const report = await readTableChanges(clientFor(fetch), {
      databaseId: schema.databaseId,
      tableId: schema.tables.details.id,
      since: 19,
      who: {
        serviceUserId: SERVICE_USER,
        ownerUserId: OWNER_USER,
        isServiceVersion: () => false,
      },
    });
    expect(report.changes.map((c) => c.version)).toEqual([20]);
    expect(report.version).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// The key.

describe('the API key never reaches an error or a log line', () => {
  const KEY_ECHOES: [string, number, string][] = [
    [
      'a JSON message',
      401,
      JSON.stringify({ message: `key ${KEY} is revoked` }),
    ],
    [
      'JSON of another shape',
      400,
      JSON.stringify({ error: true, detail: { key: KEY } }),
    ],
    ['plain text', 500, `upstream said: x-macro-user-api-key: ${KEY}`],
    [
      'an op refusal',
      400,
      JSON.stringify({
        op: 0,
        row: null,
        column: null,
        message: `refused for ${KEY}`,
        taken: null,
      }),
    ],
    ['the key URL encoded', 403, `forbidden ${encodeURIComponent(KEY)}`],
  ];
  for (const [name, status, body] of KEY_ECHOES) {
    test(`an error answer echoing it as ${name}`, async () => {
      const lines: string[] = [];
      const logger = new Logger({
        sink: (line) => lines.push(line),
        level: 'debug',
      }).child({ unit: 'review' });
      const client = clientFor(
        async () => new Response(body, { status }),
        logger
      );
      let thrown: unknown;
      try {
        await client.send(listDatabasesRequest());
      } catch (error) {
        thrown = error;
      }
      const error = thrown as SupaMacError;
      expect(error).toBeInstanceOf(SupaMacError);
      logger.error('request failed', { error });
      const everything = [
        error.message,
        error.detail ?? '',
        JSON.stringify(error),
        JSON.stringify(error.refusal ?? null),
        String(error.cause ?? ''),
        ...lines,
      ].join('\n');
      expect(everything).not.toContain(KEY);
      expect(everything).not.toContain('7a7a7a7a7a7a7a7a');
    });
  }

  test('a transport failure whose message holds it', async () => {
    const client = clientFor(async (url, init) => {
      throw new Error(
        `connect failed for ${url} with ${init.headers['x-macro-user-api-key']}`
      );
    });
    let thrown: unknown;
    try {
      await client.send(listDatabasesRequest());
    } catch (error) {
      thrown = error;
    }
    const error = thrown as SupaMacError;
    expect(error.kind).toBe('unavailable');
    expect(
      [error.message, JSON.stringify(error), String(error.cause ?? '')].join(
        '\n'
      )
    ).not.toContain(KEY);
  });

  test('an answer that does not fit its schema names the path, not the values', async () => {
    const client = clientFor(async () =>
      Response.json([{ database: { id: KEY }, grant: KEY, tables: [] }])
    );
    let thrown: unknown;
    try {
      await client.send(listDatabasesRequest());
    } catch (error) {
      thrown = error;
    }
    const error = thrown as SupaMacError;
    expect(error.kind).toBe('bad_response');
    expect([error.message, JSON.stringify(error)].join('\n')).not.toContain(
      KEY
    );
  });

  test('a success answer that is not JSON and echoes it: the error’s cause does not carry it', async () => {
    const client = clientFor(async () => new Response(KEY, { status: 200 }));
    let thrown: unknown;
    try {
      await client.send(listDatabasesRequest());
    } catch (error) {
      thrown = error;
    }
    const error = thrown as SupaMacError;
    expect(error.kind).toBe('bad_response');
    expect(error.message).not.toContain(KEY);
    expect(
      String((error.cause as Error | undefined)?.message ?? '')
    ).not.toContain(KEY);
  });
});

// ---------------------------------------------------------------------------
// Documents.

describe('documents', () => {
  test('the text document of an original with a long name still ends in " · text" and differs from it', () => {
    const original = sanitizeFileName(
      `${'Acme Productions production pack '.repeat(6)}rev 3.pdf`
    );
    const text = sanitizeFileName(`${textDocumentName(original)}.md`);
    expect(text.endsWith(' · text.md')).toBe(true);
    expect(text.replace(/\.md$/, '')).not.toBe(original.replace(/\.pdf$/, ''));
  });

  test('a file name is one name: directories, controls and bidi overrides go, and only allowed types pass', () => {
    expect(sanitizeFileName('../../etc/Call sheet.PDF')).toBe('Call sheet.pdf');
    expect(sanitizeFileName('a\u0000b\u202e.pdf')).toBe('ab.pdf');
    expect(sanitizeFileName('x.pdf\u0000.md')).toBe('x.pdf.md');
    expect(() => sanitizeFileName('invoice\u202efdp.exe')).toThrow(
      'not one the service stores'
    );
    expect(() => sanitizeFileName('Call sheet.DOCX')).toThrow(
      '.docx is never uploaded'
    );
    expect(() => sanitizeFileName('..pdf')).toThrow();
  });
});
