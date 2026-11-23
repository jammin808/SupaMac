// The one way the jobs service calls Claude (docs/supamac/jobs.md §3, "Asking",
// Security: Spending): a thin wrapper over the official SDK client.
//
// Invariants:
// - Every request streams (`beta.messages.stream` then `finalMessage()`), sets
//   `max_tokens` and `output_config.effort` explicitly, and sends no
//   `thinking`, sampling parameters, prefill or forced `tool_choice`.
// - Server-side fallbacks are opt-in per client and on by default: the beta
//   `server-side-fallback-2026-07-01` with `fallbacks: "default"`; `fallbacks:
//   false` sends neither.
// - Before each request the month's computed spend, plus what requests in
//   flight hold back, is read; at or above the monthly limit no call is made.
//   Otherwise the request's input is counted (`countTokens`) and its worst
//   case must fit under the limit, or it is refused with an `over_cap` result.
//   The worst case sums every attempt the request may bill: the requested
//   model and, with fallbacks on, each configured fallback model, since a
//   declined attempt is billed and each fallback re-reads the whole input with
//   its own `max_tokens`. Each attempt is the counted input at the highest of
//   that model's input price and the cache-write prices of the lifetimes the
//   request's breakpoints ask for, and all of `max_tokens` as output.
// - The worst case is held back from the moment it is checked until the
//   reply's cost is recorded (or the call fails), and the check, the hold and
//   the release run one at a time, so requests running at once cannot share
//   the same room under the limit. The hold is per client: one `AiClient` per
//   ledger.
// - Every reply that arrives is priced and recorded in the ledger before it is
//   returned, whatever its stop reason: tokens are billed for refusals and cut
//   short answers too. A reply whose cost cannot be recorded is still returned,
//   with the ledger's error beside it, so it is never paid for twice.
// - `stop_reason` is read before any content. A refusal, an answer cut short
//   (`max_tokens`, `model_context_window_exceeded`, `pause_turn`,
//   `compaction`) and a reply that is not valid JSON for its schema are typed
//   results, never thrown. API errors are typed results too, marked retryable
//   (429, 408, 409, 5xx, overloaded, connection, timeout, abort) or final
//   (everything else, and a workspace or contract spend limit).
// - Cost is computed from token counts at the configured prices and is
//   labelled as computed: `usage.iterations`, when present, is the per-attempt
//   record (a fallback attempt bills at its own model's prices); otherwise the
//   top-level usage at the model that answered. A model with no configured
//   price is charged at the highest configured price.
// - Nothing here logs prompt or reply content, only counts and outcomes.
//
// Choices where the design is silent, each the more cautious one:
// - Every iteration in `usage.iterations` is charged, including an attempt
//   that was declined before any output (whether that one is billed depends on
//   its category; charging it can only overstate the spend).
// - With `fallbacks: "default"` the chain is the server's; the configured
//   fallback models stand for it, and a model with no configured price is
//   charged at the highest configured price.
// - Months are calendar months in the owner's time zone.
// - Tokens of a stream that fails part way are not in the ledger: the SDK
//   gives no usage for it. The worst-case check before the next request still
//   applies.
// - A structured reply is read from all its text blocks joined; if that is not
//   valid JSON, from the text after the last fallback block only (a fallback
//   model may restart rather than continue). Either way it is validated by the
//   same zod schema that produced the format.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type {
  BetaContentBlock,
  BetaJSONOutputFormat,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaRefusalStopDetails,
  BetaTextBlockParam,
  BetaTool,
  BetaToolChoice,
  MessageCountTokensParams,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { z } from 'zod';
import type { Logger } from '../log';
import { AiError, classifyError } from './errors';
import {
  type CacheWrites,
  COMPUTED_LABEL,
  cacheWritesOf,
  DEFAULT_PRICES,
  highestPrice,
  monthOf,
  type PriceTable,
  priceUsage,
  type Purpose,
  type SpendEntry,
  type SpendLedger,
} from './spend';

export { AiError, type AiErrorKind, classifyError } from './errors';
export {
  type CacheWrites,
  COMPUTED_LABEL,
  cacheWritesOf,
  DEFAULT_PRICES,
  highestPrice,
  MemoryLedger,
  type ModelPrice,
  monthOf,
  type PricedAttempt,
  type PriceTable,
  priceUsage,
  type Purpose,
  type SpendEntry,
  type SpendLedger,
  type TokenCounts,
} from './spend';

/** `JOBS_AI_MODEL` unless set (design, Settings). */
export const DEFAULT_MODEL = 'claude-opus-5-5';

/** The beta that turns on server-side refusal fallbacks. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// ---------------------------------------------------------------------------
// The SDK surface this module uses. The official client satisfies it; tests
// pass a fake.

export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}

export interface MessageStreamLike {
  finalMessage(): Promise<BetaMessage>;
  abort(): void;
}

export interface MessagesClient {
  readonly beta: {
    readonly messages: {
      stream(
        body: BetaMessageStreamParams,
        options?: CallOptions
      ): MessageStreamLike;
      countTokens(
        body: MessageCountTokensParams,
        options?: CallOptions
      ): PromiseLike<{ input_tokens: number }>;
    };
  };
}

// ---------------------------------------------------------------------------
// Requests and outcomes.

export interface AiRequest {
  readonly purpose: Purpose;
  /** What the ledger files the cost under (a source hash); never content. */
  readonly key?: string | undefined;
  readonly effort?: Effort | undefined;
  readonly maxTokens: number;
  readonly system: readonly BetaTextBlockParam[];
  readonly messages: readonly BetaMessageParam[];
  readonly tools?: readonly BetaTool[] | undefined;
  /** `auto` or `none` only: forced tool use is refused by the model. */
  readonly toolChoice?:
    | Extract<BetaToolChoice, { type: 'auto' | 'none' }>
    | undefined;
  readonly format?: BetaJSONOutputFormat | undefined;
  /** Automatic caching of the conversation so far (the question loop). */
  readonly cacheMessages?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type CutShortReason =
  | 'max_tokens'
  | 'model_context_window_exceeded'
  | 'pause_turn'
  | 'compaction';

export interface Replied {
  readonly message: BetaMessage;
  readonly spend: SpendEntry;
  /** The model that produced the returned message. */
  readonly servedBy: string;
  /** True when a fallback model served any part of it. */
  readonly fellBack: boolean;
  /** Set when the cost could not be recorded; the pipeline must record `spend` itself. */
  readonly ledgerError?: AiError | undefined;
}

export type CallOutcome =
  | (Replied & {
      readonly kind: 'ok';
      readonly stopReason: 'end_turn' | 'tool_use' | 'stop_sequence';
    })
  | (Replied & {
      readonly kind: 'refusal';
      readonly category: BetaRefusalStopDetails['category'];
      readonly explanation: string | null;
      readonly reason: string;
    })
  | (Replied & {
      readonly kind: 'cut_short';
      readonly stopReason: CutShortReason;
      readonly reason: string;
    })
  | {
      readonly kind: 'over_cap';
      readonly month: string;
      readonly spentUsd: number;
      readonly limitUsd: number;
      /** The worst case of the refused request; absent when the month is already over. */
      readonly estimateUsd?: number | undefined;
      readonly inputTokens?: number | undefined;
      /** The worst cases held back for other requests still in flight. */
      readonly heldUsd?: number | undefined;
      readonly reason: string;
    }
  | {
      readonly kind: 'error';
      readonly error: AiError;
      readonly reason: string;
    };

export type JsonFailure = 'empty' | 'invalid_json' | 'schema';

export type JsonResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly failure: JsonFailure;
      readonly reason: string;
    };

export type StructuredOutcome<T> =
  | (Replied & {
      readonly kind: 'ok';
      readonly value: T;
      readonly text: string;
    })
  | (Replied & {
      readonly kind: 'invalid';
      readonly failure: JsonFailure | 'stop_reason';
      readonly text: string;
      readonly reason: string;
    })
  | Exclude<CallOutcome, { kind: 'ok' }>;

export interface AiClientOptions {
  readonly client: MessagesClient;
  readonly model?: string | undefined;
  readonly effort?: Effort | undefined;
  /** Server-side fallbacks on refusal; on unless false. */
  readonly fallbacks?: boolean | undefined;
  /** The models a refusal may fall back to, for the worst-case estimate. */
  readonly fallbackModels?: readonly string[] | undefined;
  readonly prices?: PriceTable | undefined;
  /** `JOBS_MONTHLY_LIMIT_USD`. */
  readonly monthlyLimitUsd: number;
  readonly ledger: SpendLedger;
  /** `JOBS_TIME_ZONE`, for the month the spend is counted in. */
  readonly timeZone: string;
  readonly clock?: (() => Date) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly logger?: Logger | undefined;
}

/** The text blocks of a reply, joined; after the last fallback block when asked. */
export function replyText(
  content: readonly BetaContentBlock[],
  afterLastFallback = false
): string {
  let start = 0;
  if (afterLastFallback) {
    content.forEach((block, i) => {
      if (block.type === 'fallback') start = i + 1;
    });
  }
  return content
    .slice(start)
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('');
}

/** Parses a reply's text as JSON and validates it with `schema`. */
export function parseJsonReply<T>(
  text: string,
  schema: z.ZodType<T>
): JsonResult<T> {
  if (text.trim() === '') {
    return { ok: false, failure: 'empty', reason: 'the reply has no text' };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      failure: 'invalid_json',
      reason: `the reply is not valid JSON (${error instanceof Error ? error.message : 'unreadable'})`,
    };
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return {
      ok: false,
      failure: 'schema',
      reason: `the reply does not match the schema (${issues})`,
    };
  }
  return { ok: true, value: parsed.data };
}

/** Reads a structured reply: all its text, else the text after the last fallback. */
export function parseStructured<T>(
  message: Pick<BetaMessage, 'content'>,
  schema: z.ZodType<T>
): JsonResult<T> & { readonly text: string } {
  const whole = replyText(message.content);
  const first = parseJsonReply(whole, schema);
  if (first.ok || !message.content.some((b) => b.type === 'fallback')) {
    return { ...first, text: whole };
  }
  const tail = replyText(message.content, true);
  const second = parseJsonReply(tail, schema);
  return second.ok ? { ...second, text: tail } : { ...first, text: whole };
}

/**
 * The JSON schema the API is sent for a zod schema: the SDK's conversion,
 * without the SDK's own parser, so that a refusal or a cut-short reply stays
 * a typed result instead of a thrown error.
 */
export function jsonFormat(schema: z.ZodType): BetaJSONOutputFormat {
  const converted = zodOutputFormat(schema);
  return { type: 'json_schema', schema: converted.schema };
}

/** A strict tool whose input schema is the SDK's conversion of `input`. */
export function strictTool(
  name: string,
  description: string,
  input: z.ZodType
): BetaTool {
  const schema = zodOutputFormat(input).schema;
  if (schema.type !== 'object') {
    throw new AiError(
      'config',
      `the ${name} tool's input is not an object`,
      false
    );
  }
  return {
    name,
    description,
    input_schema: { ...schema, type: 'object' },
    strict: true,
  };
}

const CUT_SHORT_TEXT: Readonly<Record<CutShortReason, string>> = {
  max_tokens: 'the answer was cut short at its token limit',
  model_context_window_exceeded:
    'the answer was cut short: the context window is full',
  pause_turn: 'the answer was paused before it finished',
  compaction: 'the answer stopped for compaction',
};

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export class AiClient {
  readonly model: string;
  readonly fallbacks: boolean;
  private readonly client: MessagesClient;
  private readonly effort: Effort;
  private readonly fallbackModels: readonly string[];
  private readonly prices: PriceTable;
  private readonly limitUsd: number;
  private readonly ledger: SpendLedger;
  private readonly timeZone: string;
  private readonly clock: () => Date;
  private readonly timeoutMs: number | undefined;
  private readonly logger: Logger | undefined;
  /** The worst cases held back for requests in flight, by month. */
  private readonly held = new Map<string, number>();
  /** The tail of the queue the cap's checks, holds and releases run on. */
  private lane: Promise<unknown> = Promise.resolve();

  constructor(options: AiClientOptions) {
    if (
      !Number.isFinite(options.monthlyLimitUsd) ||
      options.monthlyLimitUsd < 0
    ) {
      throw new AiError(
        'config',
        'the monthly limit must be a number of US dollars, 0 or more',
        false
      );
    }
    this.client = options.client;
    this.model = options.model ?? DEFAULT_MODEL;
    this.effort = options.effort ?? 'high';
    this.fallbacks = options.fallbacks ?? true;
    this.fallbackModels = options.fallbackModels ?? [
      'claude-opus-5',
      'claude-opus-4-8',
    ];
    this.prices = options.prices ?? DEFAULT_PRICES;
    this.limitUsd = options.monthlyLimitUsd;
    this.ledger = options.ledger;
    this.timeZone = options.timeZone;
    this.clock = options.clock ?? (() => new Date());
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger;
    // Fails at start, not at the first request, when no price is configured.
    highestPrice(this.prices);
  }

  /** The streaming request body for `request`, exactly as it is sent. */
  body(request: AiRequest): BetaMessageStreamParams {
    if (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0) {
      throw new AiError(
        'config',
        'max_tokens must be a positive whole number',
        false
      );
    }
    return {
      model: this.model,
      max_tokens: request.maxTokens,
      system: [...request.system],
      messages: [...request.messages],
      output_config: {
        effort: request.effort ?? this.effort,
        ...(request.format ? { format: request.format } : {}),
      },
      ...(request.tools && request.tools.length > 0
        ? { tools: [...request.tools] }
        : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      ...(request.cacheMessages
        ? { cache_control: { type: 'ephemeral' } }
        : {}),
      ...(this.fallbacks
        ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const }
        : {}),
    };
  }

  /** The token-count request for `body`: the same prompt, without the sending fields. */
  countBody(body: BetaMessageStreamParams): MessageCountTokensParams {
    return {
      model: body.model,
      messages: body.messages,
      ...(body.system !== undefined ? { system: body.system } : {}),
      ...(body.tools !== undefined ? { tools: body.tools } : {}),
      ...(body.tool_choice !== undefined
        ? { tool_choice: body.tool_choice }
        : {}),
      ...(body.output_config !== undefined
        ? { output_config: body.output_config }
        : {}),
    };
  }

  private options(signal: AbortSignal | undefined): CallOptions {
    return {
      ...(signal ? { signal } : {}),
      ...(this.timeoutMs !== undefined ? { timeout: this.timeoutMs } : {}),
    };
  }

  /**
   * The worst-case cost of `inputTokens` in and `maxTokens` out: every attempt
   * the request may bill, each at its own model's prices, its input at the
   * highest of the input price and the cache-write prices `cache` may incur.
   * Without `cache`, both cache lifetimes are assumed.
   */
  worstCase(
    inputTokens: number,
    maxTokens: number,
    cache: CacheWrites = { fiveMinute: true, hour: true }
  ): number {
    const models = this.fallbacks
      ? [this.model, ...this.fallbackModels]
      : [this.model];
    let total = 0;
    for (const model of models) {
      const price = this.prices[model] ?? highestPrice(this.prices);
      const inputRate = Math.max(
        price.input,
        cache.fiveMinute ? price.cacheWrite : 0,
        cache.hour ? (price.cacheWrite1h ?? price.input * 2) : 0
      );
      total += (inputTokens * inputRate + maxTokens * price.output) / 1_000_000;
    }
    return total;
  }

  /**
   * Runs `step` once every step queued before it has settled, so the cap's
   * checks, holds and releases never interleave. The step's own result or
   * error goes to its caller; the queue only waits for it to settle.
   */
  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.lane.then(step);
    this.lane = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private heldFor(month: string): number {
    return this.held.get(month) ?? 0;
  }

  private release(month: string, amount: number): void {
    const left = this.heldFor(month) - amount;
    if (left > 1e-9) this.held.set(month, left);
    else this.held.delete(month);
  }

  private async readSpent(month: string): Promise<number> {
    try {
      return await this.ledger.spent(month);
    } catch (error) {
      throw new AiError('ledger', 'the spend ledger could not be read', true, {
        cause: error,
      });
    }
  }

  /** The over-cap outcome when the month is already at the limit, else undefined. */
  private async atLimit(month: string): Promise<CallOutcome | undefined> {
    const spentUsd = await this.readSpent(month);
    const heldUsd = this.heldFor(month);
    if (spentUsd + heldUsd < this.limitUsd) return undefined;
    const inFlight =
      heldUsd > 0 ? ` (with ${usd(heldUsd)} held for requests in flight)` : '';
    return {
      kind: 'over_cap',
      month,
      spentUsd,
      limitUsd: this.limitUsd,
      ...(heldUsd > 0 ? { heldUsd } : {}),
      reason: `the computed AI spend for ${month} is ${usd(spentUsd)}${inFlight}, at or above the monthly limit of ${usd(this.limitUsd)}`,
    };
  }

  /** Holds `estimateUsd` back when it fits under the limit; else the over-cap outcome. */
  private async hold(
    month: string,
    estimateUsd: number,
    inputTokens: number
  ): Promise<CallOutcome | undefined> {
    const spentUsd = await this.readSpent(month);
    const heldUsd = this.heldFor(month);
    if (spentUsd + heldUsd + estimateUsd <= this.limitUsd) {
      this.held.set(month, heldUsd + estimateUsd);
      return undefined;
    }
    const inFlight =
      heldUsd > 0 ? ` and ${usd(heldUsd)} held for requests in flight` : '';
    return {
      kind: 'over_cap',
      month,
      spentUsd,
      limitUsd: this.limitUsd,
      estimateUsd,
      inputTokens,
      ...(heldUsd > 0 ? { heldUsd } : {}),
      reason: `this request could cost up to ${usd(estimateUsd)} (computed), which would take ${month}'s computed spend of ${usd(spentUsd)}${inFlight} over the monthly limit of ${usd(this.limitUsd)}`,
    };
  }

  /** Sends one request: cap check, token count, stream, price, record. */
  async call(request: AiRequest): Promise<CallOutcome> {
    let body: BetaMessageStreamParams;
    try {
      body = this.body(request);
    } catch (error) {
      const e = classifyError(error);
      return { kind: 'error', error: e, reason: e.message };
    }
    const month = monthOf(this.clock(), this.timeZone);

    // At or above the limit nothing is counted or sent.
    let refused: CallOutcome | undefined;
    try {
      refused = await this.serial(() => this.atLimit(month));
    } catch (error) {
      const e = classifyError(error);
      return { kind: 'error', error: e, reason: e.message };
    }
    if (refused !== undefined) return refused;

    const options = this.options(request.signal);
    let inputTokens: number;
    try {
      const counted = await this.client.beta.messages.countTokens(
        this.countBody(body),
        options
      );
      inputTokens = counted.input_tokens;
    } catch (error) {
      const e = classifyError(error);
      return {
        kind: 'error',
        error: e,
        reason: `counting tokens: ${e.message}`,
      };
    }

    // The worst case is checked against the spend as it stands and held back
    // in the same step. It is released only after the reply's cost has been
    // recorded, or the call has failed, so a check that runs in between counts
    // it at least once.
    const estimateUsd = this.worstCase(
      inputTokens,
      request.maxTokens,
      cacheWritesOf(body)
    );
    try {
      refused = await this.serial(() =>
        this.hold(month, estimateUsd, inputTokens)
      );
    } catch (error) {
      const e = classifyError(error);
      return { kind: 'error', error: e, reason: e.message };
    }
    if (refused !== undefined) return refused;
    try {
      return await this.send(request, body, options, inputTokens, estimateUsd);
    } finally {
      await this.serial(async () => this.release(month, estimateUsd));
    }
  }

  /** Streams a request whose worst case is held, then prices and records its reply. */
  private async send(
    request: AiRequest,
    body: BetaMessageStreamParams,
    options: CallOptions,
    inputTokens: number,
    estimateUsd: number
  ): Promise<CallOutcome> {
    this.logger?.info('ai.request', {
      purpose: request.purpose,
      key: request.key,
      model: this.model,
      inputTokens,
      maxTokens: request.maxTokens,
      estimateUsd,
    });

    let message: BetaMessage;
    try {
      message = await this.client.beta.messages
        .stream(body, options)
        .finalMessage();
    } catch (error) {
      const e = classifyError(error);
      this.logger?.warn('ai.error', {
        purpose: request.purpose,
        key: request.key,
        kind: e.kind,
        retryable: e.retryable,
        status: e.status,
      });
      return { kind: 'error', error: e, reason: e.message };
    }

    const priced = priceUsage(message, this.model, this.prices);
    const spend: SpendEntry = {
      month: monthOf(this.clock(), this.timeZone),
      at: this.clock().toISOString(),
      purpose: request.purpose,
      key: request.key,
      model: message.model,
      attempts: priced.attempts,
      tokens: priced.tokens,
      usd: priced.usd,
      computed: true,
      label: COMPUTED_LABEL,
    };
    // A reply that was paid for is returned even when its cost cannot be
    // recorded, so that it can be saved and never bought twice.
    let ledgerError: AiError | undefined;
    try {
      await this.ledger.record(spend);
    } catch (error) {
      ledgerError = new AiError(
        'ledger',
        'the spend ledger could not be written',
        true,
        {
          cause: error,
        }
      );
      this.logger?.error('ai.ledger', {
        purpose: request.purpose,
        key: request.key,
        usd: spend.usd,
        error: ledgerError,
      });
    }
    const fellBack =
      message.content.some((b) => b.type === 'fallback') ||
      (message.usage.iterations ?? []).some(
        (it) => it.type === 'fallback_message'
      );
    const replied: Replied = {
      message,
      spend,
      servedBy: message.model,
      fellBack,
      ...(ledgerError ? { ledgerError } : {}),
    };
    this.logger?.info('ai.reply', {
      purpose: request.purpose,
      key: request.key,
      stopReason: message.stop_reason,
      servedBy: message.model,
      fellBack,
      inputTokens: spend.tokens.input,
      outputTokens: spend.tokens.output,
      usd: spend.usd,
    });

    const stop = message.stop_reason;
    if (stop === 'refusal') {
      const details = message.stop_details;
      const category = details?.category ?? null;
      return {
        ...replied,
        kind: 'refusal',
        category,
        explanation: details?.explanation ?? null,
        reason: `the model declined to answer${category ? ` (${category})` : ''}${fellBack ? ', also after falling back' : ''}`,
      };
    }
    if (
      stop === 'max_tokens' ||
      stop === 'model_context_window_exceeded' ||
      stop === 'pause_turn' ||
      stop === 'compaction'
    ) {
      return {
        ...replied,
        kind: 'cut_short',
        stopReason: stop,
        reason: CUT_SHORT_TEXT[stop],
      };
    }
    if (
      stop === 'end_turn' ||
      stop === 'tool_use' ||
      stop === 'stop_sequence'
    ) {
      return { ...replied, kind: 'ok', stopReason: stop };
    }
    const e = new AiError(
      'response',
      `the reply has no known stop reason (${String(stop)})`,
      false
    );
    return { kind: 'error', error: e, reason: e.message };
  }

  /** Sends a request whose answer is JSON for `schema`, and validates it. */
  async callStructured<T>(
    request: Omit<AiRequest, 'format'>,
    schema: z.ZodType<T>
  ): Promise<StructuredOutcome<T>> {
    let format: BetaJSONOutputFormat;
    try {
      format = jsonFormat(schema);
    } catch (error) {
      const e = new AiError(
        'config',
        'the reply schema cannot be converted',
        false,
        {
          cause: error,
        }
      );
      return { kind: 'error', error: e, reason: e.message };
    }
    const outcome = await this.call({ ...request, format });
    if (outcome.kind !== 'ok') return outcome;
    const { kind: _kind, stopReason, ...replied } = outcome;
    if (stopReason !== 'end_turn') {
      return {
        ...replied,
        kind: 'invalid',
        failure: 'stop_reason',
        text: replyText(outcome.message.content),
        reason: `the reply stopped for ${stopReason} instead of answering`,
      };
    }
    const parsed = parseStructured(outcome.message, schema);
    if (!parsed.ok) {
      return {
        ...replied,
        kind: 'invalid',
        failure: parsed.failure,
        text: parsed.text,
        reason: parsed.reason,
      };
    }
    return { ...replied, kind: 'ok', value: parsed.value, text: parsed.text };
  }
}

/** The official client, built only from what is given (no environment reads here). */
export function createSdkClient(options: {
  readonly apiKey: string;
  readonly maxRetries?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetch?: typeof fetch | undefined;
}): MessagesClient {
  return new Anthropic({
    apiKey: options.apiKey,
    ...(options.maxRetries !== undefined
      ? { maxRetries: options.maxRetries }
      : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
}
