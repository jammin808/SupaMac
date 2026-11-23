import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from './product';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function read(path: string): string {
  return readFileSync(join(WEB_ROOT, path), 'utf8');
}

// The HTML entries and the web manifest are static, so they cannot import the
// name.
describe('the static shell', () => {
  it('titles the page with the product name', () => {
    const html = read('index.html');
    expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toBe(PRODUCT_NAME);
    expect(
      /<meta name="description" content="([^"]*)"/.exec(html)?.[1]
    ).toContain(PRODUCT_NAME);
  });

  it('titles the app connection page with the product name', () => {
    const html = read('pipedream-connect.html');
    expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toContain(PRODUCT_NAME);
  });

  it('names the installed app after the product and ships every icon it lists', () => {
    const manifest: {
      name: string;
      short_name: string;
      icons: { src: string }[];
    } = JSON.parse(read('public/manifest.json'));

    expect(manifest.name).toBe(PRODUCT_NAME);
    expect(manifest.short_name).toBe(PRODUCT_NAME);
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      // Icon paths are relative to the manifest, which sits in public/.
      expect(icon.src.startsWith('./'), icon.src).toBe(true);
      expect(
        existsSync(join(WEB_ROOT, 'public', icon.src.slice(2))),
        icon.src
      ).toBe(true);
    }
  });

  it('points icon and manifest links at files in public, by root path', () => {
    const html = read('index.html');
    const links = [
      ...html.matchAll(/<link\s[^>]*rel="([^"]+)"[^>]*href="([^"]+)"/g),
    ]
      .filter(([, rel]) => /icon|manifest/.test(rel))
      .map(([, , href]) => href);

    expect(links.length).toBe(4);
    for (const href of links) {
      // The build rewrites `/<file in public>` onto the bundle's folder; any
      // other spelling would leave the link at the site root or off the site.
      expect(href, href).toMatch(/^\/[^/]/);
      expect(existsSync(join(WEB_ROOT, 'public', href)), href).toBe(true);
    }
  });

  it('lets people pinch to zoom', () => {
    const viewport = /<meta\s+name="viewport"\s+content="([^"]*)"/.exec(
      read('index.html')
    )?.[1];
    expect(viewport).toBeDefined();
    expect(viewport).not.toMatch(/user-scalable|maximum-scale/);
  });
});
