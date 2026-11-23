// A way in (docs/supamac/jobs.md §1) as main.ts starts and stops it: the
// mailbox and Telegram units implement this; the Job intake folder is the
// pipeline's own loop.
//
// Invariants:
// - main.ts starts the mail intake only when its way in is on (its settings
//   are all there, and the AI is configured). It starts the Telegram intake
//   whenever its bot token is set, since the bot also links the owner and
//   delivers every note; that intake takes sources and questions only while
//   `wayOn(config, 'Telegram')`. Both are stopped on shutdown before the
//   pipeline's lane drains.
// - An intake is started before the Jobs database is verified, so its
//   notifier can deliver the schema's notes and a stop's reason; a pipeline
//   step it asks for meanwhile waits for the database, and fails with the
//   start's own error when the start fails. A start that fails stops every
//   intake started before it.
// - An intake hands sources to the pipeline (`processEmail`,
//   `processSource`) and acknowledges or moves what it read only after the
//   result says the source finished or was already recorded. A question
//   goes to `pipeline.ask`, which runs the answer tools over the pinned
//   tables (answers.ts).
// - An intake reports its own loop to `health.succeeded(name)` /
//   `health.failed(name, ...)` and its connection to `health.connection`, so
//   `/health`, the Status row and the hourly notes include it. Its loop name
//   is its `name`: `mail` and `telegram` are the Status row's.

import type { AiClient } from '../ai/anthropic';
import type { Config } from '../config';
import type { Logger } from '../log';
import type { HealthMonitor } from './health';
import type { Notifier } from './notify';
import type { Pipeline } from './pipeline';
import type { StateStore } from './state';

export interface IntakeContext {
  readonly pipeline: Pipeline;
  /**
   * The one AI client, on the one spend ledger, that extraction uses too:
   * questions go through it so the monthly limit covers both. Undefined
   * while the AI settings are missing.
   */
  readonly ai: AiClient | undefined;
  readonly state: StateStore;
  readonly notifier: Notifier;
  readonly logger: Logger;
  readonly config: Config;
  readonly health: HealthMonitor;
  /** The service's clock. */
  readonly clock: () => Date;
  /** The owner's zone: `/tz`'s (`pipeline.setTimeZone`), else `JOBS_TIME_ZONE`. */
  readonly timeZone: () => string;
  /** Aborted when the service stops. */
  readonly signal: AbortSignal;
}

/** One line of the Jobs setup document's check of settings. */
export interface SettingCheck {
  readonly setting: string;
  readonly ok: boolean;
  readonly text: string;
}

export interface Intake {
  /** `mail` or `telegram`: its loop's and connection's name. */
  readonly name: 'mail' | 'telegram';
  start(context: IntakeContext): Promise<void>;
  stop(): Promise<void>;
  /** A check of its settings for the Jobs setup document (a login, a getMe). */
  check?(): Promise<SettingCheck>;
}
