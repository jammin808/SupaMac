// Prices, the computed cost of a reply, and the ledger the monthly cap reads
// (docs/supamac/jobs.md, Security: Spending; the Status row's AI spend this
// month is computed from the same token counts and prices).
//
// Invariants:
// - Every cost is computed from token counts at the configured prices and is
//   labelled as computed; the Console's bill is the authority.
// - `usage.iterations`, when present, is the per-attempt record: each attempt
//   is priced at its own model. Otherwise the top-level usage is priced at the
//   model that answered. A model with no configured price is charged at the
//   highest configured price.
// - Cache writes are priced by lifetime (five minutes, one hour), cache reads
//   at their own price.

import { TZDate } from '@date-fns/tz';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { format } from 'date-fns';
import { AiError } from './errors';

/** What each kind of request is for; the ledger keeps it with the cost. */
export type Purpose = 'extraction' | 'question';

/** USD per million tokens. */
export interface ModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** Five-minute cache writes. */
  readonly cacheWrite: number;
  /** One-hour cache writes; twice the input price when not given. */
  readonly cacheWrite1h?: number | undefined;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

/**
 * The configured defaults: the requested model and the models its refusals
 * fall back to. Configuration may replace them; the Console's bill is the
 * authority, these only compute an estimate of it.
 */
export const DEFAULT_PRICES: PriceTable = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

export const COMPUTED_LABEL =
  'computed from token counts at the configured prices';

export interface TokenCounts {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheWrite1h: number;
}

/** One attempt's tokens and their computed cost. */
export interface PricedAttempt {
  readonly model: string;
  readonly tokens: TokenCounts;
  readonly usd: number;
  /** Set when the model had no configured price. */
  readonly pricedAs?: string | undefined;
}

export interface SpendEntry {
  /** `YYYY-MM` in the owner's time zone. */
  readonly month: string;
  /** ISO instant the reply arrived. */
  readonly at: string;
  readonly purpose: Purpose;
  /** What the request was for, e.g. the source's hash; never content. */
  readonly key?: string | undefined;
  /** The model that produced the returned message. */
  readonly model: string;
  readonly attempts: readonly PricedAttempt[];
  /** Totals over every attempt. */
  readonly tokens: TokenCounts;
  readonly usd: number;
  readonly computed: true;
  readonly label: typeof COMPUTED_LABEL;
}

/** Where the computed spend is kept; the pipeline backs it with its state. */
export interface SpendLedger {
  /** The computed spend, in USD, already recorded for `month`. */
  spent(month: string): Promise<number> | number;
  record(entry: SpendEntry): Promise<void> | void;
}

/** A ledger in memory, for tests and as the reference behaviour. */
export class MemoryLedger implements SpendLedger {
  readonly entries: SpendEntry[] = [];
  private readonly opening: ReadonlyMap<string, number>;

  constructor(opening: Readonly<Record<string, number>> = {}) {
    this.opening = new Map(Object.entries(opening));
  }

  spent(month: string): number {
    return this.entries
      .filter((e) => e.month === month)
      .reduce((sum, e) => sum + e.usd, this.opening.get(month) ?? 0);
  }

  record(entry: SpendEntry): void {
    this.entries.push(entry);
  }
}

/** The calendar month of `at` in `timeZone`, as `YYYY-MM`. */
export function monthOf(at: Date, timeZone: string): string {
  return format(new TZDate(at, timeZone), 'yyyy-MM');
}

const ZERO: TokenCounts = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
};

function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  };
}

function count(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** The highest price of each kind over `models` (all configured when empty). */
export function highestPrice(
  prices: PriceTable,
  models: readonly string[] = []
): ModelPrice {
  const known = models
    .map((m) => prices[m])
    .filter((p): p is ModelPrice => p !== undefined);
  const pool =
    known.length > 0 && known.length === models.length
      ? known
      : Object.values(prices);
  if (pool.length === 0) {
    throw new AiError('config', 'no model prices are configured', false);
  }
  return {
    input: Math.max(...pool.map((p) => p.input)),
    output: Math.max(...pool.map((p) => p.output)),
    cacheRead: Math.max(...pool.map((p) => p.cacheRead)),
    cacheWrite: Math.max(...pool.map((p) => p.cacheWrite)),
    cacheWrite1h: Math.max(...pool.map((p) => p.cacheWrite1h ?? p.input * 2)),
  };
}

function priceAttempt(
  model: string,
  tokens: TokenCounts,
  prices: PriceTable
): PricedAttempt {
  const configured = prices[model];
  const price = configured ?? highestPrice(prices);
  const usd =
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite * price.cacheWrite +
      tokens.cacheWrite1h * (price.cacheWrite1h ?? price.input * 2)) /
    1_000_000;
  return configured
    ? { model, tokens, usd }
    : {
        model,
        tokens,
        usd,
        pricedAs: `the highest configured price, because ${model} has none`,
      };
}

interface UsageLike {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number | null;
  readonly cache_creation_input_tokens: number | null;
  readonly cache_creation?: {
    readonly ephemeral_1h_input_tokens: number;
    readonly ephemeral_5m_input_tokens: number;
  } | null;
}

function tokensOf(usage: UsageLike): TokenCounts {
  const written = count(usage.cache_creation_input_tokens);
  const hour = count(usage.cache_creation?.ephemeral_1h_input_tokens);
  return {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: Math.max(0, written - hour),
    cacheWrite1h: hour,
  };
}

/**
 * Prices a reply's usage: each attempt of `usage.iterations` at its own
 * model, else the top-level usage at the model that answered.
 */
export function priceUsage(
  message: Pick<BetaMessage, 'model' | 'usage'>,
  requestedModel: string,
  prices: PriceTable
): { attempts: PricedAttempt[]; tokens: TokenCounts; usd: number } {
  const iterations = message.usage.iterations ?? [];
  const attempts =
    iterations.length > 0
      ? iterations.map((it) => {
          const model =
            'model' in it && typeof it.model === 'string'
              ? it.model
              : requestedModel;
          return priceAttempt(model, tokensOf(it), prices);
        })
      : [priceAttempt(message.model, tokensOf(message.usage), prices)];
  return {
    attempts,
    tokens: attempts.reduce((sum, a) => addTokens(sum, a.tokens), ZERO),
    usd: attempts.reduce((sum, a) => sum + a.usd, 0),
  };
}

/** The cache lifetimes a request's breakpoints write. */
export interface CacheWrites {
  readonly fiveMinute: boolean;
  readonly hour: boolean;
}

/**
 * The cache lifetimes `body` asks for: every `cache_control` in it, at any
 * depth (the top level, the system blocks, the tools, the message blocks).
 */
export function cacheWritesOf(body: unknown): CacheWrites {
  let fiveMinute = false;
  let hour = false;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'cache_control') {
        visit(value);
        continue;
      }
      if (value === null || typeof value !== 'object') continue;
      if ('ttl' in value && value.ttl === '1h') hour = true;
      else fiveMinute = true;
    }
  };
  visit(body);
  return { fiveMinute, hour };
}
