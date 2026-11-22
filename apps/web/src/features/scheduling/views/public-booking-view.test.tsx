import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PublicProfile } from '../core/types';
import type { BookingSource } from '../primitives/booking-flow';
import { PublicBookingView } from './public-booking-view';

const build = vi.hoisted(() => ({ selfHosted: false }));
vi.mock(import('@core/constant/servers'), async (importOriginal) => ({
  ...(await importOriginal()),
  get SELF_HOSTED() {
    return build.selfHosted;
  },
}));

const profile: PublicProfile = {
  id: 'team',
  name: 'Macro',
  description: 'Meet the team.',
  eventTypes: [],
};

function renderPage(embedded?: boolean) {
  render(() => (
    <PublicBookingView
      profile={profile}
      source={{} as BookingSource}
      onEvent={() => {}}
      onReceipt={() => {}}
      embedded={embedded}
    />
  ));
}

beforeEach(() => {
  build.selfHosted = false;
});

afterEach(cleanup);

it('carries the Macro name when it is the whole page', () => {
  renderPage();

  expect(
    screen
      .getByRole('link', { name: /SupaMac\s*Scheduling/ })
      .getAttribute('href')
  ).toBe('https://macro.com');
  expect(screen.getByText('Scheduling by SupaMac')).toBeTruthy();
});

it('names a self-hosted instance without linking to the hosted product', () => {
  build.selfHosted = true;
  renderPage();

  expect(screen.getByText('/ Scheduling')).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByText('Scheduling by SupaMac')).toBeTruthy();
});

it('leaves the Macro name to the page that embeds it', () => {
  renderPage(true);

  expect(screen.getByRole('heading', { name: 'Macro' })).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.queryByText('Scheduling by SupaMac')).toBeNull();
});
