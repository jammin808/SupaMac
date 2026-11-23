// A child that starts a process of its own, writes that process's id to the
// file its stdin names, and exits without an answer, leaving it running.
import { spawn, stdin } from 'bun';
import { writeFileSync } from 'node:fs';

const path = new TextDecoder().decode(await stdin.bytes());
const left = spawn({
  cmd: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore',
});
left.unref();
writeFileSync(path, String(left.pid));
process.exit(3);
