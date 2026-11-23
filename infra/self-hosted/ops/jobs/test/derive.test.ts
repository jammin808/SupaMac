import { describe, expect, test } from 'bun:test';
import {
  type CellValue,
  cellsEqual,
  clientKey,
  compareSourceDates,
  decideFiling,
  deriveJobsRow,
  detailName,
  type FilingInput,
  type JobFacts,
  jobFacts,
  planJobsCells,
  senderDomain,
  settle,
  strongReference,
} from '../src/derive';
import type { StoredDetail } from '../src/model';
import { stored } from './fixtures';

// Addresses on real domains (webmail, public suffixes, look-alikes) are
// joined at run time: the repository's personal-data scan reads only
// example domains as placeholders. None of them is a real person's.
const AT = '@';

const TZ = 'Europe/London';

// ---------------------------------------------------------------------------
// Jobs on file.

const LEEDS_ID = 'job-leeds';
const BETA_ID = 'job-beta';

const leedsDetails: StoredDetail[] = [
  stored({
    jobId: LEEDS_ID,
    field: 'PO number',
    value: '4500123',
    quote: 'PO: 4500123',
  }),
  stored({
    jobId: LEEDS_ID,
    field: 'Client',
    value: 'Example Arts Trust Ltd',
    quote: 'Client: Example Arts Trust Ltd',
  }),
  stored({
    jobId: LEEDS_ID,
    field: 'Dates',
    value: '12-13 March 2027',
    quote: 'Dates: Fri 12 - Sat 13 March 2027',
  }),
  stored({
    jobId: LEEDS_ID,
    field: 'Call time',
    value: '07:30',
    day: '2027-03-13',
    label: 'Crew call',
    quote: 'Crew call 07:30',
  }),
  stored({
    jobId: LEEDS_ID,
    field: 'Job reference',
    value: 'LLG-27014',
    status: 'Needs review',
    quote: 'Job ref: LLG-27014',
  }),
];

const betaDetails: StoredDetail[] = [
  stored({
    jobId: BETA_ID,
    field: 'Client',
    value: 'Beta Events',
    quote: 'Client: Beta Events',
  }),
  stored({
    jobId: BETA_ID,
    field: 'Venue',
    value: 'Beta Hall Birmingham',
    quote: 'Venue: Beta Hall Birmingham',
  }),
  stored({
    jobId: BETA_ID,
    field: 'PO number',
    value: '1001',
    quote: 'PO 1001',
  }),
  stored({
    jobId: BETA_ID,
    field: 'Dates',
    value: 'Sat 10 April 2027',
    quote: 'Date: Sat 10 April 2027',
  }),
];

const sources = [
  {
    jobId: LEEDS_ID,
    originalSender: 'Jo Bloggs <jo@acme-productions.example.com>',
    messageId: '<callsheet-v1@acme-productions.example.com>',
  },
  {
    jobId: BETA_ID,
    originalSender: 'bookings@beta-events.example.com',
    messageId: '<beta-1@beta-events.example.com>',
  },
  {
    jobId: undefined,
    originalSender: 'someone@elsewhere.example.com',
    messageId: '<unfiled@elsewhere.example.com>',
  },
];

const leeds = jobFacts(
  { id: LEEDS_ID, name: 'Leeds Lights Gala' },
  [...leedsDetails, ...betaDetails],
  sources
);
const beta = jobFacts(
  { id: BETA_ID, name: 'Beta Awards' },
  [...leedsDetails, ...betaDetails],
  sources
);
const JOBS: JobFacts[] = [leeds, beta];

function input(fields: Partial<FilingInput>): FilingInput {
  return {
    kind: 'Purchase order',
    jobsDescribed: 1,
    details: [],
    threadIds: [],
    proposals: [],
    ...fields,
  };
}

const found = (field: StoredDetail['field'], value: string, day?: string) => ({
  field,
  value,
  status: 'Found' as const,
  ...(day === undefined ? {} : { day }),
});

describe('jobFacts', () => {
  test('holds only Found and Confirmed values, and the senders of filed sources', () => {
    expect(leeds.references).toEqual([{ field: 'PO number', key: '4500123' }]);
    expect(leeds.clients).toEqual(['example arts trust']);
    expect(leeds.senderDomains).toEqual(['acme-productions.example.com']);
    expect(leeds.messageIds).toEqual([
      '<callsheet-v1@acme-productions.example.com>',
    ]);
    expect(leeds.dates).toEqual(['2027-03-12', '2027-03-13']);
    expect(beta.dates).toEqual(['2027-04-10']);
  });
});

describe('filing (design §5)', () => {
  test('files on a Found PO of five or more characters with a digit and the same client', () => {
    const d = decideFiling(
      input({
        details: [
          found('PO number', 'PO-4500123'),
          found('Client', 'Example Arts Trust'),
        ],
      }),
      JOBS
    );
    expect(d).toEqual({
      action: 'file',
      jobId: LEEDS_ID,
      rule: 'reference',
      reason: 'PO number 4500123 and the same client',
    });
  });

  test('files on the PO and the original sender domain when the source names no client', () => {
    const d = decideFiling(
      input({
        details: [found('PO number', '4500123')],
        originalSender: 'sam@acme-productions.example.com',
      }),
      JOBS
    );
    expect(d.action).toBe('file');
    expect(d.action === 'file' && d.reason).toBe(
      'PO number 4500123 and the same sender domain, acme-productions.example.com'
    );
  });

  test('a matching PO from a different client is a question, not a filing', () => {
    const d = decideFiling(
      input({
        details: [found('PO number', '4500123'), found('Client', 'Gamma Live')],
      }),
      JOBS
    );
    expect(d.action).toBe('ask');
    expect(d.action === 'ask' && d.candidates).toEqual([
      { jobId: LEEDS_ID, why: 'PO number 4500123, but a different client' },
    ]);
  });

  test('a matching PO beside a job reference the job does not have is a question', () => {
    const job = jobFacts(
      { id: LEEDS_ID, name: 'Leeds Lights Gala' },
      [
        ...leedsDetails,
        stored({
          jobId: LEEDS_ID,
          field: 'Job reference',
          value: 'LLG-27014',
          quote: 'Job ref: LLG-27014',
        }),
      ],
      sources
    );
    const d = decideFiling(
      input({
        details: [
          found('PO number', '4500123'),
          found('Job reference', 'GLA-27020'),
          found('Client', 'Example Arts Trust'),
        ],
      }),
      [job, beta]
    );
    expect(d.action).toBe('ask');
    expect(d.action === 'ask' && d.candidates[0]?.why).toBe(
      "PO number 4500123, but its Job reference GLA27020 is not the job's"
    );
  });

  test('a webmail domain does not show the client', () => {
    expect(senderDomain('someone' + AT + 'gmail.com')).toBeUndefined();
    const d = decideFiling(
      input({
        details: [found('PO number', '4500123')],
        originalSender: 'freelance.booker' + AT + 'gmail.com',
      }),
      JOBS
    );
    expect(d.action).toBe('ask');
  });

  test('a short or unchecked reference only makes a candidate', () => {
    expect(strongReference('1001')).toBe(false);
    expect(strongReference('4500123')).toBe(true);
    expect(strongReference('ABCDE')).toBe(false);
    const short = decideFiling(
      input({
        details: [found('PO number', '1001'), found('Client', 'Beta Events')],
      }),
      JOBS
    );
    expect(short).toEqual({
      action: 'ask',
      candidates: [
        { jobId: BETA_ID, why: 'PO number 1001 (too short to file by)' },
      ],
      reason: 'it may belong to a job on file',
    });
    const unchecked = decideFiling(
      input({
        details: [
          { field: 'PO number', value: '4500123', status: 'Needs review' },
          found('Client', 'Example Arts Trust'),
        ],
      }),
      JOBS
    );
    expect(unchecked.action).toBe('ask');
  });

  test('two clients at the same venue on the same day are never merged', () => {
    const d = decideFiling(
      input({
        kind: 'Invite',
        details: [
          found('Client', 'Gamma Live'),
          found('Venue', 'Beta Hall Birmingham'),
          found('Dates', 'Sat 10 April 2027'),
        ],
        proposals: [{ jobId: BETA_ID, words: 'Beta Hall Birmingham' }],
      }),
      JOBS
    );
    expect(d.action).toBe('ask');
    expect(d.action === 'ask' && d.candidates).toEqual([
      {
        jobId: BETA_ID,
        why: 'the model suggests it: Beta Hall Birmingham; it shares Sat 10 Apr 2027',
      },
    ]);
  });

  test('a reply in a filed thread files there when it names no new date', () => {
    const d = decideFiling(
      input({
        kind: 'Call sheet',
        threadIds: ['<callsheet-v1@acme-productions.example.com>'],
        details: [found('Call time', '08:00', '2027-03-13')],
      }),
      JOBS
    );
    expect(d).toEqual({
      action: 'file',
      jobId: LEEDS_ID,
      rule: 'thread',
      reason: 'a reply in a thread filed under Leeds Lights Gala',
    });
  });

  test('"are you also free for Glasgow on the 20th?" in the same thread is a question', () => {
    const d = decideFiling(
      input({
        kind: 'Invite',
        threadIds: ['<callsheet-v1@acme-productions.example.com>'],
        details: [
          found('Venue', 'Gamma Hall Glasgow'),
          {
            field: 'Dates',
            value: 'Sat 20 March 2027',
            status: 'Needs review',
          },
        ],
      }),
      JOBS
    );
    expect(d.action).toBe('ask');
    expect(d.action === 'ask' && d.candidates[0]?.why).toBe(
      'its thread is filed there, but it names Sat 20 Mar 2027'
    );
  });

  test('a thread reply with a short reference to another job is a question; to its own job it files', () => {
    const toNec = decideFiling(
      input({
        threadIds: ['<callsheet-v1@acme-productions.example.com>'],
        details: [found('PO number', '1001')],
      }),
      JOBS
    );
    expect(toNec.action).toBe('ask');
    const shortLeeds = jobFacts(
      { id: LEEDS_ID, name: 'Leeds Lights Gala' },
      [
        stored({
          jobId: LEEDS_ID,
          field: 'PO number',
          value: '2201',
          quote: 'PO 2201',
        }),
      ],
      sources
    );
    const own = decideFiling(
      input({
        threadIds: ['<callsheet-v1@acme-productions.example.com>'],
        details: [found('PO number', '2201')],
      }),
      [shortLeeds, beta]
    );
    expect(own.action).toBe('file');
  });

  test('a thread reply naming a date without a year is a question', () => {
    const d = decideFiling(
      input({
        threadIds: ['<callsheet-v1@acme-productions.example.com>'],
        details: [found('Dates', 'Sat 13th')],
      }),
      JOBS
    );
    expect(d.action).toBe('ask');
  });

  test('an attachment files with its email unless its own references conflict', () => {
    expect(
      decideFiling(
        input({ attachmentOf: { state: 'filed', jobId: LEEDS_ID } }),
        JOBS
      )
    ).toEqual({
      action: 'file',
      jobId: LEEDS_ID,
      rule: 'attachment',
      reason: 'filed with its email under Leeds Lights Gala',
    });
    const conflict = decideFiling(
      input({
        attachmentOf: { state: 'filed', jobId: LEEDS_ID },
        details: [found('PO number', '4500999')],
      }),
      JOBS
    );
    expect(conflict.action).toBe('ask');
    expect(conflict.action === 'ask' && conflict.reason).toContain(
      "its PO number 4500999 is not Leeds Lights Gala's"
    );
    expect(
      decideFiling(input({ attachmentOf: { state: 'waiting' } }), JOBS)
    ).toEqual({
      action: 'wait',
      reason: 'it waits with its email',
    });
  });

  test('a travel or accommodation confirmation never starts a job', () => {
    const d = decideFiling(
      input({
        kind: 'Accommodation confirmation',
        details: [found('Hotel', 'Example Hotel Leeds')],
      }),
      JOBS
    );
    expect(d).toEqual({
      action: 'ask',
      candidates: [],
      reason:
        'a travel or accommodation confirmation never starts a job by itself',
    });
  });

  test('a new invite that matches nothing starts a job; Other is asked about', () => {
    expect(
      decideFiling(
        input({
          kind: 'Invite',
          details: [found('Venue', 'Delta Hall')],
        }),
        JOBS
      ).action
    ).toBe('new_job');
    expect(decideFiling(input({ kind: 'Other' }), JOBS).action).toBe('ask');
  });

  test('a source describing several jobs waits; one not about a job is not a job', () => {
    expect(
      decideFiling(input({ kind: 'Invite', jobsDescribed: 2 }), JOBS)
    ).toEqual({ action: 'wait', reason: 'the source describes 2 jobs' });
    expect(decideFiling(input({ kind: 'Not about a job' }), JOBS).action).toBe(
      'not_a_job'
    );
  });

  test('client names compare without case, punctuation or a company suffix', () => {
    expect(clientKey('Example Arts Trust Ltd.')).toBe(
      clientKey('example arts trust')
    );
    expect(clientKey('The Acme Productions Limited')).toBe('acme productions');
    expect(clientKey('Acme & Co')).toBe('acme co');
  });
});

// ---------------------------------------------------------------------------
// Replacement.

describe('source dates', () => {
  test('order by the source date, by day in the owner zone, never by processing order', () => {
    expect(compareSourceDates('2027-03-10', '2027-03-01', TZ)).toBe('after');
    expect(compareSourceDates('2027-03-01', '2027-03-10', TZ)).toBe('before');
    expect(compareSourceDates('2027-03-10', '2027-03-10', TZ)).toBe('unknown');
    expect(compareSourceDates(undefined, '2027-03-10', TZ)).toBe('unknown');
    expect(
      compareSourceDates('2027-03-10T09:00:00Z', '2027-03-10T08:00:00Z', TZ)
    ).toBe('after');
    expect(compareSourceDates('2027-03-10T23:30:00Z', '2027-03-11', TZ)).toBe(
      'before'
    );
    expect(
      compareSourceDates('2027-03-10T23:30:00Z', '2027-03-11', 'Asia/Tokyo')
    ).toBe('unknown');
    expect(compareSourceDates('2027-07-10T23:30:00Z', '2027-07-11', TZ)).toBe(
      'unknown'
    );
    expect(compareSourceDates('last Tuesday', '2027-03-11', TZ)).toBe(
      'unknown'
    );
  });
});

describe('settle', () => {
  const call = (
    fields: Partial<StoredDetail> & Pick<StoredDetail, 'value'>
  ): StoredDetail =>
    stored({
      field: 'Call time',
      day: '2027-03-13',
      label: 'Crew call',
      quote: `Crew call ${fields.value}`,
      ...fields,
    });

  test('an older source processed after a newer one is Replaced, and changes nothing', () => {
    const v2 = call({ id: 'v2', value: '08:00', sourceDate: '2027-03-10' });
    const v1 = call({ id: 'v1', value: '07:00', sourceDate: '2027-03-01' });
    const s = settle([v2], [v1], { timeZone: TZ });
    expect(s.replaced).toEqual([]);
    expect(s.details[0]?.status).toBe('Replaced');
    expect(
      s.details[0]?.check.startsWith(
        'Replaced: replaced by 08:00 from a newer source.'
      )
    ).toBe(true);
  });

  test('a newer Found value replaces an older Found one in the same scope', () => {
    const v1 = call({ id: 'v1', value: '07:00', sourceDate: '2027-03-01' });
    const v2 = call({ id: 'v2', value: '08:00', sourceDate: '2027-03-10' });
    const s = settle([v1], [v2], { timeZone: TZ });
    expect(s.details[0]?.status).toBe('Found');
    expect(s.replaced.map((r) => [r.id, r.by])).toEqual([['v1', 'v2']]);
  });

  test('a confirmed value challenged by a newer source waits for review', () => {
    const confirmed = call({
      id: 'c',
      value: '07:00',
      status: 'Confirmed',
      sourceDate: '2027-03-01',
    });
    const newer = call({ id: 'n', value: '08:00', sourceDate: '2027-03-10' });
    const s = settle([confirmed], [newer], { timeZone: TZ });
    expect(s.replaced).toEqual([]);
    expect(s.details[0]?.status).toBe('Needs review');
    expect(s.details[0]?.check).toContain(
      '07:00 (confirmed); a newer source says 08:00, not confirmed'
    );
  });

  test('any change to a sensitive field waits for review', () => {
    for (const field of [
      'Rate',
      'Per diem',
      'Payment terms',
      'Invoice to',
      'Booking reference',
    ] as const) {
      const old = stored({
        id: `${field}-old`,
        field,
        value: field === 'Rate' || field === 'Per diem' ? '£350' : 'ABC-12345',
        sourceDate: '2027-03-01',
      });
      const next = stored({
        id: `${field}-new`,
        field,
        value: field === 'Rate' || field === 'Per diem' ? '£400' : 'XYZ-99999',
        sourceDate: '2027-03-10',
      });
      const s = settle([old], [next], { timeZone: TZ });
      expect(s.replaced).toEqual([]);
      expect(s.details[0]?.status).toBe('Needs review');
      expect(s.details[0]?.check).toContain(
        `a change to ${field} waits for review`
      );
    }
  });

  test('when the order is not known both values stay and the later one needs review', () => {
    const undated = call({ id: 'a', value: '07:00' });
    const dated = call({ id: 'b', value: '08:00', sourceDate: '2027-03-10' });
    const s = settle([undated], [dated], { timeZone: TZ });
    expect(s.replaced).toEqual([]);
    expect(s.details[0]?.status).toBe('Needs review');
    expect(s.details[0]?.check).toContain(
      'another source says 07:00 (not confirmed) and which is newer is not known'
    );
  });

  test('two values in the same scope from one source: the second needs review', () => {
    const s = settle(
      [],
      [
        call({ id: 'x', value: '07:00', sourceDate: '2027-03-10' }),
        call({ id: 'y', value: '08:00', sourceDate: '2027-03-10' }),
      ],
      { timeZone: TZ }
    );
    expect(s.details.map((d) => d.status)).toEqual(['Found', 'Needs review']);
  });

  test('a value from quoted history never replaces a message value', () => {
    const message = call({ id: 'm', value: '08:00', sourceDate: '2027-03-01' });
    const history = call({
      id: 'h',
      value: '07:00',
      sourceDate: '2027-03-05',
      history: true,
    });
    const s = settle([message], [history], { timeZone: TZ });
    expect(s.replaced).toEqual([]);
    expect(s.details[0]?.status).toBe('Needs review');
    const older = settle(
      [message],
      [
        call({
          id: 'h2',
          value: '07:00',
          sourceDate: '2027-02-20',
          history: true,
        }),
      ],
      { timeZone: TZ }
    );
    expect(older.details[0]?.status).toBe('Replaced');
  });

  test('a re-forwarded rejected value needs review and says when it was rejected', () => {
    const rejected = stored({
      id: 'r',
      field: 'Rate',
      value: '£300 per day',
      status: 'Rejected',
      decidedAt: '2027-03-02T09:00:00Z',
    });
    for (const value of ['£300 per day', '£300/day', 'GBP 300 per day']) {
      const again = stored({
        id: `again-${value}`,
        field: 'Rate',
        value,
        sourceDate: '2027-03-06',
        history: true,
      });
      const s = settle([rejected], [again], { timeZone: TZ });
      expect(s.details[0]?.status).toBe('Needs review');
      expect(
        s.details[0]?.check.startsWith(
          'Needs review: you rejected this on 2 Mar 2027.'
        )
      ).toBe(true);
    }
    const other = settle(
      [rejected],
      [stored({ id: 'o', field: 'Rate', value: '£350 per day' })],
      { timeZone: TZ }
    );
    expect(other.details[0]?.status).toBe('Found');
  });

  test('contacts and travel accumulate', () => {
    const sam = stored({
      id: 's',
      field: 'Contact',
      value: 'Sam Price 07700 900123',
      sourceDate: '2027-03-01',
    });
    const alex = stored({
      id: 'a',
      field: 'Contact',
      value: 'Alex Lee 07700 900456',
      sourceDate: '2027-03-10',
    });
    const out = stored({
      id: 'o',
      field: 'Travel',
      value: 'Outbound train 06:40',
      day: '2027-03-12',
    });
    const back = stored({
      id: 'b',
      field: 'Travel',
      value: 'Return train 19:05',
      day: '2027-03-12',
    });
    const s = settle([sam, out], [alex, back], { timeZone: TZ });
    expect(s.replaced).toEqual([]);
    expect(s.details.map((d) => d.status)).toEqual(['Found', 'Found']);
  });

  test('call times on other days or under other labels do not replace each other', () => {
    const fri = call({
      id: 'f',
      value: '08:00',
      day: '2027-03-12',
      sourceDate: '2027-03-01',
    });
    const performers = call({
      id: 'p',
      value: '09:00',
      label: 'Performers',
      quote: 'Performers 09:00',
      sourceDate: '2027-03-01',
    });
    const crew = call({ id: 'c', value: '07:30', sourceDate: '2027-03-10' });
    const s = settle([fri, performers], [crew], { timeZone: TZ });
    expect(s.replaced).toEqual([]);
    expect(s.details[0]?.status).toBe('Found');
  });

  test('the same value again corroborates and replaces nothing', () => {
    const s = settle(
      [call({ id: 'a', value: '08:00', sourceDate: '2027-03-01' })],
      [call({ id: 'b', value: '8am', sourceDate: '2027-03-10' })],
      {
        timeZone: TZ,
      }
    );
    expect(s.replaced).toEqual([]);
    expect(s.details[0]?.status).toBe('Found');
  });

  test("the owner's note never replaces a document's value without a confirmation", () => {
    const doc = call({ id: 'd', value: '09:00', sourceDate: '2027-03-01' });
    const note = call({
      id: 'n',
      value: '08:00',
      origin: 'note',
      sourceDate: '2027-03-10',
    });
    const s = settle([doc], [note], { timeZone: TZ });
    expect(s.replaced).toEqual([]);
    expect(s.details[0]?.status).toBe('Needs review');
    expect(s.details[0]?.check).toContain(
      'your note does not replace it until you confirm it'
    );
  });

  test('a document never replaces a value the owner entered', () => {
    const own = call({
      id: 'o',
      value: '07:45',
      origin: 'owner',
      status: 'Confirmed',
      sourceDate: '2027-03-01',
    });
    const s = settle(
      [own],
      [call({ id: 'd', value: '08:00', sourceDate: '2027-03-10' })],
      { timeZone: TZ }
    );
    expect(s.details[0]?.check).toContain(
      '07:45 (entered by you); a newer source says 08:00, not confirmed'
    );
  });

  test('a replaced value no longer counts for later details of the same run', () => {
    const v1 = call({ id: 'v1', value: '07:00', sourceDate: '2027-03-01' });
    const v2 = call({ id: 'v2', value: '08:00', sourceDate: '2027-03-10' });
    const v3 = call({
      id: 'v3',
      value: '07:00',
      sourceDate: '2027-03-11',
      sourceId: 'src-3',
    });
    const s = settle([v1], [v2, v3], { timeZone: TZ });
    expect(s.replaced.map((r) => [r.id, r.by])).toEqual([
      ['v1', 'v2'],
      ['v2', 'v3'],
    ]);
  });

  test('details not yet filed under a job are returned unchanged', () => {
    const loose = call({ id: 'l', value: '08:00', jobId: undefined });
    expect(
      settle([call({ id: 'x', value: '07:00' })], [loose], { timeZone: TZ })
        .details
    ).toEqual([loose]);
  });
});

// ---------------------------------------------------------------------------
// The Jobs row.

describe('deriveJobsRow (design §6)', () => {
  const row: StoredDetail[] = [
    stored({
      field: 'Event',
      value: 'Leeds Lights Gala',
      quote: 'Event: Leeds Lights Gala',
    }),
    stored({
      field: 'Client',
      value: 'Example Arts Trust',
      status: 'Confirmed',
      quote: 'Client: Example Arts Trust',
    }),
    stored({
      field: 'Venue',
      value: 'Acme Arena',
      quote: 'Venue: Acme Arena',
    }),
    stored({
      field: 'Dates',
      value: '12-13 March 2027',
      quote: 'Dates: Fri 12 - Sat 13 March 2027',
    }),
    stored({
      field: 'Call time',
      value: '08:00',
      day: '2027-03-12',
      label: 'Crew call',
      quote: 'Crew call 08:00',
    }),
    stored({
      field: 'Call time',
      value: '07:30',
      day: '2027-03-13',
      label: 'Crew call',
      status: 'Confirmed',
      quote: 'Crew call 07:30',
    }),
    stored({
      field: 'Call time',
      value: '09:00',
      day: '2027-03-13',
      label: 'Performer call',
      quote: 'Performer call 09:00',
    }),
    stored({
      field: 'Call time',
      value: '07:00',
      day: '2027-03-13',
      label: 'Crew call',
      status: 'Replaced',
      quote: 'Crew call 07:00',
    }),
    stored({
      field: 'Travel',
      value: 'Return train 19:05 Leeds to London Kings Cross',
      day: '2027-03-14',
      quote: 'Return train 19:05 Leeds to London Kings Cross',
    }),
    stored({
      field: 'Travel',
      value: 'Outbound train 06:40 London Kings Cross to Leeds',
      day: '2027-03-12',
      quote: 'Outbound train 06:40 London Kings Cross to Leeds',
    }),
    stored({
      field: 'Hotel',
      value: 'Example Hotel Leeds',
      quote: 'Hotel: Example Hotel Leeds',
    }),
    stored({
      field: 'Check-in',
      value: 'Fri 12 March 2027',
      quote: 'Check-in: Fri 12 March 2027',
    }),
    stored({
      field: 'Check-out',
      value: 'Sun 14 March 2027',
      quote: 'Check-out: Sun 14 March 2027',
    }),
    stored({
      field: 'Contact',
      value: 'Sam Price 07700 900123',
      quote: 'Production manager Sam Price 07700 900123',
    }),
    stored({
      field: 'Contact',
      value: 'Alex Lee 07700 900456',
      status: 'Confirmed',
      quote: 'Stage manager Alex Lee 07700 900456',
    }),
    stored({
      field: 'Rate',
      value: '£350/day + VAT',
      quote: 'Rate: £350/day + VAT',
    }),
    stored({
      field: 'Rate',
      value: '£300 per day',
      status: 'Rejected',
      quote: 'Rate £300 per day',
    }),
    stored({ field: 'PO number', value: '4500123', quote: 'PO: 4500123' }),
    stored({
      field: 'Load-in',
      value: '08:00',
      status: 'Needs review',
      quote: 'Load-in 08:00 or 09:00 TBC',
    }),
  ];

  test('derives every column from Found and Confirmed details only', () => {
    const { cells, days } = deriveJobsRow(row, { timeZone: TZ });
    expect(days).toEqual(['2027-03-12', '2027-03-13', '2027-03-14']);
    expect(cells).toEqual({
      Dates: { start: '2027-03-12', end: '2027-03-13' },
      Days: 'Fri 12 Mar 2027, Sat 13 Mar 2027, Sun 14 Mar 2027',
      Client: 'Example Arts Trust',
      'Production company': null,
      Event: 'Leeds Lights Gala',
      Role: null,
      Venue: 'Acme Arena',
      'Venue address': null,
      'Call times':
        'Fri 12 Mar 2027: 08:00; Sat 13 Mar 2027: 07:30 (crew call); Sat 13 Mar 2027: 09:00 (performer call)',
      Travel:
        'Fri 12 Mar 2027: Outbound train 06:40 London Kings Cross to Leeds; Sun 14 Mar 2027: Return train 19:05 Leeds to London Kings Cross',
      Accommodation:
        'Example Hotel Leeds, check-in Fri 12 March 2027, check-out Sun 14 March 2027',
      Contacts: 'Sam Price 07700 900123; Alex Lee 07700 900456',
      'PO number': '4500123',
      'Job reference': null,
      Rate: 350,
      Currency: 'GBP',
      'Rate basis': 'per day + VAT',
      'Payment terms': null,
      'Invoice to': null,
      'Not confirmed': [
        'Dates',
        'Days',
        'Event',
        'Venue',
        'Call times',
        'Travel',
        'Accommodation',
        'Contacts',
        'PO number',
        'Rate',
        'Currency',
        'Rate basis',
      ],
      'Needs review': 1,
    });
  });

  test('Dates stays empty unless one quote states a contiguous range; the days still go in Days', () => {
    const { cells } = deriveJobsRow(
      [
        stored({
          field: 'Dates',
          value: '12 March 2027',
          quote: 'Dates: 12 March 2027 and 14 March 2027',
        }),
        stored({
          field: 'Call time',
          value: '10:00',
          day: '2027-03-14',
          quote: 'Call 10:00',
        }),
      ],
      { timeZone: TZ }
    );
    expect(cells.Dates).toBeNull();
    expect(cells.Days).toBe('Fri 12 Mar 2027, Sun 14 Mar 2027');
  });

  test('Currency and basis come only from the Rate quote', () => {
    const preBasis = deriveJobsRow(
      [
        stored({
          field: 'Rate',
          value: '£350 + VAT',
          quote: 'Day rate £350 + VAT',
        }),
      ],
      { timeZone: TZ }
    );
    expect([
      preBasis.cells.Rate,
      preBasis.cells.Currency,
      preBasis.cells['Rate basis'],
    ]).toEqual([350, 'GBP', 'per day + VAT']);
    const plain = deriveJobsRow(
      [stored({ field: 'Rate', value: '350', quote: 'Fee: 350' })],
      { timeZone: TZ }
    );
    expect([
      plain.cells.Rate,
      plain.cells.Currency,
      plain.cells['Rate basis'],
    ]).toEqual([350, null, null]);
  });

  test('a confirmed value stays in view when a newer source says otherwise', () => {
    const { cells } = deriveJobsRow(
      [
        stored({
          field: 'Call time',
          value: '07:00',
          day: '2027-03-13',
          label: 'Crew call',
          status: 'Confirmed',
          sourceDate: '2027-03-01',
          quote: 'Crew call 07:00',
        }),
        stored({
          field: 'Call time',
          value: '08:00',
          day: '2027-03-13',
          label: 'Crew call',
          status: 'Needs review',
          sourceDate: '2027-03-10',
          quote: 'Crew call 08:00',
        }),
        stored({
          field: 'Venue',
          value: 'Acme Arena',
          label: 'Venue',
          status: 'Confirmed',
          sourceDate: '2027-03-01',
        }),
        stored({
          field: 'Venue',
          value: 'Acme Hall',
          label: 'Location',
          sourceDate: '2027-03-10',
          quote: 'Location: Acme Hall',
        }),
      ],
      { timeZone: TZ }
    );
    expect(cells['Call times']).toBe(
      'Sat 13 Mar 2027: 07:00 (confirmed); a newer source says 08:00, not confirmed'
    );
    expect(cells.Venue).toBe(
      'Acme Arena (confirmed); a newer source says Acme Hall, not confirmed'
    );
    expect(cells['Not confirmed']).toEqual(['Venue']);
    expect(cells['Needs review']).toBe(1);
  });

  test('when which is newer is not known the cell shows both', () => {
    const { cells } = deriveJobsRow(
      [
        stored({ field: 'Venue', value: 'Acme Arena', label: 'Venue' }),
        stored({
          field: 'Venue',
          value: 'Acme Hall',
          label: 'Location',
          quote: 'Location: Acme Hall',
        }),
        stored({
          field: 'Event',
          value: 'Leeds Lights Gala',
          sourceDate: '2027-03-01',
        }),
        stored({
          field: 'Event',
          value: 'Leeds Lights Gala 2027',
          status: 'Needs review',
        }),
      ],
      { timeZone: TZ }
    );
    expect(cells.Venue).toBe(
      'Acme Arena / Acme Hall (which is newer is not known)'
    );
    expect(cells.Event).toBe(
      'Leeds Lights Gala; another source says Leeds Lights Gala 2027, not confirmed'
    );
  });

  test('an older pending value is not shown, and nothing pending makes a value', () => {
    const { cells } = deriveJobsRow(
      [
        stored({
          field: 'Event',
          value: 'Leeds Lights Gala',
          sourceDate: '2027-03-10',
        }),
        stored({
          field: 'Event',
          value: 'Leeds Lights',
          status: 'Needs review',
          sourceDate: '2027-03-01',
        }),
        stored({
          field: 'Role',
          value: 'Lighting technician',
          status: 'Needs review',
        }),
      ],
      { timeZone: TZ }
    );
    expect(cells.Event).toBe('Leeds Lights Gala');
    expect(cells.Role).toBeNull();
    expect(cells['Needs review']).toBe(2);
  });
});

describe('planJobsCells', () => {
  const derived = deriveJobsRow(
    [
      stored({
        field: 'Venue',
        value: 'Acme Arena',
        status: 'Confirmed',
      }),
      stored({
        field: 'Event',
        value: 'Leeds Lights Gala',
        status: 'Confirmed',
      }),
      stored({
        field: 'Rate',
        value: '£350/day',
        quote: 'Rate: £350/day',
        status: 'Confirmed',
      }),
    ],
    { timeZone: TZ }
  ).cells;

  test('writes cells that are empty or still hold what the service last wrote', () => {
    const plan = planJobsCells(
      derived,
      { Event: 'Leeds Lights' },
      { Event: 'Leeds Lights' }
    );
    expect(plan.writes).toEqual({
      Event: 'Leeds Lights Gala',
      Venue: 'Acme Arena',
      Rate: 350,
      Currency: 'GBP',
      'Rate basis': 'per day',
      'Needs review': 0,
    });
    expect(plan.kept).toEqual([]);
  });

  test('keeps a value the owner typed and reports the disagreement', () => {
    const plan = planJobsCells(
      derived,
      { Venue: 'Acme Arena, Leeds', Rate: 375 },
      { Venue: 'Acme Arena', Rate: 350 }
    );
    expect(plan.writes.Venue).toBeUndefined();
    expect(plan.writes.Rate).toBeUndefined();
    expect(plan.kept).toEqual([
      {
        column: 'Venue',
        owner: 'Acme Arena, Leeds',
        sources: 'Acme Arena',
      },
      { column: 'Rate', owner: 375, sources: 350 },
    ]);
  });

  test('a cell that already equals the derived value is left alone, and Booking is never planned', () => {
    const current: Partial<Record<string, CellValue>> = {
      Venue: 'Acme Arena',
      Booking: 'Booked',
      'Needs review': 0,
    };
    const plan = planJobsCells(derived, current, {});
    expect(plan.writes.Venue).toBeUndefined();
    expect(Object.keys(plan.writes)).not.toContain('Booking');
    expect(Object.keys(plan.writes)).not.toContain('Needs review');
  });

  test('clears a cell the service wrote when its value is gone', () => {
    const plan = planJobsCells(derived, { Role: 'Rigger' }, { Role: 'Rigger' });
    expect(plan.writes).toMatchObject({ Role: null });
  });

  test('compares tags as sets and blanks as empty', () => {
    expect(cellsEqual(['Venue', 'Rate'], ['Rate', 'Venue'])).toBe(true);
    expect(cellsEqual('', null)).toBe(true);
    expect(cellsEqual([], null)).toBe(true);
    expect(
      cellsEqual(
        { start: '2027-03-12', end: '2027-03-13' },
        { start: '2027-03-12', end: '2027-03-13' }
      )
    ).toBe(true);
    expect(cellsEqual(350, '350')).toBe(false);
  });
});

describe('detailName', () => {
  test('marks every detail that is neither Found nor Confirmed', () => {
    expect(detailName('Call time', ' 07:00 ', 'Found')).toBe(
      'Call time: 07:00'
    );
    expect(detailName('Call time', '07:00', 'Confirmed')).toBe(
      'Call time: 07:00'
    );
    expect(detailName('Rate', '£300 per day', 'Needs review')).toBe(
      'Unconfirmed · Rate: £300 per day'
    );
    expect(detailName('Rate', '£300 per day', 'Rejected')).toBe(
      'Unconfirmed · Rate: £300 per day'
    );
  });
});

describe('rivals under another label, owner values and reasons', () => {
  const venue = (fields: Partial<StoredDetail> & Pick<StoredDetail, 'value'>) =>
    stored({ field: 'Venue', ...fields });

  test('a newer plain value under another label stays Found and the row shows it', () => {
    const old = venue({
      id: 'v1',
      value: 'Acme Arena',
      sourceDate: '2027-03-01',
    });
    const next = venue({
      id: 'v2',
      value: 'Acme Hall',
      quote: 'Location: Acme Hall',
      sourceDate: '2027-03-10',
    });
    const s = settle([old], [next], { timeZone: TZ });
    expect(s.details[0]?.status).toBe('Found');
    expect(s.replaced).toEqual([]);
    expect(
      deriveJobsRow([old, ...s.details], { timeZone: TZ }).cells.Venue
    ).toBe('Acme Hall');
  });

  test('a value under another label with no known order waits for review', () => {
    const s = settle(
      [venue({ id: 'v1', value: 'Acme Arena' })],
      [venue({ id: 'v2', value: 'Acme Hall', quote: 'Location: Acme Hall' })],
      { timeZone: TZ }
    );
    expect(s.details[0]?.status).toBe('Needs review');
    expect(s.reasons).toEqual([{ id: 'v2', codes: ['order_unknown'] }]);
  });

  test('an older value under another label changes nothing and stays', () => {
    const s = settle(
      [
        stored({
          id: 'r1',
          field: 'Rate',
          value: '£400/day',
          quote: 'Fee: £400/day',
          sourceDate: '2027-03-10',
        }),
      ],
      [
        stored({
          id: 'r2',
          field: 'Rate',
          value: '£350/day',
          quote: 'Rate: £350/day',
          sourceDate: '2027-03-01',
        }),
      ],
      { timeZone: TZ }
    );
    expect(s.details[0]?.status).toBe('Found');
    expect(s.reasons).toEqual([]);
  });

  test('fields the row lists by day or not at all do not meet other labels', () => {
    const s = settle(
      [
        stored({
          id: 'p1',
          field: 'Per diem',
          value: '£25',
          quote: 'Per diem: £25',
          sourceDate: '2027-03-01',
        }),
      ],
      [
        stored({
          id: 'p2',
          field: 'Per diem',
          value: '£10',
          quote: 'Meal buyout: £10',
          sourceDate: '2027-03-10',
        }),
      ],
      { timeZone: TZ }
    );
    expect(s.details[0]?.status).toBe('Found');
  });

  test('the reasons name why settle changed each detail', () => {
    const old = stored({
      id: 'pt1',
      field: 'Payment terms',
      value: '30 days',
      quote: 'Payment terms: 30 days',
      sourceDate: '2027-03-01',
    });
    const next = stored({
      id: 'pt2',
      field: 'Payment terms',
      value: '60 days',
      quote: 'Terms: 60 days',
      sourceDate: '2027-03-10',
    });
    const s = settle([old], [next], { timeZone: TZ });
    expect(s.reasons).toEqual([{ id: 'pt2', codes: ['sensitive_change'] }]);
    expect(s.details[0]?.check).toContain(
      'a change to Payment terms waits for review'
    );
  });

  test("the owner's own value is never set to review or replaced", () => {
    const doc = venue({
      id: 'd',
      value: 'Acme Hall',
      sourceDate: '2027-03-02',
    });
    const mine = venue({ id: 'o', value: 'Acme Studio', origin: 'owner' });
    const s = settle([doc], [mine], { timeZone: TZ });
    expect(s.details).toEqual([mine]);
    expect(s.replaced).toEqual([]);
  });

  test('a newer unconfirmed Rate leaves the confirmed number in the cell and says so in a note', () => {
    const confirmed = stored({
      field: 'Rate',
      value: '£350/day',
      quote: 'Rate: £350/day',
      status: 'Confirmed',
      sourceDate: '2027-03-01',
    });
    const newer = stored({
      field: 'Rate',
      value: '£400/day',
      quote: 'Rate: £400/day',
      sourceDate: '2027-03-10',
    });
    const row = deriveJobsRow([confirmed, newer], { timeZone: TZ });
    expect(row.cells.Rate).toBe(350);
    expect(row.notes).toEqual([
      {
        column: 'Rate',
        text: '£350/day (confirmed); a newer source says £400/day, not confirmed',
      },
    ]);
    const pending = deriveJobsRow(
      [confirmed, { ...newer, status: 'Needs review' }],
      { timeZone: TZ }
    );
    expect(pending.cells.Rate).toBe(350);
    expect(pending.notes[0]?.text).toContain(
      'a newer source says £400/day, not confirmed'
    );
  });

  test('Days lists check-in, check-out and dates a value writes, never an impossible day', () => {
    const row = deriveJobsRow(
      [
        stored({
          field: 'Check-in',
          value: 'Fri 12 March 2027',
          quote: 'Check-in: Fri 12 March 2027',
        }),
        stored({
          field: 'Check-out',
          value: 'Sun 14 March 2027',
          quote: 'Check-out: Sun 14 March 2027',
        }),
        stored({
          field: 'Travel',
          value: 'Train 20 March 2027 08:15 to Glasgow',
          quote: 'Train 20 March 2027 08:15 to Glasgow',
        }),
        stored({
          field: 'Call time',
          value: '08:00',
          day: '2027-02-30',
          quote: 'Crew call 08:00',
        }),
      ],
      { timeZone: TZ }
    );
    expect(row.days).toEqual(['2027-03-12', '2027-03-14', '2027-03-20']);
  });
});

describe('filing on references of another kind and odd days', () => {
  test('a PO equal to a job reference on a job only makes it a candidate', () => {
    const job = jobFacts(
      { id: 'job-x', name: 'Example Show' },
      [
        stored({
          jobId: 'job-x',
          field: 'Job reference',
          value: '4500777',
          quote: 'Job ref: 4500777',
        }),
        stored({ jobId: 'job-x', field: 'Client', value: 'Acme Productions' }),
      ],
      []
    );
    const d = decideFiling(
      input({
        details: [
          found('PO number', '4500777'),
          found('Client', 'Acme Productions'),
        ],
      }),
      [job]
    );
    expect(d.action).toBe('ask');
    expect(d.action === 'ask' && d.candidates[0]?.why).toContain(
      'is a reference of another kind there'
    );
  });

  test('a day that is not a calendar date never throws and is not placed', () => {
    const d = decideFiling(
      input({
        kind: 'Call sheet',
        threadIds: ['<callsheet-v1@acme-productions.example.com>'],
        details: [
          {
            field: 'Call time',
            value: '08:00',
            day: '2027-02-30',
            status: 'Needs review',
          },
        ],
      }),
      JOBS
    );
    expect(d.action).toBe('ask');
  });

  test('a date in a quote of the reply counts as one it names', () => {
    const d = decideFiling(
      input({
        kind: 'Call sheet',
        threadIds: ['<callsheet-v1@acme-productions.example.com>'],
        details: [
          {
            field: 'Call time',
            value: '08:00',
            status: 'Found',
            quote: 'Crew call 08:00 on Sat 20 March 2027',
          },
        ],
      }),
      JOBS
    );
    expect(d.action).toBe('ask');
  });
});
