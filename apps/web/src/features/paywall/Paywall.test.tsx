/**
 * @vitest-environment jsdom
 */

import { PaywallKey, usePaywallState } from '@core/constant/PaywallState';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Paywall } from './Paywall';

const build = vi.hoisted(() => ({ selfHosted: false }));
vi.mock(import('@core/constant/servers'), async (importOriginal) => ({
  ...(await importOriginal()),
  get SELF_HOSTED() {
    return build.selfHosted;
  },
}));
vi.mock('@app/signal/splitLayout', () => ({
  globalSplitManager: () => undefined,
}));
vi.mock('@core/hotkey/hotkeys', () => ({
  useHotkeyDOMScope: () => [() => {}, 'paywall'],
}));
vi.mock('./PaywallComponent', () => ({
  default: () => <p>Plans for sale</p>,
}));

beforeEach(() => {
  build.selfHosted = false;
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  usePaywallState().hidePaywall();
  cleanup();
  vi.unstubAllGlobals();
});

describe('Paywall', () => {
  it('offers the plans when the server refuses on a limit', async () => {
    usePaywallState().showPaywall(PaywallKey.FILE_LIMIT);
    render(() => <Paywall />);

    expect(await screen.findByText('Plans for sale')).toBeTruthy();
    expect(screen.queryByText('File limit reached')).toBeNull();
  });

  it('names the limit and sells nothing on a self-hosted instance', async () => {
    build.selfHosted = true;
    usePaywallState().showPaywall(PaywallKey.FILE_LIMIT);
    render(() => <Paywall />);

    expect(
      await screen.findByRole('heading', { name: 'File limit reached' })
    ).toBeTruthy();
    expect(screen.queryByText('Plans for sale')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(usePaywallState().paywallOpen()).toBe(false);
  });

  it.each([
    [
      PaywallKey.O1_LIMIT,
      'This model is not available on this instance',
      'Smart models require Pro or Max',
    ],
    [PaywallKey.MULTI_INBOX, 'Inbox limit reached', 'Connect more inboxes'],
  ])(
    'names the %s limit on a self-hosted instance, not a plan',
    async (key, limit, plansTitle) => {
      build.selfHosted = true;
      usePaywallState().showPaywall(key);
      render(() => <Paywall />);

      expect(await screen.findByRole('heading', { name: limit })).toBeTruthy();
      expect(screen.queryByText(plansTitle)).toBeNull();
    }
  );

  it('stays closed on a self-hosted instance when no limit was hit', () => {
    build.selfHosted = true;
    usePaywallState().showPaywall();
    expect(usePaywallState().paywallOpen()).toBe(false);

    build.selfHosted = false;
    usePaywallState().showPaywall();
    expect(usePaywallState().paywallOpen()).toBe(true);
  });
});
