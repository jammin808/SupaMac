import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBillingLab } from '../../billing-lab/create-billing-lab';
import { UsageSettingsView } from './usage-settings';

const build = vi.hoisted(() => ({ selfHosted: true }));
vi.mock(import('@core/constant/servers'), async (importOriginal) => ({
  ...(await importOriginal()),
  get SELF_HOSTED() {
    return build.selfHosted;
  },
}));

beforeEach(() => {
  build.selfHosted = true;
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Usage on a self-hosted instance', () => {
  it('shows a free account its meter and no plans to subscribe to', () => {
    const lab = createBillingLab('free');
    render(() => <UsageSettingsView context={lab.usage} />);

    expect(
      screen.getByRole('progressbar', { name: 'Monthly limit' })
    ).toBeTruthy();
    expect(screen.queryByText('Need more AI usage?')).toBeNull();
    expect(screen.queryByRole('button', { name: 'View plans' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'About monthly usage' })
    ).toBeNull();
  });

  it('shows a paid account its meter and no credits to buy or reload', () => {
    const lab = createBillingLab('pro');
    render(() => <UsageSettingsView context={lab.usage} />);

    expect(
      screen.getByRole('progressbar', { name: 'Monthly limit' })
    ).toBeTruthy();
    expect(screen.queryByText('Usage Credits')).toBeNull();
    expect(screen.queryByText(/credits remaining/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add more' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Configure Automatic reload' })
    ).toBeNull();
  });

  it('shows no reload cap notice, which offers credits', () => {
    const lab = createBillingLab('spending-limit');
    render(() => <UsageSettingsView context={lab.usage} />);

    expect(
      screen.queryByText('Monthly auto-reload $50 limit reached')
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add credits' })).toBeNull();
  });
});

describe('Usage on the hosted service', () => {
  it('offers a free account the plans and the explanation', () => {
    build.selfHosted = false;
    const lab = createBillingLab('free');
    render(() => <UsageSettingsView context={lab.usage} />);

    expect(screen.getByText('Need more AI usage?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View plans' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'About monthly usage' })
    ).toBeTruthy();
  });
});
