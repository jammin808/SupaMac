import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HelpMenu } from './help-menu';

const build = vi.hoisted(() => ({ selfHosted: false }));
vi.mock(import('@core/constant/servers'), async (importOriginal) => ({
  ...(await importOriginal()),
  get SELF_HOSTED() {
    return build.selfHosted;
  },
}));

const support = vi.hoisted(() => ({ created: 0 }));
vi.mock('@app/features/video-tutorials/primitives/create-support-link', () => ({
  createSupportLink: () => {
    support.created += 1;
    return { channelId: () => undefined, open: () => {} };
  },
}));

beforeEach(() => {
  build.selfHosted = false;
  support.created = 0;
});

afterEach(cleanup);

describe('HelpMenu', () => {
  it('offers help on the hosted service', () => {
    render(() => <HelpMenu />);
    expect(screen.getByRole('button', { name: 'Help' })).toBeTruthy();
  });

  it('shows nothing on a self-hosted instance', () => {
    build.selfHosted = true;
    render(() => <HelpMenu />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(support.created).toBe(0);
  });
});
