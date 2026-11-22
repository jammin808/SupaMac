import './polyfills/prism';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  configureAppLinks,
  isMacroBookingUrl,
  isStaticFileUrl,
} from '@macro-inc/lexical-core';
import { configureAppLinksFromEnv } from './app-links';

afterEach(() => configureAppLinks({}));

describe('configureAppLinksFromEnv', () => {
  it('points converted documents at the configured deployment', () => {
    configureAppLinksFromEnv({
      APP_URL: 'https://team.example.com/workspace',
      STATIC_FILE_URL: 'https://api.example.com/static-file',
    });

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

  it('trusts no host when nothing is set', () => {
    configureAppLinksFromEnv({ APP_URL: '' });

    expect(isStaticFileUrl('https://static.example.net/file/file-1')).toBe(
      false
    );
    expect(
      isMacroBookingUrl('https://other.example.net/app/book/profile-1')
    ).toBe(false);
  });

  it('refuses a value that is not a URL', () => {
    expect(() => configureAppLinksFromEnv({ APP_URL: 'not a url' })).toThrow();
  });
});
