// The service's health (docs/supamac/jobs.md, Operations: Health): each
// loop's last success for `/health` and the Status row, and a Telegram note
// when SupaMac, Anthropic, Telegram or the mailbox stops answering, at most
// hourly, and another when it recovers.
//
// Invariants:
// - A connection's state is kept in the state volume, so a restart neither
//   repeats a note nor forgets one owed.
// - The owner is told of a connection's state only when it differs from what
//   they were last told, and at most once an hour per connection: a state
//   that flips and flips back within the hour says nothing; one that stays
//   changed is told at the first report after the hour.
// - State is written only when a connection's state or what the owner was
//   told changes; loop successes stay in memory and are written by the
//   Status tick.
// - A connection's detail and the last error are kept and told with every
//   secret the logger knows masked.
// - The Status row's last error is the newest of what was recorded
//   (`recordError`) and every loop's last failure, the ways in included: a
//   refused mailbox login or Telegram token shows there with its reason.
// - `/health` is healthy while every loop that is on has succeeded within
//   its allowance (five intervals); a loop that has not run yet counts from
//   the service's start.

import type { Logger } from '../log';
import type { Connection, Notifier } from './notify';
import type { StateStore } from './state';

const HOUR_MS = 3_600_000;

export interface LoopHealth {
  readonly name: string;
  readonly intervalMs: number;
  readonly lastSuccess?: string | undefined;
  readonly lastError?: string | undefined;
  readonly lastErrorAt?: string | undefined;
  readonly healthy: boolean;
}

export interface HealthReport {
  readonly ok: boolean;
  readonly startedAt: string;
  readonly loops: readonly LoopHealth[];
  readonly connections: Readonly<
    Record<string, { up: boolean; since: string }>
  >;
}

interface LoopRecord {
  intervalMs: number;
  lastSuccess?: string | undefined;
  lastError?: string | undefined;
  lastErrorAt?: string | undefined;
}

export class HealthMonitor {
  private readonly loops = new Map<string, LoopRecord>();
  private readonly startedAt: Date;

  constructor(
    private readonly state: StateStore,
    private readonly notifier: Notifier,
    private readonly clock: () => Date,
    private readonly logger?: Logger | undefined
  ) {
    this.startedAt = clock();
  }

  /** Declares a loop that `/health` watches. */
  register(name: string, intervalMs: number): void {
    const saved = this.state.value.health.loops[name];
    this.loops.set(name, {
      intervalMs,
      lastSuccess: saved?.lastSuccess,
      lastError: saved?.lastError,
      lastErrorAt: saved?.lastErrorAt,
    });
  }

  succeeded(name: string): void {
    const loop = this.loops.get(name);
    if (loop !== undefined) loop.lastSuccess = this.clock().toISOString();
  }

  failed(name: string, error: string): void {
    const loop = this.loops.get(name);
    const at = this.clock().toISOString();
    if (loop !== undefined) {
      loop.lastError = error;
      loop.lastErrorAt = at;
    }
  }

  lastSuccess(name: string): string | undefined {
    return this.loops.get(name)?.lastSuccess;
  }

  /** The newest error: recorded, or a loop's last failure named by its loop. */
  lastError(): { readonly text: string; readonly at: string } | undefined {
    let newest = this.state.value.notes.lastError;
    for (const [name, loop] of this.loops) {
      if (loop.lastError === undefined || loop.lastErrorAt === undefined)
        continue;
      if (
        newest === undefined ||
        Date.parse(loop.lastErrorAt) > Date.parse(newest.at)
      ) {
        const text =
          this.logger?.secrets.mask(loop.lastError) ?? loop.lastError;
        newest = {
          text: `${name}: ${text}`.slice(0, 500),
          at: loop.lastErrorAt,
        };
      }
    }
    return newest;
  }

  /** Records the last error for the Status row, with every secret masked. */
  async recordError(text: string): Promise<void> {
    const masked = this.logger?.secrets.mask(text) ?? text;
    await this.state.update((s) => {
      s.notes.lastError = {
        text: masked.slice(0, 500),
        at: this.clock().toISOString(),
      };
    });
  }

  /** Writes the loops' last successes to the state; called by the Status tick. */
  async persist(): Promise<void> {
    await this.state.update((s) => {
      for (const [name, loop] of this.loops) {
        s.health.loops[name] = {
          ...(loop.lastSuccess !== undefined
            ? { lastSuccess: loop.lastSuccess }
            : {}),
          ...(loop.lastError !== undefined
            ? { lastError: loop.lastError }
            : {}),
          ...(loop.lastErrorAt !== undefined
            ? { lastErrorAt: loop.lastErrorAt }
            : {}),
        };
      }
    });
  }

  /** Reports whether a connection answered; tells the owner per the header's rule. */
  async connection(
    name: Connection,
    up: boolean,
    detail?: string
  ): Promise<void> {
    const now = this.clock();
    const saved = this.state.value.health.connections[name];
    const current = saved ?? {
      up: true,
      since: now.toISOString(),
      notifiedUp: true,
    };
    const flipped = current.up !== up;
    const owed =
      (flipped ? up : current.up) !== current.notifiedUp &&
      (current.notifiedAt === undefined ||
        now.getTime() - Date.parse(current.notifiedAt) >= HOUR_MS);
    if (!flipped && !owed && saved !== undefined) return;
    const next = {
      up,
      since: flipped ? now.toISOString() : current.since,
      ...(up
        ? {}
        : detail !== undefined
          ? {
              detail: (this.logger?.secrets.mask(detail) ?? detail).slice(
                0,
                300
              ),
            }
          : {}),
      notifiedUp: owed ? up : current.notifiedUp,
      ...(owed
        ? { notifiedAt: now.toISOString() }
        : current.notifiedAt !== undefined
          ? { notifiedAt: current.notifiedAt }
          : {}),
    };
    await this.state.update((s) => {
      s.health.connections[name] = next;
    });
    if (owed) {
      try {
        await this.notifier.connection({
          connection: name,
          up,
          since: next.since,
          ...(next.detail !== undefined ? { detail: next.detail } : {}),
        });
      } catch (error) {
        this.logger?.warn('connection note not delivered', {
          connection: name,
          error,
        });
        await this.state.update((s) => {
          const c = s.health.connections[name];
          if (c !== undefined) {
            c.notifiedUp = current.notifiedUp;
            if (current.notifiedAt === undefined) delete c.notifiedAt;
            else c.notifiedAt = current.notifiedAt;
          }
        });
      }
    }
  }

  report(): HealthReport {
    const now = this.clock().getTime();
    const loops: LoopHealth[] = [];
    for (const [name, loop] of this.loops) {
      const since = Date.parse(
        loop.lastSuccess ?? this.startedAt.toISOString()
      );
      const lastSuccessAfterStart =
        loop.lastSuccess !== undefined &&
        Date.parse(loop.lastSuccess) >= this.startedAt.getTime();
      const reference = lastSuccessAfterStart
        ? since
        : this.startedAt.getTime();
      loops.push({
        name,
        intervalMs: loop.intervalMs,
        lastSuccess: loop.lastSuccess,
        lastError: loop.lastError,
        lastErrorAt: loop.lastErrorAt,
        healthy: now - reference <= 5 * loop.intervalMs,
      });
    }
    const connections: Record<string, { up: boolean; since: string }> = {};
    for (const [name, c] of Object.entries(this.state.value.health.connections))
      connections[name] = { up: c.up, since: c.since };
    return {
      ok: loops.every((l) => l.healthy),
      startedAt: this.startedAt.toISOString(),
      loops,
      connections,
    };
  }
}
