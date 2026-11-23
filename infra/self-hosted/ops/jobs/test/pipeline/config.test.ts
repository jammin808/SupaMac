import { describe, expect, test } from 'bun:test';
import {
  ConfigError,
  loadConfig,
  offText,
  registerSecrets,
  wayOn,
} from '../../src/config';
import { Logger } from '../../src/log';

const KEY = 'smk_0123456789abcdefABCDEF'; // secret-scan: fixture
const BOT = '123456789:AAEexampleexampleexampleexample00'; // secret-scan: fixture
const ANTHROPIC = 'sk-ant-api03-example-key'; // secret-scan: fixture

const BASE = {
  JOBS_SUPAMAC_API_KEY: KEY,
  JOBS_OWNER_EMAIL: 'Sam.Price@example.com',
};

const FULL = {
  ...BASE,
  ANTHROPIC_API_KEY: ANTHROPIC,
  JOBS_MONTHLY_LIMIT_USD: '20',
  JOBS_TELEGRAM_BOT_TOKEN: BOT,
  JOBS_MAIL_HOST: 'imap.example.com',
  JOBS_MAIL_USER: 'jobs@example.com',
  JOBS_MAIL_PASSWORD: 'app-password-example',
  JOBS_MAIL_AUTHSERV_ID: 'mx.example.com',
  JOBS_MAIL_ALLOWED_SENDERS:
    'Sam.Price@example.com, office@acme-productions.example.com',
};

function refused(env: Record<string, string>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('the settings were accepted');
}

describe('loadConfig', () => {
  test('refuses to start with the stack’s internal key or database URL, even empty', () => {
    expect(refused({ ...FULL, INTERNAL_API_SECRET_KEY: 'x' })).toMatchObject({
      kind: 'forbidden',
      setting: 'INTERNAL_API_SECRET_KEY',
    });
    expect(refused({ ...FULL, DATABASE_URL: '' })).toMatchObject({
      kind: 'forbidden',
      setting: 'DATABASE_URL',
    });
  });

  test('needs the SupaMac key and the owner’s address', () => {
    expect(refused({ JOBS_OWNER_EMAIL: 'sam@example.com' })).toMatchObject({
      kind: 'missing',
      setting: 'JOBS_SUPAMAC_API_KEY',
    });
    expect(
      refused({ ...BASE, JOBS_OWNER_EMAIL: 'not an address' })
    ).toMatchObject({
      kind: 'invalid',
      setting: 'JOBS_OWNER_EMAIL',
    });
  });

  test('with every setting, every way in is on and the defaults hold', () => {
    const config = loadConfig(FULL);
    expect(config.off).toEqual([]);
    expect(offText(config)).toBeNull();
    expect(config.ownerEmail).toBe('sam.price@example.com');
    expect(config.timeZone).toBe('Europe/London');
    expect(config.stateDir).toBe('/var/lib/supamac-jobs');
    expect(config.healthPort).toBe(8080);
    expect(config.supamacBaseUrl).toBe('http://gateway:8080/dss');
    expect(config.ai).toMatchObject({
      model: 'claude-opus-5-5',
      monthlyLimitUsd: 20,
    });
    expect(config.mail).toMatchObject({
      port: 993,
      allowedSenders: [
        'sam.price@example.com',
        'office@acme-productions.example.com',
      ],
    });
    expect(config.telegram).toEqual({ botToken: BOT });
  });

  test('a way in whose settings are missing is off, and says which', () => {
    const {
      JOBS_MAIL_AUTHSERV_ID: _a,
      JOBS_TELEGRAM_BOT_TOKEN: _b,
      ...env
    } = FULL;
    const config = loadConfig(env);
    expect(wayOn(config, 'Email')).toBe(false);
    expect(wayOn(config, 'Telegram')).toBe(false);
    expect(wayOn(config, 'Folder')).toBe(true);
    expect(offText(config)).toBe(
      'Email: JOBS_MAIL_AUTHSERV_ID is not set; Telegram: JOBS_TELEGRAM_BOT_TOKEN is not set'
    );
  });

  test('without the AI’s key or a spend limit every way in is off: the model is never called without a limit', () => {
    const { JOBS_MONTHLY_LIMIT_USD: _l, ...env } = FULL;
    const config = loadConfig(env);
    expect(config.ai).toBeUndefined();
    expect(config.aiOff).toBe('JOBS_MONTHLY_LIMIT_USD is not set');
    for (const way of ['Email', 'Telegram', 'Folder'] as const)
      expect(wayOn(config, way)).toBe(false);
    expect(config.telegram).toBeDefined();
  });

  test('a value that does not parse stops the start, naming the setting and not its value', () => {
    for (const [name, value] of [
      ['JOBS_TIME_ZONE', 'Mars/Olympus'],
      ['JOBS_MONTHLY_LIMIT_USD', 'twenty'],
      ['JOBS_MAIL_PORT', '99999'],
      ['JOBS_TELEGRAM_OWNER_ID', '-4'],
      ['JOBS_TELEGRAM_BOT_TOKEN', 'not-a-token'],
      ['JOBS_MAIL_ALLOWED_SENDERS', 'sam@example.com, nobody'],
      ['JOBS_AI_PRICES', '{"claude-opus-5-5": {"input": 4}}'],
      ['JOBS_WEB_APP_URL', 'ftp://example.com'],
      ['JOBS_STATE_DIR', 'relative/path'],
    ] as const) {
      const error = refused({ ...FULL, [name]: value });
      expect(error.kind).toBe('invalid');
      expect(error.setting).toBe(name);
      expect(error.message).not.toContain(value);
    }
  });

  test('reads the optional settings', () => {
    const config = loadConfig({
      ...FULL,
      JOBS_TIME_ZONE: 'Europe/Dublin',
      JOBS_TELEGRAM_OWNER_ID: '424242',
      JOBS_MAIL_PORT: '1993',
      JOBS_AI_MODEL: 'claude-opus-5',
      JOBS_AI_PRICES:
        '{"claude-opus-5": {"input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25}}',
      JOBS_WEB_APP_URL: 'https://supamac.example.com/app',
      JOBS_STATE_DIR: '/data/jobs',
      JOBS_HEALTH_PORT: '9090',
    });
    expect(config.timeZone).toBe('Europe/Dublin');
    expect(config.telegram?.ownerId).toBe(424242);
    expect(config.mail?.port).toBe(1993);
    expect(config.ai?.model).toBe('claude-opus-5');
    expect(Object.keys(config.ai?.prices ?? {})).toEqual(['claude-opus-5']);
    expect(config.webAppUrl).toBe('https://supamac.example.com/app');
    expect(config.healthPort).toBe(9090);
  });

  test('turns the server-side fallbacks off, or names the models they may use', () => {
    expect(loadConfig(FULL).ai).toMatchObject({ fallbacks: true });
    expect(loadConfig(FULL).ai?.fallbackModels).toBeUndefined();
    const off = loadConfig({ ...FULL, JOBS_AI_FALLBACKS: 'OFF' });
    expect(off.ai?.fallbacks).toBe(false);
    const one = loadConfig({
      ...FULL,
      JOBS_AI_FALLBACK_MODELS: 'claude-opus-5, claude-opus-5',
    });
    expect(one.ai?.fallbackModels).toEqual(['claude-opus-5']);
    expect(refused({ ...FULL, JOBS_AI_FALLBACKS: 'maybe' })).toMatchObject({
      kind: 'invalid',
      setting: 'JOBS_AI_FALLBACKS',
    });
    expect(
      refused({ ...FULL, JOBS_AI_FALLBACK_MODELS: 'Not A Model' })
    ).toMatchObject({ kind: 'invalid', setting: 'JOBS_AI_FALLBACK_MODELS' });
  });

  test('registers every secret, so no log line carries one', () => {
    const lines: string[] = [];
    const logger = new Logger({ sink: (line) => lines.push(line) });
    const config = loadConfig(FULL);
    registerSecrets(config, logger);
    logger.info(`values ${KEY} ${BOT} ${ANTHROPIC} app-password-example`);
    expect(lines[0]).not.toContain(KEY);
    expect(lines[0]).not.toContain(BOT);
    expect(lines[0]).not.toContain(ANTHROPIC);
    expect(lines[0]).not.toContain('app-password-example');
  });
});
