import { afterEach, describe, expect, test } from 'bun:test';
import { AiClient } from '../../src/ai/anthropic';
import type { ExtractionReplyWire } from '../../src/ai/extract';
import { Lane } from '../../src/pipeline/context';
import { Pipeline } from '../../src/pipeline/pipeline';
import { emailHash, nameFor } from '../../src/pipeline/process';
import { fingerprint } from '../../src/pipeline/review';
import type { DetailRow } from '../../src/pipeline/store';
import { SupaMacError } from '../../src/supamac/client';
import { StateLedger } from '../../src/pipeline/state';
import { extract } from '../../src/text/extract';
import type { ExtractOutcome } from '../../src/text/types';
import { httpError } from '../ai/fake';
import { mime } from '../text/build';
import {
  CALL_SHEET_PDF,
  EMAIL_REPLY,
  INVITE_PDF_REPLY,
  inviteEmail,
  pdfOf,
} from './fixtures';
import { cleanup, makeWorld, type Scripted, type World } from './harness';

const worlds: World[] = [];
const MINUTE = 60_000;

async function world(
  script: { marker: string; reply: Scripted }[],
  outcome?: ExtractOutcome
): Promise<World> {
  const w = await makeWorld(script, {
    extract:
      outcome === undefined
        ? (bytes, hint) => extract(bytes, hint)
        : async () => outcome,
  });
  worlds.push(w);
  return w;
}

afterEach(async () => {
  for (const w of worlds.splice(0)) await cleanup(w);
});

function row(
  w: World,
  table: 'sources' | 'details' | 'jobs',
  name: string
): Record<string, unknown> {
  const found = w.store.rows(table).find(([, v]) => v.Name === name);
  if (found === undefined) throw new Error(`no ${table} row ${name}`);
  return { id: found[0], ...found[1] };
}

const NOTE = 'Get-in 08:00 on Sat 13 March 2027';

describe('attempts and retries', () => {
  test('an overloaded API keeps the source Processing with backoff, and the third failure fails it with a Retry', async () => {
    const w = await world([
      {
        marker: 'S1: "call-sheet.pdf"',
        reply: httpError(529, 'overloaded_error'),
      },
    ]);
    const first = await w.pipeline.processSource({
      via: 'Telegram',
      name: 'call-sheet.pdf',
      bytes: CALL_SHEET_PDF,
    });
    expect(first).toMatchObject({ kind: 'waiting', paused: false });
    const src = row(w, 'sources', 'call-sheet.pdf');
    expect(src.Status).toBe('Processing');
    expect(src.Attempts).toBe(1);
    expect(w.state.value.attempts[src.id as string]?.nextAt).toBe(
      new Date(w.now + MINUTE).toISOString()
    );

    // Not yet due: nothing is sent.
    await w.pipeline.resume();
    expect(w.model.requests).toHaveLength(1);
    w.now += MINUTE;
    await w.pipeline.resume();
    expect(row(w, 'sources', 'call-sheet.pdf').Attempts).toBe(2);
    w.now += 5 * MINUTE;
    const third = await w.pipeline.resume();
    expect(third[0]).toMatchObject({ kind: 'finished', status: 'Failed' });
    const failed = row(w, 'sources', 'call-sheet.pdf');
    expect(failed.Status).toBe('Failed');
    expect(String(failed.Note)).toContain('after 3 attempts');
    expect(w.notifier.of('failure')).toEqual([
      expect.objectContaining({
        sourceId: src.id,
        attempts: 3,
        retry: { sourceId: src.id },
      }),
    ]);
    expect(w.model.requests).toHaveLength(3);
    // A Failed source is not resumed by itself.
    w.now += 60 * MINUTE;
    await w.pipeline.resume();
    expect(w.model.requests).toHaveLength(3);
  });

  test('a SupaMac outage while writing is retried from where it stopped, without asking the model again', async () => {
    const w = await world([
      { marker: 'S1: "invite.pdf"', reply: INVITE_PDF_REPLY },
    ]);
    w.store.fail(
      'insertDetails',
      new SupaMacError('unavailable', 'POST /databases/query', 'down')
    );
    const first = await w.pipeline.processSource({
      via: 'Telegram',
      name: 'invite.pdf',
      bytes: pdfOf([
        'Issued: Mon 1 March 2027',
        'Job ref: LLG-27014',
        'PO: 4500123',
      ]),
    });
    expect(first.kind).toBe('waiting');
    expect(w.state.value.health.connections.supamac?.up).toBe(false);
    w.now += MINUTE;
    const [again] = await w.pipeline.resume();
    expect(again?.kind).toBe('finished');
    expect(w.model.requests).toHaveLength(1);
    // Every candidate is stored once: the two whose quotes are on the page are Found.
    const statuses = w.store.rows('details').map(([, v]) => v.Status);
    expect(statuses).toHaveLength(5);
    expect(statuses.filter((st) => st === 'Found')).toHaveLength(2);
  });

  test('a sandbox failure is Failed with a Retry; a type that is not read is Skipped without one', async () => {
    const crashed = await world([], {
      ok: false,
      refusal: {
        kind: 'timeout',
        reason:
          'Reading the file took longer than 60 seconds, so it was stopped.',
      },
    });
    await crashed.pipeline.processSource({
      via: 'Telegram',
      name: 'big.pdf',
      bytes: new Uint8Array([1]),
    });
    expect(row(crashed, 'sources', 'big.pdf')).toMatchObject({
      Status: 'Failed',
      Note: 'Reading the file took longer than 60 seconds, so it was stopped.',
    });
    expect(crashed.notifier.of('failure')).toHaveLength(1);
    expect(
      await crashed.state.readSpool(
        crashed.state.value.sources[
          row(crashed, 'sources', 'big.pdf').id as string
        ]?.hash ?? ''
      )
    ).toBeDefined();

    const skipped = await world([], {
      ok: false,
      refusal: {
        kind: 'unsupported_type',
        reason: 'The file is a GIF image, which is not read.',
      },
    });
    await skipped.pipeline.processSource({
      via: 'Telegram',
      name: 'poster.gif',
      bytes: new Uint8Array([2]),
    });
    expect(row(skipped, 'sources', 'poster.gif').Status).toBe('Skipped');
    expect(skipped.notifier.of('failure')).toEqual([]);
    expect(skipped.model.requests).toEqual([]);
  });

  test('the monthly limit pauses a source without counting an attempt, and says so once', async () => {
    const w = await world([
      { marker: 'S1: "call-sheet.pdf"', reply: INVITE_PDF_REPLY },
    ]);
    const capped = new AiClient({
      client: w.model,
      monthlyLimitUsd: 0,
      ledger: new StateLedger(w.state),
      timeZone: 'Europe/London',
      clock: () => new Date(w.now),
    });
    const pipeline = new Pipeline({ ...w.ctx, ai: capped, lane: new Lane() });
    const result = await pipeline.processSource({
      via: 'Telegram',
      name: 'call-sheet.pdf',
      bytes: CALL_SHEET_PDF,
    });
    expect(result).toMatchObject({ kind: 'waiting', paused: true });
    const src = row(w, 'sources', 'call-sheet.pdf');
    expect(src.Status).toBe('Processing');
    expect(src.Attempts).toBe(0);
    expect(w.state.value.attempts[src.id as string]).toMatchObject({
      count: 0,
      paused: true,
    });
    w.now += 61 * MINUTE;
    await pipeline.resume();
    expect(
      w.notifier.of('note').filter((n) => n.kind === 'spend_limit')
    ).toHaveLength(1);
    expect(w.model.requests).toEqual([]);
  });
});

describe('filing', () => {
  test('a source of several jobs waits, and each part files only the details that name it', async () => {
    const reply: ExtractionReplyWire = {
      source_kind: 'Call sheet',
      jobs: [
        { names: ['Leeds Lights Gala'], references: [], dates: [] },
        { names: ['York Light Night'], references: [], dates: [] },
      ],
      details: [
        {
          field: 'Event',
          label: 'Event',
          value: 'Leeds Lights Gala',
          quote: 'Event: Leeds Lights Gala',
          job: 0,
        },
        {
          field: 'Event',
          label: 'Event',
          value: 'York Light Night',
          quote: 'Event: York Light Night',
          job: 1,
        },
      ],
    };
    const w = await world([{ marker: 'S1: "two.txt"', reply }]);
    const bytes = new TextEncoder().encode(
      'Event: Leeds Lights Gala\nEvent: York Light Night\n'
    );
    const result = await w.pipeline.processSource({
      via: 'Telegram',
      name: 'two.txt',
      bytes,
    });
    expect(result).toMatchObject({ kind: 'finished', status: 'Needs review' });
    expect(w.store.rows('jobs')).toEqual([]);
    const question = w.notifier.of('filing')[0];
    expect(question?.parts.map((p) => [p.part, p.names])).toEqual([
      [0, ['Leeds Lights Gala']],
      [1, ['York Light Night']],
    ]);
    const src = row(w, 'sources', 'two.txt');
    const leeds = await w.pipeline.answerFiling({
      sourceId: src.id as string,
      part: 0,
      choice: { kind: 'new_job' },
    });
    expect(leeds).toMatchObject({ kind: 'filed', created: true, remaining: 1 });
    expect(row(w, 'sources', 'two.txt').Status).toBe('Needs review');
    const york = await w.pipeline.answerFiling({
      sourceId: src.id as string,
      part: 1,
      choice: { kind: 'new_job' },
    });
    expect(york).toMatchObject({ kind: 'filed', created: true, remaining: 0 });
    const leedsJob = row(w, 'jobs', 'Leeds Lights Gala');
    const yorkJob = row(w, 'jobs', 'York Light Night');
    expect(leedsJob.Event).toBe('Leeds Lights Gala');
    expect(yorkJob.Event).toBe('York Light Night');
    expect(row(w, 'details', 'Event: Leeds Lights Gala').Job).toEqual([
      leedsJob.id,
    ]);
    expect(row(w, 'details', 'Event: York Light Night').Job).toEqual([
      yorkJob.id,
    ]);
    expect(row(w, 'sources', 'two.txt')).toMatchObject({
      Status: 'Processed',
      Job: [leedsJob.id, yorkJob.id],
    });
  });

  test('an attachment waits with its email and is filed with it once the email’s question is answered', async () => {
    const emailReply: ExtractionReplyWire = {
      source_kind: 'Other',
      jobs: [{ names: ['Leeds Lights Gala'], references: [], dates: [] }],
      details: [
        {
          field: 'Client',
          label: 'Client',
          value: 'Example Arts Trust',
          quote: 'Client: Example Arts Trust',
        },
      ],
    };
    const w = await world([
      { marker: 'S1: "Leeds Lights Gala - booking"', reply: emailReply },
      { marker: 'S1: "invite.pdf"', reply: INVITE_PDF_REPLY },
    ]);
    const result = await w.pipeline.processEmail({ raw: inviteEmail() });
    expect(result.children[0]).toMatchObject({
      kind: 'finished',
      status: 'Needs review',
    });
    const email = row(w, 'sources', 'Leeds Lights Gala - booking');
    const pdf = row(w, 'sources', 'invite.pdf');
    expect(w.notifier.of('filing').map((q) => q.sourceId)).toEqual([
      email.id as string,
    ]);
    expect(w.state.value.filing[pdf.id as string]?.waitingFor).toBe(
      email.id as string
    );
    expect(w.store.rows('jobs')).toEqual([]);
    const refused = await w.pipeline.answerFiling({
      sourceId: pdf.id as string,
      part: null,
      choice: { kind: 'new_job' },
    });
    expect(refused.kind).toBe('refused');

    const filed = await w.pipeline.answerFiling({
      sourceId: email.id as string,
      part: null,
      choice: { kind: 'new_job' },
    });
    expect(filed).toMatchObject({ kind: 'filed', created: true });
    const job = row(w, 'jobs', 'Leeds Lights Gala');
    expect(row(w, 'sources', 'invite.pdf').Job).toEqual([job.id]);
    expect(job['Call times']).toBe(
      'Fri 12 Mar 2027: 07:00; Sat 13 Mar 2027: 07:30'
    );
    expect(w.state.value.filing).toEqual({});
  });

  test('a value the owner rejected stays Needs review when a later source says it again', async () => {
    const again: ExtractionReplyWire = {
      ...INVITE_PDF_REPLY,
      source_date: {
        date: '2027-03-03',
        quote: 'Issued: Wed 3 March 2027',
        page: 1,
      },
      details: [
        {
          field: 'PO number',
          label: 'PO',
          value: '4500123',
          quote: 'PO: 4500123',
          page: 1,
        },
        {
          field: 'Client',
          label: 'Client',
          value: 'Example Arts Trust',
          quote: 'Client: Example Arts Trust',
          page: 1,
        },
        {
          field: 'Call time',
          label: 'Crew call',
          value: '08:00',
          quote: 'Crew call 08:00',
          page: 1,
          day: '2027-03-13',
          day_quote: 'Sat 13 March 2027',
        },
      ],
    };
    const w = await world([
      { marker: 'S1: "Leeds Lights Gala - booking"', reply: EMAIL_REPLY },
      { marker: 'S1: "invite.pdf"', reply: INVITE_PDF_REPLY },
      { marker: 'S1: "call-sheet-v2.pdf"', reply: again },
    ]);
    await w.pipeline.processEmail({ raw: inviteEmail() });
    const first = await w.pipeline.processSource({
      via: 'Telegram',
      name: 'call-sheet-v2.pdf',
      bytes: CALL_SHEET_PDF,
    });
    expect(first).toMatchObject({ kind: 'finished', status: 'Processed' });
    // The owner rejects Saturday's 08:00 on Telegram.
    const eight = row(w, 'details', 'Call time: 08:00');
    const read = await w.store.details({ ids: [eight.id as string] });
    const rejected = await w.pipeline.applyReview({
      detailId: eight.id as string,
      action: 'reject',
      fingerprint: fingerprint(read.rows[0] as DetailRow),
    });
    expect(rejected).toMatchObject({ kind: 'applied', status: 'Rejected' });
    expect(w.state.value.details[eight.id as string]?.decidedVia).toBe(
      'telegram'
    );
    const repeat = await w.pipeline.processSource({
      via: 'Telegram',
      name: 'call-sheet-v2.pdf',
      bytes: pdfOf([
        'Issued: Wed 3 March 2027',
        'PO: 4500123',
        'Client: Example Arts Trust',
        'Sat 13 March 2027',
        'Crew call 08:00',
        'Rev 3',
      ]),
    });
    expect(repeat).toMatchObject({ kind: 'finished', status: 'Needs review' });
    const sticky = w.store
      .rows('details')
      .filter(([, v]) => v.Value === '08:00')
      .map(([, v]) => v)
      .at(-1);
    expect(sticky?.Status).toBe('Needs review');
    expect(String(sticky?.Check)).toContain('you rejected this on');
  });
});

describe('notes, names and hashes', () => {
  test('an owner’s note is filed as their note, with nothing uploaded', async () => {
    const reply: ExtractionReplyWire = {
      source_kind: 'Other',
      jobs: [{ names: [], references: [], dates: [] }],
      details: [
        {
          field: 'Load-in',
          label: 'Get-in',
          value: '08:00',
          quote: NOTE,
          day: '2027-03-13',
        },
      ],
    };
    const w = await world([{ marker: 'S1: "Your note"', reply }]);
    await w.pipeline.processSource({
      via: 'Note',
      name: 'Your note',
      bytes: new TextEncoder().encode(NOTE),
    });
    const detailRow = row(w, 'details', 'Load-in: 08:00');
    expect(w.state.value.details[detailRow.id as string]?.origin).toBe('note');
    expect(w.store.documents.size).toBe(0);
  });

  test('a source date that does not check is left unknown and the Note says why', async () => {
    const reply: ExtractionReplyWire = {
      ...INVITE_PDF_REPLY,
      source_date: {
        date: '2027-03-02',
        quote: 'Issued: Mon 1 March 2027',
        page: 1,
      },
    };
    const w = await world([{ marker: 'S1: "invite.pdf"', reply }]);
    await w.pipeline.processSource({
      via: 'Telegram',
      name: 'invite.pdf',
      bytes: pdfOf(['Issued: Mon 1 March 2027', 'Job ref: LLG-27014']),
    });
    const src = row(w, 'sources', 'invite.pdf');
    expect(src.Sent ?? null).toBeNull();
    expect(String(src.Note)).toContain("The source's own date was not taken");
  });

  test('a duplicate is found by the Sources Hash column when the state lost its index', async () => {
    const w = await world([
      { marker: 'S1: "invite.pdf"', reply: INVITE_PDF_REPLY },
    ]);
    const bytes = pdfOf(['Issued: Mon 1 March 2027', 'PO: 4500123']);
    const first = await w.pipeline.processSource({
      via: 'Telegram',
      name: 'invite.pdf',
      bytes,
    });
    await w.state.update((s) => {
      s.hashIndex = {};
    });
    const again = await w.pipeline.processSource({
      via: 'Telegram',
      name: 'invite (1).pdf',
      bytes,
    });
    expect(again).toMatchObject({
      kind: 'duplicate',
      sourceId: first.sourceId,
    });
    expect(w.model.requests).toHaveLength(1);
  });

  test('an email’s hash is its text and attachments, not its headers', async () => {
    const read = async (raw: Uint8Array) => {
      const outcome = await extract(raw, { name: 'message.eml' });
      if (!outcome.ok) throw new Error(outcome.refusal.reason);
      return emailHash(outcome.value);
    };
    const a = await read(inviteEmail());
    const b = await read(
      inviteEmail({
        messageId: '<other@example.com>',
        date: 'Wed, 3 Mar 2027 10:00:00 +0000',
      })
    );
    const c = await read(
      mime([
        'From: Jo Bloggs <jo@acme-productions.example.com>',
        'Subject: Leeds',
        'Date: Mon, 1 Mar 2027 09:00:00 +0000',
        '',
        'Crew call 08:00',
      ])
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test('an upload is named with the extension its bytes are', () => {
    expect(nameFor('call sheet', 'pdf')).toBe('call sheet.pdf');
    expect(nameFor('photo.JPEG', 'jpeg')).toBe('photo.JPEG');
    expect(nameFor('scan.pdf', 'png')).toBe('scan.pdf.png');
    expect(nameFor('', 'csv')).toBe('source.csv');
  });
});
