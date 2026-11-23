import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseInternalAppLink } from './macroAppUrl';

// One mock for every module instance, including those a test re-imports.
const isTauri = vi.hoisted(() => vi.fn(() => false));
vi.mock('@core/util/platform', () => ({ isTauri }));

afterEach(() => {
  isTauri.mockReturnValue(false);
});

// jsdom's window.location.hostname is 'localhost', which
// isValidMacroAppHostname pairs with dev.macro.com outside of Tauri.
describe('parseInternalAppLink', () => {
  it('parses a macro app link into path and query', () => {
    expect(
      parseInternalAppLink('https://dev.macro.com/app/component/abc?foo=bar')
    ).toEqual({ path: '/component/abc', query: 'foo=bar' });
  });

  it('keeps the fragment of a booking receipt link', () => {
    expect(
      parseInternalAppLink('https://dev.macro.com/app/booking/abc#token')
    ).toEqual({ path: '/booking/abc', query: '', fragment: 'token' });
  });

  it('maps a bare /app path to the router root', () => {
    expect(parseInternalAppLink('https://dev.macro.com/app')).toEqual({
      path: '/',
      query: '',
    });
  });

  it('accepts same-host links', () => {
    expect(
      parseInternalAppLink('http://localhost:3000/app/channel/123')
    ).toEqual({ path: '/channel/123', query: '' });
  });

  it('strips a www prefix from the hostname', () => {
    expect(parseInternalAppLink('https://www.dev.macro.com/app/x')).toEqual({
      path: '/x',
      query: '',
    });
  });

  it('does not treat a mid-string www. as a macro host', () => {
    // Only a leading `www.` is stripped, so `macro.www.com` (a subdomain of
    // the foreign `www.com`) must not collapse to `macro.com`. Checked under
    // Tauri, where localhost is paired with the prod/dev/staging hosts.
    isTauri.mockReturnValue(true);
    expect(
      parseInternalAppLink('https://macro.www.com/app/component/abc')
    ).toBeNull();
  });

  it('rejects non-/app paths on a macro host', () => {
    expect(parseInternalAppLink('https://dev.macro.com/pricing')).toBeNull();
    expect(parseInternalAppLink('https://dev.macro.com/apple')).toBeNull();
  });

  it('rejects /app paths on foreign hosts', () => {
    expect(
      parseInternalAppLink('https://evil.com/app/component/abc')
    ).toBeNull();
  });

  it('rejects prod macro links outside of Tauri when not on macro.com', () => {
    expect(
      parseInternalAppLink('https://macro.com/app/component/abc')
    ).toBeNull();
  });

  it('accepts prod macro links under Tauri', () => {
    isTauri.mockReturnValue(true);
    expect(parseInternalAppLink('https://macro.com/app/component/abc')).toEqual(
      {
        path: '/component/abc',
        query: '',
      }
    );
  });

  it('accepts staging macro links under Tauri', () => {
    isTauri.mockReturnValue(true);
    expect(
      parseInternalAppLink('https://staging.macro.com/app/component/abc')
    ).toEqual({
      path: '/component/abc',
      query: '',
    });
  });

  it('accepts macro links under Tauri when served from tauri.localhost', () => {
    // Under the http asset scheme (e.g. Windows/Android) the webview origin is
    // tauri.localhost, not localhost.
    isTauri.mockReturnValue(true);
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { hostname: 'tauri.localhost' },
    });
    try {
      expect(
        parseInternalAppLink('https://macro.com/app/component/abc')
      ).toEqual({ path: '/component/abc', query: '' });
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: original,
      });
    }
  });

  it('rejects invalid urls', () => {
    expect(parseInternalAppLink('not a url')).toBeNull();
    expect(parseInternalAppLink('/app/component/abc')).toBeNull();
  });
});

// A bundle served from another folder builds its links on that folder, so
// those are the links it opens in place; the hosted `/app` shape is foreign.
describe('parseInternalAppLink under another base path', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('reads links under the configured base and no other folder', async () => {
    vi.stubEnv('__APP_BASE_PATH__', '/workspace');
    vi.resetModules();
    const { parseInternalAppLink } = await import('./macroAppUrl');

    expect(
      parseInternalAppLink(
        'http://localhost:3000/workspace/channel/123?message=456'
      )
    ).toEqual({ path: '/channel/123', query: 'message=456' });
    expect(parseInternalAppLink('http://localhost:3000/workspace')).toEqual({
      path: '/',
      query: '',
    });
    expect(
      parseInternalAppLink('http://localhost:3000/app/channel/123')
    ).toBeNull();
    expect(
      parseInternalAppLink('http://localhost:3000/workspaces/channel/123')
    ).toBeNull();
  });
});

// A self-hosted instance is served from one host of its own: links to it open
// in place, and the hosted service's hosts are foreign wherever it runs.
describe('parseInternalAppLink in a self-hosted bundle', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function selfHostedParser() {
    vi.stubEnv('VITE_BACKEND_ORIGIN', 'https://api.example.com');
    vi.resetModules();
    return (await import('./macroAppUrl')).parseInternalAppLink;
  }

  it('opens links to the host serving it', async () => {
    const parse = await selfHostedParser();
    expect(parse('http://localhost:3000/app/channel/123')).toEqual({
      path: '/channel/123',
      query: '',
    });
  });

  it('treats the hosted development host as foreign on localhost', async () => {
    const parse = await selfHostedParser();
    expect(parse('https://dev.macro.com/app/component/abc')).toBeNull();
  });

  it('treats the hosted hosts as foreign under Tauri', async () => {
    isTauri.mockReturnValue(true);
    const parse = await selfHostedParser();
    expect(parse('https://macro.com/app/component/abc')).toBeNull();
    expect(parse('https://staging.macro.com/app/component/abc')).toBeNull();
  });
});
