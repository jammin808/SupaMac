// A table renamed in SupaMac while the service runs: the service as it
// ships (the real schema step and store) against the fake storage routes,
// whose statements are answered here so the SQL each one names can be read.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '../../src/log';
import { renameAware, type Service, startService } from '../../src/main';
import { PipelineError } from '../../src/pipeline/context';
import { RecordingNotifier } from '../../src/pipeline/notify';
import { SupaMacClient, SupaMacError } from '../../src/supamac/client';
import { ensureJobsSchema, namesChanged } from '../../src/supamac/schema';
import { extract } from '../../src/text/extract';
import { BASE, FakeDss, OWNER_EMAIL } from '../supamac/fake-dss';
import { ScriptedModel } from './harness';

const ENV = {
  JOBS_SUPAMAC_API_KEY: 'test-api-key-not-real', // secret-scan: fixture
  JOBS_SUPAMAC_URL: BASE,
  JOBS_OWNER_EMAIL: OWNER_EMAIL,
  ANTHROPIC_API_KEY: 'sk-ant-api03-example-key', // secret-scan: fixture
  JOBS_MONTHLY_LIMIT_USD: '20',
};

const services: Service[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const ROW = '0190d5a8-0000-7000-8000-0000000000f1';

/** Answers statements as SupaMac would: one naming a table that no longer goes by that name is refused. */
function answerStatements(dss: FakeDss): string[] {
  const statements: string[] = [];
  dss.overrides.set('POST /databases/query', () => {
    const body = dss.seen.at(-1)?.body as { sql: string };
    statements.push(body.sql);
    const tables = dss.databases[0]?.tables.map((t) => t.name) ?? [];
    const named = [...body.sql.matchAll(/(?:INTO|UPDATE|FROM)\s+"([^"]+)"/g)]
      .map((m) => m[1] as string)
      .filter((n) => !tables.includes(n));
    if (named.length > 0)
      return Response.json(
        { message: `no table called ${named[0]}` },
        { status: 400 }
      );
    return Response.json({
      changesApplied: body.sql.startsWith('UPDATE') ? 1 : 0,
      insertedRowIds: body.sql.startsWith('INSERT') ? [ROW] : [],
      newVersions: {},
      readVersions: {},
      truncatedTables: [],
      statement: { kind: body.sql.startsWith('INSERT') ? 'insert' : 'update' },
    });
  });
  return statements;
}

describe('a table renamed while the service runs', () => {
  test('the refused statement is retried under the new name, not failed', async () => {
    const dss = new FakeDss();
    const dir = await mkdtemp(join(tmpdir(), 'jobs-rename-'));
    dirs.push(dir);
    const service = await startService({
      env: { ...ENV, JOBS_STATE_DIR: dir },
      fetch: dss.fetch,
      notifier: new RecordingNotifier(),
      intakes: [],
      logger: new Logger({ sink: () => undefined }),
      messages: new ScriptedModel([]),
      extract: (bytes, hint) => extract(bytes, hint),
      loops: false,
      listen: false,
    });
    services.push(service);
    // The schema is made; from here statements are answered as SupaMac would.
    const statements = answerStatements(dss);

    await service.tick();
    expect(statements.at(-1)).toContain('"Status"');

    const status = dss.databases[0]?.tables.find((t) => t.name === 'Status');
    if (status === undefined) throw new Error('no Status table');
    status.name = 'Service status';

    // The first statement after the rename names the old table and is
    // refused; the service learns the new name and says the step can run
    // again, rather than failing it.
    const error = await service.tick().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PipelineError);
    expect((error as PipelineError).kind).toBe('retryable');

    await service.tick();
    expect(statements.at(-1)).toContain('"Service status"');
  });
});

describe('namesChanged', () => {
  test('reads the names once and sees a renamed table, column or option', async () => {
    const dss = new FakeDss();
    const client = new SupaMacClient({
      apiKey: ENV.JOBS_SUPAMAC_API_KEY,
      baseUrl: BASE,
      fetch: dss.fetch,
    });
    let pins: Parameters<typeof namesChanged>[1] | undefined;
    const { schema } = await ensureJobsSchema({
      client,
      pins: undefined,
      ownerEmail: OWNER_EMAIL,
      save: async (p) => {
        pins = p;
      },
    });
    if (pins === undefined) throw new Error('no pins');
    const db = dss.databases[0];
    if (db === undefined) throw new Error('no database');
    const reads = dss.seen.length;
    expect(await namesChanged(client, pins, schema)).toBe(false);
    expect(dss.seen.length).toBe(reads + 1);

    const sources = db.tables.find((t) => t.name === 'Sources');
    const note = sources?.columns.find((c) => c.name === 'Note');
    if (note === undefined) throw new Error('no Note column');
    note.name = 'Remarks';
    expect(await namesChanged(client, pins, schema)).toBe(true);
    note.name = 'Note';
    const kind = sources?.columns
      .find((c) => c.name === 'Status')
      ?.options.find((o) => o.label === 'Failed');
    if (kind === undefined) throw new Error('no Failed option');
    kind.label = 'Broken';
    expect(await namesChanged(client, pins, schema)).toBe(true);
  });
});

describe('renameAware', () => {
  const refused = new SupaMacError(
    'invalid',
    'POST /databases/query',
    'refused'
  );

  test('a refusal with the names unchanged is passed on as it is', async () => {
    let checks = 0;
    const store = renameAware(
      {
        write: async (): Promise<void> => {
          throw refused;
        },
      },
      async () => {
        checks++;
        return false;
      }
    );
    expect(await store.write().catch((e: unknown) => e)).toBe(refused);
    expect(checks).toBe(1);
  });

  test('only a statement refused as written asks for the check', async () => {
    let checks = 0;
    const other = new SupaMacError('invalid', 'POST /documents/upload', 'no');
    const store = renameAware(
      {
        upload: async (): Promise<void> => {
          throw other;
        },
        count: (): number => 3,
      },
      async () => {
        checks++;
        return true;
      }
    );
    expect(await store.upload().catch((e: unknown) => e)).toBe(other);
    expect(store.count()).toBe(3);
    expect(checks).toBe(0);
  });
});
