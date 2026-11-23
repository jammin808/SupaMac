import { describe, expect, test } from 'bun:test';
import { Logger } from '../../src/log';
import {
  ALLOWED_UPDATES,
  BotApi,
  MAX_DOWNLOAD_BYTES,
  POLL_TIMEOUT_S,
  readUpdate,
  TelegramError,
} from '../../src/telegram/api';
import { FakeBotApi, OWNER, TOKEN } from './fake-bot-api';

function setup(fetch?: FakeBotApi['fetch']) {
  const fake = new FakeBotApi();
  const lines: string[] = [];
  const waits: number[] = [];
  const logger = new Logger({
    sink: (line) => lines.push(line),
    level: 'debug',
  });
  const api = new BotApi({
    token: TOKEN,
    fetch: fetch ?? fake.fetch,
    logger,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { fake, api, lines, waits, logger };
}

async function caught(promise: Promise<unknown>): Promise<TelegramError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(TelegramError);
  return error as TelegramError;
}

describe('the Bot API client', () => {
  test('long-polls for messages and presses only, from the offset it is given', async () => {
    const { fake, api } = setup();
    fake.text(OWNER, 'hello');
    const updates = await api.getUpdates(5_000);
    const call = fake.calls.find((c) => c.method === 'getUpdates');
    expect(call?.body).toEqual({
      offset: 5_000,
      timeout: POLL_TIMEOUT_S,
      allowed_updates: [...ALLOWED_UPDATES],
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.kind).toBe('message');
  });

  test('an update it cannot read keeps its id, so it can still be acknowledged', () => {
    expect(readUpdate({ update_id: 9, message: { nonsense: true } })).toEqual({
      id: 9,
      kind: 'other',
    });
    expect(
      readUpdate({ update_id: 10, channel_post: { message_id: 1 } })
    ).toEqual({ id: 10, kind: 'other' });
    expect(readUpdate({ message: {} })).toBeUndefined();
  });

  test('sends HTML with link previews off', async () => {
    const { fake, api } = setup();
    await api.sendMessage(OWNER, '<b>x</b>', [[{ text: 'Go', data: 'v:x' }]]);
    const body = fake.calls.find((c) => c.method === 'sendMessage')?.body;
    expect(body?.parse_mode).toBe('HTML');
    expect(body?.link_preview_options).toEqual({ is_disabled: true });
    expect(body?.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Go', callback_data: 'v:x' }]],
    });
  });

  test('refuses callback data over 64 bytes before sending anything', async () => {
    const { fake, api } = setup();
    const error = await caught(
      api.sendMessage(OWNER, 'x', [[{ text: 'Go', data: 'x'.repeat(65) }]])
    );
    expect(error.kind).toBe('bad_request');
    expect(fake.count('sendMessage')).toBe(0);
  });

  test('a 429 waits for its retry_after and sends again', async () => {
    const { fake, api, waits } = setup();
    fake.fail('sendMessage', {
      status: 429,
      body: {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 7',
        parameters: { retry_after: 7 },
      },
    });
    await api.sendMessage(OWNER, 'hello');
    expect(waits).toEqual([7_000]);
    expect(fake.count('sendMessage')).toBe(2);
    expect(fake.sent).toHaveLength(1);
  });

  test('a 429 asking for a long wait is thrown with the wait, not waited out', async () => {
    const { fake, api, waits } = setup();
    fake.fail('sendMessage', {
      status: 429,
      body: {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 3600',
        parameters: { retry_after: 3_600 },
      },
    });
    const error = await caught(api.sendMessage(OWNER, 'hello'));
    expect(error.kind).toBe('rate_limited');
    expect(error.retryAfter).toBe(3_600);
    expect(waits).toEqual([]);
  });

  test('a 409 is a conflict and is not sent again', async () => {
    const { fake, api } = setup();
    fake.fail('getUpdates', {
      status: 409,
      body: {
        ok: false,
        error_code: 409,
        description:
          'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
      },
    });
    const error = await caught(api.getUpdates(undefined));
    expect(error.kind).toBe('conflict');
    expect(fake.count('getUpdates')).toBe(1);
  });

  test('"message is not modified" on an edit is success', async () => {
    const { fake, api } = setup();
    fake.fail('editMessageText', {
      status: 400,
      body: {
        ok: false,
        error_code: 400,
        description:
          'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
      },
    });
    await api.editMessageText(OWNER, 1, 'same');
  });

  test('a reply in an unknown shape is invalid_response', async () => {
    const { api } = setup(
      async () => new Response('{"ok":true,"result":{"x":1}}')
    );
    expect((await caught(api.getMe())).kind).toBe('invalid_response');
    const html = setup(
      async () => new Response('<html>bad gateway</html>', { status: 502 })
    );
    expect((await caught(html.api.getMe())).kind).toBe('server');
  });
});

describe('downloads', () => {
  test('a file Telegram states is over 20 MB is refused before it is fetched', async () => {
    const { fake, api } = setup();
    const error = await caught(
      api.download({
        file_id: 'f',
        file_unique_id: 'u',
        file_size: MAX_DOWNLOAD_BYTES + 1,
        file_path: 'documents/file_1.pdf',
      })
    );
    expect(error.kind).toBe('too_big');
    expect(fake.downloads).toEqual([]);
  });

  test('a file that states no size is counted while read and cut off at the cap', async () => {
    const { fake, api } = setup();
    fake.files.set('f', {
      path: 'documents/file_2.pdf',
      bytes: new Uint8Array(300_000),
    });
    const error = await caught(
      api.download(
        {
          file_id: 'f',
          file_unique_id: 'u',
          file_path: 'documents/file_2.pdf',
        },
        200_000
      )
    );
    expect(error.kind).toBe('too_big');
    const bytes = await api.download(
      { file_id: 'f', file_unique_id: 'u', file_path: 'documents/file_2.pdf' },
      300_000
    );
    expect(bytes.length).toBe(300_000);
  });

  test('a path that could leave Telegram’s file tree is refused', async () => {
    const { fake, api } = setup();
    for (const path of ['../etc/passwd', '/abs', 'a/../b', 'a?x=1']) {
      const error = await caught(
        api.download({ file_id: 'f', file_unique_id: 'u', file_path: path })
      );
      expect(error.kind).toBe('invalid_response');
    }
    expect(fake.downloads).toEqual([]);
  });
});

describe('the token', () => {
  const failing = async (url: string): Promise<Response> => {
    // A transport error that quotes the URL, as some runtimes' do.
    throw new Error(
      `Unable to connect. Is the computer able to access the url? ${url}`
    );
  };

  test('is in no error message and no log line when a request fails', async () => {
    const { api, lines, logger } = setup(failing);
    const errors: TelegramError[] = [];
    errors.push(await caught(api.getUpdates(undefined)));
    errors.push(
      await caught(
        api.download({
          file_id: 'f',
          file_unique_id: 'u',
          file_path: 'documents/file_3.pdf',
        })
      )
    );
    for (const e of errors) {
      expect(e.kind).toBe('network');
      expect(e.message).not.toContain(TOKEN);
      expect(e.message).not.toContain(TOKEN.split(':')[1] as string);
      expect(JSON.stringify(e)).not.toContain(TOKEN);
      logger.warn('request failed', { error: e });
    }
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines)
      expect(line).not.toContain(TOKEN.split(':')[1] as string);
  });

  test('is masked in a description Telegram sends back', async () => {
    const { api } = setup(async () =>
      Response.json(
        {
          ok: false,
          error_code: 400,
          description: `Bad Request: bot${TOKEN} is odd`,
        },
        { status: 400 }
      )
    );
    const error = await caught(api.getMe());
    expect(error.message).not.toContain(TOKEN.split(':')[1] as string);
    expect(error.description).not.toContain(TOKEN.split(':')[1] as string);
  });

  test('is in no log line of a rate-limited call', async () => {
    const { fake, api, lines } = setup();
    fake.fail('getMe', {
      status: 429,
      body: { ok: false, error_code: 429, parameters: { retry_after: 1 } },
    });
    await api.getMe();
    expect(lines.some((l) => l.includes('telegram asked to wait'))).toBe(true);
    for (const line of lines)
      expect(line).not.toContain(TOKEN.split(':')[1] as string);
  });
});
