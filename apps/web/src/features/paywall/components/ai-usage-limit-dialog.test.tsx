/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiUsageLimitDialogView } from './ai-usage-limit-dialog';

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AiUsageLimitDialogView', () => {
  it('sends a Free user to the plans', async () => {
    const onOpenSettings = vi.fn();
    render(() => (
      <AiUsageLimitDialogView
        open
        code="ai_free_allowance_exhausted"
        freePlan
        onClose={() => {}}
        onOpenSettings={onOpenSettings}
      />
    ));

    expect(
      await screen.findByText('Subscribe to a paid plan to keep going.')
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View plans' }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('only names the limit when nothing is sold', async () => {
    const onClose = vi.fn();
    render(() => (
      <AiUsageLimitDialogView
        open
        code="ai_free_allowance_exhausted"
        freePlan
        noticeOnly
        onClose={onClose}
        onOpenSettings={() => {}}
      />
    ));

    expect(
      await screen.findByText("You've used this month's free AI")
    ).toBeTruthy();
    expect(
      screen.queryByText('Subscribe to a paid plan to keep going.')
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'View plans' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
