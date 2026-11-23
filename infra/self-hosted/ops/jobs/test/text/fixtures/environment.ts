// A child that reports what it was given: its environment's names, its
// working directory and its bytes, as one text line each.
import { stdin, stdout, write } from 'bun';
const bytes = await stdin.bytes();
const outcome = {
  ok: true,
  value: {
    type: 'txt',
    mediaType: 'text/plain',
    text: {
      paged: false,
      pages: [
        {
          page: 1,
          kind: 'text',
          lines: [
            Object.keys(process.env).sort().join(','),
            process.cwd(),
            String(bytes.length),
            process.argv[2] ?? '',
          ],
        },
      ],
    },
    notes: [],
  },
};
await write(stdout, JSON.stringify(outcome));
process.exit(0);
