// The jobs containers' reach. The jobs service has a gateway of its own,
// which repeats the main gateway's deny rules word for word and serves one
// site, :8081; nothing on the `jobs` network listens on anything else but
// the egress proxy, and the extraction container shares a network with the
// jobs service alone, with no secret and no volume.

import { existsSync } from 'node:fs';
import { file, YAML } from 'bun';
import { expect, test } from 'bun:test';

const mainPath = new URL('../config/gateway/Caddyfile', import.meta.url);
const jobsPath = new URL('../config/jobs-gateway/Caddyfile', import.meta.url);
// The checkout, where compose.yaml sits beside ops/. The ops image holds
// only this directory's config, scripts and programs.
const composePath = new URL('../../compose.yaml', import.meta.url);
const inCheckout = existsSync(composePath);

/** A snippet's body, `(name) { ... }`, by brace depth. */
function snippet(text: string, name: string): string {
  const start = text.indexOf(`(${name}) {`);
  if (start < 0) throw new Error(`no snippet ${name}`);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`snippet ${name} does not close`);
}

/** The site addresses: top-level blocks that are not the options or a snippet. */
function sites(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const line of text.split('\n')) {
    const bare = line.replace(/#.*$/, '').trim();
    if (
      depth === 0 &&
      bare.endsWith('{') &&
      bare !== '{' &&
      !bare.startsWith('(')
    )
      out.push(bare.slice(0, -1).trim());
    depth +=
      (bare.match(/\{/g) ?? []).length - (bare.match(/\}/g) ?? []).length;
  }
  return out;
}

test('the jobs gateway repeats the main gateway’s deny rules and object handling word for word', async () => {
  const main = await file(mainPath).text();
  const jobs = await file(jobsPath).text();
  for (const name of ['deny', 'service', 'object_headers', 'objects'])
    expect(snippet(jobs, name)).toBe(snippet(main, name));
});

test('the jobs gateway serves :8081 alone, with the storage API and object reads, and trusts no forwarded address', async () => {
  const jobs = (await file(jobsPath).text())
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
  expect(sites(jobs)).toEqual([':8081']);
  expect(jobs).not.toContain('trusted_proxies');
  for (const route of [
    '/unfurl',
    '/image-proxy',
    '/auth',
    'handle_path /contacts',
  ])
    expect(jobs).not.toContain(route);
  expect(jobs).toContain('handle_path /dss/*');
  const main = await file(mainPath).text();
  expect(sites(main)).toEqual([':8080']);
});

test.skipIf(!inCheckout)(
  'compose: the jobs networks hold only the jobs containers, and the extraction container nothing to take',
  async () => {
    const compose = YAML.parse(await file(composePath).text()) as {
      services: Record<
        string,
        {
          networks?: string[] | Record<string, unknown>;
          env_file?: unknown;
          volumes?: unknown;
          environment?: Record<string, string>;
        }
      >;
    };
    const on = (network: string): string[] =>
      Object.entries(compose.services)
        .filter(([, s]) =>
          (Array.isArray(s.networks)
            ? s.networks
            : Object.keys(s.networks ?? {})
          ).includes(network)
        )
        .map(([name]) => name)
        .sort();
    expect(on('jobs')).toEqual(['jobs', 'jobs-egress', 'jobs-gateway']);
    expect(on('jobs-extract')).toEqual(['jobs', 'jobs-extract']);
    const extract = compose.services['jobs-extract'];
    expect(extract?.env_file).toBeUndefined();
    expect(extract?.volumes).toBeUndefined();
    expect(Object.keys(extract?.environment ?? {}).sort()).toEqual([
      'BUN_RUNTIME_TRANSPILER_CACHE_PATH',
      'JOBS_EXTRACT_PORT',
      'JOBS_EXTRACT_SWEEP',
    ]);
    const jobs = compose.services.jobs;
    expect(jobs?.environment?.JOBS_SUPAMAC_URL).toBe(
      'http://jobs-gateway:8081/dss'
    );
    expect(jobs?.environment?.JOBS_EXTRACT_URL).toBe(
      'http://jobs-extract:8090'
    );
  }
);
