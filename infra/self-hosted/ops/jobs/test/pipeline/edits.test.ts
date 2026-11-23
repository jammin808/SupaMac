import { afterEach, describe, expect, test } from 'bun:test';
import { historyInput } from '../../src/pipeline/edits';
import { extract } from '../../src/text/extract';
import { EMAIL_REPLY, INVITE_PDF_REPLY, inviteEmail } from './fixtures';
import { cleanup, makeWorld, type World } from './harness';

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await cleanup(w);
});

async function booked(): Promise<{ w: World; jobId: string }> {
  const w = await makeWorld(
    [
      { marker: 'S1: "Leeds Lights Gala - booking"', reply: EMAIL_REPLY },
      { marker: 'S1: "invite.pdf"', reply: INVITE_PDF_REPLY },
    ],
    { extract: (bytes, hint) => extract(bytes, hint) }
  );
  worlds.push(w);
  await w.pipeline.pollEdits();
  await w.pipeline.processEmail({ raw: inviteEmail() });
  const [job] = w.store.rows('jobs');
  return { w, jobId: (job as [string, unknown])[0] };
}

function jobValues(w: World, id: string): Record<string, unknown> {
  return w.store.values('jobs', id) ?? {};
}

describe('the change poll', () => {
  test('starts at the tables’ versions as they are, without replaying their history', async () => {
    const w = await makeWorld([], {
      extract: (bytes, hint) => extract(bytes, hint),
    });
    worlds.push(w);
    const id = w.store.add(
      'details',
      { Name: 'Venue: Acme Arena', Field: 'Venue', Status: 'Confirmed' },
      'agent'
    );
    const first = await w.pipeline.pollEdits();
    expect(first.report.agent).toEqual([]);
    expect(w.store.values('details', id)?.Status).toBe('Confirmed');
    expect(first.tables.map((t) => t.changes)).toEqual([0, 0, 0]);
  });

  test('skips the service’s own writes and reads nothing twice', async () => {
    const { w } = await booked();
    const poll = await w.pipeline.pollEdits();
    expect(poll.tables.every((t) => t.changes === 0)).toBe(true);
    expect(poll.report).toEqual({ agent: [], unchecked: [] });
  });

  test('an owner’s typed Jobs cell stays, and the next derivation leaves it', async () => {
    const { w, jobId } = await booked();
    w.store.edit(
      'jobs',
      jobId,
      { Venue: 'Acme Arena (Hall 2)', Booking: 'Booked' },
      'owner'
    );
    const poll = await w.pipeline.pollEdits();
    expect(poll.jobs).toContain(jobId);
    expect(jobValues(w, jobId)).toMatchObject({
      Venue: 'Acme Arena (Hall 2)',
      Booking: 'Booked',
    });
  });

  test('an agent’s change to a Jobs row is undone and reported', async () => {
    const { w, jobId } = await booked();
    const before = jobValues(w, jobId);
    w.store.edit(
      'jobs',
      jobId,
      { Venue: 'Somewhere else', Booking: 'Cancelled' },
      'agent'
    );
    const poll = await w.pipeline.pollEdits();
    expect(jobValues(w, jobId).Venue).toBe(before.Venue);
    expect(jobValues(w, jobId).Booking ?? null).toBeNull();
    expect(poll.report.agent).toEqual([
      expect.objectContaining({
        table: 'jobs',
        rowId: jobId,
        action: 'undone',
        actingBot: 'assistant',
      }),
    ]);
  });

  test('an agent’s change is not undone over a later change of the owner’s', async () => {
    const { w } = await booked();
    const [rateId] = w.store
      .rows('details')
      .find(([, v]) => v.Field === 'Rate') as [string, unknown];
    w.store.edit('details', rateId, { Status: 'Confirmed' }, 'agent');
    w.store.edit('details', rateId, { Status: 'Confirmed' }, 'owner');
    const poll = await w.pipeline.pollEdits();
    expect(w.store.values('details', rateId)?.Status).toBe('Confirmed');
    expect(poll.report.agent).toEqual([
      expect.objectContaining({ rowId: rateId, action: 'reported' }),
    ]);
    expect(w.state.value.details[rateId]).toMatchObject({
      decidedVia: 'supamac',
    });
  });

  test('a detail an agent adds is set for review; one the owner adds is the owner’s', async () => {
    const { w, jobId } = await booked();
    const byAgent = w.store.add(
      'details',
      {
        Name: 'Catering: hot meal',
        Job: [jobId],
        Field: 'Catering',
        Value: 'hot meal',
        Status: 'Found',
      },
      'agent'
    );
    const byOwner = w.store.add(
      'details',
      {
        Name: 'Dress code: show blacks',
        Job: [jobId],
        Field: 'Dress code',
        Value: 'show blacks',
        Status: 'Confirmed',
      },
      'owner'
    );
    await w.pipeline.pollEdits();
    expect(w.store.values('details', byAgent)).toMatchObject({
      Status: 'Needs review',
    });
    expect(String(w.store.values('details', byAgent)?.Check)).toContain(
      'added by the assistant'
    );
    expect(w.state.value.details[byOwner]).toEqual({
      history: false,
      origin: 'owner',
    });
  });

  test('a Status the owner’s account sets to Found is not taken, and is listed for the next summary', async () => {
    const { w } = await booked();
    const [hotelId] = w.store
      .rows('details')
      .find(([, v]) => v.Field === 'Hotel') as [string, unknown];
    w.store.edit('details', hotelId, { Status: 'Found' }, 'owner');
    await w.pipeline.pollEdits();
    expect(w.store.values('details', hotelId)?.Status).toBe('Needs review');
    expect(String(w.store.values('details', hotelId)?.Check)).toContain(
      'set to Found in SupaMac'
    );
    expect(w.state.value.notes.decidedInSupamac).toEqual([
      expect.objectContaining({
        detailId: hotelId,
        status: 'Needs review (set to Found in SupaMac, which is not taken)',
      }),
    ]);
  });

  test('a detail an agent moves to another job goes back, and the job it reached is derived again', async () => {
    const { w, jobId } = await booked();
    const other = w.store.add('jobs', { Name: 'York Light Night' }, 'agent');
    await w.pipeline.pollEdits();
    const [venueId] = w.store
      .rows('details')
      .find(([, v]) => v.Field === 'Venue') as [string, unknown];
    w.store.edit('details', venueId, { Job: [other] }, 'agent');
    const poll = await w.pipeline.pollEdits();
    expect(w.store.values('details', venueId)?.Job).toEqual([jobId]);
    expect(w.store.values('details', venueId)?.Status).toBe('Found');
    expect(poll.jobs).toContain(other);
    expect(jobValues(w, other).Venue ?? null).toBeNull();
    expect(poll.report.agent).toEqual([
      expect.objectContaining({ rowId: venueId, action: 'undone' }),
    ]);
  });

  test('a journal that cannot list every change derives every job again and says which table', async () => {
    const { w, jobId } = await booked();
    w.store.incomplete.add('details');
    const poll = await w.pipeline.pollEdits();
    expect(poll.jobs).toEqual([jobId]);
    expect(poll.report.unchecked).toEqual(['Details']);
    expect(w.notifier.of('edits').at(-1)?.unchecked).toEqual(['Details']);
  });
});

describe('historyInput', () => {
  test('reads each kind of cell, and refuses one it cannot write back', async () => {
    const w = await makeWorld([], {
      extract: (bytes, hint) => extract(bytes, hint),
    });
    worlds.push(w);
    const jobs = w.store.schema.tables.jobs.columns;
    expect(
      historyInput(jobs.Venue, { type: 'text', value: 'Acme Arena' })
    ).toEqual({ ok: true, value: 'Acme Arena' });
    expect(historyInput(jobs.Rate, { type: 'number', value: 350 })).toEqual({
      ok: true,
      value: 350,
    });
    expect(
      historyInput(jobs.Dates, {
        type: 'date_range',
        value: { start: '2027-03-12T00:00:00Z', end: '2027-03-13T00:00:00Z' },
      })
    ).toEqual({
      ok: true,
      value: { start: '2027-03-12', end: '2027-03-13' },
    });
    const booked = jobs.Booking.options.get('Booked')?.id as string;
    expect(
      historyInput(jobs.Booking, { type: 'options', value: [{ id: booked }] })
    ).toEqual({ ok: true, value: 'Booked' });
    expect(
      historyInput(jobs.Booking, {
        type: 'options',
        value: [{ id: 'not-an-option' }],
      })
    ).toEqual({ ok: false });
    expect(historyInput(jobs['Not confirmed'], undefined)).toEqual({
      ok: true,
      value: [],
    });
    expect(historyInput(jobs.Venue, { type: 'number', value: 1 })).toEqual({
      ok: false,
    });
  });
});
