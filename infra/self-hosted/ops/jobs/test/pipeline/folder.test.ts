// The Job intake folder's rules (docs/supamac/jobs.md §1): only documents
// owned by the owner or the service are read, only once their bytes are
// stored; anything else stays where it is, unread.

import { afterEach, describe, expect, test } from 'bun:test';
import { INVITE_PDF } from './fixtures';
import { cleanup, makeWorld, type World } from './harness';

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await cleanup(w);
});

describe('the Job intake folder', () => {
  test('a document someone else owns is skipped, left in place and never downloaded', async () => {
    const w = await makeWorld([]);
    worlds.push(w);
    const doc = w.store.drop(
      'invite.pdf',
      INVITE_PDF,
      'intake',
      'macro|someone.else@example.com'
    );
    const polled = await w.pipeline.pollFolder();
    expect(polled.skipped).toEqual([
      {
        documentId: doc.id,
        why: 'owned by someone other than the owner or the service',
      },
    ]);
    expect(polled.processed).toEqual([]);
    expect(w.store.documents.get(doc.id)?.folder).toBe('intake');
    expect(w.store.calls).not.toContain('downloadDocument');
    expect(w.store.rows('sources')).toEqual([]);
    expect(w.model.requests).toEqual([]);
  });

  test('a document whose bytes are not stored yet is left for a later poll, not downloaded', async () => {
    const w = await makeWorld([]);
    worlds.push(w);
    const doc = w.store.drop('invite.pdf', INVITE_PDF);
    doc.readiness = 'pending';
    const polled = await w.pipeline.pollFolder();
    expect(polled.skipped).toEqual([
      { documentId: doc.id, why: 'its bytes are not stored yet' },
    ]);
    expect(w.store.documents.get(doc.id)?.folder).toBe('intake');
    expect(w.store.calls).not.toContain('downloadDocument');
    expect(w.store.rows('sources')).toEqual([]);
  });
});
