// Text a sender or the model shapes reaches the owner's Telegram only as
// marked data: a proposal's words only when the source writes them, the
// model's own strings never echoed, and links left out of every free text
// the service prints (a detail's value and quote aside, shown with their
// status). Fixtures use placeholder domains.

import { describe, expect, test } from 'bun:test';
import { mapExtractionReply } from '../../src/ai/extract';
import { dropLinks, linksIn } from '../../src/ai/words';
import { checkSourceDate, indexSource } from '../../src/checks';
import { writtenWords } from '../../src/pipeline/process';
import {
  failureMessage,
  filingMessages,
  noteMessage,
  refusalTallyMessage,
  refusedMailMessage,
  summaryMessage,
} from '../../src/telegram/render';

const SOURCE = '0b5b4b8e-55a5-4b8e-9b0e-2b8f0c1a2d3e';
const JOB = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PHISH = 'confirm at pay-crew.example.com/verify';

const text = {
  paged: true,
  pages: [
    {
      page: 1,
      kind: 'text' as const,
      lines: ['Leeds Lights Gala', 'Crew call 07:00 at Acme Arena'],
    },
  ],
};

const html = (m: { parts: readonly string[] }): string => m.parts.join('\n');

describe('a proposal’s words', () => {
  test('are kept only when the source writes them', () => {
    expect(writtenWords(text, 'invite.pdf', 'Leeds Lights Gala')).toBe(
      'Leeds Lights Gala'
    );
    expect(
      writtenWords(text, 'invite.pdf', `bank details changed, ${PHISH}`)
    ).toBe('');
  });

  test('a link in a filing reason never reaches the message', () => {
    const [m] = filingMessages({
      sourceId: SOURCE,
      sourceName: 'invite.pdf',
      parts: [
        {
          part: null,
          names: [],
          candidates: [
            {
              jobId: JOB,
              name: 'Leeds',
              why: `the model suggests it, from the source’s words "${PHISH}"`,
            },
          ],
          reason: `see ${PHISH}`,
        },
      ],
    });
    const out = html(m ?? { parts: [] });
    expect(out).not.toContain('pay-crew');
    expect(out).toContain('[link left out]');
  });
});

describe('the model’s own strings', () => {
  test('a job key that names no listed job is not echoed into the problems', () => {
    const reply = mapExtractionReply(
      {
        source_kind: 'Invite',
        jobs: [
          {
            names: ['Leeds Lights Gala'],
            references: [],
            dates: [],
            existing_job: {
              job: `Urgent: re-enter your PO at ${PHISH}`,
              words: 'Leeds Lights Gala',
            },
          },
        ],
        details: [],
      },
      { text, existingJobs: [] }
    );
    expect(reply.problems.join(' ')).not.toContain('pay-crew');
    expect(reply.problems).toEqual([
      'job 0 names a job that is not one of those listed; left out',
    ]);
  });

  test('a source date that is not a date is not echoed into its check', () => {
    const check = checkSourceDate(
      { date: `Urgent ${PHISH}`, quote: 'Leeds Lights Gala', page: 1 },
      indexSource(text)
    );
    expect(check.text).toBe(
      'Needs review: the date given is not a calendar date'
    );
  });

  test('notes, failures and service notes print no link', () => {
    const summary = summaryMessage(
      {
        sourceId: SOURCE,
        name: 'invite.pdf',
        via: 'Email',
        kind: 'Invite',
        status: 'Processed',
        jobs: [],
        counts: { details: 0, found: 0, needsReview: 0, replaced: 0 },
        changes: [],
        kept: [],
        notes: [`Left out of the reply: ${PHISH}.`],
        sourceNote: PHISH,
        review: [],
        decidedInSupamac: [],
      },
      'Europe/London'
    );
    expect(html(summary)).not.toContain('pay-crew');
    const failure = failureMessage(
      {
        sourceId: SOURCE,
        name: 'invite.pdf',
        reason: PHISH,
        attempts: 1,
        retry: { sourceId: SOURCE },
      },
      { freshReading: false }
    );
    expect(html(failure)).not.toContain('pay-crew');
    expect(html(noteMessage({ kind: 'error', text: PHISH }))).not.toContain(
      'pay-crew'
    );
  });
});

describe('refused mail', () => {
  test('the sender is shown as code, which Telegram never makes a link', () => {
    const m = refusedMailMessage({
      from: 'confirm-booking@pay-crew.example.com',
      check: 'the sender is not on the allowed list',
    });
    expect(html(m)).toContain(
      'From: <code>confirm-booking@pay-crew.example.com</code>'
    );
  });

  test('many refusals are one message: the count, the domains as code, the last one', () => {
    const m = refusalTallyMessage(
      {
        count: 3,
        since: '2027-03-05T10:00:00Z',
        domains: ['spam.example.com', 'pay-crew.example.com'],
        last: {
          from: 'x@pay-crew.example.com',
          check: 'the sender is not on the allowed list',
        },
      },
      'Europe/London'
    );
    const out = html(m);
    expect(out).toContain('3 emails to the jobs mailbox were refused');
    expect(out).toContain(
      'Sender domains: <code>spam.example.com</code>, <code>pay-crew.example.com</code>'
    );
    expect(out).toContain('<code>x@pay-crew.example.com</code>');
  });
});

describe('links Telegram makes clickable', () => {
  test('a Unicode domain, a full-width dot and an IP address with a port or path are links', () => {
    for (const written of [
      'pay at пример.испытание/pay now',
      'see evil．example/x',
      'see evil。example/x',
      'see 192.0.2.4:8080/x',
      'see 192.0.2.4/x',
    ]) {
      expect(dropLinks(written).dropped).toBe(1);
      expect(dropLinks(written).text).toContain('[link left out]');
    }
    expect(linksIn('version 1.2.3.4 of the rider')).toEqual([]);
    expect(linksIn('call sheet v2.pdf')).toEqual([]);
  });
});
