// A stand-in for the service: seals itself when its argument says `seal`,
// then runs one extraction with peek-parent.ts as the child, and prints the
// child's lines as JSON.
import { sealProcess } from '../../src/seal';
import { extractInSandbox } from '../../src/text/sandbox';

const sealed = process.argv[2] === 'seal' ? sealProcess() : 'not asked';
const outcome = await extractInSandbox(
  new Uint8Array(10),
  { name: 'a.txt' },
  { entry: new URL('./peek-parent.ts', import.meta.url).pathname }
);
console.log(
  JSON.stringify({
    sealed,
    lines: outcome.ok ? outcome.value.text.pages[0]?.lines : outcome.refusal,
  })
);
