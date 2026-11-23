import { describe, expect, test } from 'bun:test';
import {
  cell,
  inferredTableLines,
  looksLikeHeader,
  tableLines,
} from '../../src/text/table';

describe('tableLines', () => {
  test('with a header row, each cell is "<header>: <value>" keyed by the row\'s first cell', () => {
    const rows = [
      [cell('Date'), cell('Call'), cell('Venue')],
      [cell('Fri 12 March 2027'), cell('07:00'), cell('Acme Arena')],
      [cell('Sat 13 March 2027'), cell('07:30 TBC'), undefined],
    ];
    expect(tableLines(rows, true)).toEqual([
      'Date: Fri 12 March 2027',
      'Fri 12 March 2027 · Call: 07:00',
      'Fri 12 March 2027 · Venue: Acme Arena',
      'Date: Sat 13 March 2027',
      'Sat 13 March 2027 · Call: 07:30 TBC',
    ]);
  });

  test('without a header row, a label and its value share a line and nothing else does', () => {
    const rows = [
      [cell('Venue'), cell('Acme Arena, Example Way, Leeds ZZ1 1ZZ')],
      [cell('Parking'), cell('Sample Lane car park')],
      [cell('Notes')],
    ];
    expect(tableLines(rows, false)).toEqual([
      'Venue: Acme Arena, Example Way, Leeds ZZ1 1ZZ',
      'Parking: Sample Lane car park',
      'Notes',
    ]);
  });

  test('a cell of several lines gives a line each, and a multi-line first cell is no key', () => {
    const rows = [
      [cell('Crew call'), cell('07:00 riggers\n08:00 lighting')],
      [cell('Fri 12 March\nMain stage'), cell('Load-in 08:00')],
    ];
    expect(tableLines(rows, false)).toEqual([
      'Crew call: 07:00 riggers',
      'Crew call: 08:00 lighting',
      'Fri 12 March',
      'Main stage',
      'Load-in 08:00',
    ]);
  });

  test('a first row is a header only when it is short, distinct text over three or more columns', () => {
    const header = [cell('Name'), cell('Role'), cell('Phone')];
    const data = [
      cell('Sam Price'),
      cell('Production manager'),
      cell('07700 900123', true),
    ];
    expect(looksLikeHeader([header, data])).toBe(true);
    expect(
      looksLikeHeader([
        [cell('Event'), cell('Leeds Lights Gala')],
        [cell('Crew call'), cell('07:00')],
      ])
    ).toBe(false);
    expect(
      looksLikeHeader([[cell('Date'), cell('2027', true), cell('Call')], data])
    ).toBe(false);
    expect(
      looksLikeHeader([[cell('Call'), cell('call'), cell('Venue')], data])
    ).toBe(false);
    expect(looksLikeHeader([header])).toBe(false);
  });

  test('title rows of one cell above a header row stand alone', () => {
    const rows = [
      [cell('LEEDS LIGHTS GALA - CREW SCHEDULE')],
      [cell('Name'), cell('Role'), cell('Call')],
      [cell('Sam Price'), cell('Lighting'), cell('07:00')],
    ];
    expect(inferredTableLines(rows)).toEqual([
      'LEEDS LIGHTS GALA - CREW SCHEDULE',
      'Name: Sam Price',
      'Sam Price · Role: Lighting',
      'Sam Price · Call: 07:00',
    ]);
    const facts = [
      [cell('PURCHASE ORDER')],
      [cell('PO'), cell('4500123', true)],
    ];
    expect(inferredTableLines(facts)).toEqual([
      'PURCHASE ORDER',
      'PO: 4500123',
    ]);
  });
});
