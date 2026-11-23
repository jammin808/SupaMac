// The jobs mailbox as a way in (docs/supamac/jobs.md §1): the Intake that
// main.ts starts when the mailbox settings are all there (pipeline/intake.ts).
//
// Invariants:
// - `start` only starts the reader's loop and returns: the first poll may
//   wait for the Jobs database (the pipeline holds its steps until the
//   schema is verified), and a mailbox that does not answer is reported as
//   the `mail` connection, never as a failed start.
// - `stop` ends the loop after the message in hand (the pipeline step in
//   flight is waited for, then nothing more is moved) and logs out.
// - The jobs address the To check looks for is JOBS_MAIL_USER when it is an
//   email address; otherwise none is known and every message is refused
//   with that reason (the setup document says so).
// - The mailbox is reached through the egress proxy that HTTPS_PROXY (or
//   https_proxy) names, unless NO_PROXY covers the mailbox host: the same
//   proxy every HTTPS client in the container uses. A proxy URL that does
//   not parse, or names a scheme imapflow cannot speak, stops the service's
//   start with a MailError that does not repeat the URL.
// - The mailbox password is registered with every logger this way in logs
//   through.

import type { Config, MailSettings } from '../config';
import { Logger } from '../log';
import type { Intake, IntakeContext, SettingCheck } from '../pipeline/intake';
import { asciiLower, type MailPolicy } from './auth';
import {
  checkLogin,
  type ImapClientFactory,
  imapFlowFactory,
  MailboxReader,
  MailError,
} from './imap';

export type Env = Readonly<Record<string, string | undefined>>;

const ADDRESS_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const PROXY_SCHEMES = new Set([
  'http:',
  'https:',
  'socks:',
  'socks4:',
  'socks4a:',
  'socks5:',
]);

/** The mail check's policy from the mailbox settings. */
export function mailPolicy(settings: MailSettings): MailPolicy {
  const user = asciiLower(settings.user.trim());
  return {
    authservId: settings.authservId,
    allowedSenders: settings.allowedSenders,
    jobsAddresses: ADDRESS_RE.test(user) ? [user] : [],
  };
}

function noProxy(env: Env, host: string): boolean {
  const list = env.NO_PROXY ?? env.no_proxy;
  if (list === undefined) return false;
  const h = host.toLowerCase();
  return list
    .split(/[\s,]+/)
    .map((e) => e.trim().toLowerCase().replace(/:\d+$/, ''))
    .filter((e) => e !== '')
    .some((e) => {
      if (e === '*') return true;
      const bare = e.replace(/^\*?\./, '');
      return h === bare || h.endsWith(`.${bare}`);
    });
}

/** The egress proxy for the mailbox host, if any (see the header). */
export function egressProxy(env: Env, host: string): string | undefined {
  const value = (env.HTTPS_PROXY ?? env.https_proxy)?.trim();
  if (value === undefined || value === '' || noProxy(env, host))
    return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MailError('proxy', 'HTTPS_PROXY is not a URL');
  }
  if (!PROXY_SCHEMES.has(url.protocol))
    throw new MailError(
      'proxy',
      'HTTPS_PROXY must be an http, https or socks proxy URL for the mailbox'
    );
  return value;
}

export interface MailIntakeOptions {
  readonly settings: MailSettings;
  readonly proxy?: string | undefined;
  /** Clients in place of imapflow's, for tests. */
  readonly connect?: ((logger: Logger) => ImapClientFactory) | undefined;
  readonly pollMs?: number | undefined;
}

export class MailIntake implements Intake {
  readonly name = 'mail' as const;
  private reader: MailboxReader | undefined;
  private abort: AbortController | undefined;
  private running: Promise<void> | undefined;
  private logger: Logger | undefined;
  private readonly policy: MailPolicy;

  constructor(private readonly options: MailIntakeOptions) {
    this.policy = mailPolicy(options.settings);
  }

  private factory(logger: Logger): ImapClientFactory {
    logger.addSecret(this.options.settings.password);
    return (
      this.options.connect?.(logger) ??
      imapFlowFactory(
        {
          host: this.options.settings.host,
          port: this.options.settings.port,
          user: this.options.settings.user,
          password: this.options.settings.password,
          ...(this.options.proxy !== undefined
            ? { proxy: this.options.proxy }
            : {}),
        },
        logger
      )
    );
  }

  async start(context: IntakeContext): Promise<void> {
    if (this.running !== undefined)
      throw new Error('the mail intake is already started');
    const logger = context.logger.child({ intake: 'mail' });
    this.logger = logger;
    const reader = new MailboxReader({
      host: this.options.settings.host,
      policy: this.policy,
      connect: this.factory(logger),
      pipeline: context.pipeline,
      notifier: context.notifier,
      health: context.health,
      logger,
      clock: context.clock,
      pollMs: this.options.pollMs,
    });
    this.reader = reader;
    this.abort = new AbortController();
    const signal = AbortSignal.any([context.signal, this.abort.signal]);
    this.running = reader.run(signal);
    logger.info('mailbox reader started', {
      host: this.options.settings.host,
      proxy: this.options.proxy !== undefined,
    });
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.running;
    await this.reader?.close();
    this.running = undefined;
    this.reader = undefined;
  }

  check(): Promise<SettingCheck> {
    const logger = this.logger ?? new Logger({ fields: { intake: 'mail' } });
    return checkLogin({
      host: this.options.settings.host,
      policy: this.policy,
      connect: this.factory(logger),
      logger,
    });
  }
}

/** The mail intake when its settings are all there; none otherwise. */
export function mailIntakes(
  config: Config,
  env: Env,
  seams: {
    readonly connect?: MailIntakeOptions['connect'];
    readonly pollMs?: number | undefined;
  } = {}
): Intake[] {
  if (config.mail === undefined) return [];
  return [
    new MailIntake({
      settings: config.mail,
      proxy: egressProxy(env, config.mail.host),
      ...(seams.connect !== undefined ? { connect: seams.connect } : {}),
      ...(seams.pollMs !== undefined ? { pollMs: seams.pollMs } : {}),
    }),
  ];
}
