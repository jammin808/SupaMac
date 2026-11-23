// The extraction container's server (docs/supamac/jobs.md, Security: Hostile
// files): the jobs service sends each source's bytes here (remote.ts), and
// this parses them in a child process with limits (sandbox.ts).
//
// Invariants:
// - The container holds nothing worth taking: no secret (the server refuses
//   to start with any variable that looks like one, `refusedSettings`), no
//   state volume, and no network but the one it shares with the jobs
//   service, which has no route out. A parser made to run code reaches no
//   key, no saved state and no other host.
// - One extraction at a time, in the order asked. After each one, with
//   `sweep` on (compose sets JOBS_EXTRACT_SWEEP=on), every process in the
//   container but the server, PID 1 and what `docker exec` started (its
//   parent is outside the container, so its parent id reads 0) is killed:
//   nothing a parser started outlives its extraction, even one that left its
//   process group.
// - The request (hint and limits) is validated as the child validates it;
//   one that does not validate is answered 400 without parsing anything.
//   A body over the read limit is answered 413 by the runtime.
// - `/health` answers 200 with no content; anything else is 404.
// - On Linux the server makes itself not dumpable before it listens
//   (seal.ts), so a parser's leftover process cannot reach into it.

import { readdirSync, readFileSync } from 'node:fs';
import { serve } from 'bun';
import { Logger } from '../log';
import { sealProcess } from '../seal';
import { extractInSandbox } from './sandbox';
import {
  type ExtractHint,
  type ExtractOutcome,
  LIMITS,
  type Limits,
  MIB,
} from './types';
import {
  decodeRequest,
  encodeOutcome,
  REQUEST_HEADER,
  requestLimits,
} from './wire';

export const EXTRACT_PORT = 8090;

export type SandboxCall = (
  bytes: Uint8Array,
  hint: ExtractHint,
  limits: Limits
) => Promise<ExtractOutcome>;

export interface ExtractServerOptions {
  readonly port?: number | undefined;
  readonly hostname?: string | undefined;
  /** The extraction; sandbox.ts's unless a test gives one. */
  readonly extract?: SandboxCall | undefined;
  /** Run after every extraction; the sweep in the container. */
  readonly after?: (() => void) | undefined;
  readonly logger?: Logger | undefined;
}

export interface ExtractServer {
  readonly port: number;
  stop(): Promise<void>;
}

/** Names whose presence stops the start: anything that could be a secret. */
export function refusedSettings(
  env: Readonly<Record<string, string | undefined>>
): string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined)
    .filter(
      (name) =>
        (/^(JOBS_|ANTHROPIC_|INTERNAL_|DATABASE_|MACRO_DB)/.test(name) &&
          !/^JOBS_EXTRACT_(PORT|SWEEP)$/.test(name)) ||
        /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i.test(name)
    )
    .sort();
}

/** The parent id in a /proc/<pid>/stat line, read after the command's closing parenthesis. */
export function parentOf(stat: string): number | undefined {
  const end = stat.lastIndexOf(')');
  if (end < 0) return undefined;
  const fields = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) ? ppid : undefined;
}

export interface SweepOptions {
  readonly procRoot?: string | undefined;
  readonly self?: number | undefined;
  readonly kill?: ((pid: number) => void) | undefined;
}

/** Kills every process but this one, PID 1 and those `docker exec` started; returns their ids. */
export function sweepStrays(options: SweepOptions = {}): number[] {
  const root = options.procRoot ?? '/proc';
  const self = options.self ?? process.pid;
  const kill =
    options.kill ??
    ((pid: number) => {
      process.kill(pid, 'SIGKILL');
    });
  const killed: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return killed;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === self || pid === 1) continue;
    let stat: string;
    try {
      stat = readFileSync(`${root}/${entry}/stat`, 'utf8');
    } catch {
      continue;
    }
    const ppid = parentOf(stat);
    if (ppid === undefined || ppid === 0) continue;
    try {
      kill(pid);
      killed.push(pid);
    } catch {
      // Gone already, or not this user's: nothing to do.
    }
  }
  return killed;
}

/** Starts the server; see the header. */
export function startExtractServer(
  options: ExtractServerOptions = {}
): ExtractServer {
  const logger =
    options.logger ?? new Logger({ fields: { service: 'jobs-extract' } });
  const extract: SandboxCall =
    options.extract ??
    ((bytes, hint, limits) => extractInSandbox(bytes, hint, { limits }));
  let tail: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task);
    tail = next.catch(() => undefined);
    return next;
  };
  const server = serve({
    port: options.port ?? EXTRACT_PORT,
    ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
    maxRequestBodySize: LIMITS.maxBytes + MIB,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/health' && request.method === 'GET')
        return new Response(null, { status: 200 });
      if (url.pathname !== '/extract' || request.method !== 'POST')
        return new Response('not found', { status: 404 });
      const parsed = decodeRequest(request.headers.get(REQUEST_HEADER));
      if (parsed === undefined)
        return new Response('the request is not valid', { status: 400 });
      const bytes = new Uint8Array(await request.arrayBuffer());
      const started = Date.now();
      const outcome = await oneAtATime(async () => {
        try {
          return await extract(bytes, parsed.hint, requestLimits(parsed));
        } finally {
          options.after?.();
        }
      });
      logger.info('extracted', {
        bytes: bytes.length,
        ok: outcome.ok,
        ...(outcome.ok ? {} : { refusal: outcome.refusal.kind }),
        ms: Date.now() - started,
      });
      return new Response(encodeOutcome(outcome), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    error(error) {
      logger.warn('extraction request failed', { error });
      return new Response('the extraction failed', { status: 500 });
    },
  });
  return {
    port: server.port ?? 0,
    async stop() {
      await server.stop();
    },
  };
}

/** Runs the server in the extraction container. */
export function main(): void {
  const logger = new Logger({ fields: { service: 'jobs-extract' } });
  const refused = refusedSettings(process.env);
  if (refused.length > 0) {
    logger.error('the extraction server refuses to start with a secret', {
      names: refused,
    });
    process.exitCode = 1;
    return;
  }
  try {
    if (sealProcess() === 'not_linux')
      logger.warn(
        'not sealed: only Linux keeps this process from its children'
      );
  } catch (error) {
    logger.error('the extraction server did not start', { error });
    process.exitCode = 1;
    return;
  }
  const portText = process.env.JOBS_EXTRACT_PORT;
  const port =
    portText !== undefined && /^\d{1,5}$/.test(portText)
      ? Number(portText)
      : EXTRACT_PORT;
  const sweep = process.env.JOBS_EXTRACT_SWEEP === 'on';
  const server = startExtractServer({
    port,
    logger,
    ...(sweep
      ? {
          after: () => {
            const killed = sweepStrays();
            if (killed.length > 0)
              logger.warn('killed processes a parser left behind', {
                count: killed.length,
              });
          },
        }
      : {}),
  });
  logger.info('extraction server started', { port: server.port, sweep });
  const stop = (): void => {
    server.stop().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      }
    );
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (import.meta.main) main();
