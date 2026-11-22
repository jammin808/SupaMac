import { appRoutesManifest } from '@app/features/agent-navigation/tests/app-routes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { internalInviteLinksRoute, internalSystemStatusRoute } from './routes';

const build = vi.hoisted(() => ({ selfHosted: false }));
vi.mock(import('@core/constant/servers'), async (importOriginal) => ({
  ...(await importOriginal()),
  get SELF_HOSTED() {
    return build.selfHosted;
  },
}));

beforeEach(() => {
  build.selfHosted = false;
});

const STAFF_ROUTES = [
  internalInviteLinksRoute.id,
  internalSystemStatusRoute.id,
];

describe('staff pages', () => {
  it('are registered for the hosted service', () => {
    const { byId } = appRoutesManifest();
    for (const id of STAFF_ROUTES) expect(byId.has(id), id).toBe(true);
  });

  it('are not registered on a self-hosted instance', () => {
    build.selfHosted = true;
    const { byId } = appRoutesManifest();
    for (const id of STAFF_ROUTES) expect(byId.has(id), id).toBe(false);
    expect(byId.has('invite')).toBe(true);
  });
});
