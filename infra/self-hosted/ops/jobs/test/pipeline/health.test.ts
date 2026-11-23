import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthMonitor } from '../../src/pipeline/health';
import { RecordingNotifier } from '../../src/pipeline/notify';
import { StateStore } from '../../src/pipeline/state';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const MINUTE = 60_000;

async function setup(): Promise<{
  dir: string;
  clock: { now: number };
  state: StateStore;
  notifier: RecordingNotifier;
  health: HealthMonitor;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-health-'));
  dirs.push(dir);
  const clock = { now: Date.parse('2027-03-05T10:00:00Z') };
  const state = await StateStore.open(dir, {
    clock: () => new Date(clock.now),
  });
  const notifier = new RecordingNotifier();
  return {
    dir,
    clock,
    state,
    notifier,
    health: new HealthMonitor(state, notifier, () => new Date(clock.now)),
  };
}

describe('connection notes', () => {
  test('are sent when a connection stops answering and when it recovers, at most hourly', async () => {
    const { clock, health, notifier } = await setup();
    await health.connection('anthropic', true);
    expect(notifier.of('connection')).toEqual([]);
    await health.connection('anthropic', false, 'the API is overloaded');
    expect(notifier.of('connection')).toEqual([
      expect.objectContaining({
        connection: 'anthropic',
        up: false,
        detail: 'the API is overloaded',
      }),
    ]);
    // Down again, and back up within the hour: nothing more is said yet.
    await health.connection('anthropic', false);
    clock.now += 10 * MINUTE;
    await health.connection('anthropic', true);
    expect(notifier.of('connection')).toHaveLength(1);
    // After the hour, the recovery the owner was not told of is told.
    clock.now += 51 * MINUTE;
    await health.connection('anthropic', true);
    expect(notifier.of('connection').map((c) => c.up)).toEqual([false, true]);
    // A flip and a flip back within the hour says nothing.
    clock.now += 5 * MINUTE;
    await health.connection('anthropic', false);
    clock.now += 5 * MINUTE;
    await health.connection('anthropic', true);
    clock.now += 2 * 60 * MINUTE;
    await health.connection('anthropic', true);
    expect(notifier.of('connection')).toHaveLength(2);
  });

  test('a restart neither repeats a note nor forgets one owed', async () => {
    const { clock, health, notifier, dir } = await setup();
    await health.connection('mail', false, 'login refused');
    expect(notifier.of('connection')).toHaveLength(1);
    const reopened = await StateStore.open(dir, {
      clock: () => new Date(clock.now),
    });
    const again = new HealthMonitor(
      reopened,
      notifier,
      () => new Date(clock.now)
    );
    await again.connection('mail', false);
    expect(notifier.of('connection')).toHaveLength(1);
    clock.now += 61 * MINUTE;
    await again.connection('mail', true);
    expect(notifier.of('connection').map((c) => c.up)).toEqual([false, true]);
  });

  test('a note that is not delivered is owed again', async () => {
    const { clock, health, notifier } = await setup();
    notifier.failing = true;
    await health.connection('supamac', false);
    notifier.failing = false;
    clock.now += MINUTE;
    await health.connection('supamac', false);
    expect(notifier.of('connection')).toEqual([
      expect.objectContaining({ connection: 'supamac', up: false }),
    ]);
  });
});

describe('/health', () => {
  test('is healthy while every loop succeeded within five intervals', async () => {
    const { clock, health } = await setup();
    health.register('edits', MINUTE);
    expect(health.report().ok).toBe(true);
    clock.now += 4 * MINUTE;
    health.succeeded('edits');
    clock.now += 4 * MINUTE;
    expect(health.report().ok).toBe(true);
    clock.now += 2 * MINUTE;
    const report = health.report();
    expect(report.ok).toBe(false);
    expect(report.loops[0]).toMatchObject({ name: 'edits', healthy: false });
  });
});
