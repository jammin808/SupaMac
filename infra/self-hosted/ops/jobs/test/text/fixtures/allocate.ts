// A child that takes memory until it is killed.
import { sleep } from 'bun';
const held: Uint8Array[] = [];
for (;;) {
  const block = new Uint8Array(16 * 1024 * 1024);
  block.fill(1);
  held.push(block);
  await sleep(5);
}
