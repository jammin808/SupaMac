import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginCard } from './login-card';

const build = vi.hoisted(() => ({ selfHosted: false }));
vi.mock(import('@core/constant/servers'), async (importOriginal) => ({
  ...(await importOriginal()),
  get SELF_HOSTED() {
    return build.selfHosted;
  },
}));

beforeEach(() => {
  build.selfHosted = false;
});

afterEach(cleanup);

describe('LoginCard', () => {
  it('links to the terms and privacy policy on the hosted service', () => {
    render(() => (
      <LoginCard compact={false} showGoogle>
        sign-in form
      </LoginCard>
    ));

    expect(
      screen.getByRole('link', { name: 'terms' }).getAttribute('href')
    ).toBe('/terms');
    expect(
      screen.getByRole('link', { name: 'privacy policy' }).getAttribute('href')
    ).toBe('/privacy');
  });

  it('has no legal links on a self-hosted instance, which serves no such pages', () => {
    build.selfHosted = true;
    render(() => (
      <LoginCard compact={false} showGoogle>
        sign-in form
      </LoginCard>
    ));

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(/you agree to our/)).toBeNull();
    expect(screen.getByText('sign-in form')).toBeTruthy();
  });

  it('welcomes people by the product name', () => {
    render(() => (
      <LoginCard compact={false} showGoogle>
        sign-in form
      </LoginCard>
    ));

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Welcome to SupaMac'
    );
  });
});
