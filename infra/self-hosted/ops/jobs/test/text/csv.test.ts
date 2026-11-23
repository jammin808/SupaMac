import { describe, expect, test } from 'bun:test';
import { csvLines, parseCsv, sniffDelimiter } from '../../src/text/csv';
import { extract } from '../../src/text/extract';
import { ExtractError, LIMITS } from '../../src/text/types';

describe('CSV', () => {
  test('parses RFC 4180 quoting: delimiters, doubled quotes and line breaks inside quotes', () => {
    const text =
      'Name,Role,Notes\r\n"Price, Sam",PM,"Say ""hi""\r\nat the door"\r\nAlex Lee,SM,\r\n';
    expect(parseCsv(text)).toEqual([
      ['Name', 'Role', 'Notes'],
      ['Price, Sam', 'PM', 'Say "hi"\r\nat the door'],
      ['Alex Lee', 'SM', ''],
    ]);
    expect(parseCsv('a,5" monitor,b')).toEqual([['a', '5" monitor', 'b']]);
  });

  test('takes the delimiter from the first record', () => {
    expect(sniffDelimiter('Date;Call;Venue\n12/03/2027;07:00;Acme')).toBe(';');
    expect(sniffDelimiter('Date\tCall\tVenue\n')).toBe('\t');
    expect(sniffDelimiter('"a;b",c,d\n')).toBe(',');
  });

  test('refuses a quoted field that is never closed', () => {
    expect(() => parseCsv('Venue,"Acme Arena\nCall,07:00')).toThrow(
      ExtractError
    );
  });

  test('writes each cell with its column header and row key, one line per line of a cell', () => {
    const text =
      'Date,Call,Notes\nFri 12 March 2027,07:00,"Riggers first\nLighting 08:00"\n';
    expect(csvLines(text, LIMITS)).toEqual([
      'Date: Fri 12 March 2027',
      'Fri 12 March 2027 · Call: 07:00',
      'Fri 12 March 2027 · Notes: Riggers first',
      'Fri 12 March 2027 · Notes: Lighting 08:00',
    ]);
  });

  test('is read as CSV only when the name or type says so, from text bytes', async () => {
    const bytes = new TextEncoder().encode('Venue,Acme Arena\nCall,07:00\n');
    const asCsv = await extract(bytes, { name: 'crew.csv' });
    expect(asCsv.ok && asCsv.value.type).toBe('csv');
    expect(asCsv.ok && asCsv.value.text.pages[0]?.lines).toEqual([
      'Venue: Acme Arena',
      'Call: 07:00',
    ]);
    const asText = await extract(bytes, { name: 'crew.txt' });
    expect(asText.ok && asText.value.text.pages[0]?.lines).toEqual([
      'Venue,Acme Arena',
      'Call,07:00',
    ]);
  });

  test('decodes Windows-1252, as Excel writes CSV', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('Rate,'),
      0xa3,
      ...new TextEncoder().encode('350\n'),
    ]);
    const outcome = await extract(bytes, { contentType: 'text/csv' });
    expect(outcome.ok && outcome.value.text.pages[0]?.lines).toEqual([
      'Rate: £350',
    ]);
  });
});
