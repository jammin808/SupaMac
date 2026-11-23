// Errors of a call to Claude, typed and sorted into retryable and final
// (docs/supamac/jobs.md §3: an overloaded or unreachable API keeps a source
// Processing and retries; anything else fails it).
//
// Invariants:
// - Retryable: 429, 408, 409, 5xx, overloaded, a connection failure, a
//   timeout and an abort, and a stream's error event of a retryable type.
// - Final: everything else, and a workspace, contract or organisation spend
//   limit even when it comes as a 429.
// - The SDK's error is kept as the cause.

import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AnthropicError,
} from '@anthropic-ai/sdk';

export type AiErrorKind =
  | 'rate_limited'
  | 'overloaded'
  | 'server'
  | 'timeout'
  | 'connection'
  | 'aborted'
  | 'conflict'
  | 'spend_limit'
  | 'auth'
  | 'billing'
  | 'request'
  | 'response'
  | 'config'
  | 'ledger'
  | 'unknown';

export class AiError extends Error {
  readonly kind: AiErrorKind;
  /** True when trying again later can succeed (the source stays Processing). */
  readonly retryable: boolean;
  readonly status?: number | undefined;

  constructor(
    kind: AiErrorKind,
    message: string,
    retryable: boolean,
    options: { status?: number | undefined; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = 'AiError';
    this.kind = kind;
    this.retryable = retryable;
    this.status = options.status;
  }
}

const RETRYABLE_TYPES = new Set([
  'overloaded_error',
  'api_error',
  'rate_limit_error',
  'timeout_error',
]);

const SPEND_LIMIT_CODES = new Set([
  'enforced_spend_limit_reached',
  'contract_spend_limit_reached',
  'linked_organization_spend_limit_reached',
]);

/** Sorts what the SDK threw into retryable and final, keeping it as the cause. */
export function classifyError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof APIUserAbortError) {
    return new AiError('aborted', 'the request was aborted', true, {
      cause: error,
    });
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new AiError('timeout', 'the API did not answer in time', true, {
      cause: error,
    });
  }
  if (error instanceof APIConnectionError) {
    return new AiError('connection', 'the API could not be reached', true, {
      cause: error,
    });
  }
  if (error instanceof APIError) {
    const status = error.status;
    const type = error.type;
    const code = error.errorCode;
    const options = { status, cause: error };
    if (code !== null && SPEND_LIMIT_CODES.has(code)) {
      return new AiError(
        'spend_limit',
        'the Anthropic workspace has reached its spend limit',
        false,
        options
      );
    }
    if (status === undefined) {
      // An error event inside an open stream carries a type but no status.
      if (type === 'overloaded_error')
        return new AiError(
          'overloaded',
          'the API is overloaded',
          true,
          options
        );
      if (type !== null && RETRYABLE_TYPES.has(type))
        return new AiError(
          'server',
          `the stream failed (${type})`,
          true,
          options
        );
      return new AiError(
        'response',
        `the stream failed (${type ?? 'no error type'})`,
        false,
        options
      );
    }
    if (status === 529 || type === 'overloaded_error')
      return new AiError('overloaded', 'the API is overloaded', true, options);
    if (status === 429)
      return new AiError(
        'rate_limited',
        'the API is rate limiting',
        true,
        options
      );
    if (status === 408)
      return new AiError(
        'timeout',
        'the API timed out the request',
        true,
        options
      );
    if (status === 409)
      return new AiError(
        'conflict',
        'the API reported a conflict',
        true,
        options
      );
    if (status >= 500)
      return new AiError(
        'server',
        `the API failed (HTTP ${status})`,
        true,
        options
      );
    if (status === 401 || status === 403)
      return new AiError(
        'auth',
        `the API refused the key (HTTP ${status})`,
        false,
        options
      );
    if (status === 402)
      return new AiError(
        'billing',
        'the API account needs payment (HTTP 402)',
        false,
        options
      );
    return new AiError(
      'request',
      `the API refused the request (HTTP ${status})`,
      false,
      options
    );
  }
  if (error instanceof AnthropicError) {
    return new AiError('response', 'the SDK could not read the reply', false, {
      cause: error,
    });
  }
  return new AiError('unknown', 'the call failed unexpectedly', false, {
    cause: error,
  });
}
