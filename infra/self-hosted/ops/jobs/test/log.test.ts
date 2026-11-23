import { describe, expect, test } from 'bun:test';
import {
  LogError,
  type LogLevel,
  Logger,
  maskSecrets,
  REDACTED,
  SecretRegistry,
} from '../src/log';

// Fixture secrets: shaped like the real ones, valid for nothing, and put
// together at run time so no key-shaped literal sits in the source.
const BOT_TAIL = `AAH${'x'.repeat(32)}`;
const BOT_TOKEN = ['1234567890', BOT_TAIL].join(':');
const ANTHROPIC_KEY = ['sk', 'ant', 'api03', 'fixture', 'only'].join('-');
const SUPAMAC_KEY = ['smk', 'fixture', 'value'].join('_');

function capture(level: LogLevel = 'debug'): {
  logger: Logger;
  lines: { line: string; level: LogLevel }[];
} {
  const lines: { line: string; level: LogLevel }[] = [];
  const logger = new Logger({
    level,
    clock: () => new Date('2027-03-13T07:30:00.000Z'),
    sink: (line, lvl) => lines.push({ line, level: lvl }),
  });
  return { logger, lines };
}

function parsed(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe('Logger', () => {
  test('writes one JSON object per line: time, level, msg, then the fields', () => {
    const { logger, lines } = capture();
    logger.info('source processed', {
      sourceId: 'src-1',
      details: 12,
      inputTokens: 30120,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('info');
    expect(Object.keys(parsed(lines[0]?.line ?? '{}'))).toEqual([
      'time',
      'level',
      'msg',
      'sourceId',
      'details',
      'inputTokens',
    ]);
    expect(parsed(lines[0]?.line ?? '{}')).toEqual({
      time: '2027-03-13T07:30:00.000Z',
      level: 'info',
      msg: 'source processed',
      sourceId: 'src-1',
      details: 12,
      inputTokens: 30120,
    });
  });

  test('masks Telegram bot tokens wherever they appear', () => {
    const { logger, lines } = capture();
    logger.warn(
      `GET https://api.telegram.org/bot${BOT_TOKEN}/getUpdates failed`,
      {
        url: `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        nested: { list: [`token ${BOT_TOKEN}`] },
      }
    );
    const line = lines[0]?.line ?? '';
    expect(line).not.toContain(BOT_TOKEN);
    expect(line).not.toContain(BOT_TAIL);
    expect(parsed(line).msg).toBe(
      `GET https://api.telegram.org/bot${REDACTED}/getUpdates failed`
    );
    expect(parsed(line).nested).toEqual({ list: [`token ${REDACTED}`] });
  });

  test('masks Anthropic keys', () => {
    const { logger, lines } = capture();
    logger.error('request failed', { header: `x-api-key: ${ANTHROPIC_KEY}` });
    expect(lines[0]?.line).not.toContain('api03-fixture');
    expect(parsed(lines[0]?.line ?? '{}').header).toBe(
      `x-api-key: sk-ant-${REDACTED}`
    );
  });

  test('masks registered secrets, also URL encoded, in every child', () => {
    const { logger, lines } = capture();
    logger.addSecret(SUPAMAC_KEY);
    logger.addSecret('p@ss word/123');
    const child = logger.child({ loop: 'mail' });
    child.info(
      `key ${SUPAMAC_KEY} and ${encodeURIComponent('p@ss word/123')} and p@ss word/123`
    );
    const line = lines[0]?.line ?? '';
    expect(line).not.toContain(SUPAMAC_KEY);
    expect(line).not.toContain('p@ss');
    expect(line).not.toContain('p%40ss');
    expect(parsed(line).loop).toBe('mail');
  });

  test('a secret shorter than six characters is refused', () => {
    const { logger } = capture();
    expect(() => logger.addSecret('abc')).toThrow(LogError);
    try {
      new SecretRegistry().add('12345');
    } catch (error) {
      expect(error instanceof LogError && error.kind).toBe('secret_too_short');
    }
  });

  test('fields named for secrets are redacted whatever they hold; counts are kept', () => {
    const { logger, lines } = capture();
    logger.info('config', {
      password: ['hunter', 'fixture'].join('-'),
      apiKey: 'anything',
      'x-macro-user-api-key': 'anything',
      headers: {
        Authorization: 'Bearer abc',
        'content-type': 'application/json',
      },
      mailPassword: 'also hidden',
      outputTokens: 5000,
    });
    const record = parsed(lines[0]?.line ?? '{}');
    expect(record.password).toBe(REDACTED);
    expect(record.apiKey).toBe(REDACTED);
    expect(record['x-macro-user-api-key']).toBe(REDACTED);
    expect(record.mailPassword).toBe(REDACTED);
    expect(record.headers).toEqual({
      Authorization: REDACTED,
      'content-type': 'application/json',
    });
    expect(record.outputTokens).toBe(5000);
  });

  test('errors keep their name, kind, message, stack and cause, masked', () => {
    class ApiError extends Error {
      readonly kind = 'unauthorized';
    }
    const { logger, lines } = capture();
    const error = new ApiError(`401 for bot${BOT_TOKEN}`, {
      cause: new Error(`key ${ANTHROPIC_KEY}`),
    });
    logger.error('telegram poll failed', { error });
    const line = lines[0]?.line ?? '';
    expect(line).not.toContain(BOT_TAIL);
    expect(line).not.toContain('api03-fixture');
    const logged = parsed(line).error as Record<string, unknown>;
    expect(logged.name).toBe('Error');
    expect(logged.kind).toBe('unauthorized');
    expect(logged.message).toBe(`401 for bot${REDACTED}`);
    expect(typeof logged.stack).toBe('string');
    expect((logged.cause as Record<string, unknown>).message).toBe(
      `key sk-ant-${REDACTED}`
    );
  });

  test('drops lines below its level', () => {
    const { logger, lines } = capture('warn');
    logger.debug('noise');
    logger.info('noise');
    logger.warn('kept');
    logger.error('kept');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  test('keeps fields from overwriting time, level or msg', () => {
    const { logger, lines } = capture();
    logger.info('hello', { level: 'fake', msg: 'fake', time: 'fake' });
    expect(parsed(lines[0]?.line ?? '{}')).toMatchObject({
      level: 'info',
      msg: 'hello',
      field_level: 'fake',
      field_msg: 'fake',
      field_time: 'fake',
    });
  });

  test('writes circular values, big integers and dates without throwing', () => {
    const { logger, lines } = capture();
    const loop: Record<string, unknown> = { name: 'loop' };
    loop.self = loop;
    logger.info('odd values', {
      loop,
      big: 10n ** 20n,
      at: new Date('2027-03-13T00:00:00Z'),
    });
    expect(parsed(lines[0]?.line ?? '{}')).toMatchObject({
      loop: { name: 'loop', self: '[Circular]' },
      big: '100000000000000000000',
      at: '2027-03-13T00:00:00.000Z',
    });
  });
});

describe('Logger on odd input', () => {
  test('an invalid Date, in a field or from the clock, is written, not thrown', () => {
    const lines: string[] = [];
    const logger = new Logger({
      clock: () => new Date(Number.NaN),
      sink: (line) => lines.push(line),
    });
    expect(() =>
      logger.error('failed', { at: new Date(Number.NaN) })
    ).not.toThrow();
    expect(parsed(lines[0] ?? '{}')).toMatchObject({
      time: 'Invalid Date',
      at: 'Invalid Date',
    });
  });

  test('a bot token with its colon URL encoded is masked unregistered', () => {
    const encoded = BOT_TOKEN.replace(':', '%3A');
    const line = maskSecrets(
      `https://api.telegram.org/bot${encoded}/getUpdates`
    );
    expect(line).toBe(`https://api.telegram.org/bot${REDACTED}/getUpdates`);
    expect(line).not.toContain(BOT_TAIL);
  });
});

describe('maskSecrets', () => {
  test('masks the known shapes and the values given', () => {
    expect(
      maskSecrets(`bot${BOT_TOKEN} ${ANTHROPIC_KEY} ${SUPAMAC_KEY}`, [
        SUPAMAC_KEY,
      ])
    ).toBe(`bot${REDACTED} sk-ant-${REDACTED} ${REDACTED}`);
    expect(maskSecrets(`token=${BOT_TOKEN}`)).toBe(`token=${REDACTED}`);
    expect(maskSecrets('Crew call 07:30, PO 4500123')).toBe(
      'Crew call 07:30, PO 4500123'
    );
  });
});

test('masks a registered secret in lower-case percent-encoding too', () => {
  const lines: string[] = [];
  const logger = new Logger({ sink: (line) => lines.push(line) });
  logger.addSecret('p@ss/word+1');
  logger.info('login', {
    url: 'imap://user:p%40ss%2fword%2b1@mail.example.com',
  });
  expect(lines.join('\n')).not.toContain('p%40ss%2fword%2b1');
});
