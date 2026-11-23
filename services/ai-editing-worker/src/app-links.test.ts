import {
  configureAppLinks,
  isMacroBookingUrl,
  isStaticFileUrl,
} from '@macro-inc/lexical-core';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { type AppLinkBindings, appLinks } from './app-links';

function worker() {
  const app = new Hono<{ Bindings: AppLinkBindings }>();
  app.use('*', appLinks());
  app.get('/', (c) => c.text('ok'));
  return app;
}

afterEach(() => configureAppLinks({}));

describe('appLinks', () => {
  it('points converted documents at the configured deployment', async () => {
    const response = await worker().request('/', undefined, {
      APP_URL: 'https://team.example.com/workspace',
      STATIC_FILE_URL: 'https://api.example.com/static-file',
    });

    expect(response.status).toBe(200);
    expect(
      isStaticFileUrl('https://api.example.com/static-file/file/file-1')
    ).toBe(true);
    expect(
      isMacroBookingUrl('https://team.example.com/workspace/book/profile-1')
    ).toBe(true);
    expect(
      isMacroBookingUrl('https://other.example.net/app/book/profile-1')
    ).toBe(false);
  });

  it('leaves the defaults, which trust no host, when nothing is set', async () => {
    const response = await worker().request('/', undefined, {
      APP_URL: '',
      STATIC_FILE_URL: undefined,
    });

    expect(response.status).toBe(200);
    expect(isStaticFileUrl('https://static.example.net/file/file-1')).toBe(
      false
    );
    expect(
      isMacroBookingUrl('https://other.example.net/app/book/profile-1')
    ).toBe(false);
  });

  it('refuses a request when a value is not a URL', async () => {
    const response = await worker().request('/', undefined, {
      APP_URL: 'not a url',
      STATIC_FILE_URL: undefined,
    });

    expect(response.status).toBe(500);
  });
});
