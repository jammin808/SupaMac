const QUICK_START = `npm install @macro-inc/sdk
export MACRO_API_KEY="<your token>"`;

const SET_PROFILE = `const image = await macro.me.uploadProfilePicture(bytes, {
  fileName: 'avatar.png',
  contentType: 'image/png',
});
await macro.me.update({ name: 'Your Name', profilePicture: image });`;

const NEW_TOKEN_SNIPPET = `const { secret } = await macro.apiKeys.create('my token');`;

const MACROD_INSTALL = `curl -fsSL https://raw.githubusercontent.com/macro-inc/macro/main/crates/coding_agent_worker/install/install.sh | sh
~/.local/bin/macrod detect-agents`;

const MACROD_CONFIG_DIR = 'mkdir -p ~/.macrod && chmod 700 ~/.macrod';

const MACROD_RUN = `tmux kill-session -t macrod-agent 2>/dev/null
: > ~/.macrod/agent.log
tmux new-session -d -s macrod-agent '~/.local/bin/macrod service --config ~/.macrod/agent.toml --agent <agent id> --workspace "<absolute path>" >> ~/.macrod/agent.log 2>&1'`;

const MACROD_PAIRING_CODE = `grep '"event":"pairing"' ~/.macrod/agent.log`;

const MACROD_APPROVE = `await macro.harnesses.pairing('<code>').approve();`;

/** Documentation pages the setup page links. */
export type AgentSetupDocs = {
  product: string;
  sdk: string;
  /** macrod's setup guide. */
  macrod: string;
};
const MACROD_SOURCE_URL =
  'https://github.com/macro-inc/macro/tree/main/crates/coding_agent_worker';

/** The SDK's services (`ServiceName` in `packages/sdk/src/config.ts`). */
export const SDK_SERVICES = [
  'agent-harness',
  'storage',
  'auth',
  'email',
  'calendar',
  'cognition',
  'notification',
  'properties',
  'search',
  'scheduled-action',
  'static-files',
  'connection',
  'contacts',
  'unfurl',
] as const;
export type SdkService = (typeof SDK_SERVICES)[number];

/**
 * Where a self-hosted instance serves its backend and its web app. The SDK and
 * macrod default to the hosted service, so on such an instance the page names
 * every host they use.
 */
export type SelfHostedDeployment = {
  /** The instance's host for each SDK service; one left out would fall back to the hosted service. */
  sdkHosts: Record<SdkService, string>;
  /** The web app's origin followed by the folder it is served from. */
  webAppUrl: string;
};

function sdkClient(deployment: SelfHostedDeployment | undefined) {
  if (!deployment) return 'const macro = new Macro({});';
  const hosts = SDK_SERVICES.map((service) => {
    const key = /^[a-z]+$/.test(service) ? service : `'${service}'`;
    return `    ${key}: '${deployment.sdkHosts[service]}',`;
  });
  // The SDK builds its links below `webAppUrl`, which carries the folder.
  return [
    'const macro = new Macro({',
    '  hosts: {',
    ...hosts,
    '  },',
    `  webAppUrl: '${deployment.webAppUrl}',`,
    '});',
  ].join('\n');
}

/** macrod's start commands; on a self-hosted instance its config names it first. */
function macrodStart(deployment: SelfHostedDeployment | undefined) {
  if (!deployment) return `${MACROD_CONFIG_DIR}\n${MACROD_RUN}`;
  const config = [
    '[macro]',
    `api_url = "${deployment.sdkHosts['agent-harness']}"`,
    `storage_url = "${deployment.sdkHosts.storage}"`,
    `web_url = "${deployment.webAppUrl}"`,
  ].join('\n');
  return [
    MACROD_CONFIG_DIR,
    `[ -e ~/.macrod/agent.toml ] || cat > ~/.macrod/agent.toml <<'EOF'\n${config}\nEOF`,
    MACROD_RUN,
  ].join('\n');
}

/** The page's wording, translated where it renders. */
export type AgentSetupCopy = {
  title: string;
  intro: string;
  teamJoinFailed: string;
  tokenLabel: string;
  useToken: string;
  docsHeading: string;
  productDocs: string;
  sdkDocs: string;
  setProfile: string;
  macrod: string;
  macrodInstall: string;
  macrodStart: string;
  macrodApprove: string;
  macrodNext: string;
  macrodDocs: string;
  macrodSource: string;
  anotherToken: string;
  anotherTokenSettings: string;
  openApp: string;
  openAppLink: string;
};

function codeBlock(code: string, language: string) {
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

/** An agent's first page: its SDK token and what to do with it. */
export function agentSetupMarkdown(input: {
  copy: AgentSetupCopy;
  apiKey: string;
  teamJoinFailed: boolean;
  /** Confirms the token was saved and opens the app. */
  openAppUrl: string;
  /** Where the documentation is; without it the page links none. */
  docs?: AgentSetupDocs;
  /** Set on a self-hosted instance; the hosted service's page has none. */
  selfHosted?: SelfHostedDeployment;
}) {
  const { copy, apiKey, teamJoinFailed, openAppUrl, docs, selfHosted } = input;
  const macrodLinks = [
    ...(docs ? [`- [${copy.macrodDocs}](${docs.macrod})`] : []),
    `- [${copy.macrodSource}](${MACROD_SOURCE_URL})`,
  ];

  return [
    `# ${copy.title}`,
    copy.intro,
    ...(teamJoinFailed ? [`> ${copy.teamJoinFailed}`] : []),
    `## ${copy.tokenLabel}`,
    codeBlock(apiKey, 'text'),
    `## ${copy.useToken}`,
    codeBlock(QUICK_START, 'sh'),
    `## ${copy.setProfile}`,
    codeBlock(`${sdkClient(selfHosted)}\n${SET_PROFILE}`, 'ts'),
    `## ${copy.macrod}`,
    copy.macrodInstall,
    codeBlock(MACROD_INSTALL, 'sh'),
    copy.macrodStart,
    codeBlock(macrodStart(selfHosted), 'sh'),
    copy.macrodApprove,
    codeBlock(MACROD_PAIRING_CODE, 'sh'),
    codeBlock(MACROD_APPROVE, 'ts'),
    copy.macrodNext,
    macrodLinks.join('\n'),
    `## ${copy.anotherToken}`,
    codeBlock(NEW_TOKEN_SNIPPET, 'ts'),
    copy.anotherTokenSettings,
    ...(docs
      ? [
          `## ${copy.docsHeading}`,
          `- [${copy.productDocs}](${docs.product})\n- [${copy.sdkDocs}](${docs.sdk})`,
        ]
      : []),
    `## ${copy.openApp}`,
    `[${copy.openAppLink}](${openAppUrl})`,
  ].join('\n\n');
}

export type MarkdownPart =
  | { t: 'text'; text: string }
  | { t: 'link'; label: string; url: string };

const MARKDOWN_LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** Finds the links in markdown source so they can stay clickable as source. */
export function markdownParts(markdown: string): MarkdownPart[] {
  const parts: MarkdownPart[] = [];
  let end = 0;

  for (const link of markdown.matchAll(MARKDOWN_LINK)) {
    if (link.index > end) {
      parts.push({ t: 'text', text: markdown.slice(end, link.index) });
    }
    parts.push({ t: 'link', label: link[1] ?? '', url: link[2] ?? '' });
    end = link.index + link[0].length;
  }

  if (end < markdown.length) {
    parts.push({ t: 'text', text: markdown.slice(end) });
  }

  return parts;
}
