import { describe, expect, test } from 'bun:test';
import {
  findRuns,
  normalize,
  splitLines,
  stripUnsafe,
  TextError,
  termKey,
  terms,
  termsOf,
  tokenize,
  tokenizeLine,
} from '../src/normalize';

/** A character by code point, so invisible ones stay visible in the source. */
const ch = (code: number): string => String.fromCodePoint(code);

describe('normalize', () => {
  test('applies NFKC, so ligatures and full-width digits compare as plain text', () => {
    expect(normalize(`${ch(0xfb01)}nish`)).toBe('finish');
    expect(
      normalize(`Call ${ch(0xff10)}${ch(0xff18)}:${ch(0xff10)}${ch(0xff10)}`)
    ).toBe('call 08:00');
  });

  test('folds case, including the German sharp s', () => {
    expect(normalize('CREW CALL')).toBe('crew call');
    expect(normalize(`Gro${ch(0xdf)}e Halle`)).toBe('grosse halle');
  });

  test('gives one form to curly quotes and to every dash', () => {
    expect(
      normalize(
        `${ch(0x2018)}TBC${ch(0x2019)} and ${ch(0x201c)}blacks${ch(0x201d)}`
      )
    ).toBe(`'tbc' and "blacks"`);
    expect(
      normalize(
        `Fri 12 ${ch(0x2013)} Sun 14 ${ch(0x2014)} load${ch(0x2011)}in ${ch(0x2212)}1`
      )
    ).toBe('fri 12 - sun 14 - load-in -1');
  });

  test('collapses whitespace within a line, including non-breaking and narrow spaces', () => {
    expect(normalize(`  Crew\t  call${ch(0xa0)}${ch(0x202f)}07:00  `)).toBe(
      'crew call 07:00'
    );
  });

  test('removes NUL, unpaired surrogates, zero-width and bidirectional controls', () => {
    expect(normalize(`07${ch(0)}:00`)).toBe('07:00');
    expect(normalize(`PO ${String.fromCharCode(0xd800)}4500123`)).toBe(
      'po 4500123'
    );
    expect(normalize(`08${ch(0x200b)}:00`)).toBe('08:00');
    expect(normalize(`Rate ${ch(0x202e)}053${ch(0x202c)}`)).toBe('rate 053');
    expect(normalize(`a${ch(0xad)}b${ch(0xfeff)}`)).toBe('ab');
  });

  test('keeps a valid surrogate pair', () => {
    expect(stripUnsafe(`ok ${ch(0x1f3a4)}`)).toBe(`ok ${ch(0x1f3a4)}`);
    expect(stripUnsafe(`x${String.fromCharCode(0xdc00)}y`)).toBe('xy');
  });

  test('never joins lines: every kind of line break becomes its own line', () => {
    expect(normalize('Crew call\r\n07:00')).toBe('crew call\n07:00');
    expect(normalize(`Load-in${ch(0x2028)}08:00${ch(0x2029)}TBC`)).toBe(
      'load-in\n08:00\ntbc'
    );
    expect(splitLines('a\rb\nc')).toEqual(['a', 'b', 'c']);
    expect(
      tokenize('Crew call\n07:00').map((line) => line.map((t) => t.text))
    ).toEqual([['crew', 'call'], ['07:00']]);
  });

  test('tokenizeLine refuses a line break', () => {
    expect(() => tokenizeLine('call\n07:00')).toThrow(TextError);
    try {
      tokenizeLine('call\n07:00');
    } catch (error) {
      expect(error instanceof TextError && error.kind).toBe('not_one_line');
    }
  });
});

describe('tokens', () => {
  const words = (line: string): string[] =>
    tokenizeLine(normalize(line))
      .filter((t) => t.type === 'word')
      .map((t) => t.text);

  test('keeps times, amounts and references as single tokens', () => {
    expect(words('Crew call 08:00, rate £350.00, PO-4500123')).toEqual([
      'crew',
      'call',
      '08:00',
      'rate',
      '£350.00',
      'po-4500123',
    ]);
    expect(words('€1.200,00 and £1,200')).toEqual([
      '€1.200,00',
      'and',
      '£1,200',
    ]);
    expect(words('14/03/2027 14.03.27 8.30pm 0800hrs')).toEqual([
      '14/03/2027',
      '14.03.27',
      '8.30pm',
      '0800hrs',
    ]);
  });

  test('keeps hyphenated labels, abbreviations and email addresses whole', () => {
    expect(words('Load-in, get-in, P.O. and sam.price@example.com')).toEqual([
      'load-in',
      'get-in',
      'p.o',
      'and',
      'sam.price@example.com',
    ]);
    expect(words("H&S: isn't 10% o/t")).toEqual(['h&s', "isn't", '10%', 'o/t']);
  });

  test('splits a colon or comma that is not between digits', () => {
    expect(words('Call:07:00')).toEqual(['call', '07:00']);
    expect(words('Leeds,LS2')).toEqual(['leeds', 'ls2']);
    expect(words('approx.5')).toEqual(['approx', '5']);
  });

  test('a currency sign or + before a digit starts a word; standing alone it is a symbol', () => {
    const tokens = tokenizeLine(
      normalize('£350 + VAT, +44 7700 900123, £ 400')
    );
    expect(tokens.map((t) => [t.text, t.type])).toEqual([
      ['£350', 'word'],
      ['+', 'symbol'],
      ['vat', 'word'],
      [',', 'punct'],
      ['+44', 'word'],
      ['7700', 'word'],
      ['900123', 'word'],
      [',', 'punct'],
      ['£', 'symbol'],
      ['400', 'word'],
    ]);
  });

  test('offsets point into the normalised line', () => {
    const line = normalize('Crew call 07:00');
    for (const t of tokenizeLine(line))
      expect(line.slice(t.start, t.end)).toBe(t.text);
  });

  test('terms drop punctuation but keep symbols', () => {
    expect(
      terms(tokenizeLine(normalize('Rate: £350 + VAT (per day)'))).map(
        (t) => t.text
      )
    ).toEqual(['rate', '£350', '+', 'vat', 'per', 'day']);
    expect(termsOf('“Crew  CALL” – 07:00')).toEqual(['crew', 'call', '07:00']);
    expect(termKey('The  Example Hotel,')).toBe('the example hotel');
  });
});

describe('findRuns', () => {
  test('finds contiguous runs on token boundaries only', () => {
    expect(findRuns(['crew', 'call', '07:00'], ['call', '07:00'])).toEqual([1]);
    expect(findRuns(['leeds', 'lights', '2028'], ['8'])).toEqual([]);
    expect(findRuns(['a', 'b', 'a', 'b'], ['a', 'b'])).toEqual([0, 2]);
    expect(findRuns(['a', 'b', 'a', 'b'], ['a', 'b'], 1, 4)).toEqual([2]);
    expect(findRuns(['a'], [])).toEqual([]);
  });
});
