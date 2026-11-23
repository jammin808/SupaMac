import { describe, expect, test } from 'bun:test';
import type {
  FilingQuestion,
  ReviewCard,
  SourceSummary,
} from '../../src/pipeline/notify';
import {
  callbackData,
  escapeAttr,
  escapeHtml,
  failureMessage,
  filingMessages,
  jobKey,
  MESSAGE_LIMIT,
  NAME_HTML_LIMIT,
  nameHtml,
  nameText,
  originalCaption,
  readCallback,
  reviewCardMessage,
  splitMessage,
  statusWords,
  summaryMessage,
} from '../../src/telegram/render';
import { MAX_CAPTION_CHARS } from '../../src/telegram/api';
import { wellFormed } from './fake-bot-api';

const SOURCE = '0b5b4b8e-55a5-4b8e-9b0e-2b8f0c1a2d3e';
const DETAIL = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const JOB = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function summary(over: Partial<SourceSummary> = {}): SourceSummary {
  return {
    sourceId: SOURCE,
    name: 'call-sheet.pdf',
    via: 'Telegram',
    kind: 'Call sheet',
    status: 'Needs review',
    jobs: [{ id: JOB, name: 'Leeds Lights Gala', created: true }],
    counts: { details: 5, found: 3, needsReview: 2, replaced: 0 },
    changes: [
      { column: 'Venue', from: null, to: 'Acme Arena, Example Way, Leeds' },
    ],
    kept: [],
    notes: [],
    review: [DETAIL],
    decidedInSupamac: [],
    ...over,
  };
}

function card(over: Partial<ReviewCard> = {}): ReviewCard {
  return {
    detailId: DETAIL,
    jobId: JOB,
    field: 'Call time',
    label: 'Crew call',
    value: '07:00',
    day: '2027-03-12',
    quote: 'Crew call 07:00 TBC',
    page: 2,
    status: 'Needs review',
    check: 'Needs review: the quote says TBC, which the value leaves out',
    sourceId: SOURCE,
    sourceName: 'call-sheet.pdf',
    fingerprint: 'a1b2c3d4e5f6',
    ...over,
  };
}

describe('escaping', () => {
  test('escapes &, < and >, and quotes in attributes', () => {
    expect(escapeHtml('A & B <Ltd> "q"')).toBe('A &amp; B &lt;Ltd&gt; "q"');
    expect(escapeAttr(`a"b'c<d>&`)).toBe('a&quot;b&#39;c&lt;d&gt;&amp;');
  });

  test('HTML special characters in a value reach Telegram as text, never as markup', () => {
    const m = summaryMessage(
      summary({
        name: 'Acme & Sons <script>.pdf',
        jobs: [
          { id: JOB, name: 'Gala <b>VIP</b> & "friends"', created: false },
        ],
        changes: [
          {
            column: 'Rate',
            from: null,
            to: '£350 <per day> & "plus VAT"',
          },
        ],
        links: { job: 'https://supamac.example.com/app/database/x?a=1&b="2"' },
      }),
      'Europe/London'
    );
    const html = m.parts.join('\n');
    expect(html).toContain('Acme &amp; Sons &lt;script&gt;.pdf');
    // A job's name cites no detail, so its links are left out; the "/b" of
    // "</b>" is a bot command Telegram would make tappable.
    expect(html).toContain(
      'Gala &lt;b&gt;VIP&lt;[link left out]&gt; &amp; "friends"'
    );
    expect(html).toContain('"£350 &lt;per day&gt; &amp; "plus VAT""');
    expect(html).toContain(
      'href="https://supamac.example.com/app/database/x?a=1&amp;b=&quot;2&quot;"'
    );
    expect(html).not.toContain('<script>');
    for (const part of m.parts) expect(wellFormed(part)).toBe(true);
    const c = reviewCardMessage(card({ value: '<i>07:00</i> & later' }));
    expect(c.html).toContain('&lt;i&gt;07:00&lt;/i&gt; &amp; later');
    expect(wellFormed(c.html)).toBe(true);
  });

  test('control and direction characters are taken out of what a source wrote', () => {
    const c = reviewCardMessage(card({ value: '07:00‮\u0007 TBC\nnext' }));
    expect(c.html).toContain('<b>07:00 TBC next</b>');
  });
});

describe('splitting', () => {
  test('a 10,000-character summary is split on line boundaries into parts Telegram takes', () => {
    const changes = Array.from({ length: 120 }, (_, i) => ({
      column: 'Contacts' as const,
      from: null,
      to: `Contact ${i}: Sam Price, 07700 900${String(i).padStart(3, '0')}, sam${i}@example.com <crew> & co`,
    }));
    const m = summaryMessage(summary({ changes }), 'Europe/London');
    const whole = m.parts.join('\n');
    expect(whole.length).toBeGreaterThan(10_000);
    expect(m.parts.length).toBeGreaterThanOrEqual(3);
    for (const part of m.parts) {
      expect(part.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
      expect(wellFormed(part)).toBe(true);
    }
    // Nothing is lost or cut: every line of the whole is a line of one part.
    const lines = m.parts.flatMap((p) => p.split('\n'));
    for (const ch of changes)
      expect(lines.some((l) => l.includes(escapeHtml(ch.to)))).toBe(true);
    expect(m.keyboard?.[0]?.[0]?.text).toBe('Review 1');
  });

  test('a single line over the limit is cut between tags, entities and characters, with its tags closed and opened again', () => {
    const body = `${'word &amp; '.repeat(800)}<b>${'bold &lt;x&gt; '.repeat(400)}</b> tail 😀 end`;
    const parts = splitMessage(body, 1000);
    expect(parts.length).toBeGreaterThan(5);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(1000);
      expect(wellFormed(p)).toBe(true);
      // No entity or surrogate pair is cut in half.
      expect(/&[a-z#0-9]*$/.test(p.replace(/<\/b>$/, ''))).toBe(false);
      expect(/[\uD800-\uDBFF]$/.test(p)).toBe(false);
    }
    const text = parts
      .map((p) => p.replace(/<\/?b>/g, ''))
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(text).toBe(body.replace(/<\/?b>/g, '').replace(/\s+/g, ' '));
  });

  test('a short message is one part', () => {
    expect(splitMessage('one\ntwo')).toEqual(['one\ntwo']);
  });
});

describe('the summary', () => {
  test('names the job, the counts and each change from what to what, where', () => {
    const html = summaryMessage(
      summary({
        changes: [
          {
            column: 'Call times',
            from: 'Fri 12 Mar 2027: 07:00',
            to: 'Fri 12 Mar 2027: 08:00',
          },
          {
            column: 'Dates',
            from: null,
            to: { start: '2027-03-12', end: '2027-03-13' },
          },
        ],
        kept: [{ column: 'Venue', owner: 'Main hall', sources: 'Acme Arena' }],
        notes: ['Rate: the quote names no currency'],
        sourceNote: 'page text only: over 600 pages',
        decidedInSupamac: [
          {
            detailId: DETAIL,
            status: 'Confirmed',
            name: 'Call time: 07:00',
            at: '2027-03-03T10:05:00.000Z',
          },
        ],
      }),
      'Europe/London'
    ).parts.join('\n');
    expect(html).toContain('<b>call-sheet.pdf</b>: on Telegram, a call sheet');
    expect(html).toContain('Filed under <b>Leeds Lights Gala</b> (a new job).');
    expect(html).toContain(
      '5 details: 3 found in call-sheet.pdf, not confirmed by you; 2 need a look.'
    );
    expect(html).toContain('What changed in <b>Leeds Lights Gala</b>:');
    expect(html).toContain(
      '• Call times: from "Fri 12 Mar 2027: 07:00" to "Fri 12 Mar 2027: 08:00"'
    );
    expect(html).toContain(
      '• Dates: from empty to Fri 12 Mar 2027 to Sat 13 Mar 2027'
    );
    expect(html).toContain(
      '• Venue: yours "Main hall"; the sources say "Acme Arena"'
    );
    expect(html).toContain('• Rate: the quote names no currency');
    expect(html).toContain(
      'Note on the source: page text only: over 600 pages'
    );
    expect(html).toContain(
      '• Call time: 07:00: Confirmed in SupaMac, 3 Mar 2027 10:05'
    );
    expect(html).toContain('check that each was yours');
  });

  test('a source waiting for a filing answer says its details touch no job', () => {
    const html = summaryMessage(
      summary({ jobs: [] }),
      'Europe/London'
    ).parts.join('\n');
    expect(html).toContain(
      'Not filed under a job yet; its details touch no Jobs row until it is.'
    );
  });

  test('no Review button when nothing needs a look', () => {
    const m = summaryMessage(
      summary({
        review: [],
        counts: { details: 2, found: 2, needsReview: 0, replaced: 0 },
      }),
      'Europe/London'
    );
    expect(m.keyboard).toBeUndefined();
  });
});

describe('the review card', () => {
  test('a detail awaiting review is never called found, and carries its quote, page, source and check', () => {
    const c = reviewCardMessage(card(), { remaining: 2 });
    expect(c.html).toContain(
      '<b>Call time</b> (labelled "Crew call"): <b>07:00</b>'
    );
    expect(c.html).toContain('Day: Fri 12 Mar 2027');
    expect(c.html).toContain('Quote: "Crew call 07:00 TBC"');
    expect(c.html).toContain(
      'Status: in call-sheet.pdf, p2; needs your review: the quote says TBC, which the value leaves out; not confirmed by you.'
    );
    expect(c.html).not.toContain('found');
    expect(c.html).toContain('2 other details from this source need a look.');
    expect(c.keyboard[0]?.map((b) => b.text)).toEqual([
      'Confirm',
      'Reject',
      'Skip',
    ]);
  });

  test('a Found detail is worded as found in its source, on its page, not confirmed by you', () => {
    expect(statusWords(card({ status: 'Found', check: '' }))).toBe(
      'found in call-sheet.pdf, p2, not confirmed by you'
    );
  });

  test('a detail from an image says no text was checked, and offers the original', () => {
    const c = reviewCardMessage(
      card({
        imageNote: 'read by the model from an image; no text was checked',
        pageKind: 'scan',
        documentId: '11111111-2222-4333-8444-555555555555',
      })
    );
    expect(c.html).toContain(
      'Status: read by the model from an image; no text was checked (call-sheet.pdf, p2)'
    );
    expect(c.keyboard[1]?.[0]?.text).toBe('Original');
  });

  test('every button’s data is under 64 bytes and reads back as what it was made from', () => {
    const c = reviewCardMessage(card());
    for (const row of c.keyboard)
      for (const b of row) {
        expect(new TextEncoder().encode(b.data).length).toBeLessThanOrEqual(64);
        expect(readCallback(b.data)).toMatchObject({
          detailId: DETAIL,
          fingerprint: 'a1b2c3d4e5f6',
        });
      }
    expect(
      readCallback(
        callbackData({
          kind: 'file',
          sourceId: SOURCE,
          part: 12,
          job: jobKey(JOB),
        })
      )
    ).toEqual({ kind: 'file', sourceId: SOURCE, part: 12, job: jobKey(JOB) });
    expect(readCallback('c:not-a-uuid:abcd')).toBeUndefined();
    expect(readCallback(`v:${SOURCE}:extra`)).toBeUndefined();
  });
});

describe('filing questions', () => {
  const question: FilingQuestion = {
    sourceId: SOURCE,
    sourceName: 'hotel.pdf',
    parts: [
      {
        part: null,
        names: ['Example Hotel Leeds'],
        candidates: [
          {
            jobId: JOB,
            name: 'Leeds Lights Gala',
            why: 'its days include Fri 12 Mar 2027',
          },
        ],
        reason: 'an accommodation confirmation never starts a job by itself',
      },
    ],
  };

  test('asks "File under <job>?" with Yes and New job, and says nothing is filed until then', () => {
    const [m] = filingMessages(question);
    const html = m?.parts.join('\n') ?? '';
    expect(html).toContain('<b>Which job is hotel.pdf for?</b>');
    expect(html).toContain(
      'File under <b>Leeds Lights Gala</b>? its days include Fri 12 Mar 2027'
    );
    expect(html).toContain('Its details touch no Jobs row until you answer.');
    expect(m?.keyboard?.map((r) => r[0]?.text)).toEqual(['Yes', 'New job']);
    expect(readCallback(m?.keyboard?.[0]?.[0]?.data)).toEqual({
      kind: 'file',
      sourceId: SOURCE,
      part: null,
      job: jobKey(JOB),
    });
  });
});

describe('failures', () => {
  const failure = {
    sourceId: SOURCE,
    name: 'call-sheet.pdf',
    reason: 'the reply did not match the schema',
    attempts: 1,
    retry: { sourceId: SOURCE },
  };

  test('a failure from a saved reply that could not be used offers a fresh reading, at the model’s cost', () => {
    const m = failureMessage(failure, { freshReading: true });
    expect(m.parts.join('\n')).toContain(
      'Read again asks the model for a fresh reading, at the model’s cost.'
    );
    expect(m.keyboard?.[0]?.[0]?.text).toBe('Read again (new cost)');
    expect(readCallback(m.keyboard?.[0]?.[0]?.data)).toEqual({
      kind: 'retry',
      sourceId: SOURCE,
      fresh: true,
    });
  });

  test('any other failure’s Retry resumes and never buys a reply twice', () => {
    const m = failureMessage(failure, { freshReading: false });
    expect(m.parts.join('\n')).toContain(
      'a model reply already paid for is not bought again'
    );
    expect(readCallback(m.keyboard?.[0]?.[0]?.data)).toEqual({
      kind: 'retry',
      sourceId: SOURCE,
      fresh: false,
    });
  });
});

describe('long text and names', () => {
  test('a card whose value, quote and check are all long keeps every line under 4,096', () => {
    const long = 'R&D <tbc> & "approx." '.repeat(200);
    const m = reviewCardMessage(
      card({
        value: long,
        quote: `Notes: ${long}`,
        check: `Needs review: ${long}`,
        label: long,
        sourceName: `${'Production pack & schedule '.repeat(30)}.pdf`,
        day: long,
      }),
      { lead: 'Skipped Call time: 07:00; it still needs a look.', remaining: 3 }
    );
    expect(m.html.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    expect(wellFormed(m.html)).toBe(true);
    expect(m.html).toStartWith('Skipped Call time');
    expect(m.html).toContain('Quote: "Notes: R&amp;D');
    expect(m.html).toContain('needs your review: R&amp;D');
    expect(m.html).toContain('not confirmed by you.');
    expect(m.html).toContain('3 other details from this source need a look.');
    expect(m.html).toContain('(cut here; the whole text is in SupaMac)');
  });

  test('a value is cut on its escaped length, never inside an entity', () => {
    const m = reviewCardMessage(card({ value: '&'.repeat(2_000) }));
    const value = /<b>Call time<\/b>[^:]*: <b>([^<]*)<\/b>/.exec(m.html)?.[1];
    expect(value).toBeDefined();
    const kept = (value ?? '').replace(
      '… (cut here; the whole text is in SupaMac)',
      ''
    );
    expect(kept).toBe('&amp;'.repeat(300));
  });

  test('a name is printed on one line, bounded, with its links left out', () => {
    expect(nameText('Fwd: confirm at pay.example.net/login\nnow')).toBe(
      'Fwd: confirm at [link left out] now'
    );
    expect(nameText('call-sheet v2.pdf')).toBe('call-sheet v2.pdf');
    expect(nameText('x'.repeat(500))).toHaveLength(200);
    expect(nameHtml('A & B '.repeat(200)).length).toBeLessThanOrEqual(
      NAME_HTML_LIMIT + 1
    );
    expect(nameHtml('A & B <Ltd>')).toBe('A &amp; B &lt;Ltd&gt;');
    expect(nameText(`${'a'.repeat(198)}😀😀`)).toBe(`${'a'.repeat(198)}…`);
  });

  test('a scan’s caption fits Telegram’s 1,024 whatever its name', () => {
    for (const name of [
      `Production pack ${'R&D '.repeat(240)}scan.pdf`,
      '<'.repeat(5_000),
      'call-sheet.pdf',
    ]) {
      const caption = originalCaption({ sourceName: name, page: 12 });
      expect(caption.length).toBeLessThanOrEqual(MAX_CAPTION_CHARS);
      expect(wellFormed(caption)).toBe(true);
      expect(caption).toContain(', p12: the original.');
      expect(caption).toContain('no text was checked');
    }
    expect(originalCaption({ sourceName: undefined, page: undefined })).toBe(
      'the source: the original. read by the model from an image; no text was checked.'
    );
  });

  test('a refused email’s subject and a filing question’s names carry no link', () => {
    const q = filingMessages({
      sourceId: SOURCE,
      sourceName: 'Re: invite, see www.example.net/pay',
      parts: [
        {
          part: null,
          names: ['Gala at https://pay.example.net/'],
          candidates: [
            { jobId: JOB, name: 'Gala pay.example.net', why: 'the same PO' },
          ],
          reason: 'the client is not found',
        },
      ],
    });
    const html = q.flatMap((m) => m.parts).join('\n');
    expect(html).not.toContain('example.net');
    expect(html).toContain('[link left out]');
  });
});
