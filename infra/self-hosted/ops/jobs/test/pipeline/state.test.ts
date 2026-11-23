import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger, type SpendEntry } from '../../src/ai/spend';
import {
  emptyState,
  RETENTION_DAYS,
  STATE_FILE,
  StateError,
  StateLedger,
  StateStore,
} from '../../src/pipeline/state';

const dirs: string[] = [];

async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'jobs-state-'));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const HASH = 'a'.repeat(64);
const DAY = 86_400_000;

describe('the state file', () => {
  test('starts empty, and an update is on disk, whole, before it is current', async () => {
    const d = await dir();
    const state = await StateStore.open(d);
    expect(state.value).toEqual(emptyState());
    await state.update((s) => {
      s.hashIndex[HASH] = 'row-1';
      s.timeZone = 'Europe/Paris';
    });
    const disk = JSON.parse(await readFile(join(d, STATE_FILE), 'utf8'));
    expect(disk.version).toBe(1);
    expect(disk.hashIndex[HASH]).toBe('row-1');
    expect((await StateStore.open(d)).value.timeZone).toBe('Europe/Paris');
    // No temp file is left beside it.
    expect((await readdir(d)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('an update that does not validate changes nothing, on disk or in memory', async () => {
    const d = await dir();
    const state = await StateStore.open(d);
    await expect(
      state.update((s) => {
        (s.telegram as { offset: unknown }).offset = 'not a number';
      })
    ).rejects.toMatchObject({ kind: 'invalid' });
    expect(state.value.telegram.offset).toBeUndefined();
    const disk = JSON.parse(await readFile(join(d, STATE_FILE), 'utf8'));
    expect(disk.telegram.offset).toBeUndefined();
    // Later updates still run.
    await state.update((s) => {
      s.telegram.offset = 5;
    });
    expect(state.value.telegram.offset).toBe(5);
  });

  test('a file that is not JSON, does not validate, or is of another version stops the start and is left as it is', async () => {
    for (const [text, kind] of [
      ['{not json', 'corrupt'],
      [JSON.stringify({ ...emptyState(), hashIndex: { x: 7 } }), 'corrupt'],
      [JSON.stringify({ ...emptyState(), version: 2 }), 'version'],
    ] as const) {
      const d = await dir();
      await writeFile(join(d, STATE_FILE), text);
      const error = await StateStore.open(d).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StateError);
      expect((error as StateError).kind).toBe(kind);
      expect(await readFile(join(d, STATE_FILE), 'utf8')).toBe(text);
    }
  });

  test('updates run one at a time, in order', async () => {
    const state = await StateStore.open(await dir());
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        state.update((s) => {
          s.telegram.processed.push({ id: i, at: '2027-03-01T00:00:00.000Z' });
        })
      )
    );
    expect(state.value.telegram.processed.map((u) => u.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => i)
    );
  });
});

describe('bounds', () => {
  test('processed updates and the replies of Processed sources go after 90 days; others stay', async () => {
    let now = Date.parse('2027-03-01T00:00:00Z');
    const d = await dir();
    const state = await StateStore.open(d, { clock: () => new Date(now) });
    const reply = {
      text: '{}',
      savedAt: new Date(now).toISOString(),
      model: 'claude-opus-5-5',
      inputTokens: 1,
      outputTokens: 1,
      usd: 0.01,
      jobs: [],
      attachmentsLeftOut: [],
    };
    const meta = (status: 'Processed' | 'Needs review') => ({
      hash: '',
      via: 'Email' as const,
      name: 'x',
      received: new Date(now).toISOString(),
      stage: 'done' as const,
      uploadNotes: [],
      status,
      finishedAt: new Date(now).toISOString(),
    });
    await state.update((s) => {
      s.telegram.processed.push({ id: 1, at: new Date(now).toISOString() });
      s.replies.h1 = reply;
      s.replies.h2 = reply;
      s.hashIndex.h1 = 's1';
      s.hashIndex.h2 = 's2';
      s.sources.s1 = { ...meta('Processed'), hash: 'h1' };
      s.sources.s2 = { ...meta('Needs review'), hash: 'h2' };
      s.tables.t = { seen: 10, written: [9, 10, 11] };
    });
    now += (RETENTION_DAYS - 1) * DAY;
    await state.prune();
    expect(state.value.telegram.processed).toHaveLength(1);
    expect(Object.keys(state.value.replies).sort()).toEqual(['h1', 'h2']);
    expect(state.value.tables.t?.written).toEqual([11]);
    now += 2 * DAY;
    await state.prune();
    expect(state.value.telegram.processed).toEqual([]);
    expect(Object.keys(state.value.replies)).toEqual(['h2']);
  });

  test('the spool holds bytes by hash only, and a Failed source’s bytes go after 90 days', async () => {
    let now = Date.parse('2027-03-01T00:00:00Z');
    const state = await StateStore.open(await dir(), {
      clock: () => new Date(now),
    });
    await state.spool(HASH, new Uint8Array([1, 2, 3]));
    expect(await state.readSpool(HASH)).toEqual(new Uint8Array([1, 2, 3]));
    await expect(
      state.spool('../escape', new Uint8Array([1]))
    ).rejects.toMatchObject({ kind: 'invalid' });
    await state.update((s) => {
      s.sources.s = {
        hash: HASH,
        via: 'Telegram',
        name: 'x',
        received: new Date(now).toISOString(),
        stage: 'done',
        uploadNotes: [],
        status: 'Failed',
        finishedAt: new Date(now).toISOString(),
      };
    });
    await state.pruneSpool();
    expect(await state.readSpool(HASH)).toBeDefined();
    now += (RETENTION_DAYS + 1) * DAY;
    await state.pruneSpool();
    expect(await state.readSpool(HASH)).toBeUndefined();
  });
});

describe('Telegram', () => {
  test('the link code is made once, spent once, and every later /start is refused', async () => {
    const state = await StateStore.open(await dir());
    const code = await state.linkCode();
    expect(code).toMatch(/^[A-Z2-9]{10}$/);
    expect(await state.linkCode()).toBe(code);
    expect(await state.spendLinkCode('WRONG', 42)).toBe(false);
    expect(await state.spendLinkCode((code as string).toLowerCase(), 42)).toBe(
      true
    );
    expect(state.ownerId).toBe(42);
    expect(await state.spendLinkCode(code as string, 99)).toBe(false);
    expect(state.ownerId).toBe(42);
    expect(await state.linkCode()).toBeUndefined();
  });

  test('an owner id set in the settings needs no code', async () => {
    const state = await StateStore.open(await dir());
    await state.setOwnerId(7);
    expect(await state.linkCode()).toBeUndefined();
    expect(state.ownerId).toBe(7);
  });

  test('a handled update is recorded and the offset moves past it', async () => {
    const state = await StateStore.open(await dir());
    await state.markUpdateProcessed(100);
    await state.markUpdateProcessed(100);
    expect(state.isUpdateProcessed(100)).toBe(true);
    expect(state.isUpdateProcessed(101)).toBe(false);
    expect(state.value.telegram.offset).toBe(101);
    expect(state.value.telegram.processed).toHaveLength(1);
  });
});

describe('the spend ledger', () => {
  test('keeps the month’s computed total, as the memory ledger does', async () => {
    const state = await StateStore.open(await dir());
    const ledger = new StateLedger(state);
    const memory = new MemoryLedger();
    const entry: SpendEntry = {
      month: '2027-03',
      at: '2027-03-05T10:00:00.000Z',
      purpose: 'extraction',
      key: HASH,
      model: 'claude-opus-5-5',
      attempts: [],
      tokens: {
        input: 1000,
        output: 500,
        cacheRead: 200,
        cacheWrite: 0,
        cacheWrite1h: 0,
      },
      usd: 0.0144,
      computed: true,
      label: 'computed from token counts at the configured prices',
    };
    await ledger.record(entry);
    await ledger.record({ ...entry, usd: 0.01 });
    memory.record(entry);
    memory.record({ ...entry, usd: 0.01 });
    expect(ledger.spent('2027-03')).toBeCloseTo(memory.spent('2027-03'), 10);
    expect(ledger.spent('2027-04')).toBe(0);
    expect(state.value.spend.entries.at(-1)).toMatchObject({
      input: 1200,
      output: 500,
      key: HASH,
    });
  });
});
