// The one HTTP client the service uses to reach SupaMac: the gateway's
// document storage routes, signed in as the jobs account by its API key
// (docs/supamac/jobs.md, Security).
//
// Invariants:
// - Every request goes to the configured gateway base (default
//   `http://gateway:8080/dss`) and carries the key only in the
//   `x-macro-user-api-key` header. Redirects are refused, so the key never
//   follows a redirect to another host, and an object download (a presigned
//   URL) is sent without it.
// - The key is never written to a log line, an error message or an error's
//   fields: it is registered with the logger as a secret and masked out of
//   every server message an error carries. The client's errors never carry
//   another error as their cause: a parser's or transport's message can quote
//   what it read, so only its masked text is kept, in the message.
// - Every response body is validated with the request's zod schema before a
//   caller sees it; a body that does not fit is a `bad_response` error.
// - One deadline covers a request from sending to the last byte of its
//   answer, also when the transport ignores the abort signal.
// - A failed request is a `SupaMacError` with a `kind` and a `retryable`
//   flag. Retryable means the same request may succeed later (rate limits,
//   server errors, timeouts, an unreachable gateway); the client itself
//   never retries, because a write may have committed.
// - Path parameters are percent-encoded one by one; a template naming a
//   parameter the request does not give, or a parameter the template does not
//   name, is refused before anything is sent.

import { z } from 'zod';
import { type Logger, maskSecrets } from '../log';

export const DEFAULT_SUPAMAC_BASE_URL = 'http://gateway:8080/dss';
export const API_KEY_HEADER = 'x-macro-user-api-key';
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Most bytes of an error body the client reads. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** Most bytes of an answer the client reads. */
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;
/** Longest server message an error keeps. */
const MAX_DETAIL_CHARS = 500;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface FetchInit {
  readonly method: HttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array | undefined;
  readonly signal: AbortSignal;
  readonly redirect: 'error';
}

/** The part of `fetch` the client uses; tests pass a fake. */
export type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

export type RequestBody =
  | { readonly kind: 'json'; readonly value: unknown }
  | { readonly kind: 'bytes'; readonly value: Uint8Array };

/**
 * One request to a storage route, as the builders in `api.ts` make it:
 * the OpenAPI path template and its parameters, so a test can check it
 * against the spec without sending it.
 */
export interface ApiRequest<T> {
  readonly method: HttpMethod;
  /** The OpenAPI path template, such as `/databases/{id}`. */
  readonly template: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body?: RequestBody | undefined;
  readonly response: z.ZodType<T>;
  readonly timeoutMs?: number | undefined;
  /**
   * Error kinds for statuses this route gives another meaning than
   * `kindForStatus` does, as its spec documents them.
   */
  readonly statusKinds?:
    | Readonly<Partial<Record<number, SupaMacErrorKind>>>
    | undefined;
}

export type SupaMacErrorKind =
  /** 401: the key is missing, wrong or revoked (unless the route says otherwise). */
  | 'unauthorised'
  /** 403, or a route's own 401 for no access: the account may not do this. */
  | 'forbidden'
  /** 404. */
  | 'not_found'
  /** 409: a table moved from its base version, or a write raced another. */
  | 'conflict'
  /** 413: the body is over the route's limit. */
  | 'too_large'
  /** 400 or 422: the request was refused as written. */
  | 'invalid'
  /** 429. */
  | 'rate_limited'
  /** 500. */
  | 'server'
  /** 502, 503, 504, or the gateway did not answer. */
  | 'unavailable'
  /** No answer within the request's time limit. */
  | 'timeout'
  /** An answer that does not fit the route's schema. */
  | 'bad_response'
  /** A request the client refuses to send (a bad id, a missing parameter). */
  | 'request';

const RETRYABLE: ReadonlySet<SupaMacErrorKind> = new Set([
  'rate_limited',
  'server',
  'unavailable',
  'timeout',
]);

/** Why one op of an ops batch was refused (`OpRefusalResponse`). */
export interface OpRefusal {
  readonly op: number;
  readonly row: number | null;
  readonly column: string | null;
  readonly message: string;
  readonly taken: { readonly kind: string; readonly id: string } | null;
}

export class SupaMacError extends Error {
  readonly kind: SupaMacErrorKind;
  readonly retryable: boolean;
  readonly status: number | undefined;
  /** `METHOD /template`, never a URL with ids or a query. */
  readonly route: string;
  /** The server's own message, masked and shortened. */
  readonly detail: string | undefined;
  readonly refusal: OpRefusal | undefined;

  constructor(
    kind: SupaMacErrorKind,
    route: string,
    message: string,
    options: {
      status?: number | undefined;
      detail?: string | undefined;
      refusal?: OpRefusal | undefined;
      cause?: unknown;
    } = {}
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = 'SupaMacError';
    this.kind = kind;
    this.retryable = RETRYABLE.has(kind);
    this.status = options.status;
    this.route = route;
    this.detail = options.detail;
    this.refusal = options.refusal;
  }
}

/** The error kind an HTTP status answers with. */
export function kindForStatus(status: number): SupaMacErrorKind {
  if (status === 400 || status === 422) return 'invalid';
  if (status === 401) return 'unauthorised';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  if (status >= 500) return 'server';
  return 'invalid';
}

export interface SupaMacClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly timeoutMs?: number | undefined;
  readonly logger?: Logger | undefined;
  /** Milliseconds, for request durations in the log. */
  readonly now?: (() => number) | undefined;
}

/** A key the header can carry: printable ASCII without spaces. */
function checkKey(key: string): void {
  if (key.length < 16 || key.length > 512 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new SupaMacError(
      'request',
      'config',
      'the SupaMac API key must be 16 to 512 printable characters without spaces'
    );
  }
}

/** The base URL without a trailing slash; http or https, no credentials, query or fragment. */
export function normaliseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SupaMacError(
      'request',
      'config',
      'the SupaMac base URL is not a URL'
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SupaMacError(
      'request',
      'config',
      'the SupaMac base URL must be http or https'
    );
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new SupaMacError(
      'request',
      'config',
      'the SupaMac base URL must not carry credentials, a query or a fragment'
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The path of a template with its parameters filled in, each percent-encoded. */
export function fillTemplate(
  template: string,
  params: Readonly<Record<string, string>>
): string {
  const used = new Set<string>();
  const path = template.replace(
    /\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_, name: string) => {
      const value = params[name];
      if (value === undefined || value === '') {
        throw new SupaMacError(
          'request',
          template,
          `the request names no value for {${name}}`
        );
      }
      used.add(name);
      return encodeURIComponent(value);
    }
  );
  for (const name of Object.keys(params)) {
    if (!used.has(name)) {
      throw new SupaMacError(
        'request',
        template,
        `the template has no parameter {${name}}`
      );
    }
  }
  return path;
}

async function readCapped(
  response: Response,
  maxBytes: number
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RangeError(`body over ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const ErrorMessageSchema = z.object({ message: z.string() });

/** JSON text parsed, or not JSON; a plain-text error body is kept as text. */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const OpRefusalSchema = z.object({
  op: z.number().int().nonnegative(),
  row: z.number().int().nullable().optional(),
  column: z.string().nullable().optional(),
  message: z.string(),
  taken: z.object({ kind: z.string(), id: z.string() }).nullable().optional(),
});

function parseRefusal(body: unknown): OpRefusal | undefined {
  const parsed = OpRefusalSchema.safeParse(body);
  if (!parsed.success) return undefined;
  return {
    op: parsed.data.op,
    row: parsed.data.row ?? null,
    column: parsed.data.column ?? null,
    message: parsed.data.message,
    taken: parsed.data.taken ?? null,
  };
}

export class SupaMacClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly logger: Logger | undefined;
  private readonly now: () => number;

  constructor(options: SupaMacClientOptions) {
    checkKey(options.apiKey);
    this.apiKey = options.apiKey;
    this.baseUrl = normaliseBaseUrl(
      options.baseUrl ?? DEFAULT_SUPAMAC_BASE_URL
    );
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger;
    this.now = options.now ?? (() => performance.now());
    this.logger?.addSecret(options.apiKey);
  }

  /** The gateway's origin, where presigned object paths are served. */
  get origin(): string {
    return new URL(this.baseUrl).origin;
  }

  /** The URL a request goes to. */
  urlFor(
    request: Pick<ApiRequest<unknown>, 'template' | 'params' | 'query'>
  ): string {
    const path = fillTemplate(request.template, request.params);
    const query = new URLSearchParams(Object.entries(request.query)).toString();
    return `${this.baseUrl}${path}${query === '' ? '' : `?${query}`}`;
  }

  private mask(text: string): string {
    return maskSecrets(text, [this.apiKey]);
  }

  /** An error's message, masked and shortened, for an error of the client's own. */
  private reason(error: unknown): string {
    return error instanceof Error
      ? this.mask(error.message).slice(0, MAX_DETAIL_CHARS)
      : 'unknown';
  }

  /** Sends one request and returns its validated body. */
  async send<T>(request: ApiRequest<T>): Promise<T> {
    const route = `${request.method} ${request.template}`;
    const url = this.urlFor(request);
    const headers: Record<string, string> = {
      accept: 'application/json',
      [API_KEY_HEADER]: this.apiKey,
    };
    let body: string | Uint8Array | undefined;
    if (request.body?.kind === 'json') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(request.body.value);
    } else if (request.body?.kind === 'bytes') {
      headers['content-type'] = 'application/octet-stream';
      body = request.body.value;
    }
    const started = this.now();
    const answer = await this.exchange(
      route,
      url,
      {
        method: request.method,
        headers,
        body,
        timeoutMs: request.timeoutMs ?? this.timeoutMs,
      },
      async (response) =>
        response.ok
          ? {
              status: response.status,
              text: new TextDecoder().decode(
                await readCapped(response, MAX_ANSWER_BYTES)
              ),
            }
          : {
              status: response.status,
              error: await this.errorFor(route, response, request.statusKinds),
            },
      (error) =>
        new SupaMacError(
          'bad_response',
          route,
          `the answer could not be read: ${this.reason(error)}`
        )
    );
    const ms = Math.round(this.now() - started);
    if ('error' in answer) {
      this.logger?.warn('supamac request failed', {
        route,
        status: answer.status,
        kind: answer.error.kind,
        ms,
      });
      throw answer.error;
    }
    const { status, text } = answer;
    let json: unknown = null;
    if (text.trim() !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        // The parser's message quotes the body, which may echo the key.
        throw new SupaMacError(
          'bad_response',
          route,
          'the answer is not JSON',
          { status }
        );
      }
    }
    const parsed = request.response.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where =
        issue === undefined ? '' : ` at ${issue.path.join('.') || 'the top'}`;
      throw new SupaMacError(
        'bad_response',
        route,
        `the answer does not fit the route's schema${where}`,
        { status }
      );
    }
    this.logger?.debug('supamac request', { route, status, ms });
    return parsed.data;
  }

  /**
   * Fetches an object by a presigned URL the service gave, without the key.
   * Only paths under `/local-storage/` are fetched, from the gateway's own
   * origin: the store signs them for its in-network name, which the gateway
   * supplies, so the public host the URL names is never contacted.
   */
  async fetchObject(
    presignedUrl: string,
    options: {
      readonly maxBytes: number;
      readonly timeoutMs?: number | undefined;
    }
  ): Promise<Uint8Array> {
    const route = 'GET /local-storage/*';
    let url: URL;
    try {
      url = new URL(presignedUrl);
    } catch {
      // The parser's message quotes the URL, whose signature grants the object.
      throw new SupaMacError(
        'bad_response',
        route,
        'the object URL is not a URL'
      );
    }
    if (!url.pathname.startsWith('/local-storage/')) {
      throw new SupaMacError(
        'bad_response',
        route,
        'the object URL is not a path of the gateway object store'
      );
    }
    const target = `${this.origin}${url.pathname}${url.search}`;
    const tooLarge = (): SupaMacError =>
      new SupaMacError(
        'too_large',
        route,
        `the object is over ${options.maxBytes} bytes`
      );
    return this.exchange(
      route,
      target,
      {
        method: 'GET',
        headers: {},
        body: undefined,
        timeoutMs: options.timeoutMs ?? this.timeoutMs * 4,
      },
      async (response) => {
        if (!response.ok) {
          await response.body?.cancel();
          throw new SupaMacError(
            kindForStatus(response.status),
            route,
            `the object store answered ${response.status}`,
            { status: response.status }
          );
        }
        const declared = Number(
          response.headers.get('content-length') ?? 'NaN'
        );
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          await response.body?.cancel();
          throw tooLarge();
        }
        return readCapped(response, options.maxBytes);
      },
      (error) =>
        error instanceof RangeError
          ? tooLarge()
          : new SupaMacError(
              'unavailable',
              route,
              `the object download broke off: ${this.reason(error)}`
            )
    );
  }

  /**
   * Sends one request and reads its answer under one deadline: the time
   * limit covers the body as well as the headers.
   */
  private async exchange<R>(
    route: string,
    url: string,
    init: {
      method: HttpMethod;
      headers: Record<string, string>;
      body: string | Uint8Array | undefined;
      timeoutMs: number;
    },
    read: (response: Response) => Promise<R>,
    readError: (error: unknown) => SupaMacError
  ): Promise<R> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = (): SupaMacError =>
      new SupaMacError(
        'timeout',
        route,
        `no answer within ${init.timeoutMs} ms`
      );
    // Settles only when the deadline passes, so a transport that ignores the
    // abort signal still cannot hold a request past it.
    const deadline = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(timeout()), {
        once: true,
      });
    });
    deadline.catch(() => undefined); // Raced below; marked handled for when nothing awaits it.
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, init.timeoutMs);
    try {
      let response: Response;
      try {
        response = await Promise.race([
          this.fetchImpl(url, {
            method: init.method,
            headers: init.headers,
            body: init.body,
            signal: controller.signal,
            redirect: 'error',
          }),
          deadline,
        ]);
      } catch (error) {
        if (timedOut) throw timeout();
        throw new SupaMacError(
          'unavailable',
          route,
          `the gateway did not answer: ${this.reason(error)}`
        );
      }
      try {
        return await Promise.race([read(response), deadline]);
      } catch (error) {
        if (timedOut) throw timeout();
        if (error instanceof SupaMacError) throw error;
        throw readError(error);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async errorFor(
    route: string,
    response: Response,
    statusKinds: ApiRequest<unknown>['statusKinds']
  ): Promise<SupaMacError> {
    let detail: string | undefined;
    let refusal: OpRefusal | undefined;
    let text = '';
    try {
      text = new TextDecoder().decode(
        await readCapped(response, MAX_ERROR_BODY_BYTES)
      );
    } catch (error) {
      // The status alone still says what failed; the body is only a detail.
      text = error instanceof RangeError ? '(error body too long to read)' : '';
    }
    if (text.trim() !== '') {
      let message = text;
      const json = parseJson(text);
      if (json.ok) {
        refusal = parseRefusal(json.value);
        const m = ErrorMessageSchema.safeParse(json.value);
        if (m.success) message = m.data.message;
      }
      detail = this.mask(message).slice(0, MAX_DETAIL_CHARS);
    }
    if (refusal !== undefined) {
      refusal = {
        ...refusal,
        message: this.mask(refusal.message).slice(0, MAX_DETAIL_CHARS),
      };
    }
    const kind =
      statusKinds?.[response.status] ?? kindForStatus(response.status);
    const message = `${route} answered ${response.status}${detail === undefined ? '' : `: ${detail}`}`;
    return new SupaMacError(kind, route, message, {
      status: response.status,
      detail,
      refusal,
    });
  }
}
