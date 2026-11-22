import type { SettingsTab } from '@core/constant/SettingsState';
import { SELF_HOSTED } from '@core/constant/servers';
import {
  type SettingsTabGroup,
  useSettingsTabAvailable,
  useSettingsTabs,
} from '@core/constant/settingsTabsConfig';
import { isNativeMobilePlatform } from '@core/mobile/isNativeMobilePlatform';
import { isPlatform } from '@core/util/platform';
import { type Accessor, createMemo } from 'solid-js';

/**
 * Whether a settings page exists only for the hosted service: Billing sells
 * and bills its plans, and outside the native apps Mobile App and Desktop App
 * only link the hosted service's own apps. A self-hosted instance shows none
 * of them; inside a native app the two pages show the installed version.
 */
function isHostedOnlyTab(tab: SettingsTab): boolean {
  if (!SELF_HOSTED) return false;
  if (tab === 'Billing') return true;
  if (tab === 'Mobile App') return !isNativeMobilePlatform();
  return tab === 'Desktop App' && !isPlatform('desktop');
}

/**
 * The page a tab opens: a page this deployment leaves out opens Account, so a
 * link or a caller that still names it never lands on an empty pane.
 */
export function shownSettingsTab(tab: SettingsTab): SettingsTab {
  return isHostedOnlyTab(tab) ? 'Account' : tab;
}

/** Which settings pages this deployment shows, by tab. */
export function useShownSettingsTab(): (tab: SettingsTab) => boolean {
  const isAvailable = useSettingsTabAvailable();
  return (tab) => !isHostedOnlyTab(tab) && isAvailable(tab);
}

/** The settings nav and search groups this deployment shows. */
export function useShownSettingsTabs(): {
  groups: Accessor<SettingsTabGroup[]>;
  searchGroups: Accessor<SettingsTabGroup[]>;
} {
  const tabs = useSettingsTabs();
  if (!SELF_HOSTED) return tabs;

  // Labels are getters that follow the interface language; keep them live.
  const shown = (groups: Accessor<SettingsTabGroup[]>) =>
    createMemo(() =>
      groups()
        .map((group) => ({
          get label() {
            return group.label;
          },
          items: group.items.filter((item) => !isHostedOnlyTab(item.tab)),
        }))
        .filter((group) => group.items.length > 0)
    );

  return { groups: shown(tabs.groups), searchGroups: shown(tabs.searchGroups) };
}
