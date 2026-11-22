import { createRoot } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  shownSettingsTab,
  useShownSettingsTab,
  useShownSettingsTabs,
} from './shown-settings-tabs';

const build = vi.hoisted(() => ({ selfHosted: false }));
vi.mock(import('@core/constant/servers'), async (importOriginal) => ({
  ...(await importOriginal()),
  get SELF_HOSTED() {
    return build.selfHosted;
  },
}));

const platform = vi.hoisted(() => ({ nativeMobile: false }));
vi.mock('@core/mobile/isNativeMobilePlatform', () => ({
  isNativeMobilePlatform: () => platform.nativeMobile,
}));
vi.mock('@app/lib/analytics/posthog', () => ({
  useFeatureFlag: () => () => ({ enabled: true }),
}));
vi.mock('@core/mobile/isTouchDevice', () => ({ isTouchDevice: () => false }));
vi.mock('@core/context/user', () => ({
  useHasPermission: () => () => false,
  useEmail: () => () => undefined,
  useUserId: () => () => undefined,
}));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  build.selfHosted = false;
  platform.nativeMobile = false;
});

function shownTabs() {
  return createRoot((cleanup) => {
    dispose = cleanup;
    return { isShown: useShownSettingsTab(), ...useShownSettingsTabs() };
  });
}

const listed = (groups: { items: { tab: string }[] }[]) =>
  groups.flatMap((group) => group.items.map((item) => item.tab));

describe('settings pages on the hosted service', () => {
  it('shows Billing and the app downloads in the nav, search, and by direct access', () => {
    const tabs = shownTabs();

    expect(tabs.isShown('Billing')).toBe(true);
    expect(tabs.isShown('Mobile App')).toBe(true);
    expect(tabs.isShown('Desktop App')).toBe(true);
    expect(listed(tabs.groups())).toEqual(
      expect.arrayContaining(['Billing', 'Mobile App', 'Desktop App'])
    );
    expect(listed(tabs.searchGroups())).toEqual(
      expect.arrayContaining(['Billing', 'Mobile App', 'Desktop App'])
    );
  });

  it('opens Billing when a link names it', () => {
    expect(shownSettingsTab('Billing')).toBe('Billing');
  });
});

describe('settings pages on a self-hosted instance', () => {
  it.each(['Billing', 'Mobile App', 'Desktop App'] as const)(
    'leaves %s out of the nav, search, and direct access',
    (tab) => {
      build.selfHosted = true;
      const tabs = shownTabs();

      expect(tabs.isShown(tab)).toBe(false);
      expect(listed(tabs.groups())).not.toContain(tab);
      expect(listed(tabs.searchGroups())).not.toContain(tab);
    }
  );

  it.each(['Billing', 'Mobile App', 'Desktop App'] as const)(
    'opens Account when a link names %s',
    (tab) => {
      build.selfHosted = true;

      expect(shownSettingsTab(tab)).toBe('Account');
      expect(shownSettingsTab('Usage')).toBe('Usage');
    }
  );

  it('keeps every other page', () => {
    build.selfHosted = true;
    const tabs = shownTabs();

    expect(tabs.isShown('Account')).toBe(true);
    expect(listed(tabs.groups())).toEqual(
      expect.arrayContaining(['Account', 'Appearance', 'Usage', 'Team'])
    );
  });

  it('keeps the installed-app page inside the native app', () => {
    build.selfHosted = true;
    platform.nativeMobile = true;
    const tabs = shownTabs();

    expect(tabs.isShown('Mobile App')).toBe(true);
    expect(tabs.isShown('Billing')).toBe(false);
  });
});
