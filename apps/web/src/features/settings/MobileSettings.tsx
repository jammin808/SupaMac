import { useFeatureFlag } from '@app/lib/analytics/posthog';
import { t } from '@app/lib/i18n';
import { useLogout } from '@core/auth/logout';
import { UserIcon } from '@core/component/UserIcon';
import { enableAgentNotifications } from '@core/constant/featureFlags';
import { useEmail, useUserId } from '@core/context/user';
import { fireAndForget } from '@core/util/fireAndForget';
import { useOutlookAvailable } from '@queries/auth/outlook-link';
import { isRealNamePart, useOwnUserName } from '@queries/auth/user-name-self';
import { useMacroComputersRollout } from '@queries/computers/computers';
import { Show, Suspense } from 'solid-js';
import { useMobileSettings } from './context/mobile-settings';
import { MobileSettingsSheet } from './MobileSettingsSheet';
import { SettingsTabContent } from './SettingsTabContent';
import { shownSettingsTab, useShownSettingsTabs } from './shown-settings-tabs';
import { useTeamSettingsGroups } from './teamSettingsGroups';

export function MobileSettings() {
  const settings = useMobileSettings();
  const macroComputers = useMacroComputersRollout();
  const agentNotifications = useFeatureFlag(enableAgentNotifications);
  // Always mounted on phones; read the providers only once settings open.
  const outlook = useOutlookAvailable(settings.open);
  const { groups, searchGroups } = useShownSettingsTabs();
  const navGroups = useTeamSettingsGroups(groups);
  const userId = useUserId();
  const email = useEmail();
  const name = useOwnUserName();
  const logout = useLogout();
  const page = () => {
    const tab = settings.page();
    return tab && shownSettingsTab(tab);
  };
  const displayName = () => {
    const value = name();
    return (
      [value?.first_name, value?.last_name].filter(isRealNamePart).join(' ') ||
      email()?.split('@')[0] ||
      t('settingsNav.yourAccount')
    );
  };

  return (
    <MobileSettingsSheet
      open={settings.open()}
      page={page()}
      groups={navGroups()}
      searchGroups={searchGroups()}
      emailRowStyle={false}
      outlook={outlook()}
      macroComputers={macroComputers().enabled}
      agentNotifications={agentNotifications().enabled}
      name={displayName()}
      email={email() ?? ''}
      avatar={
        <Suspense fallback={<span>{displayName().slice(0, 1)}</span>}>
          <Show
            when={userId()}
            keyed
            fallback={<span>{displayName().slice(0, 1)}</span>}
          >
            {(id) => (
              <UserIcon id={id} size="fill" suppressClick showTooltip={false} />
            )}
          </Show>
        </Suspense>
      }
      onClose={settings.close}
      onNavigate={settings.selectPage}
      onLogout={() => {
        fireAndForget(logout(), 'logout');
      }}
      renderPage={(page) => <SettingsTabContent tab={page} phone />}
    />
  );
}
