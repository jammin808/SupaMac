// Realistic UK live-events paperwork for the core tests. Every name, company,
// address and number is a placeholder: example.com domains, Acme Productions,
// Sam Price, 07700 900xxx numbers (Ofcom's drama range).

import type {
  CandidateDetail,
  SourceText,
  StoredDetail,
  TextPage,
} from '../src/model';

export function page(
  n: number,
  lines: string[],
  kind: TextPage['kind'] = 'text',
  date?: string
): TextPage {
  return date === undefined
    ? { page: n, kind, lines }
    : { page: n, kind, lines, date };
}

/** A two-page call sheet PDF for a two-day arena job, Fri 12 and Sat 13 March 2027. */
export const CALL_SHEET: SourceText = {
  paged: true,
  pages: [
    page(1, [
      'ACME PRODUCTIONS LTD - CALL SHEET v2',
      'Event: Leeds Lights Gala',
      'Client: Example Arts Trust',
      'Venue: Acme Arena, Example Way, Leeds ZZ1 1ZZ',
      'Issued: Wed 3 March 2027',
      'Job ref: LLG-27014',
      'PO: 4500123',
      'Production manager Sam Price 07700 900123, stage manager Alex Lee 07700 900456',
      'Fri 12 March 2027',
      'Load-in 08:00 or 09:00 TBC',
      'Crew call 07:00, performers 09:00',
      'Sat 13 March 2027',
      'Crew call 07:30',
      'Doors 18:30',
      'Show 19:30',
      'Load-out the following day 01:00',
      'Next year: Leeds Lights 2028',
    ]),
    page(2, [
      'Accommodation',
      'Hotel TBC, likely the Example Hotel',
      'Accommodation is not provided for local crew',
      'Parking: no parking on site; use the car park on Sample Lane',
      'Rate: £350/day + VAT',
      'Per diem £25',
      'Overtime £45/hr after 10 hours',
      'Payment terms: 30 days from invoice',
      'Dress code: show blacks',
      'Load in 8.30 for the second crew',
      'Call at 7 for riggers',
      'Second rate: £400 per day',
      'Get-in 08:00 (TBC)',
      'Get-out from 23:00. Not before the last guest leaves.',
      'Wi-Fi: AcmeCrew on the day',
      'Crew room: Room 2B, level 1',
    ]),
  ],
};

/** A hotel confirmation: one page, no page numbers. */
export const HOTEL: SourceText = {
  paged: false,
  pages: [
    page(1, [
      'Example Hotel Leeds - Booking confirmation',
      'Booking reference: MAL-77821',
      'Guest: Sam Price',
      'Hotel: Example Hotel Leeds, 1 Sample Mews, Leeds ZZ2 2ZZ',
      'Check-in: Fri 12 March 2027 from 15:00',
      'Check-out: Sun 14 March 2027 by 11:00',
      'Arrival 12/03/2027',
    ]),
  ],
};

/** A crew schedule that names its days without month or year. */
export const NO_YEAR: SourceText = {
  paged: false,
  pages: [
    page(1, [
      'CREW SCHEDULE',
      'Sat 13th',
      'Crew call 07:30',
      'Arrival 12/03/2027',
    ]),
  ],
};

/** The same schedule with an issue date stated in full on the page. */
export const ISSUED: SourceText = {
  paged: false,
  pages: [
    page(1, [
      'CREW SCHEDULE',
      'Issued 3 March 2027',
      'Sat 13th',
      'Crew call 07:30',
    ]),
  ],
};

/** The same schedule with the show day itself written in full on the page. */
export const SHOW_DAY_IN_FULL: SourceText = {
  paged: false,
  pages: [
    page(1, [
      'CREW SCHEDULE',
      'Show: Saturday 13 March 2027',
      'Sat 13th',
      'Crew call 07:30',
    ]),
  ],
};

/** Day headings by number, only the first with a date. */
export const DAY_HEADINGS: SourceText = {
  paged: false,
  pages: [
    page(1, [
      'DAY 1 - FRI 12 MARCH 2027',
      'Crew call 08:00',
      'DAY 2',
      'Crew call 07:30',
    ]),
  ],
};

/** A forwarded email: the new message and its quoted history. */
export const EMAIL: SourceText = {
  paged: true,
  pages: [
    page(
      1,
      [
        'Hi Sam, updated times below.',
        'Call time is now 08:00 on the Saturday.',
      ],
      'text',
      '2027-03-04T09:00:00Z'
    ),
    page(
      2,
      [
        'On 1 Mar 2027, at 10:15, Jo Bloggs wrote:',
        'Call time 07:00 on Sat 13 March 2027',
        'Rate £300 per day',
      ],
      'history',
      '2027-03-01T10:15:00Z'
    ),
  ],
};

/** A photographed call sheet: no text layer. */
export const PHOTO: SourceText = { paged: false, pages: [page(1, [], 'scan')] };

/** A purchase order. */
export const PURCHASE_ORDER: SourceText = {
  paged: false,
  pages: [
    page(1, [
      'PURCHASE ORDER',
      'PO 4500123 Supplier no. 88812',
      'Description: Lighting technician, Leeds Lights Gala, 12-13 March 2027',
      'Day rate £350 + VAT',
      'Payment terms: 30 days end of month',
      'Total EUR €1.200,00 / alt €1.200',
    ]),
  ],
};

export function candidate(
  fields: Partial<CandidateDetail> &
    Pick<CandidateDetail, 'field' | 'value' | 'quote'>
): CandidateDetail {
  return { label: '', ...fields };
}

let nextId = 1;

/** A stored detail with the defaults of a Found document detail. */
export function stored(
  fields: Partial<StoredDetail> & Pick<StoredDetail, 'field' | 'value'>
): StoredDetail {
  const id = fields.id ?? `d${nextId++}`;
  return {
    id,
    jobId: 'job-leeds',
    sourceId: 'src-1',
    label: '',
    quote: fields.quote ?? `${fields.field}: ${fields.value}`,
    status: 'Found',
    check: 'Found on p1: label',
    received: '2027-03-05T12:00:00Z',
    history: false,
    origin: 'document',
    ...fields,
  };
}
