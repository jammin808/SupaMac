// The bot as the real pipeline's notifier and way in, on the in-memory
// SupaMac and a scripted model (test/pipeline/harness.ts), with the fake Bot
// API: a source sent on Telegram, its summary, the review walk, a filing
// question answered with a button, and the Retry of a reply that could not
// be used.

import { afterEach, describe, expect, test } from 'bun:test';
import type { ExtractionReplyWire } from '../../src/ai/extract';
import { Pipeline } from '../../src/pipeline/pipeline';
import { BotApi } from '../../src/telegram/api';
import { Bot, TelegramNotifier } from '../../src/telegram/bot';
import { freshRetry } from '../../src/telegram/index';
import { CHANGED_LEAD, readCallback } from '../../src/telegram/render';
import { extract } from '../../src/text/extract';
import {
  HOTEL_PDF,
  HOTEL_REPLY,
  INVITE_PDF,
  INVITE_PDF_REPLY,
  pdfOf,
} from '../pipeline/fixtures';
import {
  cleanup,
  makeWorld,
  type Scripted,
  type World,
} from '../pipeline/harness';
import {
  FakeBotApi,
  OWNER,
  type SentRecord,
  TOKEN,
  wellFormed,
} from './fake-bot-api';

const SHEET_PDF = pdfOf([
  'ACME PRODUCTIONS LTD - CALL SHEET',
  'Event: Leeds Lights Gala',
  'Fri 12 March 2027',
  'Crew call 07:00 TBC',
  'Load-in approx. 06:00',
  'Hotel TBC, likely the Example Hotel',
]);

const SHEET_REPLY: ExtractionReplyWire = {
  source_kind: 'Call sheet',
  jobs: [{ names: ['Leeds Lights Gala'], references: [], dates: [] }],
  details: [
    {
      field: 'Event',
      label: 'Event',
      value: 'Leeds Lights Gala',
      quote: 'Event: Leeds Lights Gala',
      page: 1,
    },
    {
      field: 'Call time',
      label: 'Crew call',
      value: '07:00',
      quote: 'Crew call 07:00 TBC',
      page: 1,
      day: '2027-03-12',
      day_quote: 'Fri 12 March 2027',
    },
    {
      field: 'Load-in',
      label: 'Load-in',
      value: '06:00',
      quote: 'Load-in approx. 06:00',
      page: 1,
      day: '2027-03-12',
      day_quote: 'Fri 12 March 2027',
    },
    {
      field: 'Hotel',
      label: 'Hotel',
      value: 'Example Hotel',
      quote: 'Hotel TBC, likely the Example Hotel',
      page: 1,
    },
  ],
};

const INVALID = {
  source_kind: 'Bogus',
  jobs: [],
  details: [],
} as unknown as ExtractionReplyWire;

const SCRIPT: { marker: string; reply: Scripted }[] = [
  { marker: 'S1: "call-sheet.pdf"', reply: SHEET_REPLY },
  { marker: 'S1: "invite.pdf"', reply: INVITE_PDF_REPLY },
  { marker: 'S1: "hotel.pdf"', reply: HOTEL_REPLY },
  { marker: 'S1: "Your note', reply: INVALID },
];

interface Rig {
  readonly w: World;
  readonly fake: FakeBotApi;
  readonly bot: Bot;
  readonly pipeline: Pipeline;
  poll(): Promise<void>;
  send(name: string, bytes: Uint8Array): Promise<void>;
  press(sent: SentRecord, button: string | RegExp): Promise<void>;
}

const worlds: World[] = [];
const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.bot.stop();
  for (const w of worlds.splice(0)) await cleanup(w);
});

async function rig(): Promise<Rig> {
  const w = await makeWorld(SCRIPT, { extract: (b, h) => extract(b, h) });
  worlds.push(w);
  await w.state.setOwnerId(OWNER);
  const fake = new FakeBotApi();
  const api = new BotApi({
    token: TOKEN,
    fetch: fake.fetch,
    logger: w.ctx.logger,
    sleep: async () => undefined,
  });
  const notifier = new TelegramNotifier({
    api,
    state: w.state,
    logger: w.ctx.logger,
    timeZone: w.ctx.timeZone,
  });
  // The bot is the pipeline's notifier, as main.ts wires it.
  const pipeline = new Pipeline({ ...w.ctx, notifier });
  const bot = new Bot({
    api,
    notifier,
    state: w.state,
    pipeline,
    logger: w.ctx.logger,
    clock: w.ctx.clock,
    timeZone: w.ctx.timeZone,
    health: w.ctx.health,
    freshRetry: (sourceId) => freshRetry(pipeline, sourceId),
    downloadDocument: (id) => w.store.downloadDocument(id),
  });
  let files = 0;
  const r: Rig = {
    w,
    fake,
    bot,
    pipeline,
    async poll() {
      await bot.pollOnce();
      await bot.idle();
    },
    async send(name, bytes) {
      const fileId = `file-${++files}`;
      fake.files.set(fileId, {
        path: `documents/file_${files}.pdf`,
        bytes,
        size: bytes.length,
      });
      fake.message(OWNER, {
        document: {
          file_id: fileId,
          file_unique_id: `u-${fileId}`,
          file_name: name,
          mime_type: 'application/pdf',
          file_size: bytes.length,
        },
      });
      await r.poll();
    },
    async press(sent, button) {
      fake.press(OWNER, sent, fake.button(sent, button));
      await r.poll();
    },
  };
  rigs.push(r);
  return r;
}

function detailStatus(w: World, id: string): unknown {
  return w.store.values('details', id)?.Status;
}

/** The detail a card's Confirm button names. */
function cardDetail(fake: FakeBotApi, card: SentRecord): string {
  const cb = readCallback(fake.button(card, 'Confirm'));
  if (cb?.kind !== 'decide') throw new Error('not a card');
  return cb.detailId;
}

describe('a source sent on Telegram', () => {
  test('gets one summary, and its Review steps through each detail by editing one card: Confirm, Reject, and a stale card', async () => {
    const r = await rig();
    await r.send('call-sheet.pdf', SHEET_PDF);
    const sources = r.w.store.rows('sources');
    expect(sources).toHaveLength(1);
    expect(sources[0]?.[1].Via).toBe('Telegram');

    // One message: the summary, with the job, the counts and a Review button.
    expect(r.fake.to(OWNER)).toHaveLength(1);
    const summary = r.fake.last();
    expect(summary.text).toContain(
      '<b>call-sheet.pdf</b>: on Telegram, a call sheet'
    );
    expect(summary.text).toContain(
      'Filed under <b>Leeds Lights Gala</b> (a new job).'
    );
    expect(summary.text).toContain(
      '4 details: 1 found in call-sheet.pdf, not confirmed by you; 3 need a look.'
    );
    for (const part of r.fake.sent) expect(wellFormed(part.text)).toBe(true);

    await r.press(summary, 'Review 3');
    expect(r.fake.answered).toHaveLength(1);
    const card = r.fake.last();
    expect(card).not.toBe(summary);
    expect(card.text).toContain('needs your review');
    expect(card.text).toContain(
      '2 other details from this source need a look.'
    );
    const first = cardDetail(r.fake, card);

    // Confirm: recorded as the owner's, and the same message becomes the next card.
    await r.press(card, 'Confirm');
    expect(detailStatus(r.w, first)).toBe('Confirmed');
    expect(r.w.state.value.details[first]?.decidedVia).toBe('telegram');
    expect(card.edits).toBe(1);
    expect(card.text).toStartWith('Confirmed by you:');
    const second = cardDetail(r.fake, card);
    expect(second).not.toBe(first);

    await r.press(card, 'Reject');
    expect(detailStatus(r.w, second)).toBe('Rejected');
    expect(card.text).toStartWith('Rejected by you:');
    const third = cardDetail(r.fake, card);
    expect([first, second]).not.toContain(third);

    // The detail changes in SupaMac after the card was sent: the press records nothing.
    const staleData = r.fake.button(card, 'Confirm');
    r.w.store.edit('details', third, { Value: 'Example Hotel Leeds' }, 'owner');
    r.fake.press(OWNER, card, staleData);
    await r.poll();
    expect(detailStatus(r.w, third)).toBe('Needs review');
    expect(r.w.state.value.details[third]?.decidedVia).toBeUndefined();
    expect(card.text).toStartWith(CHANGED_LEAD);
    expect(card.text).toContain('<b>Example Hotel Leeds</b>');
    // Its buttons now carry the detail as it reads now.
    expect(r.fake.button(card, 'Confirm')).not.toBe(staleData);

    // Every press was answered, and the walk stayed on one message.
    expect(r.fake.answered).toHaveLength(4);
    expect(r.fake.to(OWNER)).toHaveLength(2);
  });

  test('a filing question is answered with its button, and only then touches the job', async () => {
    const r = await rig();
    await r.send('invite.pdf', INVITE_PDF);
    const jobs = r.w.store.rows('jobs');
    expect(jobs).toHaveLength(1);
    const jobId = jobs[0]?.[0] as string;
    const jobName = String(jobs[0]?.[1].Name);

    await r.send('hotel.pdf', HOTEL_PDF);
    const question = r.fake
      .to(OWNER)
      .find((m) => m.text.includes('Which job is hotel.pdf for?'));
    expect(question).toBeDefined();
    const q = question as SentRecord;
    expect(q.text).toContain('Its details touch no Jobs row until you answer.');
    const hotel = r.w.store
      .rows('sources')
      .find(([, v]) => v.Name === 'hotel.pdf')?.[0] as string;
    const unfiled = r.w.store
      .rows('details')
      .filter(([, v]) => (v['Source row'] as string[]).includes(hotel));
    expect(unfiled.length).toBeGreaterThan(0);
    for (const [, v] of unfiled) expect(v.Job ?? []).toEqual([]);

    await r.press(q, 'Yes');
    expect(q.text).toBe(`Filed hotel.pdf under <b>${jobName}</b>.`);
    expect(q.keyboard).toEqual([]);
    for (const [id] of unfiled)
      expect(r.w.store.values('details', id)?.Job).toEqual([jobId]);
    expect(r.w.state.value.filing[hotel]).toBeUndefined();
    // The filed source's summary follows.
    expect(r.fake.last().text).toContain(`<b>hotel.pdf</b>`);
    expect(r.fake.last().text).toContain(`Filed under <b>${jobName}</b>`);

    // The same press again files nothing twice.
    r.fake.press(OWNER, q, `f:${hotel}:-:new`);
    await r.poll();
    expect(r.w.store.rows('jobs')).toHaveLength(1);
    expect(q.text).toContain('this question was already answered');
  });

  test('a reply that could not be used is read afresh when the owner presses Read again', async () => {
    const r = await rig();
    r.fake.text(OWNER, '/add Crew call 07:00 on Fri 12 March 2027');
    await r.poll();
    const failure = r.fake.last();
    expect(failure.text).toContain('failed.');
    expect(failure.text).toContain('a fresh reading, at the model’s cost');
    expect(r.w.model.count('S1: "Your note')).toBe(1);

    await r.press(failure, 'Read again (new cost)');
    // The model was asked again (the script answers the same, so it fails again).
    expect(r.w.model.count('S1: "Your note')).toBe(2);
    expect(failure.text).toContain('was tried again: Failed.');
    const again = r.fake.last();
    expect(again).not.toBe(failure);
    expect(again.text).toContain('a fresh reading, at the model’s cost');
  });
});
