import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Banner from './Banner';

const build = vi.hoisted(() => ({ selfHosted: false }));
vi.mock(import('@core/constant/servers'), async (importOriginal) => ({
  ...(await importOriginal()),
  get SELF_HOSTED() {
    return build.selfHosted;
  },
}));
// The banner's buttons only navigate.
vi.mock('@solidjs/router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@core/auth', () => ({ useIsAuthenticated: () => () => false }));

beforeEach(() => {
  build.selfHosted = false;
});

afterEach(cleanup);

describe('the signed-out banner', () => {
  it('invites visitors of the hosted service to create an account', () => {
    render(() => <Banner />);

    expect(screen.getByText('Create an account to get started.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Login' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign Up' })).toBeTruthy();
  });

  it('only offers sign-in on a self-hosted instance, which admits allowed addresses', () => {
    build.selfHosted = true;
    render(() => <Banner />);

    expect(screen.queryByText(/Create an account/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign Up' })).toBeNull();
    expect(screen.queryByText('or')).toBeNull();
    expect(screen.getByRole('button', { name: 'Login' })).toBeTruthy();
  });
});
