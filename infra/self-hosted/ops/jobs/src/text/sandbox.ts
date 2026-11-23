// Extraction in a child process with a time and a memory limit
// (docs/supamac/jobs.md §2 and Security: "Parsing runs in a child process with
// limits").
//
// Invariants:
// - The child is a fresh Bun process running worker.ts with an empty
//   environment (so none of the service's secrets), no .env loading, no
//   package auto-install, and its working directory beside the worker. It
//   gets the bytes on stdin and the hint and limits as JSON in its arguments.
// - The child runs as the service's own user, so the service's environment
//   is out of its reach through /proc only because the service has made
//   itself not dumpable (seal.ts, in main). It still shares the service's
//   network and state volume.
// - The child is killed (SIGKILL) when it runs past `timeoutMs`, when its
//   resident memory passes `memoryLimitBytes` (read from /proc every
//   `pollMs`), or when its stdout grows past four times the input plus 16 MiB.
//   Each is a typed failure; so is a non-zero exit and an answer that does not
//   validate. The call always settles: it never waits on a child that hangs.
// - Without /proc (not Linux) memory is bounded only by the timeout.
// - stderr is drained so the child never blocks on it, and is never shown:
//   it can hold the file's own text.

import { spawn } from 'bun';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ExtractHint,
  type ExtractOutcome,
  LIMITS,
  type Limits,
  MIB,
  type Refusal,
  sizeText,
} from './types';
import { decodeOutcome, type WorkerRequest } from './wire';

export interface SandboxOptions {
  /** Wall-clock limit for one extraction. */
  readonly timeoutMs?: number | undefined;
  /** Resident memory limit of the child. */
  readonly memoryLimitBytes?: number | undefined;
  /** How often the child's memory is read. */
  readonly pollMs?: number | undefined;
  /** Limits passed to the child; the defaults are `LIMITS`. */
  readonly limits?: Partial<Limits> | undefined;
  /** The child's entry script; worker.ts unless a test names another. */
  readonly entry?: string | undefined;
}

export const SANDBOX_DEFAULTS = {
  timeoutMs: 60_000,
  memoryLimitBytes: 384 * MIB,
  pollMs: 25,
} as const;

const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));

/** Resident memory of a process from /proc, or undefined where it cannot be read. */
export function residentBytes(pid: number): number | undefined {
  let status: string;
  try {
    status = readFileSync(`/proc/${pid}/status`, 'utf8');
  } catch {
    return undefined;
  }
  const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
  return m ? Number(m[1]) * 1024 : undefined;
}

function failure(refusal: Refusal): ExtractOutcome {
  return { ok: false, refusal };
}

/** Reads a stream to its end, keeping at most `cap` bytes; calls `over` once past it. */
async function drain(
  stream: ReadableStream<Uint8Array>,
  cap: number,
  over: () => void
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let exceeded = false;
  for await (const chunk of stream) {
    if (kept + chunk.length > cap) {
      if (!exceeded) {
        exceeded = true;
        over();
      }
      continue;
    }
    chunks.push(chunk);
    kept += chunk.length;
  }
  const out = new Uint8Array(kept);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

type StopReason = 'timeout' | 'memory' | 'output';

/** Extracts a source's text in a child process. Never throws for content. */
export async function extractInSandbox(
  bytes: Uint8Array,
  hint: ExtractHint = {},
  options: SandboxOptions = {}
): Promise<ExtractOutcome> {
  const timeoutMs = options.timeoutMs ?? SANDBOX_DEFAULTS.timeoutMs;
  const memoryLimit =
    options.memoryLimitBytes ?? SANDBOX_DEFAULTS.memoryLimitBytes;
  const pollMs = options.pollMs ?? SANDBOX_DEFAULTS.pollMs;
  const limits = { ...LIMITS, ...options.limits };
  if (bytes.length > limits.maxBytes) {
    return failure({
      kind: 'too_large',
      reason: `The file is ${sizeText(bytes.length)}, over the ${sizeText(limits.maxBytes)} read.`,
    });
  }

  const entry = options.entry ?? WORKER;
  const request: WorkerRequest = {
    hint: { name: hint.name, contentType: hint.contentType },
    limits: options.limits ?? {},
  };
  const child = spawn({
    cmd: [
      process.execPath,
      '--smol',
      '--no-env-file',
      '--no-install',
      entry,
      JSON.stringify(request),
    ],
    cwd: dirname(entry),
    env: { TZ: 'UTC', NO_COLOR: '1' },
    stdin: new Blob([bytes]),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let stopped: StopReason | undefined;
  const stop = (reason: StopReason): void => {
    if (stopped !== undefined) return;
    stopped = reason;
    child.kill('SIGKILL');
  };
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  const poll = setInterval(() => {
    const rss = residentBytes(child.pid);
    if (rss !== undefined && rss > memoryLimit) stop('memory');
  }, pollMs);

  try {
    const [stdout] = await Promise.all([
      drain(child.stdout, 4 * bytes.length + 16 * MIB, () => stop('output')),
      drain(child.stderr, 16 * 1024, () => undefined),
      child.exited,
    ]);
    if (stopped === 'timeout') {
      return failure({
        kind: 'timeout',
        reason: `Reading the file took longer than ${Math.round(timeoutMs / 1000)} seconds, so it was stopped.`,
      });
    }
    if (stopped === 'memory') {
      return failure({
        kind: 'memory',
        reason: `Reading the file needed more than ${Math.round(memoryLimit / MIB)} MiB of memory, so it was stopped.`,
      });
    }
    if (stopped === 'output') {
      return failure({
        kind: 'bad_output',
        reason: 'The reader answered with far more text than the file holds.',
      });
    }
    if (child.exitCode !== 0) {
      const how = child.signalCode
        ? `signal ${child.signalCode}`
        : `exit code ${child.exitCode}`;
      return failure({
        kind: 'crashed',
        reason: `The reader stopped without an answer (${how}).`,
      });
    }
    const outcome = decodeOutcome(new TextDecoder().decode(stdout));
    return (
      outcome ??
      failure({
        kind: 'bad_output',
        reason: 'The reader answered with something that is not a result.',
      })
    );
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
  }
}
