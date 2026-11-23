import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signInMethods } from './sign-in-methods';

const build = vi.hoisted(() => ({
  selfHosted: false,
  google: false,
  apple: false,
  password: false,
  domainSso: false,
}));

vi.mock('@core/constant/servers', () => ({
  get SELF_HOSTED() {
    return build.selfHosted;
  },
}));

vi.mock('@core/constant/featureFlags', () => ({
  get ENABLE_GOOGLE_SIGN_IN() {
    return build.google;
  },
  get ENABLE_APPLE_SIGN_IN() {
    return build.apple;
  },
  get ENABLE_PASSWORD_SIGN_IN() {
    return build.password;
  },
  get ENABLE_DOMAIN_SSO_SIGN_IN() {
    return build.domainSso;
  },
}));

beforeEach(() => {
  build.selfHosted = false;
  build.google = false;
  build.apple = false;
  build.password = false;
  build.domainSso = false;
});

describe('signInMethods', () => {
  it('offers every method on the hosted service, whatever the flags say', () => {
    expect(signInMethods()).toEqual({
      google: true,
      apple: true,
      password: true,
      domainSso: true,
    });
  });

  it('offers none of them on a self-hosted instance until a flag turns one on', () => {
    build.selfHosted = true;

    expect(signInMethods()).toEqual({
      google: false,
      apple: false,
      password: false,
      domainSso: false,
    });
  });

  it.each(['google', 'apple', 'password', 'domainSso'] as const)(
    'turns on %s alone with its own flag on a self-hosted instance',
    (method) => {
      build.selfHosted = true;
      build[method] = true;

      expect(signInMethods()).toEqual({
        google: false,
        apple: false,
        password: false,
        domainSso: false,
        [method]: true,
      });
    }
  );
});
