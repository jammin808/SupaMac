// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  type AgentSetupCopy,
  agentSetupMarkdown,
  markdownParts,
  SDK_SERVICES,
  type SdkService,
} from './agent-setup-markdown';

const COPY = new Proxy({} as AgentSetupCopy, {
  get: (_, key) => String(key),
});

const DOCS = {
  product: 'https://docs.test',
  sdk: 'https://sdk.docs.test',
  macrod: 'https://docs.test/bring-your-own',
};

describe('agentSetupMarkdown', () => {
  it('sends the agent through macrod setup with clickable docs and source', () => {
    const markdown = agentSetupMarkdown({
      copy: COPY,
      apiKey: 'token',
      teamJoinFailed: false,
      openAppUrl: 'https://app.test/done',
      docs: DOCS,
    });

    expect(markdown).toContain(
      '--config ~/.macrod/agent.toml --agent <agent id>'
    );
    expect(markdown).toContain("harnesses.pairing('<code>').approve()");
    expect(
      markdownParts(markdown).flatMap((part) =>
        part.t === 'link' ? [part.url] : []
      )
    ).toEqual(
      expect.arrayContaining([
        'https://docs.test/bring-your-own',
        'https://github.com/macro-inc/macro/tree/main/crates/coding_agent_worker',
        'https://docs.test',
        'https://sdk.docs.test',
      ])
    );
    expect(markdown).toContain('## docsHeading');
    expect(markdown).toContain('const macro = new Macro({});');
  });
});

const SELF_HOSTED = {
  sdkHosts: Object.fromEntries(
    SDK_SERVICES.map((service) => [
      service,
      `https://api.example.org/${service}`,
    ])
  ) as Record<SdkService, string>,
  webAppUrl: 'https://ui.example.org/supamac',
};

/** The members of the SDK's `ServiceName` union, read from its source. */
function sdkServiceNames() {
  const path = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../../packages/sdk/src/config.ts'
  );
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const names: string[] = [];
  source.forEachChild((node) => {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== 'ServiceName') {
      return;
    }
    if (!ts.isUnionTypeNode(node.type)) return;
    for (const member of node.type.types) {
      if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
        names.push(member.literal.text);
      }
    }
  });
  return names;
}

describe('agentSetupMarkdown on a self-hosted instance', () => {
  const markdown = agentSetupMarkdown({
    copy: COPY,
    apiKey: 'token',
    teamJoinFailed: false,
    openAppUrl: 'https://ui.example.org/supamac/agent-setup/done',
    selfHosted: SELF_HOSTED,
  });

  it('names a host of the instance for every SDK service', () => {
    expect([...SDK_SERVICES].sort()).toEqual(sdkServiceNames().sort());
    for (const service of SDK_SERVICES) {
      expect(markdown).toMatch(
        new RegExp(`'?${service}'?: 'https://api\\.example\\.org/${service}',`)
      );
    }
    expect(markdown).toContain("webAppUrl: 'https://ui.example.org/supamac',");
    expect(markdown).not.toContain('new Macro({})');
  });

  it('points macrod at the instance before it pairs', () => {
    expect(markdown).toContain(
      [
        "[ -e ~/.macrod/agent.toml ] || cat > ~/.macrod/agent.toml <<'EOF'",
        '[macro]',
        'api_url = "https://api.example.org/agent-harness"',
        'storage_url = "https://api.example.org/storage"',
        'web_url = "https://ui.example.org/supamac"',
        'EOF',
        'tmux kill-session -t macrod-agent 2>/dev/null',
      ].join('\n')
    );
  });

  it('links no documentation when it is given none', () => {
    expect(markdown).not.toMatch(/macro\.com/);
    expect(markdown).not.toContain('docsHeading');
    expect(
      markdownParts(markdown).flatMap((part) =>
        part.t === 'link' ? [part.url] : []
      )
    ).toEqual([
      'https://github.com/macro-inc/macro/tree/main/crates/coding_agent_worker',
      'https://ui.example.org/supamac/agent-setup/done',
    ]);
  });
});

describe('markdownParts', () => {
  it('finds links between text and keeps every other character', () => {
    expect(
      markdownParts('- [Docs](https://docs.test)\n- [SDK](https://sdk.test)\n')
    ).toEqual([
      { t: 'text', text: '- ' },
      { t: 'link', label: 'Docs', url: 'https://docs.test' },
      { t: 'text', text: '\n- ' },
      { t: 'link', label: 'SDK', url: 'https://sdk.test' },
      { t: 'text', text: '\n' },
    ]);
  });

  it('leaves code that only looks close to a link as text', () => {
    const code = 'const list = [a, b]; call(list);';

    expect(markdownParts(code)).toEqual([{ t: 'text', text: code }]);
  });
});
