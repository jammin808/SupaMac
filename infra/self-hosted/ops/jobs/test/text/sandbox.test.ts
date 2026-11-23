import { sleep } from 'bun';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract } from '../../src/text/extract';
import { extractInSandbox } from '../../src/text/sandbox';
import { docx, mime, p, pdf, tbl, textOps } from './build';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url));

describe('extractInSandbox', () => {
  test('extracts in a child process exactly what extraction gives in this one', async () => {
    const bytes = docx(p('Venue: Acme Arena') + tbl([['Crew call', '07:00']]));
    const inChild = await extractInSandbox(bytes, { name: 'pack.docx' });
    expect(inChild).toEqual(await extract(bytes, { name: 'pack.docx' }));
    expect(inChild.ok && inChild.value.text.pages[0]?.lines).toEqual([
      'Venue: Acme Arena',
      'Crew call: 07:00',
    ]);
  });

  test('reads a PDF in the child, with PDF.js warnings kept off the answer', async () => {
    const bytes = pdf([
      textOps([
        {
          x: 72,
          y: 760,
          text: 'Crew call 07:00 at the stage door of Acme Arena',
        },
      ]),
    ]);
    const outcome = await extractInSandbox(bytes, { name: 'call-sheet.pdf' });
    expect(outcome.ok && outcome.value.text.pages).toEqual([
      {
        page: 1,
        kind: 'text',
        lines: ['Crew call 07:00 at the stage door of Acme Arena'],
      },
    ]);
  });

  test("brings an email's attachment bytes back intact", async () => {
    const pdfBytes = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00, 0xff, 0x80,
    ]);
    const bytes = mime([
      'From: Sam Price <sam@example.com>',
      'Subject: PO',
      'Date: Thu, 4 Mar 2027 09:00:00 +0000',
      'Content-Type: multipart/mixed; boundary="m"',
      '',
      '--m',
      'Content-Type: text/plain',
      '',
      'PO attached',
      '--m',
      'Content-Type: application/pdf',
      'Content-Disposition: attachment; filename="PO.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(pdfBytes).toString('base64'),
      '--m--',
    ]);
    const outcome = await extractInSandbox(bytes);
    expect(outcome.ok && outcome.value.email?.attachments[0]?.bytes).toEqual(
      pdfBytes
    );
  });

  test('gives the child no environment, a working directory beside its script, and the bytes on stdin', async () => {
    process.env.JOBS_TEST_SECRET = 'sk-ant-not-a-real-key';
    const entry = fixture('environment');
    const outcome = await extractInSandbox(
      new Uint8Array(1234),
      { name: 'a.txt' },
      { entry }
    );
    delete process.env.JOBS_TEST_SECRET;
    if (!outcome.ok) throw new Error(outcome.refusal.reason);
    const [names, cwd, length, request] =
      outcome.value.text.pages[0]?.lines ?? [];
    expect(names?.split(',')).not.toContain('JOBS_TEST_SECRET');
    expect(
      names
        ?.split(',')
        .every(
          (n) =>
            ['NO_COLOR', 'TZ'].includes(n) || n.startsWith('BUN_') || n === '_'
        )
    ).toBe(true);
    expect(cwd).toBe(dirname(entry));
    expect(length).toBe('1234');
    expect(JSON.parse(request ?? '{}')).toEqual({
      hint: { name: 'a.txt' },
      limits: {},
    });
  });

  test('stops a child that runs past its time', async () => {
    const started = performance.now();
    const outcome = await extractInSandbox(
      new Uint8Array(10),
      {},
      { entry: fixture('hang'), timeoutMs: 500 }
    );
    expect(!outcome.ok && outcome.refusal.kind).toBe('timeout');
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test('stops a child that goes over its memory limit', async () => {
    const outcome = await extractInSandbox(
      new Uint8Array(10),
      {},
      {
        entry: fixture('allocate'),
        memoryLimitBytes: 160 * 1024 * 1024,
        timeoutMs: 20_000,
      }
    );
    expect(!outcome.ok && outcome.refusal).toMatchObject({ kind: 'memory' });
    expect(!outcome.ok && outcome.refusal.reason).toContain('160 MiB');
  });

  test('a crash, a flood of output or an answer that does not validate is a typed failure', async () => {
    const crash = await extractInSandbox(
      new Uint8Array(10),
      {},
      { entry: fixture('crash') }
    );
    expect(!crash.ok && crash.refusal).toEqual({
      kind: 'crashed',
      reason: 'The reader stopped without an answer (exit code 3).',
    });

    const flood = await extractInSandbox(
      new Uint8Array(10),
      {},
      { entry: fixture('flood') }
    );
    expect(!flood.ok && flood.refusal.kind).toBe('bad_output');

    const garbage = await extractInSandbox(
      new Uint8Array(10),
      {},
      { entry: fixture('garbage') }
    );
    expect(!garbage.ok && garbage.refusal.kind).toBe('bad_output');
  });

  test('refuses an oversized file without starting a child', async () => {
    const outcome = await extractInSandbox(
      new Uint8Array(2048),
      {},
      { limits: { maxBytes: 1024 }, entry: fixture('crash') }
    );
    expect(!outcome.ok && outcome.refusal.kind).toBe('too_large');
  });

  test('kills what the child started and left behind: its whole process group goes with it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-sandbox-'));
    try {
      const pidFile = join(dir, 'left.pid');
      const outcome = await extractInSandbox(
        new TextEncoder().encode(pidFile),
        { name: 'notes.txt' },
        { entry: fixture('leave-behind') }
      );
      expect(outcome.ok).toBe(false);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(pid).toBeGreaterThan(0);
      const running = (): boolean => {
        const stat = `/proc/${pid}/stat`;
        if (!existsSync(stat)) return false;
        const state = readFileSync(stat, 'utf8')
          .slice(readFileSync(stat, 'utf8').lastIndexOf(')') + 2)
          .charAt(0);
        return state !== 'Z' && state !== 'X';
      };
      const end = Date.now() + 3000;
      while (running() && Date.now() < end) await sleep(20);
      expect(running()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
