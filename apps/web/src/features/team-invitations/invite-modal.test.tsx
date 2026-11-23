/**
 * @vitest-environment jsdom
 */

import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InviteModal, setInviteModalOpen } from './invite-modal';

const build = vi.hoisted(() => ({ selfHosted: false }));
vi.mock(import('@core/constant/servers'), async (importOriginal) => ({
  ...(await importOriginal()),
  get SELF_HOSTED() {
    return build.selfHosted;
  },
}));

vi.mock('@core/component/Toast/Toast', () => ({
  toast: { success: vi.fn(), failure: vi.fn() },
}));
vi.mock('@core/context/user', () => ({
  useReferralCode: () => () => 'code-1',
}));
vi.mock('@queries/team/referrals', () => ({
  useSendReferralInvitesMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
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
  setInviteModalOpen(false);
  cleanup();
  vi.unstubAllGlobals();
});

describe('the referral invite modal', () => {
  it('offers invites and a referral link on the hosted service', async () => {
    setInviteModalOpen(true);
    render(() => <InviteModal />);

    expect(
      await screen.findByRole('button', { name: 'Send Invites' })
    ).toBeTruthy();
    expect(
      screen.getByText('Or share your personal referral link:')
    ).toBeTruthy();
  });

  it('does not open on a self-hosted instance, which has no referral credit', () => {
    build.selfHosted = true;
    setInviteModalOpen(true);
    render(() => <InviteModal />);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send Invites' })).toBeNull();
    expect(screen.queryByText(/referral/)).toBeNull();
  });
});
