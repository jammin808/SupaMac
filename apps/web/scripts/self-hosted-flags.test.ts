import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SELF_HOSTED_FLAGS,
  SELF_HOSTED_FLAGS_WITHOUT_SWITCH,
  selfHostedFlagDefines,
} from '../self-hosted-flags';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const FLAGS_FILE = 'src/lib/core/constant/featureFlags.ts';

/** What featureFlags.ts defines, read from its source. */
function definedFlags() {
  const source = ts.createSourceFile(
    FLAGS_FILE,
    readFileSync(join(webRoot, FLAGS_FILE), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  /** `env` names: of `defineFlag`, and of a bare `getFeatureFlagOverride`. */
  const envNames: string[] = [];
  /** PostHog keys of the remote flags that have no `env`. */
  const keysWithoutEnv: string[] = [];
  /** Definitions whose `env` or `key` is not a string literal. */
  const unreadable: string[] = [];

  const visit = (node: ts.Node) => {
    node.forEachChild(visit);
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    const callee = node.expression.text;
    const [argument] = node.arguments;
    if (!argument) return;

    if (
      callee === 'getFeatureFlagOverride' ||
      callee === 'resolveFeatureFlag'
    ) {
      // The registry's own helpers pass the name through as a variable.
      if (ts.isStringLiteralLike(argument)) envNames.push(argument.text);
      return;
    }
    if (callee !== 'defineFlag') return;

    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    if (!ts.isObjectLiteralExpression(argument)) {
      unreadable.push(`line ${line}`);
      return;
    }
    const names: { env?: string; key?: string } = {};
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property)) {
        unreadable.push(`line ${line}`);
        continue;
      }
      const name = property.name.getText(source);
      if (name !== 'env' && name !== 'key') continue;
      if (!ts.isStringLiteralLike(property.initializer)) {
        unreadable.push(`line ${line}`);
        continue;
      }
      names[name] = property.initializer.text;
    }
    if (names.env) envNames.push(names.env);
    else if (names.key) keysWithoutEnv.push(names.key);
    else unreadable.push(`line ${line}`);
  };
  visit(source);

  return { envNames, keysWithoutEnv, unreadable };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === 'generated'
        ? []
        : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

describe('the self-hosted flag set', () => {
  const defined = definedFlags();

  it('reads every flag definition', () => {
    // A name this test cannot read is a flag it cannot hold to a decision:
    // write `env` and `key` as string literals.
    expect(defined.unreadable).toEqual([]);
    expect(defined.envNames.length).toBeGreaterThan(100);
  });

  it('decides every flag that featureFlags.ts defines', () => {
    // A self-hosted bundle has no PostHog project, so a flag missing here is
    // silently off there. Add it to SELF_HOSTED_FLAGS in self-hosted-flags.ts
    // with its value and reason.
    const undecided = defined.envNames.filter(
      (name) => !(name in SELF_HOSTED_FLAGS)
    );
    expect(undecided).toEqual([]);
  });

  it('lists every remote flag that no build can switch', () => {
    // Without an `env` the flag is off in a self-hosted bundle. Either give
    // it one in featureFlags.ts and decide it in SELF_HOSTED_FLAGS, or say
    // why it stays off in SELF_HOSTED_FLAGS_WITHOUT_SWITCH.
    const unlisted = defined.keysWithoutEnv.filter(
      (key) => !(key in SELF_HOSTED_FLAGS_WITHOUT_SWITCH)
    );
    expect(unlisted).toEqual([]);
  });

  it('holds no decision for a flag that is gone', () => {
    expect(
      Object.keys(SELF_HOSTED_FLAGS).filter(
        (name) => !defined.envNames.includes(name)
      )
    ).toEqual([]);
    expect(
      Object.keys(SELF_HOSTED_FLAGS_WITHOUT_SWITCH).filter(
        (key) => !defined.keysWithoutEnv.includes(key)
      )
    ).toEqual([]);
  });

  it('gives each decision a value and a one-line reason', () => {
    for (const [name, decision] of Object.entries(SELF_HOSTED_FLAGS)) {
      expect(decision, name).toHaveLength(2);
      expect(typeof decision[0], name).toBe('boolean');
      expect(decision[1], name).toMatch(/^\S[^\n]*\.$/);
    }
    for (const [key, reason] of Object.entries(
      SELF_HOSTED_FLAGS_WITHOUT_SWITCH
    )) {
      expect(reason, key).toMatch(/^\S[^\n]*\.$/);
    }
  });

  it('finds every definition in the one registry', () => {
    // A flag defined elsewhere would escape the checks above.
    const elsewhere = sourceFiles(join(webRoot, 'src'))
      .filter((path) => /\bdefineFlag\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(webRoot, path));
    expect(elsewhere).toEqual([FLAGS_FILE]);
  });
});

describe('selfHostedFlagDefines', () => {
  it('hands the bundle every decision as the string the app reads', () => {
    const defines = selfHostedFlagDefines({});

    expect(Object.keys(defines)).toHaveLength(
      Object.keys(SELF_HOSTED_FLAGS).length
    );
    expect(defines['import.meta.env.VITE_ENABLE_GOOGLE_SIGN_IN']).toBe(
      '"false"'
    );
    expect(defines['import.meta.env.VITE_ENABLE_CRM_LISTS']).toBe('"true"');
  });

  it('leaves a flag the build environment sets to that environment', () => {
    const defines = selfHostedFlagDefines({
      VITE_ENABLE_GOOGLE_SIGN_IN: 'true',
      VITE_ENABLE_CRM_LISTS: 'false',
    });

    expect(defines).not.toHaveProperty([
      'import.meta.env.VITE_ENABLE_GOOGLE_SIGN_IN',
    ]);
    expect(defines).not.toHaveProperty([
      'import.meta.env.VITE_ENABLE_CRM_LISTS',
    ]);
    expect(defines['import.meta.env.VITE_ENABLE_CALLS']).toBe('"false"');
  });

  it('treats an empty variable as unset', () => {
    const defines = selfHostedFlagDefines({ VITE_ENABLE_CRM_LISTS: '' });

    expect(defines['import.meta.env.VITE_ENABLE_CRM_LISTS']).toBe('"true"');
  });
});

describe('the build', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** The `define` map of a production build made in the stubbed environment. */
  async function buildDefines(): Promise<Record<string, unknown>> {
    // vite.base.ts reads VITE_BACKEND_ORIGIN as it loads.
    vi.resetModules();
    const { createAppViteConfig } = await import('../vite.base');
    const config = await createAppViteConfig()({
      command: 'build',
      mode: 'production',
    });
    return config.define ?? {};
  }

  const flagDefines = (defines: Record<string, unknown>) =>
    Object.keys(defines).filter((key) =>
      Object.keys(SELF_HOSTED_FLAGS).some(
        (name) => key === `import.meta.env.VITE_${name}`
      )
    );

  it('gives a self-hosted bundle the checked-in set', async () => {
    vi.stubEnv('VITE_BACKEND_ORIGIN', 'https://api.example.com');
    vi.stubEnv('VITE_ENABLE_GOOGLE_SIGN_IN', '');
    const defines = await buildDefines();

    expect(flagDefines(defines).sort()).toEqual(
      Object.keys(selfHostedFlagDefines(process.env)).sort()
    );
    expect(defines['import.meta.env.VITE_ENABLE_GOOGLE_SIGN_IN']).toBe(
      '"false"'
    );
  });

  it('lets the build environment turn a flag of that bundle on', async () => {
    vi.stubEnv('VITE_BACKEND_ORIGIN', 'https://api.example.com');
    vi.stubEnv('VITE_ENABLE_GOOGLE_SIGN_IN', 'true');
    const defines = await buildDefines();

    expect(defines).not.toHaveProperty([
      'import.meta.env.VITE_ENABLE_GOOGLE_SIGN_IN',
    ]);
    expect(defines['import.meta.env.VITE_ENABLE_CALLS']).toBe('"false"');
  });

  it('leaves every other build as it is', async () => {
    vi.stubEnv('VITE_BACKEND_ORIGIN', '');
    const defines = await buildDefines();

    expect(flagDefines(defines)).toEqual([]);
  });
});
