import { SELF_HOSTED } from '@core/constant/servers';
import { createSignal } from 'solid-js';
import { match } from 'ts-pattern';
import {
  type SignupProvider,
  type SignupStep,
  signupSteps,
} from '../core/signup-draft';
import { readSignupDraft, saveSignupDraft } from './flow-storage';

/**
 * The signed-out slides. Only the step and accent cross the Google or
 * Microsoft sign-up redirect; the flow resumes at the work step once the account exists.
 */
export function createSignupJourney(options: { showingEmail: boolean }) {
  const draft = readSignupDraft();
  // The email form means this account will not come from a provider sign-up
  // (an emailed link, or the fallback after one failed), so nothing chains
  // into that provider's inbox consent once it exists.
  if (options.showingEmail && draft?.provider)
    saveSignupDraft({ ...draft, provider: undefined });
  const steps = signupSteps(SELF_HOSTED);
  // A draft saved on a slide this deployment leaves out starts over.
  const savedStep = steps.find((candidate) => candidate === draft?.step);
  const [step, setStep] = createSignal<SignupStep>(
    options.showingEmail ? 'work' : (savedStep ?? 'welcome')
  );
  const [accent, setAccent] = createSignal(draft?.accent);
  const [connecting, setConnecting] = createSignal<SignupProvider>();
  const [error, setError] = createSignal<string>();

  /** Show `next`; moving between slides drops any pending sign-up. */
  const commit = (next: SignupStep) => {
    saveSignupDraft({ step: next, accent: accent() });
    setStep(next);
  };

  const connect = async (
    provider: SignupProvider,
    startSignup: () => Promise<void>
  ) => {
    if (connecting()) return;
    saveSignupDraft({
      step: 'work',
      accent: accent(),
      authenticating: true,
      provider,
    });
    setConnecting(provider);
    setError();
    try {
      await startSignup();
    } catch {
      const name = match(provider)
        .with('google', () => 'Google')
        .with('microsoft', () => 'Microsoft')
        .exhaustive();
      setError(`Couldn't open ${name}. Please try again.`);
    } finally {
      setConnecting();
    }
  };

  return {
    step,
    steps,
    accent,
    setAccent,
    commit,
    connecting,
    error,
    connect,
  };
}
