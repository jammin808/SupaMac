// A child that floods stdout far past anything the input could explain.
import { sleep } from 'bun';
const chunk = 'x'.repeat(1024 * 1024);
for (let i = 0; i < 64; i++) process.stdout.write(chunk);
await sleep(10_000);
