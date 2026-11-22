import { afterEach, expect, it, vi } from 'vitest';

afterEach(async () => {
  const { configureAppLinks } = await import('@macro-inc/lexical-core');
  configureAppLinks({});
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

// The first import of init loads every decorator.
const IMPORTS_INIT_MS = 60_000;

/** Lexical-core's link checks after the web app initializes Lexical. */
async function initializedOn(page: string) {
  vi.stubGlobal('location', new URL(page));
  vi.resetModules();
  const { initializeLexical } = await import('./init');
  initializeLexical();
  const { isMacroBookingUrl, isStaticFileUrl } = await import(
    '@macro-inc/lexical-core'
  );
  return { isMacroBookingUrl, isStaticFileUrl };
}

it(
  'points a self-hosted bundle’s content links at the instance',
  async () => {
    vi.stubEnv('VITE_BACKEND_ORIGIN', 'https://api.example.com');
    vi.stubEnv('__APP_BASE_PATH__', '/workspace');

    const links = await initializedOn(
      'https://team.example.com/workspace/home'
    );

    expect(
      links.isMacroBookingUrl(
        'https://team.example.com/workspace/book/profile-1/intro'
      )
    ).toBe(true);
    expect(
      links.isMacroBookingUrl('https://team.example.com/app/book/profile-1')
    ).toBe(false);
    expect(
      links.isStaticFileUrl('https://api.example.com/static-file/file/3d7ab8c8')
    ).toBe(true);
  },
  IMPORTS_INIT_MS
);

it(
  'leaves a hosted bundle on lexical-core’s page-relative defaults',
  async () => {
    vi.stubEnv('VITE_BACKEND_ORIGIN', undefined);

    const links = await initializedOn('https://team.example.com/app/home');

    expect(
      links.isMacroBookingUrl('https://team.example.com/app/book/profile-1')
    ).toBe(true);
    expect(
      links.isMacroBookingUrl('https://macro.com/app/book/profile-1')
    ).toBe(false);
    expect(
      links.isStaticFileUrl('https://api.example.com/static-file/file/3d7ab8c8')
    ).toBe(false);
  },
  IMPORTS_INIT_MS
);
