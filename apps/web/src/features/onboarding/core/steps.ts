export const ONBOARDING_STEPS = [
  'welcome',
  'vision',
  'security',
  'work',
  'personal',
  'tools',
  'team',
  'plan',
  'routines',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * Steps only the hosted service walks: its product pitch, its company's
 * security claims, and its paid plans. None describes a self-hosted instance.
 */
const HOSTED_ONLY_STEPS: readonly OnboardingStep[] = [
  'vision',
  'security',
  'plan',
];

/** The steps a deployment's flow walks, in order. */
export function onboardingSteps(
  selfHosted: boolean
): readonly OnboardingStep[] {
  if (!selfHosted) return ONBOARDING_STEPS;
  return ONBOARDING_STEPS.filter((step) => !HOSTED_ONLY_STEPS.includes(step));
}

/**
 * `step` when `steps` walks it, else the first step of `steps` that follows
 * it in the full order, so progress saved on a left-out step resumes past it.
 */
function firstStepFrom(
  step: OnboardingStep,
  steps: readonly OnboardingStep[]
): OnboardingStep {
  const onward = ONBOARDING_STEPS.slice(ONBOARDING_STEPS.indexOf(step));
  return (
    onward.find((candidate) => steps.includes(candidate)) ??
    steps[steps.length - 1]
  );
}

/** How the user left a step; analytics records it and skipping can fork. */
export type StepOutcome = 'completed' | 'skipped';

/** The opening slides that share the story stage's measured handoffs. */
export type StoryStep = Extract<
  OnboardingStep,
  'welcome' | 'vision' | 'security' | 'tools'
>;

export const isStoryStep = (step: OnboardingStep): step is StoryStep =>
  step === 'welcome' ||
  step === 'vision' ||
  step === 'security' ||
  step === 'tools';

export function nextOnboardingStep(
  step: OnboardingStep,
  outcome: StepOutcome,
  steps: readonly OnboardingStep[] = ONBOARDING_STEPS
): OnboardingStep {
  // Without a first account, offering a second account would be misleading.
  if (step === 'work' && outcome === 'skipped') return 'tools';
  const index = steps.indexOf(step);
  return steps[Math.min(index + 1, steps.length - 1)];
}

export function previousOnboardingStep(
  step: OnboardingStep,
  steps: readonly OnboardingStep[] = ONBOARDING_STEPS
): OnboardingStep | undefined {
  const index = steps.indexOf(step);
  return index > 0 ? steps[index - 1] : undefined;
}

/** A `?step` value that names a current onboarding step. */
export function parseOnboardingStepParam(
  value: unknown
): OnboardingStep | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  return ONBOARDING_STEPS.find((step) => step === raw);
}

/**
 * Where to open the flow.
 * Checkout return, then saved progress (including legacy names), then a
 * `?step` link, then welcome. A Google sign-up return is passed in as `work`.
 * A step `steps` leaves out opens the next one it walks.
 */
export function restoreOnboardingStep(
  saved: unknown,
  checkoutReturn = false,
  requestedStep?: unknown,
  steps: readonly OnboardingStep[] = ONBOARDING_STEPS
): OnboardingStep {
  return firstStepFrom(
    restoredStep(saved, checkoutReturn, requestedStep),
    steps
  );
}

function restoredStep(
  saved: unknown,
  checkoutReturn: boolean,
  requestedStep: unknown
): OnboardingStep {
  if (checkoutReturn) return 'plan';
  const resumed = resumeSavedStep(saved);
  if (resumed) return resumed;
  return parseOnboardingStepParam(requestedStep) ?? 'welcome';
}

/** Migrate in-progress sessions from the previous flow without losing OAuth returns. */
function resumeSavedStep(saved: unknown): OnboardingStep | undefined {
  if (typeof saved !== 'string') return undefined;
  if (saved === 'email') return 'work';
  if (saved.startsWith('connect-')) return 'tools';
  if (saved === 'building' || saved === 'summary') return 'plan';
  return ONBOARDING_STEPS.find((step) => step === saved);
}
