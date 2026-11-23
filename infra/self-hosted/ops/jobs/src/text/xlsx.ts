// Excel (.xlsx) text (docs/supamac/jobs.md §2): each cell as
// "<column header>: <value>", with the row's first cell as its key; hidden
// sheets, rows and columns dropped; numbers kept in their display format.
//
// Invariants:
// - Sheets are read in workbook order; a hidden or very hidden sheet, a
//   chart sheet, a hidden row (hidden, or a custom height of 0) and a hidden
//   column (hidden, or a width of 0) are never read.
// - A cell's text is what Excel shows for its stored value under its format:
//   shared and inline strings as written (through the format's text section,
//   when it has one), a formula's cached result, TRUE/FALSE, an error code.
//   The format's section for the value applies (positive, negative, zero, or
//   by condition); an empty section shows nothing, so ";;;" hides a value
//   and "0;-0;;@" hides a zero, and a hidden value is not read. A negative
//   section writes its own sign ("(350.00)").
// - A number follows its section's decimals, thousands separator, percent
//   sign and scaling, and keeps every word and symbol the format writes
//   around it ("£350/day", "350.00 + VAT", "approx. 350"), so a hedge or a
//   rate's basis is never lost.
// - A number under a date or time format is read from its serial, in the
//   workbook's date system. Day, month and year all shown are written
//   YYYY-MM-DD, and an hour with its minutes HH:MM (HH:MM:SS when seconds are
//   shown) on the 24-hour clock: the serial fixes the reading, so 03/04 can
//   never read two ways. A format that leaves out the year, the day or the
//   minutes is written as Excel shows it ("3-Apr", "Apr-26", "April 2026",
//   "7 PM"): what the owner does not see is never filled in.
// - A currency symbol is shown only when the format itself writes it
//   ([$£-809], "£", €). The built-in currency and accounting formats store no
//   symbol (Excel takes it from the reader's locale), so their numbers are
//   shown without one: a currency is never filled in.
// - Each visible sheet is a page, in workbook order; a sheet's own name is its
//   first line unless it is a default name ("Sheet1").
// - A vertically merged cell's value applies to every row it spans.
// - The first row is a header row only as table.ts's `looksLikeHeader` allows.
// - More than `maxCells` non-empty cells are refused, never cut short; a
//   part with more than `xmlElements` elements (a shared-strings table of
//   millions of tiny strings) is refused before it is parsed.

import type { TextPage } from '../model';
import {
  cell,
  inferredTableLines,
  type TableCell,
  type TableRow,
} from './table';
import { ExtractError, type Limits } from './types';
import {
  attr,
  child,
  elements,
  localName,
  parseXml,
  textOf,
  type XNode,
} from './xml';
import { resolvePart } from './docx';
import type { ZipArchive } from './zip';

const BUILTIN_FORMATS: Readonly<Record<number, string>> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  5: '#,##0',
  6: '#,##0',
  7: '#,##0.00',
  8: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: 'General',
  13: 'General',
  14: 'yyyy-mm-dd',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'yyyy-mm-dd h:mm',
  37: '#,##0',
  38: '#,##0',
  39: '#,##0.00',
  40: '#,##0.00',
  41: '#,##0',
  42: '#,##0',
  43: '#,##0.00',
  44: '#,##0.00',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mm:ss.0',
  48: '##0.0E+0',
  49: '@',
};

/** East Asian built-in date formats (27–36, 50–58). */
function builtinFormat(id: number): string {
  const known = BUILTIN_FORMATS[id];
  if (known !== undefined) return known;
  if ((id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return 'yyyy-mm-dd';
  return 'General';
}

export type FormatKind =
  | 'general'
  | 'text'
  | 'date'
  | 'time'
  | 'datetime'
  | 'elapsed'
  | 'number';

export interface NumberFormat {
  readonly kind: FormatKind;
  readonly decimals: number;
  readonly thousands: boolean;
  readonly percent: boolean;
  readonly scientific: boolean;
  readonly seconds: boolean;
  /** The currency symbol the format writes, and where. */
  readonly currency?:
    | { readonly symbol: string; readonly before: boolean }
    | undefined;
}

const CURRENCY_CHARS = /[£€$¥]/;
const CURRENCY_CODES = /^(GBP|EUR|USD|CHF|JPY|AUD|CAD|NZD|SEK|NOK|DKK)$/;

/**
 * One piece of a format section: a literal, a digit placeholder, a date or
 * time code, or a marker the renderers read.
 */
type Piece =
  | { readonly t: 'lit'; readonly s: string; readonly quoted: boolean }
  | { readonly t: 'digit'; readonly s: '0' | '#' | '?' }
  | { readonly t: 'dot' }
  | { readonly t: 'comma' }
  | { readonly t: 'percent' }
  | { readonly t: 'exp'; readonly sign: '+' | '-' }
  | { readonly t: 'general' }
  | { readonly t: 'at' }
  | { readonly t: 'code'; readonly s: string }
  | { readonly t: 'elapsed'; readonly s: string }
  | { readonly t: 'ampm'; readonly s: string };

/** The pieces of one section, in order; colours, locales and conditions are left out. */
function pieces(section: string): Piece[] {
  const out: Piece[] = [];
  let i = 0;
  while (i < section.length) {
    const ch = section[i] as string;
    if (ch === '"') {
      const end = section.indexOf('"', i + 1);
      const literal = section.slice(i + 1, end === -1 ? section.length : end);
      out.push({ t: 'lit', s: literal, quoted: true });
      i = end === -1 ? section.length : end + 1;
      continue;
    }
    if (ch === '[') {
      const end = section.indexOf(']', i + 1);
      const inner = section.slice(i + 1, end === -1 ? section.length : end);
      i = end === -1 ? section.length : end + 1;
      const money = /^\$([^-\]]*)(?:-.*)?$/.exec(inner);
      if (money?.[1]) out.push({ t: 'lit', s: money[1], quoted: true });
      else if (/^(h+|m+|s+)$/i.test(inner))
        out.push({ t: 'elapsed', s: inner.toLowerCase() });
      continue;
    }
    if (ch === '\\') {
      out.push({ t: 'lit', s: section[i + 1] ?? '', quoted: true });
      i += 2;
      continue;
    }
    if (ch === '_') {
      out.push({ t: 'lit', s: ' ', quoted: false });
      i += 2;
      continue;
    }
    if (ch === '*') {
      i += 2;
      continue;
    }
    if (/^general/i.test(section.slice(i, i + 7))) {
      out.push({ t: 'general' });
      i += 7;
      continue;
    }
    const ampm = /^(am\/pm|a\/p)/i.exec(section.slice(i));
    if (ampm) {
      out.push({ t: 'ampm', s: ampm[1] as string });
      i += (ampm[1] as string).length;
      continue;
    }
    if (ch === '0' || ch === '#' || ch === '?') {
      out.push({ t: 'digit', s: ch });
      i++;
      continue;
    }
    if (ch === '.') {
      out.push({ t: 'dot' });
      i++;
      continue;
    }
    if (ch === ',') {
      out.push({ t: 'comma' });
      i++;
      continue;
    }
    if (ch === '%') {
      out.push({ t: 'percent' });
      i++;
      continue;
    }
    if ((ch === 'E' || ch === 'e') && /[+-]/.test(section[i + 1] ?? '')) {
      out.push({ t: 'exp', sign: section[i + 1] === '-' ? '-' : '+' });
      i += 2;
      continue;
    }
    if (ch === '@') {
      out.push({ t: 'at' });
      i++;
      continue;
    }
    if (/[ymdhs]/i.test(ch)) {
      let j = i + 1;
      while (
        j < section.length &&
        section[j]?.toLowerCase() === ch.toLowerCase()
      )
        j++;
      out.push({ t: 'code', s: section.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    // Excel shows other characters ($ - + / ( ) : space £ € and the rest) as written.
    out.push({ t: 'lit', s: ch, quoted: false });
    i++;
  }
  return out;
}

/** What one section shows a number as. */
function sectionKind(section: string): FormatKind {
  const trimmed = section.trim();
  if (/^general$/i.test(trimmed)) return 'general';
  const list = pieces(section);
  if (list.some((p) => p.t === 'elapsed')) return 'elapsed';
  const codes = list.filter((p) => p.t === 'code').map((p) => p.s);
  const hasTime =
    codes.some((c) => c.startsWith('h') || c.startsWith('s')) ||
    list.some((p) => p.t === 'ampm');
  const hasDate =
    codes.some((c) => c.startsWith('y') || c.startsWith('d')) ||
    (codes.some((c) => c.startsWith('m')) && !hasTime);
  if (hasDate || hasTime)
    return hasDate && hasTime ? 'datetime' : hasDate ? 'date' : 'time';
  if (list.some((p) => p.t === 'digit' || p.t === 'general')) return 'number';
  if (list.some((p) => p.t === 'at')) return 'text';
  return list.length === 0 ? 'general' : 'number';
}

/** Reads what a number format code's first section shows: its kind, decimals and symbol. */
export function parseFormat(code: string): NumberFormat {
  const base = {
    decimals: 0,
    thousands: false,
    percent: false,
    scientific: false,
    seconds: false,
  };
  const section = splitSections(code)[0] ?? '';
  const kind = section.trim() === '' ? 'general' : sectionKind(section);
  const list = pieces(section);
  if (kind === 'general' || kind === 'text') return { kind, ...base };
  if (kind !== 'number') {
    const seconds = list.some(
      (p) =>
        (p.t === 'code' && p.s.startsWith('s')) ||
        (p.t === 'elapsed' && p.s.startsWith('s'))
    );
    return { kind, ...base, seconds };
  }
  let currency: NumberFormat['currency'];
  let seenDigit = false;
  for (const p of list) {
    if (p.t === 'digit') seenDigit = true;
    if (p.t !== 'lit' || currency) continue;
    const text = p.s.trim();
    if (CURRENCY_CHARS.test(text) || CURRENCY_CODES.test(text))
      currency = { symbol: text, before: !seenDigit };
  }
  const number = numberShape(list);
  return {
    kind,
    decimals: number.decimals,
    thousands: number.thousands,
    percent: number.percents > 0,
    scientific: number.exponent !== undefined,
    seconds: false,
    currency,
  };
}

/** Format sections split on ";" outside quotes and brackets. */
function splitSections(code: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote = false;
  let bracket = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i] as string;
    if (ch === '\\' && !quote) {
      current += ch + (code[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '"') quote = !quote;
    else if (!quote && ch === '[') bracket = true;
    else if (!quote && ch === ']') bracket = false;
    if (ch === ';' && !quote && !bracket) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/** A section's condition ("[>=100]"), when it has one. */
function conditionOf(
  section: string
): ((value: number) => boolean) | undefined {
  const m = /\[(<=|>=|<>|<|>|=)\s*(-?\d*\.?\d+)\]/.exec(section);
  if (!m) return undefined;
  const limit = Number(m[2]);
  switch (m[1]) {
    case '<':
      return (v) => v < limit;
    case '>':
      return (v) => v > limit;
    case '<=':
      return (v) => v <= limit;
    case '>=':
      return (v) => v >= limit;
    case '=':
      return (v) => v === limit;
    default:
      return (v) => v !== limit;
  }
}

/**
 * The section a number is shown by, and whether the section writes its own
 * sign (a negative section shows the number without its minus), or
 * undefined when no section applies.
 */
function sectionFor(
  sections: readonly string[],
  value: number
): { readonly section: string; readonly ownSign: boolean } | undefined {
  const numeric = sections.slice(0, 3);
  const conditions = numeric.map(conditionOf);
  if (conditions.some((c) => c !== undefined)) {
    for (const [i, c] of conditions.entries()) {
      if (c?.(value)) return { section: numeric[i] as string, ownSign: false };
    }
    const rest = numeric.find((_, i) => conditions[i] === undefined);
    return rest === undefined ? undefined : { section: rest, ownSign: false };
  }
  if (numeric.length === 1)
    return { section: numeric[0] as string, ownSign: false };
  if (value < 0) return { section: numeric[1] as string, ownSign: true };
  if (value === 0 && numeric.length >= 3)
    return { section: numeric[2] as string, ownSign: false };
  return { section: numeric[0] as string, ownSign: false };
}

const DAY_MS = 86_400_000;

/** A date serial as YYYY-MM-DD, or undefined when it names no day. */
export function serialDate(
  serial: number,
  date1904: boolean
): string | undefined {
  if (!Number.isFinite(serial) || serial < 0 || serial >= 2_958_466)
    return undefined;
  const days = Math.floor(serial);
  let ms: number;
  if (date1904) ms = Date.UTC(1904, 0, 1) + days * DAY_MS;
  else if (days === 60) return '1900-02-29';
  else if (days < 60) ms = Date.UTC(1899, 11, 31) + days * DAY_MS;
  else ms = Date.UTC(1899, 11, 30) + days * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The time of day of a serial as HH:MM (HH:MM:SS with seconds), rounded to the second. */
export function serialTime(
  serial: number,
  seconds: boolean
): string | undefined {
  if (!Number.isFinite(serial) || serial < 0) return undefined;
  const total = Math.round((serial - Math.floor(serial)) * 86_400) % 86_400;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return seconds ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}`;
}

function roundTo(value: number, decimals: number): number {
  return Number(`${Math.round(Number(`${value}e${decimals}`))}e-${decimals}`);
}

function groupThousands(integer: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Excel's General: up to 11 significant digits, no exponent for ordinary sizes. */
export function generalNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const text = String(Number(value.toPrecision(11)));
  return text;
}

interface NumberShape {
  /** Digit placeholders before the decimal point (or the exponent). */
  readonly integer: readonly ('0' | '#' | '?')[];
  readonly decimals: number;
  readonly fraction: readonly ('0' | '#' | '?')[];
  readonly thousands: boolean;
  /** Commas after the last integer placeholder: each divides by 1,000. */
  readonly scale: number;
  readonly percents: number;
  readonly exponent?:
    | { readonly sign: '+' | '-'; readonly digits: number }
    | undefined;
  /** Literals stand between integer placeholders ("000-0000"). */
  readonly interleaved: boolean;
}

function numberShape(list: readonly Piece[]): NumberShape {
  const integer: ('0' | '#' | '?')[] = [];
  const fraction: ('0' | '#' | '?')[] = [];
  let part: 'integer' | 'fraction' | 'exponent' = 'integer';
  let exponent: NumberShape['exponent'];
  let expDigits = 0;
  let thousands = false;
  let pendingCommas = 0;
  let scale = 0;
  let percents = 0;
  let interleaved = false;
  let literalSinceDigit = false;
  for (const p of list) {
    if (p.t === 'percent') percents++;
    if (part === 'integer') {
      if (p.t === 'digit') {
        if (pendingCommas > 0 && integer.length > 0) thousands = true;
        pendingCommas = 0;
        if (literalSinceDigit && integer.length > 0) interleaved = true;
        literalSinceDigit = false;
        integer.push(p.s);
      } else if (p.t === 'comma') {
        pendingCommas++;
      } else if (p.t === 'dot') {
        scale += pendingCommas;
        pendingCommas = 0;
        part = 'fraction';
      } else if (p.t === 'exp') {
        scale += pendingCommas;
        pendingCommas = 0;
        exponent = { sign: p.sign, digits: 0 };
        part = 'exponent';
      } else if (p.t === 'lit' && integer.length > 0) {
        literalSinceDigit = true;
      }
    } else if (part === 'fraction') {
      if (p.t === 'digit') fraction.push(p.s);
      else if (p.t === 'exp') {
        exponent = { sign: p.sign, digits: 0 };
        part = 'exponent';
      }
    } else if (p.t === 'digit') {
      expDigits++;
    }
  }
  if (part === 'integer') scale += pendingCommas;
  return {
    integer,
    decimals: fraction.length,
    fraction,
    thousands,
    scale,
    percents,
    exponent: exponent ? { sign: exponent.sign, digits: expDigits } : undefined,
    interleaved,
  };
}

/** A number under a number section, with the section's own words and symbols. */
function renderNumber(
  list: readonly Piece[],
  value: number,
  ownSign: boolean
): string {
  const shape = numberShape(list);
  let scaled = Math.abs(value) * 100 ** shape.percents;
  scaled /= 1000 ** shape.scale;

  // The integer and fraction digits, and the exponent, as text.
  let intDigits: string;
  let fracDigits: string;
  let expText = '';
  if (shape.exponent) {
    const [mantissa = '0', exp = '0'] = scaled
      .toExponential(shape.decimals)
      .split('e');
    const [i = '0', f = ''] = mantissa.split('.');
    intDigits = i;
    fracDigits = f;
    const e = Number(exp);
    const sign = e < 0 ? '-' : shape.exponent.sign === '+' ? '+' : '';
    expText = `E${sign}${String(Math.abs(e)).padStart(shape.exponent.digits, '0')}`;
  } else {
    const fixed = roundTo(scaled, shape.decimals).toFixed(shape.decimals);
    const [i = '0', f = ''] = fixed.split('.');
    intDigits = i;
    fracDigits = f;
  }
  if (/^0+$/.test(intDigits)) intDigits = '';
  // Trailing zeros are dropped for "#" places and blanked for "?" places.
  const frac = [...fracDigits];
  for (let k = shape.fraction.length - 1; k >= 0; k--) {
    if (frac[k] !== '0') break;
    if (shape.fraction[k] === '#') frac[k] = '';
    else if (shape.fraction[k] === '?') frac[k] = ' ';
    else break;
  }

  const zeros = shape.integer.filter((d) => d === '0').length;
  const pads = shape.integer.filter((d) => d !== '#').length;
  // The integer part as one run (the usual case) or digit by digit.
  const intRun = (): string => {
    let digits = intDigits.padStart(zeros, '0');
    if (shape.thousands) digits = groupThousands(digits);
    return digits.padStart(Math.max(digits.length, pads), ' ');
  };
  const perPlace: string[] = [];
  if (shape.interleaved) {
    let rest = intDigits;
    for (let k = shape.integer.length - 1; k >= 0; k--) {
      const place = shape.integer[k];
      if (k === 0)
        perPlace[k] = rest.padStart(
          place === '0' ? 1 : 0,
          place === '?' ? ' ' : '0'
        );
      else if (rest.length > 0) {
        perPlace[k] = rest.slice(-1);
        rest = rest.slice(0, -1);
      } else perPlace[k] = place === '0' ? '0' : place === '?' ? ' ' : '';
    }
  }

  let out = '';
  let part: 'integer' | 'fraction' | 'exponent' = 'integer';
  let intIndex = 0;
  let fracIndex = 0;
  let expWritten = false;
  for (const p of list) {
    switch (p.t) {
      case 'lit':
        out += p.s;
        break;
      case 'percent':
        out += '%';
        break;
      case 'general':
        out += generalNumber(Math.abs(value));
        break;
      case 'dot':
        if (part === 'integer') {
          part = 'fraction';
          out += '.';
        } else out += '.';
        break;
      case 'exp':
        part = 'exponent';
        if (!expWritten) out += expText;
        expWritten = true;
        break;
      case 'digit':
        if (part === 'integer') {
          if (shape.interleaved) out += perPlace[intIndex] ?? '';
          else if (intIndex === 0) out += intRun();
          intIndex++;
        } else if (part === 'fraction') {
          out += frac[fracIndex] ?? '';
          fracIndex++;
        }
        break;
      case 'comma':
        // Thousands are written with the integer run; scaling commas show nothing.
        break;
      default:
        // Date codes and "@" in a number section show nothing.
        break;
    }
  }
  const placed = shape.integer.length + shape.fraction.length > 0;
  const roundsToZero = placed && intDigits === '' && /^0*$/.test(fracDigits);
  const negative = value < 0 && !ownSign && !roundsToZero;
  return negative ? `-${out}` : out;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

type DateRole =
  | 'year'
  | 'month'
  | 'day'
  | 'weekday'
  | 'hour'
  | 'minute'
  | 'second'
  | 'fraction'
  | 'ampm'
  | 'elapsed';

interface DatePiece {
  readonly role: DateRole | 'lit';
  readonly s: string;
}

/** A date section's pieces with each code's role: "m" is a minute after an hour or before a second. */
function datePieces(list: readonly Piece[]): DatePiece[] {
  const out: DatePiece[] = [];
  const roleAt = (k: number, dir: 1 | -1): string | undefined => {
    for (let j = k + dir; j >= 0 && j < list.length; j += dir) {
      const q = list[j] as Piece;
      if (q.t === 'code') return q.s[0];
      if (q.t === 'elapsed') return q.s[0];
    }
    return undefined;
  };
  for (const [i, p] of list.entries()) {
    if (p.t === 'code') {
      const c = p.s[0];
      if (c === 'y') out.push({ role: 'year', s: p.s });
      else if (c === 'd')
        out.push({ role: p.s.length >= 3 ? 'weekday' : 'day', s: p.s });
      else if (c === 'h') out.push({ role: 'hour', s: p.s });
      else if (c === 's') out.push({ role: 'second', s: p.s });
      else if (
        p.s.length <= 2 &&
        (roleAt(i, -1) === 'h' || roleAt(i, 1) === 's')
      )
        out.push({ role: 'minute', s: p.s });
      else out.push({ role: 'month', s: p.s });
    } else if (p.t === 'elapsed') out.push({ role: 'elapsed', s: p.s });
    else if (p.t === 'ampm') out.push({ role: 'ampm', s: p.s });
    else if (p.t === 'dot') {
      // ".0" after seconds is a fraction of a second; otherwise a literal.
      const prev = out.at(-1);
      out.push(
        prev?.role === 'second'
          ? { role: 'fraction', s: '' }
          : { role: 'lit', s: '.' }
      );
    } else if (p.t === 'digit' && out.at(-1)?.role === 'fraction') {
      const prev = out.pop() as DatePiece;
      out.push({ role: 'fraction', s: `${prev.s}0` });
    } else if (p.t === 'lit') out.push({ role: 'lit', s: p.s });
    else if (p.t === 'percent') out.push({ role: 'lit', s: '%' });
    else if (p.t === 'comma') out.push({ role: 'lit', s: ',' });
  }
  return out;
}

/**
 * A number under a date or time section. Day, month and year all shown are
 * written YYYY-MM-DD, and an hour with its minutes HH:MM (HH:MM:SS with
 * seconds) on the 24-hour clock: the serial fixes their reading, so neither
 * can read two ways. Anything the format leaves out stays out: a format
 * without a year or a day, or an hour without its minutes, is written as
 * the format shows it ("3-Apr", "Apr-26", "7 PM"), and the format's own
 * words stay with it.
 */
function renderDate(
  list: readonly Piece[],
  value: number,
  date1904: boolean
): string | undefined {
  const pieces = datePieces(list);
  const iso = serialDate(value, date1904);
  if (iso === undefined) return undefined;
  const [y = 0, mo = 1, d = 1] = iso.split('-').map(Number);
  const totalSeconds =
    Math.round((value - Math.floor(value)) * 86_400) % 86_400;
  const fractionOfSecond = value * 86_400 - Math.floor(value * 86_400);
  const hour = Math.floor(totalSeconds / 3600);
  const minute = Math.floor((totalSeconds % 3600) / 60);
  const second = totalSeconds % 60;
  const twelve = pieces.some((p) => p.role === 'ampm');
  const weekday =
    iso === '1900-02-29'
      ? undefined
      : (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7;

  const roles = (rs: readonly DateRole[]) =>
    pieces.flatMap((p, i) => (rs.includes(p.role as DateRole) ? [i] : []));
  const dateCore = roles(['year', 'month', 'day']);
  const fullDate =
    pieces.some((p) => p.role === 'year') &&
    pieces.some((p) => p.role === 'month') &&
    pieces.some((p) => p.role === 'day');
  const timeCore = roles(['hour', 'minute', 'second', 'fraction', 'ampm']);
  const fullTime =
    pieces.some((p) => p.role === 'hour') &&
    pieces.some((p) => p.role === 'minute');
  const hasSeconds = pieces.some((p) => p.role === 'second');

  const elapsedTotal = Math.round(value * 86_400);
  const one = (p: DatePiece): string => {
    switch (p.role) {
      case 'lit':
        return p.s;
      case 'year':
        return p.s.length <= 2 ? pad(y % 100) : String(y);
      case 'month':
        if (p.s.length === 1) return String(mo);
        if (p.s.length === 2) return pad(mo);
        if (p.s.length === 3) return (MONTH_NAMES[mo - 1] ?? '').slice(0, 3);
        if (p.s.length === 4) return MONTH_NAMES[mo - 1] ?? '';
        return (MONTH_NAMES[mo - 1] ?? '').slice(0, 1);
      case 'day':
        return p.s.length === 1 ? String(d) : pad(d);
      case 'weekday': {
        const name = weekday === undefined ? '' : (DAY_NAMES[weekday] ?? '');
        return p.s.length === 3 ? name.slice(0, 3) : name;
      }
      case 'hour': {
        const h = twelve ? ((hour + 11) % 12) + 1 : hour;
        return p.s.length === 1 ? String(h) : pad(h);
      }
      case 'minute':
        return p.s.length === 1 ? String(minute) : pad(minute);
      case 'second':
        return p.s.length === 1 ? String(second) : pad(second);
      case 'fraction':
        return `.${fractionOfSecond.toFixed(p.s.length).slice(2)}`;
      case 'ampm': {
        const pm = hour >= 12;
        if (/^a\/p$/i.test(p.s)) {
          const letter = pm ? 'P' : 'A';
          return p.s[0] === 'a' ? letter.toLowerCase() : letter;
        }
        const word = pm ? 'PM' : 'AM';
        return p.s[0] === 'a' ? word.toLowerCase() : word;
      }
      case 'elapsed': {
        const c = p.s[0];
        const n =
          c === 'h'
            ? Math.floor(elapsedTotal / 3600)
            : c === 'm'
              ? Math.floor(elapsedTotal / 60)
              : elapsedTotal;
        return String(n).padStart(p.s.length, '0');
      }
    }
  };
  // Minutes and seconds after an elapsed count are within its unit.
  const elapsedFirst = pieces.find((p) => p.role === 'elapsed')?.s[0];

  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i] as DatePiece;
    if (fullDate && dateCore.length > 0 && i === dateCore[0]) {
      out += iso;
      i = dateCore.at(-1) as number;
      continue;
    }
    if (
      fullTime &&
      elapsedFirst === undefined &&
      timeCore.length > 0 &&
      i === timeCore[0]
    ) {
      out += hasSeconds
        ? `${pad(hour)}:${pad(minute)}:${pad(second)}`
        : `${pad(hour)}:${pad(minute)}`;
      i = timeCore.at(-1) as number;
      continue;
    }
    if (elapsedFirst === 'h' && p.role === 'minute') {
      out += pad(Math.floor((elapsedTotal % 3600) / 60));
      continue;
    }
    if (elapsedFirst !== undefined && p.role === 'second') {
      out += pad(elapsedTotal % 60);
      continue;
    }
    out += one(p);
  }
  return out;
}

/** Text under a format: its text section ("@" with the section's words), or as written. */
export function formatText(text: string, code: string): string {
  if (code.trim() === '') return text;
  const sections = splitSections(code);
  const section =
    sections.length >= 4
      ? sections[3]
      : sections.length === 1 &&
          pieces(sections[0] as string).some((p) => p.t === 'at')
        ? sections[0]
        : undefined;
  if (section === undefined) return text;
  let out = '';
  for (const p of pieces(section)) {
    if (p.t === 'at') out += text;
    else if (p.t === 'lit') out += p.s;
  }
  return out;
}

/**
 * The text Excel shows for a number under a format code: the section that
 * applies (positive, negative, zero, or by condition), with its own words,
 * symbols and sign. An empty section shows nothing (";;;" hides a value).
 */
export function formatNumber(
  value: number,
  code: string,
  date1904 = false
): string {
  if (code.trim() === '') return generalNumber(value);
  const picked = sectionFor(splitSections(code), value);
  if (picked === undefined) return generalNumber(value);
  const { section, ownSign } = picked;
  if (section.trim() === '') return '';
  const kind = sectionKind(section);
  const list = pieces(section);
  switch (kind) {
    case 'general':
    case 'text':
      return ownSign ? generalNumber(Math.abs(value)) : generalNumber(value);
    case 'date':
    case 'time':
    case 'datetime':
    case 'elapsed':
      return (renderDate(list, value, date1904) ?? generalNumber(value)).trim();
    case 'number':
      // Padding ("_)", "?") at either end is not text.
      return renderNumber(list, value, ownSign).trim();
  }
}

/** Zero-based column index of a cell reference's letters ("AB12" → 27). */
export function columnIndex(ref: string): number | undefined {
  const m = /^([A-Z]{1,3})(\d+)$/i.exec(ref.trim());
  if (!m) return undefined;
  let n = 0;
  for (const ch of (m[1] as string).toUpperCase())
    n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function rowIndex(ref: string): number | undefined {
  const m = /^[A-Z]{1,3}(\d+)$/i.exec(ref.trim());
  return m ? Number.parseInt(m[1] as string, 10) - 1 : undefined;
}

function isTrue(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

/** The visible text of a shared or inline string: its runs, without phonetic guides. */
function stringText(node: XNode): string {
  let out = '';
  for (const c of elements(node)) {
    if (c.name === 't' || localName(c.name) === 't') out += textOf(c);
    else if (localName(c.name) === 'r') out += stringText(c);
  }
  return out;
}

interface Workbook {
  readonly sheets: readonly { name: string; path: string }[];
  readonly date1904: boolean;
  readonly strings: readonly string[];
  readonly formats: readonly string[];
}

function readWorkbook(zip: ZipArchive, limits: Limits): Workbook {
  const relsText = zip.readText('_rels/.rels');
  let workbookPath = 'xl/workbook.xml';
  if (relsText !== undefined) {
    const rels = parseXml(relsText, limits.xmlDepth, limits.xmlElements);
    for (const rel of elements(rels)) {
      if ((attr(rel, 'Type') ?? '').endsWith('/officeDocument')) {
        workbookPath = resolvePart('', attr(rel, 'Target') ?? workbookPath);
      }
    }
  }
  const wbText = zip.readText(workbookPath);
  if (wbText === undefined)
    throw new ExtractError('damaged', 'The Excel file has no workbook part.');
  const wb = parseXml(wbText, limits.xmlDepth, limits.xmlElements);
  const folder = workbookPath.slice(0, workbookPath.lastIndexOf('/') + 1);
  const workbookPr =
    child(wb, 'workbookPr') ??
    elements(wb).find((e) => localName(e.name) === 'workbookPr');
  const date1904 = workbookPr ? isTrue(attr(workbookPr, 'date1904')) : false;

  const targets = new Map<string, { type: string; target: string }>();
  const relsPath = `${folder}_rels/${workbookPath.slice(folder.length)}.rels`;
  const wbRels = zip.readText(relsPath);
  if (wbRels !== undefined) {
    for (const rel of elements(
      parseXml(wbRels, limits.xmlDepth, limits.xmlElements)
    )) {
      const id = attr(rel, 'Id');
      const target = attr(rel, 'Target');
      if (
        id === undefined ||
        target === undefined ||
        attr(rel, 'TargetMode') === 'External'
      )
        continue;
      targets.set(id, {
        type: attr(rel, 'Type') ?? '',
        target: resolvePart(folder, target),
      });
    }
  }

  const sheets: { name: string; path: string }[] = [];
  const sheetsNode = elements(wb).find((e) => localName(e.name) === 'sheets');
  for (const s of sheetsNode ? elements(sheetsNode) : []) {
    if (localName(s.name) !== 'sheet') continue;
    const state = attr(s, 'state');
    if (state === 'hidden' || state === 'veryHidden') continue;
    const id = attr(s, 'r:id');
    const rel = id !== undefined ? targets.get(id) : undefined;
    if (!rel || !rel.type.endsWith('/worksheet')) continue;
    sheets.push({ name: attr(s, 'name') ?? '', path: rel.target });
  }

  const strings: string[] = [];
  const sharedRel = [...targets.values()].find((t) =>
    t.type.endsWith('/sharedStrings')
  );
  const sst = zip.readText(sharedRel?.target ?? `${folder}sharedStrings.xml`);
  if (sst !== undefined) {
    for (const si of elements(
      parseXml(sst, limits.xmlDepth, limits.xmlElements)
    )) {
      if (localName(si.name) === 'si') strings.push(stringText(si));
    }
  }

  const formats: string[] = [];
  const stylesRel = [...targets.values()].find((t) =>
    t.type.endsWith('/styles')
  );
  const stylesText = zip.readText(stylesRel?.target ?? `${folder}styles.xml`);
  if (stylesText !== undefined) {
    const styles = parseXml(stylesText, limits.xmlDepth, limits.xmlElements);
    const custom = new Map<number, string>();
    const numFmts = elements(styles).find(
      (e) => localName(e.name) === 'numFmts'
    );
    for (const f of numFmts ? elements(numFmts) : []) {
      const id = Number.parseInt(attr(f, 'numFmtId') ?? '', 10);
      const code = attr(f, 'formatCode');
      if (Number.isInteger(id) && code !== undefined) custom.set(id, code);
    }
    const cellXfs = elements(styles).find(
      (e) => localName(e.name) === 'cellXfs'
    );
    for (const xf of cellXfs ? elements(cellXfs) : []) {
      const id = Number.parseInt(attr(xf, 'numFmtId') ?? '0', 10);
      formats.push(
        custom.get(id) ?? builtinFormat(Number.isInteger(id) ? id : 0)
      );
    }
  }
  return { sheets, date1904, strings, formats };
}

/** The serial of an ISO date or date and time, in the workbook's date system. */
function isoSerial(raw: string, date1904: boolean): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(
    raw
  );
  if (!m) return undefined;
  const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(day)) return undefined;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const days = Math.round((day - epoch) / DAY_MS);
  // Before 1 March 1900 Excel's 1900 system counts one day fewer.
  const serial = !date1904 && days < 61 ? days - 1 : days;
  const seconds =
    Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0);
  return serial < 0 ? undefined : serial + seconds / 86_400;
}

function cellValue(c: XNode, wb: Workbook): TableCell | undefined {
  const type = attr(c, 't') ?? 'n';
  const v = child(c, 'v') ?? elements(c).find((e) => localName(e.name) === 'v');
  const raw = v ? textOf(v) : undefined;
  const style = Number.parseInt(attr(c, 's') ?? '0', 10);
  const code = wb.formats[Number.isInteger(style) ? style : 0] ?? 'General';
  switch (type) {
    case 's': {
      const index = Number.parseInt(raw ?? '', 10);
      const text = Number.isInteger(index) ? wb.strings[index] : undefined;
      return text === undefined ? undefined : cell(formatText(text, code));
    }
    case 'inlineStr': {
      const is =
        child(c, 'is') ?? elements(c).find((e) => localName(e.name) === 'is');
      return is ? cell(formatText(stringText(is), code)) : undefined;
    }
    case 'str':
      return raw === undefined ? undefined : cell(formatText(raw, code));
    case 'e':
      return raw === undefined ? undefined : cell(raw);
    case 'b':
      return raw === undefined
        ? undefined
        : cell(raw === '1' ? 'TRUE' : 'FALSE');
    case 'd': {
      if (raw === undefined) return undefined;
      const kind = parseFormat(code).kind;
      const serial = isoSerial(raw, wb.date1904);
      if (
        serial === undefined ||
        kind === 'general' ||
        kind === 'text' ||
        kind === 'number'
      )
        return cell(raw, true);
      return cell(formatNumber(serial, code, wb.date1904), true);
    }
    default: {
      if (raw === undefined || raw.trim() === '') return undefined;
      const value = Number(raw);
      if (!Number.isFinite(value)) return cell(raw);
      return cell(formatNumber(value, code, wb.date1904), true);
    }
  }
}

interface Merge {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

function parseMerge(ref: string): Merge | undefined {
  const [a, b] = ref.split(':');
  if (a === undefined || b === undefined) return undefined;
  const left = columnIndex(a);
  const right = columnIndex(b);
  const top = rowIndex(a);
  const bottom = rowIndex(b);
  if (
    left === undefined ||
    right === undefined ||
    top === undefined ||
    bottom === undefined
  ) {
    return undefined;
  }
  return { top, bottom, left, right };
}

function sheetLines(
  xml: string,
  wb: Workbook,
  limits: Limits,
  counter: { cells: number }
): string[] {
  const root = parseXml(xml, limits.xmlDepth, limits.xmlElements);
  const hiddenColumns = new Set<number>();
  const cols = elements(root).find((e) => localName(e.name) === 'cols');
  for (const col of cols ? elements(cols) : []) {
    const width = attr(col, 'width');
    const hidden =
      isTrue(attr(col, 'hidden')) ||
      (width !== undefined && Number(width) === 0);
    if (!hidden) continue;
    const min = Number.parseInt(attr(col, 'min') ?? '', 10);
    const max = Number.parseInt(attr(col, 'max') ?? '', 10);
    if (!Number.isInteger(min) || !Number.isInteger(max)) continue;
    for (let c = Math.max(1, min); c <= Math.min(max, 16_384); c++)
      hiddenColumns.add(c - 1);
  }

  const grid = new Map<number, Map<number, TableCell>>();
  const hiddenRows = new Set<number>();
  const data = elements(root).find((e) => localName(e.name) === 'sheetData');
  let nextRow = 0;
  for (const row of data ? elements(data) : []) {
    if (localName(row.name) !== 'row') continue;
    const r = Number.parseInt(attr(row, 'r') ?? '', 10);
    const index = Number.isInteger(r) && r > 0 ? r - 1 : nextRow;
    nextRow = index + 1;
    const height = attr(row, 'ht');
    if (
      isTrue(attr(row, 'hidden')) ||
      (isTrue(attr(row, 'customHeight')) &&
        height !== undefined &&
        Number(height) === 0)
    ) {
      hiddenRows.add(index);
      continue;
    }
    let nextColumn = 0;
    for (const c of elements(row)) {
      if (localName(c.name) !== 'c') continue;
      const ref = attr(c, 'r');
      const column =
        (ref !== undefined ? columnIndex(ref) : undefined) ?? nextColumn;
      nextColumn = column + 1;
      if (hiddenColumns.has(column)) continue;
      const value = cellValue(c, wb);
      if (!value || value.lines.length === 0) continue;
      counter.cells++;
      if (counter.cells > limits.maxCells) {
        throw new ExtractError(
          'too_many_cells',
          `The spreadsheet has more than ${limits.maxCells.toLocaleString('en-GB')} filled cells, so it is not read.`
        );
      }
      let cells = grid.get(index);
      if (!cells) {
        cells = new Map();
        grid.set(index, cells);
      }
      cells.set(column, value);
    }
  }

  const merges = elements(root).find((e) => localName(e.name) === 'mergeCells');
  for (const m of merges
    ? elements(merges).filter((e) => localName(e.name) === 'mergeCell')
    : []) {
    const range = parseMerge(attr(m, 'ref') ?? '');
    if (!range || range.bottom - range.top > 1000) continue;
    const value = grid.get(range.top)?.get(range.left);
    if (!value) continue;
    for (let r = range.top + 1; r <= range.bottom; r++) {
      if (hiddenRows.has(r)) continue;
      let cells = grid.get(r);
      if (!cells) {
        cells = new Map();
        grid.set(r, cells);
      }
      if (!cells.has(range.left)) cells.set(range.left, value);
    }
  }

  const rowNumbers = [...grid.keys()].sort((a, b) => a - b);
  const used = new Set<number>();
  for (const r of rowNumbers)
    for (const c of grid.get(r)?.keys() ?? []) used.add(c);
  const columns = [...used].sort((a, b) => a - b);
  const rows: TableRow[] = rowNumbers.map((r) => {
    const cells = grid.get(r) as Map<number, TableCell>;
    return columns.map((c) => cells.get(c));
  });
  return inferredTableLines(rows);
}

const DEFAULT_SHEET = /^(sheet|feuil|tabelle|hoja|foglio|blad)\s*\d+$/i;

/** One page per visible sheet, in workbook order. */
export function xlsxPages(zip: ZipArchive, limits: Limits): TextPage[] {
  const wb = readWorkbook(zip, limits);
  const counter = { cells: 0 };
  const pages: TextPage[] = [];
  for (const sheet of wb.sheets) {
    const xml = zip.readText(sheet.path);
    if (xml === undefined) continue;
    const lines = sheetLines(xml, wb, limits, counter);
    const name = sheet.name.trim();
    const withName =
      name !== '' && !DEFAULT_SHEET.test(name) ? [name, ...lines] : lines;
    pages.push({ page: pages.length + 1, kind: 'text', lines: withName });
  }
  if (pages.length === 0) pages.push({ page: 1, kind: 'text', lines: [] });
  return pages;
}
