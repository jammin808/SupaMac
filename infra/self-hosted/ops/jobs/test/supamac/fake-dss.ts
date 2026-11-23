// An in-memory stand-in for the storage routes the service calls, holding
// databases, tables, columns, options, views, folders, documents and grants.
// Its answers follow packages/sdk/specs/storage.json (api.test.ts checks
// them against it). Its schema statements are the forms schema.ts sends:
// CREATE TABLE, ALTER TABLE … ADD COLUMN and ALTER TABLE … ALTER COLUMN …
// ADD OPTIONS.

import type { FetchInit, FetchLike } from '../../src/supamac/client';

export const BASE = 'http://gateway:8080/dss';
export const SERVICE_USER = 'macro|jobs@example.com';
export const OWNER_EMAIL = 'sam.price@example.com';
export const OWNER_USER = `macro|${OWNER_EMAIL}`;
export const PUBLIC_HOST = 'https://api.example.com';

export interface FakeOption {
  id: string;
  label: string;
}

export interface FakeColumn {
  id: string;
  definitionId: string;
  name: string;
  dataType: string;
  multi: boolean;
  entity: string | null;
  link: string | null;
  options: FakeOption[];
  /** A placement config other than a relation's link (a formula, a percentage). */
  config?: Record<string, unknown> | undefined;
  /** Whether SQL may write it; true unless set. */
  writable?: boolean | undefined;
}

export interface FakeView {
  id: string;
  name: string;
  query: unknown;
  layout: Record<string, unknown>;
}

export interface FakeTable {
  id: string;
  name: string;
  version: number;
  columns: FakeColumn[];
  views: FakeView[];
}

export interface FakeDatabase {
  id: string;
  name: string;
  owner: string;
  createdAt: string;
  trashedAt: string | null;
  tables: FakeTable[];
}

export interface FakeProject {
  id: string;
  name: string;
  userId: string;
  parentId: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface FakeDocument {
  id: string;
  name: string;
  fileType: string;
  owner: string;
  projectId: string | null;
  bytes: Uint8Array;
  state: 'ready' | 'pending';
  createdAt: string;
  deletedAt: string | null;
}

export interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function error(status: number, message: string): Response {
  return json(status, { message });
}

// --- A tokenizer for the statements schema.ts writes.

type Token =
  | { t: 'ident'; v: string }
  | { t: 'word'; v: string }
  | { t: 'str'; v: string }
  | { t: 'punct'; v: string };

export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let text = '';
      for (;;) {
        if (j >= sql.length) throw new Error('unterminated quote');
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            text += c;
            j += 2;
            continue;
          }
          break;
        }
        text += sql[j];
        j++;
      }
      out.push(c === '"' ? { t: 'ident', v: text } : { t: 'str', v: text });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i)) as RegExpExecArray;
      out.push({ t: 'word', v: m[0] });
      i += m[0].length;
    } else if ('(),[].'.includes(c)) {
      out.push({ t: 'punct', v: c });
      i++;
    } else {
      throw new Error(`unexpected character ${c}`);
    }
  }
  return out;
}

class Parser {
  i = 0;
  constructor(readonly tokens: Token[]) {}
  peek(): Token | undefined {
    return this.tokens[this.i];
  }
  word(expected?: string): string {
    const t = this.tokens[this.i++];
    if (
      t?.t !== 'word' ||
      (expected !== undefined && t.v.toLowerCase() !== expected)
    ) {
      throw new Error(`expected ${expected ?? 'a word'}`);
    }
    return t.v.toLowerCase();
  }
  name(): string {
    const t = this.tokens[this.i++];
    if (t?.t === 'ident' || t?.t === 'word') return t.v;
    throw new Error('expected a name');
  }
  punct(p: string): void {
    const t = this.tokens[this.i++];
    if (t?.t !== 'punct' || t.v !== p) throw new Error(`expected ${p}`);
  }
  maybe(p: string): boolean {
    const t = this.peek();
    if (t?.t === 'punct' && t.v === p) {
      this.i++;
      return true;
    }
    return false;
  }
  strings(): string[] {
    this.punct('(');
    const out: string[] = [];
    do {
      const t = this.tokens[this.i++];
      if (t?.t !== 'str') throw new Error('expected a label');
      out.push(t.v);
    } while (this.maybe(','));
    this.punct(')');
    return out;
  }
  done(): void {
    if (this.i !== this.tokens.length) throw new Error('trailing tokens');
  }
}

interface ColumnDef {
  name: string;
  type: string;
  entity?: string;
  relation?: string;
  options: string[];
}

function columnDef(p: Parser): ColumnDef {
  const name = p.name();
  const type = p.word();
  const def: ColumnDef = { name, type, options: [] };
  if (type === 'entity') {
    p.punct('(');
    def.entity = p.word().toUpperCase();
    p.punct(')');
  } else if (type === 'relation') {
    p.punct('(');
    def.relation = p.name();
    p.punct(')');
  } else if (
    !['text', 'number', 'date', 'date_range', 'select', 'tag'].includes(type)
  ) {
    throw new Error(`unknown type ${type}`);
  }
  const next = p.peek();
  if (next?.t === 'word' && next.v.toLowerCase() === 'options') {
    p.word('options');
    def.options = p.strings();
  }
  return def;
}

const same = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

export class FakeDss {
  readonly databases: FakeDatabase[] = [];
  readonly projects: FakeProject[] = [];
  readonly documents: FakeDocument[] = [];
  /** `<type>:<id>` → user id → level. */
  readonly grants = new Map<string, Map<string, string>>();
  readonly seen: Seen[] = [];
  private counter = 0;
  private clock = Date.parse('2027-03-01T09:00:00Z');
  /** Answers given instead of the route's own, by `METHOD /path`. */
  readonly overrides = new Map<string, () => Response>();

  constructor(readonly user: string = SERVICE_USER) {}

  id(): string {
    this.counter++;
    return `0190d5a8-0000-7000-8000-${this.counter.toString(16).padStart(12, '0')}`;
  }

  now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  writes(): Seen[] {
    return this.seen.filter((s) => WRITE_METHODS.has(s.method));
  }

  database(id: string): FakeDatabase | undefined {
    return this.databases.find((d) => d.id === id);
  }

  readonly fetch: FetchLike = async (
    url: string,
    init: FetchInit
  ): Promise<Response> => {
    const parsed = new URL(url);
    const query = Object.fromEntries(parsed.searchParams);
    let body: unknown;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    else if (init.body instanceof Uint8Array) body = init.body;
    if (parsed.pathname.startsWith('/local-storage/')) {
      this.seen.push({
        method: init.method,
        path: parsed.pathname,
        query,
        headers: init.headers,
        body,
      });
      return this.object(parsed);
    }
    if (!url.startsWith(`${BASE}/`)) return error(404, 'not the gateway');
    const path = decodeURIComponent(parsed.pathname.slice('/dss'.length));
    this.seen.push({
      method: init.method,
      path,
      query,
      headers: init.headers,
      body,
    });
    if (init.headers['x-macro-user-api-key'] === undefined)
      return error(401, 'no key');
    const override = this.overrides.get(`${init.method} ${path}`);
    if (override !== undefined) return override();
    try {
      return this.route(
        init.method,
        path.split('/').filter(Boolean),
        query,
        body
      );
    } catch (e) {
      return error(400, e instanceof Error ? e.message : 'refused');
    }
  };

  private route(
    method: string,
    parts: string[],
    query: Record<string, string>,
    body: unknown
  ): Response {
    const [a, b, c, d, e, , g] = parts;
    if (a === 'databases') {
      if (method === 'GET' && b === undefined) return this.listDatabases();
      if (method === 'POST' && b === undefined)
        return this.createDatabase(
          body as { name: string; firstTable: string }
        );
      if (method === 'POST' && b === 'query')
        return this.query(body as { sql: string; databaseId: string });
      if (method === 'GET' && b !== undefined && c === undefined)
        return this.getDatabase(b);
      if (method === 'POST' && b !== undefined && c === 'ops')
        return this.ops(b, body as { ops: unknown[] });
      if (method === 'GET' && c === 'tables' && e === 'changes')
        return error(404, 'no journal in this fake');
      if (method === 'GET' && c === 'tables' && e === 'rows' && g === 'history')
        return error(404, 'no journal');
    }
    if (a === 'projects') {
      if (method === 'GET' && b === undefined) return this.listProjects();
      if (method === 'POST' && b === undefined)
        return this.createProject(body as { name: string });
      if (method === 'GET' && b !== undefined && c === undefined)
        return this.getProject(b);
      if (method === 'GET' && b !== undefined && c === 'content')
        return this.projectContent(b);
    }
    if (
      a === 'entities' &&
      b !== undefined &&
      c !== undefined &&
      d === 'direct-access'
    ) {
      if (method === 'GET' && e === undefined) return this.directAccess(b, c);
      if (method === 'PUT' && e !== undefined)
        return this.setDirectAccess(b, c, e, body as { accessLevel: string });
    }
    if (a === 'documents') {
      if (method === 'POST' && b === 'upload')
        return this.upload(query, body as Uint8Array);
      if (method === 'GET' && b !== undefined && c === undefined)
        return this.getDocument(b);
      if (method === 'PATCH' && b !== undefined && c === undefined)
        return this.editDocument(b, body as { projectId: string });
      if (method === 'GET' && b !== undefined && c === 'export')
        return this.exportDocument(b);
    }
    return error(404, `no route ${method} /${parts.join('/')}`);
  }

  // --- Databases.

  private dbJson(db: FakeDatabase): Record<string, unknown> {
    return {
      id: db.id,
      name: db.name,
      owner_id: db.owner,
      created_at: db.createdAt,
      trashed_at: db.trashedAt,
      project_id: null,
    };
  }

  private tableJson(
    db: FakeDatabase,
    t: FakeTable,
    i: number
  ): Record<string, unknown> {
    return {
      id: t.id,
      database_id: db.id,
      name: t.name,
      position: `a${i}`,
      version: t.version,
    };
  }

  private listDatabases(): Response {
    return json(
      200,
      this.databases
        .filter((db) => db.owner === this.user)
        .map((db) => ({
          database: this.dbJson(db),
          grant: 'owner',
          tables: db.tables.map((t, i) => this.tableJson(db, t, i)),
        }))
    );
  }

  addDatabase(
    name: string,
    firstTable: string,
    owner = this.user
  ): FakeDatabase {
    const db: FakeDatabase = {
      id: this.id(),
      name,
      owner,
      createdAt: this.now(),
      trashedAt: null,
      tables: [],
    };
    db.tables.push({
      id: this.id(),
      name: firstTable,
      version: 1,
      columns: [],
      views: [],
    });
    this.addColumn(
      db.tables[0] as FakeTable,
      { name: 'Name', type: 'text', options: [] },
      db
    );
    this.databases.push(db);
    return db;
  }

  private createDatabase(body: { name: string; firstTable: string }): Response {
    const db = this.addDatabase(body.name, body.firstTable ?? 'Table 1');
    return json(201, this.dbJson(db));
  }

  private getDatabase(id: string): Response {
    const db = this.database(id);
    if (db === undefined) return error(404, 'no such database');
    if (db.owner !== this.user) return error(403, 'no access');
    return json(200, {
      database: this.dbJson(db),
      grant: 'owner',
      tables: db.tables.map((t, i) => ({
        table: this.tableJson(db, t, i),
        sql_name: `"${db.name}"."${t.name}"`,
        columns: t.columns.map((col, j) => ({
          column: {
            id: col.id,
            table_id: t.id,
            property_definition_id: col.definitionId,
            position: `a${j}`,
            config:
              col.config ??
              (col.link === null
                ? null
                : { kind: 'link', database_id: db.id, table_id: col.link }),
            display_name: col.name,
            infer_type: false,
          },
          sql_name: `"${col.name.replaceAll('"', '""')}"`,
          definition: {
            definition: {
              id: col.definitionId,
              owner: { scope: 'database', database_id: db.id },
              display_name: col.name,
              data_type: col.dataType,
              is_multi_select: col.multi,
              specific_entity_type: col.entity,
              created_at: db.createdAt,
              updated_at: db.createdAt,
              is_system: false,
              is_metadata: false,
            },
            property_options: col.options.map((o, k) => ({
              id: o.id,
              property_definition_id: col.definitionId,
              display_order: k,
              value: { type: 'string', value: o.label },
              color: null,
              created_at: db.createdAt,
              updated_at: db.createdAt,
            })),
          },
          writable: col.writable ?? true,
          shared_outside_database: false,
        })),
        views: t.views.map((v, k) => ({
          id: v.id,
          databaseId: db.id,
          tableId: t.id,
          name: v.name,
          position: `a${k}`,
          query: v.query,
          layout: v.layout,
          createdAt: db.createdAt,
          updatedAt: db.createdAt,
        })),
      })),
    });
  }

  addColumn(table: FakeTable, def: ColumnDef, db: FakeDatabase): FakeColumn {
    if (table.columns.some((c) => same(c.name, def.name)))
      throw new Error(`a column named ${def.name} exists`);
    const types: Record<string, [string, boolean]> = {
      text: ['STRING', false],
      number: ['NUMBER', false],
      date: ['DATE', false],
      date_range: ['DATE_RANGE', false],
      select: ['SELECT_STRING', false],
      tag: ['TAG', true],
      entity: ['ENTITY', false],
      relation: ['ENTITY', true],
    };
    const [dataType, multi] = types[def.type] as [string, boolean];
    let link: string | null = null;
    if (def.type === 'relation') {
      const target = db.tables.find((t) =>
        same(t.name, def.relation as string)
      );
      if (target === undefined) throw new Error(`no table ${def.relation}`);
      link = target.id;
    }
    const column: FakeColumn = {
      id: this.id(),
      definitionId: this.id(),
      name: def.name,
      dataType,
      multi,
      entity:
        def.type === 'entity'
          ? (def.entity as string)
          : def.type === 'relation'
            ? 'DATABASE_ROW'
            : null,
      link,
      options: [],
    };
    for (const label of def.options) {
      if (!column.options.some((o) => same(o.label, label)))
        column.options.push({ id: this.id(), label });
    }
    table.columns.push(column);
    table.version++;
    return column;
  }

  private query(body: { sql: string; databaseId: string }): Response {
    const db = this.database(body.databaseId);
    if (db === undefined) return error(404, 'no such database');
    const p = new Parser(tokenize(body.sql));
    const first = p.word();
    const table = (name: string): FakeTable => {
      const t = db.tables.find((x) => same(x.name, name));
      if (t === undefined) throw new Error(`no table ${name}`);
      return t;
    };
    if (first === 'create') {
      p.word('table');
      const name = p.name();
      if (db.tables.some((t) => same(t.name, name)))
        throw new Error(`a table named ${name} exists`);
      p.punct('(');
      const defs: ColumnDef[] = [];
      do defs.push(columnDef(p));
      while (p.maybe(','));
      p.punct(')');
      p.done();
      const t: FakeTable = {
        id: this.id(),
        name,
        version: 1,
        columns: [],
        views: [],
      };
      db.tables.push(t);
      for (const def of defs) this.addColumn(t, def, db);
    } else if (first === 'alter') {
      p.word('table');
      const t = table(p.name());
      const verb = p.word();
      if (verb === 'add') {
        p.word('column');
        const def = columnDef(p);
        p.done();
        this.addColumn(t, def, db);
      } else if (verb === 'alter') {
        p.word('column');
        const columnName = p.name();
        p.word('add');
        p.word('options');
        const labels = p.strings();
        p.done();
        const column = t.columns.find((c) => same(c.name, columnName));
        if (column === undefined) throw new Error(`no column ${columnName}`);
        for (const label of labels) {
          if (!column.options.some((o) => same(o.label, label)))
            column.options.push({ id: this.id(), label });
        }
        t.version++;
      } else {
        throw new Error(`unsupported ALTER ${verb}`);
      }
    } else {
      throw new Error(`this fake runs schema statements only, not ${first}`);
    }
    return json(200, {
      tableDatabases: {},
      changesApplied: 0,
      insertedRowIds: [],
      newVersions: {},
      readVersions: {},
      truncatedTables: [],
      result: null,
      statement: { kind: 'schema', databaseId: db.id, summary: 'done' },
    });
  }

  private ops(databaseId: string, body: { ops: unknown[] }): Response {
    const db = this.database(databaseId);
    if (db === undefined) return error(404, 'no such database');
    const results: unknown[] = [];
    for (const [index, raw] of body.ops.entries()) {
      const op = raw as {
        kind: string;
        table: string;
        view: string;
        change: {
          kind: string;
          view: {
            name: string;
            query: unknown;
            layout: Record<string, unknown>;
          };
        };
      };
      const t = db.tables.find((x) => x.id === op.table);
      if (
        op.kind !== 'view' ||
        op.change.kind !== 'create' ||
        t === undefined
      ) {
        return json(400, {
          message: 'unsupported op',
          op: index,
          row: null,
          column: null,
          taken: null,
        });
      }
      if (db.tables.some((x) => x.views.some((v) => v.id === op.view))) {
        return json(400, {
          message: 'id taken',
          op: index,
          row: null,
          column: null,
          taken: { kind: 'view', id: op.view },
        });
      }
      if (t.views.some((v) => same(v.name, op.change.view.name))) {
        return json(400, {
          message: 'a view of that name exists',
          op: index,
          row: null,
          column: null,
          taken: null,
        });
      }
      const layout = { ...op.change.view.layout };
      if (
        (layout.kind === 'board' || layout.kind === 'timeline') &&
        layout.title === undefined
      ) {
        layout.title = t.columns[0]?.id;
      }
      const view: FakeView = {
        id: op.view,
        name: op.change.view.name,
        query: op.change.view.query,
        layout,
      };
      t.views.push(view);
      t.version++;
      results.push({
        kind: 'view',
        table: t.id,
        view: view.id,
        tableVersion: t.version,
        change: {
          kind: 'created',
          view: {
            id: view.id,
            databaseId: db.id,
            tableId: t.id,
            name: view.name,
            position: 'a0',
            query: view.query,
            layout: view.layout,
            createdAt: db.createdAt,
            updatedAt: db.createdAt,
          },
        },
      });
    }
    return json(200, { results, changes: [] });
  }

  // --- Folders.

  private projectJson(p: FakeProject): Record<string, unknown> {
    return {
      id: p.id,
      name: p.name,
      userId: p.userId,
      parentId: p.parentId,
      createdAt: p.createdAt,
      updatedAt: p.createdAt,
      deletedAt: p.deletedAt,
    };
  }

  addProject(name: string, userId = this.user): FakeProject {
    const project: FakeProject = {
      id: this.id(),
      name,
      userId,
      parentId: null,
      createdAt: this.now(),
      deletedAt: null,
    };
    this.projects.push(project);
    return project;
  }

  private visibleProject(p: FakeProject): boolean {
    return (
      p.userId === this.user ||
      (this.grants.get(`project:${p.id}`)?.has(this.user) ?? false)
    );
  }

  private listProjects(): Response {
    return json(200, {
      error: false,
      data: this.projects
        .filter((p) => this.visibleProject(p))
        .map((p) => this.projectJson(p)),
    });
  }

  private createProject(body: { name: string }): Response {
    return json(200, {
      error: false,
      data: this.projectJson(this.addProject(body.name)),
    });
  }

  private getProject(id: string): Response {
    const p = this.projects.find((x) => x.id === id);
    if (p === undefined)
      return json(404, { error: true, message: 'no such project' });
    if (!this.visibleProject(p))
      return json(401, { error: true, message: 'no access' });
    return json(200, {
      error: false,
      data: {
        projectMetadata: this.projectJson(p),
        userAccessLevel: p.userId === this.user ? 'owner' : 'edit',
      },
    });
  }

  private projectContent(id: string): Response {
    const p = this.projects.find((x) => x.id === id);
    if (p === undefined)
      return json(404, { error: true, message: 'no such project' });
    return json(200, {
      error: false,
      data: this.documents
        .filter((d) => d.projectId === id)
        .map((d) => ({
          item: { type: 'document', ...this.basicDocument(d) },
          userAccessLevel: 'owner',
        })),
    });
  }

  // --- Grants.

  private directAccess(type: string, id: string): Response {
    const grants =
      this.grants.get(`${type}:${id}`) ?? new Map<string, string>();
    return json(
      200,
      [...grants].map(([userId, accessLevel]) => ({ userId, accessLevel }))
    );
  }

  private setDirectAccess(
    type: string,
    id: string,
    userId: string,
    body: { accessLevel: string }
  ): Response {
    if (userId === this.user) return error(403, 'the owner holds it');
    const key = `${type}:${id}`;
    const grants = this.grants.get(key) ?? new Map<string, string>();
    grants.set(userId, body.accessLevel);
    this.grants.set(key, grants);
    return json(200, null);
  }

  // --- Documents.

  private basicDocument(d: FakeDocument): Record<string, unknown> {
    return {
      id: d.id,
      documentVersionId: 1,
      owner: d.owner,
      name: d.name,
      fileType: d.fileType,
      projectId: d.projectId,
      createdAt: d.createdAt,
      updatedAt: d.createdAt,
      deletedAt: d.deletedAt,
    };
  }

  addDocument(
    name: string,
    fileType: string,
    projectId: string | null,
    owner = this.user,
    bytes: Uint8Array = new Uint8Array([1, 2, 3])
  ): FakeDocument {
    const doc: FakeDocument = {
      id: this.id(),
      name,
      fileType,
      owner,
      projectId,
      bytes,
      state: 'ready',
      createdAt: this.now(),
      deletedAt: null,
    };
    this.documents.push(doc);
    return doc;
  }

  private upload(query: Record<string, string>, bytes: Uint8Array): Response {
    const fileName = query.fileName as string;
    const dot = fileName.lastIndexOf('.');
    const doc = this.addDocument(
      fileName.slice(0, dot),
      fileName.slice(dot + 1),
      query.projectId ?? null,
      this.user,
      bytes
    );
    return json(200, { documentId: doc.id, sizeBytes: bytes.byteLength });
  }

  private getDocument(id: string): Response {
    const d = this.documents.find((x) => x.id === id);
    if (d === undefined) return error(404, 'no such document');
    return json(200, {
      error: false,
      data: {
        documentMetadata: {
          documentId: d.id,
          documentName: d.name,
          documentVersionId: 1,
          owner: d.owner,
          fileType: d.fileType,
          projectId: d.projectId,
          deletedAt: d.deletedAt,
          content: { state: d.state },
        },
        userAccessLevel: 'owner',
      },
    });
  }

  private editDocument(id: string, body: { projectId: string }): Response {
    const d = this.documents.find((x) => x.id === id);
    if (d === undefined) return error(404, 'no such document');
    d.projectId = body.projectId;
    return json(200, { error: false, data: { success: true } });
  }

  private exportDocument(id: string): Response {
    const d = this.documents.find((x) => x.id === id);
    if (d === undefined)
      return json(404, { error: true, message: 'no such document' });
    return json(200, {
      presigned_url: `${PUBLIC_HOST}/local-storage/doc-storage/${d.id}.${d.fileType}?X-Amz-Signature=fixture`,
    });
  }

  private object(url: URL): Response {
    const m = /^\/local-storage\/doc-storage\/([^.]+)\./.exec(url.pathname);
    const d =
      m === null ? undefined : this.documents.find((x) => x.id === m[1]);
    if (
      d === undefined ||
      url.searchParams.get('X-Amz-Signature') !== 'fixture'
    )
      return new Response('', { status: 403 });
    return new Response(new Uint8Array(d.bytes), {
      status: 200,
      headers: { 'content-length': String(d.bytes.byteLength) },
    });
  }
}
