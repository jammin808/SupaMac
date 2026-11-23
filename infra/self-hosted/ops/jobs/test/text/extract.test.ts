import { describe, expect, test } from 'bun:test';
import { strToU8 } from 'fflate';
import { extract, looksLikeEmail, sniff } from '../../src/text/extract';
import { calendarLines, decodeText } from '../../src/text/plain';
import { LIMITS, REFUSAL_KINDS, REFUSAL_STATUS } from '../../src/text/types';
import { ftyp, gif, jpeg, png } from './build';

describe('sniff', () => {
  test('names the type from magic numbers alone', () => {
    expect(sniff(strToU8('%PDF-1.7\n'))).toEqual({ kind: 'pdf' });
    expect(sniff(strToU8('   \n%PDF-1.4'))).toEqual({ kind: 'pdf' });
    expect(sniff(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]))).toEqual({
      kind: 'zip',
    });
    expect(sniff(jpeg(10, 10))).toEqual({ kind: 'image', type: 'jpeg' });
    expect(sniff(png(10, 10))).toEqual({ kind: 'image', type: 'png' });
    expect(sniff(gif(10, 10))).toEqual({
      kind: 'unsupported',
      what: 'a GIF image',
    });
    expect(sniff(strToU8('RIFF\0\0\0\0WEBPVP8 '))).toEqual({
      kind: 'image',
      type: 'webp',
    });
    expect(sniff(ftyp('heic'))).toEqual({ kind: 'heic' });
    expect(sniff(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1]))).toMatchObject(
      { kind: 'unsupported' }
    );
    expect(sniff(strToU8('Crew call 07:00'))).toEqual({ kind: 'text' });
    expect(
      sniff(strToU8('From: a@example.com\nSubject: the %PDF-1.4 header\n'))
    ).toEqual({ kind: 'text' });
  });

  test('an email is a header block with From and one of the message headers', () => {
    expect(
      looksLikeEmail(
        'Received: by example.com\r\nFrom: a@example.com\r\nSubject: x\r\n\r\nbody'
      )
    ).toBe(true);
    expect(
      looksLikeEmail('From: a@example.com\nTo: b@example.com\n\nbody')
    ).toBe(true);
    expect(looksLikeEmail('Venue: Acme Arena\nCall: 07:00\n')).toBe(false);
    expect(
      looksLikeEmail(
        'From: the production office\nCrew call 07:00 for everyone\n'
      )
    ).toBe(false);
  });
});

describe('extract', () => {
  test('refuses empty, oversized and binary files with reasons the owner can read', async () => {
    const empty = await extract(new Uint8Array(0));
    expect(!empty.ok && empty.refusal).toEqual({
      kind: 'empty',
      reason: 'The file is empty.',
    });

    const big = await extract(
      new Uint8Array(2048),
      {},
      { ...LIMITS, maxBytes: 1024 }
    );
    expect(!big.ok && big.refusal.kind).toBe('too_large');
    expect(!big.ok && big.refusal.reason).toContain('2 KB');

    const binary = await extract(new Uint8Array([1, 2, 3, 0, 5, 6, 7, 8]));
    expect(!binary.ok && binary.refusal.kind).toBe('unsupported_type');
    expect(!binary.ok && binary.refusal.reason).toContain(
      'PDF, Word (.docx), Excel (.xlsx)'
    );
  });

  test('reads text files line by line, and marks big ones page text only', async () => {
    const text = strToU8('Crew call 07:00\r\n\r\nLoad-in 08:00\n');
    const small = await extract(text, { name: 'notes.txt' });
    expect(small.ok && small.value.text).toEqual({
      paged: false,
      pages: [
        { page: 1, kind: 'text', lines: ['Crew call 07:00', 'Load-in 08:00'] },
      ],
      pageTextOnly: false,
    });
    const large = await extract(text, {}, { ...LIMITS, pageTextOnlyBytes: 10 });
    expect(large.ok && large.value.text.pageTextOnly).toBe(true);
  });

  test('reads calendar files unfolded, with escaped line breaks as lines', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'SUMMARY:Leeds Lights Gala\\, load-in',
      'DTSTART:20270312T080000',
      'DESCRIPTION:Crew call 07:00\\nVenue: Acme Arena\\, Example Way\\, Leeds Z',
      ' Z1 1ZZ',
      'ATTACH;ENCODING=BASE64;VALUE=BINARY:QUFBQUFB',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const outcome = await extract(strToU8(ics), { name: 'invite.ics' });
    expect(outcome.ok && outcome.value.type).toBe('ics');
    expect(calendarLines(ics)).toEqual([
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'SUMMARY:Leeds Lights Gala, load-in',
      'DTSTART:20270312T080000',
      'DESCRIPTION:Crew call 07:00',
      'Venue: Acme Arena, Example Way, Leeds ZZ1 1ZZ',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
  });

  test('decodes UTF-8 with a byte order mark and UTF-16 with one', () => {
    expect(
      decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0xc2, 0xa3, 0x35]))
    ).toEqual({ text: '£5', encoding: 'utf-8' });
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0, 0x42, 0]))).toEqual({
      text: 'AB',
      encoding: 'utf-16le',
    });
  });

  test('sends emails to the email reader whatever they are named', async () => {
    const eml = strToU8(
      'From: Sam Price <sam@example.com>\r\nSubject: Leeds\r\nDate: Thu, 4 Mar 2027 09:00:00 +0000\r\n\r\nCrew call 07:00\r\n'
    );
    const outcome = await extract(eml, { name: 'message.txt' });
    expect(outcome.ok && outcome.value.type).toBe('eml');
    expect(outcome.ok && outcome.value.text.pages[0]?.lines).toEqual([
      'Crew call 07:00',
    ]);
  });

  test('text that is another format, or that its name or type says is one, is refused; text names pass', async () => {
    const refused: [string, { name?: string; contentType?: string }][] = [
      [
        '<svg xmlns="http://www.w3.org/2000/svg"><text>Rate: 900</text></svg>',
        {},
      ],
      ['<!DOCTYPE html><p>Crew call 07:00</p>', { name: 'notes.txt' }],
      ['{"rate": 900}', { name: 'notes.txt' }],
      ['BEGIN:VCARD\nFN:Sam Price\nEND:VCARD', {}],
      ['Crew call 07:00', { name: 'notes.html' }],
      ['Crew call 07:00', { name: 'booking.json' }],
      ['Crew call 07:00', { contentType: 'text/html; charset=utf-8' }],
      ['Crew call 07:00', { contentType: 'image/svg+xml' }],
    ];
    for (const [text, hint] of refused) {
      const outcome = await extract(strToU8(text), hint);
      expect([text, hint, !outcome.ok && outcome.refusal.kind]).toEqual([
        text,
        hint,
        'unsupported_type',
      ]);
    }
    const read: [string, { name?: string; contentType?: string }, string][] = [
      ['Crew call 07:00', { name: 'Leeds 12.03' }, 'txt'],
      ['Crew call 07:00', { name: 'call sheet.final' }, 'txt'],
      [
        'Crew call 07:00',
        { name: 'pack.pdf', contentType: 'application/pdf' },
        'txt',
      ],
      [
        'Role,Rate\nRigger,350',
        { name: 'crew.csv', contentType: 'application/vnd.ms-excel' },
        'csv',
      ],
      [
        '[TBC] Crew call 07:00',
        { name: 'notes.txt', contentType: 'text/plain' },
        'txt',
      ],
    ];
    for (const [text, hint, type] of read) {
      const outcome = await extract(strToU8(text), hint);
      expect([text, outcome.ok && outcome.value.type]).toEqual([text, type]);
    }
  });

  test('a header block whose From holds no address is text, not an email', async () => {
    expect(
      looksLikeEmail(
        'From: London Kings Cross\nTo: Leeds\nDate: Friday 3 April 2026\n\nDeparts 08:03\n'
      )
    ).toBe(false);
    expect(
      looksLikeEmail(
        'From:\n "Sam Price" <sam@example.com>\nSubject: x\n\nbody'
      )
    ).toBe(true);
  });

  test('every refusal kind has a Sources status; only sandbox failures can be retried', () => {
    for (const kind of REFUSAL_KINDS)
      expect(['Skipped', 'Failed']).toContain(REFUSAL_STATUS[kind]);
    expect(REFUSAL_KINDS.filter((k) => REFUSAL_STATUS[k] === 'Failed')).toEqual(
      ['timeout', 'memory', 'crashed', 'bad_output']
    );
  });
});
