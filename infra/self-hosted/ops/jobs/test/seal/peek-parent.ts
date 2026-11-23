// An extraction child that tries to read its parent, the service, through
// /proc: its environment and its memory. It answers one line for each, the
// environment's JOBS_TEST_ names or the error's code.
import { openSync, readFileSync } from 'node:fs';
import { stdout, write } from 'bun';

function attempt(read: () => string): string {
  try {
    return read();
  } catch (error) {
    return `error ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`;
  }
}

const parent = `/proc/${process.ppid}`;
const environ = attempt(() =>
  readFileSync(`${parent}/environ`, 'latin1')
    .split('\0')
    .filter((entry) => entry.startsWith('JOBS_TEST_'))
    .join(',')
);
const memory = attempt(() => {
  openSync(`${parent}/mem`, 'r');
  return 'opened';
});
const outcome = {
  ok: true,
  value: {
    type: 'txt',
    mediaType: 'text/plain',
    text: {
      paged: false,
      pages: [{ page: 1, kind: 'text', lines: [environ, memory] }],
    },
    notes: [],
  },
};
await write(stdout, JSON.stringify(outcome));
process.exit(0);
