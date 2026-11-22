// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { build, type Plugin, type Rolldown } from 'vite';
import { afterEach, expect, it, vi } from 'vitest';

const root = fileURLToPath(new URL('../../../..', import.meta.url));

/** Modules whose hosted-only code a self-hosted bundle leaves out. */
const GATED_MODULES = [
  'src/lib/core/constant/servers.ts',
  'src/lib/core/util/webOrigin.ts',
  'src/lib/core/util/macroAppUrl.ts',
  'src/lib/core/context/user-info-gate.ts',
  'src/lib/core/component/AI/component/mcpConstants.ts',
  'src/lib/constants/docs-links.ts',
  'src/lib/analytics/analytics.ts',
];

const ENTRY = '\0gated-modules';

/** An entry that keeps every export of the gated modules. */
function gatedModulesEntry(): Plugin {
  return {
    name: 'gated-modules-entry',
    resolveId: (id) => (id === ENTRY ? ENTRY : null),
    load: (id) =>
      id === ENTRY
        ? GATED_MODULES.map(
            (module, index) =>
              `export * as m${index} from ${JSON.stringify(`${root}${module}`)};`
          ).join('\n')
        : null,
  };
}

/** The minified code of the gated modules, built with the app's config. */
async function buildGatedModules(): Promise<string> {
  vi.resetModules();
  const { createAppViteConfig } = await import('../../../../vite.base');
  const config = await createAppViteConfig()({
    command: 'build',
    mode: 'production',
  });
  const output = config.build?.rolldownOptions?.output;
  if (!output || Array.isArray(output)) throw new Error('unexpected output');
  const result = (await build({
    ...config,
    configFile: false,
    root,
    publicDir: false,
    logLevel: 'silent',
    plugins: [...(config.plugins ?? []), gatedModulesEntry()],
    build: {
      ...config.build,
      write: false,
      rolldownOptions: {
        input: ENTRY,
        preserveEntrySignatures: 'strict',
        // The app's startup chunking is keyed to its HTML entries.
        output: { ...output, codeSplitting: undefined },
      },
    },
  })) as Rolldown.RolldownOutput;
  return result.output
    .filter((file) => file.type === 'chunk')
    .map((file) => file.code)
    .join('\n');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// The bundler drops a hosted branch only where it can read SELF_HOSTED as a
// constant; a gate it cannot fold ships the hosted strings as dead code.
it('builds a self-hosted bundle that names no host of the hosted service', async () => {
  vi.stubEnv('VITE_BACKEND_ORIGIN', 'https://api.example.org');
  const code = await buildGatedModules();

  expect(code).toContain('https://api.example.org');
  expect(code).not.toContain('macro.com');
  expect(code).not.toContain('macroverse.workers.dev');
  // The hosted service's analytics accounts.
  expect(code).not.toContain('G-52HPEL3FTV');
  expect(code).not.toContain('639142540393286');
}, 180_000);

it('keeps the hosted service in every other bundle', async () => {
  vi.stubEnv('VITE_BACKEND_ORIGIN', undefined);
  const code = await buildGatedModules();

  expect(code).toContain('https://gateway.macro.com');
  expect(code).toContain('https://mcp-server.macro.com/mcp');
}, 180_000);
