// What the service checks in text the model writes into an answer
// (docs/supamac/jobs.md, "Asking"): numbers and dates, hedges, links, and
// whether connecting words hold anything the service cannot vouch for.
//
// Invariants:
// - A number is any Unicode number character (ASCII, fullwidth or other
//   digits, fractions, superscripts, numerals) or currency sign, after NFKC;
//   or a number word, an ordinal (first to thirty-first and the tens), once or
//   twice. A date is a weekday or month name, a word of relative time (today,
//   tonight, tomorrow, yesterday, day, week, weekend, fortnight, month, year,
//   their plurals and -ly forms), a time of day (morning, afternoon, evening,
//   night, noon, midnight), a unit of a duration (hour, minute), or a named
//   holiday (the relative-time and time-of-day words in their plural and -ly
//   forms too). Possessives count ("tomorrow's"). "May" counts only when
//   capitalised inside a sentence.
// - A link is a URL with a scheme, a `www.` or `mailto:` address, a domain
//   name (with or without a path), a Telegram @mention or a bot /command: all
//   of what Telegram makes clickable. A name whose last label is a file
//   extension ("call sheet v2.pdf") is not a domain.
// - A link is kept only when it is, whole, one of the links a cited detail's
//   value or quote writes; any other is replaced by "[link left out]".
// - Connecting words are vouched for only when every word in them, links
//   aside, is a grammatical word, a pointer to a kind of detail ("map",
//   "details"), a word of the field vocabulary (model.ts) that asserts no
//   status or value, or a word of the cited details themselves; and they hold
//   no hedge. Anything else the model wrote is the model's own and is shown
//   as "(not checked)".

import { FIELD_NAMES, FIELDS, HEDGE_WORDS } from '../model';
import { findRuns, termsOf } from '../normalize';

const NUMBER_WORDS = new Set([
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
  'hundred',
  'hundreds',
  'thousand',
  'thousands',
  'million',
  'millions',
  'billion',
  'billions',
  'dozen',
  'dozens',
  'half',
  'halves',
  'quarter',
  'quarters',
  'once',
  'twice',
  'thrice',
  "o'clock",
  'oclock',
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth',
  'thirteenth',
  'fourteenth',
  'fifteenth',
  'sixteenth',
  'seventeenth',
  'eighteenth',
  'nineteenth',
  'twentieth',
  'thirtieth',
  'fortieth',
  'fiftieth',
  'sixtieth',
  'seventieth',
  'eightieth',
  'ninetieth',
  'hundredth',
  'thousandth',
]);

const DATE_WORDS = new Set([
  'today',
  'tonight',
  'tomorrow',
  'yesterday',
  'overnight',
  'midweek',
  'day',
  'days',
  'daily',
  'week',
  'weeks',
  'weekly',
  'weekend',
  'weekends',
  'weekday',
  'weekdays',
  'weeknight',
  'weeknights',
  'fortnight',
  'fortnights',
  'fortnightly',
  'month',
  'months',
  'monthly',
  'year',
  'years',
  'yearly',
  'annual',
  'annually',
  'morning',
  'mornings',
  'afternoon',
  'afternoons',
  'evening',
  'evenings',
  'night',
  'nights',
  'noon',
  'midday',
  'midnight',
  'hour',
  'hours',
  'hourly',
  'minute',
  'minutes',
  'christmas',
  'xmas',
  'easter',
  'hogmanay',
  'halloween',
  'holiday',
  'holidays',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'mondays',
  'tuesdays',
  'wednesdays',
  'thursdays',
  'fridays',
  'saturdays',
  'sundays',
  'mon',
  'tue',
  'tues',
  'wed',
  'thu',
  'thur',
  'thurs',
  'fri',
  'sat',
  'sun',
  'january',
  'february',
  'march',
  'april',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
]);

/** A number character or currency sign, and the run of non-space around it. */
const NUMBER_CHAR = /\S*[\p{N}\p{Sc}]\S*/u;

/** The first number or date the text writes, if any (see the header's list). */
export function numberOrDate(text: string): string | undefined {
  const folded = text.normalize('NFKC');
  const digits = NUMBER_CHAR.exec(folded);
  if (digits) return digits[0];
  for (const match of folded.matchAll(/[\p{L}][\p{L}'’]*/gu)) {
    const word = match[0];
    const lower = word.toLowerCase().replace(/’/g, "'").replace(/'s?$/u, '');
    if (NUMBER_WORDS.has(lower) || DATE_WORDS.has(lower)) return word;
    if (word === 'May') {
      const before = folded.slice(0, match.index).trimEnd();
      if (before !== '' && !/[.!?:]$/.test(before)) return word;
    }
  }
  return undefined;
}

const HEDGE_PHRASES: readonly string[][] = HEDGE_WORDS.map(termsOf).filter(
  (p) => p.length > 0
);

/** Whether the text holds a hedge or negation word or phrase. */
export function hedges(text: string): boolean {
  const terms = termsOf(text);
  if (terms.some((t) => /n't$/.test(t))) return true;
  return HEDGE_PHRASES.some((p) => findRuns(terms, p).length > 0);
}

// ---------------------------------------------------------------------------
// Links.

const LINK = new RegExp(
  [
    // A scheme, www. or mailto:, and everything up to a space or quote.
    String.raw`\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)[^\s<>"'` +
      '`' +
      String.raw`]+`,
    // A domain name, with an optional port and path.
    String.raw`\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s<>"'` +
      '`' +
      String.raw`]*)?`,
    // A Telegram @mention (not the @ of an email address).
    String.raw`(?<![\p{L}\p{N}_.@])@[a-z0-9_]{3,32}\b`,
    // A bot /command (not a slash between words or numbers).
    String.raw`(?<![\p{L}\p{N}_./:@])\/[a-z][a-z0-9_]{0,31}(?:@[a-z0-9_]+)?\b`,
  ].join('|'),
  'giu'
);

/** File extensions that are no top-level domain: "v2.pdf" is a file name. */
const FILE_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'xlsm',
  'csv',
  'ics',
  'txt',
  'rtf',
  'odt',
  'ods',
  'ppt',
  'pptx',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'heic',
  'heif',
  'tif',
  'tiff',
  'bmp',
  'eml',
  'msg',
  'htm',
  'html',
  'json',
  'xml',
]);

const TRAILING = /[.,;:!?)\]]+$/u;

/** Whether a match of LINK is a file name rather than a link. */
function isFileName(match: string): boolean {
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:|@|\/)/iu.test(match))
    return false;
  const host = match.split(/[/:]/u)[0] ?? '';
  const last = host.split('.').at(-1) ?? '';
  return FILE_EXTENSIONS.has(last.toLowerCase());
}

/** The links a text writes, without trailing punctuation. */
export function linksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(LINK)) {
    const link = m[0].replace(TRAILING, '');
    if (link !== '' && !isFileName(link)) out.push(link);
  }
  return out;
}

/** What a cited detail writes, for the link and vocabulary checks. */
export interface CitedText {
  readonly field: string;
  readonly label: string;
  readonly value: string;
  readonly quote: string;
}

/**
 * Replaces every link that is not, whole, a link of `cited` (its values and
 * quotes) with "[link left out]"; says how many it replaced.
 */
export function keepCitedLinks(
  text: string,
  cited: readonly Pick<CitedText, 'value' | 'quote'>[]
): { text: string; dropped: number } {
  const allowed = new Set(
    cited.flatMap((d) => [...linksIn(d.value), ...linksIn(d.quote)])
  );
  let dropped = 0;
  const out = text.replace(LINK, (match) => {
    const link = match.replace(TRAILING, '');
    const tail = match.slice(link.length);
    if (link === '' || isFileName(link) || allowed.has(link)) return match;
    dropped++;
    return `[link left out]${tail}`;
  });
  return { text: out, dropped };
}

/** Replaces every link in a name or note the service prints (it cites nothing). */
export function dropLinks(text: string): { text: string; dropped: number } {
  return keepCitedLinks(text, []);
}

// ---------------------------------------------------------------------------
// Connecting words.

const GRAMMAR_WORDS = new Set([
  'a',
  'an',
  'the',
  'your',
  'yours',
  'you',
  'my',
  'our',
  'their',
  'its',
  'it',
  'this',
  'that',
  'these',
  'those',
  'is',
  'are',
  'be',
  'for',
  'of',
  'to',
  'at',
  'in',
  'on',
  'by',
  'with',
  'and',
  'as',
  'from',
  'what',
  'which',
  'where',
  'who',
  'how',
  'when',
  'all',
  'each',
  'both',
  'also',
  'there',
  'here',
  'they',
  'them',
  'we',
  'i',
  'me',
  '&',
  '/',
]);

/** Words that point at a kind of detail without saying anything about it. */
const POINTER_WORDS = new Set([
  'map',
  'maps',
  'link',
  'links',
  'detail',
  'details',
  'info',
  'information',
  'note',
  'notes',
  'see',
  'says',
  'say',
  'shows',
  'below',
  'above',
  'listed',
]);

/** Words of the field vocabulary that assert a status, a plan or a value. */
const ASSERTING_WORDS = new Set([
  'book',
  'booked',
  'self-book',
  'self-booked',
  'confirmation',
  'agreed',
  'paid',
  'released',
  'settled',
  'done',
  'clear',
  'held',
  'fixed',
  'required',
  'will',
  'need',
  'please',
  'arrange',
  'arranged',
  'organised',
  'organized',
  'payable',
  'accredited',
  'catered',
  'close',
  'open',
  'extra',
  'additional',
  'own',
  'live',
  'net',
  'flat',
  'casual',
  'smart',
  'black',
  'blacks',
  'double',
  'hot',
  'high',
  'green',
  'end',
  'ends',
  'begins',
  'start',
  'return',
  'until',
  'till',
  'self',
]);

const FIELD_WORDS: ReadonlySet<string> = new Set(
  FIELD_NAMES.flatMap((name) => [
    ...termsOf(name),
    ...FIELDS[name].labels.flatMap((label) => termsOf(label)),
  ]).filter((t) => t.length > 1 && !ASSERTING_WORDS.has(t))
);

/** The forms of a term to look up: itself, without a possessive, singular. */
function forms(term: string): string[] {
  const bare = term.replace(/'s?$/u, '');
  const out = [term, bare];
  if (bare.endsWith('ies')) out.push(`${bare.slice(0, -3)}y`);
  if (bare.endsWith('es')) out.push(bare.slice(0, -2));
  if (bare.endsWith('s')) out.push(bare.slice(0, -1));
  return out;
}

/**
 * Whether connecting words hold nothing the service cannot vouch for (see
 * the header): their own words, links aside, are grammar, pointers, the field
 * vocabulary or the cited details' words, and none hedges.
 */
export function vouchedFor(
  words: string,
  cited: readonly CitedText[]
): boolean {
  if (hedges(words)) return false;
  const own = words.replace(LINK, ' ').replace(/\[link left out\]/gu, ' ');
  const citedWords = new Set(
    cited.flatMap((d) =>
      [d.field, d.label, d.value, d.quote].flatMap((t) => termsOf(t))
    )
  );
  return termsOf(own).every((term) =>
    forms(term).some(
      (f) =>
        GRAMMAR_WORDS.has(f) ||
        POINTER_WORDS.has(f) ||
        FIELD_WORDS.has(f) ||
        citedWords.has(f)
    )
  );
}
