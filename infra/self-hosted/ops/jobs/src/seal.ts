// Keeps the service's environment and memory out of reach of its own
// children (docs/supamac/jobs.md, Security: Hostile files).
//
// Invariants:
// - On Linux, `sealProcess` marks the process not dumpable (prctl
//   PR_SET_DUMPABLE 0) and confirms it with PR_GET_DUMPABLE. A process of
//   the same uid without CAP_SYS_PTRACE, which the extraction child is in
//   the jobs container, can then read neither /proc/<service>/environ,
//   which holds every jobs.env secret, nor the service's memory or open
//   files. The flag is the process's own and an exec clears it, so the
//   child is dumpable and the sandbox still reads its resident memory.
// - On Linux a seal that fails throws a `SealError`: the service never
//   parses a file while its secrets are readable by the parser. Elsewhere
//   it does nothing and says so; there is no /proc to read them from.

import { dlopen, FFIType } from 'bun:ffi';

const PR_GET_DUMPABLE = 3;
const PR_SET_DUMPABLE = 4;

export type SealResult = 'sealed' | 'not_linux';

export type SealErrorKind = 'unavailable' | 'refused';

export class SealError extends Error {
  readonly kind: SealErrorKind;
  constructor(kind: SealErrorKind, message: string) {
    super(message);
    this.name = 'SealError';
    this.kind = kind;
  }
}

/** Makes this process not dumpable; see the header. */
export function sealProcess(
  platform: NodeJS.Platform = process.platform
): SealResult {
  if (platform !== 'linux') return 'not_linux';
  let libc: ReturnType<typeof openLibc>;
  try {
    libc = openLibc();
  } catch (error) {
    throw new SealError(
      'unavailable',
      `the C library could not be loaded to make the process not dumpable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    const set = libc.symbols.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
    const dumpable = libc.symbols.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);
    if (set !== 0 || dumpable !== 0) {
      throw new SealError(
        'refused',
        `the process could not be made not dumpable (prctl answered ${set}, dumpable is ${dumpable})`
      );
    }
  } finally {
    libc.close();
  }
  return 'sealed';
}

function openLibc() {
  return dlopen('libc.so.6', {
    prctl: {
      args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
  });
}
