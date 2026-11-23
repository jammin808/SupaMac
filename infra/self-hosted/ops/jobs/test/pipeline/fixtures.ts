// UK live-events paperwork for the pipeline's tests, built as real files
// (PDFs, MIME messages) so extraction runs on them, and the model's scripted
// replies to each. Every name, company, address and number is a placeholder:
// example.com domains, Acme Productions, Sam Price, ZZ postcodes.

import type { ExtractionReplyWire } from '../../src/ai/extract';
import { mime, pdf, png, textOps } from '../text/build';

/** A one-page PDF with a line of text per entry, top to bottom. */
export function pdfOf(lines: readonly string[]): Uint8Array {
  return pdf([
    textOps(lines.map((text, i) => ({ x: 72, y: 780 - i * 20, text }))),
  ]);
}

export const INVITE_PDF_LINES = [
  'ACME PRODUCTIONS LTD - BOOKING INVITE',
  'Issued: Mon 1 March 2027',
  'Job ref: LLG-27014',
  'PO: 4500123',
  'Fri 12 March 2027',
  'Crew call 07:00',
  'Sat 13 March 2027',
  'Crew call 07:30',
  'Hotel TBC, likely the Example Hotel',
];

export const INVITE_PDF = pdfOf(INVITE_PDF_LINES);

function base64Lines(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
}

/** The production company's booking email, with the invite attached. */
export function inviteEmail(
  options: { messageId?: string; date?: string } = {}
): Uint8Array {
  return mime([
    'From: Jo Bloggs <jo@acme-productions.example.com>',
    'To: Jobs <jobs@example.com>',
    'Subject: Leeds Lights Gala - booking',
    `Date: ${options.date ?? 'Mon, 1 Mar 2027 09:00:00 +0000'}`,
    `Message-ID: ${options.messageId ?? '<invite-1@acme-productions.example.com>'}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="m"',
    '',
    '--m',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hi Sam,',
    'We would like to book you for the Leeds Lights Gala.',
    'Event: Leeds Lights Gala',
    'Client: Example Arts Trust',
    'Venue: Acme Arena, Example Way, Leeds ZZ1 1ZZ',
    'Dates: 12-13 March 2027',
    'Rate: £350/day + VAT',
    'The invite is attached.',
    '--m',
    'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="invite.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(INVITE_PDF),
    '--m--',
    '',
  ]);
}

export const CALL_SHEET_PDF = pdfOf([
  'ACME PRODUCTIONS LTD - CALL SHEET v2',
  'Issued: Wed 3 March 2027',
  'Job ref: LLG-27014',
  'PO: 4500123',
  'Client: Example Arts Trust',
  'Sat 13 March 2027',
  'Crew call 08:00',
]);

export const HOTEL_PDF = pdfOf([
  'Example Hotel Leeds - Booking confirmation',
  'Booking reference: MAL-77821',
  'Hotel: Example Hotel Leeds, 1 Sample Mews, Leeds ZZ2 2ZZ',
  'Check-in: Fri 12 March 2027',
  'Check-out: Sun 14 March 2027',
]);

export const PO_PDF = pdfOf([
  'PURCHASE ORDER',
  'Order date: Thu 4 March 2027',
  'PO 4500123',
  'Client: Example Arts Trust',
  'Payment terms: 30 days end of month',
]);

export const PHOTO = png(800, 600);

type Detail = ExtractionReplyWire['details'][number];

function job(
  names: string[],
  references: string[] = [],
  dates: string[] = []
): ExtractionReplyWire['jobs'][number] {
  return { names, references, dates };
}

export const EMAIL_REPLY: ExtractionReplyWire = {
  source_kind: 'Invite',
  jobs: [job(['Leeds Lights Gala'], [], ['12-13 March 2027'])],
  details: [
    {
      field: 'Event',
      label: 'Event',
      value: 'Leeds Lights Gala',
      quote: 'Event: Leeds Lights Gala',
    },
    {
      field: 'Client',
      label: 'Client',
      value: 'Example Arts Trust',
      quote: 'Client: Example Arts Trust',
    },
    {
      field: 'Venue',
      label: 'Venue',
      value: 'Acme Arena, Example Way, Leeds ZZ1 1ZZ',
      quote: 'Venue: Acme Arena, Example Way, Leeds ZZ1 1ZZ',
    },
    {
      field: 'Dates',
      label: 'Dates',
      value: '12-13 March 2027',
      quote: 'Dates: 12-13 March 2027',
    },
    {
      field: 'Rate',
      label: 'Rate',
      value: '£350/day + VAT',
      quote: 'Rate: £350/day + VAT',
    },
  ],
};

const callTime = (value: string, day: string, heading: string): Detail => ({
  field: 'Call time',
  label: 'Crew call',
  value,
  quote: `Crew call ${value}`,
  page: 1,
  day,
  day_quote: heading,
});

export const INVITE_PDF_REPLY: ExtractionReplyWire = {
  source_kind: 'Invite',
  jobs: [job(['Leeds Lights Gala'], ['LLG-27014', '4500123'])],
  source_date: {
    date: '2027-03-01',
    quote: 'Issued: Mon 1 March 2027',
    page: 1,
  },
  details: [
    {
      field: 'Job reference',
      label: 'Job ref',
      value: 'LLG-27014',
      quote: 'Job ref: LLG-27014',
      page: 1,
    },
    {
      field: 'PO number',
      label: 'PO',
      value: '4500123',
      quote: 'PO: 4500123',
      page: 1,
    },
    callTime('07:00', '2027-03-12', 'Fri 12 March 2027'),
    callTime('07:30', '2027-03-13', 'Sat 13 March 2027'),
    {
      field: 'Hotel',
      label: 'Hotel',
      value: 'Example Hotel',
      quote: 'Hotel TBC, likely the Example Hotel',
      page: 1,
    },
  ],
};

export const CALL_SHEET_REPLY: ExtractionReplyWire = {
  source_kind: 'Call sheet',
  jobs: [job(['Leeds Lights Gala'], ['LLG-27014', '4500123'])],
  source_date: {
    date: '2027-03-03',
    quote: 'Issued: Wed 3 March 2027',
    page: 1,
  },
  details: [
    {
      field: 'Job reference',
      label: 'Job ref',
      value: 'LLG-27014',
      quote: 'Job ref: LLG-27014',
      page: 1,
    },
    {
      field: 'PO number',
      label: 'PO',
      value: '4500123',
      quote: 'PO: 4500123',
      page: 1,
    },
    {
      field: 'Client',
      label: 'Client',
      value: 'Example Arts Trust',
      quote: 'Client: Example Arts Trust',
      page: 1,
    },
    callTime('08:00', '2027-03-13', 'Sat 13 March 2027'),
  ],
};

export const HOTEL_REPLY: ExtractionReplyWire = {
  source_kind: 'Accommodation confirmation',
  jobs: [
    job(
      ['Example Hotel Leeds'],
      ['MAL-77821'],
      ['Fri 12 March 2027', 'Sun 14 March 2027']
    ),
  ],
  details: [
    {
      field: 'Booking reference',
      label: 'Booking reference',
      value: 'MAL-77821',
      quote: 'Booking reference: MAL-77821',
      page: 1,
    },
    {
      field: 'Hotel',
      label: 'Hotel',
      value: 'Example Hotel Leeds, 1 Sample Mews, Leeds ZZ2 2ZZ',
      quote: 'Hotel: Example Hotel Leeds, 1 Sample Mews, Leeds ZZ2 2ZZ',
      page: 1,
    },
    {
      field: 'Check-in',
      label: 'Check-in',
      value: 'Fri 12 March 2027',
      quote: 'Check-in: Fri 12 March 2027',
      page: 1,
    },
    {
      field: 'Check-out',
      label: 'Check-out',
      value: 'Sun 14 March 2027',
      quote: 'Check-out: Sun 14 March 2027',
      page: 1,
    },
  ],
};

export const PO_REPLY: ExtractionReplyWire = {
  source_kind: 'Purchase order',
  jobs: [job(['Leeds Lights Gala'], ['4500123'])],
  source_date: {
    date: '2027-03-04',
    quote: 'Order date: Thu 4 March 2027',
    page: 1,
  },
  details: [
    {
      field: 'PO number',
      label: 'PO',
      value: '4500123',
      quote: 'PO 4500123',
      page: 1,
    },
    {
      field: 'Client',
      label: 'Client',
      value: 'Example Arts Trust',
      quote: 'Client: Example Arts Trust',
      page: 1,
    },
    {
      field: 'Payment terms',
      label: 'Payment terms',
      value: '30 days end of month',
      quote: 'Payment terms: 30 days end of month',
      page: 1,
    },
  ],
};
