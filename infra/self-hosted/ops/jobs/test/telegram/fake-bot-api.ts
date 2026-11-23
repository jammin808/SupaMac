// An in-process fake of the Telegram Bot API for the bot's tests: it answers
// the methods the bot calls, keeps the chat as Telegram would (messages sent
// and edited, presses answered, files to download), confirms updates below
// the offset as getUpdates does, and fails a method on demand. No network.

import type { TelegramFetch } from '../../src/telegram/api';

export const TOKEN = '123456789:AAEfakeTOKENfakeTOKENfakeTOKEN00'; // secret-scan: fixture
export const OWNER = 424_242;
export const STRANGER = 777_777;
export const BOT_ID = 123_456_789;

export interface SentRecord {
  readonly messageId: number;
  readonly chatId: number;
  text: string;
  keyboard: { text: string; callback_data: string }[][];
  edits: number;
}

export interface CallRecord {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

export function user(id: number, first = id === OWNER ? 'Sam' : 'Someone') {
  return { id, is_bot: false, first_name: first };
}

export function privateChat(id: number) {
  return { id, type: 'private', first_name: id === OWNER ? 'Sam' : 'Someone' };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export class FakeBotApi {
  readonly calls: CallRecord[] = [];
  readonly sent: SentRecord[] = [];
  readonly answered: string[] = [];
  readonly documents: {
    chatId: number;
    name: string;
    bytes: Uint8Array;
    caption?: string;
  }[] = [];
  readonly downloads: string[] = [];
  readonly files = new Map<
    string,
    { path: string; bytes: Uint8Array; size?: number | undefined }
  >();
  webhookUrl = '';
  me = {
    id: BOT_ID,
    is_bot: true,
    first_name: 'SupaMac',
    username: 'supamac_jobs_bot',
    can_join_groups: false,
  };
  private updates: Record<string, unknown>[] = [];
  private nextUpdateId = 5_000;
  private nextMessageId = 1;
  private readonly failures = new Map<
    string,
    { status: number; body: unknown } | Error
  >();
  private failuresQueue = new Map<
    string,
    ({ status: number; body: unknown } | Error)[]
  >();

  /** Fails the next call of `method` with this answer (or throws this error). */
  fail(
    method: string,
    failure: { status: number; body: unknown } | Error
  ): void {
    this.failuresQueue.set(method, [
      ...(this.failuresQueue.get(method) ?? []),
      failure,
    ]);
  }

  /** Fails every call of `method` from now on. */
  failAlways(
    method: string,
    failure: { status: number; body: unknown } | Error
  ): void {
    this.failures.set(method, failure);
  }

  /** Queues an update; returns its id. */
  push(update: Record<string, unknown>): number {
    const id = this.nextUpdateId++;
    this.updates.push({ update_id: id, ...update });
    return id;
  }

  /** Queues an update with the id given: Telegram sending one again. */
  pushAgain(update: Record<string, unknown> & { update_id: number }): void {
    this.updates.push(update);
    this.updates.sort(
      (a, b) => (a.update_id as number) - (b.update_id as number)
    );
  }

  /** Every update queued so far, as sent. */
  queued(): Record<string, unknown>[] {
    return [...this.updates];
  }

  /** A message the owner (or anyone) sends in their private chat with the bot. */
  message(from: number, fields: Record<string, unknown>): number {
    return this.push({
      message: {
        message_id: this.nextMessageId++,
        from: user(from),
        chat: privateChat(from),
        date: 1_772_701_200,
        ...fields,
      },
    });
  }

  text(from: number, text: string): number {
    return this.message(from, { text });
  }

  /** A press of a button on a message the bot sent. */
  press(from: number, sent: SentRecord, data: string): number {
    return this.push({
      callback_query: {
        id: `q${this.nextUpdateId}`,
        from: user(from),
        chat_instance: 'ci',
        message: {
          message_id: sent.messageId,
          chat: privateChat(sent.chatId),
          date: 1_772_701_200,
        },
        data,
      },
    });
  }

  /** The button on a sent message whose text matches. */
  button(sent: SentRecord, text: string | RegExp): string {
    for (const row of sent.keyboard)
      for (const b of row)
        if (typeof text === 'string' ? b.text === text : text.test(b.text))
          return b.callback_data;
    throw new Error(`no button ${String(text)} on message ${sent.messageId}`);
  }

  pending(): number {
    return this.updates.length;
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  /** Messages sent to a chat, in order. */
  to(chatId: number): SentRecord[] {
    return this.sent.filter((m) => m.chatId === chatId);
  }

  last(chatId: number = OWNER): SentRecord {
    const m = this.to(chatId).at(-1);
    if (m === undefined) throw new Error(`nothing was sent to ${chatId}`);
    return m;
  }

  readonly fetch: TelegramFetch = async (url, init) => {
    const file = /^https:\/\/api\.telegram\.org\/file\/bot([^/]+)\/(.+)$/.exec(
      url
    );
    if (file) {
      if (file[1] !== TOKEN) return new Response('not found', { status: 404 });
      const path = file[2] as string;
      this.downloads.push(path);
      const found = [...this.files.values()].find((f) => f.path === path);
      if (found === undefined)
        return new Response('not found', { status: 404 });
      // A stream with no stated length, so the reader must count.
      const bytes = found.bytes;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let at = 0; at < bytes.length; at += 64 * 1024)
              controller.enqueue(bytes.slice(at, at + 64 * 1024));
            controller.close();
          },
        }),
        { status: 200 }
      );
    }
    const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/([A-Za-z]+)$/.exec(
      url
    );
    if (!m) return new Response('not found', { status: 404 });
    if (m[1] !== TOKEN)
      return json(
        { ok: false, error_code: 401, description: 'Unauthorized' },
        401
      );
    const method = m[2] as string;
    let body: Record<string, unknown> = {};
    if (init.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) body[k] = v;
    } else if (typeof init.body === 'string') {
      body = JSON.parse(init.body) as Record<string, unknown>;
    }
    this.calls.push({ method, body });
    const queued = this.failuresQueue.get(method);
    const failure = queued?.shift() ?? this.failures.get(method);
    if (failure instanceof Error) throw failure;
    if (failure !== undefined) return json(failure.body, failure.status);
    return this.answer(method, body, init.signal ?? undefined);
  };

  private async answer(
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<Response> {
    switch (method) {
      case 'getMe':
        return json({ ok: true, result: this.me });
      case 'getWebhookInfo':
        return json({
          ok: true,
          result: {
            url: this.webhookUrl,
            has_custom_certificate: false,
            pending_update_count: 0,
          },
        });
      case 'getUpdates': {
        const offset = typeof body.offset === 'number' ? body.offset : 0;
        this.updates = this.updates.filter(
          (u) => (u.update_id as number) >= offset
        );
        if (this.updates.length === 0) {
          // A short hold, as a long poll would, so a loop yields.
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 10);
            signal?.addEventListener('abort', () => {
              clearTimeout(t);
              resolve();
            });
          });
          if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        }
        return json({ ok: true, result: this.updates.slice(0, 100) });
      }
      case 'sendMessage': {
        const record: SentRecord = {
          messageId: this.nextMessageId++,
          chatId: body.chat_id as number,
          text: body.text as string,
          keyboard: keyboardOf(body),
          edits: 0,
        };
        this.sent.push(record);
        return json({
          ok: true,
          result: {
            message_id: record.messageId,
            chat: privateChat(record.chatId),
            date: 1_772_701_200,
            text: record.text,
          },
        });
      }
      case 'editMessageText': {
        const record = this.sent.find(
          (s) => s.messageId === body.message_id && s.chatId === body.chat_id
        );
        if (record === undefined)
          return json(
            {
              ok: false,
              error_code: 400,
              description: 'Bad Request: message to edit not found',
            },
            400
          );
        record.text = body.text as string;
        record.keyboard = keyboardOf(body);
        record.edits++;
        return json({ ok: true, result: true });
      }
      case 'answerCallbackQuery':
        this.answered.push(body.callback_query_id as string);
        return json({ ok: true, result: true });
      case 'getFile': {
        const f = this.files.get(body.file_id as string);
        if (f === undefined)
          return json(
            {
              ok: false,
              error_code: 400,
              description: 'Bad Request: invalid file_id',
            },
            400
          );
        return json({
          ok: true,
          result: {
            file_id: body.file_id,
            file_unique_id: `u-${String(body.file_id)}`,
            ...(f.size !== undefined ? { file_size: f.size } : {}),
            file_path: f.path,
          },
        });
      }
      case 'sendDocument': {
        const doc = body.document as Blob & { name?: string };
        this.documents.push({
          chatId: Number(body.chat_id),
          name: doc.name ?? '',
          bytes: new Uint8Array(await doc.arrayBuffer()),
          ...(typeof body.caption === 'string'
            ? { caption: body.caption }
            : {}),
        });
        return json({
          ok: true,
          result: {
            message_id: this.nextMessageId++,
            chat: privateChat(Number(body.chat_id)),
            date: 1_772_701_200,
          },
        });
      }
      default:
        return json(
          {
            ok: false,
            error_code: 404,
            description: 'Not Found: method not found',
          },
          404
        );
    }
  }
}

function keyboardOf(
  body: Record<string, unknown>
): { text: string; callback_data: string }[][] {
  const markup = body.reply_markup as
    | { inline_keyboard?: { text: string; callback_data: string }[][] }
    | undefined;
  return markup?.inline_keyboard ?? [];
}

/** Checks that a part of a message is HTML Telegram parses: known tags, each closed, nothing stray. */
export function wellFormed(html: string): boolean {
  const allowed = new Set([
    'b',
    'i',
    'u',
    's',
    'a',
    'code',
    'pre',
    'blockquote',
  ]);
  const stack: string[] = [];
  const re = /<\/?([a-zA-Z]+)[^>]*>|[<>]|&(?!amp;|lt;|gt;|quot;|#39;)/g;
  for (const m of html.matchAll(re)) {
    const t = m[0];
    if (t === '<' || t === '>' || t === '&') return false;
    const name = (m[1] ?? '').toLowerCase();
    if (!allowed.has(name)) return false;
    if (t.startsWith('</')) {
      if (stack.pop() !== name) return false;
    } else stack.push(name);
  }
  return stack.length === 0;
}
