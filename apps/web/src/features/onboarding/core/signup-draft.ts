const SIGNUP_STEPS = ['welcome', 'vision', 'security', 'work'] as const;
export type SignupStep = (typeof SIGNUP_STEPS)[number];

/**
 * Slides only the hosted service shows: its product pitch and its company's
 * security claims. Neither describes a self-hosted instance.
 */
const HOSTED_ONLY_SIGNUP_STEPS: readonly SignupStep[] = ['vision', 'security'];

/** The signed-out steps a deployment walks, in order. */
export function signupSteps(selfHosted: boolean): readonly SignupStep[] {
  if (!selfHosted) return SIGNUP_STEPS;
  return SIGNUP_STEPS.filter(
    (step) => !HOSTED_ONLY_SIGNUP_STEPS.includes(step)
  );
}

/** The identity providers a new account can sign up with. */
export type SignupProvider = 'google' | 'microsoft';

/** Only local presentation choices cross the sign-up redirect, never credentials. */
export type SignupDraft = {
  step: SignupStep;
  accent?: string;
  /** Sign-up started from the work step; the OAuth return resumes there. */
  authenticating?: boolean;
  /** Which provider that sign-up went through. */
  provider?: SignupProvider;
};

const isSignupProvider = (value: unknown): value is SignupProvider =>
  value === 'google' || value === 'microsoft';

const isSignupStep = (value: unknown): value is SignupStep =>
  SIGNUP_STEPS.some((step) => step === value);

const isHexColor = (value: unknown): value is string =>
  typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);

/** Validates a stored draft; anything malformed reads as no draft. */
export function parseSignupDraft(raw: string | null): SignupDraft | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? 'null');
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || !('step' in value)) return;
  if (!isSignupStep(value.step)) return;
  return {
    step: value.step,
    accent:
      'accent' in value && isHexColor(value.accent) ? value.accent : undefined,
    authenticating:
      'authenticating' in value &&
      value.authenticating === true &&
      value.step === 'work',
    provider:
      'provider' in value && isSignupProvider(value.provider)
        ? value.provider
        : undefined,
  };
}

export const serializeSignupDraft = (draft: SignupDraft) =>
  JSON.stringify(draft);

export function previousSignupStep(
  step: SignupStep,
  steps: readonly SignupStep[] = SIGNUP_STEPS
): SignupStep | undefined {
  const index = steps.indexOf(step);
  return index > 0 ? steps[index - 1] : undefined;
}

export function nextSignupStep(
  step: SignupStep,
  steps: readonly SignupStep[] = SIGNUP_STEPS
): SignupStep {
  const index = steps.indexOf(step);
  return steps[Math.min(index + 1, steps.length - 1)];
}
