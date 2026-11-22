import { afterEach, describe, expect, it, vi } from 'vitest';
import { staticFileSizedUrl } from './servers';

describe('staticFileSizedUrl', () => {
  it.each([
    'data:image/png;base64,aW1hZ2U=',
    'blob:https://macro.com/avatar-id',
  ])('preserves embedded or local image sources: %s', (url) => {
    expect(staticFileSizedUrl(url, 'small')).toBe(url);
  });

  it('requests a thumbnail for uploaded images', () => {
    expect(
      staticFileSizedUrl('https://static.macro.com/file/avatar-id', 'small')
    ).toBe('https://static.macro.com/file/avatar-id?size=320');
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('keeps browser image URLs proxied but gives the agent a fetchable hosted URL', async () => {
  vi.stubEnv('MODE', 'development');
  vi.stubEnv('VITE_DEV_PROXY', 'true');
  vi.stubEnv('VITE_LOCAL_SERVERS', '');
  vi.stubGlobal('location', { origin: 'https://localhost:3003' });
  vi.resetModules();
  const { staticFileIdEndpoint, staticFileReferenceEndpoint } = await import(
    './servers'
  );
  expect(staticFileIdEndpoint('test-image')).toBe(
    'https://localhost:3003/__macro_dev/static/file/test-image'
  );
  expect(staticFileReferenceEndpoint('test-image')).toBe(
    'https://static-file-service-dev.macro.com/file/test-image'
  );
});

it('preserves local-stack image references for the local attachment resolver', async () => {
  vi.stubEnv('MODE', 'development');
  vi.stubEnv('VITE_DEV_PROXY', 'true');
  vi.stubEnv('VITE_LOCAL_SERVERS', 'ALL');
  vi.stubEnv('VITE_LOCAL_BACKEND_ORIGIN', 'https://localhost:27709');
  vi.stubGlobal('location', new URL('https://localhost:3003'));
  vi.resetModules();
  const { staticFileReferenceEndpoint } = await import('./servers');
  expect(staticFileReferenceEndpoint('test-image')).toBe(
    'https://localhost:27709/static-file/file/test-image'
  );
});

// Only a self-contained local stack's proxy keeps instances' cookies apart.
// `run_dev` serves the same proxy origin without those rules, and a hosted
// build must never take the handoff even if local settings leaked into it.
it.each([
  {
    name: 'run_local / just stack',
    mode: 'development',
    servers: 'ALL',
    backend: 'same-origin',
    stack: 'true',
    page: 'https://localhost:28009/app/login',
    expected: true,
  },
  {
    name: 'run_dev',
    mode: 'development',
    servers: 'ALL',
    backend: 'same-origin',
    stack: undefined,
    page: 'https://localhost:28009/app/login',
    expected: false,
  },
  {
    name: 'no proxy origin',
    mode: 'development',
    servers: 'ALL',
    backend: undefined,
    stack: 'true',
    page: 'https://localhost:28009/app/login',
    expected: false,
  },
  {
    name: 'hosted dev services',
    mode: 'development',
    servers: '',
    backend: 'same-origin',
    stack: 'true',
    page: 'https://localhost:28009/app/login',
    expected: false,
  },
  {
    name: 'production',
    mode: 'production',
    servers: undefined,
    backend: undefined,
    stack: undefined,
    page: 'https://macro.com/app/login',
    expected: false,
  },
  {
    name: 'production with leaked local settings',
    mode: 'production',
    servers: 'ALL',
    backend: 'same-origin',
    stack: 'true',
    page: 'https://macro.com/app/login',
    expected: false,
  },
])(
  'reports a local stack proxy for $name',
  async ({ mode, servers, backend, stack, page, expected }) => {
    vi.stubEnv('MODE', mode);
    vi.stubEnv('VITE_LOCAL_SERVERS', servers);
    vi.stubEnv('VITE_LOCAL_BACKEND_ORIGIN', backend);
    vi.stubEnv('VITE_LOCAL_STACK', stack);
    vi.stubGlobal('location', new URL(page));
    vi.resetModules();
    const { usesLocalStackProxy } = await import('./servers');
    expect(usesLocalStackProxy()).toBe(expected);
  }
);

// A self-hosted bundle is served from one host and calls its backend on
// another, so the configured origin must reach every client unchanged.
it('addresses every service under a self-hosted backend origin', async () => {
  vi.stubEnv('MODE', 'production');
  vi.stubEnv('VITE_BACKEND_ORIGIN', 'https://api.example.com');
  vi.stubEnv('BASE_URL', '/workspace');
  vi.stubGlobal('location', new URL('https://www.example.org/workspace/login'));
  vi.resetModules();
  const { SERVER_HOSTS, SYNC_SERVICE_HOSTS, selfHostedBackendUrl } =
    await import('./servers');

  expect(SERVER_HOSTS['auth-service']).toBe('https://api.example.com/auth');
  // The page sign-out leads to, as its server serves it without a redirect.
  expect(SERVER_HOSTS['auth-logout']).toBe(
    'https://www.example.org/workspace/'
  );
  // No storage socket service runs, so the session opens no such socket.
  expect(SERVER_HOSTS['websocket-service']).toBe('');
  expect(SERVER_HOSTS['connection-gateway']).toBe(
    'wss://api.example.com/connection-gateway'
  );
  expect(SYNC_SERVICE_HOSTS).toEqual({
    worker: 'https://api.example.com/sync',
    ws: 'wss://api.example.com/sync',
  });
  expect(selfHostedBackendUrl('/ai-editing')).toBe(
    'https://api.example.com/ai-editing'
  );

  const hostnames = new Set(
    Object.values(SERVER_HOSTS)
      .filter((host) => host !== '')
      .map((host) => new URL(host).hostname)
  );
  expect([...hostnames].sort()).toEqual(['api.example.com', 'www.example.org']);
});

// The backends of a self-hosted instance embed and fetch its own addresses,
// so nothing the bundle derives from them trusts or names a hosted host.
it('derives every backend-facing address from a self-hosted backend origin', async () => {
  vi.stubEnv('MODE', 'production');
  vi.stubEnv('VITE_BACKEND_ORIGIN', 'https://api.example.com');
  vi.stubGlobal('location', new URL('https://www.example.org/workspace/login'));
  vi.resetModules();
  const servers = await import('./servers');

  expect(servers.SELF_HOSTED).toBe(true);
  // Read-receipt pixels are recognised only at the instance's own email host.
  expect(servers.EMAIL_SERVICE_EMBEDDED_HOSTS).toEqual([
    'https://api.example.com/email',
  ]);
  expect(servers.staticFileReferenceEndpoint('image-1')).toBe(
    'https://api.example.com/static-file/file/image-1'
  );
  expect(servers.SYNC_PERMISSION_TOKEN_DSS_HOST).toBe(
    'https://api.example.com/dss'
  );
  for (const url of servers.NATIVE_SESSION_SERVICE_URLS) {
    expect(new URL(url).hostname).toBe('api.example.com');
  }
  expect(
    JSON.stringify([
      servers.SERVER_HOSTS,
      servers.SYNC_SERVICE_HOSTS,
      servers.NATIVE_SESSION_SERVICE_URLS,
      servers.EMAIL_SERVICE_EMBEDDED_HOSTS,
    ])
  ).not.toMatch(/macro\.com|macroverse/);
});

it('keeps the hosted services when no self-hosted origin is set', async () => {
  vi.stubEnv('MODE', 'production');
  vi.stubEnv('VITE_BACKEND_ORIGIN', undefined);
  vi.stubGlobal('location', new URL('https://macro.com/app/login'));
  vi.resetModules();
  const { SERVER_HOSTS, selfHostedBackendUrl } = await import('./servers');

  expect(SERVER_HOSTS['auth-service']).toBe('https://gateway.macro.com/auth');
  expect(selfHostedBackendUrl('/ai-editing')).toBeUndefined();
});

it('keeps the hosted sync, permission-token and mail hosts when no self-hosted origin is set', async () => {
  vi.stubEnv('MODE', 'production');
  vi.stubEnv('VITE_BACKEND_ORIGIN', undefined);
  vi.stubGlobal('location', new URL('https://macro.com/app/login'));
  vi.resetModules();
  const servers = await import('./servers');

  expect(servers.SELF_HOSTED).toBe(false);
  expect(servers.SYNC_SERVICE_HOSTS).toEqual({
    worker: 'https://sync-service-prod2.macroverse.workers.dev',
    ws: 'wss://sync-service-prod2.macroverse.workers.dev',
  });
  expect(servers.SYNC_PERMISSION_TOKEN_DSS_HOST).toBe(
    'https://gateway.macro.com/dss'
  );
  expect(servers.EMAIL_SERVICE_EMBEDDED_HOSTS).toEqual([
    'https://gateway.macro.com/email',
    'http://localhost:8087',
  ]);
  expect(servers.staticFileReferenceEndpoint('image-1')).toBe(
    'https://static-file-service.macro.com/file/image-1'
  );
});
