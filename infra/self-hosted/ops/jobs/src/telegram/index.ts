// The Telegram way in as main.ts starts it (pipeline/intake.ts): the bot, and
// the notifier every part of the service tells the owner through.
//
// Invariants:
// - The notifier exists from the service's start, before the intake starts,
//   so the schema's notes and a stop's reason reach the owner; it sends to
//   the linked owner only (JOBS_TELEGRAM_OWNER_ID, else the state's link).
// - `start` never fails for Telegram being unreachable: the bot's loop
//   retries with backoff and reports its connection, so a Telegram outage at
//   boot does not stop the service. It takes sources and questions only
//   while the Telegram way in is on (`wayOn`); linking and notes work
//   whenever the bot token is set.
// - `check` is read-only: it asks Telegram who the bot is and whether a
//   webhook is set, and says whether group joins are off.
// - The Retry of a source whose saved model reply could not be used drops
//   that reply on the pipeline's lane and runs the retry there, so the model
//   reads the source afresh, at its cost, as the button says; any other
//   Retry is the pipeline's own, which never buys a reply twice.

import type { Config, TelegramSettings } from '../config';
import { wayOn } from '../config';
import type { Logger } from '../log';
import type { Intake, IntakeContext, SettingCheck } from '../pipeline/intake';
import type { Pipeline } from '../pipeline/pipeline';
import { retry } from '../pipeline/process';
import type { StateStore } from '../pipeline/state';
import { BotApi, type Sleep, type TelegramFetch } from './api';
import {
  Bot,
  type BotPipeline,
  type RetryOutcome,
  TelegramNotifier,
} from './bot';

export interface TelegramIntakeOptions {
  readonly settings: TelegramSettings;
  readonly state: StateStore;
  readonly logger: Logger;
  /** The owner's zone: `/tz`'s, else JOBS_TIME_ZONE. */
  readonly timeZone: () => string;
  /** Why sources and questions are off; undefined while the way in is on. */
  readonly off?: string | undefined;
  readonly fetch?: TelegramFetch | undefined;
  readonly sleep?: Sleep | undefined;
  readonly baseUrl?: string | undefined;
  readonly busyPollMs?: number | undefined;
}

/** A Retry that reads the source afresh: its saved, unusable reply is dropped first. */
export function freshRetry(
  pipeline: Pipeline,
  sourceId: string
): Promise<RetryOutcome> {
  const ctx = pipeline.ctx;
  return ctx.lane.run(async () => {
    const meta = ctx.state.value.sources[sourceId];
    const hash = meta?.hash;
    if (
      hash !== undefined &&
      meta?.status === 'Failed' &&
      ctx.state.value.replies[hash]?.invalid !== undefined
    ) {
      await ctx.state.update((s) => {
        delete s.replies[hash];
      });
    }
    return retry(ctx, sourceId);
  });
}

export class TelegramIntake implements Intake {
  readonly name = 'telegram' as const;
  readonly api: BotApi;
  readonly notifier: TelegramNotifier;
  private bot: Bot | undefined;

  constructor(private readonly options: TelegramIntakeOptions) {
    this.api = new BotApi({
      token: options.settings.botToken,
      fetch: options.fetch,
      sleep: options.sleep,
      logger: options.logger,
      baseUrl: options.baseUrl,
    });
    this.notifier = new TelegramNotifier({
      api: this.api,
      state: options.state,
      logger: options.logger,
      timeZone: options.timeZone,
      ownerId: options.settings.ownerId,
    });
  }

  async start(context: IntakeContext): Promise<void> {
    if (this.bot !== undefined) return;
    const pipeline: BotPipeline = context.pipeline;
    this.bot = new Bot({
      api: this.api,
      notifier: this.notifier,
      state: context.state,
      pipeline,
      logger: context.logger.child({ intake: 'telegram' }),
      clock: context.clock,
      timeZone: context.timeZone,
      health: context.health,
      off: this.options.off,
      freshRetry: (sourceId) => freshRetry(context.pipeline, sourceId),
      downloadDocument: (documentId) =>
        context.pipeline.ctx.store.downloadDocument(documentId),
      sleep: this.options.sleep,
      busyPollMs: this.options.busyPollMs,
    });
    this.bot.start(context.signal);
  }

  async stop(): Promise<void> {
    await this.bot?.stop();
  }

  async check(): Promise<SettingCheck> {
    const setting = 'Telegram';
    const halted = this.notifier.halted;
    if (halted !== undefined) return { setting, ok: false, text: halted };
    const me = await this.api.getMe();
    const hook = await this.api.getWebhookInfo();
    const who = me.username !== undefined ? `@${me.username}` : me.first_name;
    if (hook.url !== '')
      return {
        setting,
        ok: false,
        text: `a webhook is set on ${who}, so another service receives its messages: revoke the token in BotFather`,
      };
    if (me.can_join_groups === true)
      return {
        setting,
        ok: false,
        text: `the bot answers as ${who}, but it can join groups: turn group joins off in BotFather (/setjoingroups)`,
      };
    return { setting, ok: true, text: `the bot answers as ${who}` };
  }
}

/** The Telegram intake for these settings; undefined without a bot token. */
export function telegramIntake(
  config: Config,
  deps: {
    readonly state: StateStore;
    readonly logger: Logger;
    readonly fetch?: TelegramFetch | undefined;
  }
): TelegramIntake | undefined {
  if (config.telegram === undefined) return undefined;
  const off = wayOn(config, 'Telegram')
    ? undefined
    : (config.off.find((o) => o.way === 'Telegram')?.why ?? 'it is off');
  return new TelegramIntake({
    settings: config.telegram,
    state: deps.state,
    logger: deps.logger,
    timeZone: () => deps.state.value.timeZone ?? config.timeZone,
    off,
    fetch: deps.fetch,
  });
}
