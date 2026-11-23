// The jobs service (docs/supamac/jobs.md): settings, state, the Jobs
// database, the setup document, the loops and `/health`.
//
// Invariants:
// - Nothing is written anywhere before the settings validate and the state
//   opens; a pinned database that is missing or trashed stops the start
//   (schema.ts), the owner is told why, and the service never makes a
//   second one.
// - The intakes start before the schema is verified, since the notifier
//   delivers through the Telegram intake: the schema's notes and a stop's
//   reason reach the owner. Until the schema is verified the pipeline's
//   store holds every call (PendingStore). A start that fails at any step
//   after that stops every intake and loop it started, so nothing keeps the
//   process alive.
// - The whole pins value is saved to the state after every change
//   ensureJobsSchema makes, and again from its result.
// - Each schema note is told to the owner once, not on every start.
// - A loop run that SupaMac refuses as a whole (the key, or the pinned
//   database not found) is told to the owner as SupaMac not answering, with
//   the reason; the next start's schema check stops the service if the
//   database is gone.
// - No setting's value reaches the setup document or the Status row: a
//   check's text and the last error are masked as the logs are.
// - The Status row's spend is the month the AI client counts in
//   (JOBS_TIME_ZONE's).
// - Loops never overlap themselves: the folder poll and the change poll
//   every minute, the resume of Processing sources every minute, and the
//   Status tick every minute (the Status row, the setup document, the
//   loops' health, and a daily prune of the state). Every pipeline step runs
//   on the one lane.
// - `/health` on JOBS_HEALTH_PORT answers 200 while every loop that is on
//   succeeded recently and 503 otherwise, with each loop's last success; it
//   carries no secret and no source content.
// - SIGTERM stops the intakes, then the loops (waiting for a run in
//   flight), then lets the lane drain, then closes the health server.
// - `main` makes the process not dumpable (seal.ts) before anything else,
//   so no extraction child can read the service's secrets; on Linux a seal
//   that fails stops the start.
// - Mail and Telegram are added by their units through `Intake`.

import { serve } from 'bun';
import { AiClient, createSdkClient, type MessagesClient } from './ai/anthropic';
import { monthOf } from './ai/spend';
import {
  type Config,
  loadConfig,
  offText,
  registerSecrets,
  wayOn,
} from './config';
import { Logger } from './log';
import { mailIntakes } from './mail/index';
import {
  Lane,
  type Extractor,
  errorText,
  type PipelineContext,
} from './pipeline/context';
import { HealthMonitor } from './pipeline/health';
import type { Intake, SettingCheck } from './pipeline/intake';
import { type Notifier, NullNotifier } from './pipeline/notify';
import { PendingStore } from './pipeline/pending-store';
import { Pipeline } from './pipeline/pipeline';
import { setupMarkdown, writeSetupDocument } from './pipeline/setup';
import { StateLedger, StateStore } from './pipeline/state';
import type { JobsStore } from './pipeline/store';
import { SupaMacStore } from './pipeline/supamac-store';
import { sealProcess } from './seal';
import { telegramIntake } from './telegram';
import { WATCHED_TABLES } from './supamac/changes';
import { type FetchLike, SupaMacClient, SupaMacError } from './supamac/client';
import { webAppBase } from './supamac/documents';
import {
  ensureJobsSchema,
  type EnsureSchemaResult,
  SchemaError,
} from './supamac/schema';
import type { JobsSchema } from './supamac/tables';
import { extractInSandbox } from './text/sandbox';

export const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Runs a task every interval, never two at once; `stop` waits for the run in flight. */
export class Loop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    readonly name: string,
    readonly intervalMs: number,
    private readonly task: () => Promise<void>,
    private readonly health: HealthMonitor,
    private readonly logger: Logger,
    /** Whether a run reaches SupaMac, so its outcome is SupaMac's health. */
    private readonly reachesSupaMac = true
  ) {}

  start(delayMs = 0): void {
    this.health.register(this.name, this.intervalMs);
    this.schedule(delayMs);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.once().finally(() => {
        this.running = undefined;
        this.schedule(this.intervalMs);
      });
    }, delayMs);
  }

  /** One run, its outcome recorded. */
  async once(): Promise<void> {
    try {
      await this.task();
      this.health.succeeded(this.name);
      if (this.reachesSupaMac) await this.health.connection('supamac', true);
    } catch (error) {
      this.health.failed(this.name, errorText(error));
      this.logger.warn('loop run failed', { loop: this.name, error });
      if (this.reachesSupaMac && supamacDown(error)) {
        await this.health.connection(
          'supamac',
          false,
          this.logger.secrets.mask(errorText(error))
        );
      } else if (this.reachesSupaMac && supamacRefused(error)) {
        // Every call fails alike: the pinned database is gone, or the key no
        // longer works. The owner is told as of SupaMac not answering.
        await this.health.connection(
          'supamac',
          false,
          this.logger.secrets.mask(
            `SupaMac refused the service: ${errorText(error)}`
          )
        );
      }
      try {
        await this.health.recordError(`${this.name}: ${errorText(error)}`);
      } catch (inner) {
        this.logger.warn('last error not recorded', {
          loop: this.name,
          error: inner,
        });
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    await this.running;
  }
}

/** Whether an error says SupaMac did not answer, rather than refused. */
export function supamacDown(error: unknown): boolean {
  return (
    error instanceof SupaMacError &&
    (error.kind === 'unavailable' ||
      error.kind === 'timeout' ||
      error.kind === 'server')
  );
}

/**
 * Whether an error says SupaMac refuses the service itself rather than one
 * request: the key was refused, or the pinned database (every statement
 * names it) is not found or not the service's to use.
 */
export function supamacRefused(error: unknown): boolean {
  if (!(error instanceof SupaMacError)) return false;
  if (error.kind === 'unauthorised') return true;
  return (
    (error.kind === 'not_found' || error.kind === 'forbidden') &&
    error.route.includes('/databases')
  );
}

export interface ServiceOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly notifier?: Notifier | undefined;
  readonly intakes?: readonly Intake[] | undefined;
  readonly logger?: Logger | undefined;
  readonly clock?: (() => Date) | undefined;
  /** The SupaMac transport; `fetch` unless a test gives one. */
  readonly fetch?: FetchLike | undefined;
  /** The Anthropic SDK client; the official one unless a test gives one. */
  readonly messages?: MessagesClient | undefined;
  /** A store in place of the gateway's, for tests. */
  readonly store?: ((schema: JobsSchema) => JobsStore) | undefined;
  /** The schema step, for tests that give their own store. */
  readonly ensureSchema?: typeof ensureJobsSchema | undefined;
  readonly extract?: Extractor | undefined;
  /** Start the loops (on by default); a test drives the pipeline itself when off. */
  readonly loops?: boolean | undefined;
  /** Listen for /health (on by default). */
  readonly listen?: boolean | undefined;
  /** The port to listen on in place of JOBS_HEALTH_PORT; 0 picks a free one. */
  readonly port?: number | undefined;
}

export interface Service {
  readonly config: Config;
  readonly pipeline: Pipeline;
  readonly health: HealthMonitor;
  readonly state: StateStore;
  readonly port?: number | undefined;
  /** One Status tick: the Status row, the setup document, the loops' health. */
  tick(): Promise<void>;
  stop(): Promise<void>;
}

/** The setup document's checks of the settings that are not a way in's own. */
async function settingChecks(
  config: Config,
  messages: MessagesClient | undefined,
  intakes: readonly Intake[],
  health: HealthMonitor
): Promise<SettingCheck[]> {
  const checks: SettingCheck[] = [
    {
      setting: 'SupaMac API key',
      ok: true,
      text: 'the service signed in and found the Jobs database',
    },
  ];
  const mail = intakes.find((i) => i.name === 'mail');
  if (config.mail === undefined) {
    checks.push({
      setting: 'Mailbox login',
      ok: false,
      text: config.off.find((o) => o.way === 'Email')?.why ?? 'not set',
    });
  } else if (mail?.check !== undefined) {
    checks.push(
      await mail.check().catch((e: unknown) => ({
        setting: 'Mailbox login',
        ok: false,
        text: errorText(e),
      }))
    );
  } else {
    checks.push({
      setting: 'Mailbox login',
      ok: false,
      text: 'set, but the mailbox reader is not part of this build',
    });
  }
  const telegram = intakes.find((i) => i.name === 'telegram');
  if (config.telegram === undefined) {
    checks.push({
      setting: 'Telegram',
      ok: false,
      text: 'JOBS_TELEGRAM_BOT_TOKEN is not set',
    });
  } else if (telegram?.check !== undefined) {
    checks.push(
      await telegram.check().catch((e: unknown) => ({
        setting: 'Telegram',
        ok: false,
        text: errorText(e),
      }))
    );
  } else {
    checks.push({
      setting: 'Telegram',
      ok: false,
      text: 'set, but the bot is not part of this build',
    });
  }
  if (config.ai === undefined || messages === undefined) {
    checks.push({
      setting: 'Anthropic',
      ok: false,
      text: config.aiOff ?? 'not set',
    });
  } else {
    try {
      await messages.beta.messages.countTokens({
        model: config.ai.model,
        messages: [{ role: 'user', content: 'ok' }],
      });
      checks.push({
        setting: 'Anthropic',
        ok: true,
        text: `the key works with ${config.ai.model}`,
      });
      await health.connection('anthropic', true);
    } catch (error) {
      checks.push({
        setting: 'Anthropic',
        ok: false,
        text: `the key was refused or the API did not answer (${errorText(error)})`,
      });
      await health.connection('anthropic', false, errorText(error));
    }
  }
  return checks;
}

/**
 * Starts the service; resolves once the intakes are started, the schema is
 * verified, the setup document written and the loops started. The intakes
 * start before the schema is verified, so the owner's notifier can deliver
 * the schema's notes and a stop's reason; a pipeline step they ask for
 * meanwhile waits for the Jobs database (PendingStore). A start that fails
 * after an intake started stops every intake and loop it started.
 */
export async function startService(options: ServiceOptions): Promise<Service> {
  const config = loadConfig(options.env);
  const logger = options.logger ?? new Logger({ fields: { service: 'jobs' } });
  registerSecrets(config, logger);
  const mask = (text: string): string => logger.secrets.mask(text);
  const clock = options.clock ?? (() => new Date());
  const state = await StateStore.open(config.stateDir, { clock, logger });
  // The Telegram bot is the owner's notifier and a way in; a caller that
  // gives its own notifier or intakes (a test) gets neither.
  const bot =
    options.notifier === undefined && options.intakes === undefined
      ? telegramIntake(config, { state, logger })
      : undefined;
  const notifier = options.notifier ?? bot?.notifier ?? new NullNotifier();
  const client = new SupaMacClient({
    apiKey: config.supamacApiKey,
    baseUrl: config.supamacBaseUrl,
    logger,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  if (config.telegram?.ownerId !== undefined)
    await state.setOwnerId(config.telegram.ownerId);

  const messages =
    config.ai === undefined
      ? undefined
      : (options.messages ?? createSdkClient({ apiKey: config.ai.apiKey }));
  const ai =
    config.ai === undefined || messages === undefined
      ? undefined
      : new AiClient({
          client: messages,
          model: config.ai.model,
          effort: 'high',
          monthlyLimitUsd: config.ai.monthlyLimitUsd,
          prices: config.ai.prices,
          fallbacks: config.ai.fallbacks,
          ...(config.ai.fallbackModels !== undefined
            ? { fallbackModels: config.ai.fallbackModels }
            : {}),
          ledger: new StateLedger(state),
          timeZone: config.timeZone,
          clock,
          logger,
        });
  const health = new HealthMonitor(state, notifier, clock, logger);
  const store = new PendingStore();
  const ctx: PipelineContext = {
    store,
    state,
    ai,
    aiOff: config.aiOff,
    notifier,
    logger,
    clock,
    timeZone: () => state.value.timeZone ?? config.timeZone,
    extract:
      options.extract ?? ((bytes, hint) => extractInSandbox(bytes, hint)),
    ...(config.webAppUrl !== undefined
      ? { webApp: webAppBase(config.webAppUrl) }
      : {}),
    health,
    lane: new Lane(),
  };
  const pipeline = new Pipeline(ctx);
  // The mailbox, like the bot, is a way in only for a caller that gives
  // neither notifier nor intakes (main); a test gives its own.
  const intakes = options.intakes ?? [
    ...(bot !== undefined ? [bot] : []),
    ...(options.notifier === undefined ? mailIntakes(config, options.env) : []),
  ];

  const ensure = options.ensureSchema ?? ensureJobsSchema;
  const verify = async (): Promise<EnsureSchemaResult> => {
    const result = await ensure({
      client,
      pins: state.value.pins,
      ownerEmail: config.ownerEmail,
      save: async (pins) => {
        await state.update((s) => {
          s.pins = pins;
        });
      },
      logger,
    });
    await state.update((s) => {
      s.pins = result.pins;
    });
    for (const change of result.changes) logger.info('schema', { change });
    const fresh = result.notes.filter(
      (n) => !state.value.schemaNotes.includes(n)
    );
    const told: string[] = [];
    for (const text of fresh) {
      try {
        await notifier.note({ kind: 'schema', text });
        told.push(text);
      } catch (error) {
        logger.warn('schema note not delivered', { error });
      }
    }
    await state.update((s) => {
      s.schemaNotes = result.notes.filter(
        (n) => s.schemaNotes.includes(n) || told.includes(n)
      );
    });
    return result;
  };

  const abort = new AbortController();
  const started: Intake[] = [];
  const loops: Loop[] = [];
  let server: ReturnType<typeof serve> | undefined;
  const stopIntakes = async (): Promise<void> => {
    abort.abort();
    for (const intake of started.splice(0).reverse()) {
      try {
        await intake.stop();
      } catch (error) {
        logger.warn('intake did not stop cleanly', {
          intake: intake.name,
          error,
        });
      }
    }
  };

  // The settings are checked at the start and then hourly: a check logs in.
  let checks: SettingCheck[] = [];
  let checkedAt = Number.NEGATIVE_INFINITY;
  const refreshSetup = async (): Promise<void> => {
    if (clock().getTime() - checkedAt >= 60 * MINUTE_MS) {
      checks = (await settingChecks(config, messages, intakes, health)).map(
        (c) => ({ ...c, text: mask(c.text) })
      );
      checkedAt = clock().getTime();
    }
    const linkCode =
      config.telegram !== undefined && config.telegram.ownerId === undefined
        ? await state.linkCode()
        : undefined;
    const markdown = setupMarkdown({
      checks,
      linkCode,
      linked: state.ownerId !== undefined,
      telegramOn: config.telegram !== undefined,
      off: config.off.map((o) => `${o.way}: ${o.why}`),
      timeZone: ctx.timeZone(),
    });
    await pipeline.ctx.lane.run(() => writeSetupDocument(ctx, markdown));
  };
  let lastPrune = 0;
  const tick = async (): Promise<void> => {
    await health.persist();
    // The month the AI client counts the spend in: JOBS_TIME_ZONE's.
    const month = monthOf(clock(), config.timeZone);
    const lastError = state.value.notes.lastError;
    const rowId = await store.writeStatus(state.value.statusRowId, {
      Name: 'Jobs service',
      'Last mail check': health.lastSuccess('mail') ?? null,
      'Last Telegram poll': health.lastSuccess('telegram') ?? null,
      'Last change poll': health.lastSuccess('edits') ?? null,
      'Last error': lastError === undefined ? null : mask(lastError.text),
      'Last error at': lastError?.at ?? null,
      'Ways in off': offText(config),
      'AI spend this month (computed, USD)':
        Math.round((state.value.spend.months[month] ?? 0) * 100) / 100,
    });
    if (rowId !== state.value.statusRowId) {
      await state.update((s) => {
        s.statusRowId = rowId;
      });
    }
    await refreshSetup();
    if (clock().getTime() - lastPrune >= DAY_MS) {
      lastPrune = clock().getTime();
      await state.prune();
      await state.pruneSpool();
    }
  };

  try {
    for (const intake of intakes) {
      const on =
        intake.name === 'mail'
          ? wayOn(config, 'Email')
          : config.telegram !== undefined;
      if (!on) continue;
      health.register(intake.name, MINUTE_MS);
      started.push(intake);
      await intake.start({
        pipeline,
        ai,
        state,
        notifier,
        logger,
        config,
        health,
        clock,
        timeZone: ctx.timeZone,
        signal: abort.signal,
      });
    }

    let first: EnsureSchemaResult;
    try {
      first = await verify();
    } catch (error) {
      // The service stops rather than make a second database; the owner is told why.
      if (error instanceof SchemaError) {
        try {
          await notifier.note({
            kind: 'error',
            text: `The jobs service stopped: ${error.message}.`,
          });
        } catch (inner) {
          logger.warn('stop note not delivered', { error: inner });
        }
      }
      throw error;
    }
    const watched = new Set(
      WATCHED_TABLES.map((t) => first.schema.tables[t].id)
    );
    const onWrite = (
      versions: readonly { tableId: string; version: number }[]
    ): Promise<void> =>
      state.recordWritten(versions.filter((v) => watched.has(v.tableId)));
    const supamacStore = new SupaMacStore({
      client,
      schema: first.schema,
      onWrite,
    });
    store.resolve(
      options.store !== undefined ? options.store(first.schema) : supamacStore
    );

    if (options.loops !== false) {
      if (wayOn(config, 'Folder')) {
        loops.push(
          new Loop(
            'folder',
            MINUTE_MS,
            async () => {
              await pipeline.pollFolder();
            },
            health,
            logger
          )
        );
      }
      loops.push(
        new Loop(
          'edits',
          MINUTE_MS,
          async () => {
            const result = await pipeline.pollEdits();
            if (result.schemaChanged) {
              const again = await verify();
              supamacStore.setSchema(again.schema);
            }
          },
          health,
          logger
        ),
        new Loop(
          'resume',
          MINUTE_MS,
          async () => {
            await pipeline.resume();
          },
          health,
          logger
        ),
        new Loop('status', MINUTE_MS, tick, health, logger)
      );
    }

    await refreshSetup();
    for (const loop of loops) loop.start();

    if (options.listen !== false) {
      server = serve({
        port: options.port ?? config.healthPort,
        fetch(request) {
          const url = new URL(request.url);
          if (url.pathname !== '/health' || request.method !== 'GET')
            return new Response('not found', { status: 404 });
          const report = health.report();
          return Response.json(report, { status: report.ok ? 200 : 503 });
        },
      });
    }
  } catch (error) {
    store.fail(error);
    await stopIntakes();
    for (const loop of loops) await loop.stop();
    await pipeline.idle();
    await server?.stop();
    throw error;
  }
  logger.info('jobs service started', {
    off: config.off.map((o) => o.way),
    ai: ai !== undefined,
    healthPort: server?.port,
  });

  let stopping: Promise<void> | undefined;
  return {
    config,
    pipeline,
    health,
    state,
    port: server?.port,
    tick,
    stop() {
      stopping ??= (async () => {
        await stopIntakes();
        for (const loop of loops) await loop.stop();
        await pipeline.idle();
        await server?.stop();
        logger.info('jobs service stopped');
      })();
      return stopping;
    },
  };
}

/** Runs the service until SIGTERM or SIGINT. */
export async function main(): Promise<void> {
  const logger = new Logger({ fields: { service: 'jobs' } });
  let service: Service;
  try {
    if (sealProcess() === 'not_linux')
      logger.warn('not sealed: only Linux keeps the environment from children');
    service = await startService({ env: process.env, logger });
  } catch (error) {
    logger.error('jobs service did not start', { error });
    process.exitCode = 1;
    return;
  }
  const stop = (signal: string): void => {
    logger.info('stopping', { signal });
    service.stop().then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        logger.error('stop failed', { error });
        process.exitCode = 1;
      }
    );
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

if (import.meta.main) await main();
