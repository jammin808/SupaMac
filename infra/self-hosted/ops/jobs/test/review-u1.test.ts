// An independent review of the core unit against docs/supamac/jobs.md §4–§6.
// Each test states what the design requires; a failing test is a finding.
// Every name, company and number is a placeholder.

import { describe, expect, test } from 'bun:test';
import {
  type CheckResult,
  checkDetail,
  indexSource,
  valueKey,
} from '../src/checks';
import {
  type DerivedCells,
  decideFiling,
  deriveJobsRow,
  jobFacts,
  planJobsCells,
  settle,
} from '../src/derive';
import {
  type CandidateDetail,
  DERIVED_COLUMNS,
  type SourceText,
  type StoredDetail,
} from '../src/model';
import { candidate, page, stored } from './fixtures';

const TZ = 'Europe/London';

function onePage(lines: string[]): SourceText {
  return { paged: false, pages: [page(1, lines)] };
}

function check(lines: string[], c: CandidateDetail): CheckResult {
  return checkDetail(c, indexSource(onePage(lines)));
}

/** A quote that is the whole of a one-line source. */
function line(
  text: string,
  fields: Omit<CandidateDetail, 'quote' | 'label'> & { label?: string }
): CheckResult {
  return check([text], candidate({ ...fields, quote: text }));
}

function emptyCells(): Record<(typeof DERIVED_COLUMNS)[number], null> {
  return Object.fromEntries(DERIVED_COLUMNS.map((c) => [c, null])) as Record<
    (typeof DERIVED_COLUMNS)[number],
    null
  >;
}

// ---------------------------------------------------------------------------
// Inputs the unit handles as the design says (kept as a regression table).

describe('holds: adversarial inputs the checks treat as the design says', () => {
  const reviews: [string, string, Omit<CandidateDetail, 'quote' | 'label'>][] =
    [
      ['not', 'Crew call not 07:00', { field: 'Call time', value: '07:00' }],
      [
        'TBC glued',
        'Crew call 07:00(TBC)',
        { field: 'Call time', value: '07:00' },
      ],
      [
        't.b.c.',
        'Crew call 07:00 t.b.c.',
        { field: 'Call time', value: '07:00' },
      ],
      [
        'or',
        'Hotel: Example Hotel or Example Inn',
        { field: 'Hotel', value: 'Example Hotel' },
      ],
      [
        'unless',
        'Crew call 07:00 unless advised',
        { field: 'Call time', value: '07:00' },
      ],
      [
        'subject to',
        'Rate £350/day subject to PO',
        { field: 'Rate', value: '£350/day' },
      ],
      ['circa', 'Finish c. 23:00', { field: 'Finish', value: '23:00' }],
      ['tilde', 'Finish ~23:00', { field: 'Finish', value: '23:00' }],
      [
        "n't",
        "Parking isn't available on site",
        { field: 'Access and parking', value: 'available on site' },
      ],
      [
        'two times glued',
        'Crew call 07:00/08:00',
        { field: 'Call time', value: '07:00' },
      ],
      ['two amounts', 'Rate: £300-£350', { field: 'Rate', value: '£300' }],
      ['amount with k', 'Budget £3k', { field: 'Rate', value: '£3' }],
      [
        'two references',
        'PO: 4500 123',
        { field: 'PO number', value: '4500 123' },
      ],
      [
        'bare number',
        'Call at 7 for riggers',
        { field: 'Call time', value: '7am' },
      ],
      [
        '7.30 is open',
        'Crew call 7.30',
        { field: 'Call time', value: '07:30' },
      ],
      ['am left out', 'Crew call 7am', { field: 'Call time', value: '7:00' }],
      ['currency left out', 'Rate: £350', { field: 'Rate', value: '350' }],
      ['currency not written', 'Rate: 350', { field: 'Rate', value: '£350' }],
      ['VAT left out', 'Rate: £350 + VAT', { field: 'Rate', value: '£350' }],
      ['basis left out', 'Rate: £350 a day', { field: 'Rate', value: '£350' }],
      ['€1.200', 'Fee: €1.200', { field: 'Rate', value: '€1200' }],
      ['euro 1,200', 'Fee: €1,200', { field: 'Rate', value: '€1200' }],
      [
        'weekday wrong',
        'Check-in: Fri 13 March 2027',
        { field: 'Check-in', value: '13 March 2027' },
      ],
      [
        'range weekday wrong',
        'Dates: Fri 13 - Sun 15 March 2027',
        { field: 'Dates', value: '13-15 March 2027' },
      ],
      [
        'range narrowed',
        'Dates: 12-14 March 2027',
        { field: 'Dates', value: '12 March 2027' },
      ],
      [
        '03/04 alone',
        'Crew call 07:00 on 03/04/2027',
        { field: 'Call time', value: '07:00', day: '2027-04-03' },
      ],
      [
        'day in a range',
        'Crew call 07:00 on 12-13 March 2027',
        { field: 'Call time', value: '07:00', day: '2027-03-12' },
      ],
      [
        'weekday only',
        'Saturday crew call 07:30',
        { field: 'Call time', value: '07:30', day: '2027-03-13' },
      ],
      [
        'the next day',
        'Crew call the next day 07:00',
        { field: 'Call time', value: '07:00' },
      ],
      [
        'label only in value',
        'Hotel Example Leeds',
        { field: 'Hotel', value: 'Hotel Example Leeds' },
      ],
    ];
  for (const [name, text, fields] of reviews) {
    test(`needs review: ${name}`, () => {
      expect(line(text, fields).status).toBe('Needs review');
    });
  }

  test('a quote repeated under two headings is not Found for the later day', () => {
    const r = check(
      [
        'Fri 12 March 2027',
        'Crew call 07:00',
        'Sat 13 March 2027',
        'Crew call 07:00',
      ],
      candidate({
        field: 'Call time',
        value: '07:00',
        day: '2027-03-13',
        day_quote: 'Sat 13 March 2027',
        quote: 'Crew call 07:00',
      })
    );
    expect(r.status).toBe('Needs review');
  });

  test('a scan page is always Needs review', () => {
    const r = checkDetail(
      candidate({
        field: 'Venue',
        value: 'Acme Hall',
        quote: 'Venue: Acme Hall',
      }),
      indexSource({ paged: false, pages: [page(1, [], 'scan')] })
    );
    expect(r.status).toBe('Needs review');
    expect(r.text).toContain(
      'read by the model from an image; no text was checked'
    );
  });

  test('a rejected value comes back Needs review in another spelling', () => {
    const rejected = stored({
      id: 'rej',
      field: 'Rate',
      value: '£350',
      status: 'Rejected',
      decidedAt: '2027-03-06T10:00:00Z',
    });
    const again = stored({
      id: 'again',
      field: 'Rate',
      value: 'GBP 350',
      sourceDate: '2027-03-09',
    });
    const s = settle([rejected], [again], { timeZone: TZ });
    expect(s.details[0]?.status).toBe('Needs review');
    expect(s.details[0]?.check).toContain('you rejected this on 6 Mar 2027');
  });

  test('a cell the owner typed stays and is reported', () => {
    const derived: DerivedCells = { ...emptyCells(), Venue: 'Acme Hall' };
    const plan = planJobsCells(
      derived,
      { Venue: 'Beta Theatre York' },
      { Venue: 'Leeds' }
    );
    expect(plan.writes).toEqual({});
    expect(plan.kept).toEqual([
      { column: 'Venue', owner: 'Beta Theatre York', sources: 'Acme Hall' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// F1. Negation: "no" before a number is dropped as an abbreviation.

describe('F1 §4 check 3: "no" before a number still negates', () => {
  test('"Access: No 24hr access" is not Found as "24hr access"', () => {
    expect(
      line('Access: No 24hr access', {
        field: 'Access and parking',
        value: '24hr access',
      }).status
    ).toBe('Needs review');
  });
  test('"Parking: no 2 hour parking on site" is not Found', () => {
    expect(
      line('Parking: no 2 hour parking on site', {
        field: 'Access and parking',
        value: '2 hour parking on site',
      }).status
    ).toBe('Needs review');
  });
  test('"Per diem: no £25 buyout this time" is not Found as £25', () => {
    expect(
      line('Per diem: no £25 buyout this time', {
        field: 'Per diem',
        value: '£25',
      }).status
    ).toBe('Needs review');
  });
});

// ---------------------------------------------------------------------------
// F2. Time ranges count as one time.

describe('F2 §4 check 3: a time range is more than one time', () => {
  const cases: [string, string, string][] = [
    ['Crew call 7-8am', 'Call time', '8am'],
    ['Get-in 1-3pm', 'Load-in', '3pm'],
    ['Crew call 7:30-8', 'Call time', '7:30'],
    ['Crew call between 7 and 8am', 'Call time', '8am'],
    ['Doors 7 to 7.30pm', 'Show time', '7.30pm'],
  ];
  for (const [text, field, value] of cases) {
    test(`"${text}" is not Found as "${value}"`, () => {
      expect(
        line(text, { field: field as CandidateDetail['field'], value }).status
      ).toBe('Needs review');
    });
  }
});

// ---------------------------------------------------------------------------
// F3. A bare number beside a marked amount is dropped.

describe('F3 §4 check 3: the quote must hold exactly one amount', () => {
  test('"Rate: 350-400 GBP" is not Found as "400 GBP"', () => {
    expect(
      line('Rate: 350-400 GBP', { field: 'Rate', value: '400 GBP' }).status
    ).toBe('Needs review');
  });
  test('"Rate: £300 to 350" is not Found as "£300"', () => {
    expect(
      line('Rate: £300 to 350', { field: 'Rate', value: '£300' }).status
    ).toBe('Needs review');
  });
  test('"Fee: £1 200" is not Found as "£1", and the Rate cell is not 1', () => {
    const r = line('Fee: £1 200', { field: 'Rate', value: '£1' });
    expect(r.status).toBe('Needs review');
    const row = deriveJobsRow(
      [stored({ field: 'Rate', value: '£1 200', quote: 'Fee: £1 200' })],
      { timeZone: TZ }
    );
    expect(row.cells.Rate).not.toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F4. Tax words the parser does not attach to the amount may be left out.

describe('F4 §4 check 3: tax words stay in the value', () => {
  const cases: [string, string][] = [
    ['Rate: £350 per day, plus VAT', '£350 per day'],
    ['Rate: £350 + 20% VAT', '£350'],
    ['Rate: £350 + V.A.T.', '£350'],
    ['Day rate (ex VAT): £350', '£350'],
    ['Fee: £350 net of VAT', '£350'],
  ];
  for (const [text, value] of cases) {
    test(`"${text}" is not Found as "${value}"`, () => {
      expect(line(text, { field: 'Rate', value }).status).toBe('Needs review');
    });
  }
  test('the Rate basis cell carries the VAT of "£350 per day, plus VAT"', () => {
    const row = deriveJobsRow(
      [
        stored({
          field: 'Rate',
          value: '£350 per day',
          quote: 'Rate: £350 per day, plus VAT',
        }),
      ],
      { timeZone: TZ }
    );
    expect(String(row.cells['Rate basis'])).toContain('VAT');
  });
});

// ---------------------------------------------------------------------------
// F5. A list of days is read as its last date.

describe('F5 §4 check 3 and §6 Dates: a list of days is not one date', () => {
  test('"Dates: 12, 13 and 14 March 2027" is not Found as 14 March', () => {
    expect(
      line('Dates: 12, 13 and 14 March 2027', {
        field: 'Dates',
        value: '14 March 2027',
      }).status
    ).toBe('Needs review');
  });
  test('"Crew call 07:00 on 12 & 13 March 2027" does not give the day as the 13th alone', () => {
    expect(
      line('Crew call 07:00 on 12 & 13 March 2027', {
        field: 'Call time',
        value: '07:00',
        day: '2027-03-13',
      }).status
    ).toBe('Needs review');
  });
  test('the Dates cell is not the last day of a list', () => {
    const row = deriveJobsRow(
      [
        stored({
          field: 'Dates',
          value: '14 March 2027',
          quote: 'Dates: 12, 13 and 14 March 2027',
        }),
      ],
      { timeZone: TZ }
    );
    expect(row.cells.Dates).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F6. A missing month is taken from an unrelated full date on the page.

describe('F6 §4 check 3/4: a missing month is never filled from another date', () => {
  test('"Issued 28 February 2027" does not make "Sat 13th" 13 February', () => {
    const r = check(
      [
        'CREW SCHEDULE',
        'Issued 28 February 2027',
        'Sat 13th',
        'Crew call 07:30',
      ],
      candidate({
        field: 'Call time',
        value: '07:30',
        day: '2027-02-13',
        day_quote: 'Sat 13th',
        quote: 'Crew call 07:30',
      })
    );
    expect(r.status).toBe('Needs review');
  });
});

// ---------------------------------------------------------------------------
// F7. Any dated line above counts as the date heading.

describe('F7 §4 check 4: day_quote must be a date heading', () => {
  test('an invoice date above a call time is not its day', () => {
    const r = check(
      ['Invoice date: 3 March 2027', 'Call time 07:00'],
      candidate({
        field: 'Call time',
        value: '07:00',
        day: '2027-03-03',
        day_quote: '3 March 2027',
        quote: 'Call time 07:00',
      })
    );
    expect(r.status).toBe('Needs review');
  });
});

// ---------------------------------------------------------------------------
// F8. Relative days the parser does not know, and day headings between.

describe('F8 §4 check 4: a relative day needs review', () => {
  test('"Second day: crew call 07:30" under a Fri heading is not Found on Fri', () => {
    const r = check(
      [
        'Fri 12 March 2027',
        'First day: crew call 08:00',
        'Second day: crew call 07:30',
      ],
      candidate({
        field: 'Call time',
        value: '07:30',
        day: '2027-03-12',
        day_quote: 'Fri 12 March 2027',
        quote: 'Second day: crew call 07:30',
      })
    );
    expect(r.status).toBe('Needs review');
  });
  test('"Last day: crew call 07:30" is not Found on the heading day', () => {
    const r = check(
      ['Fri 12 March 2027', 'Crew call 08:00', 'Last day: crew call 07:30'],
      candidate({
        field: 'Call time',
        value: '07:30',
        day: '2027-03-12',
        day_quote: 'Fri 12 March 2027',
        quote: 'Last day: crew call 07:30',
      })
    );
    expect(r.status).toBe('Needs review');
  });
  test('a "DAY 2" heading between the Day 1 date and the quote stops the heading', () => {
    const r = check(
      [
        'DAY 1 - FRI 12 MARCH 2027',
        'Crew call 08:00',
        'DAY 2',
        'Crew call 07:30',
      ],
      candidate({
        field: 'Call time',
        value: '07:30',
        day: '2027-03-12',
        day_quote: 'FRI 12 MARCH 2027',
        quote: 'Crew call 07:30',
      })
    );
    expect(r.status).toBe('Needs review');
  });
  test('a "Show day" heading between stops the heading', () => {
    const r = check(
      ['Fri 12 March 2027', 'Get-in 08:00', 'Show day', 'Crew call 07:30'],
      candidate({
        field: 'Call time',
        value: '07:30',
        day: '2027-03-12',
        day_quote: 'Fri 12 March 2027',
        quote: 'Crew call 07:30',
      })
    );
    expect(r.status).toBe('Needs review');
  });
});

// ---------------------------------------------------------------------------
// F9. A label word of another field passes check 2.

describe("F9 §4 check 2: the quote names the detail's field", () => {
  test('"Booking ref: MAL-77821" is not Found as a Job reference', () => {
    expect(
      line('Booking ref: MAL-77821', {
        field: 'Job reference',
        value: 'MAL-77821',
      }).status
    ).toBe('Needs review');
  });
  test('"Show start 19:30" is not Found as a Call time', () => {
    expect(
      line('Show start 19:30', { field: 'Call time', value: '19:30' }).status
    ).toBe('Needs review');
  });
  test('"Crew call 07:00" is not Found as a Contact', () => {
    expect(
      line('Crew call 07:00', { field: 'Contact', value: '07:00' }).status
    ).toBe('Needs review');
  });
});

// ---------------------------------------------------------------------------
// F10. A sensitive change under another label word replaces in the row with no review.

describe('F10 §6: any change to Rate or Payment terms waits for review', () => {
  test('"Fee: £400/day" after "Rate: £350/day" waits, and the Rate cell stays 350', () => {
    const old = stored({
      id: 'rate-old',
      field: 'Rate',
      value: '£350/day',
      quote: 'Rate: £350/day',
      sourceDate: '2027-03-01',
    });
    const next = stored({
      id: 'rate-new',
      field: 'Rate',
      value: '£400/day',
      quote: 'Fee: £400/day',
      sourceDate: '2027-03-10',
    });
    const s = settle([old], [next], { timeZone: TZ });
    expect(s.details[0]?.status).toBe('Needs review');
    const row = deriveJobsRow([old, ...s.details], { timeZone: TZ });
    expect(row.cells.Rate).toBe(350);
  });
  test('"Terms: 60 days" after "Payment terms: 30 days" waits', () => {
    const old = stored({
      id: 'pt-old',
      field: 'Payment terms',
      value: '30 days',
      quote: 'Payment terms: 30 days',
      sourceDate: '2027-03-01',
    });
    const next = stored({
      id: 'pt-new',
      field: 'Payment terms',
      value: '60 days',
      quote: 'Terms: 60 days',
      sourceDate: '2027-03-10',
    });
    const s = settle([old], [next], { timeZone: TZ });
    expect(s.details[0]?.status).toBe('Needs review');
    const row = deriveJobsRow([old, ...s.details], { timeZone: TZ });
    expect(row.cells['Payment terms']).not.toBe('60 days');
  });
});

// ---------------------------------------------------------------------------
// F11. A confirmed value challenged under another label word.

describe('F11 §6: a value that would replace a confirmed one waits for review', () => {
  test('a newer "Day rate: £400/day" against a confirmed £350 waits, and Rate stays 350', () => {
    const confirmed = stored({
      id: 'rate-confirmed',
      field: 'Rate',
      value: '£350/day',
      quote: 'Rate: £350/day',
      sourceDate: '2027-03-01',
      status: 'Confirmed',
    });
    const next = stored({
      id: 'rate-challenge',
      field: 'Rate',
      value: '£400/day',
      quote: 'Day rate: £400/day',
      sourceDate: '2027-03-10',
    });
    const s = settle([confirmed], [next], { timeZone: TZ });
    expect(s.details[0]?.status).toBe('Needs review');
    const row = deriveJobsRow([confirmed, ...s.details], { timeZone: TZ });
    expect(row.cells.Rate).toBe(350);
  });
  test('a newer "Location: Gamma Arena Manchester" against a confirmed venue is counted for review', () => {
    const confirmed = stored({
      id: 'venue-confirmed',
      field: 'Venue',
      value: 'Acme Hall',
      quote: 'Venue: Acme Hall',
      sourceDate: '2027-03-01',
      status: 'Confirmed',
    });
    const next = stored({
      id: 'venue-challenge',
      field: 'Venue',
      value: 'Gamma Arena Manchester',
      quote: 'Location: Gamma Arena Manchester',
      sourceDate: '2027-03-10',
    });
    const s = settle([confirmed], [next], { timeZone: TZ });
    const row = deriveJobsRow([confirmed, ...s.details], { timeZone: TZ });
    expect(row.cells['Needs review']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F12. The owner's own Rate value vanishes from the row.

describe('F12 §6 and Edits in SupaMac: the owner value stands in the Rate cell', () => {
  test('an owner-entered £400/day shows as Rate 400', () => {
    const owner = stored({
      id: 'rate-owner',
      field: 'Rate',
      value: '£400/day',
      quote: 'Rate: £350/day',
      origin: 'owner',
      status: 'Confirmed',
    });
    const row = deriveJobsRow([owner], { timeZone: TZ });
    expect(row.cells.Rate).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// F13. Filing by references that are not equal.

describe('F13 §5: files only on an equal reference', () => {
  test('reservation RES12345 is not equal to job reference BK12345', () => {
    const jobs = [
      jobFacts(
        { id: 'job-leeds', name: 'Leeds Lights Gala' },
        [
          stored({ field: 'Job reference', value: 'BK12345' }),
          stored({ field: 'Client', value: 'Acme Productions Ltd' }),
        ],
        []
      ),
    ];
    const decision = decideFiling(
      {
        kind: 'Invite',
        jobsDescribed: 1,
        details: [
          { field: 'PO number', value: 'RES12345', status: 'Found' },
          {
            field: 'Client',
            value: 'Acme Productions Limited',
            status: 'Found',
          },
        ],
        threadIds: [],
        proposals: [],
      },
      jobs
    );
    expect(decision.action).not.toBe('file');
  });
});

// ---------------------------------------------------------------------------
// F14. An attachment's own conflicting reference is ignored unless Found.

describe('F14 §5: an attachment files with its email unless its own references conflict', () => {
  test("an attachment carrying another job's PO is asked about", () => {
    const jobs = [
      jobFacts(
        { id: 'job-a', name: 'Leeds' },
        [stored({ jobId: 'job-a', field: 'PO number', value: '4500123' })],
        []
      ),
      jobFacts(
        { id: 'job-b', name: 'York' },
        [stored({ jobId: 'job-b', field: 'PO number', value: '4500999' })],
        []
      ),
    ];
    const decision = decideFiling(
      {
        kind: 'Purchase order',
        jobsDescribed: 1,
        details: [
          { field: 'PO number', value: '4500999', status: 'Needs review' },
        ],
        threadIds: [],
        proposals: [],
        attachmentOf: { state: 'filed', jobId: 'job-a' },
      },
      jobs
    );
    expect(decision.action).toBe('ask');
  });
});

// ---------------------------------------------------------------------------
// F15. The thread rule misses dates written in a detail's value.

describe('F15 §5: a thread reply that names a new date is a question', () => {
  test('"Train 20 March 2027 08:15 to Glasgow" names a date the job does not have', () => {
    const jobs = [
      jobFacts(
        { id: 'job-a', name: 'Leeds' },
        [
          stored({
            jobId: 'job-a',
            field: 'Call time',
            value: '07:00',
            day: '2027-03-13',
          }),
        ],
        [{ jobId: 'job-a', messageId: '<m1@example.com>' }]
      ),
    ];
    const decision = decideFiling(
      {
        kind: 'Other',
        jobsDescribed: 1,
        details: [
          {
            field: 'Travel',
            value: 'Train 20 March 2027 08:15 to Glasgow',
            status: 'Found',
          },
        ],
        threadIds: ['<m1@example.com>'],
        proposals: [],
      },
      jobs
    );
    expect(decision.action).toBe('ask');
  });
});

// ---------------------------------------------------------------------------
// F16. Line separators other than "\n" crash the checks and derivation.

describe('F16 robustness: odd line breaks from a model reply never throw', () => {
  const src = onePage(['Crew call 07:00']);
  test('a quote with a vertical tab is refused, not thrown', () => {
    expect(() =>
      checkDetail(
        candidate({
          field: 'Call time',
          value: '07:00',
          quote: 'Crew call\u000b07:00',
        }),
        indexSource(src)
      )
    ).not.toThrow();
  });
  test('a value with a next-line character is refused, not thrown', () => {
    expect(() =>
      checkDetail(
        candidate({
          field: 'Call time',
          value: '07:00\u0085',
          quote: 'Crew call 07:00',
        }),
        indexSource(src)
      )
    ).not.toThrow();
  });
  test('valueKey of a value with a line separator does not throw', () => {
    expect(() => valueKey('Call time', '07:00 08:00')).not.toThrow();
  });
  test('settle does not throw on a stored value holding a carriage return', () => {
    const d: StoredDetail = stored({
      field: 'Call time',
      value: '07:00\r08:00',
      status: 'Needs review',
      check: 'Needs review: the value spans more than one line',
    });
    expect(() => settle([], [d], { timeZone: TZ })).not.toThrow();
  });
  test('deriveJobsRow does not throw on a stored quote holding a carriage return', () => {
    const d: StoredDetail = stored({
      field: 'Call time',
      value: '07:00',
      quote: 'Crew call\r07:00',
    });
    expect(() => deriveJobsRow([d], { timeZone: TZ })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Minor findings.

describe('M1 §4 check 3: hedges the list misses', () => {
  const cases: [string, Omit<CandidateDetail, 'quote' | 'label'>][] = [
    [
      'Hotel: cannot be booked yet, Example Hotel',
      { field: 'Hotel', value: 'Example Hotel' },
    ],
    [
      'Parking: neither on site nor nearby',
      { field: 'Access and parking', value: 'on site' },
    ],
    ['Finish 23:00 (estimate)', { field: 'Finish', value: '23:00' }],
    ['Rate: £350/day negotiable', { field: 'Rate', value: '£350/day' }],
  ];
  for (const [text, fields] of cases) {
    test(`"${text}" needs review`, () => {
      expect(line(text, fields).status).toBe('Needs review');
    });
  }
  test('a TBC in the next sentence of the same line is seen', () => {
    const r = check(
      ['Rate: £350/day. TBC'],
      candidate({ field: 'Rate', value: '£350/day', quote: 'Rate: £350/day' })
    );
    expect(r.status).toBe('Needs review');
  });
});

describe('M2 §4 check 3: a numeric date is settled only by that date in words', () => {
  test('"3 April 2026" does not settle "03/04/2027"', () => {
    const r = check(
      ['Issued 3 April 2026', 'Crew call 07:00 on 03/04/2027'],
      candidate({
        field: 'Call time',
        value: '07:00',
        day: '2027-04-03',
        quote: 'Crew call 07:00 on 03/04/2027',
      })
    );
    expect(r.status).toBe('Needs review');
  });
});

describe('M3 §6 Rate/Currency: currency only from the quote own symbol or code', () => {
  test('"$350/day" does not set Currency to USD', () => {
    const row = deriveJobsRow(
      [stored({ field: 'Rate', value: '$350/day', quote: 'Rate: $350/day' })],
      { timeZone: TZ }
    );
    expect(row.cells.Currency).not.toBe('USD');
  });
  test('"350 quid a day" is not Found as a bare 350', () => {
    expect(
      line('Rate: 350 quid a day', { field: 'Rate', value: '350' }).status
    ).toBe('Needs review');
  });
});

describe('M4 §6 Days: every day a detail names', () => {
  test('a Check-in date is in Days', () => {
    const row = deriveJobsRow(
      [
        stored({
          field: 'Check-in',
          value: 'Fri 12 March 2027',
          quote: 'Check-in: Fri 12 March 2027',
        }),
      ],
      { timeZone: TZ }
    );
    expect(String(row.cells.Days)).toContain('12 Mar 2027');
  });
});

describe('M5 §5: a reference match beside a thread filed elsewhere is a question', () => {
  test('a Found PO of job A in a thread filed under job B is asked about', () => {
    const jobs = [
      jobFacts(
        { id: 'job-a', name: 'Leeds' },
        [
          stored({ jobId: 'job-a', field: 'PO number', value: '4500123' }),
          stored({
            jobId: 'job-a',
            field: 'Client',
            value: 'Acme Productions',
          }),
        ],
        []
      ),
      jobFacts(
        { id: 'job-b', name: 'York' },
        [],
        [{ jobId: 'job-b', messageId: '<m9@example.com>' }]
      ),
    ];
    const decision = decideFiling(
      {
        kind: 'Purchase order',
        jobsDescribed: 1,
        details: [
          { field: 'PO number', value: '4500123', status: 'Found' },
          { field: 'Client', value: 'Acme Productions', status: 'Found' },
        ],
        threadIds: ['<m9@example.com>'],
        proposals: [],
      },
      jobs
    );
    expect(decision.action).toBe('ask');
  });
});

describe('M6 §6 owner-typed cells: a disagreement needs a source value', () => {
  test('an owner-typed cell with no source value is not reported as a disagreement', () => {
    const plan = planJobsCells(
      emptyCells(),
      { Venue: 'Beta Theatre York' },
      {}
    );
    expect(plan.kept).toEqual([]);
  });
});
