import { afterEach, describe, expect, it, vi } from 'vitest';

const build = vi.hoisted(() => ({ selfHosted: false }));
vi.mock(import('@core/constant/servers'), async (importOriginal) => ({
  ...(await importOriginal()),
  get SELF_HOSTED() {
    return build.selfHosted;
  },
}));

afterEach(() => vi.resetModules());

/** `keepsSenderFonts` as a bundle of the given kind defines it. */
async function keepsSenderFonts(selfHosted: boolean) {
  build.selfHosted = selfHosted;
  return (await import('./email-message-body')).keepsSenderFonts;
}

describe('keepsSenderFonts', () => {
  it('keeps the fonts of the hosted service’s own mail', async () => {
    const keeps = await keepsSenderFonts(false);
    expect(keeps('Team@Macro.com')).toBe(true);
    expect(keeps('person@example.com')).toBe(false);
    expect(keeps(undefined)).toBe(false);
  });

  it('normalizes every sender’s fonts on a self-hosted instance', async () => {
    const keeps = await keepsSenderFonts(true);
    expect(keeps('team@macro.com')).toBe(false);
    expect(keeps('person@example.com')).toBe(false);
  });
});
