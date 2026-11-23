// The jobs mailbox over IMAP (docs/supamac/jobs.md §1, §3, Settings,
// Operations: Health): every minute, each message in INBOX is checked on
// its headers alone (auth.ts), and an accepted one goes whole to the
// pipeline as an email.
//
// Invariants:
// - Nothing is fetched beyond a message's header block (BODY.PEEK[HEADER],
//   with its size, flags and arrival date) before the mail check accepts it
//   and its size is within MAX_MESSAGE_BYTES. Every fetch peeks, so no
//   message is marked read by the service.
// - A refused message, or one over the size limit, is moved to `Refused`
//   unread (a read flag someone else set is taken off first; a server that
//   will not take it off is logged, and the message still moves), and the owner
//   is told the sender and the check that failed, never its subject or any
//   of its content. The note is delivered before the message is moved, so
//   nothing is moved untold: while the notifier fails, the message stays in
//   INBOX and is checked and told again later, after a restart too, with
//   the backoff below (once a note fails, the poll's other refusals wait
//   for the next try). A refusal is told once per message, twice only when
//   the service stops between the note and the move.
// - A message the server will not give is that message's failure, not the
//   mailbox's: a FETCH answered NO or BAD (other than throttling) on a
//   connection that is still usable, or a message given without its header
//   block or source. It stays in INBOX, the messages after it are read, and
//   it is tried again with the backoff below; after MAX_READ_FAILURES failed
//   reads the owner is told once (per run of the service). A batch FETCH the
//   server refuses is read again one message at a time. Any other command
//   for one message the server refuses (a STORE, a MOVE) leaves that
//   message in INBOX the same way.
// - An accepted message is checked again on its full source (the same
//   headers must give the same decision) before the pipeline sees it, and
//   then moved by the pipeline's result: to `Processed` once the email and
//   every attachment the result lists have finished or were already
//   recorded, to `Failed` when one of them Failed, and left in INBOX while
//   any is still Processing or waiting to retry. A message left in INBOX is
//   handed to the pipeline again later (it is resumable and records a
//   source once, so a second hand-over is safe), at most once a minute at
//   first and backing off to every fifteen minutes.
// - A pipeline step that throws leaves the message in INBOX and backs off
//   the same way; it is not the mailbox's failure.
// - The `Processed`, `Refused` and `Failed` folders are made when missing,
//   once per connection.
// - The mailbox's health is reported as connection `mail`: a poll that
//   completes reports it up; a login refused, a TLS failure, the mailbox or
//   the egress proxy not answering reports it down with why, and the next
//   connection waits (one minute doubling to fifteen; a refused login five
//   minutes doubling to an hour, so the provider does not lock the account).
//   A connection that worked and drops mid-poll is opened again at once,
//   once, before the mailbox is reported down.
//   Every text is masked by the service's logger, and nothing logs the
//   password: imapflow's own lines are reduced to their message and code.
// - At most MAX_PER_POLL messages are read per poll, oldest first. New mail
//   seen while idle wakes the loop early, at most once every MIN_GAP_MS.
// - TLS is always on (implicit TLS, or STARTTLS required on port 143) with
//   the runtime's certificate checks; the connection goes through the
//   egress proxy when one is given (imapflow speaks HTTP CONNECT and SOCKS).
//
// Choices where the design is silent, each the more cautious one:
// - An attachment that Failed sends its email to `Failed` too, so the
//   folder shows every message that holds something the owner must retry.
// - A recorded source whose status is not known yet counts as still
//   Processing: a source has no status until it finishes.
// - A message the server will not move stays where it is and is tried again
//   later, without telling the owner twice.

import { ImapFlow } from 'imapflow';
import type { Logger } from '../log';
import { errorText } from '../pipeline/context';
import type { HealthMonitor } from '../pipeline/health';
import type { SettingCheck } from '../pipeline/intake';
import type { Notifier, RefusedMail } from '../pipeline/notify';
import type { EmailInput, SourceResult } from '../pipeline/process';
import { checkMail, type MailPolicy } from './auth';

export const FOLDERS = ['Processed', 'Refused', 'Failed'] as const;
export type Folder = (typeof FOLDERS)[number];

/** The largest message read (40 MB); a larger one is refused with a note. */
export const MAX_MESSAGE_BYTES = 40_000_000;
export const POLL_MS = 60_000;
export const MAX_PER_POLL = 20;
export const MIN_GAP_MS = 5_000;
/** Failed reads of one message before the owner is told it cannot be read. */
export const MAX_READ_FAILURES = 3;
const MAX_BACKOFF_MS = 15 * 60_000;
const LOGIN_BACKOFF_MS = 5 * 60_000;
const MAX_LOGIN_BACKOFF_MS = 60 * 60_000;
const LOGOUT_MS = 5_000;
const HEADER_QUERY = {
  uid: true,
  size: true,
  flags: true,
  internalDate: true,
  headers: true,
} as const;

// ---------------------------------------------------------------------------
// The client, as much of imapflow's ImapFlow as the reader uses.

export interface FetchedMessage {
  readonly uid: number;
  readonly size?: number | undefined;
  readonly flags?: ReadonlySet<string> | undefined;
  readonly internalDate?: Date | string | undefined;
  readonly headers?: Uint8Array | undefined;
  readonly source?: Uint8Array | undefined;
}

export interface FetchQuery {
  readonly uid?: boolean;
  readonly size?: boolean;
  readonly flags?: boolean;
  readonly internalDate?: boolean;
  readonly headers?: boolean;
  readonly source?: boolean;
}

export interface ListedMailbox {
  readonly path: string;
  readonly name: string;
  readonly parent: readonly string[];
}

export interface ImapClient {
  readonly usable: boolean;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  list(): Promise<readonly ListedMailbox[]>;
  mailboxCreate(path: string): Promise<{ readonly path: string }>;
  mailboxOpen(path: string): Promise<{
    readonly path: string;
    readonly uidValidity: bigint;
    readonly exists: number;
  }>;
  search(
    query: { readonly all: true },
    options: { readonly uid: true }
  ): Promise<number[] | false | undefined>;
  fetch(
    range: string,
    query: FetchQuery,
    options: { readonly uid: true }
  ): AsyncIterable<FetchedMessage>;
  fetchOne(
    range: string,
    query: FetchQuery,
    options: { readonly uid: true }
  ): Promise<FetchedMessage | false>;
  messageMove(
    range: string,
    destination: string,
    options: { readonly uid: true }
  ): Promise<unknown>;
  messageFlagsRemove(
    range: string,
    flags: string[],
    options: { readonly uid: true }
  ): Promise<boolean>;
  on(
    event: 'error' | 'close' | 'exists',
    listener: (arg: unknown) => void
  ): unknown;
}

export type ImapClientFactory = (options: {
  readonly verifyOnly: boolean;
}) => ImapClient;

export interface ImapFlowSettings {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  /** The egress proxy: `http://`, `https://` (CONNECT) or `socks5://`. */
  readonly proxy?: string | undefined;
}

/** imapflow's lines, reduced to their message and code, at debug level. */
function imapLogger(logger: Logger): {
  debug(obj: unknown): void;
  info(obj: unknown): void;
  warn(obj: unknown): void;
  error(obj: unknown): void;
} {
  const line = (obj: unknown): Record<string, unknown> => {
    if (typeof obj !== 'object' || obj === null) return {};
    const o = obj as Record<string, unknown>;
    const err = o.err;
    return {
      ...(typeof o.msg === 'string' ? { imap: o.msg.slice(0, 200) } : {}),
      ...(err instanceof Error ? { error: err.message.slice(0, 200) } : {}),
      ...(typeof o.code === 'string' ? { code: o.code } : {}),
    };
  };
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: (obj) => logger.debug('imap warning', line(obj)),
    error: (obj) => logger.debug('imap error', line(obj)),
  };
}

/** Clients from imapflow, TLS always on, bounded in what a server can make them hold. */
export function imapFlowFactory(
  settings: ImapFlowSettings,
  logger: Logger
): ImapClientFactory {
  return ({ verifyOnly }) => {
    const client: ImapClient = new ImapFlow({
      host: settings.host,
      port: settings.port,
      secure: settings.port !== 143,
      ...(settings.port === 143 ? { doSTARTTLS: true } : {}),
      auth: { user: settings.user, pass: settings.password },
      logger: imapLogger(logger),
      ...(settings.proxy !== undefined ? { proxy: settings.proxy } : {}),
      verifyOnly,
      clientInfo: { name: 'supamac-jobs' },
      tls: { minVersion: 'TLSv1.2' },
      connectionTimeout: 60_000,
      greetingTimeout: 30_000,
      maxLineLength: 8 * 1024 * 1024,
      maxLiteralSize: MAX_MESSAGE_BYTES + 1024 * 1024,
      maxResponseSize: MAX_MESSAGE_BYTES + 2 * 1024 * 1024,
    });
    return client;
  };
}

// ---------------------------------------------------------------------------
// Errors.

export type MailErrorKind =
  | 'login'
  | 'tls'
  | 'unreachable'
  | 'proxy'
  | 'folder'
  | 'protocol';

export class MailError extends Error {
  readonly kind: MailErrorKind;
  constructor(
    kind: MailErrorKind,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'MailError';
    this.kind = kind;
  }
}

const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'ETIMEOUT',
  'NoConnection',
  'EConnectionClosed',
  'ClosedAfterConnectText',
]);
const PROXY = new Set([
  'ProxyError',
  'EPROXY',
  'UnsupportedProxyAddress',
  'ERR_INVALID_URL',
]);
const TLS_CODE =
  /^(?:ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH|ClosedAfterConnectTLS|STARTTLS)/;

function field(error: unknown, name: string): unknown {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)[name]
    : undefined;
}

/**
 * Whether the server answered one command with NO or BAD (not throttling)
 * on a connection that is still usable: a failure of what the command was
 * for, not of the mailbox.
 */
export function refusedByServer(error: unknown, client: ImapClient): boolean {
  const status = field(error, 'responseStatus');
  return (
    client.usable &&
    (status === 'NO' || status === 'BAD') &&
    field(error, 'code') !== 'ETHROTTLE'
  );
}

/** What the server said when it refused a command, short, for a log line. */
function serverText(error: unknown): string {
  const text = field(error, 'responseText');
  return typeof text === 'string' ? text.slice(0, 200) : errorText(error);
}

/** What an imapflow, socket or TLS error says about the mailbox. */
export function classifyMailError(error: unknown): MailError {
  if (error instanceof MailError) return error;
  const code = field(error, 'code');
  const codeText = typeof code === 'string' ? code.slice(0, 60) : undefined;
  const options = { cause: error };
  if (field(error, 'authenticationFailed') === true)
    return new MailError(
      'login',
      'the mailbox refused the login: check JOBS_MAIL_USER and JOBS_MAIL_PASSWORD (an app password)',
      options
    );
  if (
    field(error, 'tlsFailed') === true ||
    (codeText !== undefined && TLS_CODE.test(codeText))
  )
    return new MailError(
      'tls',
      `TLS with the mailbox failed (${codeText ?? errorText(error)})`,
      options
    );
  if (codeText !== undefined && PROXY.has(codeText))
    return new MailError(
      'proxy',
      `the egress proxy did not open a connection to the mailbox (${codeText})`,
      options
    );
  if (codeText !== undefined && UNREACHABLE.has(codeText))
    return new MailError(
      'unreachable',
      `the mailbox did not answer (${codeText})`,
      options
    );
  return new MailError(
    'protocol',
    `the mailbox failed: ${errorText(error)}`,
    options
  );
}

// ---------------------------------------------------------------------------
// Where a message goes.

export type Placement = 'Processed' | 'Failed' | 'stay';

/** Where the pipeline's result puts the message (see the header). */
export function placementOf(result: SourceResult): Placement {
  let pending = false;
  let failed = false;
  const visit = (r: SourceResult): void => {
    if (
      r.kind === 'waiting' ||
      r.status === undefined ||
      r.status === 'Processing'
    )
      pending = true;
    else if (r.status === 'Failed') failed = true;
    for (const child of r.children) visit(child);
  };
  visit(result);
  return pending ? 'stay' : failed ? 'Failed' : 'Processed';
}

// ---------------------------------------------------------------------------
// The reader.

/** Where an accepted message goes: the pipeline's email step. */
export interface EmailSink {
  processEmail(input: EmailInput): Promise<SourceResult>;
}

export type MailHealth = Pick<
  HealthMonitor,
  'succeeded' | 'failed' | 'connection'
>;

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

export interface MailboxReaderOptions {
  readonly host: string;
  readonly policy: MailPolicy;
  readonly connect: ImapClientFactory;
  readonly pipeline: EmailSink;
  readonly notifier: Pick<Notifier, 'refusedMail' | 'note'>;
  readonly health: MailHealth;
  readonly logger: Logger;
  readonly clock: () => Date;
  readonly pollMs?: number | undefined;
  readonly maxPerPoll?: number | undefined;
  readonly minGapMs?: number | undefined;
  readonly sleep?: Sleep | undefined;
}

export interface PollReport {
  /** Messages whose headers were read. */
  readonly seen: number;
  /** Moved to Refused, the owner told. */
  readonly refused: number;
  readonly processed: number;
  readonly failed: number;
  /** Left in INBOX for the pipeline to finish. */
  readonly kept: number;
  /** Messages a step could not finish (a read, a note, a move); tried again later. */
  readonly errors: number;
}

interface Session {
  readonly client: ImapClient;
  readonly folders: Readonly<Record<Folder, string>>;
}

type Counts = { -readonly [K in keyof PollReport]: number };

/** One poll's session and tallies. */
interface PollRun {
  readonly session: Session;
  readonly counts: Counts;
  /** A note failed this poll: the poll's other notes wait for the next. */
  notesFailed: boolean;
}

function isoOf(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

function findFolder(
  listed: readonly ListedMailbox[],
  name: Folder
): string | undefined {
  const exact = listed.find((m) => m.path === name);
  if (exact !== undefined) return exact.path;
  return listed.find(
    (m) =>
      m.name === name &&
      (m.parent.length === 0 ||
        (m.parent.length === 1 && m.parent[0]?.toUpperCase() === 'INBOX'))
  )?.path;
}

function grew(event: unknown): boolean {
  const count = field(event, 'count');
  const prev = field(event, 'prevCount');
  return typeof count === 'number' && typeof prev === 'number' && count > prev;
}

export class MailboxReader {
  private session: Session | undefined;
  private uidValidity: bigint | undefined;
  /** Messages left in INBOX, by UID: when to hand them over again. */
  private readonly later = new Map<number, { attempts: number; at: number }>();
  /** Refused messages whose note was delivered and that are not moved yet, by UID. */
  private readonly told = new Set<number>();
  /** Failed reads of messages still in INBOX, by UID. */
  private readonly readFailures = new Map<number, number>();
  /** Messages the owner was told cannot be read, by UID. */
  private readonly warned = new Set<number>();
  private readonly pollMs: number;
  private readonly maxPerPoll: number;
  private readonly minGapMs: number;
  private readonly sleep: Sleep;
  private woken = false;
  private wakeUp: (() => void) | undefined;
  private up = false;

  constructor(private readonly options: MailboxReaderOptions) {
    this.pollMs = options.pollMs ?? POLL_MS;
    this.maxPerPoll = options.maxPerPoll ?? MAX_PER_POLL;
    this.minGapMs = options.minGapMs ?? MIN_GAP_MS;
    this.sleep = options.sleep ?? sleep;
  }

  private get logger(): Logger {
    return this.options.logger;
  }

  private mask(text: string): string {
    return this.logger.secrets.mask(text);
  }

  /** Polls until `signal` aborts; never rejects. */
  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    let loginFailures = 0;
    while (!signal.aborted) {
      const started = this.options.clock().getTime();
      let delay = this.pollMs;
      let report: PollReport | undefined;
      try {
        try {
          report = await this.poll(signal);
        } catch (error) {
          // A connection that worked and dropped mid-poll is opened again at
          // once, before the mailbox is called down.
          if (
            !this.up ||
            signal.aborted ||
            classifyMailError(error).kind !== 'unreachable'
          )
            throw error;
          this.logger.info('mailbox connection dropped; connecting again', {
            error: this.mask(classifyMailError(error).message),
          });
          report = await this.poll(signal);
        }
      } catch (error) {
        this.up = false;
        this.woken = false;
        const e = classifyMailError(error);
        const text = this.mask(e.message);
        if (e.kind === 'login') {
          loginFailures++;
          delay = Math.min(
            LOGIN_BACKOFF_MS * 2 ** (loginFailures - 1),
            MAX_LOGIN_BACKOFF_MS
          );
        } else {
          failures++;
          delay = Math.min(this.pollMs * 2 ** (failures - 1), MAX_BACKOFF_MS);
        }
        this.logger.warn('mailbox check failed', {
          kind: e.kind,
          error: text,
          retryInMs: delay,
        });
        try {
          this.options.health.failed('mail', text);
          await this.options.health.connection('mail', false, text);
        } catch (inner) {
          this.logger.warn('mailbox health not recorded', { error: inner });
        }
      }
      if (report !== undefined) {
        failures = 0;
        loginFailures = 0;
        this.up = true;
        if (report.seen > 0) this.logger.info('mailbox checked', { ...report });
        try {
          this.options.health.succeeded('mail');
          await this.options.health.connection('mail', true);
        } catch (inner) {
          this.logger.warn('mailbox health not recorded', { error: inner });
        }
      }
      if (signal.aborted) break;
      await this.pause(delay, signal, started);
    }
  }

  /** Waits for the next poll: `ms`, or less when new mail wakes it. */
  private async pause(
    ms: number,
    signal: AbortSignal,
    startedAt: number
  ): Promise<void> {
    const inner = new AbortController();
    const forward = (): void => inner.abort();
    signal.addEventListener('abort', forward, { once: true });
    this.wakeUp = forward;
    try {
      if (!this.woken) await this.sleep(ms, inner.signal);
    } finally {
      this.wakeUp = undefined;
      signal.removeEventListener('abort', forward);
    }
    if (signal.aborted || !this.woken) return;
    this.woken = false;
    const gap = this.minGapMs - (this.options.clock().getTime() - startedAt);
    if (gap > 0) await this.sleep(gap, signal);
  }

  private wake(): void {
    if (!this.up) return;
    this.woken = true;
    this.wakeUp?.();
  }

  private async connectSession(): Promise<Session> {
    const client = this.options.connect({ verifyOnly: false });
    client.on('error', (error) => {
      this.logger.warn('mailbox connection error', {
        error: this.mask(classifyMailError(error).message),
      });
    });
    client.on('close', () => {
      if (this.session?.client === client) this.session = undefined;
    });
    client.on('exists', (event) => {
      if (this.session?.client === client && grew(event)) this.wake();
    });
    try {
      await client.connect();
    } catch (error) {
      this.discard(client);
      throw classifyMailError(error);
    }
    try {
      const folders = await this.ensureFolders(client);
      return { client, folders };
    } catch (error) {
      this.discard(client);
      throw error;
    }
  }

  private async ensureFolders(
    client: ImapClient
  ): Promise<Record<Folder, string>> {
    const listed = await client.list();
    const out: Partial<Record<Folder, string>> = {};
    for (const name of FOLDERS) {
      let path = findFolder(listed, name);
      if (path === undefined) {
        try {
          path = (await client.mailboxCreate(name)).path;
          this.logger.info('mailbox folder created', { folder: name });
        } catch (error) {
          path = findFolder(await client.list(), name);
          if (path === undefined)
            throw new MailError(
              'folder',
              `the mailbox could not make the ${name} folder: ${errorText(error)}`,
              { cause: error }
            );
        }
      }
      out[name] = path;
    }
    return out as Record<Folder, string>;
  }

  private discard(client: ImapClient): void {
    try {
      client.close();
    } catch (error) {
      this.logger.debug('mailbox connection not closed cleanly', { error });
    }
  }

  /**
   * One poll: connects when needed and reads INBOX. Throws a MailError when
   * the mailbox fails (the connection is then dropped); a message the server
   * will not give is not the mailbox failing (see the header).
   */
  async poll(signal?: AbortSignal): Promise<PollReport> {
    if (this.session === undefined || !this.session.client.usable) {
      if (this.session !== undefined) this.discard(this.session.client);
      this.session = undefined;
      const fresh = await this.connectSession();
      this.session = fresh;
    }
    const session = this.session;
    const run: PollRun = {
      session,
      counts: {
        seen: 0,
        refused: 0,
        processed: 0,
        failed: 0,
        kept: 0,
        errors: 0,
      },
      notesFailed: false,
    };
    try {
      await this.readInbox(run, signal);
      return run.counts;
    } catch (error) {
      if (this.session === session) this.session = undefined;
      this.discard(session.client);
      throw classifyMailError(error);
    }
  }

  /** Forgets every message's backoff and tallies (a new UIDVALIDITY, an empty INBOX). */
  private forgetAll(): void {
    this.later.clear();
    this.told.clear();
    this.readFailures.clear();
    this.warned.clear();
  }

  /** Forgets the messages no longer in INBOX. */
  private keepOnly(present: ReadonlySet<number>): void {
    for (const uid of this.later.keys())
      if (!present.has(uid)) this.later.delete(uid);
    for (const uid of this.readFailures.keys())
      if (!present.has(uid)) this.readFailures.delete(uid);
    for (const set of [this.told, this.warned])
      for (const uid of set) if (!present.has(uid)) set.delete(uid);
  }

  private async readInbox(run: PollRun, signal?: AbortSignal): Promise<void> {
    const client = run.session.client;
    const box = await client.mailboxOpen('INBOX');
    if (this.uidValidity !== box.uidValidity) {
      this.uidValidity = box.uidValidity;
      this.forgetAll();
    }
    if (box.exists === 0) {
      this.forgetAll();
      return;
    }
    const found = await client.search({ all: true }, { uid: true });
    if (!Array.isArray(found))
      throw new MailError('protocol', 'the mailbox would not list INBOX');
    const present = new Set(found);
    this.keepOnly(present);
    const now = this.options.clock().getTime();
    const batch = [...present]
      .sort((a, b) => a - b)
      .filter((uid) => (this.later.get(uid)?.at ?? 0) <= now)
      .slice(0, this.maxPerPoll);
    if (batch.length === 0) return;
    const messages = await this.fetchHeaders(run, batch);
    for (const message of messages) {
      if (signal?.aborted) break;
      run.counts.seen++;
      try {
        await this.handle(run, message);
      } catch (error) {
        if (!refusedByServer(error, client)) throw error;
        run.counts.errors++;
        this.defer(message.uid);
        this.logger.warn(
          'the mailbox refused a command for a message; it stays in INBOX',
          {
            uid: message.uid,
            error: this.mask(serverText(error)),
          }
        );
      }
    }
  }

  /**
   * The header blocks of `batch`, oldest first. When the server refuses the
   * batch, each message not given yet is asked for alone, and one it
   * refuses is left for later.
   */
  private async fetchHeaders(
    run: PollRun,
    batch: readonly number[]
  ): Promise<FetchedMessage[]> {
    const client = run.session.client;
    const messages: FetchedMessage[] = [];
    try {
      for await (const m of client.fetch(batch.join(','), HEADER_QUERY, {
        uid: true,
      }))
        messages.push(m);
    } catch (error) {
      if (!refusedByServer(error, client)) throw error;
      this.logger.warn(
        'the mailbox refused a batch of headers; reading them one at a time',
        { count: batch.length, error: this.mask(serverText(error)) }
      );
      const given = new Set(messages.map((m) => m.uid));
      for (const uid of batch) {
        if (given.has(uid)) continue;
        try {
          for await (const m of client.fetch(String(uid), HEADER_QUERY, {
            uid: true,
          }))
            if (m.uid === uid) messages.push(m);
        } catch (inner) {
          if (!refusedByServer(inner, client)) throw inner;
          await this.unreadable(run, uid, 'header block', {
            error: inner,
          });
        }
      }
    }
    return messages.sort((a, b) => a.uid - b.uid);
  }

  private defer(uid: number): void {
    const attempts = (this.later.get(uid)?.attempts ?? 0) + 1;
    const delay = Math.min(this.pollMs * 2 ** (attempts - 1), MAX_BACKOFF_MS);
    this.later.set(uid, {
      attempts,
      at: this.options.clock().getTime() + delay,
    });
  }

  /**
   * A message the server would not give: left in INBOX for later, and the
   * owner told once when it has failed MAX_READ_FAILURES times.
   */
  private async unreadable(
    run: PollRun,
    uid: number,
    what: 'header block' | 'source',
    detail: { readonly error?: unknown; readonly from?: string } = {}
  ): Promise<void> {
    run.counts.errors++;
    this.defer(uid);
    const failures = (this.readFailures.get(uid) ?? 0) + 1;
    this.readFailures.set(uid, failures);
    this.logger.warn(
      'the mailbox would not give a message; it stays in INBOX',
      {
        uid,
        what,
        failures,
        ...(detail.error !== undefined
          ? { error: this.mask(serverText(detail.error)) }
          : {}),
      }
    );
    if (failures < MAX_READ_FAILURES || this.warned.has(uid) || run.notesFailed)
      return;
    const sender = detail.from !== undefined ? ` from ${detail.from}` : '';
    try {
      await this.options.notifier.note({
        kind: 'error',
        text: `A message${sender} in the jobs mailbox cannot be read: the mailbox would not give its ${what} (${failures} tries). It stays in INBOX, unread by the service, and is tried again later (at least every 15 minutes); open the mailbox to look at it, or forward it again.`,
      });
      this.warned.add(uid);
    } catch (error) {
      run.notesFailed = true;
      this.logger.warn('unreadable-message note not delivered', {
        uid,
        error,
      });
    }
  }

  private async handle(run: PollRun, message: FetchedMessage): Promise<void> {
    const { session, counts } = run;
    const uid = message.uid;
    if (message.headers === undefined) {
      await this.unreadable(run, uid, 'header block');
      return;
    }
    const decision = checkMail(message.headers, this.options.policy);
    if (!decision.ok) {
      this.readFailures.delete(uid);
      await this.refuse(run, message, {
        from: decision.from,
        check: decision.reason,
      });
      return;
    }
    const size = message.size;
    if (size === undefined || size > MAX_MESSAGE_BYTES) {
      this.readFailures.delete(uid);
      await this.refuse(run, message, {
        from: decision.from,
        check:
          size === undefined
            ? 'Size: the mailbox did not give the message’s size'
            : `Size: the message is ${megabytes(size)} MB, over the ${megabytes(MAX_MESSAGE_BYTES)} MB limit`,
      });
      return;
    }
    let full: FetchedMessage | false;
    try {
      full = await session.client.fetchOne(
        String(uid),
        { uid: true, source: true },
        { uid: true }
      );
    } catch (error) {
      if (!refusedByServer(error, session.client)) throw error;
      await this.unreadable(run, uid, 'source', {
        error,
        from: decision.from,
      });
      return;
    }
    if (full === false || full.source === undefined) {
      await this.unreadable(run, uid, 'source', { from: decision.from });
      return;
    }
    this.readFailures.delete(uid);
    const source = full.source;
    if (source.length > MAX_MESSAGE_BYTES) {
      await this.refuse(run, message, {
        from: decision.from,
        check: `Size: the message is ${megabytes(source.length)} MB, over the ${megabytes(MAX_MESSAGE_BYTES)} MB limit`,
      });
      return;
    }
    const again = checkMail(source, this.options.policy);
    if (!again.ok || again.from !== decision.from) {
      await this.refuse(run, message, {
        from: again.from,
        check: again.ok
          ? 'Headers: the message’s headers changed between reads'
          : again.reason,
      });
      return;
    }
    const received = isoOf(message.internalDate);
    let result: SourceResult;
    try {
      result = await this.options.pipeline.processEmail({
        raw: source,
        from: decision.from,
        ...(received !== undefined ? { received } : {}),
      });
    } catch (error) {
      counts.errors++;
      this.logger.warn(
        'the pipeline did not take a message; it stays in INBOX',
        {
          uid,
          error,
        }
      );
      this.defer(uid);
      return;
    }
    const place = placementOf(result);
    if (place === 'stay') {
      counts.kept++;
      this.defer(uid);
      this.logger.info('message left in INBOX until its source finishes', {
        uid,
        sourceId: result.sourceId,
      });
      return;
    }
    if (!(await this.move(session, uid, place))) {
      counts.errors++;
      this.defer(uid);
      return;
    }
    this.later.delete(uid);
    if (place === 'Processed') counts.processed++;
    else counts.failed++;
    this.logger.info('message filed', {
      uid,
      folder: place,
      sourceId: result.sourceId,
    });
  }

  private async move(
    session: Session,
    uid: number,
    folder: Folder
  ): Promise<boolean> {
    const moved = await session.client.messageMove(
      String(uid),
      session.folders[folder],
      { uid: true }
    );
    if (moved === false) {
      this.logger.warn('mailbox would not move a message', { uid, folder });
      return false;
    }
    return true;
  }

  /** Tells the owner, then moves the message to Refused (see the header). */
  private async refuse(
    run: PollRun,
    message: FetchedMessage,
    note: RefusedMail
  ): Promise<void> {
    const { session, counts } = run;
    const uid = message.uid;
    const check = note.check.split(':')[0];
    if (!this.told.has(uid)) {
      if (run.notesFailed) {
        counts.errors++;
        this.defer(uid);
        return;
      }
      try {
        await this.options.notifier.refusedMail(note);
      } catch (error) {
        run.notesFailed = true;
        counts.errors++;
        this.defer(uid);
        this.logger.warn(
          'refused-mail note not delivered; the message stays in INBOX until it is',
          { uid, check, error }
        );
        return;
      }
      this.told.add(uid);
      this.logger.info('message refused', { uid, check });
    }
    if (
      message.flags?.has('\\Seen') === true &&
      !(await session.client.messageFlagsRemove(String(uid), ['\\Seen'], {
        uid: true,
      }))
    )
      this.logger.warn('mailbox would not mark a refused message unread', {
        uid,
      });
    if (await this.move(session, uid, 'Refused')) {
      this.later.delete(uid);
      this.told.delete(uid);
      counts.refused++;
    } else {
      counts.errors++;
      this.defer(uid);
    }
  }

  /** Logs out, or closes when the server does not answer. */
  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        session.client.logout(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('the logout was not answered')),
            LOGOUT_MS
          );
        }),
      ]);
    } catch (error) {
      this.logger.debug('mailbox logout failed; closing', {
        error: this.mask(errorText(error)),
      });
      this.discard(session.client);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The Jobs setup document's mailbox line: a login that logs out at once. */
export async function checkLogin(options: {
  readonly host: string;
  readonly policy: MailPolicy;
  readonly connect: ImapClientFactory;
  readonly logger: Logger;
}): Promise<SettingCheck> {
  const client = options.connect({ verifyOnly: true });
  client.on('error', (error) => {
    options.logger.debug('mailbox check connection error', {
      error: options.logger.secrets.mask(classifyMailError(error).message),
    });
  });
  try {
    await client.connect();
  } catch (error) {
    try {
      client.close();
    } catch (inner) {
      options.logger.debug('mailbox check not closed cleanly', {
        error: inner,
      });
    }
    return {
      setting: 'Mailbox login',
      ok: false,
      text: options.logger.secrets.mask(classifyMailError(error).message),
    };
  }
  if (options.policy.jobsAddresses.length === 0)
    return {
      setting: 'Mailbox login',
      ok: false,
      text: `logged in to ${options.host}, but JOBS_MAIL_USER is not an email address, so the mail check cannot find the jobs address in To and refuses every message`,
    };
  const n = options.policy.allowedSenders.length;
  return {
    setting: 'Mailbox login',
    ok: true,
    text: `logged in to ${options.host}; mail from ${n} allowed sender${n === 1 ? '' : 's'} is read`,
  };
}
