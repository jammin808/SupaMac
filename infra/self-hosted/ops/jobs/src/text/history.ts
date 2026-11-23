// Quoted history and forwarded messages inside an email body
// (docs/supamac/jobs.md §2: they "become pages of their own, each with its own
// date").
//
// Invariants:
// - A body splits into its own text and history segments, in reading order.
//   A segment starts at a forward marker ("---------- Forwarded message
//   ---------", "Begin forwarded message:", "-----Original Message-----", an
//   Outlook rule of underscores) followed by a header block, at an Outlook
//   header block (From: with Sent: or Date: and Subject:), at an attribution
//   ("On <date>, <sender> wrote:"), or at ">" quoting.
// - A forwarded or Outlook-quoted message runs to the end of the body; a ">"
//   block runs while its lines are quoted, and the body's text after it is
//   the body's own again. Quoting is removed one level per segment, and each
//   segment is split again, so nested history becomes later segments.
// - A segment's lines keep its marker, header and attribution lines, as
//   written: they are the source's text.
// - A segment's date is written in its header or attribution: exactly one
//   whole date (day, month and year) that reads one way, with a weekday, if
//   given, that agrees. A numeric date that could read two ways (03/04/2026),
//   one with a two-digit year, or one with no year gives no date; nothing is
//   filled in. When one time with a numeric zone (or GMT, UTC, Z) is written
//   with it, the date is an ISO instant that keeps the written date, time and
//   offset ("2026-04-03T00:30:00+01:00"; UTC as "…T09:00:00.000Z"), so its
//   first ten characters are the day the writer meant; otherwise it is an
//   ISO date. A zone named by letters other than GMT and UTC (BST, CET) is not
//   read. Its sender is the header's From value, or the attribution's words
//   after its date and time.
// - An "On … wrote:" line starts history when quoted (">") lines follow it, or,
//   with unquoted text after it, only when it names a date or a time; any
//   other such line is the body's own text.
// - Only Gmail's and Apple Mail's markers say "forwarded"; Outlook's say
//   nothing either way, and the email's subject decides (email.ts).

import { type DateParts, partsIso, scanLine, weekdayOf } from '../parse';

export interface Segment {
  readonly lines: readonly string[];
  readonly history: boolean;
  /** Introduced by a marker that says the message was forwarded. */
  readonly forward: boolean;
  /** Introduced by a header block (From/Sent/Subject), forwarded or quoted. */
  readonly headed: boolean;
  readonly from?: string | undefined;
  readonly date?: string | undefined;
}

const FORWARD_MARKER =
  /^\s*(?:-{2,}\s*forwarded message\s*-{2,}|begin forwarded message\s*:?)\s*$/i;
const QUOTE_MARKER = /^\s*(?:-{2,}\s*original message\s*-{2,}|_{10,})\s*$/i;
const HEADER =
  /^\s*\*?(from|sent|date|to|cc|bcc|subject|reply-to)\s*\*?\s*:\s*(.*)$/i;
const ONE_LINE_HEADER =
  /^\s*From:\s*(.+?)\s+(?:Sent|Date):\s*(.+?)\s+(?:To:\s*.+?\s+)?Subject:\s*(.*)$/i;
const ATTRIBUTION = /^\s*On\s.+\swrote\s*:?\s*$/i;
const MAX_DEPTH = 20;

interface Header {
  readonly fields: ReadonlyMap<string, string>;
  /** The index after the header block. */
  readonly end: number;
}

/** Reads the header block starting at `start`, skipping blank lines before it. */
function readHeader(lines: readonly string[], start: number): Header {
  let i = start;
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++;
  const fields = new Map<string, string>();
  const one = ONE_LINE_HEADER.exec(lines[i] ?? '');
  if (one) {
    fields.set('from', (one[1] ?? '').trim());
    fields.set('date', (one[2] ?? '').trim());
    fields.set('subject', (one[3] ?? '').trim());
    return { fields, end: i + 1 };
  }
  while (i < lines.length) {
    const m = HEADER.exec(lines[i] ?? '');
    if (!m) break;
    const key =
      (m[1] ?? '').toLowerCase() === 'sent'
        ? 'date'
        : (m[1] ?? '').toLowerCase();
    if (!fields.has(key)) fields.set(key, (m[2] ?? '').trim());
    i++;
  }
  return { fields, end: i };
}

function isOutlookBlock(header: Header): boolean {
  return (
    header.fields.has('from') &&
    header.fields.has('date') &&
    header.fields.has('subject')
  );
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * A written date and time with the offset it was written in, as an ISO
 * instant that keeps all three: `…Z` for a zero offset, else `…±HH:MM`.
 * Undefined when a part is out of range.
 */
export function zonedInstant(
  date: string,
  hour: number,
  minute: number,
  second: number,
  offsetMinutes: number
): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59 ||
    !Number.isInteger(second) ||
    second < 0 ||
    second > 59 ||
    !Number.isInteger(offsetMinutes) ||
    Math.abs(offsetMinutes) > 14 * 60
  ) {
    return undefined;
  }
  const time = `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
  if (offsetMinutes === 0) return `${date}T${time}.000Z`;
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${date}T${time}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** The ISO date of parts that read one way only, or undefined. */
function oneWayDate(parts: DateParts): string | undefined {
  if (parts.ambiguous) return undefined;
  if (parts.twoDigitYear && !parts.monthInWords) return undefined;
  const iso = partsIso(parts);
  if (iso === undefined) return undefined;
  if (
    parts.weekday !== undefined &&
    parts.year !== undefined &&
    parts.month !== undefined &&
    parts.day !== undefined &&
    weekdayOf(parts.year, parts.month, parts.day) !== parts.weekday
  ) {
    return undefined;
  }
  return iso;
}

const ZONED_TIME =
  /(?<![\d:.])(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:\s*([ap])\.?\s?m\b\.?)?(?:\s*(?:GMT|UTC|UT)\s*([+-])(\d{2}):?(\d{2})|\s+([+-])(\d{2}):?(\d{2})|\s*(GMT|UTC|UT|Z))(?![\w:])/gi;

/** The one time written with a zone, as 24-hour parts and an offset in minutes. */
function zonedTime(
  text: string
):
  | { hour: number; minute: number; second: number; offset: number }
  | undefined {
  const found = [...text.matchAll(ZONED_TIME)];
  if (found.length !== 1) return undefined;
  const m = found[0] as RegExpMatchArray;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = m[3] === undefined ? 0 : Number(m[3]);
  const meridiem = m[4]?.toLowerCase();
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
  }
  const sign = m[5] ?? m[8];
  const offset =
    sign === undefined
      ? 0
      : (sign === '-' ? -1 : 1) *
        (Number(m[6] ?? m[9]) * 60 + Number(m[7] ?? m[10]));
  return { hour, minute, second, offset };
}

/** The date a header or attribution writes, as the invariants above allow. */
export function writtenDate(text: string): string | undefined {
  const dates = scanLine(text).dates.filter((d) => d.parts.year !== undefined);
  if (dates.length !== 1) return undefined;
  const iso = oneWayDate((dates[0] as (typeof dates)[number]).parts);
  if (iso === undefined) return undefined;
  const time = zonedTime(text);
  if (time === undefined) return iso;
  return (
    zonedInstant(iso, time.hour, time.minute, time.second, time.offset) ?? iso
  );
}

const RFC_ZONES: Readonly<Record<string, number>> = {
  UT: 0,
  GMT: 0,
  Z: 0,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
};

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

const RFC_DATE =
  /^\s*(?:[A-Za-z]{3,9}\s*,\s*)?(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:([+-])(\d{2})(\d{2})|([A-Za-z]{1,3}))?\s*(?:\(.*\))?\s*$/;

/**
 * A message's Date header (RFC 5322 §3.3, obsolete zones included) as an ISO
 * instant that keeps its written date, time and offset; a header that is not
 * in that form is read as `writtenDate` reads a forward's, and never by
 * guessing.
 */
export function headerDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const m = RFC_DATE.exec(value);
  if (!m) return writtenDate(value);
  const day = Number(m[1]);
  const month = MONTHS.indexOf((m[2] ?? '').slice(0, 3).toLowerCase()) + 1;
  let year = Number(m[3]);
  if ((m[3] ?? '').length === 2) year += year < 50 ? 2000 : 1900;
  else if ((m[3] ?? '').length === 3) year += 1900;
  if (month === 0) return undefined;
  const iso = partsIso({
    day,
    month,
    year,
    monthInWords: true,
    numeric: false,
    ambiguous: false,
    twoDigitYear: false,
    shared: [],
  });
  if (iso === undefined) return undefined;
  const offset =
    m[7] !== undefined
      ? (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]))
      : m[10] !== undefined
        ? RFC_ZONES[m[10].toUpperCase()]
        : undefined;
  // No zone, or one the RFC leaves unknown (a military letter): the date only.
  if (offset === undefined) return iso;
  return (
    zonedInstant(
      iso,
      Number(m[4]),
      Number(m[5]),
      m[6] === undefined ? 0 : Number(m[6]),
      offset
    ) ?? iso
  );
}

const TIME_OR_YEAR =
  /\d{1,2}[:.]\d{2}(?::\d{2})?(?:\s*[ap]\.?\s?m\.?)?|\b\d{4}\b/gi;

/** The sender an attribution names: its words after its last time or year. */
export function attributionSender(text: string): string | undefined {
  const body = text.replace(/^\s*On\s+/i, '').replace(/\s*wrote\s*:?\s*$/i, '');
  let end = -1;
  for (const m of body.matchAll(TIME_OR_YEAR))
    end = (m.index ?? 0) + m[0].length;
  if (end === -1) return undefined;
  const sender = body
    .slice(end)
    .replace(/^[\s,]+/, '')
    .trim();
  return sender === '' ? undefined : sender;
}

/** An attribution at `i`, possibly wrapped over up to three lines. */
function attributionAt(
  lines: readonly string[],
  i: number
): { text: string; span: number } | undefined {
  const first = lines[i] ?? '';
  if (!/^\s*On\s/i.test(first)) return undefined;
  let text = first;
  for (let span = 1; span <= 3; span++) {
    if (text.length <= 400 && ATTRIBUTION.test(text)) return { text, span };
    const next = lines[i + span];
    if (next === undefined || next.trim() === '' || /^\s*>/.test(next))
      return undefined;
    text = `${text} ${next.trim()}`;
  }
  return undefined;
}

/** Whether an attribution names a time, or a date with its day and month. */
function namesWhen(text: string): boolean {
  if (/\d{1,2}[:.]\d{2}/.test(text)) return true;
  return scanLine(text).dates.some(
    (d) => d.parts.day !== undefined && d.parts.month !== undefined
  );
}

const isQuoted = (line: string | undefined): boolean =>
  line !== undefined && /^\s*>/.test(line);

/** The end of the ">" block starting at `start` (blank lines inside it allowed). */
function quoteEnd(lines: readonly string[], start: number): number {
  let i = start;
  while (i < lines.length) {
    if (isQuoted(lines[i])) {
      i++;
      continue;
    }
    if ((lines[i] ?? '').trim() === '') {
      let j = i;
      while (j < lines.length && (lines[j] ?? '').trim() === '') j++;
      if (isQuoted(lines[j])) {
        i = j;
        continue;
      }
    }
    break;
  }
  return i;
}

const dequote = (line: string): string => line.replace(/^\s*>\s?/, '');

const nonBlank = (lines: readonly string[]): string[] =>
  lines.filter((l) => l.trim() !== '');

/** Splits a message body into its own text (first) and its history segments. */
export function splitHistory(lines: readonly string[], depth = 0): Segment[] {
  const own: string[] = [];
  const history: Segment[] = [];

  // A nested message: its own text joins the opening lines of its segment.
  const nested = (
    opening: readonly string[],
    body: readonly string[],
    fields: Omit<Segment, 'lines' | 'history'>
  ): void => {
    const parts = depth < MAX_DEPTH ? splitHistory(body, depth + 1) : [];
    const ownText = parts[0]?.lines ?? body;
    history.push({
      ...fields,
      history: true,
      lines: nonBlank([...opening, ...ownText]),
    });
    history.push(...parts.slice(1));
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    const forward = FORWARD_MARKER.test(line);
    if (forward || QUOTE_MARKER.test(line)) {
      const header = readHeader(lines, i + 1);
      if (header.fields.size > 0) {
        nested(lines.slice(i, header.end), lines.slice(header.end), {
          forward,
          headed: true,
          from: header.fields.get('from'),
          date: writtenDate(header.fields.get('date') ?? ''),
        });
        break;
      }
    }

    if (/^\s*\*?From\s*\*?\s*:/i.test(line)) {
      const header = readHeader(lines, i);
      if (isOutlookBlock(header)) {
        nested(lines.slice(i, header.end), lines.slice(header.end), {
          forward: false,
          headed: true,
          from: header.fields.get('from'),
          date: writtenDate(header.fields.get('date') ?? ''),
        });
        break;
      }
    }

    const attribution = attributionAt(lines, i);
    if (attribution) {
      const opening = lines.slice(i, i + attribution.span);
      const fields = {
        forward: false,
        headed: false,
        from: attributionSender(attribution.text),
        date: writtenDate(attribution.text),
      };
      let k = i + attribution.span;
      while (k < lines.length && (lines[k] ?? '').trim() === '') k++;
      if (isQuoted(lines[k])) {
        const end = quoteEnd(lines, k);
        nested(opening, lines.slice(k, end).map(dequote), fields);
        i = end;
        continue;
      }
      if (namesWhen(attribution.text)) {
        nested(opening, lines.slice(i + attribution.span), fields);
        break;
      }
    }

    if (isQuoted(line)) {
      const end = quoteEnd(lines, i);
      nested([], lines.slice(i, end).map(dequote), {
        forward: false,
        headed: false,
      });
      i = end;
      continue;
    }

    own.push(line);
    i++;
  }

  return [
    { lines: nonBlank(own), history: false, forward: false, headed: false },
    ...history.filter((s) => s.lines.length > 0),
  ];
}

/** The address inside a From value ("Jo Bloggs <jo@example.com>" → jo@example.com). */
export function addressOf(from: string | undefined): string | undefined {
  if (from === undefined) return undefined;
  const angled = /<\s*([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)\s*>/.exec(from);
  const bare =
    angled ?? /([^\s<>()[\]"',;:@]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(from);
  const address = bare?.[1]?.replace(/^mailto:/i, '');
  return address === undefined ? undefined : address.toLowerCase();
}
