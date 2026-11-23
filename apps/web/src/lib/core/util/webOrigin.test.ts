import { afterEach, describe, expect, it, vi } from 'vitest';

const isTauri = vi.hoisted(() => vi.fn(() => false));
vi.mock('./platform', () => ({ isTauri }));

afterEach(() => {
  isTauri.mockReturnValue(false);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function loadWebOrigin(options: {
  backendOrigin?: string;
  page: string;
  mode?: string;
}) {
  vi.stubEnv('VITE_BACKEND_ORIGIN', options.backendOrigin);
  vi.stubEnv('MODE', options.mode ?? 'production');
  vi.stubGlobal('location', new URL(options.page));
  vi.resetModules();
  return import('./webOrigin');
}

describe('getWebOrigin', () => {
  it('names the hosted web deployment from the hosted native apps', async () => {
    isTauri.mockReturnValue(true);
    const { getWebOrigin } = await loadWebOrigin({
      page: 'tauri://localhost/',
    });
    expect(getWebOrigin()).toBe('https://macro.com');
  });

  it('is the page’s own origin in a self-hosted bundle, even inside a native shell', async () => {
    isTauri.mockReturnValue(true);
    const { getWebOrigin } = await loadWebOrigin({
      backendOrigin: 'https://api.example.com',
      page: 'https://www.example.org:8443/workspace/login',
    });
    expect(getWebOrigin()).toBe('https://www.example.org:8443');
  });
});

describe('getCopiedLinkOrigin', () => {
  it('links the hosted development deployment from a local hosted page', async () => {
    const { getCopiedLinkOrigin } = await loadWebOrigin({
      page: 'https://localhost:3003/app/md/1',
      mode: 'development',
    });
    expect(getCopiedLinkOrigin()).toBe('https://dev.macro.com');
  });

  it('links a hosted page’s own host without its www prefix', async () => {
    const { getCopiedLinkOrigin } = await loadWebOrigin({
      page: 'https://www.macro.com/app/md/1',
    });
    expect(getCopiedLinkOrigin()).toBe('https://macro.com');
  });

  it.each([
    'http://localhost:8080/workspace/md/1',
    'https://www.example.org:8443/workspace/md/1',
  ])('links the origin serving a self-hosted instance: %s', async (page) => {
    const { getCopiedLinkOrigin } = await loadWebOrigin({
      backendOrigin: 'https://api.example.com',
      page,
    });
    expect(getCopiedLinkOrigin()).toBe(new URL(page).origin);
  });
});
