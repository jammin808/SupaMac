import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, which } from 'bun';
import { sealProcess } from '../src/seal';

const SERVICE = fileURLToPath(new URL('./seal/service.ts', import.meta.url));
const SECRET = 'JOBS_TEST_SECRET=sk-ant-not-a-real-key';
const CAP_SYS_PTRACE = 19n;

/**
 * The prefix that runs a command as the jobs container runs the service:
 * without CAP_SYS_PTRACE, which reads any process's environment. A test
 * process that holds it (root outside a container) drops every capability
 * through setpriv; one that does not (an unprivileged user, a container
 * build) runs the command as it is.
 */
function withoutPtrace(): string[] {
  const status = readFileSync('/proc/self/status', 'utf8');
  const effective = BigInt(`0x${/^CapEff:\s+([0-9a-f]+)/m.exec(status)?.[1]}`);
  if ((effective & (1n << CAP_SYS_PTRACE)) === 0n) return [];
  const setpriv = which('setpriv');
  if (setpriv === null)
    throw new Error(
      'this process holds CAP_SYS_PTRACE and setpriv is not installed to drop it'
    );
  return [
    setpriv,
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--bounding-set=-all',
    '--no-new-privs',
  ];
}

async function runService(
  mode: 'seal' | 'plain'
): Promise<{ sealed: string; lines: unknown }> {
  const [name, value] = SECRET.split('=') as [string, string];
  const child = spawn({
    cmd: [...withoutPtrace(), process.execPath, SERVICE, mode],
    env: { [name]: value, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (child.exitCode !== 0) throw new Error(`the service failed: ${err}`);
  return JSON.parse(out);
}

describe('sealProcess', () => {
  test('an extraction child of a sealed service reads neither its environment nor its memory', async () => {
    expect(await runService('seal')).toEqual({
      sealed: 'sealed',
      lines: ['error EACCES', 'error EACCES'],
    });
  });

  test('without the seal the same child reads the secret, so the test can see a leak', async () => {
    expect(await runService('plain')).toEqual({
      sealed: 'not asked',
      lines: [SECRET, 'opened'],
    });
  });

  test('does nothing off Linux, and says so', () => {
    expect(sealProcess('darwin')).toBe('not_linux');
  });
});
