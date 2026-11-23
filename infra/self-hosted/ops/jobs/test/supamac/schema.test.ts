import { describe, expect, test } from 'bun:test';
import {
  BOOKING_OPTIONS,
  DETAIL_STATUSES,
  FIELD_NAMES,
  JOBS_COLUMN_TYPES,
  JOBS_COLUMNS,
  SOURCE_KINDS,
  SOURCE_STATUSES,
  VIA_OPTIONS,
} from '../../src/model';
import {
  type FetchLike,
  SupaMacClient,
  SupaMacError,
} from '../../src/supamac/client';
import {
  ensureJobsSchema,
  type JobsPins,
  JobsPinsSchema,
  SchemaError,
  type SchemaErrorKind,
} from '../../src/supamac/schema';
import {
  columnsOf,
  NOT_CONFIRMED_OPTIONS,
  TABLES,
  type TableKey,
} from '../../src/supamac/tables';
import {
  BASE,
  FakeDss,
  type FakeTable,
  OWNER_EMAIL,
  OWNER_USER,
  SERVICE_USER,
} from './fake-dss';

const KEY = ['mak', 'f'.repeat(64)].join('_');

function client(dss: FakeDss): SupaMacClient {
  return new SupaMacClient({ apiKey: KEY, baseUrl: BASE, fetch: dss.fetch });
}

interface Store {
  pins: JobsPins | undefined;
  saves: number;
}

function store(): Store & { save: (p: JobsPins) => Promise<void> } {
  const s: Store & { save: (p: JobsPins) => Promise<void> } = {
    pins: undefined,
    saves: 0,
    save: async (p) => {
      // The state volume keeps JSON: round-trip it as the pipeline will.
      s.pins = JobsPinsSchema.parse(JSON.parse(JSON.stringify(p)));
      s.saves++;
    },
  };
  return s;
}

let viewCounter = 0;
const newId = (): string => {
  viewCounter++;
  return `0190d5a8-0000-7000-9000-${viewCounter.toString(16).padStart(12, '0')}`;
};

async function run(
  dss: FakeDss,
  s: ReturnType<typeof store>,
  ownerEmail = OWNER_EMAIL,
  fetch?: FetchLike
) {
  const via =
    fetch === undefined
      ? client(dss)
      : new SupaMacClient({ apiKey: KEY, baseUrl: BASE, fetch });
  return ensureJobsSchema({
    client: via,
    pins: s.pins,
    ownerEmail,
    save: s.save,
    newId,
  });
}

/** The SQL a request carries, if it is a query. */
function sqlOf(init: {
  body?: string | Uint8Array | undefined;
}): string | undefined {
  return typeof init.body === 'string'
    ? (JSON.parse(init.body) as { sql?: string }).sql
    : undefined;
}

async function expectSchemaError(
  promise: Promise<unknown>,
  kind: SchemaErrorKind
): Promise<SchemaError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaError);
    expect((error as SchemaError).kind).toBe(kind);
    return error as SchemaError;
  }
  throw new Error(`expected a ${kind} SchemaError`);
}

function table(dss: FakeDss, name: string): FakeTable {
  const t = dss.databases[0]?.tables.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no table ${name}`);
  return t;
}

describe('the first start', () => {
  test('makes the Jobs database with every table, column, option, view and folder, and shares them', async () => {
    const dss = new FakeDss();
    const s = store();
    const result = await run(dss, s);

    expect(dss.databases).toHaveLength(1);
    const db = dss.databases[0];
    expect(db?.name).toBe('Jobs');
    expect(db?.tables.map((t) => t.name)).toEqual([
      'Jobs',
      'Sources',
      'Details',
      'Status',
    ]);

    const jobs = table(dss, 'Jobs');
    expect(jobs.columns.map((c) => c.name)).toEqual([...JOBS_COLUMNS]);
    const kinds = Object.fromEntries(
      jobs.columns.map((c) => [c.name, c.dataType])
    );
    for (const column of JOBS_COLUMNS) {
      const expected = {
        title: 'STRING',
        text: 'STRING',
        select: 'SELECT_STRING',
        date_range: 'DATE_RANGE',
        date: 'DATE',
        number: 'NUMBER',
        tags: 'TAG',
      }[JOBS_COLUMN_TYPES[column]];
      expect(kinds[column]).toBe(expected);
    }
    expect(
      jobs.columns
        .find((c) => c.name === 'Booking')
        ?.options.map((o) => o.label)
    ).toEqual([...BOOKING_OPTIONS]);
    expect(
      jobs.columns
        .find((c) => c.name === 'Not confirmed')
        ?.options.map((o) => o.label)
    ).toEqual([...NOT_CONFIRMED_OPTIONS]);

    const details = table(dss, 'Details');
    expect(details.columns.map((c) => c.name)).toEqual([
      'Name',
      'Job',
      'Source row',
      'Field',
      'Label',
      'Value',
      'Day',
      'Quote',
      'Source',
      'Page',
      'Status',
      'Check',
      'Received',
    ]);
    expect(
      details.columns
        .find((c) => c.name === 'Field')
        ?.options.map((o) => o.label)
    ).toEqual([...FIELD_NAMES]);
    expect(
      details.columns
        .find((c) => c.name === 'Status')
        ?.options.map((o) => o.label)
    ).toEqual([...DETAIL_STATUSES]);
    expect(details.columns.find((c) => c.name === 'Job')?.link).toBe(jobs.id);
    const sources = table(dss, 'Sources');
    expect(details.columns.find((c) => c.name === 'Source row')?.link).toBe(
      sources.id
    );
    expect(details.columns.find((c) => c.name === 'Source')).toMatchObject({
      dataType: 'ENTITY',
      entity: 'DOCUMENT',
      multi: false,
    });

    expect(sources.columns.map((c) => c.name)).toEqual([
      'Name',
      'Document',
      'Text',
      'Kind',
      'Via',
      'From',
      'Sent',
      'Received',
      'Job',
      'Status',
      'Hash',
      'Message ID',
      'Thread IDs',
      'Attempts',
      'Input tokens',
      'Output tokens',
      'Note',
    ]);
    expect(
      sources.columns
        .find((c) => c.name === 'Kind')
        ?.options.map((o) => o.label)
    ).toEqual([...SOURCE_KINDS]);
    expect(
      sources.columns.find((c) => c.name === 'Via')?.options.map((o) => o.label)
    ).toEqual([...VIA_OPTIONS]);
    expect(
      sources.columns
        .find((c) => c.name === 'Status')
        ?.options.map((o) => o.label)
    ).toEqual([...SOURCE_STATUSES]);
    expect(sources.columns.find((c) => c.name === 'Job')?.link).toBe(jobs.id);

    const status = table(dss, 'Status');
    expect(status.columns.map((c) => c.name)).toEqual(
      Object.keys(TABLES.status.columns)
    );

    // Views.
    expect(jobs.views.map((v) => [v.name, v.layout.kind])).toEqual([
      ['Timeline', 'timeline'],
      ['Board', 'board'],
    ]);
    const timeline = jobs.views[0]?.layout as Record<string, unknown>;
    expect(timeline.range).toBe(
      jobs.columns.find((c) => c.name === 'Dates')?.id
    );
    expect(timeline.colorBy).toBe(
      jobs.columns.find((c) => c.name === 'Booking')?.id
    );
    const board = jobs.views[1]?.layout as {
      groupBy: string;
      lanes: { key: { kind: string; id?: string } }[];
    };
    const booking = jobs.columns.find((c) => c.name === 'Booking');
    expect(board.groupBy).toBe(booking?.id as string);
    expect(board.lanes.map((l) => l.key)).toEqual([
      { kind: 'none' },
      ...(booking?.options ?? []).map((o) => ({ kind: 'option', id: o.id })),
    ]);
    expect(details.views.map((v) => v.name)).toEqual(['Needs review']);
    const needsReviewId = details.columns
      .find((c) => c.name === 'Status')
      ?.options.find((o) => o.label === 'Needs review')?.id;
    expect(details.views[0]?.query).toEqual({
      filter: {
        conjunction: 'and',
        conditions: [
          {
            kind: 'condition',
            column: details.columns.find((c) => c.name === 'Status')?.id,
            test: {
              kind: 'options',
              operator: 'isAnyOf',
              options: [needsReviewId],
            },
          },
        ],
      },
      sort: [
        {
          column: details.columns.find((c) => c.name === 'Received')?.id,
          direction: 'descending',
        },
      ],
    });
    expect(sources.views.map((v) => v.name)).toEqual(['Problems']);
    const problemOptions = (
      sources.views[0]?.query as {
        filter: { conditions: { test: { options: string[] } }[] };
      }
    ).filter.conditions[0]?.test.options;
    const sourceStatus = sources.columns.find((c) => c.name === 'Status');
    const problemIds = ['Failed', 'Needs review', 'Skipped'].map(
      (l) =>
        sourceStatus?.options.find((o) => o.label === l)?.id ?? `no ${l} option`
    );
    expect(problemOptions).toEqual(problemIds);

    // Folders.
    expect(dss.projects.map((p) => [p.name, p.userId])).toEqual([
      ['Job intake', SERVICE_USER],
      ['Job sources', SERVICE_USER],
    ]);

    // Shares: the owner, with edit, and nobody else.
    expect([...dss.grants]).toEqual([
      [`database:${db?.id}`, new Map([[OWNER_USER, 'edit']])],
      [`project:${dss.projects[0]?.id}`, new Map([[OWNER_USER, 'edit']])],
      [`project:${dss.projects[1]?.id}`, new Map([[OWNER_USER, 'edit']])],
    ]);

    // Pins: every id, and the resolved schema agrees with the fake.
    const pins = result.pins;
    expect(pins.complete).toBe(true);
    expect(pins.serviceUserId).toBe(SERVICE_USER);
    expect(pins.ownerUserId).toBe(OWNER_USER);
    expect(pins.databaseId).toBe(db?.id as string);
    expect(s.pins).toEqual(pins);
    for (const key of ['jobs', 'sources', 'details', 'status'] as TableKey[]) {
      const fake = table(dss, TABLES[key].name);
      expect(pins.tables[key]?.id).toBe(fake.id);
      for (const [columnKey] of columnsOf(key)) {
        const column = fake.columns.find((c) => c.name === columnKey);
        expect(pins.tables[key]?.columns[columnKey]?.id).toBe(
          column?.id as string
        );
        for (const option of column?.options ?? []) {
          expect(
            pins.tables[key]?.columns[columnKey]?.options?.[option.label]
          ).toBe(option.id);
        }
      }
    }
    expect(pins.views).toEqual({
      jobsTimeline: jobs.views[0]?.id,
      jobsBoard: jobs.views[1]?.id,
      detailsNeedsReview: details.views[0]?.id,
      sourcesProblems: sources.views[0]?.id,
    });
    expect(pins.folders).toEqual({
      intake: dss.projects[0]?.id,
      sources: dss.projects[1]?.id,
    });
    expect(
      result.schema.tables.details.columns.Status.options.get('Needs review')
    ).toEqual({
      id: needsReviewId as string,
      label: 'Needs review',
    });
    expect(result.schema.tables.jobs.sqlName).toBe('"Jobs"');
    expect(result.schema.folders).toEqual(
      pins.folders as { intake: string; sources: string }
    );
    expect(result.changes).toContain('made the Jobs database');
    expect(result.notes).toEqual([]);

    // Every schema statement named the database.
    for (const seen of dss.seen.filter((x) => x.path === '/databases/query')) {
      expect((seen.body as { databaseId: string }).databaseId).toBe(
        db?.id as string
      );
    }
  });

  test('a later start with nothing changed writes nothing and resolves the same ids', async () => {
    const dss = new FakeDss();
    const s = store();
    const first = await run(dss, s);
    const writes = dss.writes().length;
    const second = await run(dss, s);
    expect(dss.writes()).toHaveLength(writes);
    expect(second.pins).toEqual(first.pins);
    expect(second.changes).toEqual([]);
    expect(second.notes).toEqual([]);
    expect(dss.databases).toHaveLength(1);
    expect(dss.projects).toHaveLength(2);
  });

  test('a database named Jobs this account owns but has not pinned stops the service', async () => {
    const dss = new FakeDss();
    dss.addDatabase('jobs', 'Table 1');
    const s = store();
    const error = await expectSchemaError(run(dss, s), 'unpinned_existing');
    expect(error.message).toContain('second one');
    expect(dss.databases).toHaveLength(1);
    expect(dss.writes()).toEqual([]);
  });

  test("the example database the web app makes on the account's first sign-in does not stop it", async () => {
    const dss = new FakeDss();
    const starter = dss.addDatabase('Getting started', 'Ideas');
    const result = await run(dss, store());
    expect(result.pins.complete).toBe(true);
    expect(result.schema.databaseId).not.toBe(starter.id);
    expect(dss.databases).toHaveLength(2);
    expect(starter.tables.map((t) => t.name)).toEqual(['Ideas']);
  });

  test('any other database this account owns stops the first start before anything is made', async () => {
    const shapes: [string, (dss: FakeDss) => void][] = [
      [
        'a renamed Jobs database',
        (dss) => dss.addDatabase('Work 2027', 'Jobs'),
      ],
      [
        'the example, renamed',
        (dss) => dss.addDatabase('Ideas board', 'Ideas'),
      ],
      [
        'the example, with a table added',
        (dss) => {
          const starter = dss.addDatabase('Getting started', 'Ideas');
          starter.tables.push({
            id: dss.id(),
            name: 'Jobs',
            version: 1,
            columns: [],
            views: [],
          });
        },
      ],
    ];
    for (const [, prepare] of shapes) {
      const dss = new FakeDss();
      prepare(dss);
      const error = await expectSchemaError(
        run(dss, store()),
        'unpinned_existing'
      );
      expect(error.message).toContain('second one');
      expect(dss.databases).toHaveLength(1);
      expect(dss.writes()).toEqual([]);
    }
  });

  test('a trashed unpinned database does not stop the first start', async () => {
    const dss = new FakeDss();
    const old = dss.addDatabase('Jobs', 'Jobs');
    old.trashedAt = dss.now();
    await run(dss, store());
    expect(dss.databases.filter((d) => d.trashedAt === null)).toHaveLength(1);
  });

  test('an owner address that is the jobs account itself is refused', async () => {
    const dss = new FakeDss();
    await expectSchemaError(
      run(dss, store(), 'jobs@example.com'),
      'owner_invalid'
    );
    await expectSchemaError(
      run(new FakeDss(), store(), 'not an address'),
      'owner_invalid'
    );
  });
});

describe('a setup interrupted at any step', () => {
  test('resumes from its pins without making anything twice', async () => {
    const reference = new FakeDss();
    const refStore = store();
    await run(reference, refStore);
    const totalSaves = refStore.saves;
    expect(totalSaves).toBeGreaterThan(20);

    for (let crashAt = 1; crashAt <= totalSaves; crashAt++) {
      const dss = new FakeDss();
      const s = store();
      let calls = 0;
      const crashing = async (p: JobsPins): Promise<void> => {
        calls++;
        if (calls === crashAt) throw new Error('the container stopped');
        await s.save(p);
      };
      await expect(
        ensureJobsSchema({
          client: client(dss),
          pins: s.pins,
          ownerEmail: OWNER_EMAIL,
          save: crashing,
          newId,
        })
      ).rejects.toThrow('the container stopped');

      if (crashAt === 1) {
        // The database was made but its id never saved: the next start stops
        // rather than make a second one.
        await expectSchemaError(run(dss, s), 'unpinned_existing');
        expect(dss.databases).toHaveLength(1);
        continue;
      }
      const result = await run(dss, s);
      expect(result.pins.complete).toBe(true);
      expect(dss.databases).toHaveLength(1);
      expect(dss.projects).toHaveLength(2);
      const db = dss.databases[0];
      expect(db?.tables.map((t) => t.name)).toEqual([
        'Jobs',
        'Sources',
        'Details',
        'Status',
      ]);
      for (const t of db?.tables ?? []) {
        const names = t.columns.map((c) => c.name);
        expect(new Set(names).size).toBe(names.length);
        expect(names).toEqual(
          columnsOf(
            (
              {
                Jobs: 'jobs',
                Sources: 'sources',
                Details: 'details',
                Status: 'status',
              } as const
            )[t.name as 'Jobs']
          ).map(([k]) => k)
        );
        for (const c of t.columns)
          expect(new Set(c.options.map((o) => o.label)).size).toBe(
            c.options.length
          );
      }
      expect(db?.tables.flatMap((t) => t.views.map((v) => v.name))).toEqual([
        'Timeline',
        'Board',
        'Problems',
        'Needs review',
      ]);
      const again = await run(dss, s);
      expect(again.changes).toEqual([]);
    }
  });
});

describe('later starts', () => {
  async function made() {
    const dss = new FakeDss();
    const s = store();
    await run(dss, s);
    return { dss, s };
  }

  test('follow renamed tables, columns, options, views and folders by id', async () => {
    const { dss, s } = await made();
    const details = table(dss, 'Details');
    details.name = 'Job details';
    const value = details.columns.find((c) => c.name === 'Value');
    if (value === undefined) throw new Error('no Value');
    value.name = 'What it says';
    const status = details.columns.find((c) => c.name === 'Status');
    const found = status?.options.find((o) => o.label === 'Found');
    if (found === undefined) throw new Error('no Found');
    found.label = 'Found it';
    const view = details.views[0];
    if (view !== undefined) view.name = 'To check';
    const folder = dss.projects[0];
    if (folder !== undefined) folder.name = 'Drop files here';
    const writes = dss.writes().length;

    const result = await run(dss, s);
    expect(dss.writes()).toHaveLength(writes);
    expect(result.schema.tables.details.sqlName).toBe('"Job details"');
    expect(result.schema.tables.details.columns.Value.sqlName).toBe(
      '"What it says"'
    );
    expect(
      result.schema.tables.details.columns.Status.options.get('Found')
    ).toEqual({ id: found.id, label: 'Found it' });
    expect(result.schema.views.detailsNeedsReview).toBe(view?.id as string);
    expect(result.schema.folders.intake).toBe(folder?.id as string);
    expect(result.changes).toEqual([]);
  });

  test('leave columns and options the owner added alone', async () => {
    const { dss, s } = await made();
    const jobs = table(dss, 'Jobs');
    const db = dss.databases[0];
    if (db === undefined) throw new Error('no database');
    dss.addColumn(jobs, { name: 'My notes', type: 'text', options: [] }, db);
    jobs.columns
      .find((c) => c.name === 'Booking')
      ?.options.push({ id: dss.id(), label: 'Maybe' });
    const writes = dss.writes().length;
    const result = await run(dss, s);
    expect(dss.writes()).toHaveLength(writes);
    expect(Object.keys(result.schema.tables.jobs.columns)).not.toContain(
      'My notes'
    );
    expect([
      ...result.schema.tables.jobs.columns.Booking.options.keys(),
    ]).toEqual([...BOOKING_OPTIONS]);
    expect(jobs.columns.find((c) => c.name === 'My notes')).toBeDefined();
  });

  test('add back a column the owner deleted, under a free name when its name is taken', async () => {
    const { dss, s } = await made();
    const details = table(dss, 'Details');
    const before = details.columns.find((c) => c.name === 'Check');
    details.columns = details.columns.filter(
      (c) => c.name !== 'Check' && c.name !== 'Quote'
    );
    const db = dss.databases[0];
    if (db === undefined) throw new Error('no database');
    // The owner made their own Quote column, of another type.
    dss.addColumn(details, { name: 'Quote', type: 'number', options: [] }, db);
    const ownerQuote = details.columns.find((c) => c.name === 'Quote');

    const result = await run(dss, s);
    const check = details.columns.find((c) => c.name === 'Check');
    expect(check?.id).not.toBe(before?.id as string);
    expect(result.pins.tables.details?.columns.Check?.id).toBe(
      check?.id as string
    );
    const quote = details.columns.find((c) => c.name === 'Quote 2');
    expect(quote?.dataType).toBe('STRING');
    expect(result.schema.tables.details.columns.Quote.sqlName).toBe(
      '"Quote 2"'
    );
    expect(details.columns.find((c) => c.name === 'Quote')).toEqual(
      ownerQuote as NonNullable<typeof ownerQuote>
    );
    expect(result.notes).toEqual([
      'the Quote column of Details was deleted; it is added again',
      'the Check column of Details was deleted; it is added again',
    ]);
    expect(result.changes).toEqual([
      'added the Quote 2 column to Details',
      'added the Check column to Details',
    ]);
  });

  test('add back a select option the owner deleted', async () => {
    const { dss, s } = await made();
    const status = table(dss, 'Sources').columns.find(
      (c) => c.name === 'Status'
    );
    if (status === undefined) throw new Error('no Status');
    const skipped = status.options.find((o) => o.label === 'Skipped');
    status.options = status.options.filter((o) => o.label !== 'Skipped');
    const result = await run(dss, s);
    const again = status.options.find((o) => o.label === 'Skipped');
    expect(again?.id).not.toBe(skipped?.id as string);
    expect(
      result.schema.tables.sources.columns.Status.options.get('Skipped')?.id
    ).toBe(again?.id as string);
    expect(result.changes).toEqual([
      'added the options Skipped to Sources.Status',
    ]);
  });

  test('leave a deleted saved view deleted and say so', async () => {
    const { dss, s } = await made();
    const jobs = table(dss, 'Jobs');
    jobs.views = jobs.views.filter((v) => v.name !== 'Board');
    const writes = dss.writes().length;
    const result = await run(dss, s);
    expect(dss.writes()).toHaveLength(writes);
    expect(result.notes).toEqual([
      'the Jobs view "Board" was deleted; it is left deleted',
    ]);
    expect(result.schema.views.jobsBoard).toBeUndefined();
    expect(result.schema.views.jobsTimeline).toBe(jobs.views[0]?.id as string);
  });

  test('stop on a trashed, missing or foreign database, never making a second', async () => {
    const trashed = await made();
    const db = trashed.dss.databases[0];
    if (db === undefined) throw new Error('no database');
    db.trashedAt = trashed.dss.now();
    await expectSchemaError(run(trashed.dss, trashed.s), 'database_trashed');
    expect(trashed.dss.databases).toHaveLength(1);

    const missing = await made();
    missing.dss.databases.splice(0, 1);
    await expectSchemaError(run(missing.dss, missing.s), 'database_missing');
    expect(missing.dss.databases).toHaveLength(0);

    const foreign = await made();
    const theirs = foreign.dss.databases[0];
    if (theirs === undefined) throw new Error('no database');
    theirs.owner = 'macro|other.account@example.com';
    await expectSchemaError(run(foreign.dss, foreign.s), 'not_owned');
  });

  test('stop on a deleted table or a retyped column', async () => {
    const deleted = await made();
    const db = deleted.dss.databases[0];
    if (db === undefined) throw new Error('no database');
    db.tables = db.tables.filter((t) => t.name !== 'Sources');
    await expectSchemaError(run(deleted.dss, deleted.s), 'table_missing');

    const retyped = await made();
    const page = table(retyped.dss, 'Details').columns.find(
      (c) => c.name === 'Page'
    );
    if (page === undefined) throw new Error('no Page');
    page.dataType = 'STRING';
    await expectSchemaError(run(retyped.dss, retyped.s), 'column_changed');
  });

  test('stop when two pinned options now read the same', async () => {
    const { dss, s } = await made();
    const status = table(dss, 'Details').columns.find(
      (c) => c.name === 'Status'
    );
    const replaced = status?.options.find((o) => o.label === 'Replaced');
    if (replaced === undefined) throw new Error('no Replaced');
    replaced.label = 'found';
    await expectSchemaError(run(dss, s), 'ambiguous_name');
  });

  test('stop on a trashed, missing or foreign folder', async () => {
    const trashed = await made();
    const folder = trashed.dss.projects[1];
    if (folder === undefined) throw new Error('no folder');
    folder.deletedAt = trashed.dss.now();
    await expectSchemaError(run(trashed.dss, trashed.s), 'folder_trashed');
    expect(trashed.dss.projects).toHaveLength(2);

    const missing = await made();
    missing.dss.projects.splice(0, 1);
    await expectSchemaError(run(missing.dss, missing.s), 'folder_missing');
    expect(missing.dss.projects).toHaveLength(1);
  });

  test('share again with the owner when the grant is gone, and with a new owner address', async () => {
    const { dss, s } = await made();
    const db = dss.databases[0];
    dss.grants.delete(`database:${db?.id}`);
    const result = await run(dss, s);
    expect(dss.grants.get(`database:${db?.id}`)).toEqual(
      new Map([[OWNER_USER, 'edit']])
    );
    expect(result.changes).toEqual([
      'shared the Jobs database with the owner, with edit access',
    ]);

    const moved = await run(dss, s, 'Crew.Office@Example.com');
    expect(moved.pins.ownerUserId).toBe('macro|crew.office@example.com');
    expect(
      dss.grants.get(`database:${db?.id}`)?.get('macro|crew.office@example.com')
    ).toBe('edit');
    expect(moved.notes[0]).toContain('owner address changed');
  });
});

describe('later starts, when the server or the owner changes what the service made', () => {
  async function made() {
    const dss = new FakeDss();
    const s = store();
    await run(dss, s);
    return { dss, s };
  }

  test('a pinned column turned into a percentage or a formula, or no longer writable, stops the start', async () => {
    const changes: [
      string,
      (c: NonNullable<ReturnType<FakeTable['columns']['find']>>) => void,
    ][] = [
      ['Rate', (c) => (c.config = { kind: 'percentage' })],
      [
        'Rate',
        (c) => {
          c.config = { kind: 'derived', formula: { kind: 'number', value: 1 } };
          c.writable = false;
        },
      ],
      ['Needs review', (c) => (c.writable = false)],
    ];
    for (const [name, change] of changes) {
      const { dss, s } = await made();
      const column = table(dss, 'Jobs').columns.find((c) => c.name === name);
      if (column === undefined) throw new Error(`no ${name}`);
      change(column);
      const writes = dss.writes().length;
      await expectSchemaError(run(dss, s), 'column_changed');
      expect(dss.writes()).toHaveLength(writes);
    }
  });

  test('columns added in one start, one of whose ADD fails, are each made once', async () => {
    const { dss, s } = await made();
    const details = table(dss, 'Details');
    details.columns = details.columns.filter(
      (c) => c.name !== 'Quote' && c.name !== 'Check'
    );
    // Quote is added and answered; Check's ADD is refused by an unavailable gateway.
    const failing: FetchLike = async (url, init) => {
      if (sqlOf(init)?.includes('ADD COLUMN "Check"') === true)
        return new Response('', { status: 503 });
      return dss.fetch(url, init);
    };
    let thrown: unknown;
    try {
      await run(dss, s, OWNER_EMAIL, failing);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SupaMacError);
    expect((thrown as SupaMacError).retryable).toBe(true);
    expect(s.pins?.adding?.map((a) => [a.table, a.column, a.name])).toEqual([
      ['details', 'Quote', 'Quote'],
      ['details', 'Check', 'Check'],
    ]);

    const result = await run(dss, s);
    expect(
      details.columns
        .map((c) => c.name)
        .filter((n) => /^(quote|check)( \d+)?$/i.test(n))
    ).toEqual(['Quote', 'Check']);
    expect(result.pins.tables.details?.columns.Quote?.id).toBe(
      details.columns.find((c) => c.name === 'Quote')?.id as string
    );
    expect(result.pins.tables.details?.columns.Check?.id).toBe(
      details.columns.find((c) => c.name === 'Check')?.id as string
    );
    expect(result.pins.adding).toBeUndefined();
    expect(result.changes).toEqual([
      'added the Quote column to Details',
      'added the Check column to Details',
    ]);
    expect((await run(dss, s)).changes).toEqual([]);
  });

  test('a column whose ADD answer was lost during setup is adopted, not made twice', async () => {
    const dss = new FakeDss();
    const s = store();
    let dropped = false;
    const dropping: FetchLike = async (url, init) => {
      const response = await dss.fetch(url, init);
      if (!dropped && sqlOf(init)?.includes('ADD COLUMN "Venue"') === true) {
        dropped = true;
        throw new TypeError('connection reset');
      }
      return response;
    };
    await expect(run(dss, s, OWNER_EMAIL, dropping)).rejects.toThrow(
      'gateway did not answer'
    );
    const result = await run(dss, s);
    expect(result.pins.complete).toBe(true);
    const names = table(dss, 'Jobs').columns.map((c) => c.name);
    expect(names.filter((n) => /^venue( \d+)?$/i.test(n))).toEqual(['Venue']);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every grant but the owner’s is named on every start, and none is changed or removed', async () => {
    const { dss, s } = await made();
    const db = dss.databases[0];
    if (db === undefined) throw new Error('no database');
    const intake = dss.projects[0];
    if (intake === undefined) throw new Error('no folder');
    dss.grants
      .get(`database:${db.id}`)
      ?.set('macro|crew.office@example.com', 'view');
    dss.grants
      .get(`project:${intake.id}`)
      ?.set('macro|crew.office@example.com', 'edit');
    const writes = dss.writes().length;
    const first = await run(dss, s);
    expect(dss.writes()).toHaveLength(writes);
    expect(first.notes).toEqual([
      'the Jobs database is also shared with macro|crew.office@example.com (view); the service shares only with the owner and leaves that grant as it is: remove it in SupaMac unless it is meant',
      'the Job intake folder is also shared with macro|crew.office@example.com (edit); the service shares only with the owner and leaves that grant as it is: remove it in SupaMac unless it is meant',
    ]);
    expect((await run(dss, s)).notes).toEqual(first.notes);

    // A new owner address: the former owner's grants are named too.
    const moved = await run(dss, s, 'Crew.Lead@Example.com');
    expect(moved.notes.filter((n) => n.includes(OWNER_USER))).toHaveLength(3);
    expect(dss.grants.get(`database:${db.id}`)?.get(OWNER_USER)).toBe('edit');
  });
});

describe('a folder by the service name', () => {
  test('made before setup began stops the service instead of being adopted', async () => {
    const dss = new FakeDss();
    dss.addProject('Job intake');
    await expectSchemaError(run(dss, store()), 'unpinned_existing');
    expect(dss.projects).toHaveLength(1);
  });

  test('left from an earlier setup whose database is gone stops the first start before a database is made', async () => {
    const dss = new FakeDss();
    dss.addProject('job sources');
    await expectSchemaError(run(dss, store()), 'unpinned_existing');
    expect(dss.databases).toEqual([]);
    expect(dss.writes()).toEqual([]);
  });

  test("the owner's own, shared with the service, does not block it and is never used", async () => {
    const dss = new FakeDss();
    const theirs = dss.addProject('Job intake', OWNER_USER);
    dss.grants.set(`project:${theirs.id}`, new Map([[SERVICE_USER, 'edit']]));
    const result = await run(dss, store());
    expect(result.schema.folders.intake).not.toBe(theirs.id);
    expect(dss.projects.filter((p) => p.userId === SERVICE_USER)).toHaveLength(
      2
    );
  });

  test("of someone else's is not the service's and does not block it", async () => {
    const dss = new FakeDss();
    dss.addProject('Job intake', 'macro|other.account@example.com');
    const result = await run(dss, store());
    expect(dss.projects.filter((p) => p.userId === SERVICE_USER)).toHaveLength(
      2
    );
    expect(result.schema.folders.intake).not.toBe(
      dss.projects[0]?.id as string
    );
  });
});
