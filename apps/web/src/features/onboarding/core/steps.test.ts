import { describe, expect, it } from 'vitest';
import {
  nextOnboardingStep,
  ONBOARDING_STEPS,
  onboardingSteps,
  previousOnboardingStep,
  restoreOnboardingStep,
} from './steps';

describe('onboarding resume', () => {
  it.each([
    ['email', 'work'],
    ['connect-linear', 'tools'],
    ['building', 'plan'],
    ['summary', 'plan'],
    ['personal', 'personal'],
    ['team', 'team'],
  ])('migrates %s to %s', (saved, expected) => {
    expect(restoreOnboardingStep(saved)).toBe(expected);
  });
  it.each([undefined, null, {}, 17, 'unknown'])(
    'starts safely for invalid saved steps',
    (saved) => {
      expect(restoreOnboardingStep(saved)).toBe('welcome');
    }
  );
  it('restores the checkout step even when session storage was lost', () => {
    expect(restoreOnboardingStep(undefined, true)).toBe('plan');
    expect(restoreOnboardingStep('work', true)).toBe('plan');
  });

  it('opens a valid step link when nothing is saved', () => {
    expect(restoreOnboardingStep(undefined, false, 'plan')).toBe('plan');
    expect(restoreOnboardingStep(undefined, false, 'work')).toBe('work');
  });

  it('ignores an unknown step link', () => {
    expect(restoreOnboardingStep(undefined, false, 'nope')).toBe('welcome');
    expect(restoreOnboardingStep(undefined, false, 'email')).toBe('welcome');
    expect(restoreOnboardingStep(undefined, false, 'building')).toBe('welcome');
  });

  it('prefers saved progress over the step link', () => {
    expect(restoreOnboardingStep('team', false, 'plan')).toBe('team');
    expect(restoreOnboardingStep('email', false, 'plan')).toBe('work');
  });

  it('lets a checkout return beat saved progress and the step link', () => {
    expect(restoreOnboardingStep('work', true, 'team')).toBe('plan');
    expect(restoreOnboardingStep(undefined, true, 'welcome')).toBe('plan');
  });
});

describe('self-hosted onboarding steps', () => {
  const steps = onboardingSteps(true);

  it('walks every step on the hosted service', () => {
    expect(onboardingSteps(false)).toEqual(ONBOARDING_STEPS);
  });

  it('leaves out the product pitch, the security claims, and the plan', () => {
    expect(steps).toEqual([
      'welcome',
      'work',
      'personal',
      'tools',
      'team',
      'routines',
    ]);
  });

  it('moves between the steps it keeps', () => {
    expect(nextOnboardingStep('welcome', 'completed', steps)).toBe('work');
    expect(nextOnboardingStep('team', 'completed', steps)).toBe('routines');
    expect(nextOnboardingStep('work', 'skipped', steps)).toBe('tools');
    expect(previousOnboardingStep('work', steps)).toBe('welcome');
    expect(previousOnboardingStep('routines', steps)).toBe('team');
  });

  it.each([
    ['vision', 'work'],
    ['security', 'work'],
    ['plan', 'routines'],
    ['building', 'routines'],
    ['team', 'team'],
  ])('resumes saved %s at %s', (saved, expected) => {
    expect(restoreOnboardingStep(saved, false, undefined, steps)).toBe(
      expected
    );
  });

  it('never opens the plan step, from a checkout return or a step link', () => {
    expect(restoreOnboardingStep(undefined, true, undefined, steps)).toBe(
      'routines'
    );
    expect(restoreOnboardingStep(undefined, false, 'plan', steps)).toBe(
      'routines'
    );
    expect(restoreOnboardingStep(undefined, false, 'security', steps)).toBe(
      'work'
    );
  });
});
