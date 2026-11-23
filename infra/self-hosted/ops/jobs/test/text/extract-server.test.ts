// The extraction container's server and the service's client of it, over a
// real socket on 127.0.0.1: the bytes go out, a child parses them, and the
// answer is validated on the service's side again.

import { sleep } from 'bun';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '../../src/log';
import { PipelineError } from '../../src/pipeline/context';
import { extract } from '../../src/text/extract';
import {
  type ExtractServer,
  parentOf,
  refusedSettings,
  startExtractServer,
  sweepStrays,
} from '../../src/text/extract-server';
import { remoteExtractor } from '../../src/text/remote';
import type { ExtractOutcome } from '../../src/text/types';
import { REQUEST_HEADER } from '../../src/text/wire';
import { docx, p, tbl } from './build';

const servers: ExtractServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function serve(
  options: Parameters<typeof startExtractServer>[0] = {}
): ExtractServer {
  const server = startExtractServer({
    port: 0,
    hostname: '127.0.0.1',
    logger: new Logger({ sink: () => undefined }),
    ...options,
  });
  servers.push(server);
  return server;
}

const base = (server: ExtractServer): string =>
  `http://127.0.0.1:${server.port}`;

describe('the extraction server and its client', () => {
  test('a file sent over the socket is parsed in a child exactly as in this process', async () => {
    const server = serve();
    const bytes = docx(p('Venue: Acme Arena') + tbl([['Crew call', '07:00']]));
    const remote = remoteExtractor(base(server));
    const outcome = await remote(bytes, { name: 'pack.docx' });
    expect(outcome).toEqual(await extract(bytes, { name: 'pack.docx' }));
  });

  test('runs one extraction at a time and the sweep after each', async () => {
    let running = 0;
    let most = 0;
    const order: string[] = [];
    const server = serve({
      extract: async (_bytes, hint): Promise<ExtractOutcome> => {
        running++;
        most = Math.max(most, running);
        await sleep(30);
        running--;
        order.push(`read ${hint.name}`);
        return {
          ok: false,
          refusal: { kind: 'unsupported_type', reason: 'no' },
        };
      },
      after: () => order.push('swept'),
    });
    const remote = remoteExtractor(base(server));
    await Promise.all([
      remote(new Uint8Array([1]), { name: 'a.txt' }),
      remote(new Uint8Array([2]), { name: 'b.txt' }),
    ]);
    expect(most).toBe(1);
    expect(order).toEqual(['read a.txt', 'swept', 'read b.txt', 'swept']);
  });

  test('answers /health, refuses a request that does not validate, and nothing else', async () => {
    let called = 0;
    const server = serve({
      extract: async () => {
        called++;
        return {
          ok: false,
          refusal: { kind: 'unsupported_type', reason: 'no' },
        };
      },
    });
    expect((await fetch(`${base(server)}/health`)).status).toBe(200);
    expect((await fetch(`${base(server)}/other`)).status).toBe(404);
    expect((await fetch(`${base(server)}/extract`)).status).toBe(404);
    const missing = await fetch(`${base(server)}/extract`, {
      method: 'POST',
      body: new Uint8Array([1]),
    });
    expect(missing.status).toBe(400);
    const garbled = await fetch(`${base(server)}/extract`, {
      method: 'POST',
      headers: {
        [REQUEST_HEADER]: Buffer.from('{"hint":3}').toString('base64'),
      },
      body: new Uint8Array([1]),
    });
    expect(garbled.status).toBe(400);
    expect(called).toBe(0);
  });

  test('the container not answering, or answering an error, is retryable; an answer that does not validate is the file’s failure', async () => {
    const closed = serve();
    const url = base(closed);
    await closed.stop();
    servers.splice(servers.indexOf(closed), 1);
    const down = await remoteExtractor(url)(new Uint8Array([1]), {}).catch(
      (e: unknown) => e
    );
    expect(down).toBeInstanceOf(PipelineError);
    expect((down as PipelineError).kind).toBe('retryable');

    const failing = await remoteExtractor('http://jobs-extract.example.com', {
      fetch: async () => new Response('busy', { status: 503 }),
    })(new Uint8Array([1]), {}).catch((e: unknown) => e);
    expect(failing).toBeInstanceOf(PipelineError);
    expect((failing as PipelineError).message).toBe(
      'the extraction container answered 503'
    );

    const lying = await remoteExtractor('http://jobs-extract.example.com', {
      fetch: async () =>
        Response.json({ ok: true, value: { type: 'exe', text: 'all of it' } }),
    })(new Uint8Array([1]), {});
    expect(lying).toEqual({
      ok: false,
      refusal: {
        kind: 'bad_output',
        reason: 'The reader answered with something that is not a result.',
      },
    });
  });

  test('a file over the read limit is refused before anything is sent', async () => {
    let sent = 0;
    const remote = remoteExtractor('http://jobs-extract.example.com', {
      fetch: async () => {
        sent++;
        return new Response('', { status: 500 });
      },
    });
    const outcome = await remote(new Uint8Array(64 * 1024 * 1024 + 1), {});
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.refusal.kind).toBe('too_large');
    expect(sent).toBe(0);
  });
});

describe('what the extraction container holds', () => {
  test('refuses to start with anything that could be a secret in its environment', () => {
    expect(
      refusedSettings({
        PATH: '/usr/local/bin',
        HOME: '/nonexistent',
        TZ: 'UTC',
        JOBS_EXTRACT_PORT: '8090',
        JOBS_EXTRACT_SWEEP: 'on',
      })
    ).toEqual([]);
    expect(
      refusedSettings({
        JOBS_SUPAMAC_API_KEY: 'x',
        ANTHROPIC_API_KEY: 'x',
        JOBS_TELEGRAM_BOT_TOKEN: 'x',
        JOBS_MAIL_PASSWORD: 'x',
        JOBS_OWNER_EMAIL: 'x',
        DATABASE_URL: 'x',
        SOME_VENDOR_SECRET: 'x',
        PATH: '/usr/bin',
      })
    ).toEqual([
      'ANTHROPIC_API_KEY',
      'DATABASE_URL',
      'JOBS_MAIL_PASSWORD',
      'JOBS_OWNER_EMAIL',
      'JOBS_SUPAMAC_API_KEY',
      'JOBS_TELEGRAM_BOT_TOKEN',
      'SOME_VENDOR_SECRET',
    ]);
  });

  test('the sweep kills every process but itself, PID 1 and what docker exec started', () => {
    const root = mkdtempSync(join(tmpdir(), 'jobs-proc-'));
    dirs.push(root);
    const proc = (pid: number, comm: string, ppid: number): void => {
      mkdirSync(join(root, String(pid)));
      writeFileSync(
        join(root, String(pid), 'stat'),
        `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560`
      );
    };
    proc(1, 'docker-init', 0);
    proc(7, 'bun', 1);
    proc(40, 'bun', 7);
    proc(41, 'a (tricky) name', 1);
    proc(55, 'bun', 0);
    mkdirSync(join(root, 'self'));
    const killed: number[] = [];
    const swept = sweepStrays({
      procRoot: root,
      self: 7,
      kill: (pid) => {
        killed.push(pid);
      },
    });
    expect(swept.sort((a, b) => a - b)).toEqual([40, 41]);
    expect(killed.sort((a, b) => a - b)).toEqual([40, 41]);
    expect(parentOf('41 (a (tricky) name) S 1 41 41')).toBe(1);
  });
});
