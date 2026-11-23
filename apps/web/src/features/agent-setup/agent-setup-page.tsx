import { WEB_BASE_PATH } from '@app/constants/routerBase';
import { t } from '@app/lib/i18n';
import { useIsAuthenticated } from '@core/auth';
import { LoadingSpinner } from '@core/component/LoadingSpinner';
import { SELF_HOSTED, SERVER_HOSTS } from '@core/constant/servers';
import { getWebOrigin } from '@core/util/webOrigin';
import { useAgentSetupMutation } from '@queries/auth/agent-setup';
import { useCompleteTutorialMutation } from '@queries/auth/tutorial';
import { useUserInfoQuery } from '@queries/auth/user-info';
import { useNavigate } from '@solidjs/router';
import { Button } from '@ui';
import { createEffect, For, Match, type ParentProps, Switch } from 'solid-js';
import { match } from 'ts-pattern';
import {
  type AgentSetupDocs,
  agentSetupMarkdown,
  markdownParts,
  type SdkService,
  type SelfHostedDeployment,
} from './core/agent-setup-markdown';

/** The hosted service's documentation; a self-hosted instance has none. */
const HOSTED_DOCS: AgentSetupDocs | undefined = SELF_HOSTED
  ? undefined
  : {
      product: 'https://macro.com/docs',
      sdk: 'https://sdk.macro.com',
      macrod: 'https://macro.com/docs/AI/bring-your-own',
    };

/** The app's host that serves each SDK service. */
const SDK_SERVICE_HOSTS = {
  'agent-harness': 'agent-harness',
  storage: 'document-storage-service',
  auth: 'auth-service',
  email: 'email-service',
  calendar: 'calendar-service',
  cognition: 'cognition-service',
  notification: 'notification-service',
  properties: 'document-storage-service',
  search: 'document-storage-service',
  'scheduled-action': 'scheduled-action',
  'static-files': 'static-file',
  connection: 'connection-gateway',
  contacts: 'contacts',
  unfurl: 'unfurl-service',
} as const satisfies Record<SdkService, keyof typeof SERVER_HOSTS>;

/** The instance's own hosts, on a self-hosted instance. */
function selfHostedDeployment(): SelfHostedDeployment | undefined {
  if (!SELF_HOSTED) return undefined;
  const entries = Object.entries(SDK_SERVICE_HOSTS) as [
    SdkService,
    keyof typeof SERVER_HOSTS,
  ][];
  // The SDK opens its own sockets from an https host.
  const sdkHosts = Object.fromEntries(
    entries.map(([service, server]) => [
      service,
      SERVER_HOSTS[server].replace(/^ws(s?):/, 'http$1:'),
    ])
  ) as Record<SdkService, string>;
  return { sdkHosts, webAppUrl: `${getWebOrigin()}${WEB_BASE_PATH}` };
}

/** Who is looking at a setup page, and whether setup is theirs to finish. */
function useSetupStatus() {
  const userInfoQuery = useUserInfoQuery();
  const isAuthenticated = useIsAuthenticated();
  const navigate = useNavigate();

  const status = () => {
    if (isAuthenticated() === false) return 'signed-out';
    // A failed background refetch keeps its data: leaving the page then would
    // mint a new token and revoke the one the agent already saw.
    const settled = userInfoQuery.isSuccess || userInfoQuery.isRefetchError;
    if (!settled) return 'pending';
    const data = userInfoQuery.data;
    if (data?.isAgent === true && data.tutorialComplete === false) {
      return 'needs-setup';
    }
    return 'finished';
  };

  createEffect(() => {
    if (status() === 'signed-out') navigate('/login', { replace: true });
    if (status() === 'finished') navigate('/', { replace: true });
  });

  return status;
}

function PageFrame(props: ParentProps) {
  return (
    <div class="h-full overflow-y-auto bg-page p-6 text-ink">
      {props.children}
    </div>
  );
}

/** Markdown source with its links left clickable, so its text is the page. */
function MarkdownSource(props: { markdown: string }) {
  return (
    <For each={props.markdown.split('\n\n')}>
      {(block) => (
        <p class="mb-4 select-text whitespace-pre-wrap wrap-break-word font-mono text-sm">
          <For each={markdownParts(block)}>
            {(part) =>
              match(part)
                .with({ t: 'text' }, ({ text }) => text)
                .with({ t: 'link' }, ({ label, url }) => (
                  <>
                    [{label}](
                    <a href={url} target="_self" class="underline">
                      {url}
                    </a>
                    )
                  </>
                ))
                .exhaustive()
            }
          </For>
        </p>
      )}
    </For>
  );
}

/**
 * A new agent's first page: its SDK token and how to use it, as plain markdown
 * an agent driving a browser can read. The app sends the agent back here until
 * it follows the page's link to confirm it saved the token. Reloading replaces
 * the token, since a key can only be shown once.
 */
export function AgentSetupPage() {
  const status = useSetupStatus();
  const setup = useAgentSetupMutation();

  createEffect(() => {
    if (status() === 'needs-setup' && setup.isIdle) setup.mutate();
  });

  const markdown = (apiKey: string, teamJoinFailed: boolean) =>
    agentSetupMarkdown({
      apiKey,
      teamJoinFailed,
      openAppUrl: `${getWebOrigin()}${WEB_BASE_PATH}/agent-setup/done`,
      docs: HOSTED_DOCS,
      selfHosted: selfHostedDeployment(),
      copy: {
        title: t('agentSetup.title'),
        intro: t('agentSetup.intro'),
        teamJoinFailed: t('agentSetup.teamJoinFailed'),
        tokenLabel: t('agentSetup.tokenLabel'),
        useToken: t('agentSetup.useToken'),
        docsHeading: t('agentSetup.docsHeading'),
        productDocs: t('agentSetup.productDocs'),
        sdkDocs: t('agentSetup.sdkDocs'),
        setProfile: t('agentSetup.setProfile'),
        macrod: t('agentSetup.macrod'),
        macrodInstall: t('agentSetup.macrodInstall'),
        macrodStart: t('agentSetup.macrodStart'),
        macrodApprove: t('agentSetup.macrodApprove'),
        macrodNext: t('agentSetup.macrodNext'),
        macrodDocs: t('agentSetup.macrodDocs'),
        macrodSource: t('agentSetup.macrodSource'),
        anotherToken: t('agentSetup.anotherToken'),
        anotherTokenSettings: t('agentSetup.anotherTokenSettings'),
        openApp: t('agentSetup.openApp'),
        openAppLink: t('agentSetup.openAppLink'),
      },
    });

  return (
    <PageFrame>
      <Switch fallback={<LoadingSpinner class="m-auto size-10 p-2" />}>
        <Match when={setup.isError}>
          <p class="text-ink-muted">{t('agentSetup.loadFailed')}</p>
          <Button
            class="self-start"
            variant="primary"
            size="sm"
            onClick={() => setup.mutate()}
          >
            {t('agentSetup.tryAgain')}
          </Button>
        </Match>
        <Match when={setup.data}>
          {(result) => (
            <MarkdownSource
              markdown={markdown(result().api_key, result().team_join_failed)}
            />
          )}
        </Match>
      </Switch>
    </PageFrame>
  );
}

/** Where the setup page's link lands: confirms the token, then opens the app. */
export function AgentSetupDonePage() {
  const status = useSetupStatus();
  const confirm = useCompleteTutorialMutation();

  createEffect(() => {
    if (status() === 'needs-setup' && confirm.isIdle) confirm.mutate();
  });

  return (
    <PageFrame>
      <Switch fallback={<LoadingSpinner class="m-auto size-10 p-2" />}>
        <Match when={confirm.isError}>
          <p class="text-ink-muted">{t('agentSetup.confirmFailed')}</p>
          <Button
            class="self-start"
            variant="primary"
            size="sm"
            onClick={() => confirm.mutate()}
          >
            {t('agentSetup.tryAgain')}
          </Button>
        </Match>
      </Switch>
    </PageFrame>
  );
}
