import { cleanup, render } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

const build = vi.hoisted(() => ({
  backendOrigin: undefined as string | undefined,
}));
vi.mock(import('@core/constant/servers'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    get SELF_HOSTED() {
      return build.backendOrigin !== undefined;
    },
    get SERVER_HOSTS() {
      const origin = build.backendOrigin;
      if (origin === undefined) return actual.SERVER_HOSTS;
      const socket = origin.replace(/^http/, 'ws');
      return {
        ...actual.SERVER_HOSTS,
        'agent-harness': `${origin}/agent-harness`,
        'document-storage-service': `${origin}/dss`,
        'auth-service': `${origin}/auth`,
        'email-service': `${origin}/email`,
        'calendar-service': `${origin}/calendar`,
        'cognition-service': `${origin}/cognition`,
        'notification-service': `${origin}/notification`,
        'scheduled-action': `${origin}/scheduled-action`,
        'static-file': `${origin}/static-file`,
        'connection-gateway': `${socket}/connection-gateway`,
        contacts: `${origin}/contacts`,
        'unfurl-service': `${origin}/unfurl`,
      };
    },
  };
});
vi.mock('@core/auth', () => ({ useIsAuthenticated: () => () => true }));
vi.mock('@queries/auth/user-info', () => ({
  useUserInfoQuery: () => ({
    isSuccess: true,
    isRefetchError: false,
    data: { isAgent: true, tutorialComplete: false },
  }),
}));
vi.mock('@queries/auth/agent-setup', () => ({
  useAgentSetupMutation: () => ({
    isIdle: false,
    isError: false,
    data: { api_key: 'mak_token', team_join_failed: false },
    mutate: () => {},
  }),
}));
vi.mock('@queries/auth/tutorial', () => ({
  useCompleteTutorialMutation: () => ({ isIdle: false, mutate: () => {} }),
}));
vi.mock('@solidjs/router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solidjs/router')>()),
  useNavigate: () => () => {},
}));

afterEach(() => {
  cleanup();
  vi.resetModules();
});

/** The page's text as a bundle for the given backend renders it. */
async function pageText(backendOrigin: string | undefined) {
  build.backendOrigin = backendOrigin;
  const { AgentSetupPage } = await import('./agent-setup-page');
  return render(() => <AgentSetupPage />).container.textContent ?? '';
}

describe('AgentSetupPage', () => {
  it('links the hosted service’s documentation', async () => {
    const text = await pageText(undefined);
    expect(text).toContain('https://macro.com/docs/AI/bring-your-own');
    expect(text).toContain('const macro = new Macro({});');
  });

  it('names the instance’s hosts and no hosted page on a self-hosted instance', async () => {
    const text = await pageText('https://api.example.org');
    expect(text).toContain(
      "'agent-harness': 'https://api.example.org/agent-harness',"
    );
    expect(text).toContain('api_url = "https://api.example.org/agent-harness"');
    // The SDK takes an https host for its socket service too.
    expect(text).toContain(
      "connection: 'https://api.example.org/connection-gateway',"
    );
    expect(text).toContain(`webAppUrl: '${window.location.origin}/app',`);
    expect(text).not.toMatch(/macro\.com/);
  });
});
