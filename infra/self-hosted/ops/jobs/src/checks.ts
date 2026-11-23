// The four checks every detail passes before it is Found (docs/supamac/jobs.md §4).
//
// They run against the service's own extracted text, never the model's word:
// 1. The quote is on the page it names (a source with several pages must
//    name one), once, or with the same outcome at every occurrence. It holds
//    a label word and the value.
// 2. The quote holds a label word for the field, outside the value: from the
//    field's lexicon, or the model's own label for Other. The label must name
//    this field alone: one that sits inside a longer label of another field
//    ("ref" of "booking ref"), one another field of the same value kind also
//    uses ("address"), or one a typed field uses when the value is only that
//    field's kind ("Show 19:30" as an Event) does not. A label the model
//    gives for any field must also be in the quote, because it scopes
//    replacement (derive.ts).
// 3. The value is in the quote and nothing more. A text value is one
//    contiguous run of the quote's terms. A typed value is parsed from the
//    value and from the source line, and the two agree component by
//    component; the quote holds exactly one entity of the kind, whole. A
//    hedge or negation on the quote's line that the value leaves out needs
//    review, and so do tax words in the quote an amount leaves out. A
//    component the value has and the quote lacks is allowed only when the
//    same page writes that very date in full, once, and is named ("year from
//    p1").
// 4. The day is written: a date in the quote, or `day_quote` as the nearest
//    date heading above the quote on the same page, with no other date and
//    no relative day ("Day 2", "show day") between. A heading is a line that
//    holds the date and nothing but heading words ("DAY 1 - FRI 12 MARCH",
//    "Call sheet: Sat 13th"); "Invoice date: 3 March 2027" is not one. A
//    relative day needs review, with the calculation shown as one.
//
// Choices where the design is silent, each the more cautious one:
// - Quotes are matched term by term (normalize.ts): punctuation is ignored,
//   symbols (£ + / & …) are not. Entities are parsed from the source line,
//   not the model's copy, so an entity the quote cuts short ("£350" of
//   "£350 per day") fails.
// - Hedges are looked for on the quote's whole line, not only inside the
//   quote, and a "?" or "~" counts as one; a line is the unit the source
//   writes, so a trailing "TBC" in a second sentence still counts.
// - A completion is taken only from a full date on the page that is the
//   written date itself (same day, and the weekday if written), and only
//   when exactly one such date is written; an unrelated full date (an issue
//   date) never supplies a month or year.
// - An ambiguous numeric date is settled only by the same day and month in
//   words whose year, if both write one, is the same.
// - A source with no pages is read as one scan: no text was checked.
// - "Day N" and named days ("show day") beside a written date are labels; any
//   other relative day, or one with no date beside it, needs review.
// - A typed value must keep every component its quote's entity writes:
//   currency, basis and tax words, am/pm. Leaving one out needs review.
// - Several occurrences of the quote on its page pass only if every one
//   passes with the same value and day.

import { format, parseISO } from 'date-fns';
import {
  type CandidateDetail,
  type CheckedStatus,
  FIELDS,
  type FieldName,
  HEDGE_WORDS,
  isCalendarDate,
  isTypedKind,
  type PageKind,
  type SourceText,
  type TextPage,
  type TypedKind,
  type ValueKind,
} from './model';
import {
  findRuns,
  hasLineBreak,
  splitLines,
  type Token,
  termsOf,
  terms as termsOfTokens,
} from './normalize';
import {
  type AmountEntity,
  amountKey,
  type DateEntity,
  type DateParts,
  type DateRangeEntity,
  effectiveAmounts,
  isoDate,
  type LineScan,
  partsIso,
  PRE_TAX_WORDS,
  partsKey,
  type ReferenceEntity,
  type RelativeDay,
  scanLine,
  type TimeEntity,
  taxOf,
  timeKey,
  weekdayOf,
} from './parse';

export type CheckNumber = 1 | 2 | 3 | 4;

export type FailureCode =
  | 'no_quote'
  | 'quote_spans_lines'
  | 'page_missing'
  | 'page_unknown'
  | 'quote_not_on_page'
  | 'quote_repeats_differently'
  | 'scan_page'
  | 'page_unsure'
  | 'no_label'
  | 'label_only_in_value'
  | 'label_names_other_field'
  | 'label_spans_lines'
  | 'model_label_not_in_quote'
  | 'no_other_label'
  | 'no_value'
  | 'value_spans_lines'
  | 'value_not_in_quote'
  | 'value_words_not_in_quote'
  | 'hedge_left_out'
  | 'value_not_parsed'
  | 'value_several'
  | 'quote_none'
  | 'quote_several'
  | 'quote_cut_short'
  | 'disagree'
  | 'not_written'
  | 'left_out'
  | 'ambiguous_date'
  | 'ambiguous_number'
  | 'unknown_suffix'
  | 'weekday_disagrees'
  | 'day_invalid'
  | 'day_not_written'
  | 'day_quote_not_found'
  | 'day_quote_several_dates'
  | 'day_quote_not_heading'
  | 'date_between'
  | 'quote_dates_several'
  | 'relative_day';

export interface Finding {
  readonly check: CheckNumber;
  readonly text: string;
}

export interface Failure extends Finding {
  readonly code: FailureCode;
}

export interface CheckResult {
  readonly status: CheckedStatus;
  readonly passed: readonly Finding[];
  readonly failed: readonly Failure[];
  /** Components the page states in full and the value uses ("year from p1"). */
  readonly completions: readonly string[];
  readonly page?: number | undefined;
  readonly pageKind?: PageKind | undefined;
  /** The history page's own date, for a detail from quoted history. */
  readonly historyDate?: string | undefined;
  /**
   * The label that scopes replacement, as `scopeLabel(field, label, quote)`
   * gives it: the model's, else the longest lexicon label in the quote.
   */
  readonly label: string;
  /** The day, when check 4 found it written. */
  readonly day?: string | undefined;
  /** The Check column's text. */
  readonly text: string;
}

/** The Check text of a detail read from an image or scan. */
export const SCAN_TEXT = 'read by the model from an image; no text was checked';

const KIND_NAMES: Readonly<Record<TypedKind, string>> = {
  date: 'date',
  date_range: 'date or date range',
  time: 'time',
  amount: 'amount',
  reference: 'reference',
};

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Nouns a number follows, so "no" between them is "number" ("PO no 4500123"). */
const NUMBERED_NOUNS = new Set([
  'po',
  'p.o',
  'p/o',
  'order',
  'job',
  'booking',
  'invoice',
  'inv',
  'supplier',
  'vendor',
  'account',
  'acct',
  'ref',
  'reference',
  'conf',
  'confirmation',
  'reservation',
  'project',
  'quote',
  'room',
  'seat',
  'coach',
  'carriage',
  'platform',
  'gate',
  'dock',
  'unit',
  'door',
  'flight',
  'train',
  'ticket',
  'member',
  'customer',
  'policy',
  'registration',
  'reg',
  'vat',
  'company',
  'item',
  'stand',
  'pitch',
  'bay',
]);

/** Words a date heading may hold beside its date and day label. */
const HEADING_WORDS = new Set([
  'day',
  'date',
  'schedule',
  'timings',
  'times',
  'itinerary',
  'programme',
  'program',
  'running',
  'order',
  'call',
  'sheet',
  'callsheet',
  'call-sheet',
  'week',
]);

/** Terms of the quote that are tax words an amount must keep. */
const TAX_TERMS = new Set([
  'vat',
  'v.a.t',
  'tax',
  'taxes',
  'gst',
  'net',
  'gross',
]);

const HEDGE_PHRASES: readonly string[][] = HEDGE_WORDS.map(termsOf)
  .filter((p) => p.length > 0)
  .sort((a, b) => b.length - a.length);

/** Lexicon phrases as terms, longest first, per field. */
const LEXICON: Readonly<Record<FieldName, readonly string[][]>> =
  Object.fromEntries(
    Object.values(FIELDS).map((spec) => [
      spec.name,
      spec.labels
        .map(termsOf)
        .filter((p) => p.length > 0)
        .sort((a, b) => b.length - a.length),
    ])
  ) as Record<FieldName, string[][]>;

/** The fields each lexicon phrase is a label of. */
const PHRASE_FIELDS: ReadonlyMap<string, readonly FieldName[]> = (() => {
  const map = new Map<string, FieldName[]>();
  for (const spec of Object.values(FIELDS)) {
    for (const phrase of LEXICON[spec.name]) {
      const key = phrase.join(' ');
      map.set(key, [...(map.get(key) ?? []), spec.name]);
    }
  }
  return map;
})();

type KindGroup = 'text' | 'date' | 'time' | 'amount' | 'reference';

/** Fields whose values read alike: text and contacts, dates and ranges. */
function kindGroup(kind: ValueKind): KindGroup {
  if (kind === 'text' || kind === 'contact') return 'text';
  if (kind === 'date_range') return 'date';
  return kind;
}

/** "Sat 13 Mar 2027"; text that is not a calendar date is returned as it is. */
export function formatDay(iso: string): string {
  if (!isCalendarDate(iso)) return iso;
  return format(parseISO(iso), 'EEE d MMM yyyy');
}

function quoted(text: string): string {
  return `'${text}'`;
}

// ---------------------------------------------------------------------------
// The source, indexed once per source.

interface LineView {
  readonly scan: LineScan;
  readonly terms: readonly Token[];
  readonly texts: readonly string[];
}

interface PageView {
  readonly page: TextPage;
  readonly lines: readonly LineView[];
  /** Full, unambiguous dates written on the page. */
  readonly fullDates: readonly { year: number; month: number; day: number }[];
}

export interface SourceIndex {
  readonly text: SourceText;
  readonly pages: readonly PageView[];
  /** Dates written with the month in words anywhere in the source. */
  readonly worded: readonly {
    day: number;
    month: number;
    year?: number | undefined;
    page: number;
  }[];
}

function lineView(line: string): LineView {
  const scan = scanLine(line);
  const terms = termsOfTokens(scan.tokens);
  return { scan, terms, texts: terms.map((t) => t.text) };
}

/** Indexes a source's text for checking; build once, check every detail. */
export function indexSource(text: SourceText): SourceIndex {
  const worded: {
    day: number;
    month: number;
    year?: number | undefined;
    page: number;
  }[] = [];
  const pages = text.pages.map((page): PageView => {
    const lines =
      page.kind === 'scan' ? [] : page.lines.flatMap(splitLines).map(lineView);
    const fullDates: { year: number; month: number; day: number }[] = [];
    for (const line of lines) {
      const parts = [
        ...line.scan.dates.map((d) => d.parts),
        ...line.scan.ranges.flatMap((r) => [r.from, r.to]),
      ];
      for (const p of parts) {
        const iso = p.ambiguous ? undefined : partsIso(p);
        if (iso !== undefined) {
          fullDates.push({
            year: p.year as number,
            month: p.month as number,
            day: p.day as number,
          });
        }
        if (p.monthInWords && p.day !== undefined && p.month !== undefined) {
          worded.push({
            day: p.day,
            month: p.month,
            year: p.year,
            page: page.page,
          });
        }
      }
    }
    return { page, lines, fullDates };
  });
  return { text, pages, worded };
}

// ---------------------------------------------------------------------------
// Shared helpers.

function overlaps(
  a: { start: number; end: number },
  b: { start: number; end: number }
): boolean {
  return a.start < b.end && b.start < a.end;
}

interface TermRun {
  /** Term indices into the line, end exclusive. */
  readonly start: number;
  readonly end: number;
}

function runOffsets(
  line: LineView,
  run: TermRun
): { start: number; end: number } {
  return {
    start: (line.terms[run.start] as Token).start,
    end: (line.terms[run.end - 1] as Token).end,
  };
}

/** Term indices whose token lies inside an offset span. */
function termsInside(
  line: LineView,
  span: { start: number; end: number }
): TermRun | undefined {
  let start = -1;
  let end = -1;
  line.terms.forEach((t, k) => {
    if (t.start >= span.start && t.end <= span.end) {
      if (start < 0) start = k;
      end = k + 1;
    }
  });
  return start < 0 ? undefined : { start, end };
}

interface LabelHit {
  readonly run: TermRun;
  readonly phrase: string;
  /** Matched inside a hyphenated or slashed term ("po" of "po-4500123"). */
  readonly partial: boolean;
}

/** Occurrences of phrases within a run of a line's terms, also inside compound terms. */
function phraseHits(
  line: LineView,
  within: TermRun,
  phrases: readonly string[][]
): LabelHit[] {
  const hits: LabelHit[] = [];
  for (const phrase of phrases) {
    for (const s of findRuns(line.texts, phrase, within.start, within.end)) {
      hits.push({
        run: { start: s, end: s + phrase.length },
        phrase: phrase.join(' '),
        partial: false,
      });
    }
  }
  const parts: { text: string; term: number }[] = [];
  for (let k = within.start; k < within.end; k++) {
    const text = line.texts[k] as string;
    const pieces = /[-/]/.test(text)
      ? text.split(/[-/]/).filter((p) => p !== '')
      : [text];
    for (const p of pieces) parts.push({ text: p, term: k });
  }
  const partTexts = parts.map((p) => p.text);
  for (const phrase of phrases) {
    for (const s of findRuns(partTexts, phrase)) {
      const first = (parts[s] as { term: number }).term;
      const last = (parts[s + phrase.length - 1] as { term: number }).term;
      const run = { start: first, end: last + 1 };
      if (
        !hits.some((h) => h.run.start === run.start && h.run.end === run.end)
      ) {
        hits.push({ run, phrase: phrase.join(' '), partial: true });
      }
    }
  }
  return hits;
}

function inside(run: TermRun, outer: TermRun | undefined): boolean {
  return (
    outer !== undefined && run.start >= outer.start && run.end <= outer.end
  );
}

/** The scope label of a detail: the model's label, else the longest lexicon label in the quote. */
export function scopeLabel(
  field: FieldName,
  label: string,
  quote: string
): string {
  const own = termsOf(label);
  if (own.length > 0) return own.join(' ');
  if (hasLineBreak(quote) || quote.trim() === '') return '';
  const line = lineView(quote);
  const hits = phraseHits(
    line,
    { start: 0, end: line.terms.length },
    LEXICON[field]
  );
  hits.sort(
    (a, b) =>
      b.phrase.split(' ').length - a.phrase.split(' ').length ||
      a.run.start - b.run.start
  );
  return hits[0]?.phrase ?? '';
}

// ---------------------------------------------------------------------------
// Typed values.

type Entity =
  | DateEntity
  | DateRangeEntity
  | TimeEntity
  | AmountEntity
  | ReferenceEntity;

function entitiesOf(
  kind: TypedKind,
  scan: LineScan,
  span?: { start: number; end: number }
): { list: Entity[]; count: number } {
  const keep = <T extends { start: number; end: number }>(e: T): boolean =>
    span === undefined || overlaps(e, span);
  switch (kind) {
    case 'time': {
      const list = scan.times.filter(keep);
      return { list, count: list.length };
    }
    case 'date': {
      const dates = scan.dates.filter(keep);
      const ranges = scan.ranges.filter(keep);
      return {
        list: [...dates, ...ranges],
        count: dates.length + 2 * ranges.length,
      };
    }
    case 'date_range': {
      const list: Entity[] = [
        ...scan.ranges.filter(keep),
        ...scan.dates.filter(keep),
      ];
      return { list, count: list.length };
    }
    case 'amount': {
      const list = effectiveAmounts(scan.amounts.filter(keep));
      return { list, count: list.length };
    }
    case 'reference': {
      const list = scan.references.filter(keep);
      return { list, count: list.length };
    }
  }
}

/** A typed value parsed: its one entity, and its other terms. */
interface ParsedValue {
  readonly entity?: Entity | undefined;
  readonly count: number;
  readonly extras: readonly string[];
}

function parseValue(kind: TypedKind, value: string): ParsedValue {
  const line = lineView(value);
  const { list, count } = entitiesOf(kind, line.scan);
  const entity = count === 1 ? list[0] : undefined;
  const extras = line.terms
    .filter(
      (t) =>
        entity === undefined ||
        !(t.start >= entity.start && t.end <= entity.end)
    )
    .map((t) => t.text);
  return { entity, count, extras };
}

/**
 * A comparison key for a value: the canonical form of its entity for typed
 * fields (so "£350.00" and "GBP 350" are equal), its terms otherwise.
 */
export function valueKey(field: FieldName, value: string): string {
  const kind = FIELDS[field].kind;
  const words = termsOf(value).join(' ');
  if (!isTypedKind(kind) || hasLineBreak(value) || value.trim() === '')
    return words;
  const parsed = parseValue(kind, value);
  if (parsed.entity === undefined) return words;
  // Tax words before an amount are in its key already ("ex VAT £350").
  const extras =
    parsed.entity.kind === 'amount' && parsed.entity.preTax !== undefined
      ? parsed.extras.filter((w) => !PRE_TAX_WORDS.has(w))
      : parsed.extras;
  return [entityKey(parsed.entity), ...extras].join(' ');
}

function entityKey(entity: Entity): string {
  switch (entity.kind) {
    case 'date':
      return partsKey(entity.parts);
    case 'date_range':
      return `${partsKey(entity.from)}..${partsKey(entity.to)}`;
    case 'time':
      return timeKey(entity);
    case 'amount':
      return amountKey(entity);
    case 'reference':
      return entity.key;
  }
}

function asRange(entity: Entity): DateRangeEntity | undefined {
  if (entity.kind === 'date_range') return entity;
  if (entity.kind === 'date') {
    return {
      ...entity,
      kind: 'date_range',
      from: entity.parts,
      to: entity.parts,
    };
  }
  return undefined;
}

interface Agreement {
  failed: Failure[];
  completions: string[];
  notes: string[];
}

function emptyAgreement(): Agreement {
  return { failed: [], completions: [], notes: [] };
}

function merge(into: Agreement, from: Agreement): void {
  into.failed.push(...from.failed);
  into.completions.push(...from.completions);
  into.notes.push(...from.notes);
}

function describeParts(p: DateParts): string {
  const bits: string[] = [];
  if (p.day !== undefined) bits.push(String(p.day));
  if (p.month !== undefined) bits.push(MONTH_NAMES[p.month - 1] as string);
  if (p.year !== undefined) bits.push(String(p.year));
  return bits.join(' ') || 'no day';
}

interface DateContext {
  readonly index: SourceIndex;
  readonly view: PageView;
}

/** Settles an ambiguous numeric date by the source's dates in words, if it can. */
function settleReading(
  p: DateParts,
  written: string,
  ctx: DateContext,
  check: CheckNumber
): { parts?: DateParts; failed?: Failure; note?: string } {
  if (!p.ambiguous) return { parts: p };
  const readings: { day: number; month: number }[] = [];
  if (p.day !== undefined && p.month !== undefined)
    readings.push({ day: p.day, month: p.month });
  if (p.alternative) readings.push(p.alternative);
  const hits = readings
    .map((r) => ({
      r,
      w: ctx.index.worded.find(
        (w) =>
          w.day === r.day &&
          w.month === r.month &&
          (p.year === undefined || w.year === undefined || w.year === p.year)
      ),
    }))
    .filter((h) => h.w !== undefined);
  if (hits.length === 1) {
    const { r, w } = hits[0] as {
      r: { day: number; month: number };
      w: { page: number };
    };
    return {
      parts: {
        ...p,
        day: r.day,
        month: r.month,
        ambiguous: false,
        alternative: undefined,
      },
      note: `${quoted(written)} read as ${r.day} ${MONTH_NAMES[r.month - 1]} from p${w.page}`,
    };
  }
  const options = readings
    .map((r) => `${r.day} ${MONTH_NAMES[r.month - 1]}`)
    .join(' or ');
  return {
    failed: {
      check,
      code: 'ambiguous_date',
      text: `${quoted(written)} reads two ways (${options}) and the source does not write it with the month in words`,
    },
  };
}

interface FullDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * The full dates on the page that a partly written date may be: the same
 * day, and the same month, year and weekday where those are written.
 */
function statedInFull(written: DateParts, view: PageView): FullDate[] {
  const out = new Map<string, FullDate>();
  if (written.day === undefined) return [];
  for (const d of view.fullDates) {
    if (d.day !== written.day) continue;
    if (written.month !== undefined && d.month !== written.month) continue;
    if (written.year !== undefined && d.year !== written.year) continue;
    if (
      written.weekday !== undefined &&
      weekdayOf(d.year, d.month, d.day) !== written.weekday
    )
      continue;
    out.set(isoDate(d.year, d.month, d.day), d);
  }
  return [...out.values()];
}

/**
 * Compares what is claimed (a value's date, or the day) with what is
 * written. A component the claim has and the writing lacks must come from
 * the one full date on the page that the writing can be.
 */
function agreeParts(
  claimIn: DateParts,
  claimText: string,
  writtenIn: DateParts,
  writtenText: string,
  ctx: DateContext,
  check: CheckNumber
): Agreement {
  const out = emptyAgreement();
  const claimSettled = settleReading(claimIn, claimText, ctx, check);
  const writtenSettled = settleReading(writtenIn, writtenText, ctx, check);
  for (const s of [claimSettled, writtenSettled]) {
    if (s.failed) out.failed.push(s.failed);
    if (s.note) out.notes.push(s.note);
  }
  const claim = claimSettled.parts;
  const written = writtenSettled.parts;
  if (!claim || !written) return out;
  const pageNo = ctx.view.page.page;
  const completed: { day?: number; month?: number; year?: number } = {};
  const missing: ('month' | 'year')[] = [];
  for (const comp of ['day', 'month', 'year'] as const) {
    const c = claim[comp];
    const w = written[comp];
    if (c !== undefined && w !== undefined) {
      if (c !== w) {
        out.failed.push({
          check,
          code: 'disagree',
          text: `${quoted(claimText)} is ${describeParts(claim)} but the source writes ${describeParts(written)}`,
        });
        return out;
      }
      completed[comp] = c;
    } else if (c !== undefined) {
      if (comp === 'day') {
        out.failed.push({
          check,
          code: 'day_not_written',
          text: `${quoted(writtenText)} gives no day of the month`,
        });
        return out;
      }
      missing.push(comp);
      completed[comp] = c;
    } else if (w !== undefined) {
      completed[comp] = w;
    }
  }
  if (missing.length > 0) {
    const matches = statedInFull(written, ctx.view);
    const match = matches.length === 1 ? matches[0] : undefined;
    if (match === undefined || missing.some((m) => match[m] !== claim[m])) {
      const values = missing
        .map((m) =>
          m === 'month'
            ? (MONTH_NAMES[(claim.month as number) - 1] as string)
            : String(claim.year)
        )
        .join(' ');
      const why =
        match !== undefined
          ? `p${pageNo} writes it as ${formatDay(isoDate(match.year, match.month, match.day))}`
          : matches.length > 1
            ? `p${pageNo} writes more than one date it could be`
            : `p${pageNo} does not write that date in full`;
      out.failed.push({
        check,
        code: 'not_written',
        text: `the ${missing.join(' and ')} (${values}) ${missing.length > 1 ? 'are' : 'is'} not written in ${quoted(writtenText)}, and ${why}`,
      });
      return out;
    }
    out.completions.push(`${missing.join(' and ')} from p${pageNo}`);
  }
  const full =
    completed.day !== undefined &&
    completed.month !== undefined &&
    completed.year !== undefined;
  if (claim.weekday !== undefined && written.weekday === undefined) {
    out.failed.push({
      check,
      code: 'not_written',
      text: `the weekday in ${quoted(claimText)} is not written`,
    });
  }
  if (
    claim.weekday !== undefined &&
    written.weekday !== undefined &&
    claim.weekday !== written.weekday
  ) {
    out.failed.push({
      check,
      code: 'disagree',
      text: `${quoted(claimText)} and ${quoted(writtenText)} name different weekdays`,
    });
  }
  if (written.weekday !== undefined && full) {
    const actual = weekdayOf(
      completed.year as number,
      completed.month as number,
      completed.day as number
    );
    if (actual !== written.weekday) {
      const iso = isoDate(
        completed.year as number,
        completed.month as number,
        completed.day as number
      );
      out.failed.push({
        check,
        code: 'weekday_disagrees',
        text: `the weekday in ${quoted(writtenText)} is not that of ${formatDay(iso)}`,
      });
    }
  }
  return out;
}

function agreeTime(v: TimeEntity, q: TimeEntity): Agreement {
  const out = emptyAgreement();
  const sameHour = v.hour % 12 === q.hour % 12 && v.minute === q.minute;
  const disagree = (): Failure => ({
    check: 3,
    code: 'disagree',
    text: `the value ${quoted(v.text)} is not the time the source writes, ${quoted(q.text)}`,
  });
  if (v.resolved !== undefined && q.resolved !== undefined) {
    if (v.resolved !== q.resolved) out.failed.push(disagree());
  } else if (v.resolved === undefined && q.resolved !== undefined) {
    if (q.clock === '12h' && sameHour) {
      out.failed.push({
        check: 3,
        code: 'left_out',
        text: `the am or pm in ${quoted(q.text)} is left out of the value`,
      });
    } else if (!(v.hour === q.hour && v.minute === q.minute)) {
      out.failed.push(disagree());
    }
  } else if (v.resolved !== undefined && q.resolved === undefined) {
    out.failed.push(
      sameHour
        ? {
            check: 3,
            code: 'not_written',
            text: `am or pm is not written in ${quoted(q.text)}`,
          }
        : disagree()
    );
  } else if (!(v.hour === q.hour && v.minute === q.minute)) {
    out.failed.push(disagree());
  }
  return out;
}

function agreeAmount(v: AmountEntity, q: AmountEntity): Agreement {
  const vTax = taxOf(v);
  const qTax = taxOf(q);
  const out = emptyAgreement();
  if (q.unknownSuffix || v.unknownSuffix) {
    out.failed.push({
      check: 3,
      code: 'unknown_suffix',
      text: `the amount ${quoted(q.unknownSuffix ? q.text : v.text)} is not understood`,
    });
    return out;
  }
  if (
    q.ambiguous ||
    v.ambiguous ||
    q.value === undefined ||
    v.value === undefined
  ) {
    out.failed.push({
      check: 3,
      code: 'ambiguous_number',
      text: `the number ${quoted(q.ambiguous ? q.numberText : v.numberText)} reads two ways`,
    });
    return out;
  }
  if (v.value !== q.value) {
    out.failed.push({
      check: 3,
      code: 'disagree',
      text: `the value ${quoted(v.text)} is not the amount the source writes, ${quoted(q.text)}`,
    });
    return out;
  }
  const parts: Array<[string, string | undefined, string | undefined]> = [
    ['currency', v.currency, q.currency],
    ['basis', v.basis, q.basis],
    ['tax words', vTax, qTax],
  ];
  for (const [name, a, b] of parts) {
    if (a === b) continue;
    const verb = name === 'tax words' ? 'are' : 'is';
    if (a === undefined) {
      out.failed.push({
        check: 3,
        code: 'left_out',
        text: `the ${name} in ${quoted(q.text)} ${verb} left out of the value`,
      });
    } else if (b === undefined) {
      out.failed.push({
        check: 3,
        code: 'not_written',
        text: `the ${name} in the value ${verb} not written in ${quoted(q.text)}`,
      });
    } else {
      out.failed.push({
        check: 3,
        code: 'disagree',
        text: `the ${name} of the value differs from ${quoted(q.text)}`,
      });
    }
  }
  return out;
}

function agreeReference(v: ReferenceEntity, q: ReferenceEntity): Agreement {
  const out = emptyAgreement();
  if (v.key !== q.key) {
    out.failed.push({
      check: 3,
      code: 'disagree',
      text: `the value ${quoted(v.text)} is not the reference the source writes, ${quoted(q.text)}`,
    });
  }
  return out;
}

function agreeEntities(
  kind: TypedKind,
  v: Entity,
  q: Entity,
  ctx: DateContext
): Agreement {
  if (kind === 'time' && v.kind === 'time' && q.kind === 'time')
    return agreeTime(v, q);
  if (kind === 'amount' && v.kind === 'amount' && q.kind === 'amount')
    return agreeAmount(v, q);
  if (kind === 'reference' && v.kind === 'reference' && q.kind === 'reference')
    return agreeReference(v, q);
  if (kind === 'date' && v.kind === 'date' && q.kind === 'date') {
    return agreeParts(v.parts, v.text, q.parts, q.text, ctx, 3);
  }
  const vr = asRange(v);
  const qr = asRange(q);
  if (kind === 'date_range' && vr && qr) {
    const out = agreeParts(vr.from, vr.text, qr.from, qr.text, ctx, 3);
    if (out.failed.length === 0)
      merge(out, agreeParts(vr.to, vr.text, qr.to, qr.text, ctx, 3));
    out.completions.splice(
      0,
      out.completions.length,
      ...new Set(out.completions)
    );
    return out;
  }
  const out = emptyAgreement();
  out.failed.push({
    check: 3,
    code: 'disagree',
    text: `the value ${quoted(v.text)} is not a ${KIND_NAMES[kind]} like ${quoted(q.text)}`,
  });
  return out;
}

// ---------------------------------------------------------------------------
// Hedges and sentences.

interface Hedge {
  readonly text: string;
  readonly run?: TermRun | undefined;
  readonly start: number;
  readonly end: number;
}

function hedgesIn(
  line: LineView,
  range: { start: number; end: number }
): Hedge[] {
  const out: Hedge[] = [];
  const tokens = line.scan.tokens;
  const dates = [...line.scan.dates, ...line.scan.ranges];
  const first = line.terms.findIndex((t) => t.start >= range.start);
  if (first >= 0) {
    for (let k = first; k < line.terms.length; ) {
      const term = line.terms[k] as Token;
      if (term.end > range.end) break;
      const nextToken = tokens.find((t) => t.start >= term.end);
      const nextTerm = line.terms[k + 1];
      let matched: string[] | undefined;
      for (const phrase of HEDGE_PHRASES) {
        if (phrase.every((p, n) => line.texts[k + n] === p)) {
          matched = phrase;
          break;
        }
      }
      if (matched !== undefined && matched.length === 1) {
        const word = matched[0] as string;
        const glued =
          nextToken !== undefined &&
          nextToken.start === term.end &&
          nextToken.type === 'punct';
        const numberNext = nextTerm !== undefined && /\d/.test(nextTerm.text);
        const prevTerm = line.terms[k - 1];
        // "no" is "number" only glued to ".", ":" or "#", before "#", or
        // between a numbered noun and a reference ("PO no 4500123").
        const numberAbbreviation =
          (glued && ['.', ':', '#'].includes(nextToken.text)) ||
          nextTerm?.text === '#' ||
          (prevTerm !== undefined &&
            NUMBERED_NOUNS.has(prevTerm.text) &&
            nextTerm !== undefined &&
            line.scan.references.some((r) => r.start === nextTerm.start));
        if (word === 'no' && numberAbbreviation) {
          matched = undefined;
        } else if (word === 'may' && dates.some((d) => overlaps(d, term))) {
          matched = undefined;
        } else if (
          (word === 'c' || word === 'ca') &&
          !((glued && nextToken.text === '.') || numberNext)
        ) {
          matched = undefined;
        }
      }
      if (
        matched === undefined &&
        (term.text.endsWith("n't") || /^\d[\d:.]*-?ish$/.test(term.text))
      )
        matched = [term.text];
      if (matched !== undefined) {
        const last = line.terms[k + matched.length - 1] as Token;
        out.push({
          text: matched.join(' '),
          run: { start: k, end: k + matched.length },
          start: term.start,
          end: last.end,
        });
        k += matched.length;
        continue;
      }
      k++;
    }
  }
  for (const t of tokens) {
    if (
      t.type === 'punct' &&
      t.text === '?' &&
      t.start >= range.start &&
      t.end <= range.end
    ) {
      out.push({ text: '?', start: t.start, end: t.end });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// One occurrence of the quote.

interface Occurrence {
  readonly lineIndex: number;
  readonly run: TermRun;
}

interface OccurrenceResult {
  readonly passed: Finding[];
  readonly failed: Failure[];
  readonly completions: string[];
  readonly label: string;
  readonly day?: string | undefined;
  /** Equal for two occurrences that read the same. */
  readonly signature: string;
}

interface Context {
  readonly candidate: CandidateDetail;
  readonly kind: ValueKind;
  readonly index: SourceIndex;
  readonly view: PageView;
}

/** Dates, ranges and relative days ("Day 2", "show day") between two places. */
function datesBetween(
  view: PageView,
  from: { line: number; offset: number },
  to: { line: number; offset: number }
): (DateEntity | DateRangeEntity | RelativeDay)[] {
  const found: (DateEntity | DateRangeEntity | RelativeDay)[] = [];
  for (let l = from.line; l <= to.line; l++) {
    const scan = (view.lines[l] as LineView).scan;
    for (const d of [...scan.dates, ...scan.ranges, ...scan.relatives]) {
      const afterFrom = l > from.line || d.start >= from.offset;
      const beforeTo = l < to.line || d.end <= to.offset;
      if (afterFrom && beforeTo) found.push(d);
    }
  }
  return found;
}

function dayParts(iso: string): DateParts | undefined {
  if (!isCalendarDate(iso)) return undefined;
  const [year, month, day] = iso.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  return {
    year,
    month,
    day,
    monthInWords: false,
    numeric: true,
    ambiguous: false,
    twoDigitYear: false,
    shared: [],
  };
}

/** A date written on a page, completed only from that same date written in full on the page. */
function completeOnPage(parts: DateParts, view: PageView): string | undefined {
  if (parts.ambiguous || parts.day === undefined) return undefined;
  const iso = partsIso(parts);
  if (iso !== undefined) return iso;
  const matches = statedInFull(parts, view);
  const only = matches.length === 1 ? matches[0] : undefined;
  return only ? isoDate(only.year, only.month, only.day) : undefined;
}

/**
 * Whether a line, up to term `limit`, is a date heading: nothing but the
 * date, day labels ("Day 1", "show day"), heading words and small numbers.
 */
function isHeading(
  line: LineView,
  limit: number,
  date: { start: number; end: number }
): boolean {
  const labels = line.scan.relatives;
  return line.terms.slice(0, limit).every((t) => {
    if (t.start >= date.start && t.end <= date.end) return true;
    if (labels.some((r) => t.start >= r.start && t.end <= r.end)) return true;
    return HEADING_WORDS.has(t.text) || /^\d{1,2}$/.test(t.text);
  });
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return isoDate(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate()
  );
}

/** The calculation a relative day implies, shown as a calculation. */
function relativeText(
  rel: RelativeDay,
  ctx: Context,
  occ: Occurrence,
  day: string | undefined
): string {
  const view = ctx.view;
  const line = view.lines[occ.lineIndex] as LineView;
  let anchor: { iso: string; from: string } | undefined;
  let result: string | undefined;
  if (rel.offset !== undefined) {
    const sameLine = line.scan.dates
      .filter((d) => d.end <= rel.start)
      .reverse();
    for (const d of sameLine) {
      const iso = completeOnPage(d.parts, view);
      if (iso) {
        anchor = { iso, from: d.text };
        break;
      }
    }
    for (let l = occ.lineIndex - 1; anchor === undefined && l >= 0; l--) {
      const above = [...(view.lines[l] as LineView).scan.dates].reverse();
      for (const d of above) {
        const iso = completeOnPage(d.parts, view);
        if (iso) {
          anchor = { iso, from: d.text };
          break;
        }
      }
      if (above.length > 0) break;
    }
    if (anchor === undefined && view.page.date !== undefined) {
      const iso = view.page.date.slice(0, 10);
      if (dayParts(iso)) anchor = { iso, from: 'the date of this message' };
    }
    if (anchor) result = addDays(anchor.iso, rel.offset);
  } else if (rel.dayNumber !== undefined) {
    for (const l of view.lines) {
      const label = l.scan.relatives.find((r) => r.dayNumber !== undefined);
      const date = l.scan.dates.find(
        (d) => completeOnPage(d.parts, view) !== undefined
      );
      if (label && date && label.dayNumber !== rel.dayNumber) {
        const iso = completeOnPage(date.parts, view) as string;
        anchor = { iso, from: `${label.text} = ${date.text}` };
        result = addDays(iso, rel.dayNumber - (label.dayNumber as number));
        break;
      }
    }
  } else {
    return `${quoted(rel.text)} names no date`;
  }
  if (!anchor || result === undefined) {
    return `${quoted(rel.text)} is relative and no date to count it from is written`;
  }
  const match =
    day === undefined
      ? ''
      : day === result
        ? '; it matches the day given'
        : `; the day given is ${formatDay(day)}`;
  return `${quoted(rel.text)} counted from ${quoted(anchor.from)} is ${formatDay(result)} (calculated, not written)${match}`;
}

function checkDay(
  ctx: Context,
  occ: Occurrence,
  span: { start: number; end: number },
  valueDate: Entity | undefined
): {
  failed: Failure[];
  passed: Finding[];
  completions: string[];
  day?: string;
} {
  const c = ctx.candidate;
  const line = ctx.view.lines[occ.lineIndex] as LineView;
  const failed: Failure[] = [];
  const passed: Finding[] = [];
  const completions: string[] = [];
  const target = c.day === undefined ? undefined : dayParts(c.day);
  const day = target === undefined ? undefined : c.day;
  const relatives = line.scan.relatives.filter((r) => overlaps(r, span));
  const counted = relatives.filter((r) => r.offset !== undefined);
  for (const rel of counted) {
    failed.push({
      check: 4,
      code: 'relative_day',
      text: relativeText(rel, ctx, occ, day),
    });
  }
  if (c.day === undefined) return { failed, passed, completions };
  if (!target) {
    failed.push({
      check: 4,
      code: 'day_invalid',
      text: `the day ${quoted(c.day)} is not a calendar date`,
    });
    return { failed, passed, completions };
  }
  const ctxDates: DateContext = { index: ctx.index, view: ctx.view };
  const quoteDates = line.scan.dates.filter((d) => overlaps(d, span));
  const quoteRanges = line.scan.ranges.filter((r) => overlaps(r, span));
  const settle = (written: DateEntity, how: string): void => {
    const agreement = agreeParts(
      target,
      c.day as string,
      written.parts,
      written.text,
      ctxDates,
      4
    );
    failed.push(...agreement.failed);
    completions.push(...agreement.completions);
    if (agreement.failed.length === 0) {
      passed.push({
        check: 4,
        text: `day ${formatDay(c.day as string)} ${how}${agreement.notes.length ? ` (${agreement.notes.join('; ')})` : ''}`,
      });
    }
  };
  if (quoteDates.length + quoteRanges.length > 0) {
    let written: DateEntity | undefined;
    if (quoteDates.length === 1 && quoteRanges.length === 0)
      written = quoteDates[0];
    else if (valueDate?.kind === 'date')
      written = quoteDates.find((d) => d.start === valueDate.start);
    if (
      written === undefined &&
      valueDate !== undefined &&
      valueDate.kind === 'date'
    ) {
      written = quoteDates.find(
        (d) => partsKey(d.parts) === partsKey(valueDate.parts)
      );
    }
    if (written === undefined) {
      failed.push({
        check: 4,
        code: 'quote_dates_several',
        text: 'the quote names more than one date, so its day is not clear',
      });
    } else {
      settle(written, 'in the quote');
    }
    return {
      failed,
      passed,
      completions,
      ...(failed.length === 0 ? { day: c.day } : {}),
    };
  }
  const named = relatives.filter((r) => r.offset === undefined);
  if (named.length > 0) {
    for (const rel of named) {
      failed.push({
        check: 4,
        code: 'relative_day',
        text: relativeText(rel, ctx, occ, day),
      });
    }
    return { failed, passed, completions };
  }
  if (c.day_quote === undefined || c.day_quote.trim() === '') {
    if (counted.length === 0) {
      failed.push({
        check: 4,
        code: 'day_not_written',
        text: 'the day is not in the quote and no date heading was given',
      });
    }
    return { failed, passed, completions };
  }
  const headingTerms = termsOf(c.day_quote);
  let heading: { line: number; run: TermRun } | undefined;
  for (let l = occ.lineIndex; l >= 0 && heading === undefined; l--) {
    const view = ctx.view.lines[l] as LineView;
    const limit = l === occ.lineIndex ? occ.run.start : view.terms.length;
    const runs = findRuns(view.texts, headingTerms, 0, limit);
    const lastRun = runs[runs.length - 1];
    if (lastRun !== undefined)
      heading = {
        line: l,
        run: { start: lastRun, end: lastRun + headingTerms.length },
      };
  }
  if (heading === undefined) {
    failed.push({
      check: 4,
      code: 'day_quote_not_found',
      text: `the date heading ${quoted(c.day_quote)} is not above the quote on p${ctx.view.page.page}`,
    });
    return { failed, passed, completions };
  }
  const headingLine = ctx.view.lines[heading.line] as LineView;
  const headingSpan = runOffsets(headingLine, heading.run);
  const headingDates = [
    ...headingLine.scan.dates.filter((d) => overlaps(d, headingSpan)),
    ...headingLine.scan.ranges.filter((r) => overlaps(r, headingSpan)),
  ];
  if (headingDates.length !== 1 || headingDates[0]?.kind !== 'date') {
    const headingRel = headingLine.scan.relatives.filter((r) =>
      overlaps(r, headingSpan)
    );
    if (headingDates.length === 0 && headingRel.length > 0) {
      for (const rel of headingRel) {
        failed.push({
          check: 4,
          code: 'relative_day',
          text: relativeText(
            rel,
            ctx,
            { lineIndex: heading.line, run: heading.run },
            day
          ),
        });
      }
    } else {
      failed.push({
        check: 4,
        code:
          headingDates.length === 0
            ? 'day_not_written'
            : 'day_quote_several_dates',
        text:
          headingDates.length === 0
            ? `the heading ${quoted(c.day_quote)} holds no date`
            : `the heading ${quoted(c.day_quote)} holds more than one date`,
      });
    }
    return { failed, passed, completions };
  }
  const headingDate = headingDates[0];
  const headingLimit =
    heading.line === occ.lineIndex ? occ.run.start : headingLine.terms.length;
  if (!isHeading(headingLine, headingLimit, headingDate)) {
    failed.push({
      check: 4,
      code: 'day_quote_not_heading',
      text: `${quoted(c.day_quote)} is in ${quoted(headingLine.scan.line)}, which is not a date heading`,
    });
    return { failed, passed, completions };
  }
  const between = datesBetween(
    ctx.view,
    { line: heading.line, offset: headingDate.end },
    { line: occ.lineIndex, offset: span.start }
  ).filter((d) => d !== headingDate);
  if (between.length > 0) {
    failed.push({
      check: 4,
      code: 'date_between',
      text: `${quoted(between[0]?.text ?? '')} lies between the heading ${quoted(c.day_quote)} and the quote${between[0]?.kind === 'relative' ? ', so the heading may not be its day' : ''}`,
    });
    return { failed, passed, completions };
  }
  settle(headingDate, `from the heading ${quoted(c.day_quote)}`);
  return {
    failed,
    passed,
    completions,
    ...(failed.length === 0 ? { day: c.day } : {}),
  };
}

/** Whether a value is one entity of a typed kind and nothing else. */
function loneEntity(kind: TypedKind, value: string): boolean {
  const parsed = parseValue(kind, value);
  return parsed.count === 1 && parsed.extras.length === 0;
}

/**
 * Why a label hit for `field` does not name it alone, or undefined when it
 * does: it is part of a longer label of another field, another field of the
 * same value kind uses it too, or a typed field uses it and the value is
 * only that field's kind.
 */
function labelTakenBy(
  field: FieldName,
  hit: LabelHit,
  line: LineView,
  within: TermRun,
  value: string
): string | undefined {
  const words = hit.phrase.split(' ').length;
  const width = hit.run.end - hit.run.start;
  for (const spec of Object.values(FIELDS)) {
    if (spec.name === field) continue;
    for (const other of phraseHits(line, within, LEXICON[spec.name])) {
      const covers =
        other.run.start <= hit.run.start && other.run.end >= hit.run.end;
      const longer =
        other.run.end - other.run.start > width ||
        other.phrase.split(' ').length > words;
      if (covers && longer)
        return `${quoted(hit.phrase)} is part of ${quoted(other.phrase)}, a label for ${spec.name}`;
    }
  }
  const own = FIELDS[field].kind;
  for (const other of PHRASE_FIELDS.get(hit.phrase) ?? []) {
    if (other === field) continue;
    const kind = FIELDS[other].kind;
    if (kindGroup(kind) === kindGroup(own))
      return `${quoted(hit.phrase)} is a label for ${other} too`;
    if (
      kindGroup(own) === 'text' &&
      isTypedKind(kind) &&
      loneEntity(kind, value)
    )
      return `${quoted(hit.phrase)} before a lone ${KIND_NAMES[kind]} is a label for ${other}`;
  }
  return undefined;
}

function evaluate(ctx: Context, occ: Occurrence): OccurrenceResult {
  const c = ctx.candidate;
  const line = ctx.view.lines[occ.lineIndex] as LineView;
  const span = runOffsets(line, occ.run);
  const passed: Finding[] = [];
  const failed: Failure[] = [];
  const completions: string[] = [];
  const notes: string[] = [];
  let valueRun: TermRun | undefined;
  let entityRun: TermRun | undefined;
  let valueEntity: Entity | undefined;
  let signature = '';

  const valueTermTexts = new Set(termsOf(c.value));

  // Check 3: the value is in the quote, and nothing more.
  if (!isTypedKind(ctx.kind)) {
    const valueTerms = termsOf(c.value);
    const runs = findRuns(line.texts, valueTerms, occ.run.start, occ.run.end);
    const first = runs[0];
    if (first === undefined) {
      failed.push({
        check: 3,
        code: 'value_not_in_quote',
        text: "the value is not one unbroken run of the quote's words",
      });
    } else {
      valueRun = { start: first, end: first + valueTerms.length };
      passed.push({ check: 3, text: 'value is one run of the quote' });
      signature = valueTerms.join(' ');
    }
  } else {
    const kind = ctx.kind;
    const parsed = parseValue(kind, c.value);
    const quoteEntities = entitiesOf(kind, line.scan, span);
    const name = KIND_NAMES[kind];
    if (parsed.count === 0) {
      failed.push({
        check: 3,
        code: 'value_not_parsed',
        text: `the value holds no ${name}`,
      });
    } else if (parsed.count > 1) {
      failed.push({
        check: 3,
        code: 'value_several',
        text: `the value holds more than one ${name}`,
      });
    }
    if (quoteEntities.count === 0) {
      failed.push({
        check: 3,
        code: 'quote_none',
        text: `the quote holds no ${name}`,
      });
    } else if (quoteEntities.count > 1) {
      failed.push({
        check: 3,
        code: 'quote_several',
        text: `the quote holds ${quoteEntities.count} ${name}s, not one`,
      });
    }
    const q = quoteEntities.count === 1 ? quoteEntities.list[0] : undefined;
    const v = parsed.entity;
    if (q !== undefined && v !== undefined) {
      valueEntity = q;
      if (q.start < span.start || q.end > span.end) {
        failed.push({
          check: 1,
          code: 'quote_cut_short',
          text: `the quote cuts ${quoted(q.text)} short`,
        });
      } else {
        const agreement = agreeEntities(kind, v, q, {
          index: ctx.index,
          view: ctx.view,
        });
        failed.push(...agreement.failed);
        completions.push(...agreement.completions);
        notes.push(...agreement.notes);
        if (agreement.failed.length === 0) {
          passed.push({
            check: 3,
            text: `value ${quoted(c.value.trim())} matches ${quoted(q.text)}`,
          });
        }
      }
      entityRun = termsInside(line, q);
      // Tax words the quote writes outside the amount stay in the value.
      if (q.kind === 'amount' && taxOf(q) === undefined) {
        const stray = line.terms
          .slice(occ.run.start, occ.run.end)
          .filter(
            (t) =>
              TAX_TERMS.has(t.text) &&
              !(t.start >= q.start && t.end <= q.end) &&
              !valueTermTexts.has(t.text)
          )
          .map((t) => quoted(t.text));
        if (stray.length > 0) {
          failed.push({
            check: 3,
            code: 'left_out',
            text: `the tax words ${[...new Set(stray)].join(', ')} in the quote are left out of the value`,
          });
        }
      }
      const spanTexts = line.texts.slice(occ.run.start, occ.run.end);
      const strays = parsed.extras.filter((w) => !spanTexts.includes(w));
      if (strays.length > 0) {
        failed.push({
          check: 3,
          code: 'value_words_not_in_quote',
          text: `the value has words the quote does not: ${strays.map(quoted).join(', ')}`,
        });
      }
      signature = [entityKey(q), ...parsed.extras].join(' ');
    }
  }

  // Hedges and negations on the quote's line that the value leaves out.
  for (const hedge of hedgesIn(line, {
    start: 0,
    end: line.scan.line.length,
  })) {
    let covered: boolean;
    if (isTypedKind(ctx.kind)) {
      const inEntity = hedge.run !== undefined && inside(hedge.run, entityRun);
      const inValue =
        hedge.text === '?'
          ? c.value.includes('?')
          : hedge.text.split(' ').every((w) => valueTermTexts.has(w));
      covered = inEntity || inValue;
    } else {
      covered = hedge.run !== undefined && inside(hedge.run, valueRun);
    }
    if (covered) continue;
    const where =
      hedge.start >= span.start && hedge.end <= span.end
        ? 'the quote'
        : 'the same line';
    failed.push({
      check: 3,
      code: 'hedge_left_out',
      text: `${quoted(hedge.text)} is in ${where} but not in the value`,
    });
  }

  // Check 2: the quote names the field, outside the value.
  const spanRun = occ.run;
  const valueSide = isTypedKind(ctx.kind) ? entityRun : valueRun;
  let label = '';
  if (c.field === 'Other') {
    const own = termsOf(c.label);
    if (own.length === 0) {
      failed.push({
        check: 2,
        code: 'no_other_label',
        text: 'a detail filed as Other needs its own label',
      });
    } else {
      const hits = phraseHits(line, spanRun, [own]);
      if (hits.length === 0) {
        failed.push({
          check: 2,
          code: 'model_label_not_in_quote',
          text: `the label ${quoted(c.label)} is not in the quote`,
        });
      } else if (hits.every((h) => inside(h.run, valueSide))) {
        failed.push({
          check: 2,
          code: 'label_only_in_value',
          text: `the label ${quoted(c.label)} is only part of the value`,
        });
      } else {
        label = own.join(' ');
        passed.push({ check: 2, text: `label ${quoted(label)}` });
      }
    }
  } else {
    const hits = phraseHits(line, spanRun, LEXICON[c.field]);
    const prefix =
      valueEntity?.kind === 'reference' ? valueEntity.prefix : undefined;
    const outside = hits.filter(
      (h) =>
        !inside(h.run, valueSide) ||
        (h.partial &&
          prefix !== undefined &&
          h.phrase.replace(/ /g, '') === prefix.replace(/[./]/g, ''))
    );
    const taken = outside.map((h) =>
      labelTakenBy(c.field, h, line, spanRun, c.value)
    );
    const free = outside.filter((_, n) => taken[n] === undefined);
    if (hits.length === 0) {
      failed.push({
        check: 2,
        code: 'no_label',
        text: `the quote has no label word for ${c.field}`,
      });
    } else if (outside.length === 0) {
      failed.push({
        check: 2,
        code: 'label_only_in_value',
        text: `the only label word for ${c.field} is part of the value`,
      });
    } else if (free.length === 0) {
      failed.push({
        check: 2,
        code: 'label_names_other_field',
        text: `no label in the quote names ${c.field} alone: ${[...new Set(taken)].join('; ')}`,
      });
    }
    const own = termsOf(c.label);
    if (own.length > 0 && phraseHits(line, spanRun, [own]).length === 0) {
      failed.push({
        check: 2,
        code: 'model_label_not_in_quote',
        text: `the label ${quoted(c.label)} is not in the quote`,
      });
    } else {
      label = scopeLabel(c.field, c.label, c.quote);
    }
    if (free.length > 0)
      passed.push({
        check: 2,
        text: `label ${quoted(label || (free[0] as LabelHit).phrase)}`,
      });
  }

  // Check 4: the day is written.
  const dayCheck = checkDay(
    ctx,
    occ,
    span,
    ctx.kind === 'date' ? valueEntity : undefined
  );
  failed.push(...dayCheck.failed);
  passed.push(...dayCheck.passed);
  completions.push(...dayCheck.completions);
  if (notes.length > 0) passed.push({ check: 3, text: notes.join('; ') });
  return {
    passed,
    failed,
    completions: [...new Set(completions)],
    label,
    day: dayCheck.day,
    signature: `${signature}|${dayCheck.day ?? ''}|${failed.length}`,
  };
}

// ---------------------------------------------------------------------------
// The checks of one detail.

function result(
  fields: Omit<
    CheckResult,
    'status' | 'text' | 'passed' | 'completions' | 'label'
  > &
    Partial<Pick<CheckResult, 'passed' | 'completions' | 'label'>>
): CheckResult {
  const passed = fields.passed ?? [];
  const completions = fields.completions ?? [];
  const failed = fields.failed;
  const status: CheckedStatus = failed.length === 0 ? 'Found' : 'Needs review';
  const history =
    fields.pageKind === 'history'
      ? `From quoted history${fields.historyDate ? ` dated ${fields.historyDate.slice(0, 10)}` : ''}. `
      : '';
  const body =
    status === 'Found'
      ? `Found on p${fields.page}: ${[...passed.filter((p) => !(p.check === 1 && p.text.startsWith('on p'))).map((p) => p.text), ...completions].join('; ')}`
      : `Needs review: ${[...new Set(failed.map((f) => f.text))].join('; ')}`;
  return {
    ...fields,
    passed,
    completions,
    label: fields.label ?? '',
    status,
    text: `${history}${body}`,
  };
}

function pagesHolding(
  index: SourceIndex,
  quoteTerms: readonly string[]
): number[] {
  return index.pages
    .filter((p) =>
      p.lines.some((l) => findRuns(l.texts, quoteTerms).length > 0)
    )
    .map((p) => p.page.page);
}

/** Runs the four checks on one detail against its source's text. */
export function checkDetail(
  candidate: CandidateDetail,
  index: SourceIndex
): CheckResult {
  const spec = FIELDS[candidate.field];
  if (candidate.quote.trim() === '') {
    return result({
      failed: [{ check: 1, code: 'no_quote', text: 'the detail has no quote' }],
    });
  }
  if (hasLineBreak(candidate.quote)) {
    return result({
      failed: [
        {
          check: 1,
          code: 'quote_spans_lines',
          text: 'the quote spans more than one line',
        },
      ],
    });
  }
  if (candidate.value.trim() === '') {
    return result({
      failed: [{ check: 3, code: 'no_value', text: 'the detail has no value' }],
    });
  }
  if (hasLineBreak(candidate.value)) {
    return result({
      failed: [
        {
          check: 3,
          code: 'value_spans_lines',
          text: 'the value spans more than one line',
        },
      ],
    });
  }
  if (hasLineBreak(candidate.label)) {
    return result({
      failed: [
        {
          check: 2,
          code: 'label_spans_lines',
          text: 'the label spans more than one line',
        },
      ],
    });
  }
  if (index.pages.length === 0) {
    return result({
      pageKind: 'scan',
      failed: [{ check: 1, code: 'scan_page', text: SCAN_TEXT }],
    });
  }
  const quoteTerms = termsOf(candidate.quote);
  const paged = index.text.paged || index.pages.length > 1;
  let view: PageView | undefined;
  if (candidate.page === undefined) {
    if (paged) {
      const holding = pagesHolding(index, quoteTerms);
      return result({
        failed: [
          {
            check: 1,
            code: 'page_missing',
            text: `the quote names no page${holding.length ? `; it is on ${holding.map((p) => `p${p}`).join(', ')}` : ''}`,
          },
        ],
      });
    }
    view = index.pages[0];
  } else {
    view = index.pages.find((p) => p.page.page === candidate.page);
  }
  if (view === undefined) {
    return result({
      failed: [
        {
          check: 1,
          code: 'page_unknown',
          text: `the source has no p${candidate.page ?? 1}`,
        },
      ],
    });
  }
  const page = view.page.page;
  const pageKind = view.page.kind;
  const historyDate = pageKind === 'history' ? view.page.date : undefined;
  const base = { page, pageKind, historyDate };
  if (pageKind === 'scan') {
    return result({
      ...base,
      failed: [{ check: 1, code: 'scan_page', text: SCAN_TEXT }],
    });
  }
  const occurrences: Occurrence[] = [];
  view.lines.forEach((line, lineIndex) => {
    for (const start of findRuns(line.texts, quoteTerms)) {
      occurrences.push({
        lineIndex,
        run: { start, end: start + quoteTerms.length },
      });
    }
  });
  if (occurrences.length === 0) {
    const elsewhere = pagesHolding(index, quoteTerms).filter((p) => p !== page);
    return result({
      ...base,
      failed: [
        {
          check: 1,
          code: 'quote_not_on_page',
          text: `the quote is not on p${page}${elsewhere.length ? `; it is on ${elsewhere.map((p) => `p${p}`).join(', ')}` : ''}`,
        },
      ],
    });
  }
  const ctx: Context = { candidate, kind: spec.kind, index, view };
  const results = occurrences.map((occ) => evaluate(ctx, occ));
  const first = results[0] as OccurrenceResult;
  const failed: Failure[] = [];
  // Text that may not show where it was read is never Found on its own.
  if (view.page.unsure !== undefined)
    failed.push({
      check: 1,
      code: 'page_unsure',
      text: `${view.page.unsure}; check the original`,
    });
  for (const r of results) {
    for (const f of r.failed)
      if (!failed.some((g) => g.code === f.code && g.text === f.text))
        failed.push(f);
  }
  const passed: Finding[] = [
    { check: 1, text: `on p${page}` },
    ...first.passed,
  ];
  if (results.length > 1) {
    const same = results.every((r) => r.signature === first.signature);
    if (!same && failed.length === 0) {
      failed.push({
        check: 1,
        code: 'quote_repeats_differently',
        text: `the quote occurs ${results.length} times on p${page} and they do not read the same`,
      });
    } else if (failed.length > 0) {
      failed.push({
        check: 1,
        code: 'quote_repeats_differently',
        text: `the quote occurs ${results.length} times on p${page}`,
      });
    } else {
      passed.push({
        check: 1,
        text: `occurs ${results.length} times on p${page}, the same each time`,
      });
    }
  }
  return result({
    ...base,
    failed,
    passed,
    completions: first.completions,
    label: first.label,
    day: failed.length === 0 ? first.day : undefined,
  });
}

/** Checks every detail of one source. */
export function checkDetails(
  candidates: readonly CandidateDetail[],
  text: SourceText
): CheckResult[] {
  const index = indexSource(text);
  return candidates.map((c) => checkDetail(c, index));
}

export interface SourceDateClaim {
  /** The source's own date, as `YYYY-MM-DD`. */
  readonly date: string;
  /** The line that writes it ("Issued 3 March 2027", "Revision 3 - 12 Feb 2027"). */
  readonly quote: string;
  readonly page?: number | undefined;
}

export interface SourceDateCheck {
  readonly status: CheckedStatus;
  readonly text: string;
  /** The date, when the checks found it written. */
  readonly date?: string | undefined;
}

/**
 * Checks the source's own date the extraction gives (design §3): its quote
 * is one line on the page it names, holds exactly one single date, whole,
 * and that date is the one claimed, completed only as check 3 allows. Every
 * occurrence of the quote on the page must read the same. Newer means this
 * date (design §6), so a date that fails stays unknown.
 */
export function checkSourceDate(
  claim: SourceDateClaim,
  index: SourceIndex
): SourceDateCheck {
  const review = (text: string): SourceDateCheck => ({
    status: 'Needs review',
    text: `Needs review: ${text}`,
  });
  const target = dayParts(claim.date);
  // The claim is the model's own text: its value is never echoed.
  if (!target) return review('the date given is not a calendar date');
  if (claim.quote.trim() === '') return review('the date has no quote');
  if (hasLineBreak(claim.quote))
    return review('the quote spans more than one line');
  if (index.pages.length === 0) return review(SCAN_TEXT);
  const paged = index.text.paged || index.pages.length > 1;
  if (claim.page === undefined && paged)
    return review('the quote names no page');
  const view =
    claim.page === undefined
      ? index.pages[0]
      : index.pages.find((p) => p.page.page === claim.page);
  if (view === undefined) return review(`the source has no p${claim.page}`);
  if (view.page.kind === 'scan') return review(SCAN_TEXT);
  if (view.page.unsure !== undefined) return review(view.page.unsure);
  const quoteTerms = termsOf(claim.quote);
  const outcomes: { failed: string[]; completions: string[] }[] = [];
  view.lines.forEach((line) => {
    for (const start of findRuns(line.texts, quoteTerms)) {
      const run = { start, end: start + quoteTerms.length };
      const span = runOffsets(line, run);
      const failed: string[] = [];
      const completions: string[] = [];
      const found = entitiesOf('date', line.scan, span);
      const written = found.count === 1 ? found.list[0] : undefined;
      if (written === undefined || written.kind !== 'date') {
        failed.push(
          found.count === 0
            ? 'the quote holds no date'
            : 'the quote holds more than one date'
        );
      } else if (written.start < span.start || written.end > span.end) {
        failed.push(`the quote cuts ${quoted(written.text)} short`);
      } else {
        const agreement = agreeParts(
          target,
          claim.date,
          written.parts,
          written.text,
          { index, view },
          3
        );
        failed.push(...agreement.failed.map((f) => f.text));
        completions.push(...agreement.completions);
      }
      for (const hedge of hedgesIn(line, {
        start: 0,
        end: line.scan.line.length,
      }))
        failed.push(`${quoted(hedge.text)} is on the same line`);
      outcomes.push({ failed, completions });
    }
  });
  const pageNo = view.page.page;
  if (outcomes.length === 0) return review(`the quote is not on p${pageNo}`);
  const failed = [...new Set(outcomes.flatMap((o) => o.failed))];
  if (failed.length > 0) return review(failed.join('; '));
  const completions = [...new Set(outcomes.flatMap((o) => o.completions))];
  return {
    status: 'Found',
    text: `Found on p${pageNo}: ${quoted(claim.quote.trim())} dates the source ${formatDay(claim.date)}${completions.length ? `; ${completions.join('; ')}` : ''}`,
    date: claim.date,
  };
}
