// What every pipeline step is given, and the small rules they share.
//
// Invariants:
// - Every change the pipeline makes in SupaMac runs on one lane, one at a
//   time (design, Operations: Memory, "one source at a time"), so two steps
//   never write the same job at once.
// - An error is retryable when trying again later can succeed: a SupaMac
//   error marked retryable, an AI error marked retryable, or a Jobs row that
//   kept moving under the service. Anything else is final.

import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import type { AiClient } from '../ai/anthropic';
import { AiError } from '../ai/errors';
import type { Logger } from '../log';
import { SupaMacError } from '../supamac/client';
import type { WebAppBase } from '../supamac/documents';
import type { ExtractHint, ExtractOutcome } from '../text/types';
import type { HealthMonitor } from './health';
import type { Notifier } from './notify';
import type { StateStore } from './state';
import type { JobsStore } from './store';

export type Extractor = (
  bytes: Uint8Array,
  hint: ExtractHint
) => Promise<ExtractOutcome>;

export interface PipelineContext {
  readonly store: JobsStore;
  readonly state: StateStore;
  /** Undefined when the AI settings are missing; `aiOff` says why. */
  readonly ai: AiClient | undefined;
  readonly aiOff?: string | undefined;
  readonly notifier: Notifier;
  readonly logger: Logger;
  readonly clock: () => Date;
  /** The owner's zone: `/tz`'s, else `JOBS_TIME_ZONE`. */
  readonly timeZone: () => string;
  readonly extract: Extractor;
  readonly webApp?: WebAppBase | undefined;
  readonly health: HealthMonitor;
  readonly lane: Lane;
}

/** Runs tasks one at a time, in the order given. */
export class Lane {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      this.depth++;
      try {
        return await task();
      } finally {
        this.depth--;
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Whether a task is running now. */
  get busy(): boolean {
    return this.depth > 0;
  }

  /** Settles when every task given so far has settled. */
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}

/** A failure the pipeline marks on the source. */
export class PipelineError extends Error {
  readonly kind: 'retryable' | 'final';
  constructor(
    kind: 'retryable' | 'final',
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'PipelineError';
    this.kind = kind;
  }
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof PipelineError) return error.kind === 'retryable';
  if (error instanceof SupaMacError) return error.retryable;
  if (error instanceof AiError) return error.retryable;
  return false;
}

/** One line for a Note or a log field; never a stack. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return 'an unknown error';
}

/** Today in the owner's zone, as YYYY-MM-DD. */
export function today(
  ctx: Pick<PipelineContext, 'clock' | 'timeZone'>
): string {
  return format(
    new TZDate(ctx.clock().getTime(), ctx.timeZone()),
    'yyyy-MM-dd'
  );
}

/** "3 Mar 2027" in the owner's zone. */
export function dayText(
  ctx: Pick<PipelineContext, 'timeZone'>,
  instant: string
): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return instant;
  return format(new TZDate(ms, ctx.timeZone()), 'd MMM yyyy');
}

/** An instant as SQL dates take it: seconds always written, the offset as given. */
export function sqlInstant(value: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const m =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      value
    );
  if (!m) return undefined;
  return `${m[1]}${m[2] ?? ':00'}${m[3]}`;
}

/** Keeps a Note within a length the owner reads. */
export function noteText(parts: readonly (string | undefined)[]): string {
  const text = parts
    .filter((p): p is string => p !== undefined && p.trim() !== '')
    .map((p) => p.trim().replace(/\s+/g, ' '))
    .join(' · ');
  return text.length > 2000 ? `${text.slice(0, 1999)}…` : text;
}
