// The jobs service's vocabulary (docs/supamac/jobs.md): the detail fields,
// their value kinds and label words, the statuses, and the shapes every other
// module passes around.
//
// Invariants:
// - Field, status, kind and option names here are the exact strings stored in
//   the Jobs database's select columns; nothing else names them.
// - A field's label words are written as they appear in UK production
//   paperwork. They are compared after `normalize` on token boundaries, so
//   case, quote marks and dashes do not matter, but a hyphen inside a word
//   does ("load-in" and "load in" are listed separately).
// - Only Contact and Travel accumulate unconditionally. Call time and Hotel
//   accumulate across days (one per day, a night for Hotel), which the
//   replacement scope (job, field, day, label) already gives them; within one
//   day and label they are single-valued like every other field.
// - A sensitive field's change never replaces a value by itself (design §6).
// - Every day a detail names (its `day`, and every full date its value
//   writes) feeds the Jobs row's Days column; `column` says which other
//   column, if any, the field feeds.
// - Check 2 needs a label that names the field alone: a label word that is
//   also another field's (of the same value kind), or that sits inside a
//   longer label of another field, does not name it (checks.ts). Generic
//   words that name no field on their own ("cost", "price", "budget") are
//   left out of the lexicons.
// - Every Details and Sources column of the design holds what it names. The
//   fields of `StoredDetail` and `SourceRecord` with no column of their own
//   live in the service's state volume, keyed by the row id, and are written
//   in the same step as the row (see each field). A reader that finds no such
//   record must leave them unknown, never fill them from another column.

import { z } from 'zod';

export const FIELD_NAMES = [
  'Event',
  'Client',
  'Production company',
  'Role',
  'Job reference',
  'PO number',
  'Dates',
  'Venue',
  'Venue address',
  'Access and parking',
  'Call time',
  'Load-in',
  'Show time',
  'Load-out',
  'Finish',
  'Travel',
  'Travel booked by',
  'Hotel',
  'Hotel address',
  'Check-in',
  'Check-out',
  'Booking reference',
  'Per diem',
  'Rate',
  'Overtime',
  'Payment terms',
  'Invoice to',
  'Contact',
  'Dress code',
  'Catering',
  'Kit to bring',
  'Credentials and passes',
  'Health and safety',
  'Other',
] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

export const VALUE_KINDS = [
  'text',
  'date',
  'date_range',
  'time',
  'amount',
  'reference',
  'contact',
] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

/** The kinds whose value is parsed and compared with the quote's own entity. */
export type TypedKind = 'date' | 'date_range' | 'time' | 'amount' | 'reference';

export function isTypedKind(kind: ValueKind): kind is TypedKind {
  return kind !== 'text' && kind !== 'contact';
}

/**
 * How values of one field live side by side:
 * - `single`: within (job, field, day, label) a newer value replaces an older;
 * - `per_day`: the same, named for the fields that hold one value per day or
 *   night (Call time, Hotel), so the Jobs row lists them by day;
 * - `many`: every value stays (Contact, Travel).
 */
export type Multiplicity = 'single' | 'per_day' | 'many';

export const JOBS_COLUMNS = [
  'Name',
  'Booking',
  'Dates',
  'Days',
  'Client',
  'Production company',
  'Event',
  'Role',
  'Venue',
  'Venue address',
  'Call times',
  'Travel',
  'Accommodation',
  'Contacts',
  'PO number',
  'Job reference',
  'Rate',
  'Currency',
  'Rate basis',
  'Payment terms',
  'Invoice to',
  'Not confirmed',
  'Needs review',
  'Updated',
] as const;
export type JobsColumn = (typeof JOBS_COLUMNS)[number];

export type JobsColumnType =
  | 'title'
  | 'select'
  | 'date_range'
  | 'date'
  | 'text'
  | 'number'
  | 'tags';

export const JOBS_COLUMN_TYPES: Readonly<Record<JobsColumn, JobsColumnType>> = {
  Name: 'title',
  Booking: 'select',
  Dates: 'date_range',
  Days: 'text',
  Client: 'text',
  'Production company': 'text',
  Event: 'text',
  Role: 'text',
  Venue: 'text',
  'Venue address': 'text',
  'Call times': 'text',
  Travel: 'text',
  Accommodation: 'text',
  Contacts: 'text',
  'PO number': 'text',
  'Job reference': 'text',
  Rate: 'number',
  Currency: 'text',
  'Rate basis': 'text',
  'Payment terms': 'text',
  'Invoice to': 'text',
  'Not confirmed': 'tags',
  'Needs review': 'number',
  Updated: 'date',
};

/** The Jobs columns the service derives from details (design §6). */
export const DERIVED_COLUMNS = JOBS_COLUMNS.filter(
  (c): c is DerivedColumn => c !== 'Name' && c !== 'Booking' && c !== 'Updated'
);
export type DerivedColumn = Exclude<JobsColumn, 'Name' | 'Booking' | 'Updated'>;

/** Which Jobs column a field feeds, and by which rule of design §6. */
export type ColumnRule =
  | { readonly rule: 'newest'; readonly column: DerivedColumn }
  | { readonly rule: 'dates' }
  | { readonly rule: 'by_day'; readonly column: 'Call times' | 'Travel' }
  | {
      readonly rule: 'accommodation';
      readonly part: 'hotel' | 'check_in' | 'check_out';
    }
  | { readonly rule: 'list'; readonly column: 'Contacts' }
  | { readonly rule: 'rate' }
  | { readonly rule: 'none' };

export interface FieldSpec {
  readonly name: FieldName;
  readonly kind: ValueKind;
  /** Label words and phrases; empty for Other, whose label is the model's. */
  readonly labels: readonly string[];
  readonly multiplicity: Multiplicity;
  readonly sensitive: boolean;
  readonly column: ColumnRule;
}

function spec(
  name: FieldName,
  kind: ValueKind,
  labels: readonly string[],
  column: ColumnRule,
  options: { multiplicity?: Multiplicity; sensitive?: boolean } = {}
): FieldSpec {
  return {
    name,
    kind,
    labels,
    multiplicity: options.multiplicity ?? 'single',
    sensitive: options.sensitive ?? false,
    column,
  };
}

const NONE: ColumnRule = { rule: 'none' };

export const FIELDS: Readonly<Record<FieldName, FieldSpec>> = {
  Event: spec(
    'Event',
    'text',
    [
      'event',
      'event name',
      'event title',
      'show',
      'show name',
      'production',
      'project',
      'project name',
      'job name',
      'job title',
      'gig',
      'tour',
      'festival',
      'conference',
      'awards',
      'launch',
      'title',
    ],
    { rule: 'newest', column: 'Event' }
  ),
  Client: spec(
    'Client',
    'text',
    [
      'client',
      'client name',
      'end client',
      'customer',
      'brand',
      'on behalf of',
      'for client',
      'account',
    ],
    { rule: 'newest', column: 'Client' }
  ),
  'Production company': spec(
    'Production company',
    'text',
    [
      'production company',
      'production co',
      'prod co',
      'prodco',
      'production',
      'producer',
      'produced by',
      'agency',
      'crew agency',
      'company',
      'contractor',
      'hiring company',
      'booking company',
    ],
    { rule: 'newest', column: 'Production company' }
  ),
  Role: spec(
    'Role',
    'text',
    [
      'role',
      'your role',
      'crew role',
      'job role',
      'position',
      'booked as',
      'working as',
      'department',
      'dept',
      'grade',
      'job title',
    ],
    { rule: 'newest', column: 'Role' }
  ),
  'Job reference': spec(
    'Job reference',
    'reference',
    [
      'job ref',
      'job reference',
      'job no',
      'job number',
      'job #',
      'job code',
      'job id',
      'project ref',
      'project reference',
      'project no',
      'project number',
      'project code',
      'ref',
      'reference',
      'our ref',
      'your ref',
      'quote ref',
      'quote no',
    ],
    { rule: 'newest', column: 'Job reference' }
  ),
  'PO number': spec(
    'PO number',
    'reference',
    [
      'po',
      'p.o.',
      'p/o',
      'po no',
      'po number',
      'po #',
      'po ref',
      'purchase order',
      'purchase order no',
      'purchase order number',
      'order no',
      'order number',
      'order ref',
      'order #',
    ],
    { rule: 'newest', column: 'PO number' }
  ),
  Dates: spec(
    'Dates',
    'date_range',
    [
      'date',
      'dates',
      'event date',
      'event dates',
      'show date',
      'show dates',
      'job date',
      'job dates',
      'booking date',
      'booking dates',
      'working date',
      'working dates',
      'dates required',
      'day',
      'days',
      'when',
    ],
    { rule: 'dates' }
  ),
  Venue: spec(
    'Venue',
    'text',
    [
      'venue',
      'venue name',
      'location',
      'site',
      'held at',
      'taking place at',
      'where',
      'place',
    ],
    { rule: 'newest', column: 'Venue' }
  ),
  'Venue address': spec(
    'Venue address',
    'text',
    [
      'address',
      'venue address',
      'site address',
      'location',
      'postcode',
      'post code',
      'sat nav',
      'satnav',
      'what3words',
      'directions',
    ],
    { rule: 'newest', column: 'Venue address' }
  ),
  'Access and parking': spec(
    'Access and parking',
    'text',
    [
      'access',
      'access via',
      'parking',
      'car park',
      'car parking',
      'park',
      'loading bay',
      'loading dock',
      'dock',
      'stage door',
      'crew entrance',
      'entrance',
      'vehicle access',
      'unloading',
      'get in via',
      'gate',
      'barrier',
      'permit',
    ],
    NONE
  ),
  'Call time': spec(
    'Call time',
    'time',
    [
      'call',
      'crew call',
      'call time',
      'calltime',
      'calls',
      'report',
      'report time',
      'report to',
      'reporting',
      'arrive',
      'arrival',
      'arrival time',
      'start',
      'start time',
      'on site',
      'on-site',
      'be on site',
      'meet',
      'meet time',
      'rv',
    ],
    { rule: 'by_day', column: 'Call times' },
    { multiplicity: 'per_day' }
  ),
  'Load-in': spec(
    'Load-in',
    'time',
    [
      'load-in',
      'load in',
      'loadin',
      'load-in time',
      'get-in',
      'get in',
      'getin',
      'get-in time',
      'bump-in',
      'bump in',
      'build',
      'rig',
      'install',
    ],
    NONE
  ),
  'Show time': spec(
    'Show time',
    'time',
    [
      'show',
      'show time',
      'showtime',
      'show start',
      'show call',
      'doors',
      'doors open',
      'curtain',
      'curtain up',
      'performance',
      'perf',
      'set time',
      'stage time',
      'on stage',
      'live',
      'go live',
      'event start',
      'kick off',
      'kick-off',
      'start',
      'start time',
      'begins',
    ],
    NONE
  ),
  'Load-out': spec(
    'Load-out',
    'time',
    [
      'load-out',
      'load out',
      'loadout',
      'get-out',
      'get out',
      'getout',
      'bump-out',
      'bump out',
      'de-rig',
      'derig',
      'strike',
      'breakdown',
      'break down',
      'out',
    ],
    NONE
  ),
  Finish: spec(
    'Finish',
    'time',
    [
      'finish',
      'finish time',
      'finishing',
      'end',
      'end time',
      'ends',
      'wrap',
      'wrap time',
      'release',
      'released',
      'curfew',
      'until',
      'till',
      'done by',
      'clear by',
      'out by',
      'venue close',
    ],
    NONE
  ),
  Travel: spec(
    'Travel',
    'text',
    [
      'travel',
      'travelling',
      'traveling',
      'train',
      'trains',
      'rail',
      'flight',
      'flights',
      'fly',
      'flying',
      'outbound',
      'inbound',
      'return',
      'depart',
      'departs',
      'departing',
      'departure',
      'arrives',
      'coach',
      'bus',
      'ferry',
      'eurostar',
      'transfer',
      'taxi',
      'cab',
      'car',
      'drive',
      'driving',
      'pick up',
      'pick-up',
      'pickup',
      'ticket',
      'tickets',
      'e-ticket',
      'seat',
      'van',
    ],
    { rule: 'by_day', column: 'Travel' },
    { multiplicity: 'many' }
  ),
  'Travel booked by': spec(
    'Travel booked by',
    'text',
    [
      'booked by',
      'travel booked by',
      'arranged by',
      'travel arranged by',
      'organised by',
      'organized by',
      'booking by',
      'booked through',
      'travel booking',
      'book your own',
      'self book',
      'self-book',
      'self-booked',
      'we will book',
      'we will arrange',
      'to be booked by',
      'tickets booked by',
    ],
    NONE
  ),
  Hotel: spec(
    'Hotel',
    'text',
    [
      'hotel',
      'hotel name',
      'accommodation',
      'accom',
      'staying at',
      'stay at',
      'your stay',
      'staying',
      'stay',
      'lodging',
      'digs',
      'room',
      'rooms',
      'room type',
      'nights at',
      'night at',
      'reservation at',
      'booked into',
      'property',
    ],
    { rule: 'accommodation', part: 'hotel' },
    { multiplicity: 'per_day' }
  ),
  'Hotel address': spec(
    'Hotel address',
    'text',
    [
      'hotel address',
      'address',
      'postcode',
      'post code',
      'located at',
      'location',
    ],
    NONE
  ),
  'Check-in': spec(
    'Check-in',
    'date',
    [
      'check-in',
      'check in',
      'checkin',
      'check-in date',
      'arrival',
      'arrival date',
      'arriving',
      'arrive',
    ],
    { rule: 'accommodation', part: 'check_in' }
  ),
  'Check-out': spec(
    'Check-out',
    'date',
    [
      'check-out',
      'check out',
      'checkout',
      'check-out date',
      'departure',
      'departure date',
      'departing',
      'depart',
    ],
    { rule: 'accommodation', part: 'check_out' }
  ),
  'Booking reference': spec(
    'Booking reference',
    'reference',
    [
      'booking ref',
      'booking reference',
      'booking no',
      'booking number',
      'booking id',
      'confirmation',
      'confirmation no',
      'confirmation number',
      'confirmation code',
      'conf no',
      'conf',
      'reservation',
      'reservation no',
      'reservation number',
      'reservation ref',
      'ref',
      'reference',
      'ticket ref',
      'collection ref',
      'collection reference',
      'collection code',
      'pnr',
      'e-ticket',
      'itinerary',
    ],
    NONE,
    { sensitive: true }
  ),
  'Per diem': spec(
    'Per diem',
    'amount',
    [
      'per diem',
      'per diems',
      'pd',
      'p.d.',
      'p/d',
      'daily allowance',
      'allowance',
      'subsistence',
      'meal allowance',
      'food allowance',
      'buyout',
      'buy-out',
      'meal buyout',
      'expenses',
      'daily expenses',
    ],
    NONE,
    { sensitive: true }
  ),
  Rate: spec(
    'Rate',
    'amount',
    [
      'rate',
      'fee',
      'fees',
      'day rate',
      'daily rate',
      'hourly rate',
      'rate of pay',
      'pay',
      'pay rate',
      'agreed rate',
      'flat fee',
      'fixed fee',
      'wage',
      'remuneration',
    ],
    { rule: 'rate' },
    { sensitive: true }
  ),
  Overtime: spec(
    'Overtime',
    'amount',
    [
      'overtime',
      'ot',
      'o/t',
      'over time',
      'additional hours',
      'additional hour',
      'per additional hour',
      'extra hours',
      'time and a half',
      'double time',
    ],
    NONE
  ),
  'Payment terms': spec(
    'Payment terms',
    'text',
    [
      'payment terms',
      'terms',
      'terms of payment',
      'payment',
      'paid',
      'payable',
      'pay within',
      'paid within',
      'payment within',
      'net',
      'invoice terms',
      'settlement',
      'settled',
    ],
    { rule: 'newest', column: 'Payment terms' },
    { sensitive: true }
  ),
  'Invoice to': spec(
    'Invoice to',
    'text',
    [
      'invoice to',
      'invoices to',
      'invoice',
      'invoices',
      'invoicing',
      'bill to',
      'billing',
      'billing address',
      'accounts',
      'accounts payable',
      'send invoices',
      'invoice address',
      'finance',
      'remittance',
      'raise invoice',
    ],
    { rule: 'newest', column: 'Invoice to' },
    { sensitive: true }
  ),
  Contact: spec(
    'Contact',
    'contact',
    [
      'contact',
      'contacts',
      'contact name',
      'on the day contact',
      'on the day',
      'day contact',
      'onsite contact',
      'on-site contact',
      'site contact',
      'point of contact',
      'poc',
      'production manager',
      'pm',
      'stage manager',
      'sm',
      'tour manager',
      'tm',
      'site manager',
      'event manager',
      'crew chief',
      'crew boss',
      'head of',
      'coordinator',
      'co-ordinator',
      'producer',
      'manager',
      'director',
      'lead',
      'phone',
      'tel',
      'telephone',
      'mobile',
      'mob',
      'email',
      'e-mail',
      'call',
      'ring',
      'text',
      'whatsapp',
    ],
    { rule: 'list', column: 'Contacts' },
    { multiplicity: 'many' }
  ),
  'Dress code': spec(
    'Dress code',
    'text',
    [
      'dress code',
      'dress',
      'attire',
      'wear',
      'wearing',
      'uniform',
      'clothing',
      'clothes',
      'blacks',
      'show blacks',
      'all black',
      'smart casual',
      'black tie',
      'branded',
    ],
    NONE
  ),
  Catering: spec(
    'Catering',
    'text',
    [
      'catering',
      'catered',
      'crew catering',
      'food',
      'meal',
      'meals',
      'hot meal',
      'lunch',
      'dinner',
      'breakfast',
      'refreshments',
      'drinks',
      'snacks',
      'craft',
      'green room',
      'water',
    ],
    NONE
  ),
  'Kit to bring': spec(
    'Kit to bring',
    'text',
    [
      'kit',
      'kit list',
      'own kit',
      'bring',
      'please bring',
      'what to bring',
      'tools',
      'tool',
      'toolkit',
      'tool kit',
      'equipment',
      'you will need',
      'required',
      'torch',
      'ppe',
    ],
    NONE
  ),
  'Credentials and passes': spec(
    'Credentials and passes',
    'text',
    [
      'pass',
      'passes',
      'crew pass',
      'accreditation',
      'accredited',
      'credentials',
      'credential',
      'laminate',
      'laminates',
      'lanyard',
      'wristband',
      'wristbands',
      'badge',
      'badges',
      'id',
      'photo id',
      'aaa',
      'access all areas',
      'guest list',
    ],
    NONE
  ),
  'Health and safety': spec(
    'Health and safety',
    'text',
    [
      'health and safety',
      'health & safety',
      'h&s',
      'h & s',
      'safety',
      'risk assessment',
      'rams',
      'method statement',
      'ppe',
      'hard hat',
      'hard hats',
      'hi-vis',
      'hi vis',
      'high vis',
      'high-vis',
      'steel toe',
      'steel toecaps',
      'steel toe caps',
      'safety boots',
      'toe-caps',
      'induction',
      'site induction',
      'first aid',
      'cscs',
      'ipaf',
      'pasma',
      'working at height',
      'fire',
    ],
    NONE
  ),
  Other: spec('Other', 'text', [], NONE),
};

/**
 * Words and phrases that hedge or negate a value. A line holding one that
 * the value leaves out needs review (design §4, check 3). "no" glued to ".",
 * ":" or "#" ("PO no. 4500123"), or between a numbered noun and a reference
 * ("PO no 4500123"), and "may" inside a date are abbreviations and month
 * names, not hedges; checks.ts makes those exceptions. Any word ending in
 * "n't", and a number ending in "ish" ("7ish"), also hedge.
 */
export const HEDGE_WORDS: readonly string[] = [
  'not',
  'no',
  'cannot',
  'neither',
  'nor',
  'none',
  'nil',
  'never',
  'without',
  'n/a',
  'tbc',
  'tba',
  'tbd',
  't.b.c.',
  't.b.a.',
  't.b.d.',
  'to be confirmed',
  'to be advised',
  'to be agreed',
  'to be decided',
  'to be arranged',
  'to confirm',
  'unconfirmed',
  'provisional',
  'provisionally',
  'pencil',
  'pencilled',
  'penciled',
  'on hold',
  'hold',
  'option',
  'optional',
  'options',
  'approx',
  'approximately',
  'circa',
  'c',
  'ca',
  'around',
  'about',
  'roughly',
  'est',
  'estimate',
  'estimates',
  'estimated',
  'likely',
  'unlikely',
  'possibly',
  'possible',
  'probably',
  'perhaps',
  'maybe',
  'may',
  'might',
  'could',
  'should',
  'expected',
  'expect',
  'hopefully',
  'ideally',
  'tentative',
  'tentatively',
  'ish',
  'negotiable',
  'ono',
  'up to',
  'or so',
  'give or take',
  'unknown',
  'unclear',
  'unsure',
  'unable',
  'unavailable',
  'yet to',
  'still to',
  'to follow',
  'or',
  'either',
  'if',
  'unless',
  'except',
  'subject to',
  'pending',
  'awaiting',
  'depending',
  'depends',
  'was',
  'previously',
  'formerly',
  'instead',
  'cancelled',
  'canceled',
  'postponed',
  '~',
];

export const DETAIL_STATUSES = [
  'Found',
  'Needs review',
  'Confirmed',
  'Rejected',
  'Replaced',
] as const;
export type DetailStatus = (typeof DETAIL_STATUSES)[number];

/** What the checks can give a detail; only the owner gives the others. */
export type CheckedStatus = 'Found' | 'Needs review';

/** Details whose value a Jobs row may show. */
export function isCurrent(status: DetailStatus): boolean {
  return status === 'Found' || status === 'Confirmed';
}

export const SOURCE_STATUSES = [
  'Processing',
  'Processed',
  'Needs review',
  'Not a job',
  'Skipped',
  'Failed',
] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** What a source is, as the extraction names it (design §3). */
export const SOURCE_KINDS = [
  'Invite',
  'Production pack',
  'Purchase order',
  'Call sheet',
  'Travel confirmation',
  'Accommodation confirmation',
  'Other',
  'Not about a job',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Kinds that may start a new job when nothing on file matches them. */
export const JOB_STARTING_KINDS: readonly SourceKind[] = [
  'Invite',
  'Production pack',
  'Purchase order',
  'Call sheet',
];

export const VIA_OPTIONS = ['Email', 'Telegram', 'Folder', 'Note'] as const;
export type Via = (typeof VIA_OPTIONS)[number];

/** Written by the owner only; empty on a new job. */
export const BOOKING_OPTIONS = [
  'Enquiry',
  'Pencilled',
  'Booked',
  'Completed',
  'Cancelled',
] as const;
export type Booking = (typeof BOOKING_OPTIONS)[number];

/** Whether `text` is `YYYY-MM-DD` and names a day of the calendar. */
export function isCalendarDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] as number);
}

/** `YYYY-MM-DD`, a calendar date in the owner's zone; 2027-02-30 is refused. */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a calendar date as YYYY-MM-DD')
  .refine(isCalendarDate, 'a day of the calendar');

/**
 * One detail as the extraction model returns it (design §3). The
 * descriptions reach the model through the structured-output schema.
 */
export const CandidateDetailSchema = z.object({
  field: z.enum(FIELD_NAMES).describe("The detail's field."),
  label: z
    .string()
    .describe(
      'The label as written in the quote, copied; for Other, the only label.'
    ),
  value: z
    .string()
    .describe(
      'The value, copied from the quote with its hedges and tax words ("TBC", "approx.", "plus VAT"); one value per detail.'
    ),
  day: IsoDateSchema.describe(
    'The day the detail is for, as YYYY-MM-DD, only when the quote or a date heading above it writes that day.'
  ).optional(),
  day_quote: z
    .string()
    .describe(
      'When the quote has no date: the nearest date heading above the quote on the same page, copied.'
    )
    .optional(),
  quote: z
    .string()
    .describe(
      'One line or table cell of the source, copied character for character, holding the label and the value.'
    ),
  page: z
    .number()
    .int()
    .positive()
    .describe('The page the quote is on, as the source text numbers it.')
    .optional(),
  job: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Which of the reply's jobs the detail describes, counted from 0; left out when the source describes one job."
    )
    .optional(),
});
export type CandidateDetail = z.infer<typeof CandidateDetailSchema>;

/**
 * Where a page's text came from:
 * - `text`: a text layer, document body or cell the service read itself;
 * - `scan`: an image, a scanned page or invisible text over an image, read
 *   only by the model, so nothing on it can be checked;
 * - `history`: quoted history or a forwarded message inside an email, with
 *   its own date.
 */
export type PageKind = 'text' | 'scan' | 'history';

export interface TextPage {
  /** 1-based, as `[S2 p3]` numbers it. */
  readonly page: number;
  readonly kind: PageKind;
  /** A history page's own date (ISO date or instant), when it is written. */
  readonly date?: string | undefined;
  /** A history page's own sender, as its header writes it. */
  readonly from?: string | undefined;
  /**
   * Why some of the page's text may not show where it was read (white text
   * with no background the service can see, a stylesheet that hides text in
   * ways it cannot follow): every detail from the page needs review.
   */
  readonly unsure?: string | undefined;
  /** Extracted lines in reading order; a table cell is a line of its own. */
  readonly lines: readonly string[];
}

/**
 * A source's text as the service extracted it. An image or photo is one
 * `scan` page with no lines; a source with no pages at all is treated as one,
 * so every detail from it needs review.
 */
export interface SourceText {
  readonly pages: readonly TextPage[];
  /** True for a source with real pages (a PDF); a quote must then name one. */
  readonly paged: boolean;
  /**
   * True when the file was over 600 pages or 25 MiB and only its page text
   * was read (design §2); the Sources row's Note says so.
   */
  readonly pageTextOnly?: boolean | undefined;
  /**
   * The original sender's address: the forwarded message's own From in a
   * forward, else the email's From; absent for files and notes. Filing reads
   * its domain (design §5).
   */
  readonly originalSender?: string | undefined;
}

/** Who a detail's words come from. */
export type DetailOrigin =
  /** Found in a document or email. */
  | 'document'
  /** The owner's `/add` text: "your note", never "found in a document". */
  | 'note'
  /** The owner's own edit in SupaMac: "entered by you". */
  | 'owner';

/**
 * A detail as stored and read back by the service. The fields marked
 * "state" have no Details column: they live in the state volume's record for
 * the Details row id, written in the same step as the row.
 */
export interface StoredDetail {
  /** The Details row id. */
  readonly id: string;
  /** Details: Job. */
  readonly jobId?: string | undefined;
  /** Details: Source row. */
  readonly sourceId: string;
  /** Details: Field. */
  readonly field: FieldName;
  /** Details: Label. */
  readonly label: string;
  /** Details: Value. */
  readonly value: string;
  /** Details: Day. */
  readonly day?: string | undefined;
  /** Details: Quote. */
  readonly quote: string;
  /** Details: Page. */
  readonly page?: number | undefined;
  /** Details: Status. */
  readonly status: DetailStatus;
  /** Details: Check. */
  readonly check: string;
  /** Details: Received (ISO instant). */
  readonly received: string;
  /** Details: Source (document), the original's or its text document's id. */
  readonly documentId?: string | undefined;
  /**
   * State. The source's own date (ISO date or instant) for this detail: a
   * history page's own date for a detail from quoted history, else the
   * Sources row's Sent. Unknown when the record is missing, so a rival's
   * order is unknown and it needs review.
   */
  readonly sourceDate?: string | undefined;
  /** State. From a quoted-history page; true when the record is missing. */
  readonly history: boolean;
  /**
   * State. Who the words come from; "note" also follows from the Sources
   * row's Via (Note), "owner" from row history (Edits in SupaMac).
   */
  readonly origin: DetailOrigin;
  /** State. When the owner confirmed or rejected it (ISO instant), from row history. */
  readonly decidedAt?: string | undefined;
  /** State. The kind of the page the quote is on; `scan` details show the page image. */
  readonly pageKind?: PageKind | undefined;
  /** State. The model's `day_quote`, when the day came from a heading. */
  readonly dayQuote?: string | undefined;
}

/**
 * A row of the Sources table, as the service keeps it. Fields marked "state"
 * have no Sources column and live in the state volume's record for the row id.
 */
export interface SourceRecord {
  readonly id: string;
  readonly name: string;
  /** Sources: Document, the original's document id (absent for a .docx). */
  readonly documentId?: string | undefined;
  /** Sources: Text, the `<file> · text` document's id. */
  readonly textDocumentId?: string | undefined;
  readonly kind?: SourceKind | undefined;
  readonly via: Via;
  /**
   * Sources: From. The original sender (`SourceText.originalSender`) when
   * known, else the address it came from.
   */
  readonly from?: string | undefined;
  /** Sources: Sent, the source's own date. */
  readonly sent?: string | undefined;
  readonly received: string;
  readonly jobId?: string | undefined;
  readonly status: SourceStatus;
  /** SHA-256 of the content, hex; a hash already recorded is not processed again. */
  readonly hash: string;
  readonly messageId?: string | undefined;
  /** In-Reply-To and References, oldest first. */
  readonly threadIds: readonly string[];
  readonly attempts: number;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly note?: string | undefined;
  /** State. The Sources row id of the email this source came attached to. */
  readonly parentId?: string | undefined;
}

export function fieldSpec(field: FieldName): FieldSpec {
  return FIELDS[field];
}
