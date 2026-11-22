import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileAppButton } from './footer-actions';

const build = vi.hoisted(() => ({ selfHosted: false }));
vi.mock(import('@core/constant/servers'), async (importOriginal) => ({
  ...(await importOriginal()),
  get SELF_HOSTED() {
    return build.selfHosted;
  },
}));

vi.mock('@app/lib/analytics/analytics-context', () => ({
  useAnalytics: () => ({ track: vi.fn() }),
}));
vi.mock('@app/signal/splitLayout', () => ({
  globalSplitManager: () => undefined,
}));
vi.mock('@components/app/app-sidebar/sidebar', () => ({
  SidebarOpenInSplitMenu: () => null,
}));
vi.mock('@core/component/UserIcon', () => ({ UserIcon: () => null }));
vi.mock('@core/constant/SettingsState', () => ({
  useSettingsState: () => ({
    openSettings: vi.fn(),
    openSettingsInSplit: vi.fn(),
    activeTabId: () => 'Account',
    settingsOpen: () => false,
  }),
}));
vi.mock('@core/constant/settingsTabsConfig', () => ({
  useSettingsTabAvailable: () => () => true,
}));
vi.mock('@core/context/user', () => ({
  useEmail: () => () => undefined,
  useUserId: () => () => undefined,
}));
vi.mock('@core/mobile/isNativeMobilePlatform', () => ({
  isNativeMobilePlatform: () => false,
}));
vi.mock('@queries/auth/user-name-self', () => ({
  isRealNamePart: () => false,
  useOwnUserName: () => () => undefined,
}));
vi.mock('./app-update', () => ({ useAppUpdate: () => () => undefined }));
vi.mock('./help-menu', () => ({ HelpMenu: () => null }));
vi.mock('./update-button', () => ({ UpdateButton: () => null }));

beforeEach(() => {
  build.selfHosted = false;
});

afterEach(cleanup);

describe('MobileAppButton', () => {
  it('offers the mobile app on the hosted service', () => {
    render(() => <MobileAppButton />);
    expect(
      screen.getByRole('button', { name: 'Get the mobile app' })
    ).toBeTruthy();
  });

  it('shows nothing on a self-hosted instance', () => {
    build.selfHosted = true;
    render(() => <MobileAppButton />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
