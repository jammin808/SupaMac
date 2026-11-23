// Dates, date ranges, times, amounts and references, parsed into the
// components a line writes (docs/supamac/jobs.md §4, check 3).
//
// Invariants:
// - A parse holds only what is written. A missing year, month, am/pm,
//   currency, basis or tax word stays missing; nothing is taken from today,
//   from habit or from another line. A date range's month or year written
//   once for both ends ("12-14 March 2027") is written for both, and is
//   marked `shared`.
// - A bare number is never a time: a time has a colon or a full stop between
//   hour and minutes, am/pm, "hrs", "noon" or "midnight", or is four digits
//   with a leading zero ("0800"). "1930" alone is not a time; it may be a
//   year. A dotted time ("19.30") next to a currency or a basis word is an
//   amount instead. The one exception is the other end of a time range: a
//   bare hour joined to a time by "-", "to", "and", "or", "&" or "until"
//   ("7-8am", "between 7 and 8am") is counted as a time of its own, open as
//   to am or pm, so the line holds two.
// - Days listed before a date written with its month ("12, 13 and 14 March
//   2027", "12 & 13 March") are dates of their own, sharing the month and
//   year written once, like a range's.
// - Numeric dates read day first. One whose two parts are both 12 or less
//   and differ ("03/04") is `ambiguous`, with the other reading kept; one
//   that only reads month first ("03/14") is `ambiguous` too. A two-digit
//   year is 2000 plus it. "dd.mm" without a year is not a date (it is a time
//   or an amount).
// - An amount is `marked` when it has a currency, a basis or a tax word
//   (after it, or before it: "ex VAT £350"). Where a string holds a marked
//   amount, its bare numbers are not counted as amounts, except one right
//   beside a marked amount or joined to it as a range ("350-400 GBP",
//   "£300 to 350", "£1 200"); where it holds none, each bare number that is
//   not a quantity ("10 hours"), a date, a time, a phone number or a
//   labelled reference is.
// - A currency is an ISO 4217 code only where the writing names one: a code,
//   a currency word, or a sign one currency owns (£ GBP, € EUR). A sign
//   several currencies share ($, ¥) is kept as the sign.
// - A number's separators are read by their shape: both "," and "." give a
//   decimal mark (the last) and a thousands mark; one separator repeated is a
//   thousands mark; "," before one or two digits is a decimal comma; "."
//   before three digits ("1.200") reads two ways, and so does "," before
//   three digits after a euro amount. A number that reads two ways is
//   `ambiguous` and has no value.
// - A reference is a word with a digit, at least three letters and digits
//   long, that is not a date, time, marked amount, phone number, email
//   address, postcode, ordinal, percentage or quantity. A bare four-digit
//   year is a reference only right after a reference label ("Job 2027").
//   Its comparison key is every letter and digit it writes; only a PO label
//   glued to it ("PO-4500123", "PO4500123") is dropped, so "RES12345" and
//   "BK12345" never compare equal.
// - Every scan is of one line; text with line breaks is scanned line by line
//   and never joined.

import {
  normalize,
  splitLines,
  type Token,
  type TokenType,
  tokenizeLine,
} from './normalize';

export class ParseError extends Error {
  readonly kind: 'not_one_line';
  constructor(kind: 'not_one_line', message: string) {
    super(message);
    this.name = 'ParseError';
    this.kind = kind;
  }
}

export type EntityKind =
  | 'date'
  | 'date_range'
  | 'time'
  | 'amount'
  | 'reference';

export interface DateParts {
  readonly day?: number | undefined;
  readonly month?: number | undefined;
  readonly year?: number | undefined;
  /** 1 = Monday … 7 = Sunday, as written. */
  readonly weekday?: number | undefined;
  readonly monthInWords: boolean;
  readonly numeric: boolean;
  readonly ambiguous: boolean;
  /** The other reading of an ambiguous numeric date. */
  readonly alternative?:
    | { readonly day: number; readonly month: number }
    | undefined;
  readonly twoDigitYear: boolean;
  /** Components a range writes once for both ends. */
  readonly shared: readonly ('month' | 'year')[];
}

interface Span {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface DateEntity extends Span {
  readonly kind: 'date';
  readonly parts: DateParts;
}

export interface DateRangeEntity extends Span {
  readonly kind: 'date_range';
  readonly from: DateParts;
  readonly to: DateParts;
}

export type Meridiem = 'am' | 'pm';

export interface TimeEntity extends Span {
  readonly kind: 'time';
  readonly hour: number;
  readonly minute: number;
  readonly meridiem?: Meridiem | undefined;
  /**
   * `24h` and `12h` are unambiguous; `open` ("8:00", "8.30") may be morning
   * or evening.
   */
  readonly clock: '24h' | '12h' | 'open';
  /** `HH:MM` on the 24-hour clock, when the time is unambiguous. */
  readonly resolved?: string | undefined;
}

export type Basis =
  | 'day'
  | 'hour'
  | 'week'
  | 'night'
  | 'show'
  | 'session'
  | 'flat';
export type Tax = 'plus_vat' | 'inc_vat' | 'ex_vat' | 'no_vat';

export const BASIS_TEXT: Readonly<Record<Basis, string>> = {
  day: 'per day',
  hour: 'per hour',
  week: 'per week',
  night: 'per night',
  show: 'per show',
  session: 'per session',
  flat: 'flat',
};

export const TAX_TEXT: Readonly<Record<Tax, string>> = {
  plus_vat: '+ VAT',
  inc_vat: 'inc VAT',
  ex_vat: 'ex VAT',
  no_vat: 'no VAT',
};

export interface AmountEntity extends Span {
  readonly kind: 'amount';
  /** Absent when the number reads two ways or is not understood. */
  readonly value?: number | undefined;
  readonly numberText: string;
  readonly ambiguous: boolean;
  /**
   * An ISO 4217 code from a code, a currency word or a sign one currency
   * owns; a shared sign ("$", "¥") as written.
   */
  readonly currency?: string | undefined;
  readonly basis?: Basis | undefined;
  readonly tax?: Tax | undefined;
  readonly marked: boolean;
  /** A currency amount with a suffix this parser does not know ("£350pp"). */
  readonly unknownSuffix: boolean;
  /** A basis written before the amount ("day rate £350", "flat fee £900"). */
  readonly preBasis?: Basis | undefined;
  /** Tax words written before the amount ("ex VAT: £350"). */
  readonly preTax?: Tax | undefined;
  /** A bare number right beside a marked amount, or the other end of its range. */
  readonly besideMarked: boolean;
}

/** The tax words an amount carries, before or after it. */
export function taxOf(amount: AmountEntity): Tax | undefined {
  return amount.tax ?? amount.preTax;
}

export interface ReferenceEntity extends Span {
  readonly kind: 'reference';
  /** The reference without a label prefix it is glued to ("po-"). */
  readonly core: string;
  /** Letters and digits of the core, upper-case: the comparison key. */
  readonly key: string;
  readonly prefix?: string | undefined;
}

export interface RelativeDay extends Span {
  readonly kind: 'relative';
  /** Days from the date counted from: +1 "the following day", 0 "today". */
  readonly offset?: number | undefined;
  /** N in "Day N". */
  readonly dayNumber?: number | undefined;
}

export interface PhoneEntity extends Span {
  readonly kind: 'phone';
  readonly digits: string;
}

export interface EmailEntity extends Span {
  readonly kind: 'email';
}

export interface LineScan {
  /** The normalised line every offset refers to. */
  readonly line: string;
  readonly tokens: readonly Token[];
  readonly dates: readonly DateEntity[];
  readonly ranges: readonly DateRangeEntity[];
  readonly times: readonly TimeEntity[];
  /** Marked and bare amounts; see `effectiveAmounts`. */
  readonly amounts: readonly AmountEntity[];
  readonly references: readonly ReferenceEntity[];
  readonly relatives: readonly RelativeDay[];
  readonly phones: readonly PhoneEntity[];
  readonly emails: readonly EmailEntity[];
  readonly postcodes: readonly Span[];
}

interface PT {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly type: TokenType;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const WEEKDAYS: Readonly<Record<string, number>> = {
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
  sun: 7,
  sunday: 7,
};

const FULL_WEEKDAYS = new Set([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);

/** Words after an ordinal that make it a count, not a day ("5th floor"). */
const ORDINAL_NOUNS = new Set([
  'floor',
  'level',
  'row',
  'party',
  'edition',
  'place',
  'time',
  'round',
  'year',
  'anniversary',
  'birthday',
  'generation',
  'century',
  'gear',
  'grade',
  'unit',
  'stage',
  'act',
  'gate',
  'door',
  'bay',
  'option',
  'choice',
  'call',
  'draft',
  'version',
  'revision',
  'day',
  'days',
  'night',
  'nights',
  'show',
  'week',
  'performance',
  'session',
]);

/** Words before a bare number that make it a label's number, not a day. */
const NUMBER_LABELS = new Set([
  'day',
  'days',
  'no',
  'number',
  'room',
  'rooms',
  'gate',
  'dock',
  'unit',
  'door',
  'stage',
  'hall',
  'row',
  'level',
  'floor',
  'platform',
  'coach',
  'seat',
  'bay',
  'page',
  'p',
  'line',
  'version',
  'v',
  'rev',
  'revision',
  'issue',
  'draft',
  'edition',
  'sheet',
  'of',
  'act',
  'scene',
  'part',
  'phase',
  'week',
  'wk',
  'zone',
  'area',
  'block',
  'pit',
  'truck',
  'van',
  'crew',
]);

const RANGE_WORDS = new Set(['to', 'until', 'till', 'til', 'thru', 'through']);

const MERIDIEMS: Readonly<Record<string, Meridiem>> = {
  am: 'am',
  'a.m': 'am',
  pm: 'pm',
  'p.m': 'pm',
};

const HOURS_WORDS = new Set(['hrs', 'hr', 'hours', 'h']);

/** A sign one currency owns gives its code; a shared sign is kept as written. */
const CURRENCY_SIGNS: Readonly<Record<string, string>> = {
  '£': 'GBP',
  $: '$',
  '€': 'EUR',
  '¥': '¥',
};

const CURRENCY_CODES = new Set([
  'gbp',
  'eur',
  'usd',
  'chf',
  'aud',
  'cad',
  'nzd',
  'sek',
  'nok',
  'dkk',
  'jpy',
  'zar',
  'aed',
]);

const CURRENCY_WORDS: Readonly<Record<string, string>> = {
  pound: 'GBP',
  pounds: 'GBP',
  quid: 'GBP',
  sterling: 'GBP',
  euro: 'EUR',
  euros: 'EUR',
  dollar: '$',
  dollars: '$',
};

const UNITS: Readonly<Record<string, Basis>> = {
  day: 'day',
  days: 'day',
  d: 'day',
  hour: 'hour',
  hours: 'hour',
  hr: 'hour',
  hrs: 'hour',
  h: 'hour',
  week: 'week',
  weeks: 'week',
  wk: 'week',
  night: 'night',
  nights: 'night',
  show: 'show',
  shows: 'show',
  gig: 'show',
  performance: 'show',
  session: 'session',
};

/** Basis suffixes glued to a number ("£350/day", "£45ph"). */
const BASIS_SUFFIXES: Readonly<Record<string, Basis>> = {
  '/day': 'day',
  '/d': 'day',
  '/hr': 'hour',
  '/hour': 'hour',
  '/h': 'hour',
  '/hrs': 'hour',
  '/week': 'week',
  '/wk': 'week',
  '/night': 'night',
  '/show': 'show',
  '/session': 'session',
  pd: 'day',
  'p/d': 'day',
  'p/day': 'day',
  ph: 'hour',
  'p/h': 'hour',
  'p/hr': 'hour',
  'p/hour': 'hour',
  pw: 'week',
  'p/w': 'week',
  pn: 'night',
  'p/n': 'night',
};

/** Basis words standing alone after an amount. */
const BASIS_WORDS: Readonly<Record<string, Basis>> = {
  pd: 'day',
  'p/d': 'day',
  ph: 'hour',
  'p/h': 'hour',
  'p/hr': 'hour',
  pw: 'week',
  'p/w': 'week',
  pn: 'night',
  daily: 'day',
  hourly: 'hour',
  weekly: 'week',
  nightly: 'night',
  flat: 'flat',
  fixed: 'flat',
};

/** Words before an amount that state its basis ("day rate £350"). */
const PRE_BASIS: ReadonlyArray<readonly [readonly string[], Basis]> = [
  [['flat', 'fee'], 'flat'],
  [['flat', 'rate'], 'flat'],
  [['fixed', 'fee'], 'flat'],
  [['fixed', 'rate'], 'flat'],
  [['day', 'rate'], 'day'],
  [['daily', 'rate'], 'day'],
  [['hourly', 'rate'], 'hour'],
  [['weekly', 'rate'], 'week'],
  [['night', 'rate'], 'night'],
  [['flat'], 'flat'],
];

/** Words after a number that make it a count, not an amount or reference. */
const QUANTITY_UNITS = new Set([
  'hour',
  'hours',
  'hr',
  'hrs',
  'h',
  'day',
  'days',
  'night',
  'nights',
  'week',
  'weeks',
  'month',
  'months',
  'year',
  'years',
  'min',
  'mins',
  'minute',
  'minutes',
  'people',
  'person',
  'persons',
  'crew',
  'pax',
  'guests',
  'staff',
  'heads',
  'x',
  'times',
  'km',
  'miles',
  'mile',
  'mi',
  'm',
  'metres',
  'meters',
  'ft',
  'feet',
  'kg',
  'tonnes',
  'room',
  'rooms',
  'ticket',
  'tickets',
  'seat',
  'seats',
  'shows',
  'sessions',
  'percent',
  'pages',
  'page',
  'items',
  'cases',
  'trucks',
  'vans',
]);

const QUANTITY_TOKEN =
  /^\d+(?:\.\d+)?(?:hrs?|hours?|h|days?|nights?|wks?|weeks?|mins?|minutes?|m|km|mi|miles|kg|x|pax|pp|ppl|people|crew|ft|cm|mm)$/;

/** Labels a reference is written after, or glued to. */
const REFERENCE_LABELS = new Set([
  'po',
  'p.o',
  'p/o',
  'ref',
  'reference',
  'no',
  'nr',
  'number',
  'order',
  'job',
  'invoice',
  'inv',
  'booking',
  'conf',
  'confirmation',
  'reservation',
  'supplier',
  'vendor',
  'account',
  'acct',
  'project',
  'quote',
  'pnr',
  '#',
]);

/** A PO label glued to its number; no other prefix is dropped from a key. */
const REFERENCE_PREFIX = /^(po|p\.o|p\/o)[-#:/.]?(?=\d)/;

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const DMY = /^(\d{1,2})([./-])(\d{1,2})\2(\d{2}|\d{4})$/;
const DM = /^(\d{1,2})\/(\d{1,2})$/;
const DAY_TOKEN = /^(\d{1,2})(st|nd|rd|th)?$/;
const YEAR_TOKEN = /^(19|20)\d{2}$/;
const TIME_SEPARATED = /^(\d{1,2})([:.])(\d{2})(am|pm|a\.m|p\.m|hrs|hr|h)?$/;
const TIME_MERIDIEM = /^(\d{1,2})(am|pm|a\.m|p\.m)$/;
const TIME_FOUR = /^(\d{4})(hrs|hr|h)?$/;
const TIME_H = /^(\d{1,2})h(\d{2})$/;
const NUMBER = /^\d(?:[\d.,]*\d)?$/;
const AMOUNT_TOKEN = /^([£$€¥])?(\d(?:[\d.,]*\d)?)(.*)$/;
const FRACTIONS = new Set(['1/2', '1/3', '2/3', '1/4', '3/4', '24/7']);

function at<T>(list: readonly T[], index: number): T | undefined {
  return index >= 0 && index < list.length ? list[index] : undefined;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(month: number, year?: number): number {
  if (month === 2) return year === undefined || isLeap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validDay(
  day: number,
  month: number | undefined,
  year: number | undefined
): boolean {
  if (day < 1 || day > 31) return false;
  if (month === undefined) return true;
  if (month < 1 || month > 12) return false;
  return day <= daysInMonth(month, year);
}

/** ISO weekday (1 = Monday) of a calendar date. */
export function weekdayOf(year: number, month: number, day: number): number {
  const sunday0 = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sunday0 === 0 ? 7 : sunday0;
}

export function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The ISO date of complete parts, or undefined. */
export function partsIso(parts: DateParts): string | undefined {
  if (
    parts.day === undefined ||
    parts.month === undefined ||
    parts.year === undefined
  ) {
    return undefined;
  }
  if (!validDay(parts.day, parts.month, parts.year)) return undefined;
  return isoDate(parts.year, parts.month, parts.day);
}

/** Splits glued ranges ("14-15", "08:00-09:00", "8am/9am") for date and time scanning. */
function parseTokens(tokens: readonly Token[]): PT[] {
  const out: PT[] = [];
  for (const t of tokens) {
    if (
      t.type === 'word' &&
      /^\d/.test(t.text) &&
      t.text.includes('-') &&
      !ISO_DATE.test(t.text) &&
      !DMY.test(t.text)
    ) {
      const parts = t.text.split('-');
      if (parts.every((p) => /^\d/.test(p))) {
        pushParts(out, t, parts, '-', 'punct');
        continue;
      }
    }
    if (t.type === 'word' && t.text.includes('/')) {
      const parts = t.text.split('/');
      if (parts.length === 2 && parts.every((p) => timeShape(p))) {
        pushParts(out, t, parts, '/', 'symbol');
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

function pushParts(
  out: PT[],
  token: Token,
  parts: readonly string[],
  separator: string,
  type: TokenType
): void {
  let offset = token.start;
  parts.forEach((part, k) => {
    if (k > 0) {
      out.push({ text: separator, start: offset, end: offset + 1, type });
      offset += 1;
    }
    out.push({
      text: part,
      start: offset,
      end: offset + part.length,
      type: 'word',
    });
    offset += part.length;
  });
}

function timeShape(text: string): boolean {
  return (
    TIME_SEPARATED.test(text) ||
    TIME_MERIDIEM.test(text) ||
    (TIME_FOUR.test(text) && text.startsWith('0'))
  );
}

/** The next index after `i`, skipping punctuation in `skippable`; -1 at the end. */
function after(pt: readonly PT[], i: number, skippable: string): number {
  let k = i + 1;
  while (k < pt.length) {
    const token = pt[k] as PT;
    if (token.type === 'punct' && skippable.includes(token.text)) {
      k++;
      continue;
    }
    return k;
  }
  return -1;
}

function wordAt(pt: readonly PT[], i: number): string | undefined {
  const token = at(pt, i);
  return token && token.type === 'word' ? token.text : undefined;
}

/** The nearest word before `i`, skipping punctuation. */
function wordBefore(pt: readonly PT[], i: number): string | undefined {
  for (let k = i - 1; k >= 0; k--) {
    const token = pt[k] as PT;
    if (token.type === 'punct') continue;
    return token.text;
  }
  return undefined;
}

interface NumericDate {
  day: number;
  month: number;
  year?: number | undefined;
  ambiguous: boolean;
  alternative?: { day: number; month: number } | undefined;
  twoDigitYear: boolean;
}

function numericDate(text: string): NumericDate | undefined {
  const iso = ISO_DATE.exec(text);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (!validDay(day, month, year)) return undefined;
    return { day, month, year, ambiguous: false, twoDigitYear: false };
  }
  let a: number;
  let b: number;
  let year: number | undefined;
  let twoDigitYear = false;
  const dmy = DMY.exec(text);
  const dm = dmy ? null : DM.exec(text);
  if (dmy) {
    a = Number(dmy[1]);
    b = Number(dmy[3]);
    const y = dmy[4] as string;
    twoDigitYear = y.length === 2;
    year = twoDigitYear ? 2000 + Number(y) : Number(y);
  } else if (dm) {
    if (FRACTIONS.has(text)) return undefined;
    a = Number(dm[1]);
    b = Number(dm[2]);
  } else {
    return undefined;
  }
  const uk = validDay(a, b, year);
  const us = validDay(b, a, year);
  if (uk && us && a !== b && a <= 12 && b <= 12) {
    return {
      day: a,
      month: b,
      year,
      ambiguous: true,
      alternative: { day: b, month: a },
      twoDigitYear,
    };
  }
  if (uk) return { day: a, month: b, year, ambiguous: false, twoDigitYear };
  if (us) return { day: b, month: a, year, ambiguous: true, twoDigitYear };
  return undefined;
}

function dayToken(
  text: string | undefined
): { day: number; ordinal: boolean } | undefined {
  if (text === undefined) return undefined;
  const m = DAY_TOKEN.exec(text);
  if (!m) return undefined;
  const day = Number(m[1]);
  if (day < 1 || day > 31) return undefined;
  return { day, ordinal: m[2] !== undefined };
}

interface PartsDraft {
  day?: number | undefined;
  month?: number | undefined;
  year?: number | undefined;
  weekday?: number | undefined;
  monthInWords: boolean;
  numeric: boolean;
  ambiguous: boolean;
  alternative?: { day: number; month: number } | undefined;
  twoDigitYear: boolean;
  shared: ('month' | 'year')[];
}

function draft(fields: Partial<PartsDraft>): PartsDraft {
  return {
    monthInWords: false,
    numeric: false,
    ambiguous: false,
    twoDigitYear: false,
    shared: [],
    ...fields,
  };
}

interface DateMatch {
  parts: PartsDraft;
  first: number;
  last: number;
}

/**
 * One date starting at `i`. `bareDay` lets a plain day number stand as a day
 * (only inside a range, next to its separator).
 */
function matchDate(
  pt: readonly PT[],
  i: number,
  bareDay: boolean
): DateMatch | undefined {
  const first = wordAt(pt, i);
  if (first === undefined) return undefined;
  let j = i;
  let weekday: number | undefined;
  const w = WEEKDAYS[first];
  if (w !== undefined) {
    const k = after(pt, i, ',.');
    const next = wordAt(pt, k);
    if (
      next !== undefined &&
      (dayToken(next) !== undefined ||
        MONTHS[next] !== undefined ||
        numericDate(next) !== undefined)
    ) {
      weekday = w;
      j = k;
    } else if (FULL_WEEKDAYS.has(first)) {
      return { parts: draft({ weekday: w }), first: i, last: i };
    } else {
      return undefined;
    }
  }
  const text = wordAt(pt, j) as string;
  const numeric = numericDate(text);
  if (numeric) {
    return {
      parts: draft({
        day: numeric.day,
        month: numeric.month,
        year: numeric.year,
        weekday,
        numeric: true,
        ambiguous: numeric.ambiguous,
        alternative: numeric.alternative,
        twoDigitYear: numeric.twoDigitYear,
      }),
      first: i,
      last: j,
    };
  }
  const day = dayToken(text);
  if (day) {
    let k = after(pt, j, ',.');
    if (wordAt(pt, k) === 'of') k = after(pt, k, '');
    const monthWord = wordAt(pt, k);
    const month = monthWord === undefined ? undefined : MONTHS[monthWord];
    if (month !== undefined) {
      let last = k;
      let year: number | undefined;
      const y = after(pt, k, ',.');
      const yearWord = wordAt(pt, y);
      if (yearWord !== undefined && YEAR_TOKEN.test(yearWord)) {
        year = Number(yearWord);
        last = y;
      }
      if (!validDay(day.day, month, year)) return undefined;
      return {
        parts: draft({
          day: day.day,
          month,
          year,
          weekday,
          monthInWords: true,
        }),
        first: i,
        last,
      };
    }
    const before = weekday === undefined ? wordBefore(pt, i) : undefined;
    const labelled = before !== undefined && NUMBER_LABELS.has(before);
    const nextWord = wordAt(pt, after(pt, j, ''));
    const ordinalOk =
      day.ordinal &&
      (nextWord === undefined || !ORDINAL_NOUNS.has(nextWord)) &&
      !labelled;
    if (weekday !== undefined || ordinalOk || (bareDay && !labelled)) {
      return { parts: draft({ day: day.day, weekday }), first: i, last: j };
    }
    return undefined;
  }
  const month = MONTHS[text];
  if (month !== undefined) {
    const k = after(pt, j, ',.');
    const d = dayToken(wordAt(pt, k));
    if (!d) return undefined;
    let last = k;
    let year: number | undefined;
    const y = after(pt, k, ',.');
    const yearWord = wordAt(pt, y);
    if (yearWord !== undefined && YEAR_TOKEN.test(yearWord)) {
      year = Number(yearWord);
      last = y;
    }
    if (!validDay(d.day, month, year)) return undefined;
    return {
      parts: draft({ day: d.day, month, year, weekday, monthInWords: true }),
      first: i,
      last,
    };
  }
  return undefined;
}

function compareParts(a: PartsDraft, b: PartsDraft): number {
  const ya = a.year ?? 0;
  const yb = b.year ?? 0;
  if (ya !== yb) return ya - yb;
  if ((a.month ?? 0) !== (b.month ?? 0)) return (a.month ?? 0) - (b.month ?? 0);
  return (a.day ?? 0) - (b.day ?? 0);
}

interface RangeMatch {
  from: PartsDraft;
  to: PartsDraft;
  first: number;
  last: number;
}

function matchRange(pt: readonly PT[], i: number): RangeMatch | undefined {
  const from = matchDate(pt, i, true);
  if (!from || from.parts.day === undefined) return undefined;
  const k = after(pt, from.last, '');
  const sep = at(pt, k);
  if (!sep) return undefined;
  const isSep =
    (sep.type === 'punct' && sep.text === '-') ||
    (sep.type === 'word' && RANGE_WORDS.has(sep.text)) ||
    (sep.type === 'word' &&
      sep.text === 'and' &&
      wordBefore(pt, i) === 'between');
  if (!isSep) return undefined;
  const to = matchDate(pt, after(pt, k, ','), true);
  if (!to || to.parts.day === undefined) return undefined;
  const a = { ...from.parts, shared: [...from.parts.shared] };
  const b = { ...to.parts, shared: [...to.parts.shared] };
  if (a.month === undefined && b.month !== undefined) {
    a.month = b.month;
    a.shared.push('month');
  }
  if (b.month === undefined && a.month !== undefined) {
    b.month = a.month;
    b.shared.push('month');
  }
  if (a.month === undefined || b.month === undefined) return undefined;
  if (a.year === undefined && b.year !== undefined) {
    a.year = b.year;
    a.shared.push('year');
  }
  if (b.year === undefined && a.year !== undefined) {
    b.year = a.year;
    b.shared.push('year');
  }
  if (
    !validDay(a.day as number, a.month, a.year) ||
    !validDay(b.day as number, b.month, b.year)
  ) {
    return undefined;
  }
  const order = compareParts(a, b);
  const wraps = a.year === undefined && a.month > b.month;
  if (order > 0 && !wraps) return undefined;
  return { from: a, to: b, first: i, last: to.last };
}

function isListSeparator(token: PT | undefined): boolean {
  if (!token) return false;
  if (token.type === 'punct') return token.text === ',';
  if (token.type === 'symbol') return token.text === '&';
  return token.text === 'and';
}

/**
 * Days listed before a date with its month ("12, 13 and 14 March 2027"),
 * starting at `i`: each listed day shares the month and year written once.
 */
function matchListDays(
  pt: readonly PT[],
  i: number
): { indices: number[]; days: number[]; tail: PartsDraft } | undefined {
  const before = wordBefore(pt, i);
  if (before !== undefined && NUMBER_LABELS.has(before)) return undefined;
  const indices: number[] = [];
  const days: number[] = [];
  let k = i;
  while (indices.length < 31) {
    const day = dayToken(wordAt(pt, k));
    if (!day) return undefined;
    indices.push(k);
    days.push(day.day);
    const sep = at(pt, k + 1);
    if (!isListSeparator(sep)) return undefined;
    let n = k + 2;
    const word = at(pt, n);
    if (sep?.text === ',' && word?.type === 'word' && word.text === 'and')
      n += 1;
    const tail = matchDate(pt, n, false);
    if (
      tail &&
      !tail.parts.ambiguous &&
      tail.parts.day !== undefined &&
      tail.parts.month !== undefined
    ) {
      if (!days.every((d) => validDay(d, tail.parts.month, tail.parts.year)))
        return undefined;
      return { indices, days, tail: tail.parts };
    }
    k = n;
  }
  return undefined;
}

function spanOf(
  pt: readonly PT[],
  line: string,
  first: number,
  last: number
): Span {
  const start = (pt[first] as PT).start;
  const end = (pt[last] as PT).end;
  return { text: line.slice(start, end), start, end };
}

function freeze(parts: PartsDraft): DateParts {
  return { ...parts, shared: [...parts.shared] };
}

function resolveClock(
  hour: number,
  minute: number,
  meridiem: Meridiem | undefined,
  twentyFour: boolean
): Omit<TimeEntity, keyof Span | 'kind'> | undefined {
  if (minute < 0 || minute > 59) return undefined;
  const hhmm = (h: number): string =>
    `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    const h24 = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
    return { hour, minute, meridiem, clock: '12h', resolved: hhmm(h24) };
  }
  if (hour === 24 && minute === 0)
    return { hour, minute, clock: '24h', resolved: '24:00' };
  if (hour > 23) return undefined;
  if (twentyFour || hour === 0 || hour >= 13) {
    return { hour, minute, clock: '24h', resolved: hhmm(hour) };
  }
  return { hour, minute, clock: 'open' };
}

interface TimeMatch {
  time: Omit<TimeEntity, keyof Span | 'kind'>;
  first: number;
  last: number;
}

function amountContext(pt: readonly PT[], i: number): boolean {
  const prev = at(pt, i - 1);
  if (
    prev &&
    (CURRENCY_SIGNS[prev.text] !== undefined || CURRENCY_CODES.has(prev.text))
  ) {
    return true;
  }
  const next = at(pt, i + 1);
  if (!next) return false;
  if (
    next.text === '/' ||
    next.text === 'per' ||
    next.text === '+' ||
    next.text === 'plus'
  ) {
    return true;
  }
  return (
    BASIS_WORDS[next.text] !== undefined ||
    CURRENCY_WORDS[next.text] !== undefined
  );
}

function matchTime(pt: readonly PT[], i: number): TimeMatch | undefined {
  const text = wordAt(pt, i);
  if (text === undefined) return undefined;
  const nextWord = wordAt(pt, i + 1);
  if (text === 'noon' || text === 'midday') {
    return {
      time: { hour: 12, minute: 0, clock: '24h', resolved: '12:00' },
      first: i,
      last: i,
    };
  }
  if (text === 'midnight') {
    return {
      time: { hour: 0, minute: 0, clock: '24h', resolved: '00:00' },
      first: i,
      last: i,
    };
  }
  if (
    text === '12' &&
    (nextWord === 'noon' || nextWord === 'midday' || nextWord === 'midnight')
  ) {
    const noon = nextWord !== 'midnight';
    return {
      time: {
        hour: noon ? 12 : 0,
        minute: 0,
        clock: '24h',
        resolved: noon ? '12:00' : '00:00',
      },
      first: i,
      last: i + 1,
    };
  }
  const meridiemNext = nextWord === undefined ? undefined : MERIDIEMS[nextWord];
  const hoursNext = nextWord !== undefined && HOURS_WORDS.has(nextWord);
  const separated = TIME_SEPARATED.exec(text);
  if (separated) {
    const hourText = separated[1] as string;
    const suffix = separated[4];
    const meridiem = suffix ? MERIDIEMS[suffix] : meridiemNext;
    const hrs =
      (suffix !== undefined && HOURS_WORDS.has(suffix)) ||
      (!suffix && hoursNext);
    if (separated[2] === '.' && !meridiem && !hrs && amountContext(pt, i))
      return undefined;
    const time = resolveClock(
      Number(hourText),
      Number(separated[3]),
      meridiem,
      hrs || (hourText.length === 2 && hourText.startsWith('0'))
    );
    if (!time) return undefined;
    const last = !suffix && (meridiemNext || hoursNext) ? i + 1 : i;
    return { time, first: i, last };
  }
  const withMeridiem = TIME_MERIDIEM.exec(text);
  if (withMeridiem) {
    const time = resolveClock(
      Number(withMeridiem[1]),
      0,
      MERIDIEMS[withMeridiem[2] as string],
      false
    );
    return time ? { time, first: i, last: i } : undefined;
  }
  if (/^\d{1,2}$/.test(text)) {
    if (meridiemNext) {
      const time = resolveClock(Number(text), 0, meridiemNext, false);
      return time ? { time, first: i, last: i + 1 } : undefined;
    }
    if (nextWord === "o'clock" || nextWord === 'oclock') {
      const time = resolveClock(Number(text), 0, undefined, false);
      return time ? { time, first: i, last: i + 1 } : undefined;
    }
    return undefined;
  }
  const four = TIME_FOUR.exec(text);
  if (four) {
    const digits = four[1] as string;
    const hrs = four[2] !== undefined || hoursNext;
    if (!hrs && !digits.startsWith('0')) return undefined;
    const time = resolveClock(
      Number(digits.slice(0, 2)),
      Number(digits.slice(2)),
      undefined,
      true
    );
    if (!time) return undefined;
    return {
      time,
      first: i,
      last: four[2] === undefined && hoursNext ? i + 1 : i,
    };
  }
  const h = TIME_H.exec(text);
  if (h) {
    const time = resolveClock(Number(h[1]), Number(h[2]), undefined, true);
    return time ? { time, first: i, last: i } : undefined;
  }
  return undefined;
}

/** Reads a written number; `ambiguous` when its separators read two ways. */
export function parseNumber(
  text: string,
  currency?: string
): { value?: number | undefined; ambiguous: boolean } {
  if (!NUMBER.test(text)) return { ambiguous: true };
  if (/^\d+$/.test(text)) return { value: Number(text), ambiguous: false };
  const dots = (text.match(/\./g) ?? []).length;
  const commas = (text.match(/,/g) ?? []).length;
  const grouped = (body: string, mark: string): boolean =>
    new RegExp(`^\\d{1,3}(\\${mark}\\d{3})+$`).test(body);
  if (dots > 0 && commas > 0) {
    const decimal = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    const cut = text.lastIndexOf(decimal);
    const whole = text.slice(0, cut);
    const fraction = text.slice(cut + 1);
    if (
      whole.includes(decimal) ||
      !grouped(whole, thousands) ||
      !/^\d{1,2}$/.test(fraction)
    ) {
      return { ambiguous: true };
    }
    return {
      value: Number(`${whole.split(thousands).join('')}.${fraction}`),
      ambiguous: false,
    };
  }
  const mark = dots > 0 ? '.' : ',';
  const count = dots + commas;
  if (count > 1) {
    return grouped(text, mark)
      ? { value: Number(text.split(mark).join('')), ambiguous: false }
      : { ambiguous: true };
  }
  const [whole, fraction] = text.split(mark) as [string, string];
  if (fraction.length === 3) {
    if (mark === ',' && currency !== 'EUR' && whole.length <= 3) {
      return { value: Number(whole + fraction), ambiguous: false };
    }
    return { ambiguous: true };
  }
  if (fraction.length <= 2)
    return { value: Number(`${whole}.${fraction}`), ambiguous: false };
  return { ambiguous: true };
}

interface AmountMatch {
  amount: Omit<AmountEntity, keyof Span | 'kind'>;
  first: number;
  last: number;
}

interface SuffixMatch<T> {
  value: T;
  last: number;
}

function matchBasis(
  pt: readonly PT[],
  k: number
): SuffixMatch<Basis> | undefined {
  const token = at(pt, k);
  if (!token) return undefined;
  const next = wordAt(pt, k + 1);
  if (token.text === '/' && next !== undefined && UNITS[next] !== undefined) {
    return { value: UNITS[next] as Basis, last: k + 1 };
  }
  if (token.type !== 'word') return undefined;
  if (token.text === 'per' && next !== undefined) {
    if (UNITS[next] !== undefined)
      return { value: UNITS[next] as Basis, last: k + 1 };
    // "per 10 hour day", "per 10-hour day", "per 10hr day"
    let m = k + 1;
    if (/^\d+$/.test(next)) {
      const hours = wordAt(pt, k + 2);
      if (hours !== undefined && UNITS[hours] === 'hour') m = k + 2;
    } else if (/^\d+-?(hour|hours|hr|hrs)$/.test(next)) {
      m = k + 1;
    } else {
      return undefined;
    }
    const unit = wordAt(pt, m + 1);
    if (unit !== undefined && UNITS[unit] !== undefined) {
      return { value: UNITS[unit] as Basis, last: m + 1 };
    }
    return undefined;
  }
  if ((token.text === 'a' || token.text === 'an') && next !== undefined) {
    const unit = UNITS[next];
    if (unit !== undefined && unit !== 'flat')
      return { value: unit, last: k + 1 };
    return undefined;
  }
  const word = BASIS_WORDS[token.text];
  if (word !== undefined) {
    if (word === 'flat' && (next === 'rate' || next === 'fee'))
      return { value: 'flat', last: k + 1 };
    return { value: word, last: k };
  }
  return undefined;
}

const VAT_WORDS = new Set(['vat', 'v.a.t']);
const PERCENT = /^\d+(?:\.\d+)?%$/;
const INC_WORDS = new Set(['inc', 'incl', 'including', 'inclusive']);
const EX_WORDS = new Set(['ex', 'exc', 'excl', 'excluding', 'exclusive']);

function isVat(word: string | undefined): boolean {
  return word !== undefined && VAT_WORDS.has(word);
}

/**
 * Tax words starting at `k`: "+ VAT", "plus 20% VAT", "inc. VAT", "ex V.A.T.",
 * "net of VAT", "VAT exempt", also after a comma ("£350 per day, plus VAT")
 * or in brackets.
 */
function matchTax(pt: readonly PT[], k: number): SuffixMatch<Tax> | undefined {
  let i = k;
  const lead = at(pt, i);
  if (lead?.type === 'punct' && (lead.text === ',' || lead.text === '-'))
    i += 1;
  const open = at(pt, i);
  const bracketed = open?.type === 'punct' && open.text === '(';
  if (bracketed) i += 1;
  const a = at(pt, i);
  if (!a) return undefined;
  // A full stop after an abbreviation ("inc. VAT") sits between the words.
  const next = (from: number): number => (from < 0 ? -1 : after(pt, from, '.'));
  /** The index of "vat" reached from `from` over an optional "of" and rate. */
  const vatFrom = (from: number): number => {
    let j = from;
    if (wordAt(pt, j) === 'of') j = next(j);
    if (j >= 0 && PERCENT.test(wordAt(pt, j) ?? '')) j = next(j);
    return j >= 0 && isVat(wordAt(pt, j)) ? j : -1;
  };
  const w1 = a.text;
  const i2 = next(i);
  const w2 = wordAt(pt, i2);
  let tax: Tax | undefined;
  let last = i;
  const take = (t: Tax, end: number): void => {
    if (end < 0) return;
    tax = t;
    last = end;
  };
  if (w1 === '+' || w1 === 'plus') take('plus_vat', vatFrom(i2));
  else if (INC_WORDS.has(w1)) take('inc_vat', vatFrom(i2));
  else if (EX_WORDS.has(w1) || w1 === 'before') take('ex_vat', vatFrom(i2));
  else if (w1 === 'net' && w2 === 'of') take('ex_vat', vatFrom(i2));
  else if (w1 === 'no' && isVat(w2)) take('no_vat', i2);
  else if (isVat(w1) && w2 !== undefined) {
    if (['inc', 'incl', 'included', 'inclusive'].includes(w2))
      take('inc_vat', i2);
    else if (w2 === 'exempt') take('no_vat', i2);
    else if (w2 === 'exclusive' || w2 === 'excluded') take('ex_vat', i2);
    else if (w2 === 'extra') take('plus_vat', i2);
  }
  if (tax === undefined) return undefined;
  if (bracketed) {
    const close = at(pt, last + 1);
    if (close?.type === 'punct' && close.text === ')') last += 1;
  }
  return { value: tax, last };
}

/** Tax words written before an amount ("Day rate (ex VAT): £350"). */
const PRE_TAX: ReadonlyArray<readonly [readonly string[], Tax]> = [
  [['net', 'of', 'vat'], 'ex_vat'],
  [['exclusive', 'of', 'vat'], 'ex_vat'],
  [['inclusive', 'of', 'vat'], 'inc_vat'],
  [['ex', 'vat'], 'ex_vat'],
  [['exc', 'vat'], 'ex_vat'],
  [['excl', 'vat'], 'ex_vat'],
  [['excluding', 'vat'], 'ex_vat'],
  [['before', 'vat'], 'ex_vat'],
  [['vat', 'exclusive'], 'ex_vat'],
  [['inc', 'vat'], 'inc_vat'],
  [['incl', 'vat'], 'inc_vat'],
  [['including', 'vat'], 'inc_vat'],
  [['vat', 'inclusive'], 'inc_vat'],
  [['vat', 'included'], 'inc_vat'],
  [['plus', 'vat'], 'plus_vat'],
  [['+', 'vat'], 'plus_vat'],
  [['no', 'vat'], 'no_vat'],
  [['vat', 'exempt'], 'no_vat'],
];

/** Every word of a tax phrase written before an amount. */
export const PRE_TAX_WORDS: ReadonlySet<string> = new Set([
  ...PRE_TAX.flatMap(([phrase]) => phrase),
  'v.a.t',
]);

function matchPreTax(pt: readonly PT[], first: number): Tax | undefined {
  const words: string[] = [];
  for (let k = first - 1; k >= 0 && words.length < 3; k--) {
    const token = pt[k] as PT;
    if (token.type === 'punct') continue;
    words.unshift(VAT_WORDS.has(token.text) ? 'vat' : token.text);
  }
  for (const [phrase, tax] of PRE_TAX) {
    const tail = words.slice(words.length - phrase.length);
    if (tail.length === phrase.length && tail.every((w, n) => w === phrase[n]))
      return tax;
  }
  return undefined;
}

function matchPreBasis(pt: readonly PT[], first: number): Basis | undefined {
  const words: string[] = [];
  for (let k = first - 1; k >= 0 && words.length < 3; k--) {
    const token = pt[k] as PT;
    if (token.type === 'punct') continue;
    if (words.length === 0 && token.text === 'of') continue;
    words.unshift(token.text);
  }
  for (const [phrase, basis] of PRE_BASIS) {
    const tail = words.slice(words.length - phrase.length);
    if (tail.length === phrase.length && tail.every((w, n) => w === phrase[n]))
      return basis;
  }
  return undefined;
}

function matchAmount(
  pt: readonly PT[],
  i: number,
  line: string
): AmountMatch | undefined {
  const token = at(pt, i);
  if (!token) return undefined;
  let currency: string | undefined;
  let numberIndex = i;
  if (token.type === 'symbol' && CURRENCY_SIGNS[token.text] !== undefined) {
    currency = CURRENCY_SIGNS[token.text];
    numberIndex = i + 1;
  } else if (token.type === 'word' && CURRENCY_CODES.has(token.text)) {
    currency = token.text.toUpperCase();
    numberIndex = i + 1;
  }
  const numberToken = at(pt, numberIndex);
  if (!numberToken || numberToken.type !== 'word') return undefined;
  if (numberIndex > i && numberToken.start - token.end > 1) return undefined;
  let text = numberToken.text;
  let codeGlued: string | undefined;
  const codeFirst =
    /^(gbp|eur|usd|chf|aud|cad|nzd|sek|nok|dkk|jpy|zar|aed)(\d.*)$/.exec(text);
  if (codeFirst && currency === undefined) {
    codeGlued = (codeFirst[1] as string).toUpperCase();
    text = codeFirst[2] as string;
  }
  const m = AMOUNT_TOKEN.exec(text);
  if (!m) return undefined;
  const sign = m[1];
  if (sign !== undefined) {
    if (currency !== undefined) return undefined;
    currency = CURRENCY_SIGNS[sign];
  }
  currency = currency ?? codeGlued;
  const numberText = m[2] as string;
  let rest = m[3] as string;
  let basis: Basis | undefined;
  let unknownSuffix = false;
  const codeAfter =
    /^(gbp|eur|usd|chf|aud|cad|nzd|sek|nok|dkk|jpy|zar|aed)(.*)$/.exec(rest);
  if (codeAfter && currency === undefined) {
    currency = (codeAfter[1] as string).toUpperCase();
    rest = codeAfter[2] as string;
  }
  if (rest !== '') {
    const glued = BASIS_SUFFIXES[rest];
    if (glued !== undefined) basis = glued;
    else if (currency !== undefined) unknownSuffix = true;
    else return undefined;
  }
  let last = numberIndex;
  if (currency === undefined) {
    const next = wordAt(pt, last + 1);
    if (
      next !== undefined &&
      (CURRENCY_CODES.has(next) || CURRENCY_WORDS[next] !== undefined)
    ) {
      currency = CURRENCY_WORDS[next] ?? next.toUpperCase();
      last += 1;
    }
  }
  let tax: Tax | undefined;
  for (let round = 0; round < 2; round++) {
    if (basis === undefined) {
      const b = matchBasis(pt, last + 1);
      if (b) {
        basis = b.value;
        last = b.last;
        continue;
      }
    }
    if (tax === undefined) {
      const t = matchTax(pt, last + 1);
      if (t) {
        tax = t.value;
        last = t.last;
        continue;
      }
    }
    break;
  }
  const number = parseNumber(numberText, currency);
  const preTax = matchPreTax(pt, i);
  const marked =
    currency !== undefined ||
    basis !== undefined ||
    tax !== undefined ||
    preTax !== undefined;
  return {
    amount: {
      value: number.value,
      numberText,
      ambiguous: number.ambiguous,
      currency,
      basis,
      tax,
      marked,
      unknownSuffix,
      preBasis: matchPreBasis(pt, i),
      preTax,
      besideMarked: false,
    },
    first: i,
    last,
  };
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const RELATIVE_PHRASES: ReadonlyArray<
  readonly [readonly string[], number | undefined]
> = [
  [['the', 'following', 'morning'], 1],
  [['the', 'following', 'day'], 1],
  [['the', 'next', 'morning'], 1],
  [['the', 'next', 'day'], 1],
  [['the', 'morning', 'after'], 1],
  [['the', 'day', 'after'], 1],
  [['the', 'day', 'before'], -1],
  [['the', 'night', 'before'], -1],
  [['the', 'evening', 'before'], -1],
  [['the', 'previous', 'day'], -1],
  [['the', 'same', 'day'], 0],
  [['day', 'of', 'show'], undefined],
  [['last', 'day'], undefined],
  [['final', 'day'], undefined],
  [['opening', 'day'], undefined],
  [['closing', 'day'], undefined],
  [['opening', 'night'], undefined],
  [['closing', 'night'], undefined],
  [['press', 'night'], undefined],
  [['first', 'night'], undefined],
  [['last', 'night'], undefined],
  [['final', 'night'], undefined],
  [['show', 'night'], undefined],
  [['tech', 'day'], undefined],
  [['prep', 'day'], undefined],
  [['rig', 'day'], undefined],
  [['install', 'day'], undefined],
  [['load-out', 'day'], undefined],
  [['get-out', 'day'], undefined],
  [['following', 'morning'], 1],
  [['following', 'day'], 1],
  [['next', 'morning'], 1],
  [['next', 'day'], 1],
  [['day', 'after'], 1],
  [['day', 'before'], -1],
  [['night', 'before'], -1],
  [['previous', 'day'], -1],
  [['same', 'day'], 0],
  [['that', 'day'], 0],
  [['that', 'evening'], 0],
  [['this', 'evening'], 0],
  [['show', 'day'], undefined],
  [['build', 'day'], undefined],
  [['get-in', 'day'], undefined],
  [['load-in', 'day'], undefined],
  [['rehearsal', 'day'], undefined],
  [['travel', 'day'], undefined],
  [['derig', 'day'], undefined],
  [['de-rig', 'day'], undefined],
  [['strike', 'day'], undefined],
  [['event', 'day'], undefined],
  [['tomorrow'], 1],
  [['yesterday'], -1],
  [['today'], 0],
  [['tonight'], 0],
];

const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

function ordinalNumber(text: string): number | undefined {
  const m = /^(\d{1,2})(st|nd|rd|th)$/.exec(text);
  return m ? Number(m[1]) : ORDINAL_WORDS[text];
}

function scanRelatives(words: readonly Token[], line: string): RelativeDay[] {
  const out: RelativeDay[] = [];
  const texts = words.map((w) => w.text);
  let i = 0;
  while (i < texts.length) {
    const here = texts[i] as string;
    const next = at(texts, i + 1);
    // "second day", "3rd day": the day number written as an ordinal.
    const ordinal = ordinalNumber(here);
    if (ordinal !== undefined && next === 'day') {
      const start = (words[i] as Token).start;
      const end = (words[i + 1] as Token).end;
      out.push({
        kind: 'relative',
        dayNumber: ordinal,
        text: line.slice(start, end),
        start,
        end,
      });
      i += 2;
      continue;
    }
    if (here === 'day' && next !== undefined) {
      const n = /^\d{1,2}$/.test(next) ? Number(next) : NUMBER_WORDS[next];
      if (n !== undefined) {
        const start = (words[i] as Token).start;
        const end = (words[i + 1] as Token).end;
        out.push({
          kind: 'relative',
          dayNumber: n,
          text: line.slice(start, end),
          start,
          end,
        });
        i += 2;
        continue;
      }
    }
    let matched = false;
    for (const [phrase, offset] of RELATIVE_PHRASES) {
      if (phrase.every((p, n) => texts[i + n] === p)) {
        const start = (words[i] as Token).start;
        const end = (words[i + phrase.length - 1] as Token).end;
        out.push({
          kind: 'relative',
          offset,
          text: line.slice(start, end),
          start,
          end,
        });
        i += phrase.length;
        matched = true;
        break;
      }
    }
    if (!matched) i++;
  }
  return out;
}

function scanPhones(tokens: readonly Token[], line: string): PhoneEntity[] {
  const out: PhoneEntity[] = [];
  let i = 0;
  while (i < tokens.length) {
    const first = tokens[i] as Token;
    if (first.type !== 'word' || !/^(\+\d{1,3}|0[\d-]*)$/.test(first.text)) {
      i++;
      continue;
    }
    let digits = first.text.replace(/[^\d]/g, '');
    const international = first.text.startsWith('+');
    let best = -1;
    let bestDigits = '';
    const valid = (d: string): boolean =>
      international
        ? d.length >= 11 && d.length <= 13
        : d.length >= 10 && d.length <= 11;
    if (valid(digits)) {
      best = i;
      bestDigits = digits;
    }
    let k = i + 1;
    while (k < tokens.length && digits.length < 13) {
      const t = tokens[k] as Token;
      if (t.type === 'punct' && ['(', ')', '-', '.'].includes(t.text)) {
        k++;
        continue;
      }
      if (t.type !== 'word' || !/^[\d-]+$/.test(t.text)) break;
      // "+44 (0)7700": the trunk zero is not dialled after a country code.
      const trunk =
        international && t.text === '0' && at(tokens, k - 1)?.text === '(';
      if (!trunk) digits += t.text.replace(/-/g, '');
      if (valid(digits)) {
        best = k;
        bestDigits = digits;
      }
      k++;
    }
    if (best >= 0) {
      const start = first.start;
      const end = (tokens[best] as Token).end;
      out.push({
        kind: 'phone',
        digits: bestDigits,
        text: line.slice(start, end),
        start,
        end,
      });
      i = best + 1;
    } else {
      i++;
    }
  }
  return out;
}

function overlaps(
  a: { start: number; end: number },
  b: { start: number; end: number }
): boolean {
  return a.start < b.end && b.start < a.end;
}

function covered(
  token: { start: number; end: number },
  spans: readonly { start: number; end: number }[]
): boolean {
  return spans.some((s) => overlaps(token, s));
}

const RANGE_JOINS = new Set([
  'to',
  'until',
  'till',
  'til',
  'thru',
  'through',
  'and',
  'or',
]);

/** "-", "&", "/" or a word that joins the two ends of a range or a pair. */
function isRangeSeparator(token: PT | undefined): boolean {
  if (!token) return false;
  if (token.type === 'punct') return token.text === '-';
  if (token.type === 'symbol') return token.text === '&' || token.text === '/';
  return RANGE_JOINS.has(token.text);
}

/** Splits a reference token into the label it is glued to and its core. */
export function referenceParts(text: string): {
  core: string;
  key: string;
  prefix?: string;
} {
  const m = REFERENCE_PREFIX.exec(text);
  const core = m ? text.slice(m[0].length) : text;
  const key = core.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
  return m ? { core, key, prefix: m[1] as string } : { core, key };
}

/** Scans one line. Throws `ParseError` for text with a line break. */
export function scanLine(text: string): LineScan {
  const line = normalize(text);
  if (line.includes('\n')) {
    throw new ParseError(
      'not_one_line',
      'scanLine takes one line; use scanText'
    );
  }
  const tokens = tokenizeLine(line);
  const pt = parseTokens(tokens);
  const phones = scanPhones(tokens, line);
  const emails: EmailEntity[] = tokens
    .filter((t) => t.type === 'word' && /@[^@]+\.[^@]+$/.test(t.text))
    .map((t) => ({ kind: 'email', text: t.text, start: t.start, end: t.end }));
  const postcodes: Span[] = [];
  for (let k = 0; k + 1 < tokens.length; k++) {
    const a = tokens[k] as Token;
    const b = tokens[k + 1] as Token;
    if (/^[a-z]{1,2}\d[a-z\d]?$/.test(a.text) && /^\d[a-z]{2}$/.test(b.text)) {
      postcodes.push({
        text: line.slice(a.start, b.end),
        start: a.start,
        end: b.end,
      });
    }
  }
  const blocked: { start: number; end: number }[] = [
    ...phones,
    ...emails,
    ...postcodes,
  ];

  const dates: DateEntity[] = [];
  const ranges: DateRangeEntity[] = [];
  for (let i = 0; i < pt.length; ) {
    const token = pt[i] as PT;
    if (token.type !== 'word' || covered(token, blocked)) {
      i++;
      continue;
    }
    const range = matchRange(pt, i);
    if (range) {
      ranges.push({
        kind: 'date_range',
        from: freeze(range.from),
        to: freeze(range.to),
        ...spanOf(pt, line, range.first, range.last),
      });
      i = range.last + 1;
      continue;
    }
    const list = matchListDays(pt, i);
    if (list) {
      list.indices.forEach((index, n) => {
        const shared: ('month' | 'year')[] = ['month'];
        if (list.tail.year !== undefined) shared.push('year');
        dates.push({
          kind: 'date',
          parts: freeze(
            draft({
              day: list.days[n],
              month: list.tail.month,
              year: list.tail.year,
              monthInWords: list.tail.monthInWords,
              shared,
            })
          ),
          ...spanOf(pt, line, index, index),
        });
      });
      i = (list.indices[list.indices.length - 1] as number) + 1;
      continue;
    }
    const date = matchDate(pt, i, false);
    if (date) {
      dates.push({
        kind: 'date',
        parts: freeze(date.parts),
        ...spanOf(pt, line, date.first, date.last),
      });
      i = date.last + 1;
      continue;
    }
    i++;
  }
  blocked.push(...dates, ...ranges);

  const times: TimeEntity[] = [];
  const timeAt: { first: number; last: number }[] = [];
  for (let i = 0; i < pt.length; ) {
    const token = pt[i] as PT;
    if (token.type !== 'word' || covered(token, blocked)) {
      i++;
      continue;
    }
    const time = matchTime(pt, i);
    if (time) {
      times.push({
        kind: 'time',
        ...time.time,
        ...spanOf(pt, line, time.first, time.last),
      });
      timeAt.push({ first: time.first, last: time.last });
      i = time.last + 1;
      continue;
    }
    i++;
  }
  // The bare hour at the other end of a time range is a time of its own.
  const partners = new Set<number>();
  for (const { first, last } of timeAt) {
    if (isRangeSeparator(at(pt, first - 1))) partners.add(first - 2);
    if (isRangeSeparator(at(pt, last + 1))) partners.add(last + 2);
  }
  for (const k of [...partners].sort((a, b) => a - b)) {
    const token = at(pt, k);
    if (!token || token.type !== 'word' || !/^\d{1,2}$/.test(token.text))
      continue;
    if (covered(token, blocked) || covered(token, times)) continue;
    const unit = wordAt(pt, k + 1);
    if (unit !== undefined && QUANTITY_UNITS.has(unit)) continue;
    const time = resolveClock(Number(token.text), 0, undefined, false);
    if (time) times.push({ kind: 'time', ...time, ...spanOf(pt, line, k, k) });
  }
  times.sort((a, b) => a.start - b.start);
  blocked.push(...times);

  const found: { amount: AmountEntity; first: number; last: number }[] = [];
  for (let i = 0; i < pt.length; ) {
    const token = pt[i] as PT;
    if (token.type === 'punct' || covered(token, blocked)) {
      i++;
      continue;
    }
    const amount = matchAmount(pt, i, line);
    if (
      amount &&
      !covered(spanOf(pt, line, amount.first, amount.last), blocked)
    ) {
      const span = spanOf(pt, line, amount.first, amount.last);
      const bare = !amount.amount.marked;
      const nextWord = wordAt(pt, amount.last + 1);
      const before = wordBefore(pt, amount.first);
      const quantity = nextWord !== undefined && QUANTITY_UNITS.has(nextWord);
      const labelled = before !== undefined && REFERENCE_LABELS.has(before);
      if (!bare || (!quantity && !labelled)) {
        found.push({
          amount: { kind: 'amount', ...amount.amount, ...span },
          first: amount.first,
          last: amount.last,
        });
      }
      i = amount.last + 1;
      continue;
    }
    i++;
  }
  // A bare number right beside a marked amount, or joined to one as a range,
  // is an amount too ("350-400 GBP", "£300 to 350", "£1 200").
  const joined = (a: { last: number }, b: { first: number }): boolean =>
    b.first === a.last + 1 ||
    (b.first === a.last + 2 && isRangeSeparator(at(pt, a.last + 1)));
  const amounts: AmountEntity[] = found.map((f) => {
    if (f.amount.marked) return f.amount;
    const beside = found.some(
      (g) => g.amount.marked && (joined(g, f) || joined(f, g))
    );
    return beside ? { ...f.amount, besideMarked: true } : f.amount;
  });
  blocked.push(...amounts.filter((a) => a.marked || a.besideMarked));

  const references: ReferenceEntity[] = [];
  tokens.forEach((t, k) => {
    if (t.type !== 'word' || !/\d/.test(t.text) || covered(t, blocked)) return;
    const alnum = t.text.replace(/[^\p{L}\p{N}]/gu, '');
    if (alnum.length < 3) return;
    if (
      /^\d+(st|nd|rd|th)$/.test(t.text) ||
      t.text.endsWith('%') ||
      FRACTIONS.has(t.text)
    )
      return;
    if (QUANTITY_TOKEN.test(t.text)) return;
    const prev =
      k > 0
        ? (tokens
            .slice(0, k)
            .reverse()
            .find((p) => p.type !== 'punct')?.text ?? '')
        : '';
    const next = tokens.slice(k + 1).find((p) => p.type !== 'punct')?.text;
    if (YEAR_TOKEN.test(t.text) && !REFERENCE_LABELS.has(prev)) return;
    if (NUMBER.test(t.text) && next !== undefined && QUANTITY_UNITS.has(next))
      return;
    references.push({
      kind: 'reference',
      ...referenceParts(t.text),
      text: t.text,
      start: t.start,
      end: t.end,
    });
  });

  const relatives = scanRelatives(
    tokens.filter((t) => t.type === 'word'),
    line
  );
  return {
    line,
    tokens,
    dates,
    ranges,
    times,
    amounts,
    references,
    relatives,
    phones,
    emails,
    postcodes,
  };
}

/** Scans every line of a text, in order. */
export function scanText(text: string): LineScan[] {
  return splitLines(text).map(scanLine);
}

/**
 * The amounts a scan counts: when any is marked, the marked ones and the bare
 * numbers beside them; else all.
 */
export function effectiveAmounts(
  amounts: readonly AmountEntity[]
): AmountEntity[] {
  return amounts.some((a) => a.marked)
    ? amounts.filter((a) => a.marked || a.besideMarked)
    : [...amounts];
}

export type EntityCounts = Readonly<Record<EntityKind, number>>;

/**
 * How many entities of each kind a text holds. A range counts as one
 * `date_range` and two `date`s; a single date counts as one of each.
 */
export function countEntities(text: string): EntityCounts {
  const scans = scanText(text);
  const all = scans.flatMap((s) => s.amounts);
  return {
    date: scans.reduce((n, s) => n + s.dates.length + 2 * s.ranges.length, 0),
    date_range: scans.reduce((n, s) => n + s.dates.length + s.ranges.length, 0),
    time: scans.reduce((n, s) => n + s.times.length, 0),
    amount: effectiveAmounts(all).length,
    reference: scans.reduce((n, s) => n + s.references.length, 0),
  };
}

export interface Single<T> {
  /** Defined exactly when `count` is 1. */
  readonly entity?: T | undefined;
  readonly count: number;
}

function single<T>(found: readonly T[]): Single<T> {
  return found.length === 1
    ? { entity: found[0], count: 1 }
    : { count: found.length };
}

/** The one time a string holds, if it holds exactly one. */
export function parseTime(text: string): Single<TimeEntity> {
  return single(scanText(text).flatMap((s) => s.times));
}

/** The one single date a string holds; a range is not a date. */
export function parseDate(text: string): Single<DateEntity> {
  const scans = scanText(text);
  if (scans.some((s) => s.ranges.length > 0)) {
    return {
      count: scans.reduce(
        (n, s) => n + s.dates.length + 2 * s.ranges.length,
        0
      ),
    };
  }
  return single(scans.flatMap((s) => s.dates));
}

/** The one date range, or single date as a one-day range, a string holds. */
export function parseDateRange(text: string): Single<DateRangeEntity> {
  const found: DateRangeEntity[] = scanText(text).flatMap((s) => [
    ...s.ranges,
    ...s.dates.map(
      (d): DateRangeEntity => ({
        kind: 'date_range',
        from: d.parts,
        to: d.parts,
        text: d.text,
        start: d.start,
        end: d.end,
      })
    ),
  ]);
  return single(found);
}

/** The one amount a string holds, counted as `effectiveAmounts` counts. */
export function parseAmount(text: string): Single<AmountEntity> {
  return single(effectiveAmounts(scanText(text).flatMap((s) => s.amounts)));
}

/** The one reference a string holds. */
export function parseReference(text: string): Single<ReferenceEntity> {
  return single(scanText(text).flatMap((s) => s.references));
}

/** A key for comparing two writings of the same date parts. */
export function partsKey(parts: DateParts): string {
  const pad = (n: number | undefined, w: number): string =>
    n === undefined ? '?'.repeat(w) : String(n).padStart(w, '0');
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}${parts.ambiguous ? '~' : ''}`;
}

/** A key for comparing two writings of the same time. */
export function timeKey(time: TimeEntity): string {
  return (
    time.resolved ?? `${time.hour}:${String(time.minute).padStart(2, '0')}?`
  );
}

/** A key for comparing two writings of the same amount. */
export function amountKey(amount: AmountEntity): string {
  return [
    amount.currency ?? '',
    amount.value === undefined ? `~${amount.numberText}` : String(amount.value),
    amount.basis ?? '',
    taxOf(amount) ?? '',
  ]
    .filter((p) => p !== '')
    .join(' ');
}
