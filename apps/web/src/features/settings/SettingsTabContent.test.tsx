import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsTabContent } from './SettingsTabContent';

const build = vi.hoisted(() => ({ selfHosted: false }));
vi.mock(import('@core/constant/servers'), async (importOriginal) => ({
  ...(await importOriginal()),
  get SELF_HOSTED() {
    return build.selfHosted;
  },
}));

vi.mock('@core/mobile/isNativeMobilePlatform', () => ({
  isNativeMobilePlatform: () => false,
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

vi.mock('./Account', () => ({ Account: () => <p>Account page</p> }));
vi.mock('./Billing', () => ({ Billing: () => <p>Billing page</p> }));
vi.mock('../usage/usage', () => ({ Usage: () => <p>Usage page</p> }));
vi.mock('../calendar/calendar-settings', () => ({
  CalendarSettings: () => null,
}));
vi.mock('../crm/crm-settings', () => ({ CrmSettings: () => null }));
vi.mock('../routines/routine-settings', () => ({
  RoutineSettings: () => null,
}));
vi.mock('./AccountManagers', () => ({ AccountManagers: () => null }));
vi.mock('./Admin', () => ({ Admin: () => null }));
vi.mock('./Agent', () => ({ Agent: () => null }));
vi.mock('./AgentSettings', () => ({ AgentSettings: () => null }));
vi.mock('./ApiKeys', () => ({ ApiKeys: () => null }));
vi.mock('./Appearance', () => ({ Appearance: () => null }));
vi.mock('./Bots', () => ({ Bots: () => null }));
vi.mock('./DesktopApp', () => ({ DesktopApp: () => null }));
vi.mock('./email-settings', () => ({ EmailSettings: () => null }));
vi.mock('./IntegrationsPage', () => ({ IntegrationsPage: () => null }));
vi.mock('./MobileApp', () => ({ MobileApp: () => null }));
vi.mock('./Notifications', () => ({ Notifications: () => null }));
vi.mock('./Shortcuts', () => ({ Shortcuts: () => null }));
vi.mock('./Tags', () => ({ Tags: () => null }));
vi.mock('./Team', () => ({ TeamPage: () => null }));
vi.mock('./TeamGeneral', () => ({ TeamGeneral: () => null }));
vi.mock('./TeamMembers', () => ({ TeamMembers: () => null }));

afterEach(() => {
  cleanup();
  build.selfHosted = false;
});

describe('the settings page a tab opens', () => {
  it('is Billing on the hosted service', () => {
    render(() => <SettingsTabContent tab="Billing" />);

    expect(screen.getByText('Billing page')).toBeTruthy();
    expect(screen.queryByText('Account page')).toBeNull();
  });

  it('is Account on a self-hosted instance asked for Billing', () => {
    build.selfHosted = true;
    render(() => <SettingsTabContent tab="Billing" />);

    expect(screen.getByText('Account page')).toBeTruthy();
    expect(screen.queryByText('Billing page')).toBeNull();
  });

  it('is the page asked for when the instance shows it', () => {
    build.selfHosted = true;
    render(() => <SettingsTabContent tab="Usage" />);

    expect(screen.getByText('Usage page')).toBeTruthy();
    expect(screen.queryByText('Account page')).toBeNull();
  });
});
