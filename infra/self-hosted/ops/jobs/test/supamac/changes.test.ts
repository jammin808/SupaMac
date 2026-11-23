import { beforeAll, describe, expect, test } from 'bun:test';
import type { RowHistoryEntry } from '../../src/supamac/api';
import {
  type Attribution,
  authorOf,
  cellOption,
  cellText,
  detailEdit,
  readTableChanges,
} from '../../src/supamac/changes';
import { type FetchInit, SupaMacClient } from '../../src/supamac/client';
import { ensureJobsSchema } from '../../src/supamac/schema';
import type { JobsSchema } from '../../src/supamac/tables';
import {
  BASE,
  FakeDss,
  OWNER_EMAIL,
  OWNER_USER,
  SERVICE_USER,
} from './fake-dss';

const KEY = ['mak', 'e5'.repeat(32)].join('_');
const DB = '0190d5a8-0000-7000-c000-0000000000db';
const TABLE = '0190d5a8-0000-7000-c000-0000000000ab';
const ROW_A = '0190d5a8-0000-7000-c000-00000000000a';
const ROW_B = '0190d5a8-0000-7000-c000-00000000000b';
const ROW_C = '0190d5a8-0000-7000-c000-00000000000c';
const BOT = 'bot|0190d5a8-0000-7000-c000-000000000b07';

const SERVICE_VERSIONS = new Set([41, 43]);
const WHO: Attribution = {
  serviceUserId: SERVICE_USER,
  ownerUserId: OWNER_USER,
  isServiceVersion: (table, version) =>
    table === TABLE && SERVICE_VERSIONS.has(version),
};

function entry(
  fields: Partial<RowHistoryEntry> & Pick<RowHistoryEntry, 'version'>
): RowHistoryEntry {
  return {
    change: fields.version * 10,
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

describe('who made a change', () => {
  test('the service, by a version it wrote or by its own account', () => {
    expect(
      authorOf(entry({ version: 41, actor: SERVICE_USER }), TABLE, WHO)
    ).toBe('service');
    // A version the service wrote is skipped whoever the journal names.
    expect(
      authorOf(entry({ version: 43, actor: OWNER_USER }), TABLE, WHO)
    ).toBe('service');
    expect(
      authorOf(
        entry({ version: 50, actor: 'MACRO|JOBS@EXAMPLE.COM' }),
        TABLE,
        WHO
      )
    ).toBe('service');
    // The same version number of another table is not the service's.
    expect(
      authorOf(entry({ version: 41, actor: OWNER_USER }), ROW_A, WHO)
    ).toBe('owner');
  });

  test('the owner, only with no agent acting', () => {
    expect(authorOf(entry({ version: 50 }), TABLE, WHO)).toBe('owner');
    expect(
      authorOf(
        entry({ version: 50, actor: 'macro|Sam.Price@example.com' }),
        TABLE,
        WHO
      )
    ).toBe('owner');
    expect(authorOf(entry({ version: 50, actingBot: BOT }), TABLE, WHO)).toBe(
      'agent'
    );
    expect(authorOf(entry({ version: 50, actingBot: '  ' }), TABLE, WHO)).toBe(
      'owner'
    );
  });

  test('an agent acting for anyone, the jobs account included', () => {
    expect(
      authorOf(
        entry({ version: 50, actor: SERVICE_USER, actingBot: BOT }),
        TABLE,
        WHO
      )
    ).toBe('agent');
    expect(
      authorOf(entry({ version: 50, actor: null, actingBot: BOT }), TABLE, WHO)
    ).toBe('agent');
  });

  test('anyone else, or an internal caller', () => {
    expect(
      authorOf(
        entry({ version: 50, actor: 'macro|other.account@example.com' }),
        TABLE,
        WHO
      )
    ).toBe('other');
    expect(authorOf(entry({ version: 50, actor: null }), TABLE, WHO)).toBe(
      'other'
    );
  });
});

interface Journal {
  changes: unknown;
  history: Record<string, RowHistoryEntry[]>;
}

function journalClient(journal: Journal): {
  client: SupaMacClient;
  urls: string[];
} {
  const urls: string[] = [];
  const client = new SupaMacClient({
    apiKey: KEY,
    baseUrl: BASE,
    fetch: async (url: string, _init: FetchInit) => {
      urls.push(url);
      const path = new URL(url).pathname;
      const history = /\/rows\/([^/]+)\/history$/.exec(path);
      const body =
        history === null
          ? journal.changes
          : { changes: journal.history[history[1] as string] ?? [] };
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
  return { client, urls };
}

describe('reading a table since a version', () => {
  test('reports others’ changes after it, oldest first, and skips the service’s', async () => {
    const { client, urls } = journalClient({
      changes: {
        version: 46,
        complete: true,
        truncated: false,
        rows: [
          { row: ROW_A, kind: 'update' },
          { row: ROW_B, kind: 'insert' },
        ],
        columns: [],
      },
      history: {
        [ROW_A]: [
          entry({ version: 46, change: 460, actingBot: BOT, columns: ['c1'] }),
          entry({ version: 44, change: 440, columns: ['c1'] }),
          entry({ version: 43, change: 430, actor: SERVICE_USER }),
          entry({ version: 40, change: 400, columns: ['c1'] }),
        ],
        [ROW_B]: [
          entry({
            version: 41,
            change: 410,
            actor: SERVICE_USER,
            kind: 'insert',
          }),
          entry({ version: 47, change: 470 }),
        ],
      },
    });
    const report = await readTableChanges(client, {
      databaseId: DB,
      tableId: TABLE,
      since: 40,
      who: WHO,
    });
    expect(urls[0]).toBe(
      `${BASE}/databases/${DB}/tables/${TABLE}/changes?since=40`
    );
    expect(urls.slice(1)).toEqual([
      `${BASE}/databases/${DB}/tables/${TABLE}/rows/${ROW_A}/history`,
      `${BASE}/databases/${DB}/tables/${TABLE}/rows/${ROW_B}/history`,
    ]);
    expect(report.version).toBe(46);
    expect(report.needsFullRead).toBe(false);
    expect(report.skipped).toBe(2);
    expect(report.changes.map((c) => [c.rowId, c.version, c.author])).toEqual([
      [ROW_A, 44, 'owner'],
      [ROW_A, 46, 'agent'],
    ]);
    expect(report.changes[1]?.actingBot).toBe(BOT);
  });

  test('asks for a full read when the journal cannot list every row, still attributing those it lists', async () => {
    for (const changes of [
      {
        version: 50,
        complete: false,
        truncated: false,
        rows: [{ row: ROW_A, kind: 'update' }],
        columns: [],
      },
      {
        version: 50,
        complete: true,
        truncated: true,
        rows: [{ row: ROW_A, kind: 'update' }],
        columns: [],
      },
    ]) {
      const { client } = journalClient({
        changes,
        history: { [ROW_A]: [entry({ version: 49 })] },
      });
      const report = await readTableChanges(client, {
        databaseId: DB,
        tableId: TABLE,
        since: 45,
        who: WHO,
      });
      expect(report.needsFullRead).toBe(true);
      expect(report.changes.map((c) => c.version)).toEqual([49]);
    }
    const many = {
      version: 50,
      complete: true,
      truncated: false,
      rows: [ROW_A, ROW_B, ROW_C].map((row) => ({ row, kind: 'update' })),
      columns: [{ column: ROW_C, kind: 'rename' }],
    };
    const { client, urls } = journalClient({ changes: many, history: {} });
    const report = await readTableChanges(client, {
      databaseId: DB,
      tableId: TABLE,
      since: 45,
      who: WHO,
      maxRows: 2,
    });
    expect(report.needsFullRead).toBe(true);
    expect(urls).toHaveLength(3);
    expect(report.columns).toEqual([{ column: ROW_C, kind: 'rename' }]);
  });

  test('with nothing new keeps its place', async () => {
    const { client } = journalClient({
      changes: {
        version: 40,
        complete: true,
        truncated: false,
        rows: [],
        columns: [],
      },
      history: {},
    });
    const report = await readTableChanges(client, {
      databaseId: DB,
      tableId: TABLE,
      since: 40,
      who: WHO,
    });
    expect(report).toMatchObject({
      version: 40,
      needsFullRead: false,
      changes: [],
      skipped: 0,
    });
  });
});

describe('a change to a Details row', () => {
  let schema: JobsSchema;
  beforeAll(async () => {
    const dss = new FakeDss();
    const client = new SupaMacClient({
      apiKey: KEY,
      baseUrl: BASE,
      fetch: dss.fetch,
    });
    schema = (
      await ensureJobsSchema({
        client,
        pins: undefined,
        ownerEmail: OWNER_EMAIL,
        save: async () => {},
      })
    ).schema;
  });

  test("reads the owner's decision and value in the spec's terms", async () => {
    const d = schema.tables.details.columns;
    const ownerColumn = '0190d5a8-0000-7000-c000-0000000000ff';
    const { client } = journalClient({
      changes: {
        version: 60,
        complete: true,
        truncated: false,
        rows: [{ row: ROW_A, kind: 'update' }],
        columns: [],
      },
      history: {
        [ROW_A]: [
          entry({
            version: 60,
            columns: [
              d.Status.id,
              d.Value.id,
              d.Day.id,
              d.Name.id,
              ownerColumn,
            ],
            before: {
              [d.Status.id]: {
                type: 'options',
                value: [{ id: d.Status.options.get('Found')?.id as string }],
              },
              [d.Value.id]: { type: 'text', value: '07:00' },
            },
            after: {
              [d.Status.id]: {
                type: 'options',
                value: [{ label: 'confirmed' }],
              },
              [d.Value.id]: { type: 'text', value: '07:30' },
              [d.Day.id]: { type: 'date', value: '2027-03-14T00:00:00Z' },
            },
          }),
        ],
      },
    });
    const report = await readTableChanges(client, {
      databaseId: DB,
      tableId: schema.tables.details.id,
      since: 59,
      who: WHO,
    });
    const change = report.changes[0];
    if (change === undefined) throw new Error('no change');
    expect(change.author).toBe('owner');
    expect(detailEdit(change, schema.tables.details)).toEqual({
      status: {
        before: { kind: 'option', option: 'Found' },
        after: { kind: 'option', option: 'Confirmed' },
      },
      value: {
        before: { kind: 'text', text: '07:00' },
        after: { kind: 'text', text: '07:30' },
      },
      quote: undefined,
      day: {
        before: { kind: 'empty' },
        after: { kind: 'text', text: '2027-03-14' },
      },
      others: ['Name'],
      unpinned: [ownerColumn],
    });
  });

  test('reads an option the owner added as foreign and a cleared cell as empty', () => {
    const status = schema.tables.details.columns.Status;
    expect(
      cellOption(status, {
        type: 'options',
        value: [{ id: '0190d5a8-0000-7000-c000-000000000999' }],
      })
    ).toEqual({
      kind: 'foreign',
      label: '0190d5a8-0000-7000-c000-000000000999',
    });
    expect(
      cellOption(status, { type: 'options', value: [{ label: 'Maybe' }] })
    ).toEqual({ kind: 'foreign', label: 'Maybe' });
    expect(cellOption(status, { type: 'clear' })).toEqual({ kind: 'empty' });
    expect(cellOption(status, undefined)).toEqual({ kind: 'empty' });
    expect(cellText({ type: 'number', value: 2 })).toEqual({
      kind: 'text',
      text: '2',
    });
    expect(cellText({ type: 'rows', value: [ROW_A] })).toEqual({
      kind: 'other',
      type: 'rows',
    });
  });
});
