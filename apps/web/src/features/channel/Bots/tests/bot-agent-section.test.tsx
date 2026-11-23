import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

const build = vi.hoisted(() => ({ selfHosted: false }));
vi.mock(import('@core/constant/servers'), async (importOriginal) => ({
  ...(await importOriginal()),
  get SELF_HOSTED() {
    return build.selfHosted;
  },
}));

afterEach(() => {
  cleanup();
  vi.resetModules();
});

/** The section as a bundle of the given kind renders it. */
async function renderSection(selfHosted: boolean) {
  build.selfHosted = selfHosted;
  const { BotAgentSection } = await import('../BotAgentSection');
  render(() => <BotAgentSection checked onChange={() => {}} />);
}

describe('BotAgentSection', () => {
  it('links the hosted service’s agent setup guide', async () => {
    await renderSection(false);
    expect(
      screen
        .getByRole('link', { name: 'Connecting an agent? View setup guide' })
        .getAttribute('href')
    ).toBe('https://macro.com/docs/AI/bring-your-own');
  });

  it('links no guide on a self-hosted instance', async () => {
    await renderSection(true);
    expect(screen.queryByRole('link')).toBeNull();
    expect(
      screen.getByRole('switch', { name: 'Enable AI agent' })
    ).toBeTruthy();
  });
});
