import { saveSignupDraft } from '@app/features/onboarding/primitives/flow-storage';
import { stubOnboardingBrowser } from '@app/features/onboarding/tests/render';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Login, MobileWebSignup } from './auth';
import type { createFakeAuth } from './tests/fake-auth-context';

const world = vi.hoisted(() => ({
  microsoftSignup: false,
  selfHosted: false,
  googleSignIn: false,
  navigate: vi.fn(),
  auth: undefined as ReturnType<typeof createFakeAuth> | undefined,
}));

vi.mock(import('@core/constant/servers'), async (importOriginal) => ({
  ...(await importOriginal()),
  get SELF_HOSTED() {
    return world.selfHosted;
  },
}));

vi.mock(import('@core/constant/featureFlags'), async (importOriginal) => ({
  ...(await importOriginal()),
  get ENABLE_GOOGLE_SIGN_IN() {
    return world.googleSignIn;
  },
}));

vi.mock('@app/lib/analytics/posthog', () => ({
  useFeatureFlag: (flag: { key: string }) => () => ({
    enabled: flag.key === 'enable-microsoft-signup' && world.microsoftSignup,
  }),
}));

// Provider sign-in leaves the page; the fake never comes back signed in.
vi.mock('./create-app-auth-context', async () => {
  const { createFakeAuth } = await import('./tests/fake-auth-context');
  return {
    createAppAuthContext: () => {
      world.auth = createFakeAuth(
        {},
        { ssoRedirect: () => new Promise(() => {}) }
      );
      return world.auth.context;
    },
  };
});

// The real sign-up slides, on a fake onboarding backend.
vi.mock('@app/features/onboarding/onboarding', async () => {
  const { OnboardingProvider } = await import(
    '@app/features/onboarding/context/onboarding-context'
  );
  const { createFakeOnboarding } = await import(
    '@app/features/onboarding/tests/fake-onboarding-context'
  );
  const { SignupJourneyView } = await import(
    '@app/features/onboarding/views/signup-journey-view'
  );
  return {
    OnboardingSignup: (props: Parameters<typeof SignupJourneyView>[0]) => (
      <OnboardingProvider
        value={createFakeOnboarding({ viewer: null }).context}
      >
        <SignupJourneyView {...props} />
      </OnboardingProvider>
    ),
    OnboardingPending: () => null,
    Onboarding: () => null,
    clearSignupDraft: () => {},
  };
});

vi.mock('@solidjs/router', async (original) => ({
  ...(await original<typeof import('@solidjs/router')>()),
  useSearchParams: () => [{}, vi.fn()],
  useNavigate: () => world.navigate,
}));

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  stubOnboardingBrowser();
  world.microsoftSignup = false;
  world.selfHosted = false;
  world.googleSignIn = false;
  world.navigate.mockReset();
  world.auth = undefined;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const microsoftButton = () =>
  screen.queryByRole('button', { name: 'Continue with Microsoft' });

describe('Continue with Microsoft, behind enable-microsoft-signup', () => {
  it('is not offered on sign-in while the flag is off', async () => {
    render(() => <Login />);
    await screen.findByRole('button', { name: 'Continue with Google' });
    expect(microsoftButton()).toBeNull();
  });

  it('signs in through Microsoft once the flag is on', async () => {
    world.microsoftSignup = true;
    render(() => <Login />);
    await screen.findByRole('button', { name: 'Continue with Google' });
    const microsoft = microsoftButton();
    expect(microsoft).toBeTruthy();
    if (microsoft) fireEvent.click(microsoft);
    await waitFor(() =>
      expect(world.auth?.calls()).toContain('sso:microsoft:login')
    );
  });

  it('keeps the sign-up work step Google-only, with its old copy, while the flag is off', async () => {
    saveSignupDraft({ step: 'work' });
    render(() => <Login signupMode />);
    await screen.findByRole('button', { name: 'Connect work email' });
    expect(
      screen.getByRole('heading', { name: /Connect your work/ })
    ).toBeTruthy();
    expect(microsoftButton()).toBeNull();
    expect(screen.queryByText('Continuing with Microsoft')).toBeNull();
    expect(screen.getByText('Google account connection')).toBeTruthy();
  });

  it('offers Microsoft sign-up and explains it under Read more once the flag is on', async () => {
    world.microsoftSignup = true;
    saveSignupDraft({ step: 'work' });
    render(() => <Login signupMode />);
    await screen.findByRole('button', { name: 'Continue with Google' });
    expect(
      screen.getByRole('heading', { name: /Continue with your work/ })
    ).toBeTruthy();
    expect(screen.getByText('Continuing with Microsoft')).toBeTruthy();
    const microsoft = microsoftButton();
    expect(microsoft).toBeTruthy();
    if (microsoft) fireEvent.click(microsoft);
    await waitFor(() =>
      expect(world.auth?.calls()).toContain('sso:microsoft:signup')
    );
  });
});

/** The sign-in card's email field, once it is on screen. */
const emailField = () =>
  waitFor(() => {
    const field = document.querySelector('input[type="email"]');
    expect(field).not.toBeNull();
    return field;
  });

const googleButton = () =>
  screen.queryByRole('button', { name: 'Continue with Google' });

describe('sign-in on a self-hosted instance', () => {
  beforeEach(() => {
    world.selfHosted = true;
  });

  it('asks for an email address straight away: the emailed code is the only way in', async () => {
    render(() => <Login />);

    await emailField();
    expect(googleButton()).toBeNull();
    expect(microsoftButton()).toBeNull();
    expect(screen.queryByRole('button', { name: /Continue with/ })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Back to sign in' })
    ).toBeNull();
  });

  it('signs up on the same card instead of the slides that lead to Google', async () => {
    saveSignupDraft({ step: 'work' });
    render(() => <Login signupMode />);

    await emailField();
    expect(
      screen.queryByRole('button', { name: 'Connect work email' })
    ).toBeNull();
    expect(googleButton()).toBeNull();
  });

  it('offers Google once the build turns it on', async () => {
    world.googleSignIn = true;
    render(() => <Login />);

    const google = await screen.findByRole('button', {
      name: 'Continue with Google',
    });
    fireEvent.click(google);
    await waitFor(() =>
      expect(world.auth?.calls()).toContain('sso:google:login')
    );
  });

  it('offers Microsoft once the build turns that on, still without Google', async () => {
    world.microsoftSignup = true;
    render(() => <Login />);

    await screen.findByRole('button', { name: 'Continue with Microsoft' });
    expect(googleButton()).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Continue with email' })
    ).toBeTruthy();
  });

  it('sends a phone that opens the sign-up page to sign in', () => {
    render(() => <MobileWebSignup />);

    expect(world.navigate).toHaveBeenCalledWith('/login', { replace: true });
    expect(screen.queryByRole('button', { name: 'Sign Up' })).toBeNull();
  });
});

describe('sign-in on the hosted service', () => {
  it('offers Google whatever the self-hosted flag says', async () => {
    world.googleSignIn = false;
    render(() => <Login />);

    expect(
      await screen.findByRole('button', { name: 'Continue with Google' })
    ).toBeTruthy();
  });

  it('takes an email address on the mobile-web sign-up page', () => {
    render(() => <MobileWebSignup />);

    expect(screen.getByRole('button', { name: 'Sign Up' })).toBeTruthy();
    expect(world.navigate).not.toHaveBeenCalled();
  });
});
