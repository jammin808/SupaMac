import type { LexicalEditor } from 'lexical';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@core/signal/mention', () => ({ trackMention: vi.fn() }));
// The block table loads every block module; booking links never need it.
vi.mock('@core/constant/allBlocks', () => ({ fileTypeToBlockName: vi.fn() }));
vi.mock('../../../../plugins', () => ({
  REMOVE_INLINE_SEARCH_COMMAND: 'remove-search',
}));
vi.mock('../../../../plugins/mentions', () => ({
  INSERT_BOOKING_LINK_MENTION_COMMAND: 'insert-booking-link',
}));
vi.mock('../../../../utils/mentionsUtils', () => ({
  handleUserMention: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function insertBookingLink(page: string): Promise<unknown> {
  vi.stubGlobal('location', new URL(page));
  vi.resetModules();
  const { createItemHandler } = await import('./mentionHandlers');
  const dispatchCommand = vi.fn();
  await createItemHandler({
    editor: { dispatchCommand } as unknown as LexicalEditor,
    blockId: 'channel-1',
    blockName: 'channel',
  })({
    kind: 'bookingLink',
    id: 'link-1',
    data: {
      profileId: 'profile 1',
      slug: 'intro',
      title: 'Intro call',
      durationMinutes: 30,
      owner: 'macro|alex@example.com',
    },
  });
  return dispatchCommand.mock.calls.find(
    ([command]) => command === 'insert-booking-link'
  )?.[1];
}

it('links a booking page on the origin serving a self-hosted instance', async () => {
  vi.stubEnv('VITE_BACKEND_ORIGIN', 'https://api.example.com');
  vi.stubEnv('__APP_BASE_PATH__', '/workspace');

  expect(
    await insertBookingLink('http://localhost:8080/workspace/channel/1')
  ).toEqual({
    profileId: 'profile 1',
    slug: 'intro',
    label: 'Intro call',
    url: 'http://localhost:8080/workspace/book/profile%201/intro',
  });
});

it('links a local hosted page’s booking page on the hosted development deployment', async () => {
  vi.stubEnv('VITE_BACKEND_ORIGIN', undefined);

  expect(
    await insertBookingLink('https://localhost:3003/app/channel/1')
  ).toMatchObject({
    url: 'https://dev.macro.com/app/book/profile%201/intro',
  });
});
