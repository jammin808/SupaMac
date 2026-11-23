// Text normalisation and tokens for the quote checks (docs/supamac/jobs.md §4).
//
// Invariants:
// - Both sides of every comparison pass through `normalize`: Unicode NFKC,
//   case folding, one space for any run of whitespace within a line, one form
//   for quote marks (' and ") and dashes (-), and no NUL, other control
//   characters, unpaired surrogates, bidirectional controls or invisible
//   format characters.
// - Line breaks are kept as "\n". Nothing here joins two lines: `tokenize`
//   gives each line its own tokens and `tokenizeLine` refuses a line break.
// - A token is a word, a symbol or punctuation. A word keeps its inner
//   connectors, so a time (08:00), an amount (£350.00, €1.200,00), a
//   reference (PO-4500123), a date (14/03/2027), an email address and a
//   hyphenated label (load-in) are each one token. A connector joins only
//   when both neighbours are word characters of the right sort: ":" and ","
//   between digits, "." between two digits or two letters, "'" and "&"
//   between letters, "-", "/" and "@" between any word characters. A
//   currency sign or "+" directly before a digit starts a word.
// - Terms are the words and symbols of a line, without punctuation. Quotes,
//   values and labels are compared term by term.

export class TextError extends Error {
  readonly kind: 'not_one_line';
  constructor(kind: 'not_one_line', message: string) {
    super(message);
    this.name = 'TextError';
    this.kind = kind;
  }
}

export type TokenType = 'word' | 'symbol' | 'punct';

export interface Token {
  readonly text: string;
  /** Offsets into the normalised line, in UTF-16 code units. */
  readonly start: number;
  readonly end: number;
  readonly type: TokenType;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: line breaks are what this matches
const LINE_BREAK = /\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/;
const INVISIBLE =
  /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;
// C0 and C1 controls other than tab and the line breaks split on above.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROL = /[\u0001-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g;
const SINGLE_QUOTES =
  /[\u2018\u2019\u201a\u201b\u2032\u2035`\u00b4\u02b9\u02bb\u02bc\u02bd\u2039\u203a\uff07]/g;
const DOUBLE_QUOTES =
  /[\u201c\u201d\u201e\u201f\u2033\u2036\u00ab\u00bb\u301d\u301e\u301f\uff02]/g;
const DASHES = /[\u2010-\u2015\u2212\u2e3a\u2e3b\ufe58\ufe63\uff0d]/g;
const SPACES = /\s+/g;

/** Removes NUL characters and unpaired surrogates; keeps everything else. */
export function stripUnsafe(text: string): string {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0) continue;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out.push(text.slice(i, i + 2));
        i++;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    out.push(text[i] as string);
  }
  return out.join('');
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/\u00df/g, 'ss')
    .replace(/\u03c2/g, '\u03c3')
    .normalize('NFKC');
}

function normalizeOneLine(line: string): string {
  return fold(line.replace(INVISIBLE, '').replace(CONTROL, ' '))
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .replace(SPACES, ' ')
    .trim();
}

/** Normalises text for comparison, keeping its line breaks as "\n". */
export function normalize(text: string): string {
  return splitLines(stripUnsafe(text).normalize('NFKC'))
    .map(normalizeOneLine)
    .join('\n');
}

/** Splits on every kind of line break, keeping empty lines. */
export function splitLines(text: string): string[] {
  return text.split(LINE_BREAK);
}

/**
 * Whether text holds any line break `splitLines` splits on (LF, CR, VT, FF,
 * NEL, LS, PS). A quote or value with one spans lines and is never joined.
 */
export function hasLineBreak(text: string): boolean {
  return LINE_BREAK.test(text);
}

const WORD_CHAR = /^[\p{L}\p{N}\p{M}_]$/u;
const LETTER = /^[\p{L}\p{M}]$/u;
const DIGIT = /^\p{Nd}$/u;
const SYMBOLS = new Set([
  '£',
  '$',
  '€',
  '¥',
  '+',
  '&',
  '@',
  '#',
  '%',
  '/',
  '~',
]);
const CURRENCY_SIGNS = new Set(['£', '$', '€', '¥']);

function charAt(text: string, index: number): string {
  if (index < 0 || index >= text.length) return '';
  const code = text.codePointAt(index);
  return code === undefined ? '' : String.fromCodePoint(code);
}

function charBefore(text: string, index: number): string {
  if (index <= 0) return '';
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2)
    return text.slice(index - 2, index);
  return text.slice(index - 1, index);
}

const isWord = (ch: string): boolean => ch !== '' && WORD_CHAR.test(ch);
const isLetter = (ch: string): boolean => ch !== '' && LETTER.test(ch);
const isDigit = (ch: string): boolean => ch !== '' && DIGIT.test(ch);

function connects(ch: string, prev: string, next: string): boolean {
  if (!isWord(next) || !isWord(prev)) return false;
  switch (ch) {
    case ':':
    case ',':
      return isDigit(prev) && isDigit(next);
    case '.':
      return (
        (isDigit(prev) && isDigit(next)) || (isLetter(prev) && isLetter(next))
      );
    case "'":
    case '&':
      return isLetter(prev) && isLetter(next);
    case '-':
    case '/':
    case '@':
      return true;
    default:
      return false;
  }
}

function consumeWord(line: string, from: number): number {
  let i = from;
  while (i < line.length) {
    const ch = charAt(line, i);
    if (isWord(ch)) {
      i += ch.length;
      continue;
    }
    if (connects(ch, charBefore(line, i), charAt(line, i + ch.length))) {
      i += ch.length;
      continue;
    }
    if (ch === '%' && isDigit(charBefore(line, i))) i += 1;
    break;
  }
  return i;
}

/** Tokens of one normalised line. */
export function tokenizeLine(line: string): Token[] {
  if (LINE_BREAK.test(line)) {
    throw new TextError(
      'not_one_line',
      'tokenizeLine takes one line; use tokenize'
    );
  }
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = charAt(line, i);
    if (/\s/u.test(ch)) {
      i += ch.length;
      continue;
    }
    const start = i;
    const next = charAt(line, i + ch.length);
    const startsWord =
      isWord(ch) ||
      (CURRENCY_SIGNS.has(ch) && isDigit(next)) ||
      (ch === '+' && isDigit(next) && !isWord(charBefore(line, i)));
    if (startsWord) {
      i = consumeWord(line, i + ch.length);
      tokens.push({ text: line.slice(start, i), start, end: i, type: 'word' });
      continue;
    }
    i += ch.length;
    tokens.push({
      text: ch,
      start,
      end: i,
      type: SYMBOLS.has(ch) ? 'symbol' : 'punct',
    });
  }
  return tokens;
}

/** Normalises text and gives each of its lines its own tokens. */
export function tokenize(text: string): Token[][] {
  return normalize(text).split('\n').map(tokenizeLine);
}

/** The words and symbols of a token list, without punctuation. */
export function terms(tokens: readonly Token[]): Token[] {
  return tokens.filter((t) => t.type !== 'punct');
}

/**
 * The terms of a short text (a value, a label, a phrase), normalised. A text
 * with a line break gives the terms of every line in order; callers that must
 * not join lines check for "\n" first.
 */
export function termsOf(text: string): string[] {
  return tokenize(text).flatMap((line) => terms(line).map((t) => t.text));
}

/** Start indices where `needle` occurs as a contiguous run of `hay`. */
export function findRuns(
  hay: readonly string[],
  needle: readonly string[],
  from = 0,
  to = hay.length
): number[] {
  const found: number[] = [];
  if (needle.length === 0) return found;
  for (let i = from; i + needle.length <= to; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) found.push(i);
  }
  return found;
}

/** Normalised words of a text joined by single spaces: a comparison key. */
export function termKey(text: string): string {
  return termsOf(text).join(' ');
}
