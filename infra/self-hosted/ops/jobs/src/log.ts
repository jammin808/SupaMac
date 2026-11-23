// The service's one logger: structured JSON lines, with secrets masked.
//
// Invariants:
// - Every line is one JSON object: time, level, msg, then the fields.
// - No line holds a Telegram bot token (`bot<digits>:<token>`, also with the
//   colon URL encoded as `%3A`, or the bare `<digits>:<30 or more token
//   characters>`), an Anthropic key (`sk-ant-…`), or any value registered as
//   a secret (also in its URL encoded form). Masking runs on every string in
//   the fields, on error messages and stacks, and once more on the finished
//   line.
// - Writing a line never throws for what it is given: an invalid Date is
//   written as "Invalid Date", and so is the time of a clock that gives one.
// - A field whose name says it holds a secret (password, token, apiKey,
//   authorization, cookie, ...) is written as "[REDACTED]" whatever it holds.
//   Counts such as `inputTokens` are not secrets and are kept.
// - A secret shorter than six characters is refused rather than registered,
//   because masking it would blank ordinary words in every line.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const REDACTED = '[REDACTED]';

export class LogError extends Error {
  readonly kind: 'secret_too_short';
  constructor(kind: 'secret_too_short', message: string) {
    super(message);
    this.name = 'LogError';
    this.kind = kind;
  }
}

const PATTERNS: readonly [RegExp, string][] = [
  [/bot\d+(?::|%3[Aa])[A-Za-z0-9_-]+/g, `bot${REDACTED}`],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}/g, REDACTED],
  [/sk-ant-[A-Za-z0-9_-]+/g, `sk-ant-${REDACTED}`],
];

const SECRET_NAMES = new Set([
  'password',
  'passwd',
  'pass',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'bottoken',
  'apikey',
  'xapikey',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'xmacrouserapikey',
  'anthropicapikey',
  'clientsecret',
  'privatekey',
]);

const SECRET_SUFFIXES = [
  'password',
  'secret',
  'apikey',
  'bottoken',
  'accesstoken',
  'privatekey',
];

function secretName(name: string): boolean {
  const flat = name.toLowerCase().replace(/[-_\s]/g, '');
  return (
    SECRET_NAMES.has(flat) || SECRET_SUFFIXES.some((s) => flat.endsWith(s))
  );
}

/** The secret values a logger masks; shared by a logger and its children. */
export class SecretRegistry {
  private readonly values = new Set<string>();

  add(value: string): void {
    if (value.length < 6) {
      throw new LogError(
        'secret_too_short',
        'a secret to mask must be at least six characters'
      );
    }
    this.values.add(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) {
      this.values.add(encoded);
      // Percent-encoding may be written in either case (%2F or %2f).
      this.values.add(
        encoded.replace(/%[0-9A-F]{2}/g, (octet) => octet.toLowerCase())
      );
    }
  }

  /** Masks registered values and the known key and token shapes in a string. */
  mask(text: string): string {
    let out = text;
    const longestFirst = [...this.values].sort((a, b) => b.length - a.length);
    for (const value of longestFirst) out = out.split(value).join(REDACTED);
    for (const [pattern, replacement] of PATTERNS)
      out = out.replace(pattern, replacement);
    return out;
  }
}

export type LogSink = (line: string, level: LogLevel) => void;

export interface LoggerOptions {
  readonly sink?: LogSink;
  readonly clock?: () => Date;
  readonly level?: LogLevel;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly secrets?: SecretRegistry;
}

const defaultSink: LogSink = (line, level) => {
  (level === 'warn' || level === 'error'
    ? process.stderr
    : process.stdout
  ).write(`${line}\n`);
};

const RESERVED = new Set(['time', 'level', 'msg']);
const MAX_DEPTH = 8;

export class Logger {
  private readonly sink: LogSink;
  private readonly clock: () => Date;
  private readonly level: LogLevel;
  private readonly fields: Readonly<Record<string, unknown>>;
  readonly secrets: SecretRegistry;

  constructor(options: LoggerOptions = {}) {
    this.sink = options.sink ?? defaultSink;
    this.clock = options.clock ?? (() => new Date());
    this.level = options.level ?? 'info';
    this.fields = options.fields ?? {};
    this.secrets = options.secrets ?? new SecretRegistry();
  }

  /** Registers a value to mask in every later line of this logger and its children. */
  addSecret(value: string): void {
    this.secrets.add(value);
  }

  /** A logger that adds `fields` to every line and shares the secrets. */
  child(fields: Readonly<Record<string, unknown>>): Logger {
    return new Logger({
      sink: this.sink,
      clock: this.clock,
      level: this.level,
      fields: { ...this.fields, ...fields },
      secrets: this.secrets,
    });
  }

  debug(msg: string, fields?: Readonly<Record<string, unknown>>): void {
    this.write('debug', msg, fields);
  }

  info(msg: string, fields?: Readonly<Record<string, unknown>>): void {
    this.write('info', msg, fields);
  }

  warn(msg: string, fields?: Readonly<Record<string, unknown>>): void {
    this.write('warn', msg, fields);
  }

  error(msg: string, fields?: Readonly<Record<string, unknown>>): void {
    this.write('error', msg, fields);
  }

  private write(
    level: LogLevel,
    msg: string,
    fields?: Readonly<Record<string, unknown>>
  ): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const record: Record<string, unknown> = {
      time: isoTime(this.clock()),
      level,
      msg: this.secrets.mask(msg),
    };
    const all = { ...this.fields, ...fields };
    for (const [key, value] of Object.entries(all)) {
      const name = RESERVED.has(key) ? `field_${key}` : key;
      record[name] = secretName(key)
        ? REDACTED
        : this.clean(value, 0, new WeakSet());
    }
    this.sink(this.secrets.mask(JSON.stringify(record)), level);
  }

  private clean(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return this.secrets.mask(value);
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'symbol' || typeof value === 'function')
      return String(value);
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[Too deep]';
    seen.add(value);
    if (value instanceof Error) {
      const out: Record<string, unknown> = {
        name: value.name,
        message: this.secrets.mask(value.message),
      };
      const kind = (value as Error & { kind?: unknown }).kind;
      if (kind !== undefined) out.kind = this.clean(kind, depth + 1, seen);
      if (value.stack !== undefined) out.stack = this.secrets.mask(value.stack);
      if (value.cause !== undefined)
        out.cause = this.clean(value.cause, depth + 1, seen);
      return out;
    }
    if (value instanceof Date) return isoTime(value);
    if (Array.isArray(value))
      return value.map((v) => this.clean(v, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = secretName(k) ? REDACTED : this.clean(v, depth + 1, seen);
    }
    return out;
  }
}

function isoTime(date: Date): string {
  return Number.isNaN(date.getTime()) ? 'Invalid Date' : date.toISOString();
}

/** Masks the known key and token shapes in a string, with no registered secrets. */
export function maskSecrets(
  text: string,
  secrets: Iterable<string> = []
): string {
  const registry = new SecretRegistry();
  for (const s of secrets) registry.add(s);
  return registry.mask(text);
}
