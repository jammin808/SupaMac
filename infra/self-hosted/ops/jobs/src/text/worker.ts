// The extraction child process that sandbox.ts starts: the source's bytes on
// stdin, the request (hint and limits) as JSON in argv[2], one JSON outcome
// on stdout (wire.ts), then exit 0.
//
// Invariants:
// - stdout carries the outcome and nothing else: every console method writes
//   to stderr, so a library's warning cannot corrupt the answer.
// - A request that does not validate exits 2 without reading anything.

import { stdin, stdout, write } from 'bun';
import { extract } from './extract';
import {
  encodeOutcome,
  requestLimits,
  type WorkerRequest,
  WorkerRequestSchema,
} from './wire';

const toStderr = (...args: unknown[]): void => {
  console.error(...args);
};
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;

function readRequest(): WorkerRequest | undefined {
  try {
    const parsed = WorkerRequestSchema.safeParse(
      JSON.parse(process.argv[2] ?? 'null')
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const request = readRequest();
if (!request) {
  console.error('the extraction request is not valid');
  process.exit(2);
}

const bytes = await stdin.bytes();
const outcome = await extract(bytes, request.hint, requestLimits(request));
await write(stdout, encodeOutcome(outcome));
process.exit(0);
