import { createRoot } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useComposePaidAccess } from './compose-paid-access';

const build = vi.hoisted(() => ({ selfHosted: false }));
vi.mock(import('@core/constant/servers'), async (importOriginal) => ({
  ...(await importOriginal()),
  get SELF_HOSTED() {
    return build.selfHosted;
  },
}));

const license = vi.hoisted(() => ({ paid: false }));
vi.mock('@core/auth/license', () => ({
  useHasPaidAccess: () => () => license.paid,
}));

afterEach(() => {
  build.selfHosted = false;
  license.paid = false;
});

const composePaidAccess = () =>
  createRoot((dispose) => {
    const paid = useComposePaidAccess()();
    dispose();
    return paid;
  });

describe('useComposePaidAccess', () => {
  it('follows the license on the hosted service', () => {
    expect(composePaidAccess()).toBe(false);
    license.paid = true;
    expect(composePaidAccess()).toBe(true);
  });

  it('never owes the watermark on a self-hosted instance', () => {
    build.selfHosted = true;
    expect(composePaidAccess()).toBe(true);
  });
});
