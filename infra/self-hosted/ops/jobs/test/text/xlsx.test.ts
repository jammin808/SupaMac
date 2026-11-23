import { describe, expect, test } from 'bun:test';
import { extract } from '../../src/text/extract';
import { LIMITS } from '../../src/text/types';
import {
  columnIndex,
  formatNumber,
  formatText,
  parseFormat,
  serialDate,
  serialTime,
} from '../../src/text/xlsx';
import { row, xlsx } from './build';

async function pages(bytes: Uint8Array, limits = LIMITS) {
  const outcome = await extract(bytes, {}, limits);
  if (!outcome.ok) throw new Error(outcome.refusal.reason);
  expect(outcome.value.type).toBe('xlsx');
  return outcome.value.text;
}

describe('number formats', () => {
  test('dates and times come from serials as YYYY-MM-DD and HH:MM when the format shows them whole', () => {
    expect(formatNumber(46458, 'dd/mm/yyyy')).toBe('2027-03-12');
    expect(formatNumber(46458, 'dddd, d mmmm yyyy')).toBe('Friday, 2027-03-12');
    expect(formatNumber(46458.2916666667, 'h:mm')).toBe('07:00');
    expect(formatNumber(0.8125, 'h:mm AM/PM')).toBe('19:30');
    expect(formatNumber(0.3125347, '[$-809]hh:mm:ss')).toBe('07:30:03');
    expect(formatNumber(46458.75, 'dd/mm/yyyy hh:mm')).toBe('2027-03-12 18:00');
    expect(formatNumber(1.5, '[h]:mm')).toBe('36:00');
    expect(formatNumber(44996, 'yyyy-mm-dd', true)).toBe('2027-03-12');
  });

  test('a format that leaves out the year, the day or the minutes is written as Excel shows it', () => {
    expect(formatNumber(46458, 'ddd d mmm')).toBe('Fri 12 Mar');
    expect(formatNumber(46458, 'd-mmm')).toBe('12-Mar');
    expect(formatNumber(46458, 'dd/mm')).toBe('12/03');
    expect(formatNumber(46458, 'mmm-yy')).toBe('Mar-27');
    expect(formatNumber(46458, 'mmmm yyyy')).toBe('March 2027');
    expect(formatNumber(0.8125, 'h AM/PM')).toBe('7 PM');
    expect(formatNumber(0.3125347, 'mm:ss')).toBe('30:03');
    expect(formatNumber(46458, 'dd/mm/yyyy" TBC"')).toBe('2027-03-12 TBC');
  });

  test('the section for the value applies, and an empty one shows nothing', () => {
    expect(formatNumber(900, ';;;')).toBe('');
    expect(formatNumber(0, '0;-0;;@')).toBe('');
    expect(formatNumber(-5, '0;-0;;@')).toBe('-5');
    expect(formatNumber(-350, '#,##0.00;(#,##0.00)')).toBe('(350.00)');
    expect(formatNumber(150, '[>=100]"over "0;"under "0')).toBe('over 150');
    expect(formatNumber(50, '[>=100]"over "0;"under "0')).toBe('under 50');
    expect(formatText('Rigger', ';;;')).toBe('');
    expect(formatText('Rigger', '0;-0;;"Role: "@')).toBe('Role: Rigger');
    expect(formatText('Rigger', '0.00')).toBe('Rigger');
  });

  test('the words and symbols a format writes stay with the number', () => {
    expect(formatNumber(350, '"£"#,##0"/day"')).toBe('£350/day');
    expect(formatNumber(350, '#,##0.00" + VAT"')).toBe('350.00 + VAT');
    expect(formatNumber(350, '"approx. "0')).toBe('approx. 350');
    expect(formatNumber(1500, '#,##0,"k"')).toBe('2k');
    expect(formatNumber(5551234, '000-0000')).toBe('555-1234');
    expect(formatNumber(0.5, '#.00')).toBe('.50');
    expect(formatNumber(350.25, '0.0#')).toBe('350.25');
    expect(formatNumber(350, '0.0#')).toBe('350.0');
  });

  test("the 1900 date system keeps Excel's own day numbers", () => {
    expect(serialDate(1, false)).toBe('1900-01-01');
    expect(serialDate(59, false)).toBe('1900-02-28');
    expect(serialDate(60, false)).toBe('1900-02-29');
    expect(serialDate(61, false)).toBe('1900-03-01');
    expect(serialDate(-1, false)).toBeUndefined();
    expect(serialTime(0.999999, false)).toBe('00:00');
  });

  test('numbers keep their decimals, separators, percent and the currency the format writes', () => {
    expect(formatNumber(350, '"£"#,##0.00')).toBe('£350.00');
    expect(formatNumber(1200, '[$€-x-euro2] #,##0.00')).toBe('€ 1,200.00');
    expect(formatNumber(1200.5, '#,##0.00 [$€-1]')).toBe('1,200.50 €');
    expect(formatNumber(45, '\\£0.00')).toBe('£45.00');
    expect(formatNumber(-25, '£#,##0;[Red]-£#,##0')).toBe('-£25');
    expect(formatNumber(0.175, '0.0%')).toBe('17.5%');
    expect(formatNumber(1234567.891, '#,##0')).toBe('1,234,568');
    expect(formatNumber(1.005, '0.00')).toBe('1.01');
    expect(formatNumber(0.1 + 0.2, 'General')).toBe('0.3');
    expect(formatNumber(4500123, 'General')).toBe('4500123');
  });

  test('the built-in currency formats store no symbol, so none is shown', () => {
    expect(parseFormat('#,##0.00').currency).toBeUndefined();
    expect(formatNumber(350, '#,##0.00')).toBe('350.00');
    expect(parseFormat('"GBP "#,##0').currency).toEqual({
      symbol: 'GBP',
      before: true,
    });
    expect(formatNumber(350, '"GBP "#,##0')).toBe('GBP 350');
  });

  test('cell references name zero-based columns', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('AB12')).toBe(27);
    expect(columnIndex('1A')).toBeUndefined();
  });
});

describe('Excel workbooks', () => {
  test('each cell is "<column header>: <value>" keyed by its row\'s first cell, in display format', async () => {
    const text = await pages(
      xlsx(
        [
          {
            name: 'Leeds crew',
            rows:
              row(1, ['Date', 'Call', 'Rate']) +
              row(2, [
                { v: 46458, s: 1 },
                { v: 0.2916666667, s: 2 },
                { v: 350, s: 3 },
              ]) +
              row(3, [{ v: 46459, s: 1 }, { v: 0.3125, s: 2 }, 'TBC']),
          },
        ],
        {
          numFmts:
            '<numFmt numFmtId="164" formatCode="&quot;£&quot;#,##0.00&quot;/day&quot;"/>',
          cellXfs:
            '<xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="20"/><xf numFmtId="164"/>',
        }
      )
    );
    expect(text.paged).toBe(false);
    expect(text.pages).toEqual([
      {
        page: 1,
        kind: 'text',
        lines: [
          'Leeds crew',
          'Date: 2027-03-12',
          '2027-03-12 · Call: 07:00',
          '2027-03-12 · Rate: £350.00/day',
          'Date: 2027-03-13',
          '2027-03-13 · Call: 07:30',
          '2027-03-13 · Rate: TBC',
        ],
      },
    ]);
  });

  test('skips hidden sheets, rows and columns, and reads sheets in workbook order', async () => {
    const text = await pages(
      xlsx([
        {
          name: 'Sheet1',
          rows:
            row(1, ['Venue', 'Acme Arena']) +
            row(2, ['Rate', 'secret'], ' hidden="1"'),
        },
        { name: 'Rates', state: 'hidden', rows: row(1, ['Rate', '£999']) },
        {
          name: 'Internal',
          state: 'veryHidden',
          rows: row(1, ['Margin', '40%']),
        },
        {
          name: 'Hotel',
          before: '<cols><col min="2" max="2" hidden="1"/></cols>',
          rows:
            row(1, ['Hotel', 'cost to client £180', 'Example Hotel Leeds']) +
            row(2, ['Zero', 'x', 'y'], ' customHeight="1" ht="0"'),
        },
      ])
    );
    expect(text.paged).toBe(true);
    expect(text.pages.map((p) => p.lines)).toEqual([
      ['Venue: Acme Arena'],
      ['Hotel', 'Hotel: Example Hotel Leeds'],
    ]);
  });

  test('reads shared strings with their runs, booleans, cached formula results and merged cells', async () => {
    const shared = xlsx(
      [
        {
          name: 'Sheet1',
          rows: [
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>',
            '<row r="2"><c r="A2" t="str"><f>A1</f><v>Parking</v></c><c r="B2" t="b"><v>1</v></c></row>',
            '<row r="3"><c r="B3" t="s"><v>2</v></c></row>',
          ].join(''),
          after: '<mergeCells count="1"><mergeCell ref="A2:A3"/></mergeCells>',
        },
      ],
      { strings: ['Crew call', '07:00', 'Sample Lane car park'] }
    );
    const text = await pages(shared);
    expect(text.pages[0]?.lines).toEqual([
      'Crew call: 07:00',
      'Parking: TRUE',
      'Parking: Sample Lane car park',
    ]);
  });

  test('refuses more filled cells than the limit rather than cutting the sheet short', async () => {
    let rows = '';
    for (let r = 1; r <= 30; r++) rows += row(r, ['Item', r]);
    const outcome = await extract(
      xlsx([{ name: 'Kit', rows }]),
      {},
      { ...LIMITS, maxCells: 50 }
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.kind).toBe('too_many_cells');
  });
});
