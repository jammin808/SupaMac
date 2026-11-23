// The real store's statements, against the fake storage routes: the schema
// is made by ensureJobsSchema itself, and the row statements are answered by
// a queue of outcomes so each statement's SQL can be read.

import { beforeAll, describe, expect, test } from 'bun:test';
import {
  readMarkdownRequest,
  SupaMacStore,
  writeMarkdownRequest,
} from '../../src/pipeline/supamac-store';
import { SupaMacClient, SupaMacError } from '../../src/supamac/client';
import { ensureJobsSchema } from '../../src/supamac/schema';
import type { JobsSchema } from '../../src/supamac/tables';
import { BASE, FakeDss, OWNER_EMAIL } from '../supamac/fake-dss';

const KEY = ['mak', 'e'.repeat(64)].join('_');

let dss: FakeDss;
let schema: JobsSchema;
const answers: (() => Response)[] = [];
const written: { tableId: string; version: number }[][] = [];

function outcome(fields: Record<string, unknown>): () => Response {
  return () =>
    Response.json({
      changesApplied: 0,
      insertedRowIds: [],
      newVersions: {},
      readVersions: {},
      truncatedTables: [],
      statement: { kind: 'insert' },
      ...fields,
    });
}

function lastSql(): { sql: string; body: Record<string, unknown> } {
  const seen = dss.seen.filter((s) => s.path === '/databases/query').at(-1);
  const body = seen?.body as Record<string, unknown>;
  return { sql: String(body.sql), body };
}

let store: SupaMacStore;

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
    save: async () => undefined,
  });
  schema = result.schema;
  dss.overrides.set('POST /databases/query', () => {
    const next = answers.shift();
    if (next === undefined) throw new Error('no answer queued');
    return next();
  });
  store = new SupaMacStore({
    client,
    schema,
    onWrite: (v) => void written.push([...v]),
  });
});

describe('SupaMacStore', () => {
  test('writes all of a source’s details in one INSERT with their Source row, and reports the version', async () => {
    const details = schema.tables.details;
    answers.push(
      outcome({
        changesApplied: 2,
        insertedRowIds: [
          '0190d5a8-0000-7000-8000-00000000a001',
          '0190d5a8-0000-7000-8000-00000000a002',
        ],
        newVersions: { [details.id]: 8 },
      })
    );
    const source = '0190d5a8-0000-7000-8000-00000000b001';
    const ids = await store.insertDetails([
      {
        Name: 'Call time: 07:00',
        'Source row': [source],
        Field: 'Call time',
        Value: '07:00',
        Status: 'Found',
        Quote: "Crew call 07:00 (Sam's)",
      },
      {
        Name: 'Unconfirmed · Hotel: Example Hotel',
        'Source row': [source],
        Field: 'Hotel',
        Value: 'Example Hotel',
        Status: 'Needs review',
        Quote: 'Hotel TBC',
      },
    ]);
    expect(ids).toHaveLength(2);
    const { sql, body } = lastSql();
    expect(body.databaseId).toBe(schema.databaseId);
    expect(sql.startsWith('INSERT INTO "Details" (')).toBe(true);
    expect(sql.match(/\), \(/g)).toHaveLength(1);
    expect(sql).toContain("'Crew call 07:00 (Sam''s)'");
    expect(sql).toContain(`['${source}']`);
    expect(written.at(-1)).toEqual([{ tableId: details.id, version: 8 }]);
  });

  test('writes a Jobs row against the version it was read at, and a conflict is typed', async () => {
    const jobs = schema.tables.jobs;
    const id = '0190d5a8-0000-7000-8000-00000000c001';
    answers.push(
      outcome({
        changesApplied: 1,
        newVersions: { [jobs.id]: 5 },
        statement: { kind: 'update' },
      })
    );
    await store.updateJob(
      id,
      {
        'Call times': 'Sat 13 Mar 2027: 08:00',
        'Not confirmed': ['Call times'],
        Rate: 350,
      },
      { baseVersion: 4 }
    );
    const { sql, body } = lastSql();
    expect(body.baseVersions).toEqual({ [jobs.id]: 4 });
    expect(sql).toContain(`WHERE row_id = '${id}'`);
    expect(sql).toContain('"Not confirmed" = [\'Call times\']');
    answers.push(() =>
      Response.json({ message: 'the table moved on' }, { status: 409 })
    );
    const error = await store
      .updateJob(id, { Rate: 400 }, { baseVersion: 4 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupaMacError);
    expect((error as SupaMacError).kind).toBe('conflict');
  });

  test('looks a source up by its hash and decodes the row', async () => {
    const sources = schema.tables.sources;
    const hash = 'f'.repeat(64);
    const columns = Object.values(sources.columns);
    const row = columns.map((c) => {
      if (c.key === 'Name') return { type: 'text', value: 'invite.pdf' };
      if (c.key === 'Hash') return { type: 'text', value: hash };
      if (c.key === 'Status')
        return { type: 'options', value: [c.options.get('Processing')?.id] };
      if (c.key === 'Job')
        return {
          type: 'entities',
          value: ['0190d5a8-0000-7000-8000-00000000c001'],
        };
      if (c.key === 'Thread IDs')
        return { type: 'text', value: '<a@example.com> <b@example.com>' };
      return null;
    });
    answers.push(
      outcome({
        statement: { kind: 'select' },
        readVersions: { [sources.id]: 3 },
        result: {
          columns: columns.map((c) => ({ name: c.name, kind: c.spec.kind })),
          rowIds: ['0190d5a8-0000-7000-8000-00000000b001'],
          rows: [row],
        },
      })
    );
    const read = await store.sources({ hash });
    expect(lastSql().sql).toContain(`WHERE "Hash" = '${hash}'`);
    expect(read.partial).toBe(false);
    expect(read.rows[0]).toMatchObject({
      name: 'invite.pdf',
      hash,
      status: 'Processing',
      jobIds: ['0190d5a8-0000-7000-8000-00000000c001'],
      threadIds: ['<a@example.com>', '<b@example.com>'],
    });
  });

  test('rewrites a Markdown document only at the revision it was read at', () => {
    const id = '0190d5a8-0000-7000-8000-00000000d001';
    expect(readMarkdownRequest(id)).toMatchObject({
      method: 'GET',
      template: '/documents/{document_id}/markdown',
    });
    expect(writeMarkdownRequest(id, '# Jobs setup\n', 'rev-3')).toMatchObject({
      method: 'PUT',
      template: '/documents/{document_id}/markdown',
      body: {
        kind: 'json',
        value: { markdown: '# Jobs setup\n', expectedRevision: 'rev-3' },
      },
    });
    expect(() => readMarkdownRequest('../etc')).toThrow();
  });
});
