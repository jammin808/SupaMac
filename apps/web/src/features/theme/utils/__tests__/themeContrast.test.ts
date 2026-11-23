// @vitest-environment node
import { readFileSync } from 'node:fs';
import Color from 'colorjs.io';
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEMES } from '../../themes';
import { resolveGraph } from '../resolvedThemeColors';
import { normalizeThemeColorTokens } from '../themeColorTokens';

// WCAG 2 success criteria 1.4.3 (text below 18pt) and 1.4.11 (the parts of a
// control that show its state), both level AA.
const MINIMUM_TEXT_CONTRAST = 4.5;
const MINIMUM_INDICATOR_CONTRAST = 3;

const TEXT_TOKENS = [
  'link',
  'link-hover',
  'link-visited',
  'ink-placeholder',
] as const;
const SURFACE_TOKENS = [
  'surface-0',
  'surface-1',
  'surface-2',
  'surface-3',
  'surface-4',
] as const;
const LIGHT_THEMES = DEFAULT_THEMES.filter((theme) => theme.mode === 'light');
const WHITE = new Color('white');

// WCAG defines relative luminance on sRGB, so a color outside that gamut is
// measured as an sRGB display paints it: clipped per channel.
function painted(color: Color): Color {
  return color.to('srgb').toGamut({ space: 'srgb', method: 'clip' });
}

function contrast(first: Color, second: Color): number {
  return painted(first).contrastWCAG21(painted(second));
}

// Browsers composite a translucent color over its backdrop in sRGB.
function over(color: Color, alpha: number, backdrop: Color): Color {
  const top = painted(color).coords;
  const bottom = painted(backdrop).coords;

  return new Color('srgb', [
    top[0] * alpha + bottom[0] * (1 - alpha),
    top[1] * alpha + bottom[1] * (1 - alpha),
    top[2] * alpha + bottom[2] * (1 - alpha),
  ]);
}

describe('light theme text contrast', () => {
  it('covers every built-in light theme', () => {
    expect(LIGHT_THEMES.map((theme) => theme.id)).toEqual([
      'Macro Light',
      'Satsuma',
      'Lapis',
      'Flora',
      'Paper',
      'Decepticon',
    ]);
  });

  describe.each(LIGHT_THEMES)('$id', (theme) => {
    const resolve = resolveGraph(
      normalizeThemeColorTokens(theme.colorTokens, theme.mode)
    );

    it.each(TEXT_TOKENS)('%s reads on white and on the page', (token) => {
      const text = resolve(token);
      const page = resolve('page');

      // A translucent color has no contrast of its own: it depends on what
      // lies beneath it.
      expect(text?.alpha).toBe(1);
      expect(page?.alpha).toBe(1);
      if (!text || !page) return;

      expect(contrast(text, WHITE)).toBeGreaterThanOrEqual(
        MINIMUM_TEXT_CONTRAST
      );
      expect(contrast(text, page)).toBeGreaterThanOrEqual(
        MINIMUM_TEXT_CONTRAST
      );
    });
  });
});

describe('keyboard focus outline contrast', () => {
  // The outline is the theme's ink at the share index.css gives --button-focus.
  const stylesheet = readFileSync(
    new URL('../../../../index.css', import.meta.url),
    'utf8'
  );
  const inkShare = stylesheet.match(
    /--button-focus: color-mix\(in oklch, var\(--color-content-0\) ([\d.]+)%, transparent\);/
  )?.[1];

  it('reads the ink share of the outline from the stylesheet', () => {
    expect(Number(inkShare)).toBeGreaterThan(0);
    expect(Number(inkShare)).toBeLessThanOrEqual(100);
  });

  describe.each(DEFAULT_THEMES)('$id', (theme) => {
    const resolve = resolveGraph(
      normalizeThemeColorTokens(theme.colorTokens, theme.mode)
    );

    it.each(SURFACE_TOKENS)('stands out from %s', (token) => {
      const ink = resolve('content-0');
      const surface = resolve(token);

      expect(ink?.alpha).toBe(1);
      expect(surface?.alpha).toBe(1);
      if (!ink || !surface) return;

      const outline = over(ink, Number(inkShare) / 100, surface);
      expect(contrast(outline, surface)).toBeGreaterThanOrEqual(
        MINIMUM_INDICATOR_CONTRAST
      );
    });
  });
});
