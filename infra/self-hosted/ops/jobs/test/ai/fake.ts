// A fake of the SDK surface src/ai/anthropic.ts uses: it records every
// request and answers from a script of messages and errors. No network.

import { APIError } from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaIterationsUsage,
  BetaMessage,
  BetaMessageStreamParams,
  BetaRefusalStopDetails,
  BetaStopReason,
  BetaToolUseBlock,
  BetaUsage,
  MessageCountTokensParams,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ErrorType } from '@anthropic-ai/sdk/resources/shared';
import {
  AiClient,
  type AiClientOptions,
  MemoryLedger,
  type MessagesClient,
  type MessageStreamLike,
} from '../../src/ai/anthropic';

export type Step =
  | BetaMessage
  | Error
  | ((body: BetaMessageStreamParams) => BetaMessage | Error);

export class FakeClient implements MessagesClient {
  readonly requests: BetaMessageStreamParams[] = [];
  readonly counted: MessageCountTokensParams[] = [];
  private readonly steps: Step[];
  inputTokens: number;
  countError: Error | undefined;

  constructor(steps: Step[], inputTokens = 2_000) {
    this.steps = [...steps];
    this.inputTokens = inputTokens;
  }

  get remaining(): number {
    return this.steps.length;
  }

  readonly beta = {
    messages: {
      stream: (body: BetaMessageStreamParams): MessageStreamLike => {
        // A deep copy, so later pushes to the caller's arrays do not show here.
        this.requests.push(structuredClone(body));
        const step = this.steps.shift();
        return {
          finalMessage: async () => {
            if (step === undefined)
              throw new Error('the fake has no more replies');
            const out = typeof step === 'function' ? step(body) : step;
            if (out instanceof Error) throw out;
            return out;
          },
          abort: () => {},
        };
      },
      countTokens: async (
        body: MessageCountTokensParams
      ): Promise<{ input_tokens: number }> => {
        this.counted.push(structuredClone(body));
        if (this.countError) throw this.countError;
        return { input_tokens: this.inputTokens };
      },
    },
  };
}

export function usage(
  input: number,
  output: number,
  extra: {
    cacheRead?: number;
    cacheWrite?: number;
    iterations?: BetaIterationsUsage;
  } = {}
): BetaUsage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: extra.cacheWrite ?? 0,
    cache_read_input_tokens: extra.cacheRead ?? 0,
    fallback_credit: null,
    inference_geo: null,
    input_tokens: input,
    iterations: extra.iterations ?? null,
    output_tokens: output,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: 'standard',
    speed: 'standard',
  };
}

export function text(t: string): BetaContentBlock {
  return { type: 'text', text: t, citations: null };
}

export function thinking(): BetaContentBlock {
  return { type: 'thinking', thinking: '', signature: 'sig' };
}

export function toolUse(
  id: string,
  name: string,
  input: unknown
): BetaToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

export function fallbackBlock(from: string, to: string): BetaContentBlock {
  return {
    type: 'fallback',
    from: { model: from },
    to: { model: to },
    trigger: { type: 'refusal', category: 'cyber' },
  };
}

export function message(options: {
  content: BetaContentBlock[];
  stop: BetaStopReason;
  usage?: BetaUsage;
  model?: string;
  stopDetails?: BetaRefusalStopDetails;
}): BetaMessage {
  return {
    id: 'msg_test',
    container: null,
    content: options.content,
    context_management: null,
    diagnostics: null,
    model: options.model ?? 'claude-opus-5-5',
    role: 'assistant',
    stop_details: options.stopDetails ?? null,
    stop_reason: options.stop,
    stop_sequence: null,
    type: 'message',
    usage: options.usage ?? usage(2_000, 500),
  };
}

export function jsonReply(value: unknown, u?: BetaUsage): BetaMessage {
  return message({
    content: [thinking(), text(JSON.stringify(value))],
    stop: 'end_turn',
    ...(u ? { usage: u } : {}),
  });
}

export function refusal(
  category: BetaRefusalStopDetails['category']
): BetaMessage {
  return message({
    content: [],
    stop: 'refusal',
    usage: usage(2_000, 0),
    stopDetails: {
      type: 'refusal',
      category,
      explanation: 'declined by a classifier',
      fallback_credit_token: null,
      fallback_has_prefill_claim: null,
      recommended_model: null,
    },
  });
}

/** An HTTP error as the SDK makes it from a response. */
export function httpError(
  status: number,
  type: string,
  errorCode?: string
): APIError {
  return APIError.generate(
    status,
    {
      type: 'error',
      error: {
        type,
        message: `${type} for a test`,
        ...(errorCode ? { details: { error_code: errorCode } } : {}),
      },
    },
    undefined,
    new Headers()
  );
}

/** An error event inside an open stream: a type, no status. */
export function streamError(type: ErrorType): APIError {
  return new APIError(
    undefined,
    { type: 'error', error: { type, message: `${type} in a stream` } },
    undefined,
    new Headers(),
    type
  );
}

export const NOW = new Date('2027-03-12T10:00:00Z');

export function aiClient(
  fake: FakeClient,
  options: Partial<AiClientOptions> = {}
): { ai: AiClient; ledger: MemoryLedger } {
  const ledger =
    options.ledger instanceof MemoryLedger
      ? options.ledger
      : new MemoryLedger();
  const ai = new AiClient({
    client: fake,
    monthlyLimitUsd: 50,
    ledger,
    timeZone: 'Europe/London',
    clock: () => NOW,
    ...options,
  });
  return { ai, ledger };
}
