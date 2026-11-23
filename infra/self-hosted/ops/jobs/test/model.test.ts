import { describe, expect, test } from 'bun:test';
import {
  BOOKING_OPTIONS,
  CandidateDetailSchema,
  DERIVED_COLUMNS,
  DETAIL_STATUSES,
  FIELD_NAMES,
  FIELDS,
  HEDGE_WORDS,
  isCalendarDate,
  isCurrent,
  isTypedKind,
  JOB_STARTING_KINDS,
  JOBS_COLUMN_TYPES,
  JOBS_COLUMNS,
  SOURCE_KINDS,
  SOURCE_STATUSES,
  VALUE_KINDS,
  VIA_OPTIONS,
} from '../src/model';
import { termsOf } from '../src/normalize';

describe('fields', () => {
  test('every field of the design has a spec under its own name', () => {
    expect([...FIELD_NAMES]).toEqual([
      'Event',
      'Client',
      'Production company',
      'Role',
      'Job reference',
      'PO number',
      'Dates',
      'Venue',
      'Venue address',
      'Access and parking',
      'Call time',
      'Load-in',
      'Show time',
      'Load-out',
      'Finish',
      'Travel',
      'Travel booked by',
      'Hotel',
      'Hotel address',
      'Check-in',
      'Check-out',
      'Booking reference',
      'Per diem',
      'Rate',
      'Overtime',
      'Payment terms',
      'Invoice to',
      'Contact',
      'Dress code',
      'Catering',
      'Kit to bring',
      'Credentials and passes',
      'Health and safety',
      'Other',
    ]);
    for (const name of FIELD_NAMES) {
      expect(FIELDS[name].name).toBe(name);
      expect(VALUE_KINDS).toContain(FIELDS[name].kind);
    }
  });

  test('value kinds follow what each field holds', () => {
    const kinds = Object.fromEntries(
      FIELD_NAMES.map((n) => [n, FIELDS[n].kind])
    );
    expect(kinds).toMatchObject({
      'Call time': 'time',
      'Load-in': 'time',
      'Show time': 'time',
      'Load-out': 'time',
      Finish: 'time',
      Dates: 'date_range',
      'Check-in': 'date',
      'Check-out': 'date',
      'PO number': 'reference',
      'Job reference': 'reference',
      'Booking reference': 'reference',
      Rate: 'amount',
      'Per diem': 'amount',
      Overtime: 'amount',
      Contact: 'contact',
      Venue: 'text',
      Hotel: 'text',
      Other: 'text',
    });
  });

  test('every field but Other has label words, none repeated once normalised', () => {
    for (const name of FIELD_NAMES) {
      const labels = FIELDS[name].labels;
      if (name === 'Other') {
        expect(labels).toEqual([]);
        continue;
      }
      expect(labels.length).toBeGreaterThan(2);
      const keys = labels.map((l) => termsOf(l).join(' '));
      for (const k of keys) expect(k).not.toBe('');
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  test('the lexicon holds the words UK paperwork uses', () => {
    const has = (field: (typeof FIELD_NAMES)[number], ...words: string[]) => {
      const keys = FIELDS[field].labels.map((l) => termsOf(l).join(' '));
      for (const w of words) expect(keys).toContain(termsOf(w).join(' '));
    };
    has('Call time', 'call', 'crew call', 'call time');
    has('Load-in', 'load-in', 'load in', 'get-in', 'get in');
    has(
      'PO number',
      'PO',
      'P.O.',
      'purchase order',
      'order no',
      'order number'
    );
    has('Hotel', 'hotel', 'accommodation', 'staying at');
    has('Rate', 'rate', 'fee', 'day rate');
    has('Load-out', 'load-out', 'get-out');
    has('Health and safety', 'H&S', 'RAMS', 'hi-vis');
  });

  test('only Contact and Travel always accumulate; Call time and Hotel are per day', () => {
    const many = FIELD_NAMES.filter((n) => FIELDS[n].multiplicity === 'many');
    const perDay = FIELD_NAMES.filter(
      (n) => FIELDS[n].multiplicity === 'per_day'
    );
    expect(many).toEqual(['Travel', 'Contact']);
    expect(perDay).toEqual(['Call time', 'Hotel']);
  });

  test('the sensitive fields are exactly those whose change waits for review', () => {
    expect(FIELD_NAMES.filter((n) => FIELDS[n].sensitive)).toEqual([
      'Booking reference',
      'Per diem',
      'Rate',
      'Payment terms',
      'Invoice to',
    ]);
  });

  test('each field feeds the Jobs column its rule names', () => {
    const fed = new Set<string>();
    for (const name of FIELD_NAMES) {
      const rule = FIELDS[name].column;
      if (
        rule.rule === 'newest' ||
        rule.rule === 'by_day' ||
        rule.rule === 'list'
      ) {
        expect(JOBS_COLUMNS).toContain(rule.column);
        fed.add(rule.column);
      }
    }
    expect([...fed].sort()).toEqual(
      [
        'Call times',
        'Client',
        'Contacts',
        'Event',
        'Invoice to',
        'Job reference',
        'PO number',
        'Payment terms',
        'Production company',
        'Role',
        'Travel',
        'Venue',
        'Venue address',
      ].sort()
    );
    expect(FIELDS.Dates.column).toEqual({ rule: 'dates' });
    expect(FIELDS.Rate.column).toEqual({ rule: 'rate' });
    expect(FIELDS.Hotel.column).toEqual({
      rule: 'accommodation',
      part: 'hotel',
    });
    expect(FIELDS['Load-in'].column).toEqual({ rule: 'none' });
  });

  test('typed kinds are parsed; text and contact are not', () => {
    expect(VALUE_KINDS.filter(isTypedKind)).toEqual([
      'date',
      'date_range',
      'time',
      'amount',
      'reference',
    ]);
  });
});

describe('statuses and options', () => {
  test('are the select options of the design', () => {
    expect([...DETAIL_STATUSES]).toEqual([
      'Found',
      'Needs review',
      'Confirmed',
      'Rejected',
      'Replaced',
    ]);
    expect([...SOURCE_STATUSES]).toEqual([
      'Processing',
      'Processed',
      'Needs review',
      'Not a job',
      'Skipped',
      'Failed',
    ]);
    expect([...BOOKING_OPTIONS]).toEqual([
      'Enquiry',
      'Pencilled',
      'Booked',
      'Completed',
      'Cancelled',
    ]);
    expect([...VIA_OPTIONS]).toEqual(['Email', 'Telegram', 'Folder', 'Note']);
    expect(SOURCE_KINDS).toContain('Not about a job');
    expect(JOB_STARTING_KINDS).not.toContain('Travel confirmation');
    expect(JOB_STARTING_KINDS).not.toContain('Accommodation confirmation');
    expect(JOB_STARTING_KINDS).not.toContain('Other');
  });

  test('only Found and Confirmed details are current', () => {
    expect(DETAIL_STATUSES.filter(isCurrent)).toEqual(['Found', 'Confirmed']);
  });

  test('the Jobs columns have types, and the service derives all but Name, Booking and Updated', () => {
    expect(Object.keys(JOBS_COLUMN_TYPES).sort()).toEqual(
      [...JOBS_COLUMNS].sort()
    );
    expect(DERIVED_COLUMNS).not.toContain('Name');
    expect(DERIVED_COLUMNS).not.toContain('Booking');
    expect(DERIVED_COLUMNS).not.toContain('Updated');
    expect(DERIVED_COLUMNS).toHaveLength(JOBS_COLUMNS.length - 3);
    expect(JOBS_COLUMN_TYPES.Rate).toBe('number');
    expect(JOBS_COLUMN_TYPES.Dates).toBe('date_range');
    expect(JOBS_COLUMN_TYPES['Not confirmed']).toBe('tags');
  });

  test('the hedge list holds the design words, each normalisable', () => {
    for (const w of [
      'not',
      'no',
      'without',
      'tbc',
      'tba',
      'tbd',
      'provisional',
      'approx',
      'likely',
      'option',
      'or',
      'subject to',
      'if',
      'unless',
      'pending',
    ]) {
      expect(HEDGE_WORDS).toContain(w);
    }
    for (const w of HEDGE_WORDS) expect(termsOf(w).length).toBeGreaterThan(0);
  });
});

describe('CandidateDetailSchema', () => {
  test('accepts a detail as the model returns it', () => {
    const detail = {
      field: 'Call time',
      label: 'Crew call',
      value: '07:30',
      day: '2027-03-13',
      day_quote: 'Sat 13 March 2027',
      quote: 'Crew call 07:30',
      page: 1,
    };
    expect(CandidateDetailSchema.parse(detail)).toEqual(detail as never);
    expect(
      CandidateDetailSchema.parse({
        field: 'Venue',
        label: 'Venue',
        value: 'Beta Hall',
        quote: 'Venue: Beta Hall',
      })
    ).toEqual({
      field: 'Venue',
      label: 'Venue',
      value: 'Beta Hall',
      quote: 'Venue: Beta Hall',
    });
  });

  test('refuses a day that is not on the calendar, and says what each field holds', () => {
    const base = { label: '', value: '09:00', quote: 'Load-out 09:00' };
    expect(
      CandidateDetailSchema.safeParse({
        ...base,
        field: 'Load-out',
        day: '2027-02-30',
      }).success
    ).toBe(false);
    expect(
      CandidateDetailSchema.safeParse({
        ...base,
        field: 'Load-out',
        day: '2028-02-29',
        job: 0,
      }).success
    ).toBe(true);
    expect(isCalendarDate('2027-02-29')).toBe(false);
    expect(isCalendarDate('2027-13-01')).toBe(false);
    for (const field of ['field', 'label', 'value', 'quote'] as const)
      expect(CandidateDetailSchema.shape[field].description).toBeTruthy();
  });

  test('refuses an unknown field, a day that is not YYYY-MM-DD, and page 0', () => {
    const base = { label: '', value: 'x', quote: 'x' };
    expect(
      CandidateDetailSchema.safeParse({ ...base, field: 'Mood' }).success
    ).toBe(false);
    expect(
      CandidateDetailSchema.safeParse({
        ...base,
        field: 'Call time',
        day: '13/03/2027',
      }).success
    ).toBe(false);
    expect(
      CandidateDetailSchema.safeParse({ ...base, field: 'Call time', page: 0 })
        .success
    ).toBe(false);
    expect(
      CandidateDetailSchema.safeParse({
        ...base,
        field: 'Call time',
        page: 1.5,
      }).success
    ).toBe(false);
  });
});
