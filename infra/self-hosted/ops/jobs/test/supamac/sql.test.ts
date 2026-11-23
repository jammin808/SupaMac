import { beforeAll, describe, expect, test } from 'bun:test';
import { getDatabaseRequest, type SqlOutcome } from '../../src/supamac/api';
import { SupaMacClient } from '../../src/supamac/client';
import {
  ensureJobsSchema,
  resolveSchema,
  type JobsPins,
} from '../../src/supamac/schema';
import {
  addColumnSql,
  addOptionsSql,
  byteLength,
  cellLiteral,
  columnDefinitionSql,
  createTableSql,
  decodeRows,
  execute,
  insertRow,
  insertRows,
  MAX_BATCH_ROWS,
  MAX_STATEMENT_BYTES,
  quoteIdent,
  readDate,
  selectRows,
  SqlError,
  type SqlErrorKind,
  sqlNumber,
  sqlText,
  updateRow,
  updateRows,
} from '../../src/supamac/sql';
import type { JobsSchema, RowInput } from '../../src/supamac/tables';
import { BASE, FakeDss, OWNER_EMAIL } from './fake-dss';

// The lexer of crates/database_sql/src/parse/lexer.rs, for what statements
// must tokenize to: whitespace is [ \t\r\n], strings are '…' with '' inside,
// quoted identifiers "…" with "" inside, and nothing else is accepted.
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
      throw new Error(`the lexer refuses ${JSON.stringify(rest.slice(0, 20))}`);
  }
  return out;
}

function sqlError(fn: () => unknown, kind: SqlErrorKind): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SqlError);
    expect((error as SqlError).kind).toBe(kind);
    return;
  }
  throw new Error(`expected a ${kind} SqlError`);
}

const KEY = ['mak', 'c3'.repeat(32)].join('_');
const ROW = '0190d5a8-0000-7000-a000-000000000001';
const ROW2 = '0190d5a8-0000-7000-a000-000000000002';
const DOC = '0190d5a8-0000-7000-a000-000000000003';

let dss: FakeDss;
let pins: JobsPins;
let schema: JobsSchema;

beforeAll(async () => {
  dss = new FakeDss();
  const client = new SupaMacClient({
    apiKey: KEY,
    baseUrl: BASE,
    fetch: dss.fetch,
  });
  const result = await ensureJobsSchema({
    client,
    pins: undefined,
    ownerEmail: OWNER_EMAIL,
    save: async () => {},
  });
  pins = result.pins;
  schema = result.schema;
});

describe('the one literal function', () => {
  test('doubles quotes and keeps everything else', () => {
    expect(sqlText("Crew call 07:00 at Acme's yard")).toBe(
      "'Crew call 07:00 at Acme''s yard'"
    );
    expect(sqlText("''")).toBe("''''''");
    expect(sqlText('C:\\Shows\\"Leeds"\n-- not a comment; DROP')).toBe(
      '\'C:\\Shows\\"Leeds"\n-- not a comment; DROP\''
    );
    expect(sqlText('£350/day + VAT · 🎭')).toBe("'£350/day + VAT · 🎭'");
  });

  test('removes NUL and unpaired surrogates', () => {
    expect(sqlText('a\u0000b')).toBe("'ab'");
    expect(sqlText('x\ud83cy\udfadz')).toBe("'xyz'");
    expect(sqlText('\ud83c\udfad')).toBe("'\ud83c\udfad'");
  });

  test('round-trips any text through the lexer as one string literal', () => {
    const alphabet = [
      "'",
      "''",
      '"',
      '\\',
      '\u0000',
      '\ud83c',
      '\udfad',
      '🎭',
      '\n',
      '\r',
      '\t',
      ';',
      '--',
      ' ',
      'a',
      'é',
      '\u2028',
      '[',
      ']',
      '%',
      '_',
    ];
    let state = 0x2545f491;
    const next = (): number => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state;
    };
    for (let i = 0; i < 500; i++) {
      let text = '';
      const length = next() % 24;
      for (let j = 0; j < length; j++)
        text += alphabet[next() % alphabet.length];
      const tokens = lex(
        `UPDATE "Details" SET "Value" = ${sqlText(text)} WHERE row_id = ${sqlText(ROW)}`
      );
      const strings = tokens.filter((t) => t.kind === 'string');
      expect(strings).toHaveLength(2);
      const expected = text.replaceAll('\u0000', '');
      // An unpaired surrogate is removed; a pair is kept.
      expect(strings[0]?.text).toBe(
        Array.from(expected)
          .filter((c) => !/^[\ud800-\udfff]$/.test(c))
          .join('')
      );
    }
  });

  test('numbers are finite and never negative zero', () => {
    expect(sqlNumber(350)).toBe('350');
    expect(sqlNumber(0.5)).toBe('0.5');
    expect(sqlNumber(-0)).toBe('0');
    expect(sqlNumber(1e21)).toBe('1e+21');
    // The dialect's number token takes the exponent with its sign.
    expect(lex(sqlNumber(1e21))).toEqual([{ kind: 'number', text: '1e+21' }]);
    sqlError(() => sqlNumber(Number.NaN), 'bad_value');
    sqlError(() => sqlNumber(Number.POSITIVE_INFINITY), 'bad_value');
  });
});

describe('identifiers', () => {
  test('are quoted with quotes doubled', () => {
    expect(quoteIdent('Source row')).toBe('"Source row"');
    expect(quoteIdent('The "real" name')).toBe('"The ""real"" name"');
    expect(lex(quoteIdent('The "real" name'))).toEqual([
      { kind: 'qident', text: 'The "real" name' },
    ]);
  });

  test('are refused rather than changed when not well formed', () => {
    sqlError(() => quoteIdent(''), 'bad_identifier');
    sqlError(() => quoteIdent('a\u0000b'), 'bad_identifier');
    sqlError(() => quoteIdent('a\ud83c'), 'bad_identifier');
  });
});

describe('statements', () => {
  test('a Sources row', () => {
    const [statement, ...rest] = insertRows(schema, 'sources', [
      {
        Name: 'Fwd: Call sheet, Acme Productions',
        Via: 'Email',
        From: 'production@example.com',
        Sent: '2027-03-01',
        Received: '2027-03-01T09:15:00.000Z',
        Status: 'Processing',
        Hash: 'e3b0c442',
        'Message ID': '<abc@example.com>',
        'Thread IDs': '<root@example.com>',
        Attempts: 0,
      },
    ]);
    expect(rest).toEqual([]);
    expect(statement?.sql).toBe(
      'INSERT INTO "Sources" ("Name", "Via", "From", "Sent", "Received", "Status", "Hash", "Message ID", "Thread IDs", "Attempts") VALUES ' +
        "('Fwd: Call sheet, Acme Productions', 'Email', 'production@example.com', '2027-03-01', '2027-03-01T09:15:00.000Z', 'Processing', 'e3b0c442', '<abc@example.com>', '<root@example.com>', 0)"
    );
    expect(statement?.databaseId).toBe(schema.databaseId);
    expect(statement?.tableId).toBe(schema.tables.sources.id);
    expect(statement?.kind).toBe('insert');
    expect(statement?.rows).toBe(1);
  });

  test('the details of one source in one statement, with relations, a document and NULLs', () => {
    const rows: RowInput<'details'>[] = [
      {
        Name: 'Call time: 07:00',
        'Source row': [ROW],
        Field: 'Call time',
        Label: 'Crew call',
        Value: '07:00',
        Day: '2027-03-13',
        Quote: 'Crew call 07:00',
        Source: DOC,
        Page: 2,
        Status: 'Found',
        Check: '',
        Received: '2027-03-01T09:15:00Z',
      },
      {
        Name: 'Unconfirmed · Hotel: Example Hotel, ZZ1 1ZZ (TBC)',
        'Source row': [ROW],
        Job: [],
        Field: 'Hotel',
        Label: 'Hotel',
        Value: 'Example Hotel (TBC)',
        Quote: "Hotel: Example Hotel (TBC) — 'tbc'",
        Status: 'Needs review',
        Check: 'the quote says TBC',
      },
    ];
    const statements = insertRows(schema, 'details', rows);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toBe(
      'INSERT INTO "Details" ("Name", "Job", "Source row", "Field", "Label", "Value", "Day", "Quote", "Source", "Page", "Status", "Check", "Received") VALUES ' +
        `('Call time: 07:00', NULL, ['${ROW}'], 'Call time', 'Crew call', '07:00', '2027-03-13', 'Crew call 07:00', '${DOC}', 2, 'Found', '', '2027-03-01T09:15:00Z'), ` +
        `('Unconfirmed · Hotel: Example Hotel, ZZ1 1ZZ (TBC)', NULL, ['${ROW}'], 'Hotel', 'Hotel', 'Example Hotel (TBC)', NULL, 'Hotel: Example Hotel (TBC) — ''tbc''', NULL, NULL, 'Needs review', 'the quote says TBC', NULL)`
    );
    expect(statements[0]?.rows).toBe(2);
    expect(() => lex(statements[0]?.sql as string)).not.toThrow();
  });

  test('a Jobs row from derived cells: a date range, tags, a number and cleared cells', () => {
    const statement = updateRow(schema, 'jobs', ROW, {
      Dates: { start: '2027-03-13', end: '2027-03-15' },
      Days: '2027-03-13, 2027-03-14, 2027-03-15',
      'Not confirmed': ['Venue', 'Rate', 'Venue'],
      'Needs review': 2,
      Rate: 350,
      Currency: 'GBP',
      'Rate basis': 'per day + VAT',
      Contacts: null,
      Travel: null,
      Updated: '2027-03-01',
    });
    expect(statement.sql).toBe(
      'UPDATE "Jobs" SET "Dates" = \'2027-03-13/2027-03-15\', "Days" = \'2027-03-13, 2027-03-14, 2027-03-15\', "Travel" = NULL, "Contacts" = NULL, ' +
        `"Rate" = 350, "Currency" = 'GBP', "Rate basis" = 'per day + VAT', "Not confirmed" = ['Venue', 'Rate'], "Needs review" = 2, "Updated" = '2027-03-01' ` +
        `WHERE row_id = '${ROW}'`
    );
    expect(updateRow(schema, 'jobs', ROW, { 'Not confirmed': [] }).sql).toBe(
      `UPDATE "Jobs" SET "Not confirmed" = NULL WHERE row_id = '${ROW}'`
    );
  });

  test('filing details under a job by their ids', () => {
    const [statement] = updateRows(schema, 'details', [ROW, ROW2, ROW], {
      Job: [ROW2],
    });
    expect(statement?.sql).toBe(
      `UPDATE "Details" SET "Job" = ['${ROW2}'] WHERE row_id IN ('${ROW}', '${ROW2}')`
    );
    expect(statement?.rows).toBe(2);
    expect(updateRows(schema, 'details', [], { Job: [ROW2] })).toEqual([]);
  });

  test('reads narrowed by job, status and text', () => {
    const statement = selectRows(
      schema,
      'details',
      ['Name', 'Field', 'Value', 'Status', 'Day'],
      {
        where: {
          op: 'and',
          conditions: [
            { op: 'has', column: 'Job', value: ROW },
            { op: 'in', column: 'Status', values: ['Found', 'Confirmed'] },
            {
              op: 'or',
              conditions: [
                { op: '=', column: 'Field', value: 'Hotel' },
                { op: 'contains', column: 'Value', text: "acme's" },
              ],
            },
            { op: 'is not null', column: 'Day' },
            { op: '>=', column: 'Day', value: '2027-03-13' },
          ],
        },
        orderBy: [{ column: 'Day' }, { column: 'Received', descending: true }],
        limit: 100,
        offset: 200,
      }
    );
    expect(statement.sql).toBe(
      'SELECT "Name", "Field", "Value", "Status", "Day" FROM "Details" WHERE ' +
        `("Job" HAS '${ROW}' AND "Status" IN ('Found', 'Confirmed') AND ("Field" = 'Hotel' OR "Value" LIKE '%acme''s%') AND "Day" IS NOT NULL AND "Day" >= '2027-03-13') ` +
        'ORDER BY "Day" ASC, "Received" DESC LIMIT 100 OFFSET 200'
    );
    expect(
      selectRows(schema, 'sources', ['Hash'], {
        where: { op: '=', column: 'Hash', value: 'e3b0' },
      }).sql
    ).toBe(`SELECT "Hash" FROM "Sources" WHERE "Hash" = 'e3b0'`);
    expect(
      selectRows(schema, 'jobs', ['Name'], {
        where: { op: 'row_id in', ids: [ROW, ROW2] },
      }).sql
    ).toBe(`SELECT "Name" FROM "Jobs" WHERE row_id IN ('${ROW}', '${ROW2}')`);
  });

  test('write the names and labels the owner renamed to', async () => {
    const db = dss.databases[0];
    const details = db?.tables.find((t) => t.id === schema.tables.details.id);
    const value = details?.columns.find(
      (c) => c.id === schema.tables.details.columns.Value.id
    );
    const found = details?.columns
      .find((c) => c.id === schema.tables.details.columns.Status.id)
      ?.options.find((o) => o.label === 'Found');
    if (
      db === undefined ||
      details === undefined ||
      value === undefined ||
      found === undefined
    ) {
      throw new Error('the fake lacks the Details table');
    }
    value.name = 'What it "says"';
    found.label = 'Found it';
    details.name = "Owner's details";
    try {
      // Read the database again as a later start does, through the fake's own route.
      const client = new SupaMacClient({
        apiKey: KEY,
        baseUrl: BASE,
        fetch: dss.fetch,
      });
      const detail = await client.send(getDatabaseRequest(db.id));
      const renamed = resolveSchema(pins, detail);
      expect(
        updateRow(renamed, 'details', ROW, { Value: '08:00', Status: 'Found' })
          .sql
      ).toBe(
        `UPDATE "Owner's details" SET "What it ""says""" = '08:00', "Status" = 'Found it' WHERE row_id = '${ROW}'`
      );
    } finally {
      value.name = 'Value';
      found.label = 'Found';
      details.name = 'Details';
    }
  });
});

describe('values the service refuses', () => {
  test('an option that is not one of the fixed labels, in any case', () => {
    sqlError(
      () =>
        updateRow(schema, 'details', ROW, {
          Status: 'Definitely Found' as 'Found',
        }),
      'unknown_option'
    );
    sqlError(
      () =>
        updateRow(schema, 'details', ROW, {
          Field: 'call time' as 'Call time',
        }),
      'unknown_option'
    );
    sqlError(
      () =>
        updateRow(schema, 'jobs', ROW, {
          'Not confirmed': ['Venue', "x'); DROP" as 'Venue'],
        }),
      'unknown_option'
    );
    sqlError(
      () =>
        selectRows(schema, 'details', ['Name'], {
          where: { op: '=', column: 'Field', value: 'Hotel; --' },
        }),
      'unknown_option'
    );
  });

  test('ids that are not UUIDs, impossible dates and backwards ranges', () => {
    sqlError(
      () => updateRow(schema, 'details', ROW, { Job: ["' OR 1=1 --"] }),
      'bad_value'
    );
    sqlError(
      () => updateRow(schema, 'details', ROW, { Source: 'Call sheet.pdf' }),
      'bad_value'
    );
    sqlError(
      () => updateRow(schema, 'details', "x' OR '1", { Check: 'x' }),
      'bad_value'
    );
    sqlError(
      () => updateRow(schema, 'details', ROW, { Day: '2027-02-30' }),
      'bad_value'
    );
    sqlError(
      () => updateRow(schema, 'details', ROW, { Day: '13/03/2027' }),
      'bad_value'
    );
    sqlError(
      () =>
        updateRow(schema, 'details', ROW, { Received: '2027-03-01T09:15Z' }),
      'bad_value'
    );
    sqlError(
      () =>
        updateRow(schema, 'jobs', ROW, {
          Dates: { start: '2027-03-15', end: '2027-03-13' },
        }),
      'bad_value'
    );
    sqlError(
      () => updateRow(schema, 'details', ROW, { Page: Number.NaN }),
      'bad_value'
    );
    sqlError(
      () =>
        updateRow(schema, 'details', ROW, { Page: '2' as unknown as number }),
      'bad_value'
    );
  });

  test('statements that would change nothing or test a column the wrong way', () => {
    sqlError(() => updateRow(schema, 'details', ROW, {}), 'empty');
    sqlError(() => selectRows(schema, 'details', []), 'empty');
    sqlError(
      () =>
        selectRows(schema, 'details', ['Name'], {
          where: { op: 'in', column: 'Status', values: [] },
        }),
      'empty'
    );
    sqlError(
      () =>
        selectRows(schema, 'details', ['Name'], {
          where: { op: '=', column: 'Job', value: ROW },
        }),
      'bad_value'
    );
    sqlError(
      () =>
        selectRows(schema, 'details', ['Name'], {
          where: { op: 'has', column: 'Value', value: 'x' },
        }),
      'bad_value'
    );
    sqlError(
      () =>
        selectRows(schema, 'details', ['Name'], {
          where: { op: 'contains', column: 'Page', text: '2' },
        }),
      'bad_value'
    );
    sqlError(
      () => selectRows(schema, 'details', ['Nope' as 'Name']),
      'unknown_column'
    );
    sqlError(
      () => selectRows(schema, 'details', ['Name'], { offset: 5 }),
      'bad_value'
    );
  });
});

describe('batches', () => {
  test('stay under 256 KiB and 500 rows, keeping every row in order', () => {
    const quote = `Crew call 07:00 — ${'x'.repeat(480)}`;
    const rows: RowInput<'details'>[] = Array.from(
      { length: 1800 },
      (_, i) => ({
        Name: `Call time: ${i}`,
        'Source row': [ROW],
        Field: 'Call time',
        Value: String(i),
        Quote: quote,
        Status: 'Found',
      })
    );
    const statements = insertRows(schema, 'details', rows);
    expect(statements.length).toBeGreaterThan(3);
    let seen = 0;
    for (const s of statements) {
      expect(byteLength(s.sql)).toBeLessThan(MAX_STATEMENT_BYTES);
      expect(s.rows ?? 0).toBeLessThanOrEqual(MAX_BATCH_ROWS);
      const names = [...s.sql.matchAll(/\('Call time: (\d+)'/g)].map((m) =>
        Number(m[1])
      );
      expect(names).toEqual(
        Array.from({ length: names.length }, (_, k) => seen + k)
      );
      seen += names.length;
      expect(
        s.sql.startsWith(
          'INSERT INTO "Details" ("Name", "Source row", "Field", "Value", "Quote", "Status") VALUES ('
        )
      ).toBe(true);
    }
    expect(seen).toBe(1800);
  });

  test('of wide rows split by size, multi-byte text counted in bytes', () => {
    const rows: RowInput<'sources'>[] = Array.from({ length: 10 }, () => ({
      Note: '€'.repeat(30_000),
    }));
    const statements = insertRows(schema, 'sources', rows);
    expect(statements.length).toBeGreaterThan(1);
    for (const s of statements)
      expect(byteLength(s.sql)).toBeLessThan(MAX_STATEMENT_BYTES);
    expect(statements.reduce((n, s) => n + (s.rows ?? 0), 0)).toBe(10);
  });

  test('refuse one row that cannot fit', () => {
    sqlError(
      () =>
        insertRows(schema, 'sources', [
          { Note: 'x'.repeat(MAX_STATEMENT_BYTES) },
        ]),
      'too_large'
    );
    sqlError(
      () =>
        insertRow(schema, 'sources', { Note: 'x'.repeat(MAX_STATEMENT_BYTES) }),
      'too_large'
    );
    sqlError(
      () =>
        updateRow(schema, 'sources', ROW, {
          Note: 'x'.repeat(MAX_STATEMENT_BYTES),
        }),
      'too_large'
    );
  });

  test('of row ids for one update', () => {
    const ids = Array.from(
      { length: 12_000 },
      (_, i) => `0190d5a8-0000-7000-b000-${i.toString(16).padStart(12, '0')}`
    );
    const statements = updateRows(schema, 'details', ids, {
      Status: 'Replaced',
    });
    expect(statements.length).toBe(Math.ceil(12_000 / MAX_BATCH_ROWS));
    for (const s of statements) {
      expect(byteLength(s.sql)).toBeLessThan(MAX_STATEMENT_BYTES);
      expect(s.sql.endsWith(')')).toBe(true);
    }
  });
});

describe('reading rows', () => {
  test('decodes cells by column, with dates as written and foreign options kept apart', () => {
    const statement = selectRows(schema, 'details', [
      'Name',
      'Status',
      'Day',
      'Received',
      'Job',
      'Source',
      'Page',
    ]);
    const status = schema.tables.details.columns.Status;
    const outcome: SqlOutcome = {
      changesApplied: 0,
      insertedRowIds: [],
      newVersions: {},
      readVersions: { [schema.tables.details.id]: 12 },
      truncatedTables: [],
      statement: { kind: 'select' },
      result: {
        columns: [
          { name: 'Name', kind: 'text' },
          {
            name: 'Status',
            kind: 'select',
            options: [{ id: 'owner-option', label: 'Maybe' }],
          },
          { name: 'Day', kind: 'date' },
          { name: 'Received', kind: 'date' },
          { name: 'Job', kind: 'entity' },
          { name: 'Source', kind: 'entity' },
          { name: 'Page', kind: 'number' },
        ],
        rowIds: [ROW, ROW2],
        rows: [
          [
            { type: 'text', value: 'Call time: 07:00' },
            {
              type: 'options',
              value: [status.options.get('Confirmed')?.id as string],
            },
            { type: 'date', value: '2027-03-13T00:00:00Z' },
            { type: 'date', value: '2027-03-01T09:15:00Z' },
            { type: 'entities', value: [ROW2] },
            { type: 'entities', value: [DOC] },
            { type: 'number', value: 2 },
          ],
          [
            null,
            { type: 'options', value: ['owner-option'] },
            null,
            null,
            null,
            null,
            null,
          ],
        ],
      },
    };
    const read = decodeRows(schema, statement, outcome);
    expect(read.partial).toBe(false);
    expect(read.rows).toEqual([
      {
        rowId: ROW,
        values: {
          Name: 'Call time: 07:00',
          Status: 'Confirmed',
          Day: '2027-03-13',
          Received: '2027-03-01T09:15:00Z',
          Job: [ROW2],
          Source: DOC,
          Page: 2,
        },
        foreign: [],
      },
      {
        rowId: ROW2,
        values: {
          Name: null,
          Status: null,
          Day: null,
          Received: null,
          Job: [],
          Source: null,
          Page: null,
        },
        foreign: [{ column: 'Status', label: 'Maybe' }],
      },
    ]);
    expect(
      decodeRows(schema, statement, {
        ...outcome,
        truncatedTables: ['Details'],
      }).partial
    ).toBe(true);
    sqlError(
      () => decodeRows(schema, statement, { ...outcome, result: null }),
      'bad_cell'
    );
  });

  test('tags and date ranges', () => {
    const statement = selectRows(schema, 'jobs', ['Not confirmed', 'Dates']);
    const notConfirmed = schema.tables.jobs.columns['Not confirmed'];
    const read = decodeRows(schema, statement, {
      changesApplied: 0,
      insertedRowIds: [],
      newVersions: {},
      readVersions: {},
      truncatedTables: [],
      statement: { kind: 'select' },
      result: {
        columns: [
          { name: 'Not confirmed', kind: 'select' },
          { name: 'Dates', kind: 'dateRange' },
        ],
        rowIds: [ROW],
        rows: [
          [
            {
              type: 'options',
              value: [
                notConfirmed.options.get('Venue')?.id as string,
                notConfirmed.options.get('Rate')?.id as string,
              ],
            },
            {
              type: 'dateRange',
              value: {
                start: '2027-03-13T00:00:00Z',
                end: '2027-03-15T00:00:00.000Z',
              },
            },
          ],
        ],
      },
    });
    expect(read.rows[0]?.values).toEqual({
      'Not confirmed': ['Venue', 'Rate'],
      Dates: { start: '2027-03-13', end: '2027-03-15' },
    });
  });

  test('a date that is not midnight UTC stays an instant', () => {
    expect(readDate('2027-03-13T00:00:00Z')).toBe('2027-03-13');
    expect(readDate('2027-03-13T00:00:00.000+00:00')).toBe('2027-03-13');
    expect(readDate('2027-03-13T07:00:00Z')).toBe('2027-03-13T07:00:00Z');
  });
});

describe('running a statement', () => {
  test('sends its database and guards, and returns the versions it wrote', async () => {
    const bodies: unknown[] = [];
    const client = new SupaMacClient({
      apiKey: KEY,
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init.body as string));
        return new Response(
          JSON.stringify({
            tableDatabases: {},
            changesApplied: 1,
            insertedRowIds: [ROW],
            newVersions: { [schema.tables.sources.id]: 18 },
            readVersions: {},
            truncatedTables: [],
            result: null,
            statement: {
              kind: 'insert',
              tableId: schema.tables.sources.id,
              tableName: 'Sources',
            },
          }),
          { status: 200 }
        );
      },
    });
    const statement = insertRow(schema, 'sources', {
      Name: 'PO 4500123',
      Via: 'Folder',
      Status: 'Processing',
    });
    const done = await execute(client, statement, {
      baseVersions: { [schema.tables.sources.id]: 17 },
    });
    expect(done.written).toEqual([
      { tableId: schema.tables.sources.id, version: 18 },
    ]);
    expect(done.outcome.insertedRowIds).toEqual([ROW]);
    expect(bodies).toEqual([
      {
        sql: statement.sql,
        databaseId: schema.databaseId,
        baseVersions: { [schema.tables.sources.id]: 17 },
      },
    ]);
  });
});

describe('schema statements', () => {
  const name = (key: string): string =>
    ({
      jobs: 'Jobs',
      sources: 'Sources',
      details: 'Details',
      status: 'Status',
    })[key] as string;
  const DB = '0190d5a8-0000-7000-a000-0000000000db';

  test('write each kind of column', () => {
    expect(
      columnDefinitionSql({ name: 'Name', spec: { kind: 'text' } }, name)
    ).toBe('"Name" text');
    expect(
      columnDefinitionSql({ name: 'Dates', spec: { kind: 'date_range' } }, name)
    ).toBe('"Dates" date_range');
    expect(
      columnDefinitionSql({ name: 'Source', spec: { kind: 'document' } }, name)
    ).toBe('"Source" entity(DOCUMENT)');
    expect(
      columnDefinitionSql(
        { name: 'Source row', spec: { kind: 'relation', target: 'sources' } },
        name
      )
    ).toBe('"Source row" relation("Sources")');
    expect(
      columnDefinitionSql(
        {
          name: 'Via',
          spec: { kind: 'select', options: ['Email', "Owner's note"] },
        },
        name
      )
    ).toBe(`"Via" select OPTIONS ('Email', 'Owner''s note')`);
    expect(
      columnDefinitionSql(
        { name: 'Not confirmed', spec: { kind: 'tag', options: ['Venue'] } },
        name
      )
    ).toBe(`"Not confirmed" tag OPTIONS ('Venue')`);
  });

  test('create a table, add a column and add options', () => {
    const create = createTableSql(
      DB,
      'Status',
      [
        { name: 'Name', spec: { kind: 'text' } },
        { name: 'Last error at', spec: { kind: 'date' } },
      ],
      name
    );
    expect(create).toEqual({
      sql: 'CREATE TABLE "Status" ("Name" text, "Last error at" date)',
      databaseId: DB,
      kind: 'schema',
    });
    expect(
      addColumnSql(DB, 'Jobs', { name: 'Rate', spec: { kind: 'number' } }, name)
        .sql
    ).toBe('ALTER TABLE "Jobs" ADD COLUMN "Rate" number');
    expect(addOptionsSql(DB, 'Sources', 'Status', ['Skipped']).sql).toBe(
      `ALTER TABLE "Sources" ALTER COLUMN "Status" ADD OPTIONS ('Skipped')`
    );
    sqlError(() => addOptionsSql(DB, 'Sources', 'Status', []), 'empty');
    sqlError(() => createTableSql(DB, 'Status', [], name), 'empty');
  });

  test('a value for each kind lexes as the dialect reads it', () => {
    for (const [key, value] of [
      ['Day', '2027-03-13'],
      ['Page', 12.5],
      ['Job', [ROW, ROW2]],
      ['Source', DOC],
      ['Status', 'Needs review'],
    ] as const) {
      const column = schema.tables.details.columns[key];
      expect(() => lex(cellLiteral(column, value))).not.toThrow();
    }
  });
});
