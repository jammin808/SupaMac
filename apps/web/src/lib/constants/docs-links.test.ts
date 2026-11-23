import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('documentation links', () => {
  it('links the hosted documentation site', async () => {
    vi.stubEnv('VITE_BACKEND_ORIGIN', undefined);
    vi.resetModules();
    const { docsUrl, LIST_VIEW_DOCS_URL } = await import('./docs-links');

    expect(docsUrl('/product/email')).toBe(
      'https://docs.macro.com/product/email'
    );
    expect(LIST_VIEW_DOCS_URL.mail).toBe(
      'https://docs.macro.com/product/email'
    );
  });

  it('links nothing from a self-hosted bundle', async () => {
    vi.stubEnv('VITE_BACKEND_ORIGIN', 'https://api.example.com');
    vi.resetModules();
    const { docsUrl, LIST_VIEW_DOCS_URL } = await import('./docs-links');

    expect(docsUrl('/product/email')).toBeUndefined();
    expect(LIST_VIEW_DOCS_URL).toEqual({});
  });
});
