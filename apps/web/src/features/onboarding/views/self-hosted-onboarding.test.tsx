import { cleanup, fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingStep } from '../core/steps';
import { saveStep } from '../primitives/flow-storage';
import {
  FAKE_VIEWER_ID,
  type FakeOnboardingWorld,
} from '../tests/fake-onboarding-context';
import { renderInviteOfferStub } from '../tests/invite-offer-stub';
import {
  renderWithFakeOnboarding,
  stubOnboardingBrowser,
} from '../tests/render';
import { OnboardingFlowView } from './onboarding-flow-view';
import { SignupJourneyView } from './signup-journey-view';

vi.mock(import('@core/constant/servers'), async (importOriginal) => ({
  ...(await importOriginal()),
  SELF_HOSTED: true,
}));

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  stubOnboardingBrowser();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setupFlow(
  options: {
    world?: Partial<FakeOnboardingWorld>;
    resume?: OnboardingStep;
    next?: string;
  } = {}
) {
  if (options.resume) saveStep(FAKE_VIEWER_ID, options.resume);
  const navigate = vi.fn();
  const redirect = vi.fn();
  const { fake } = renderWithFakeOnboarding(
    () => (
      <OnboardingFlowView
        next={options.next}
        checkoutReturn={undefined}
        onNavigate={navigate}
        onRedirect={redirect}
        onSignedOut={() => {}}
        renderInviteOffer={renderInviteOfferStub}
      />
    ),
    options.world
  );
  return { fake, navigate, redirect };
}

const heading = (name: string | RegExp) =>
  screen.findByRole('heading', { name, level: 1 });
const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole('button', { name }));

describe('self-hosted onboarding', () => {
  it('walks the setup steps and finishes without a pitch, trust claims, or a plan', async () => {
    const { fake, navigate, redirect } = setupFlow({ next: '/channel/launch' });

    await heading('Create your workspace');
    click('Get started');

    // Straight to the first account: no feature pitch, no security slide.
    await heading(/Connect your work/);
    expect(screen.queryByRole('button', { name: 'Read more' })).toBeNull();
    expect(screen.queryByText('Data protection')).toBeNull();
    expect(screen.queryByLabelText('Privacy assurances')).toBeNull();
    click('Connect work email');
    await screen.findByText(
      FAKE_VIEWER_ID.slice(FAKE_VIEWER_ID.indexOf('|') + 1)
    );
    click('Continue');

    await heading(/Add your personal/);
    expect(screen.queryByRole('button', { name: 'Read more' })).toBeNull();
    click('Skip for now');

    await heading('Connect your tools.');
    click('Continue');

    await heading('Built for teams.');
    expect(
      screen.getByText('Bring your team into one workspace.')
    ).toBeTruthy();
    expect(screen.queryByText(/AI credit/)).toBeNull();
    click('Create team & invite 2');
    await screen.findByText("You're on Acme");
    click('Continue');

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/channel/launch')
    );
    expect(redirect).not.toHaveBeenCalled();
    expect(fake.calls().some((call) => call.startsWith('startCheckout'))).toBe(
      false
    );
    expect(fake.world.viewer?.tutorialComplete).toBe(true);
    expect(fake.events()).toContainEqual({
      event: 'onboarding_v4_completed',
      data: {
        plan: 'free',
        plan_skipped: true,
        emails_connected: 1,
        connectors_connected: [],
      },
    });
    const steps = fake
      .events()
      .filter((e) => e.event === 'onboarding_v4_step')
      .map((e) => e.data);
    for (const step of ['vision', 'security', 'plan'])
      expect(steps).not.toContainEqual(expect.objectContaining({ step }));
  });

  it('goes back from the first account to the workspace step', async () => {
    setupFlow({ resume: 'work' });
    await heading(/Connect your work/);
    click('Back to previous step');
    await heading('Create your workspace');
  });

  it('resumes past a step it leaves out', async () => {
    setupFlow({ resume: 'security' });
    await heading(/Connect your work/);
  });

  it('offers a personal address the team form or a way past it, never referrals', async () => {
    const { fake, navigate } = setupFlow({
      resume: 'team',
      world: { record: { status: 'active', suggestedTeamDomain: undefined } },
    });

    await heading('Built for teams.');
    expect(screen.getByText('Workspace name')).toBeTruthy();
    expect(screen.queryByText('Invite friends.')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Copy referral link' })
    ).toBeNull();

    click('Skip for now');
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(
      fake.calls().some((call) => call.startsWith('sendReferralInvites'))
    ).toBe(false);
    expect(fake.calls().some((call) => call.startsWith('createTeam'))).toBe(
      false
    );
  });
});

describe('self-hosted sign-up', () => {
  it('goes from the workspace step straight to sign-up, without trust claims or terms', () => {
    const google = vi.fn().mockResolvedValue(undefined);
    renderWithFakeOnboarding(
      () => (
        <SignupJourneyView
          onGoogle={google}
          onBackFromEmail={() => {}}
          onSignIn={() => {}}
          onAgentSignup={() => {}}
          showingEmail={false}
        />
      ),
      { viewer: null }
    );

    expect(
      screen.getByRole('heading', { name: 'Create your workspace' })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));

    expect(
      screen.queryByRole('heading', {
        name: 'Which features do you want to try first?',
      })
    ).toBeNull();
    expect(
      screen.queryByRole('heading', {
        name: 'A workspace built to earn your trust.',
      })
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Read more' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'privacy policy' })).toBeNull();
    expect(screen.queryByLabelText('Privacy assurances')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Connect work email' }));
    expect(google).toHaveBeenCalledOnce();
  });
});
