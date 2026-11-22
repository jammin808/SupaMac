import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendEmailCode } from './auth-requests';

const mocks = vi.hoisted(() => ({
  methods: { google: true, apple: true, password: true, domainSso: true },
  platformFetch: vi.fn(),
  passwordLogin: vi.fn(),
}));

vi.mock('../sign-in-methods', () => ({
  signInMethods: () => mocks.methods,
}));
vi.mock('@core/constant/servers', () => ({
  SERVER_HOSTS: { 'auth-service': 'https://api.example.com/auth' },
}));
vi.mock('@core/util/platformFetch', () => ({
  platformFetch: mocks.platformFetch,
}));
vi.mock('@service-auth/client', () => ({
  authServiceClient: { passwordLogin: mocks.passwordLogin },
}));

const LOGIN_PAGE = 'https://app.example.com/workspace/login';
const input = { email: 'person@example.com', isAgent: false };

/** The auth service's answer once a code is on its way. */
const codeSent = () => ({ ok: true, status: 200, json: async () => ({}) });

/** The auth service's answer for an address whose domain has its own sign-in. */
const organizationSignIn = () => ({
  ok: true,
  status: 202,
  json: async () => ({ idp_id: 'idp-1' }),
});

beforeEach(() => {
  mocks.methods = {
    google: true,
    apple: true,
    password: true,
    domainSso: true,
  };
  mocks.platformFetch.mockReset();
  mocks.passwordLogin.mockReset();
  vi.stubGlobal('window', {
    location: { href: LOGIN_PAGE, origin: new URL(LOGIN_PAGE).origin },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sendEmailCode, for an address its organization signs in', () => {
  it('leaves for the identity provider where that sign-in is offered', async () => {
    mocks.platformFetch.mockResolvedValue(organizationSignIn());

    expect(await sendEmailCode(input)).toEqual({ t: 'redirected' });
    const destination = new URL(window.location.href);
    expect(destination.origin + destination.pathname).toBe(
      'https://api.example.com/auth/login/sso'
    );
    expect(destination.searchParams.get('idp_id')).toBe('idp-1');
    expect(destination.searchParams.get('login_hint')).toBe(
      'person@example.com'
    );
  });

  it('stays on the page and says so where it is not', async () => {
    mocks.methods = { ...mocks.methods, domainSso: false };
    mocks.platformFetch.mockResolvedValue(organizationSignIn());

    expect(await sendEmailCode(input)).toEqual({
      t: 'failed',
      message: 'Unable to start SSO login for this email.',
    });
    expect(window.location.href).toBe(LOGIN_PAGE);
  });
});

describe('sendEmailCode, for an account with a password', () => {
  it('checks whether the address is one where password sign-in is offered', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest');
    mocks.platformFetch.mockResolvedValue(codeSent());

    expect(await sendEmailCode(input)).toEqual({ t: 'code-sent' });
    expect(digest).toHaveBeenCalledOnce();
  });

  it('sends every address a code where it is not', async () => {
    mocks.methods = { ...mocks.methods, password: false };
    const digest = vi.spyOn(crypto.subtle, 'digest');
    mocks.platformFetch.mockResolvedValue(codeSent());

    expect(await sendEmailCode(input)).toEqual({ t: 'code-sent' });
    expect(digest).not.toHaveBeenCalled();
    expect(mocks.passwordLogin).not.toHaveBeenCalled();
    expect(mocks.platformFetch).toHaveBeenCalledWith(
      'https://api.example.com/auth/login/passwordless',
      expect.objectContaining({ method: 'POST' })
    );
  });
});
