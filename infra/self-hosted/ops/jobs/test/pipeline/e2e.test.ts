// The pipeline end to end, on an in-memory SupaMac, a scripted model behind
// the real AI client and real extraction in the sandbox: one owner's sources
// arriving over a week, in order. Each test continues from the last.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Notice } from '../../src/pipeline/notify';
import type { SourceResult } from '../../src/pipeline/process';
import {
  CALL_SHEET_PDF,
  CALL_SHEET_REPLY,
  EMAIL_REPLY,
  HOTEL_PDF,
  HOTEL_REPLY,
  INVITE_PDF_REPLY,
  inviteEmail,
  PHOTO,
  PO_PDF,
  PO_REPLY,
} from './fixtures';
import { cleanup, makeWorld, restart, type World } from './harness';
import { gif } from '../text/build';

const SCRIPT = [
  { marker: 'S1: "Leeds Lights Gala - booking"', reply: EMAIL_REPLY },
  { marker: 'S1: "invite.pdf"', reply: INVITE_PDF_REPLY },
  { marker: 'S1: "call-sheet-v2.pdf"', reply: CALL_SHEET_REPLY },
  { marker: 'S1: "hotel.pdf"', reply: HOTEL_REPLY },
  { marker: 'S1: "PO-4500123.pdf"', reply: PO_REPLY },
  { marker: 'S1: "photo.png"', reply: 'refusal' as const },
];

let world: World;

beforeAll(async () => {
  world = await makeWorld(SCRIPT);
  // The change poll starts from the tables' versions as they are now.
  await world.pipeline.pollEdits();
});

const DAY = 86_400_000;

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

afterAll(async () => {
  await cleanup(world);
});

function sources(): Record<string, unknown>[] {
  return world.store.rows('sources').map(([id, v]) => ({ id, ...v }));
}

function source(name: string): Record<string, unknown> {
  const found = sources().find((s) => s.Name === name);
  if (found === undefined) throw new Error(`no source ${name}`);
  return found;
}

function detailsOf(sourceId: string): Record<string, unknown>[] {
  return world.store
    .rows('details')
    .filter(([, v]) =>
      ((v['Source row'] as string[] | undefined) ?? []).includes(sourceId)
    )
    .map(([id, v]) => ({ id, ...v }));
}

function jobs(): Record<string, unknown>[] {
  return world.store.rows('jobs').map(([id, v]) => ({ id, ...v }));
}

function theJob(): Record<string, unknown> {
  const all = jobs();
  expect(all).toHaveLength(1);
  return all[0] as Record<string, unknown>;
}

function summaries(): Extract<Notice, { kind: 'summary' }>['value'][] {
  return world.notifier.of('summary');
}

function detail(
  sourceName: string,
  field: string,
  value?: string
): Record<string, unknown> {
  const src = source(sourceName);
  const found = detailsOf(src.id as string).find(
    (d) => d.Field === field && (value === undefined || d.Value === value)
  );
  if (found === undefined)
    throw new Error(`no ${field} detail of ${sourceName}`);
  return found;
}

describe('a week of sources', () => {
  let first: SourceResult;

  test('an invite email with a PDF attachment creates a job with Found and Needs review details', async () => {
    first = await world.pipeline.processEmail({
      raw: inviteEmail(),
      from: 'jo@acme-productions.example.com',
    });
    expect(first.kind).toBe('finished');
    expect(first.children).toHaveLength(1);
    expect(world.model.requests).toHaveLength(2);

    const email = source('Leeds Lights Gala - booking');
    expect(email.Via).toBe('Email');
    expect(email.Status).toBe('Processed');
    expect(email['Message ID']).toBe('<invite-1@acme-productions.example.com>');
    expect(email.Sent).toBe('2027-03-01T09:00:00.000Z');
    expect(email.Kind).toBe('Invite');
    expect(email['Input tokens']).toBe(3_000);

    const pdf = source('invite.pdf');
    expect(pdf.Status).toBe('Needs review');
    expect(pdf.Sent).toBe('2027-03-01');
    expect(pdf.Document).toBeString();
    expect(pdf.Text).toBeString();

    const job = theJob();
    expect(job.Name).toBe('Leeds Lights Gala');
    expect(email.Job).toEqual([job.id]);
    expect(pdf.Job).toEqual([job.id]);
    expect(job.Booking).toBeUndefined();
    expect(job.Client).toBe('Example Arts Trust');
    expect(job.Venue).toBe('Acme Arena, Example Way, Leeds ZZ1 1ZZ');
    expect(job.Dates).toEqual({ start: '2027-03-12', end: '2027-03-13' });
    expect(job['PO number']).toBe('4500123');
    expect(job['Call times']).toBe(
      'Fri 12 Mar 2027: 07:00; Sat 13 Mar 2027: 07:30'
    );
    expect(job.Rate).toBe(350);
    expect(job['Needs review']).toBe(1);
    expect(job['Not confirmed']).toContain('Venue');

    expect(detail('invite.pdf', 'Call time', '07:30').Status).toBe('Found');
    expect(detail('invite.pdf', 'Call time', '07:30').Day).toBe('2027-03-13');
    const hotel = detail('invite.pdf', 'Hotel');
    expect(hotel.Status).toBe('Needs review');
    expect(String(hotel.Name)).toStartWith('Unconfirmed · Hotel: ');
    expect(String(hotel.Check)).toContain("'tbc'");

    const [emailSummary, pdfSummary] = summaries();
    expect(emailSummary?.jobs).toEqual([
      { id: job.id as string, name: 'Leeds Lights Gala', created: true },
    ]);
    expect(pdfSummary?.counts).toMatchObject({
      details: 5,
      found: 4,
      needsReview: 1,
    });
    expect(pdfSummary?.review).toEqual([hotel.id as string]);
    expect(pdfSummary?.changes.map((c) => c.column)).toContain('Call times');
    // The originals, the email document and the PDF's text are in Job sources.
    const names = world.store.inFolder('sources').map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Leeds Lights Gala - booking.md',
        'invite.pdf',
        'invite.pdf · text.md',
      ])
    );
  });

  test('a re-forwarded duplicate is not processed twice', async () => {
    const before = sources().length;
    const again = await world.pipeline.processEmail({
      raw: inviteEmail({
        messageId: '<invite-1-again@acme-productions.example.com>',
        date: 'Tue, 2 Mar 2027 08:15:00 +0000',
      }),
      from: 'jo@acme-productions.example.com',
    });
    expect(again.kind).toBe('duplicate');
    expect(again.sourceId).toBe(first.sourceId);
    expect(again.children.map((c) => c.kind)).toEqual(['duplicate']);
    expect(sources()).toHaveLength(before);
    expect(world.model.requests).toHaveLength(2);
  });

  test('the owner confirms a detail on Telegram', async () => {
    const pdf = source('invite.pdf');
    const cards = await world.pipeline.reviewCards({
      sourceId: pdf.id as string,
    });
    expect(cards.map((c) => c.field)).toEqual(['Hotel']);
    const card = cards[0] as (typeof cards)[number];
    expect(card.quote).toBe('Hotel TBC, likely the Example Hotel');
    expect(card.link).toContain('pdf_page_number=1');
    const result = await world.pipeline.applyReview({
      detailId: card.detailId,
      action: 'confirm',
      fingerprint: card.fingerprint,
    });
    expect(result.kind).toBe('applied');
    const hotel = detail('invite.pdf', 'Hotel');
    expect(hotel.Status).toBe('Confirmed');
    expect(hotel.Name).toBe('Hotel: Example Hotel');
    expect(world.state.value.details[card.detailId]).toMatchObject({
      decidedVia: 'telegram',
    });
    const job = theJob();
    expect(job['Needs review']).toBe(0);
    expect(job.Accommodation).toBe('Example Hotel');
    expect(job['Not confirmed']).not.toContain('Accommodation');
    expect(source('invite.pdf').Status).toBe('Processed');
    // Pressed again, the card no longer matches the detail.
    const stale = await world.pipeline.applyReview({
      detailId: card.detailId,
      action: 'reject',
      fingerprint: card.fingerprint,
    });
    expect(stale.kind).toBe('changed');
    expect(detail('invite.pdf', 'Hotel').Status).toBe('Confirmed');
  });

  test('a later call sheet updates a call time and the summary shows the change', async () => {
    world.now += DAY;
    const result = await world.pipeline.processSource({
      via: 'Telegram',
      name: 'call-sheet-v2.pdf',
      bytes: CALL_SHEET_PDF,
      from: 'Sam Price',
    });
    expect(result).toMatchObject({ kind: 'finished', status: 'Processed' });
    const sheet = source('call-sheet-v2.pdf');
    expect(sheet.Sent).toBe('2027-03-03');
    const job = theJob();
    expect(sheet.Job).toEqual([job.id]);
    expect(job['Call times']).toBe(
      'Fri 12 Mar 2027: 07:00; Sat 13 Mar 2027: 08:00'
    );
    const old = detail('invite.pdf', 'Call time', '07:30');
    expect(old.Status).toBe('Replaced');
    expect(String(old.Check)).toStartWith('Replaced: replaced by 08:00');
    const summary = summaries().at(-1);
    expect(summary?.sourceId).toBe(sheet.id as string);
    expect(summary?.changes).toContainEqual({
      column: 'Call times',
      from: 'Fri 12 Mar 2027: 07:00; Sat 13 Mar 2027: 07:30',
      to: 'Fri 12 Mar 2027: 07:00; Sat 13 Mar 2027: 08:00',
    });
    expect(summary?.counts.replaced).toBe(1);
  });

  test('a source the filing rules cannot place asks, and touches no Jobs row until answered', async () => {
    const before = structuredClone(theJob());
    const jobVersion = world.store.tables.get('jobs')?.version;
    const result = await world.pipeline.processSource({
      via: 'Telegram',
      name: 'hotel.pdf',
      bytes: HOTEL_PDF,
      from: 'Sam Price',
    });
    expect(result).toMatchObject({ kind: 'finished', status: 'Needs review' });
    const hotel = source('hotel.pdf');
    expect(hotel.Job ?? []).toEqual([]);
    const details = detailsOf(hotel.id as string);
    expect(details).toHaveLength(4);
    for (const d of details) expect(d.Job ?? []).toEqual([]);
    expect(theJob()).toEqual(before);
    expect(world.store.tables.get('jobs')?.version).toBe(jobVersion);
    const question = world.notifier.of('filing').at(-1);
    expect(question?.sourceId).toBe(hotel.id as string);
    expect(question?.parts[0]?.candidates.map((c) => c.jobId)).toEqual([
      before.id as string,
    ]);
    expect(question?.parts[0]?.candidates[0]?.why).toContain('Fri 12 Mar 2027');

    const answered = await world.pipeline.answerFiling({
      sourceId: hotel.id as string,
      part: null,
      choice: { kind: 'job', jobId: before.id as string },
    });
    expect(answered).toMatchObject({
      kind: 'filed',
      jobId: before.id,
      created: false,
      remaining: 0,
    });
    for (const d of detailsOf(hotel.id as string))
      expect(d.Job).toEqual([before.id]);
    expect(source('hotel.pdf').Job).toEqual([before.id]);
    const job = theJob();
    expect(String(job.Accommodation)).toContain('check-in Fri 12 March 2027');
    expect(String(job.Accommodation)).toContain('check-out Sun 14 March 2027');
    expect(world.state.value.filing[hotel.id as string]).toBeUndefined();
    const again = await world.pipeline.answerFiling({
      sourceId: hotel.id as string,
      part: null,
      choice: { kind: 'new_job' },
    });
    expect(again.kind).toBe('no_question');
  });

  test('an owner Status edit in SupaMac is the owner’s decision, listed in the next summary', async () => {
    const rate = detail('Leeds Lights Gala - booking', 'Rate');
    expect(theJob().Rate).toBe(350);
    world.store.edit(
      'details',
      rate.id as string,
      { Status: 'Rejected' },
      'owner'
    );
    const poll = await world.pipeline.pollEdits();
    expect(poll.report.agent).toEqual([]);
    expect(world.state.value.details[rate.id as string]).toMatchObject({
      decidedVia: 'supamac',
      decidedAt: new Date(world.now).toISOString(),
    });
    expect(world.state.value.notes.decidedInSupamac).toContainEqual(
      expect.objectContaining({ detailId: rate.id, status: 'Rejected' })
    );
    const job = theJob();
    expect(job.Rate).toBeNull();
    expect(job.Currency).toBeNull();
  });

  test('an agent’s edits are undone or set for review, and reported', async () => {
    const venue = detail('Leeds Lights Gala - booking', 'Venue');
    const event = detail('Leeds Lights Gala - booking', 'Event');
    world.store.edit(
      'details',
      venue.id as string,
      { Status: 'Confirmed' },
      'agent'
    );
    world.store.edit(
      'details',
      event.id as string,
      { Value: 'Leeds Lights Gala 2027' },
      'agent'
    );
    const poll = await world.pipeline.pollEdits();
    expect(detail('Leeds Lights Gala - booking', 'Venue').Status).toBe('Found');
    const changed = detail('Leeds Lights Gala - booking', 'Event');
    expect(changed.Status).toBe('Needs review');
    expect(String(changed.Check)).toContain('changed by the assistant');
    expect(poll.report.agent.map((a) => [a.rowId, a.action])).toEqual([
      [venue.id as string, 'undone'],
      [event.id as string, 'needs_review'],
    ]);
    expect(world.notifier.of('edits').at(-1)?.agent).toHaveLength(2);
    const job = theJob();
    expect(job['Not confirmed']).toContain('Venue');
    expect(job.Event).toBeNull();
    // The service's own undo is not read back as a change.
    const quiet = await world.pipeline.pollEdits();
    expect(quiet.report.agent).toEqual([]);
  });

  test('an owner’s value edit in SupaMac is the owner’s value, and a stale card says so', async () => {
    const hotel = detail('hotel.pdf', 'Hotel');
    expect(hotel.Status).toBe('Needs review');
    const [card] = await world.pipeline.reviewCards({
      sourceId: source('hotel.pdf').id as string,
    });
    expect(card?.detailId).toBe(hotel.id as string);
    world.store.edit(
      'details',
      hotel.id as string,
      { Value: 'Example Hotel Leeds' },
      'owner'
    );
    await world.pipeline.pollEdits();
    expect(world.state.value.details[hotel.id as string]?.origin).toBe('owner');
    expect(detail('hotel.pdf', 'Hotel').Status).toBe('Confirmed');
    const pressed = await world.pipeline.applyReview({
      detailId: hotel.id as string,
      action: 'reject',
      fingerprint: card?.fingerprint ?? '',
    });
    expect(pressed.kind).toBe('changed');
    if (pressed.kind === 'changed')
      expect(pressed.card.status).toBe('Confirmed');
    expect(String(theJob().Accommodation)).toContain('Example Hotel Leeds');
  });

  test('a crash after the model call and before the INSERT resumes without a second model call', async () => {
    world.now += DAY;
    const dropped = world.store.drop('PO-4500123.pdf', PO_PDF);
    world.store.fail('insertDetails', 'hang');
    const inserts = world.store.calls.filter(
      (c) => c === 'insertDetails'
    ).length;
    // The first service hangs at the INSERT, as if the process died there.
    void world.pipeline.pollFolder();
    await until(
      () =>
        world.store.calls.filter((c) => c === 'insertDetails').length > inserts,
      'the INSERT'
    );
    expect(world.model.count('S1: "PO-4500123.pdf"')).toBe(1);
    const po = source('PO-4500123.pdf');
    expect(po.Status).toBe('Processing');
    expect(detailsOf(po.id as string)).toHaveLength(0);

    await restart(world);
    const resumed = await world.pipeline.resume();
    expect(resumed.map((r) => [r.sourceId, r.kind])).toEqual([
      [po.id as string, 'finished'],
    ]);
    expect(world.model.count('S1: "PO-4500123.pdf"')).toBe(1);
    expect(source('PO-4500123.pdf').Status).toBe('Processed');
    expect(source('PO-4500123.pdf').Job).toEqual([theJob().id]);
    expect(detailsOf(po.id as string).map((d) => d.Field)).toEqual([
      'PO number',
      'Client',
      'Payment terms',
    ]);
    expect(theJob()['Payment terms']).toBe('30 days end of month');
    expect(world.store.documents.get(dropped.id)?.folder).toBe('sources');
    // The summary lists what was decided in SupaMac since the last one, once.
    const summary = summaries().at(-1);
    expect(summary?.sourceId).toBe(po.id as string);
    expect(summary?.decidedInSupamac.map((d) => d.status)).toEqual([
      'Rejected',
      'Confirmed (entered by you)',
    ]);
    expect(world.state.value.notes.decidedInSupamac).toEqual([]);
    // Polled again, the folder holds nothing new.
    const polled = await world.pipeline.pollFolder();
    expect(polled.processed).toEqual([]);
  });

  test('a refusal sets the source Failed with a Retry action', async () => {
    const result = await world.pipeline.processSource({
      via: 'Telegram',
      name: 'photo.png',
      bytes: PHOTO,
      from: 'Sam Price',
    });
    expect(result).toMatchObject({ kind: 'finished', status: 'Failed' });
    const photo = source('photo.png');
    expect(photo.Status).toBe('Failed');
    expect(String(photo.Note)).toBe('the model declined to answer (cyber)');
    const failure = world.notifier.of('failure').at(-1);
    expect(failure).toMatchObject({
      sourceId: photo.id,
      retry: { sourceId: photo.id },
    });
    expect(detailsOf(photo.id as string)).toHaveLength(0);
    const again = await world.pipeline.retry(photo.id as string);
    expect(again).toMatchObject({ kind: 'finished', status: 'Failed' });
    expect(world.model.count('S1: "photo.png"')).toBe(2);
  });

  test('a file of a type that is not read is Skipped without a model call', async () => {
    const requests = world.model.requests.length;
    const result = await world.pipeline.processSource({
      via: 'Telegram',
      name: 'poster.gif',
      bytes: gif(10, 10),
    });
    expect(result).toMatchObject({ kind: 'finished', status: 'Skipped' });
    expect(String(source('poster.gif').Note)).toContain('not read');
    expect(world.model.requests).toHaveLength(requests);
    expect(world.notifier.of('failure').map((f) => f.name)).not.toContain(
      'poster.gif'
    );
  });
});
