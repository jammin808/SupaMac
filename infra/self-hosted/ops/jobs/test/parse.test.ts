import { describe, expect, test } from 'bun:test';
import {
  amountKey,
  countEntities,
  type DateParts,
  ParseError,
  parseAmount,
  parseDate,
  parseDateRange,
  parseNumber,
  parseReference,
  parseTime,
  partsIso,
  scanLine,
  scanText,
  taxOf,
  timeKey,
  weekdayOf,
} from '../src/parse';

function date(text: string): DateParts {
  const found = parseDate(text);
  expect(found.count).toBe(1);
  return (found.entity as NonNullable<typeof found.entity>).parts;
}

function written(p: DateParts): Record<string, number | boolean | undefined> {
  return {
    day: p.day,
    month: p.month,
    year: p.year,
    weekday: p.weekday,
    ambiguous: p.ambiguous,
  };
}

describe('dates, as written', () => {
  test.each([
    [
      'Sat 14th March',
      { day: 14, month: 3, year: undefined, weekday: 6, ambiguous: false },
    ],
    [
      '14/03',
      {
        day: 14,
        month: 3,
        year: undefined,
        weekday: undefined,
        ambiguous: false,
      },
    ],
    [
      '14/03/2027',
      { day: 14, month: 3, year: 2027, weekday: undefined, ambiguous: false },
    ],
    [
      '14.03.27',
      { day: 14, month: 3, year: 2027, weekday: undefined, ambiguous: false },
    ],
    [
      '14 March 2027',
      { day: 14, month: 3, year: 2027, weekday: undefined, ambiguous: false },
    ],
    [
      'March 14',
      {
        day: 14,
        month: 3,
        year: undefined,
        weekday: undefined,
        ambiguous: false,
      },
    ],
    [
      'Saturday, 13th of March, 2027',
      { day: 13, month: 3, year: 2027, weekday: 6, ambiguous: false },
    ],
    [
      '2027-03-13',
      { day: 13, month: 3, year: 2027, weekday: undefined, ambiguous: false },
    ],
    [
      'Fri 12',
      {
        day: 12,
        month: undefined,
        year: undefined,
        weekday: 5,
        ambiguous: false,
      },
    ],
  ])('%s', (text, expected) => {
    expect(written(date(text))).toEqual(expected);
  });

  test('a missing year or month stays missing', () => {
    const p = date('Sat 14th March');
    expect(p.year).toBeUndefined();
    expect(partsIso(p)).toBeUndefined();
    expect(date('the 14th').month).toBeUndefined();
  });

  test('a numeric date that reads two ways is ambiguous and keeps the other reading', () => {
    const p = date('03/04');
    expect(p.ambiguous).toBe(true);
    expect([p.day, p.month]).toEqual([3, 4]);
    expect(p.alternative).toEqual({ day: 4, month: 3 });
    expect(date('12/03/2027').ambiguous).toBe(true);
    expect(date('14/03').ambiguous).toBe(false);
    expect(date('04/04').ambiguous).toBe(false);
  });

  test('a date that only reads month first is ambiguous', () => {
    const p = date('03/14');
    expect(p.ambiguous).toBe(true);
    expect([p.day, p.month]).toEqual([14, 3]);
  });

  test('dd.mm without a year, fractions, 24/7 and impossible dates are not dates', () => {
    expect(parseDate('Load-in 14.30').count).toBe(0);
    expect(parseDate('1/2 day').count).toBe(0);
    expect(parseDate('24/7 security').count).toBe(0);
    expect(parseDate('31/02/2027').count).toBe(0);
    expect(parseDate('30 February').count).toBe(0);
  });

  test('a bare number is not a day, an ordinal before a noun is not either', () => {
    expect(parseDate('Gate 14').count).toBe(0);
    expect(parseDate('on the 5th floor').count).toBe(0);
    expect(parseDate('see you on the 14th').count).toBe(1);
  });

  test('a weekday on its own counts as a date with only a weekday; sat nav does not', () => {
    expect(written(date('SATURDAY'))).toEqual({
      day: undefined,
      month: undefined,
      year: undefined,
      weekday: 6,
      ambiguous: false,
    });
    expect(parseDate('sat nav ZZ1 1ZZ').count).toBe(0);
  });

  test('weekdayOf gives the ISO weekday', () => {
    expect(weekdayOf(2027, 3, 12)).toBe(5);
    expect(weekdayOf(2027, 3, 13)).toBe(6);
    expect(weekdayOf(2027, 3, 14)).toBe(7);
  });
});

describe('date ranges', () => {
  test.each([
    ['Dates: Fri 12 – Sun 14 March 2027', [12, 3, 2027], [14, 3, 2027]],
    ['12-14 March', [12, 3, undefined], [14, 3, undefined]],
    ['12th-13th March 2027', [12, 3, 2027], [13, 3, 2027]],
    ['from 12 to 14 March 2027', [12, 3, 2027], [14, 3, 2027]],
    ['March 12 - 14', [12, 3, undefined], [14, 3, undefined]],
    ['between 12 and 14 March', [12, 3, undefined], [14, 3, undefined]],
    ['12/03/2027 - 14/03/2027', [12, 3, 2027], [14, 3, 2027]],
    ['28 February - 2 March 2027', [28, 2, 2027], [2, 3, 2027]],
  ])('%s', (text, from, to) => {
    const found = parseDateRange(text);
    expect(found.count).toBe(1);
    const range = found.entity as NonNullable<typeof found.entity>;
    expect([range.from.day, range.from.month, range.from.year]).toEqual(from);
    expect([range.to.day, range.to.month, range.to.year]).toEqual(to);
  });

  test('the month written once is marked shared, not inferred', () => {
    const range = parseDateRange('12-14 March 2027').entity as NonNullable<
      ReturnType<typeof parseDateRange>['entity']
    >;
    expect(range.from.shared).toEqual(['month', 'year']);
    expect(range.to.shared).toEqual([]);
  });

  test('a single date is a one-day range; two listed days are two entities', () => {
    expect(parseDateRange('Sat 13 March 2027').count).toBe(1);
    expect(parseDateRange('12th & 13th March').count).toBe(2);
    expect(parseDate('12-14 March').count).toBe(2);
  });

  test('bare numbers on both sides, or a Day N label, make no range', () => {
    expect(parseDateRange('Crew 8 - 10').count).toBe(0);
    expect(scanLine('DAY 2 - SAT 13 MARCH 2027').ranges).toHaveLength(0);
    expect(scanLine('DAY 2 - SAT 13 MARCH 2027').dates).toHaveLength(1);
  });
});

describe('times, as written', () => {
  test.each([
    ['8am', 8, 0, '12h', '08:00'],
    ['8:30pm', 8, 30, '12h', '20:30'],
    ['08:00', 8, 0, '24h', '08:00'],
    ['0800', 8, 0, '24h', '08:00'],
    ['0800hrs', 8, 0, '24h', '08:00'],
    ['1930 hrs', 19, 30, '24h', '19:30'],
    ['noon', 12, 0, '24h', '12:00'],
    ['12 midnight', 0, 0, '24h', '00:00'],
    ['Doors 19.30', 19, 30, '24h', '19:30'],
    ['7.30 p.m.', 7, 30, '12h', '19:30'],
    ['19h30', 19, 30, '24h', '19:30'],
  ])('%s', (text, hour, minute, clock, resolved) => {
    const found = parseTime(text);
    expect(found.count).toBe(1);
    const t = found.entity as NonNullable<typeof found.entity>;
    expect([t.hour, t.minute, t.clock, t.resolved]).toEqual([
      hour,
      minute,
      clock,
      resolved,
    ]);
  });

  test('a time without am or pm that could be either stays open', () => {
    const t = parseTime('Load in 8.30').entity as NonNullable<
      ReturnType<typeof parseTime>['entity']
    >;
    expect(t.clock).toBe('open');
    expect(t.resolved).toBeUndefined();
    expect(timeKey(t)).toBe('8:30?');
    expect(parseTime('8:00').entity?.clock).toBe('open');
  });

  test('a bare number is never a time', () => {
    expect(parseTime('Call 8').count).toBe(0);
    expect(parseTime('call at 7').count).toBe(0);
    expect(parseTime('Call 1930').count).toBe(0);
    expect(parseTime('2028').count).toBe(0);
  });

  test('a dotted number beside a currency or basis is an amount, not a time', () => {
    expect(parseTime('£19.30/hour').count).toBe(0);
    expect(parseTime('19.30 per hour').count).toBe(0);
    expect(parseAmount('19.30 per hour').entity?.value).toBe(19.3);
  });

  test('counts each time of a range or a list', () => {
    expect(parseTime('08:00-18:00').count).toBe(2);
    expect(parseTime('Load-in 08:00 or 09:00 TBC').count).toBe(2);
    expect(countEntities('Crew call 07:00, performers 09:00').time).toBe(2);
  });

  test('a UK phone number is not a time', () => {
    expect(parseTime('Call 0800 123 4567').count).toBe(0);
    expect(scanLine('Call 0800 123 4567').phones.map((p) => p.digits)).toEqual([
      '08001234567',
    ]);
  });
});

describe('amounts, as written', () => {
  test.each([
    ['£350/day', 350, 'GBP', 'day', undefined],
    ['350 + VAT', 350, undefined, undefined, 'plus_vat'],
    ['€1.200,00', 1200, 'EUR', undefined, undefined],
    ['GBP 350', 350, 'GBP', undefined, undefined],
    ['£350/day + VAT', 350, 'GBP', 'day', 'plus_vat'],
    ['£350 + VAT per day', 350, 'GBP', 'day', 'plus_vat'],
    ['£1,200 flat', 1200, 'GBP', 'flat', undefined],
    ['£45ph', 45, 'GBP', 'hour', undefined],
    ['£25 (+VAT)', 25, 'GBP', undefined, 'plus_vat'],
    ['£400 inc. VAT', 400, 'GBP', undefined, 'inc_vat'],
    ['£400 ex VAT', 400, 'GBP', undefined, 'ex_vat'],
    ['350 pounds a day', 350, 'GBP', 'day', undefined],
    ['350GBP', 350, 'GBP', undefined, undefined],
    ['£300 per 10 hour day', 300, 'GBP', 'day', undefined],
  ])('%s', (text, value, currency, basis, tax) => {
    const found = parseAmount(text);
    expect(found.count).toBe(1);
    const a = found.entity as NonNullable<typeof found.entity>;
    expect([a.value, a.currency, a.basis, a.tax, a.marked]).toEqual([
      value,
      currency,
      basis,
      tax,
      true,
    ]);
  });

  test('no currency is inferred', () => {
    const a = parseAmount('Rate 350 per day').entity as NonNullable<
      ReturnType<typeof parseAmount>['entity']
    >;
    expect(a.currency).toBeUndefined();
    expect(amountKey(a)).toBe('350 day');
  });

  test('a basis written before the amount is kept apart from it', () => {
    const a = parseAmount('Day rate £350 + VAT').entity as NonNullable<
      ReturnType<typeof parseAmount>['entity']
    >;
    expect(a.basis).toBeUndefined();
    expect(a.preBasis).toBe('day');
    expect(parseAmount('Flat fee of £900').entity?.preBasis).toBe('flat');
  });

  test('numbers that read two ways are ambiguous and have no value', () => {
    expect(parseNumber('1.200')).toEqual({ ambiguous: true });
    expect(parseNumber('1,200', 'EUR')).toEqual({ ambiguous: true });
    expect(parseNumber('1,200', 'GBP')).toEqual({
      value: 1200,
      ambiguous: false,
    });
    expect(parseNumber('1.200,50')).toEqual({
      value: 1200.5,
      ambiguous: false,
    });
    expect(parseNumber('1,200.50')).toEqual({
      value: 1200.5,
      ambiguous: false,
    });
    expect(parseNumber('350,50')).toEqual({ value: 350.5, ambiguous: false });
    expect(parseNumber('1,20,0')).toEqual({ ambiguous: true });
    expect(parseAmount('€1.200').entity?.ambiguous).toBe(true);
  });

  test('marked amounts hide bare numbers; quantities are never amounts', () => {
    expect(countEntities('Fee £1,200 for 4 days').amount).toBe(1);
    expect(countEntities('Rate 350 for 3 days').amount).toBe(1);
    expect(countEntities('Rate 350, OT 45').amount).toBe(2);
    expect(countEntities('Rate £350, OT £45/hr').amount).toBe(2);
    expect(countEntities('£350 per 10 hour day').amount).toBe(1);
  });

  test('a currency amount with an unknown suffix is flagged', () => {
    expect(parseAmount('£350pp').entity?.unknownSuffix).toBe(true);
  });
});

describe('references', () => {
  test('keep the written token and compare by letters and digits', () => {
    const po = parseReference('PO-4500123').entity as NonNullable<
      ReturnType<typeof parseReference>['entity']
    >;
    expect([po.text, po.core, po.key, po.prefix]).toEqual([
      'po-4500123',
      '4500123',
      '4500123',
      'po',
    ]);
    expect(parseReference('Job ref: LLG-27014').entity?.key).toBe('LLG27014');
    expect(
      parseReference('Booking ref ABC12345 for 2 nights').entity?.key
    ).toBe('ABC12345');
  });

  test('counts every reference, so a supplier number beside a PO is a second one', () => {
    expect(countEntities('PO 4500123 Supplier no. 88812').reference).toBe(2);
  });

  test('dates, times, amounts, phones, postcodes, ordinals and quantities are not references', () => {
    expect(
      countEntities(
        'Call 07:00 on 14/03/2027, £350, 07700 900123, ZZ1 1ZZ, 14th, 120 crew, 10hrs'
      ).reference
    ).toBe(0);
    expect(countEntities('Leeds Lights 2028').reference).toBe(0);
    expect(countEntities('Job 2027').reference).toBe(1);
  });
});

describe('relative days', () => {
  test('are found with their offset or day number', () => {
    const rel = (text: string) =>
      scanLine(text).relatives.map((r) => [r.text, r.offset, r.dayNumber]);
    expect(rel('Load-out the following day 01:00')).toEqual([
      ['the following day', 1, undefined],
    ]);
    expect(rel('Get-in the night before')).toEqual([
      ['the night before', -1, undefined],
    ]);
    expect(rel('DAY 2 - SAT 13 MARCH 2027')).toEqual([['day 2', undefined, 2]]);
    expect(rel('Day two rehearsals')).toEqual([['day two', undefined, 2]]);
    expect(rel('Show day call 10:00')).toEqual([
      ['show day', undefined, undefined],
    ]);
    expect(rel('Day rate £350')).toEqual([]);
  });
});

describe('counts and lines', () => {
  test('counts a range as one date range and two dates', () => {
    expect(countEntities('Dates 12-14 March 2027')).toMatchObject({
      date: 2,
      date_range: 1,
    });
    expect(countEntities('Check-in 12 March')).toMatchObject({
      date: 1,
      date_range: 1,
    });
  });

  test('scans line by line and never joins lines', () => {
    expect(scanText('Call\n07:00')).toHaveLength(2);
    expect(countEntities('12\nMarch 2027').date).toBe(0);
    expect(() => scanLine('Call\n07:00')).toThrow(ParseError);
  });
});

describe('what a line holds, as written', () => {
  test('the bare hour at the other end of a time range is a time of its own', () => {
    expect(parseTime('Crew call 7-8am').count).toBe(2);
    expect(parseTime('Crew call between 7 and 8am').count).toBe(2);
    expect(parseTime('Crew call 7:30-8').count).toBe(2);
    expect(parseTime('Doors 7 to 7.30pm').count).toBe(2);
    expect(parseTime('Crew call 7-8am').entity).toBeUndefined();
    expect(parseTime('Load-in 08:00 - 2 trucks').count).toBe(1);
    expect(parseTime('Crew 8 - 10').count).toBe(0);
  });

  test('a bare number beside a marked amount, or at the end of its range, is an amount', () => {
    expect(countEntities('Rate: 350-400 GBP').amount).toBe(2);
    expect(countEntities('Rate: £300 to 350').amount).toBe(2);
    expect(countEntities('Fee: £1 200').amount).toBe(2);
    expect(countEntities('Fee: £1\u202f200').amount).toBe(2);
    expect(countEntities('Fee £1,200 for 4 days').amount).toBe(1);
    expect(countEntities('Rate 350 per day, 2 crew').amount).toBe(1);
  });

  test('tax words after a comma, with a rate, dotted, or before the amount', () => {
    const tax = (text: string) => {
      const a = parseAmount(text).entity;
      return a ? taxOf(a) : 'none';
    };
    expect(tax('£350 per day, plus VAT')).toBe('plus_vat');
    expect(tax('£350 + 20% VAT')).toBe('plus_vat');
    expect(tax('£350 + V.A.T.')).toBe('plus_vat');
    expect(tax('£350 net of VAT')).toBe('ex_vat');
    expect(tax('Day rate (ex VAT): £350')).toBe('ex_vat');
    expect(tax('£350 VAT extra')).toBe('plus_vat');
    expect(tax('£350, OT £45')).toBe('none');
    expect(parseAmount('Day rate (ex VAT): £350').entity?.preTax).toBe(
      'ex_vat'
    );
  });

  test('a sign several currencies share stays a sign; quid is pounds', () => {
    expect(parseAmount('$350/day').entity?.currency).toBe('$');
    expect(parseAmount('¥5000').entity?.currency).toBe('¥');
    expect(parseAmount('350 dollars').entity?.currency).toBe('$');
    expect(parseAmount('£350').entity?.currency).toBe('GBP');
    const quid = parseAmount('350 quid a day').entity;
    expect([quid?.currency, quid?.basis]).toEqual(['GBP', 'day']);
  });

  test('days listed before a date with its month share its month and year', () => {
    const scan = scanLine('Dates: 12, 13 and 14 March 2027');
    expect(scan.dates.map((d) => partsIso(d.parts))).toEqual([
      '2027-03-12',
      '2027-03-13',
      '2027-03-14',
    ]);
    expect(scan.dates[0]?.parts.shared).toEqual(['month', 'year']);
    expect(parseDate('Crew call 07:00 on 12 & 13 March 2027').count).toBe(2);
    expect(parseDate('Rooms 12, 13 and 14').count).toBe(0);
  });

  test('ordinal day numbers and named days are relative; "2nd day" is not a date', () => {
    const rel = (text: string) =>
      scanLine(text).relatives.map((r) => [r.text, r.dayNumber]);
    expect(rel('Second day: crew call 07:30')).toEqual([['second day', 2]]);
    expect(rel('2nd day crew call 07:30')).toEqual([['2nd day', 2]]);
    expect(rel('Last day: crew call 07:30')).toEqual([['last day', undefined]]);
    expect(parseDate('2nd day crew call 07:30').count).toBe(0);
  });

  test('issue, revision and draft numbers are not days', () => {
    for (const line of [
      'Revision 3 - 12 Feb 2027',
      'Issue 2 - 12 Feb 2027',
      'Draft 4 - 12 Feb 2027',
      'Call sheet 2 of 3 - 12 Feb 2027',
    ]) {
      expect(scanLine(line).ranges).toHaveLength(0);
      expect(parseDate(line).count).toBe(1);
    }
  });

  test('a reference keeps every letter but a PO label glued to it', () => {
    const key = (text: string) => parseReference(text).entity?.key;
    expect(key('RES12345')).toBe('RES12345');
    expect(key('BK12345')).toBe('BK12345');
    expect(key('INV-12345')).toBe('INV12345');
    expect(key('PO4500123')).toBe('4500123');
    expect(key('PO-4500123')).toBe('4500123');
  });
});
