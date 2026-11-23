// The service's settings (docs/supamac/jobs.md, Settings and Security), read
// once at start from the environment the jobs container is given
// (`/etc/supamac/jobs.env` by compose, plus compose's own non-secret values).
//
// Invariants:
// - The service refuses to start when the stack's internal key or its
//   database URL is in its environment at all, even empty, under any of the
//   names the stack's bootstrap writes them as (`FORBIDDEN_SETTINGS`): it
//   must reach SupaMac only as its own account, through the gateway.
// - `JOBS_SUPAMAC_API_KEY` and `JOBS_OWNER_EMAIL` are required. Every value
//   that is given is validated; one that does not parse stops the start
//   with a `ConfigError` naming the setting, never its value.
// - A way in whose settings are missing is off, and `off` says which and
//   why; the AI's settings missing (`ANTHROPIC_API_KEY`,
//   `JOBS_MONTHLY_LIMIT_USD`) turns every way in off, since no source could
//   be read: the model is never called without a spend limit.
// - Every secret is registered with the logger before anything is logged.
//
// Settings beyond the design's table, each non-secret:
// - `JOBS_STATE_DIR` (default /var/lib/supamac-jobs), `JOBS_HEALTH_PORT`
//   (default 8080), `JOBS_WEB_APP_URL` (links into SupaMac; none without it),
//   `JOBS_SUPAMAC_URL` (the gateway's storage base, default
//   http://jobs-gateway:8081/dss), `JOBS_AI_PRICES` (JSON: model id to
//   `{ input, output, cacheRead, cacheWrite, cacheWrite1h? }` in USD per
//   million tokens; the defaults of ai/spend.ts otherwise),
//   `JOBS_AI_FALLBACKS` (`on` or `off`: the server-side fallbacks on refusal;
//   on unless set) and `JOBS_AI_FALLBACK_MODELS` (the models a refusal may
//   fall back to, comma separated, which the spend check's worst case counts;
//   ai/anthropic.ts's list unless set). Fewer fallbacks hold back less of the
//   monthly limit per request.
// - `JOBS_MAIL_PORT` defaults to 993 (IMAP over TLS) when the other mailbox
//   settings are given.
// - `JOBS_EXTRACT_URL`: the extraction container (text/extract-server.ts),
//   such as http://jobs-extract:8090, which compose sets. Without it the
//   service parses files in a child of its own (development only: that child
//   shares the service's user, network and state volume).
// - The mailbox's host is the deploy tool's SUPAMAC_JOBS_MAIL_HOST, which
//   compose hands over as JOBS_MAIL_HOST: a way-off reason names the deploy
//   variable, the one the owner can set.

import { z } from 'zod';
import { DEFAULT_MODEL } from './ai/anthropic';
import { DEFAULT_PRICES, type PriceTable } from './ai/spend';
import type { Logger } from './log';
import { DEFAULT_STATE_DIR } from './pipeline/state';
import { DEFAULT_SUPAMAC_BASE_URL, normaliseBaseUrl } from './supamac/client';
import { webAppBase } from './supamac/documents';

export type ConfigErrorKind = 'forbidden' | 'missing' | 'invalid';

export class ConfigError extends Error {
  readonly kind: ConfigErrorKind;
  readonly setting: string;
  constructor(kind: ConfigErrorKind, setting: string, message: string) {
    super(message);
    this.name = 'ConfigError';
    this.kind = kind;
    this.setting = setting;
  }
}

export type Env = Readonly<Record<string, string | undefined>>;

export interface AiSettings {
  readonly apiKey: string;
  readonly model: string;
  readonly monthlyLimitUsd: number;
  readonly prices: PriceTable;
  /** Server-side fallbacks on refusal. */
  readonly fallbacks: boolean;
  /** The fallback models the spend check counts; the AI client's own list when undefined. */
  readonly fallbackModels?: readonly string[] | undefined;
}

export interface MailSettings {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly authservId: string;
  /** Lower case. */
  readonly allowedSenders: readonly string[];
}

export interface TelegramSettings {
  readonly botToken: string;
  readonly ownerId?: number | undefined;
}

export type Way = 'Email' | 'Telegram' | 'Folder';

export interface Config {
  readonly supamacApiKey: string;
  readonly supamacBaseUrl: string;
  readonly ownerEmail: string;
  readonly timeZone: string;
  readonly stateDir: string;
  readonly healthPort: number;
  readonly webAppUrl?: string | undefined;
  /** The extraction container; the service parses in its own child without it. */
  readonly extractUrl?: string | undefined;
  readonly ai?: AiSettings | undefined;
  /** Why the AI is off, when it is. */
  readonly aiOff?: string | undefined;
  readonly mail?: MailSettings | undefined;
  readonly telegram?: TelegramSettings | undefined;
  /** The ways in that are off, each with why; the Status row lists them. */
  readonly off: readonly { readonly way: Way; readonly why: string }[];
}

/**
 * Settings that stop the start when present: every name the stack's
 * bootstrap gives its shared internal service key and its database URL.
 */
export const FORBIDDEN_SETTINGS = [
  'INTERNAL_API_SECRET_KEY',
  'INTERNAL_API_KEY',
  'INTERNAL_AUTH_KEY',
  'AUTHENTICATION_SERVICE_SECRET_KEY',
  'SYNC_SERVICE_AUTH_KEY',
  'SERVICE_INTERNAL_AUTH_KEY',
  'DOCUMENT_STORAGE_SERVICE_AUTH_KEY',
  'DSS_INTERNAL_AUTH_KEY',
  'DATABASE_URL',
  'DATABASE_URL_READONLY',
  'MACRO_DB_URL',
] as const;

const MODEL_RE = /^[a-z0-9][a-z0-9._-]{1,99}$/;

const ADDRESS_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function value(env: Env, name: string): string | undefined {
  const v = env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

function required(env: Env, name: string): string {
  const v = value(env, name);
  if (v === undefined)
    throw new ConfigError('missing', name, `${name} is not set`);
  return v;
}

function invalid(name: string, what: string): ConfigError {
  return new ConfigError('invalid', name, `${name} must be ${what}`);
}

function wholeNumber(
  env: Env,
  name: string,
  min: number,
  max: number
): number | undefined {
  const v = value(env, name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v))
    throw invalid(name, `a whole number from ${min} to ${max}`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw invalid(name, `a whole number from ${min} to ${max}`);
  return n;
}

/** Whether `zone` is an IANA time zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const PriceSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  cacheWrite1h: z.number().nonnegative().optional(),
});
const PricesSchema = z.record(z.string().min(1), PriceSchema);

function prices(env: Env): PriceTable {
  const v = value(env, 'JOBS_AI_PRICES');
  if (v === undefined) return DEFAULT_PRICES;
  let raw: unknown;
  try {
    raw = JSON.parse(v);
  } catch {
    throw invalid('JOBS_AI_PRICES', 'JSON');
  }
  const parsed = PricesSchema.safeParse(raw);
  if (!parsed.success || Object.keys(parsed.data).length === 0)
    throw invalid(
      'JOBS_AI_PRICES',
      'an object of model ids to prices in USD per million tokens'
    );
  return parsed.data;
}

/** Reads and validates the settings (see the header). */
export function loadConfig(env: Env): Config {
  for (const name of FORBIDDEN_SETTINGS) {
    if (env[name] !== undefined) {
      throw new ConfigError(
        'forbidden',
        name,
        `${name} is in the service's environment; the jobs service reaches SupaMac only as its own account and refuses to start with it`
      );
    }
  }
  const supamacApiKey = required(env, 'JOBS_SUPAMAC_API_KEY');
  if (supamacApiKey.length < 16 || !/^[\x21-\x7e]+$/.test(supamacApiKey))
    throw invalid(
      'JOBS_SUPAMAC_API_KEY',
      '16 or more printable characters without spaces'
    );
  const ownerEmail = required(env, 'JOBS_OWNER_EMAIL').toLowerCase();
  if (!ADDRESS_RE.test(ownerEmail))
    throw invalid('JOBS_OWNER_EMAIL', 'an email address');

  let supamacBaseUrl = DEFAULT_SUPAMAC_BASE_URL;
  const base = value(env, 'JOBS_SUPAMAC_URL');
  if (base !== undefined) {
    try {
      supamacBaseUrl = normaliseBaseUrl(base);
    } catch {
      throw invalid(
        'JOBS_SUPAMAC_URL',
        'an http or https URL with no credentials, query or fragment'
      );
    }
  }
  const webAppUrl = value(env, 'JOBS_WEB_APP_URL');
  if (webAppUrl !== undefined) {
    try {
      webAppBase(webAppUrl);
    } catch {
      throw invalid('JOBS_WEB_APP_URL', 'an http or https URL');
    }
  }
  const extractUrl = value(env, 'JOBS_EXTRACT_URL');
  if (extractUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(extractUrl);
    } catch {
      throw invalid('JOBS_EXTRACT_URL', 'an http URL');
    }
    if (
      url.protocol !== 'http:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    )
      throw invalid('JOBS_EXTRACT_URL', 'an http URL');
  }
  const timeZone = value(env, 'JOBS_TIME_ZONE') ?? 'Europe/London';
  if (!isTimeZone(timeZone))
    throw invalid('JOBS_TIME_ZONE', 'an IANA time zone such as Europe/London');
  const stateDir = value(env, 'JOBS_STATE_DIR') ?? DEFAULT_STATE_DIR;
  if (!stateDir.startsWith('/'))
    throw invalid('JOBS_STATE_DIR', 'an absolute path');
  const healthPort = wholeNumber(env, 'JOBS_HEALTH_PORT', 1, 65535) ?? 8080;

  const off: { way: Way; why: string }[] = [];

  // The AI.
  const anthropicKey = value(env, 'ANTHROPIC_API_KEY');
  const limitText = value(env, 'JOBS_MONTHLY_LIMIT_USD');
  let monthlyLimitUsd: number | undefined;
  if (limitText !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(limitText))
      throw invalid(
        'JOBS_MONTHLY_LIMIT_USD',
        'a number of US dollars, such as 20 or 12.50'
      );
    monthlyLimitUsd = Number(limitText);
  }
  const model = value(env, 'JOBS_AI_MODEL') ?? DEFAULT_MODEL;
  if (!MODEL_RE.test(model)) throw invalid('JOBS_AI_MODEL', 'a model id');
  const fallbacksText = value(env, 'JOBS_AI_FALLBACKS')?.toLowerCase();
  if (
    fallbacksText !== undefined &&
    fallbacksText !== 'on' &&
    fallbacksText !== 'off'
  )
    throw invalid('JOBS_AI_FALLBACKS', 'on or off');
  const fallbacks = fallbacksText !== 'off';
  const fallbackModelsText = value(env, 'JOBS_AI_FALLBACK_MODELS');
  let fallbackModels: string[] | undefined;
  if (fallbackModelsText !== undefined) {
    fallbackModels = [
      ...new Set(
        fallbackModelsText
          .split(/[\s,]+/)
          .map((m) => m.trim())
          .filter((m) => m !== '')
      ),
    ];
    if (fallbackModels.some((m) => !MODEL_RE.test(m)))
      throw invalid('JOBS_AI_FALLBACK_MODELS', 'model ids separated by commas');
  }
  const priceTable = prices(env);
  if (anthropicKey !== undefined && anthropicKey.length < 6)
    throw invalid('ANTHROPIC_API_KEY', 'an API key');
  let ai: AiSettings | undefined;
  let aiOff: string | undefined;
  if (anthropicKey === undefined) aiOff = 'ANTHROPIC_API_KEY is not set';
  else if (monthlyLimitUsd === undefined)
    aiOff = 'JOBS_MONTHLY_LIMIT_USD is not set';
  else
    ai = {
      apiKey: anthropicKey,
      model,
      monthlyLimitUsd,
      prices: priceTable,
      fallbacks,
      ...(fallbackModels !== undefined ? { fallbackModels } : {}),
    };

  // The mailbox.
  const mailNames = [
    'JOBS_MAIL_HOST',
    'JOBS_MAIL_USER',
    'JOBS_MAIL_PASSWORD',
    'JOBS_MAIL_AUTHSERV_ID',
    'JOBS_MAIL_ALLOWED_SENDERS',
  ];
  const mailMissing = mailNames.filter((n) => value(env, n) === undefined);
  const mailPort = wholeNumber(env, 'JOBS_MAIL_PORT', 1, 65535) ?? 993;
  let mail: MailSettings | undefined;
  if (mailMissing.length > 0) {
    // The host is the deploy tool's, under the name the owner can set there.
    const inFile = mailMissing.filter((n) => n !== 'JOBS_MAIL_HOST');
    const why = [
      ...(mailMissing.includes('JOBS_MAIL_HOST')
        ? ['SUPAMAC_JOBS_MAIL_HOST is not set in the deploy tool']
        : []),
      ...(inFile.length > 0
        ? [
            `${inFile.join(', ')} ${inFile.length === 1 ? 'is' : 'are'} not set in jobs.env`,
          ]
        : []),
    ].join('; ');
    off.push({ way: 'Email', why });
  } else {
    const host = required(env, 'JOBS_MAIL_HOST');
    if (!/^[A-Za-z0-9.-]+$/.test(host))
      throw invalid('JOBS_MAIL_HOST', 'a host name');
    const senders = required(env, 'JOBS_MAIL_ALLOWED_SENDERS')
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== '');
    for (const s of senders)
      if (!ADDRESS_RE.test(s))
        throw invalid(
          'JOBS_MAIL_ALLOWED_SENDERS',
          'email addresses separated by commas'
        );
    const password = required(env, 'JOBS_MAIL_PASSWORD');
    if (password.length < 6) {
      off.push({
        way: 'Email',
        why: 'JOBS_MAIL_PASSWORD is too short to be kept out of the logs',
      });
    } else {
      mail = {
        host,
        port: mailPort,
        user: required(env, 'JOBS_MAIL_USER'),
        password,
        authservId: required(env, 'JOBS_MAIL_AUTHSERV_ID'),
        allowedSenders: [...new Set(senders)],
      };
    }
  }

  // Telegram.
  const botToken = value(env, 'JOBS_TELEGRAM_BOT_TOKEN');
  const ownerId = wholeNumber(
    env,
    'JOBS_TELEGRAM_OWNER_ID',
    1,
    Number.MAX_SAFE_INTEGER
  );
  let telegram: TelegramSettings | undefined;
  if (botToken === undefined) {
    off.push({ way: 'Telegram', why: 'JOBS_TELEGRAM_BOT_TOKEN is not set' });
  } else {
    if (!/^\d{3,20}:[A-Za-z0-9_-]{20,}$/.test(botToken))
      throw invalid('JOBS_TELEGRAM_BOT_TOKEN', 'a token as BotFather gives it');
    telegram = { botToken, ...(ownerId !== undefined ? { ownerId } : {}) };
  }

  if (aiOff !== undefined) {
    for (const way of ['Email', 'Telegram', 'Folder'] as const) {
      const at = off.findIndex((o) => o.way === way);
      const why = `the AI is off: ${aiOff}`;
      if (at >= 0) off[at] = { way, why: `${off[at]?.why}; ${why}` };
      else off.push({ way, why });
    }
  }

  return {
    supamacApiKey,
    supamacBaseUrl,
    ownerEmail,
    timeZone,
    stateDir,
    healthPort,
    ...(webAppUrl !== undefined ? { webAppUrl } : {}),
    ...(extractUrl !== undefined
      ? { extractUrl: extractUrl.replace(/\/+$/, '') }
      : {}),
    ...(ai !== undefined ? { ai } : {}),
    ...(aiOff !== undefined ? { aiOff } : {}),
    ...(mail !== undefined ? { mail } : {}),
    ...(telegram !== undefined ? { telegram } : {}),
    off,
  };
}

/** Whether a way in is on. */
export function wayOn(config: Config, way: Way): boolean {
  return !config.off.some((o) => o.way === way);
}

/** The Status row's "Ways in off" text. */
export function offText(config: Config): string | null {
  return config.off.length === 0
    ? null
    : config.off.map((o) => `${o.way}: ${o.why}`).join('; ');
}

/** Registers every secret with the logger, so no line carries one. */
export function registerSecrets(config: Config, logger: Logger): void {
  logger.addSecret(config.supamacApiKey);
  if (config.ai !== undefined) logger.addSecret(config.ai.apiKey);
  if (config.telegram !== undefined) logger.addSecret(config.telegram.botToken);
  if (config.mail !== undefined) logger.addSecret(config.mail.password);
}
