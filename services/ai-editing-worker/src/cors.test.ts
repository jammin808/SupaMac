import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { isOriginAllowed, originCors, PREFLIGHT_MAX_AGE_SECONDS } from './cors';

describe('isOriginAllowed', () => {
  it('allows only development origins when ALLOWED_ORIGINS names none', () => {
    for (const configured of [undefined, '', ' , ']) {
      for (const origin of [
        'http://localhost:5173',
        'http://localhost:3000',
        'http://localhost:3999',
        'http://localhost:20010',
        'http://host.local:3000',
        'http://tauri.localhost',
        'tauri://localhost',
      ]) {
        expect(isOriginAllowed(origin, configured), origin).toBe(true);
      }
      for (const origin of [
        'https://example.com',
        'https://app.example.com',
        'https://feature.preview.example.com',
        'http://localhost:8080',
        'https://localhost:3000',
        'http://evil.localhost:3000',
        '',
      ]) {
        expect(isOriginAllowed(origin, configured), origin).toBe(false);
      }
    }
  });

  it('allows exactly the configured origins', () => {
    const configured = 'https://example.com, https://app.example.com';

    expect(isOriginAllowed('https://example.com', configured)).toBe(true);
    expect(isOriginAllowed('https://app.example.com', configured)).toBe(true);

    for (const origin of [
      'http://localhost:3000',
      'http://localhost:5173',
      'tauri://localhost',
      'http://example.com',
      'https://example.com:8443',
      'https://example.com/',
      'https://evil.example.com',
      'https://example.com.evil.test',
      '',
    ]) {
      expect(isOriginAllowed(origin, configured), origin).toBe(false);
    }
  });
});

describe('originCors', () => {
  const app = new Hono<{ Bindings: { ALLOWED_ORIGINS: string | undefined } }>();
  app.use('*', originCors());
  app.post('/edit', (c) => c.text('ok'));

  const env = { ALLOWED_ORIGINS: 'https://app.example.com' };

  it('answers a preflight from a configured origin', async () => {
    const response = await app.request(
      '/edit',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type, traceparent',
        },
      },
      env
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://app.example.com'
    );
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain(
      'POST'
    );
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
      'content-type,traceparent'
    );
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(response.headers.get('Access-Control-Max-Age')).toBe(
      String(PREFLIGHT_MAX_AGE_SECONDS)
    );
  });

  it('names no origin to a browser at any other origin', async () => {
    for (const origin of ['https://example.com', 'http://localhost:3000']) {
      const response = await app.request(
        '/edit',
        { method: 'POST', headers: { Origin: origin } },
        env
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('serves a caller that sends no Origin', async () => {
    const response = await app.request('/edit', { method: 'POST' }, env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
