// The Telegram Bot API over an injectable fetch (docs/supamac/jobs.md §1,
// Security: the bot token).
//
// Invariants:
// - The bot token is in every request URL and in nothing this module
//   returns, throws or logs, in any of its spellings: as it is, and with its
//   colon percent-encoded in upper or lower case, each registered with the
//   logger too. An error's message is built from the method, the HTTP status
//   and Telegram's own description, each masked; a transport error's text is
//   masked before it is kept, and its object is never kept as a cause. A
//   downloaded file's URL never leaves `download`.
// - Every response is read with a size cap and validated with zod; a reply
//   that does not parse is a `TelegramError` of kind `invalid_response`. A
//   date is a Unix time a Date holds and a calendar formats (years 1970 to
//   9999), so nothing read from an update throws when it is used.
// - `getUpdates` long-polls (timeout 50) for messages and button presses only
//   (`allowed_updates`); the offset is the caller's, so an update is
//   confirmed to Telegram only once the caller has handled it. An update
//   whose parts do not parse keeps its id and is returned as `other`, so it
//   can still be acknowledged.
// - A 409 Conflict is kind `conflict`: another program polls with this token
//   or a webhook is set. It is never retried here.
// - A 429 is waited out for its `retry_after` and sent again, at most
//   `RATE_RETRIES` times and only when the wait is at most
//   `MAX_RETRY_AFTER_S`; otherwise it is thrown as `rate_limited` with the
//   wait. Nothing else is sent again here: a request that may have landed
//   is not repeated.
// - Files are downloaded in-process: refused above the cap from the size
//   Telegram states, and counted while read, so a file that states no size
//   or the wrong one is still cut off at the cap.
// - Messages are sent with parse_mode HTML and link previews off; a button's
//   callback data over 64 bytes is refused before anything is sent.
//
// Choices where the API leaves room, each the more cautious one:
// - The download cap is 20 MiB (Telegram's bot limit is "20 MB"); a file
//   Telegram refuses as too big is the same `too_big`.
// - "message is not modified" on an edit is success: the message already
//   reads as asked.

import { z } from 'zod';
import { type Logger, SecretRegistry } from '../log';

export const TELEGRAM_API = 'https://api.telegram.org';
/** Long polling: how long Telegram holds a getUpdates open, in seconds. */
export const POLL_TIMEOUT_S = 50;
export const ALLOWED_UPDATES = ['message', 'callback_query'] as const;
/** The most a downloaded file may be. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** The most a document the bot sends may be (Telegram's upload limit). */
export const MAX_UPLOAD_BYTES = 50 * 1000 * 1000;
/** The most a JSON response may be. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_CALLBACK_DATA_BYTES = 64;
/** A document's caption, in characters (it is HTML, so it is never cut). */
export const MAX_CAPTION_CHARS = 1024;
/** The longest 429 wait that is waited out rather than thrown. */
export const MAX_RETRY_AFTER_S = 120;
export const RATE_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export type TelegramErrorKind =
  /** The request did not complete. */
  | 'network'
  | 'timeout'
  /** The caller's signal stopped it. */
  | 'aborted'
  /** 409: another poller, or a webhook set. */
  | 'conflict'
  | 'rate_limited'
  /** 401: the token was refused. */
  | 'unauthorised'
  /** 403: the owner blocked the bot, or it cannot write to the chat. */
  | 'forbidden'
  | 'bad_request'
  | 'too_big'
  | 'server'
  | 'invalid_response'
  /** The bot has no linked owner to tell. */
  | 'not_linked'
  /** The bot stopped after a conflict or a webhook: nothing more is sent. */
  | 'halted';

export class TelegramError extends Error {
  readonly kind: TelegramErrorKind;
  readonly method: string;
  readonly status?: number | undefined;
  /** For `rate_limited`: the seconds Telegram asked to wait. */
  readonly retryAfter?: number | undefined;
  /** Telegram's own description, masked. */
  readonly description?: string | undefined;

  constructor(
    kind: TelegramErrorKind,
    method: string,
    message: string,
    extra: {
      status?: number | undefined;
      retryAfter?: number | undefined;
      description?: string | undefined;
    } = {}
  ) {
    super(message);
    this.name = 'TelegramError';
    this.kind = kind;
    this.method = method;
    this.status = extra.status;
    this.retryAfter = extra.retryAfter;
    this.description = extra.description;
  }
}

/** The part of `fetch` the API uses. */
export type TelegramFetch = (
  url: string,
  init: RequestInit
) => Promise<Response>;

/** Waits `ms`, or less when the signal is aborted; never rejects. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const sleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener('abort', done, { once: true });
  });

// ---------------------------------------------------------------------------
// What Telegram sends, as far as the bot reads it.

export const UserSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  can_join_groups: z.boolean().optional(),
});
export type User = z.infer<typeof UserSchema>;

export const ChatSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  title: z.string().optional(),
  username: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});
export type Chat = z.infer<typeof ChatSchema>;

const FileSize = z.number().int().nonnegative().optional();

/** The last second of 9999: the latest time a stamp is written for. */
export const MAX_UNIX_SECONDS = 253_402_300_799;
/** A Unix time in seconds, as Telegram dates a message (0: not known). */
const UnixSeconds = z.number().int().min(0).max(MAX_UNIX_SECONDS);

export const PhotoSizeSchema = z.object({
  file_id: z.string().min(1),
  file_unique_id: z.string(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  file_size: FileSize,
});
export type PhotoSize = z.infer<typeof PhotoSizeSchema>;

export const DocumentSchema = z.object({
  file_id: z.string().min(1),
  file_unique_id: z.string(),
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
  file_size: FileSize,
});
export type TgDocument = z.infer<typeof DocumentSchema>;

export const MessageOriginSchema = z.object({
  type: z.string(),
  date: UnixSeconds,
  sender_user: UserSchema.optional(),
  sender_user_name: z.string().optional(),
  sender_chat: ChatSchema.optional(),
  chat: ChatSchema.optional(),
  author_signature: z.string().optional(),
});
export type MessageOrigin = z.infer<typeof MessageOriginSchema>;

/** Kinds of message content the bot does not read; only their presence counts. */
export const UNREAD_CONTENT = [
  'animation',
  'audio',
  'contact',
  'dice',
  'game',
  'location',
  'paid_media',
  'poll',
  'sticker',
  'story',
  'venue',
  'video',
  'video_note',
  'voice',
] as const;

export const MessageSchema = z.object({
  message_id: z.number().int(),
  from: UserSchema.optional(),
  sender_chat: ChatSchema.optional(),
  date: UnixSeconds,
  chat: ChatSchema,
  text: z.string().optional(),
  caption: z.string().optional(),
  document: DocumentSchema.optional(),
  photo: z.array(PhotoSizeSchema).optional(),
  forward_origin: MessageOriginSchema.optional(),
  /** The pre-7.0 mark of a forward; read only as "this is a forward". */
  forward_date: UnixSeconds.optional(),
  is_automatic_forward: z.boolean().optional(),
  animation: z.unknown().optional(),
  audio: z.unknown().optional(),
  contact: z.unknown().optional(),
  dice: z.unknown().optional(),
  game: z.unknown().optional(),
  location: z.unknown().optional(),
  paid_media: z.unknown().optional(),
  poll: z.unknown().optional(),
  sticker: z.unknown().optional(),
  story: z.unknown().optional(),
  venue: z.unknown().optional(),
  video: z.unknown().optional(),
  video_note: z.unknown().optional(),
  voice: z.unknown().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

/** Whether a message holds content the bot does not read (a voice note, a sticker, ...). */
export function hasUnreadContent(message: Message): boolean {
  return UNREAD_CONTENT.some((k) => message[k] !== undefined);
}

export const CallbackQuerySchema = z.object({
  id: z.string().min(1),
  from: UserSchema,
  /** The message the button was on; `date` 0 when it is no longer accessible. */
  message: z
    .object({
      message_id: z.number().int(),
      chat: ChatSchema,
      date: UnixSeconds,
    })
    .optional(),
  inline_message_id: z.string().optional(),
  data: z.string().optional(),
});
export type CallbackQuery = z.infer<typeof CallbackQuerySchema>;

export type IncomingUpdate =
  | {
      readonly id: number;
      readonly kind: 'message';
      readonly message: Message;
    }
  | {
      readonly id: number;
      readonly kind: 'callback';
      readonly query: CallbackQuery;
    }
  /** Anything else, or a message or press that did not parse. */
  | { readonly id: number; readonly kind: 'other' };

const RawUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
});

/** Reads one element of a getUpdates result; undefined when it has no id. */
export function readUpdate(raw: unknown): IncomingUpdate | undefined {
  const head = RawUpdateSchema.safeParse(raw);
  if (!head.success) return undefined;
  const id = head.data.update_id;
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body).filter((k) => k !== 'update_id');
  if (keys.length === 1 && keys[0] === 'message') {
    const m = MessageSchema.safeParse(body.message);
    if (m.success) return { id, kind: 'message', message: m.data };
  } else if (keys.length === 1 && keys[0] === 'callback_query') {
    const q = CallbackQuerySchema.safeParse(body.callback_query);
    if (q.success) return { id, kind: 'callback', query: q.data };
  }
  return { id, kind: 'other' };
}

export const WebhookInfoSchema = z.object({
  url: z.string(),
  pending_update_count: z.number().int().optional(),
});
export type WebhookInfo = z.infer<typeof WebhookInfoSchema>;

export const FileSchema = z.object({
  file_id: z.string(),
  file_unique_id: z.string(),
  file_size: FileSize,
  file_path: z.string().optional(),
});
export type TgFile = z.infer<typeof FileSchema>;

export const SentMessageSchema = z.object({
  message_id: z.number().int(),
  chat: ChatSchema,
  date: z.number().int(),
});
export type SentMessage = z.infer<typeof SentMessageSchema>;

const EnvelopeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().int().optional(),
  description: z.string().optional(),
  parameters: z
    .object({
      retry_after: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export interface Button {
  readonly text: string;
  readonly data: string;
}

/** Rows of inline buttons, each carrying callback data. */
export type Keyboard = readonly (readonly Button[])[];

/** A file path as Telegram gives it: no traversal, nothing outside a plain path. */
const FILE_PATH_RE =
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;

/**
 * The token as it is and with its colon percent-encoded in either case; a
 * registry adds the upper-case encoding itself, the lower-case one only here.
 */
export function tokenForms(token: string): string[] {
  const lower = token.replace(/:/g, '%3a');
  return lower === token ? [token] : [token, lower];
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Read through a call, so a check after an await is not narrowed away. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'an unknown error';
}

export interface BotApiOptions {
  readonly token: string;
  readonly fetch?: TelegramFetch | undefined;
  readonly sleep?: Sleep | undefined;
  readonly logger?: Logger | undefined;
  /** Telegram's address; the official one unless a test gives its fake's. */
  readonly baseUrl?: string | undefined;
}

export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

type Body = Record<string, unknown> | (() => FormData);

export class BotApi {
  private readonly token: string;
  private readonly fetch: TelegramFetch;
  private readonly sleep: Sleep;
  private readonly logger: Logger | undefined;
  private readonly base: string;
  private readonly secrets = new SecretRegistry();

  constructor(options: BotApiOptions) {
    this.token = options.token;
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? sleep;
    this.logger = options.logger;
    this.base = (options.baseUrl ?? TELEGRAM_API).replace(/\/+$/, '');
    for (const form of tokenForms(options.token)) {
      this.secrets.add(form);
      options.logger?.addSecret(form);
    }
  }

  /** Masks the token (and the known token shapes) in a text. */
  mask(text: string): string {
    return this.secrets.mask(text);
  }

  getMe(options: CallOptions = {}): Promise<User> {
    return this.call('getMe', UserSchema, {}, options);
  }

  getWebhookInfo(options: CallOptions = {}): Promise<WebhookInfo> {
    return this.call('getWebhookInfo', WebhookInfoSchema, {}, options);
  }

  /** One long poll; updates from `offset` on, each read as far as the bot reads it. */
  async getUpdates(
    offset: number | undefined,
    options: CallOptions = {}
  ): Promise<IncomingUpdate[]> {
    const raw = await this.call(
      'getUpdates',
      z.array(z.unknown()),
      {
        ...(offset !== undefined ? { offset } : {}),
        timeout: POLL_TIMEOUT_S,
        allowed_updates: [...ALLOWED_UPDATES],
      },
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? (POLL_TIMEOUT_S + 15) * 1000,
      }
    );
    const out: IncomingUpdate[] = [];
    for (const element of raw) {
      const update = readUpdate(element);
      if (update === undefined) {
        this.logger?.warn('telegram update without an id was left out');
        continue;
      }
      out.push(update);
    }
    return out.sort((a, b) => a.id - b.id);
  }

  getFile(fileId: string, options: CallOptions = {}): Promise<TgFile> {
    return this.call('getFile', FileSchema, { file_id: fileId }, options);
  }

  /** A file's bytes, read in-process and cut off above `maxBytes`. */
  async download(
    file: TgFile,
    maxBytes: number = MAX_DOWNLOAD_BYTES,
    options: CallOptions = {}
  ): Promise<Uint8Array> {
    const method = 'download';
    if (file.file_size !== undefined && file.file_size > maxBytes)
      throw new TelegramError('too_big', method, 'the file is over the cap');
    const path = file.file_path;
    if (path === undefined || !FILE_PATH_RE.test(path) || path.includes('..'))
      throw new TelegramError(
        'invalid_response',
        method,
        'Telegram gave no usable path for the file'
      );
    const timeout = AbortSignal.timeout(
      options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS
    );
    const signal =
      options.signal === undefined
        ? timeout
        : AbortSignal.any([options.signal, timeout]);
    let response: Response;
    try {
      response = await this.fetch(
        `${this.base}/file/bot${this.token}/${path}`,
        {
          method: 'GET',
          signal,
        }
      );
    } catch (error) {
      throw this.transportError(method, error, options.signal, timeout);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new TelegramError(
        response.status >= 500 ? 'server' : 'bad_request',
        method,
        `the file download answered HTTP ${response.status}`,
        { status: response.status }
      );
    }
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new TelegramError('too_big', method, 'the file is over the cap');
    }
    try {
      return await readCapped(response, maxBytes, method);
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw this.transportError(method, error, options.signal, timeout);
    }
  }

  async sendMessage(
    chatId: number,
    html: string,
    keyboard?: Keyboard | undefined,
    options: CallOptions = {}
  ): Promise<SentMessage> {
    return await this.call(
      'sendMessage',
      SentMessageSchema,
      {
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...markup('sendMessage', keyboard),
      },
      options
    );
  }

  /** Edits a message's text and buttons; no buttons when `keyboard` is undefined. */
  async editMessageText(
    chatId: number,
    messageId: number,
    html: string,
    keyboard?: Keyboard | undefined,
    options: CallOptions = {}
  ): Promise<void> {
    try {
      await this.call(
        'editMessageText',
        z.union([z.literal(true), SentMessageSchema]),
        {
          chat_id: chatId,
          message_id: messageId,
          text: html,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...markup('editMessageText', keyboard ?? []),
        },
        options
      );
    } catch (error) {
      if (
        error instanceof TelegramError &&
        error.kind === 'bad_request' &&
        /message is not modified/i.test(error.description ?? '')
      )
        return;
      throw error;
    }
  }

  async answerCallbackQuery(
    queryId: string,
    text?: string | undefined,
    options: CallOptions = {}
  ): Promise<void> {
    await this.call(
      'answerCallbackQuery',
      z.literal(true),
      {
        callback_query_id: queryId,
        ...(text !== undefined ? { text: text.slice(0, 200) } : {}),
      },
      options
    );
  }

  /** Sends a file the service holds (an original) as a document. */
  async sendDocument(
    chatId: number,
    fileName: string,
    bytes: Uint8Array,
    captionHtml?: string | undefined,
    options: CallOptions = {}
  ): Promise<SentMessage> {
    if (bytes.length > MAX_UPLOAD_BYTES)
      throw new TelegramError(
        'too_big',
        'sendDocument',
        'the file is over the upload limit'
      );
    if (captionHtml !== undefined && captionHtml.length > MAX_CAPTION_CHARS)
      throw new TelegramError(
        'bad_request',
        'sendDocument',
        `a caption is at most ${MAX_CAPTION_CHARS} characters`
      );
    const form = (): FormData => {
      const data = new FormData();
      data.set('chat_id', String(chatId));
      data.set('document', new Blob([bytes]), fileName);
      if (captionHtml !== undefined) {
        data.set('caption', captionHtml);
        data.set('parse_mode', 'HTML');
      }
      return data;
    };
    return await this.call('sendDocument', SentMessageSchema, form, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    });
  }

  // --- The one request path.

  private async call<T>(
    method: string,
    schema: z.ZodType<T>,
    body: Body,
    options: CallOptions
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(method, schema, body, options);
      } catch (error) {
        if (
          error instanceof TelegramError &&
          error.kind === 'rate_limited' &&
          error.retryAfter !== undefined &&
          error.retryAfter <= MAX_RETRY_AFTER_S &&
          attempt < RATE_RETRIES &&
          !isAborted(options.signal)
        ) {
          this.logger?.warn('telegram asked to wait', {
            method,
            retryAfterS: error.retryAfter,
          });
          await this.sleep(error.retryAfter * 1000, options.signal);
          if (isAborted(options.signal))
            throw new TelegramError('aborted', method, `${method} was stopped`);
          continue;
        }
        throw error;
      }
    }
  }

  private async once<T>(
    method: string,
    schema: z.ZodType<T>,
    body: Body,
    options: CallOptions
  ): Promise<T> {
    const timeout = AbortSignal.timeout(
      options.timeoutMs ?? REQUEST_TIMEOUT_MS
    );
    const signal =
      options.signal === undefined
        ? timeout
        : AbortSignal.any([options.signal, timeout]);
    const init: RequestInit =
      typeof body === 'function'
        ? { method: 'POST', body: body(), signal }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal,
          };
    let response: Response;
    let text: string;
    try {
      response = await this.fetch(
        `${this.base}/bot${this.token}/${method}`,
        init
      );
      text = new TextDecoder().decode(
        await readCapped(response, MAX_RESPONSE_BYTES, method)
      );
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw this.transportError(method, error, options.signal, timeout);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new TelegramError(
        response.status >= 500 ? 'server' : 'invalid_response',
        method,
        `${method} answered HTTP ${response.status} without JSON`,
        { status: response.status }
      );
    }
    const envelope = EnvelopeSchema.safeParse(json);
    if (!envelope.success)
      throw new TelegramError(
        'invalid_response',
        method,
        `${method} answered in an unknown shape`,
        { status: response.status }
      );
    const e = envelope.data;
    if (!e.ok) throw this.apiError(method, response.status, e);
    const result = schema.safeParse(e.result);
    if (!result.success)
      throw new TelegramError(
        'invalid_response',
        method,
        `${method} answered with a result in an unknown shape`,
        { status: response.status }
      );
    return result.data;
  }

  private apiError(
    method: string,
    status: number,
    e: z.infer<typeof EnvelopeSchema>
  ): TelegramError {
    const code = e.error_code ?? status;
    const description =
      e.description === undefined
        ? undefined
        : this.mask(e.description).slice(0, 300);
    const extra = { status: code, description };
    const said = description ? `: ${description}` : '';
    if (code === 409)
      return new TelegramError(
        'conflict',
        method,
        `${method} was refused with a conflict${said}`,
        extra
      );
    if (code === 429)
      return new TelegramError(
        'rate_limited',
        method,
        `${method} was rate limited${said}`,
        { ...extra, retryAfter: e.parameters?.retry_after }
      );
    if (code === 401)
      return new TelegramError(
        'unauthorised',
        method,
        `Telegram refused the bot token${said}`,
        extra
      );
    if (code === 403)
      return new TelegramError(
        'forbidden',
        method,
        `${method} was forbidden${said}`,
        extra
      );
    if (code === 400 && /file is too big/i.test(description ?? ''))
      return new TelegramError('too_big', method, 'the file is too big', extra);
    if (code >= 500)
      return new TelegramError(
        'server',
        method,
        `${method} failed on Telegram's side (${code})${said}`,
        extra
      );
    return new TelegramError(
      'bad_request',
      method,
      `${method} was refused (${code})${said}`,
      extra
    );
  }

  private transportError(
    method: string,
    error: unknown,
    stop: AbortSignal | undefined,
    timeout: AbortSignal
  ): TelegramError {
    if (stop?.aborted === true)
      return new TelegramError('aborted', method, `${method} was stopped`);
    if (timeout.aborted)
      return new TelegramError('timeout', method, `${method} timed out`);
    return new TelegramError(
      'network',
      method,
      `${method}: the request did not complete (${this.mask(reasonOf(error)).slice(0, 200)})`
    );
  }
}

/** Reads a body, refusing it once more than `max` bytes have arrived. */
async function readCapped(
  response: Response,
  max: number,
  method: string
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new TelegramError(
        'too_big',
        method,
        'the response is over the cap'
      );
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function markup(
  method: string,
  keyboard: Keyboard | undefined
): { reply_markup?: unknown } {
  if (keyboard === undefined) return {};
  for (const row of keyboard)
    for (const button of row) {
      if (button.text.trim() === '')
        throw new TelegramError('bad_request', method, 'a button has no text');
      const size = utf8Length(button.data);
      if (size < 1 || size > MAX_CALLBACK_DATA_BYTES)
        throw new TelegramError(
          'bad_request',
          method,
          `a button's callback data is ${size} bytes; Telegram takes 1 to ${MAX_CALLBACK_DATA_BYTES}`
        );
    }
  return {
    reply_markup: {
      inline_keyboard: keyboard.map((row) =>
        row.map((b) => ({ text: b.text, callback_data: b.data }))
      ),
    },
  };
}
