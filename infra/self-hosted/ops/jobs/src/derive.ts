// What the service decides from checked details (docs/supamac/jobs.md §5, §6):
// where a source is filed, which value replaces which, the Jobs row, and which
// Jobs cells it may write.
//
// Invariants:
// - A source files under an existing job by itself only on a Found PO number
//   or job reference (five or more letters and digits, one a digit) equal to
//   one of the same field on that job, with the same client, and nothing else
//   pointing at another job; or as a reply in a thread already filed there
//   that names no date the job lacks. An attachment follows its email unless
//   any reference it carries, checked or not, conflicts. Everything else is a
//   question; a travel or accommodation confirmation never starts a job; a
//   source that describes several jobs waits.
// - Newer means the source's own date, never processing order. A value
//   replaces another only within (job, field, day, label), only for a field
//   that is not many-valued, only when it is Found and dated later, and
//   never when the other is Confirmed or the owner's, when the field is
//   sensitive, when it comes from quoted history, or when it is the owner's
//   note against a document: those wait for review. When the order is not
//   known both stay and the later-processed one needs review.
// - A field the Jobs row shows one value of (the "newest" columns, Dates,
//   Rate, Check-in, Check-out) also meets rivals under other labels and days:
//   a value that would become the row's over a Confirmed or owner's value,
//   over a sensitive value, from quoted history, or with no known order,
//   waits for review. It replaces nothing under another label or day.
// - An owner's value (origin "owner") is never set to review or replaced.
// - A value equal to one the owner rejected (same job, field, day and value
//   key) needs review, saying when it was rejected.
// - The Jobs row is computed from Found and Confirmed details only; Needs
//   review details appear only as "a newer source says …, not confirmed".
// - A Jobs cell is written only when it is empty or still holds what the
//   service last wrote. Name, Booking and Updated are never derived.
//
// Choices where the design is silent, each the more cautious one:
// - A source whose PO or job reference matches a job but which also carries a
//   reference of a kind the job has, with another value, is asked about.
// - "The same client" is a shared Client value (case, punctuation and a
//   trailing Ltd/Limited/PLC/LLP/Inc ignored) when both sides have one, and
//   only otherwise the original sender's domain; a webmail domain
//   (gmail.com, outlook.com, ...) never shows who the client is.
// - A source whose dates cannot all be placed (no year, a weekday alone, a
//   numeric date that reads two ways) names dates the job does not have.
//   The dates a source names are its details' days and every date their
//   values and quotes write; a job's are its details' days and values'.
// - A PO number on the source and a job reference on a job (or the reverse)
//   with the same key only make that job a candidate.
// - Per diem and Booking reference feed no Jobs column, so values under
//   other labels (a meal buyout beside a per diem, a hotel's and a train's
//   booking references) live side by side; within one label any change
//   waits for review.
// - Only Invite, Production pack, Purchase order and Call sheet start a job
//   by themselves; Other is asked about.
// - A reference equal to one on a job that is too short to file by, or not
//   Found, makes that job a candidate in the question instead of letting a
//   new job start.
// - A history value never replaces anything; one dated later than the
//   current value waits for review.
// - Rate basis also carries the Rate quote's tax words ("per day + VAT"), so
//   the row never shows a VAT-exclusive rate as a plain number; a basis
//   written before the amount ("day rate £350") counts as the quote's.
// - Days lists every day a current detail names: its day and every full date
//   its value writes (a Dates range's days, a check-in, a travel date).
// - The Rate cell holds the number of the Rate detail's own value. Currency,
//   basis and tax words come from the Rate quote's amount with that number;
//   for the owner's own value, from that value. A Rate the row cannot show
//   as one number (unknown order, a pending change) is also given as a note.
// - An owner-typed cell with no source value is no disagreement.

import { TZDate } from '@date-fns/tz';
import { format, parseISO } from 'date-fns';
import { formatDay, scopeLabel, valueKey } from './checks';
import {
  DERIVED_COLUMNS,
  type DerivedColumn,
  type DetailStatus,
  FIELDS,
  type FieldName,
  isCalendarDate,
  isCurrent,
  JOB_STARTING_KINDS,
  type JobsColumn,
  type SourceKind,
  type StoredDetail,
} from './model';
import { termsOf } from './normalize';
import {
  type AmountEntity,
  BASIS_TEXT,
  effectiveAmounts,
  parseAmount,
  parseDateRange,
  parseReference,
  partsIso,
  scanText,
  TAX_TEXT,
  taxOf,
} from './parse';

// ---------------------------------------------------------------------------
// Source dates.

export type Order = 'after' | 'before' | 'unknown';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function calendarDay(value: string, timeZone: string): string | undefined {
  if (DATE_ONLY.test(value)) return value;
  if (!INSTANT.test(value)) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return format(new TZDate(ms, timeZone), 'yyyy-MM-dd');
}

/**
 * Whether source date `a` is after or before `b`. Two instants compare
 * exactly; anything with a calendar date compares by day in the owner's
 * zone, and the same day is `unknown`, as is a missing or unreadable date.
 */
export function compareSourceDates(
  a: string | undefined,
  b: string | undefined,
  timeZone: string
): Order {
  if (a === undefined || b === undefined) return 'unknown';
  if (INSTANT.test(a) && INSTANT.test(b)) {
    const diff = Date.parse(a) - Date.parse(b);
    if (Number.isNaN(diff) || diff === 0) return 'unknown';
    return diff > 0 ? 'after' : 'before';
  }
  const da = calendarDay(a, timeZone);
  const db = calendarDay(b, timeZone);
  if (da === undefined || db === undefined || da === db) return 'unknown';
  return da > db ? 'after' : 'before';
}

function dayInZone(instant: string, timeZone: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return instant;
  return format(new TZDate(ms, timeZone), 'd MMM yyyy');
}

// ---------------------------------------------------------------------------
// Values and dates of details.

/** Every day from `from` to `to`, ISO; just the two ends past `limit` days. */
function daysFrom(from: string, to: string, limit = 62): string[] {
  const days: string[] = [];
  for (
    let d = parseISO(from);
    days.length <= limit;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  ) {
    const iso = format(d, 'yyyy-MM-dd');
    if (iso > to) break;
    days.push(iso);
  }
  return days.length > limit ? [from, to] : days;
}

/**
 * Every calendar day a text writes in full: its dates and the days of its
 * ranges. `unplaced` when it writes a date it does not give in full (no
 * year, a weekday alone) or one that reads two ways.
 */
function daysWritten(text: string): { days: string[]; unplaced: boolean } {
  const days: string[] = [];
  let unplaced = false;
  for (const scan of scanText(text)) {
    for (const r of scan.ranges) {
      const from = r.from.ambiguous ? undefined : partsIso(r.from);
      const to = r.to.ambiguous ? undefined : partsIso(r.to);
      if (from === undefined || to === undefined || from > to) unplaced = true;
      else days.push(...daysFrom(from, to));
    }
    for (const d of scan.dates) {
      const iso = d.parts.ambiguous ? undefined : partsIso(d.parts);
      if (iso === undefined) unplaced = true;
      else days.push(iso);
    }
  }
  return { days, unplaced };
}

/** Every calendar day a Dates value names, when it writes them in full. */
function rangeDays(value: string): string[] | undefined {
  const range = parseDateRange(value).entity;
  if (!range || range.from.ambiguous || range.to.ambiguous) return undefined;
  const from = partsIso(range.from);
  const to = partsIso(range.to);
  if (from === undefined || to === undefined || from > to) return undefined;
  return daysFrom(from, to);
}

/**
 * The dates a detail names: its day and every date its value writes, and
 * its quote's too when `withQuote` (a source's side, for filing). A day that
 * is not a calendar date cannot be placed.
 */
function datesNamed(
  detail: Pick<StoredDetail, 'value' | 'day'> & {
    readonly quote?: string | undefined;
  },
  withQuote = false
): { dates: string[]; unplaced: boolean } {
  const dates: string[] = [];
  let unplaced = false;
  if (detail.day !== undefined) {
    if (isCalendarDate(detail.day)) dates.push(detail.day);
    else unplaced = true;
  }
  const texts = [detail.value];
  if (withQuote && detail.quote !== undefined) texts.push(detail.quote);
  for (const text of texts) {
    const written = daysWritten(text);
    dates.push(...written.days);
    unplaced ||= written.unplaced;
  }
  return { dates: [...new Set(dates)], unplaced };
}

function referenceKey(value: string): string | undefined {
  return parseReference(value).entity?.key;
}

/** Five or more letters and digits, at least one a digit (design §5). */
export function strongReference(key: string): boolean {
  return key.length >= 5 && /\d/.test(key);
}

const COMPANY_SUFFIXES = new Set([
  'ltd',
  'limited',
  'plc',
  'llp',
  'llc',
  'inc',
  'incorporated',
]);

/** A client name for comparison: its words, without a trailing company suffix or a leading "the". */
export function clientKey(name: string): string {
  const words = termsOf(name).filter((w) => w !== '&' && w !== 'and');
  while (
    words.length > 1 &&
    COMPANY_SUFFIXES.has(words[words.length - 1] as string)
  )
    words.pop();
  if (words[0] === 'the' && words.length > 1) words.shift();
  return words.join(' ');
}

const WEBMAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'live.co.uk',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'aol.co.uk',
  'btinternet.com',
  'sky.com',
  'virginmedia.com',
  'talktalk.net',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.co.uk',
  'mail.com',
  'zoho.com',
  'fastmail.com',
]);

/** The domain of an address that shows who sent it, or undefined for webmail. */
export function senderDomain(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  const m = /@([a-z0-9-]+(?:\.[a-z0-9-]+)+)\s*>?\s*$/i.exec(address.trim());
  if (!m) return undefined;
  const domain = (m[1] as string).toLowerCase();
  return WEBMAIL.has(domain) ? undefined : domain;
}

// ---------------------------------------------------------------------------
// Filing (design §5).

type ReferenceField = 'PO number' | 'Job reference';

export interface JobFacts {
  readonly jobId: string;
  readonly name: string;
  readonly references: readonly {
    readonly field: ReferenceField;
    readonly key: string;
  }[];
  readonly clients: readonly string[];
  readonly senderDomains: readonly string[];
  readonly messageIds: readonly string[];
  readonly dates: readonly string[];
}

export interface FiledSource {
  readonly jobId?: string | undefined;
  /** The original sender's address (the forwarded message's From). */
  readonly originalSender?: string | undefined;
  readonly messageId?: string | undefined;
}

/** What filing needs to know of a job, from its Found and Confirmed details and filed sources. */
export function jobFacts(
  job: { readonly id: string; readonly name: string },
  details: readonly StoredDetail[],
  sources: readonly FiledSource[]
): JobFacts {
  const mine = details.filter((d) => d.jobId === job.id && isCurrent(d.status));
  const references: { field: ReferenceField; key: string }[] = [];
  const clients = new Set<string>();
  const dates = new Set<string>();
  for (const d of mine) {
    if (d.field === 'PO number' || d.field === 'Job reference') {
      const key = referenceKey(d.value);
      if (key !== undefined) references.push({ field: d.field, key });
    }
    if (d.field === 'Client') clients.add(clientKey(d.value));
    for (const date of datesNamed(d).dates) dates.add(date);
  }
  const filed = sources.filter((s) => s.jobId === job.id);
  const domains = new Set<string>();
  for (const s of filed) {
    const domain = senderDomain(s.originalSender);
    if (domain !== undefined) domains.add(domain);
  }
  return {
    jobId: job.id,
    name: job.name,
    references,
    clients: [...clients],
    senderDomains: [...domains],
    messageIds: filed.flatMap((s) =>
      s.messageId === undefined ? [] : [s.messageId]
    ),
    dates: [...dates].sort(),
  };
}

export interface FilingInput {
  readonly kind: SourceKind;
  /** How many jobs the extraction says the source describes. */
  readonly jobsDescribed: number;
  /** The source's details after the checks; a quote's dates count too. */
  readonly details: readonly (Pick<
    StoredDetail,
    'field' | 'value' | 'day' | 'status'
  > & { readonly quote?: string | undefined })[];
  readonly originalSender?: string | undefined;
  /** In-Reply-To and References. */
  readonly threadIds: readonly string[];
  /** Set for an attachment: what became of its email. */
  readonly attachmentOf?:
    | { readonly state: 'filed'; readonly jobId: string }
    | { readonly state: 'waiting' }
    | undefined;
  /** Existing jobs the model says the source may be, with the words that show it. */
  readonly proposals: readonly {
    readonly jobId: string;
    readonly words: string;
  }[];
}

export interface Candidate {
  readonly jobId: string;
  readonly why: string;
}

export type FilingDecision =
  | {
      readonly action: 'file';
      readonly jobId: string;
      readonly rule: 'reference' | 'thread' | 'attachment';
      readonly reason: string;
    }
  /** "File under <job>?" with Yes and New job; no candidates asks which job. */
  | {
      readonly action: 'ask';
      readonly candidates: readonly Candidate[];
      readonly reason: string;
    }
  | { readonly action: 'new_job'; readonly reason: string }
  | { readonly action: 'wait'; readonly reason: string }
  | { readonly action: 'not_a_job'; readonly reason: string };

/** Decides where a source goes (design §5). */
export function decideFiling(
  input: FilingInput,
  jobs: readonly JobFacts[]
): FilingDecision {
  if (input.kind === 'Not about a job') {
    return { action: 'not_a_job', reason: 'the source is not about a job' };
  }
  if (input.jobsDescribed > 1) {
    return {
      action: 'wait',
      reason: `the source describes ${input.jobsDescribed} jobs`,
    };
  }
  const byId = new Map(jobs.map((j) => [j.jobId, j]));
  const candidates = new Map<string, string[]>();
  const propose = (jobId: string, why: string): void => {
    if (!byId.has(jobId)) return;
    const list = candidates.get(jobId) ?? [];
    if (!list.includes(why)) list.push(why);
    candidates.set(jobId, list);
  };
  const asked = (reason: string): FilingDecision => ({
    action: 'ask',
    candidates: [...candidates].map(([jobId, why]) => ({
      jobId,
      why: why.join('; '),
    })),
    reason,
  });

  const found = input.details.filter((d) => d.status === 'Found');
  const live = input.details.filter(
    (d) => d.status !== 'Rejected' && d.status !== 'Replaced'
  );
  const referencesOf = (
    list: readonly Pick<StoredDetail, 'field' | 'value'>[],
    strongOnly: boolean
  ): { field: ReferenceField; key: string }[] => {
    const out: { field: ReferenceField; key: string }[] = [];
    for (const d of list) {
      if (d.field !== 'PO number' && d.field !== 'Job reference') continue;
      const key = referenceKey(d.value);
      if (key !== undefined && (!strongOnly || strongReference(key)))
        out.push({ field: d.field, key });
    }
    return out;
  };
  const refs = referencesOf(found, true);
  const holders = (key: string, field?: ReferenceField): JobFacts[] =>
    jobs.filter((j) =>
      j.references.some(
        (r) => r.key === key && (field === undefined || r.field === field)
      )
    );
  const threadJobs = jobs.filter((j) =>
    j.messageIds.some((id) => input.threadIds.includes(id))
  );

  if (input.attachmentOf !== undefined) {
    if (input.attachmentOf.state === 'waiting') {
      return { action: 'wait', reason: 'it waits with its email' };
    }
    const parent = byId.get(input.attachmentOf.jobId);
    if (parent) {
      // Every reference the attachment carries counts, checked or not.
      const conflicts: string[] = [];
      for (const r of referencesOf(live, false)) {
        const others = holders(r.key).filter((j) => j.jobId !== parent.jobId);
        for (const o of others) {
          conflicts.push(`its ${r.field} ${r.key} is on ${o.name}`);
          propose(o.jobId, `${r.field} ${r.key}`);
        }
        const own = parent.references.filter((p) => p.field === r.field);
        if (own.length > 0 && !own.some((p) => p.key === r.key)) {
          conflicts.push(`its ${r.field} ${r.key} is not ${parent.name}'s`);
        }
      }
      if (conflicts.length === 0) {
        return {
          action: 'file',
          jobId: parent.jobId,
          rule: 'attachment',
          reason: `filed with its email under ${parent.name}`,
        };
      }
      propose(parent.jobId, 'its email is filed there');
      return asked(
        `the attachment's references conflict: ${[...new Set(conflicts)].join('; ')}`
      );
    }
  }

  const sourceClients = new Set(
    found.filter((d) => d.field === 'Client').map((d) => clientKey(d.value))
  );
  const domain = senderDomain(input.originalSender);
  const sameClient = (job: JobFacts): { same: boolean; why: string } => {
    if (sourceClients.size > 0 && job.clients.length > 0) {
      const shared = job.clients.some((c) => sourceClients.has(c));
      return {
        same: shared,
        why: shared ? 'the same client' : 'a different client',
      };
    }
    if (domain !== undefined && job.senderDomains.includes(domain)) {
      return { same: true, why: `the same sender domain, ${domain}` };
    }
    return { same: false, why: 'no client in common' };
  };

  // A reference files only against one of the same field.
  const byReference = new Map<string, JobFacts>();
  for (const r of refs)
    for (const j of holders(r.key, r.field)) byReference.set(j.jobId, j);
  for (const r of refs) {
    for (const j of holders(r.key)) {
      if (!byReference.has(j.jobId))
        propose(
          j.jobId,
          `${r.field} ${r.key} is a reference of another kind there`
        );
    }
  }
  if (byReference.size === 1) {
    const job = [...byReference.values()][0] as JobFacts;
    const client = sameClient(job);
    const ref = refs.find((r) =>
      job.references.some((x) => x.field === r.field && x.key === r.key)
    ) as { field: string; key: string };
    const clash = refs.find(
      (r) =>
        job.references.some((x) => x.field === r.field) &&
        !job.references.some((x) => x.field === r.field && x.key === r.key)
    );
    const otherThread = threadJobs.find((j) => j.jobId !== job.jobId);
    const otherProposal = input.proposals.find(
      (p) => p.jobId !== job.jobId && byId.has(p.jobId)
    );
    if (clash) {
      propose(
        job.jobId,
        `${ref.field} ${ref.key}, but its ${clash.field} ${clash.key} is not the job's`
      );
    } else if (otherThread) {
      propose(
        job.jobId,
        `${ref.field} ${ref.key}, but its thread is filed under ${otherThread.name}`
      );
    } else if (otherProposal) {
      propose(
        job.jobId,
        `${ref.field} ${ref.key}, but the model suggests another job`
      );
    } else if (client.same) {
      return {
        action: 'file',
        jobId: job.jobId,
        rule: 'reference',
        reason: `${ref.field} ${ref.key} and ${client.why}`,
      };
    } else {
      propose(job.jobId, `${ref.field} ${ref.key}, but ${client.why}`);
    }
  } else {
    for (const j of byReference.values())
      propose(j.jobId, 'a shared reference');
  }

  // A reference too short to file by, or not Found, still points at a job.
  for (const d of live) {
    if (d.field !== 'PO number' && d.field !== 'Job reference') continue;
    const key = referenceKey(d.value);
    if (key === undefined || (d.status === 'Found' && strongReference(key)))
      continue;
    const why = d.status === 'Found' ? 'too short to file by' : 'not checked';
    for (const j of holders(key))
      propose(j.jobId, `${d.field} ${key} (${why})`);
  }

  if (threadJobs.length === 1) {
    const job = threadJobs[0] as JobFacts;
    const named = live.map((d) => datesNamed(d, true));
    const unplaced = named.some((n) => n.unplaced);
    const newDates = [...new Set(named.flatMap((n) => n.dates))].filter(
      (d) => !job.dates.includes(d)
    );
    const elsewhere = [...candidates.keys()].some((id) => id !== job.jobId);
    if (!unplaced && newDates.length === 0 && !elsewhere) {
      return {
        action: 'file',
        jobId: job.jobId,
        rule: 'thread',
        reason: `a reply in a thread filed under ${job.name}`,
      };
    }
    propose(
      job.jobId,
      unplaced
        ? 'its thread is filed there, but it names a date it does not write in full'
        : newDates.length > 0
          ? `its thread is filed there, but it names ${newDates.sort().map(formatDay).join(', ')}`
          : 'its thread is filed there'
    );
  } else {
    for (const j of threadJobs) propose(j.jobId, 'its thread is filed there');
  }

  // `words` are the source's own (process.ts keeps no others), quoted as such.
  for (const p of input.proposals)
    propose(
      p.jobId,
      p.words.trim() === ''
        ? 'the model suggests it'
        : `the model suggests it, from the source’s words "${p.words.trim()}"`
    );
  const foundDays = new Set(found.flatMap((d) => datesNamed(d).dates));
  for (const j of jobs) {
    const shared = j.dates.filter((d) => foundDays.has(d));
    if (shared.length > 0)
      propose(j.jobId, `it shares ${shared.map(formatDay).join(', ')}`);
  }

  if (candidates.size > 0) return asked('it may belong to a job on file');
  if (
    input.kind === 'Travel confirmation' ||
    input.kind === 'Accommodation confirmation'
  ) {
    return asked(
      'a travel or accommodation confirmation never starts a job by itself'
    );
  }
  if (input.jobsDescribed === 0) return asked('the source describes no job');
  if (JOB_STARTING_KINDS.includes(input.kind)) {
    return {
      action: 'new_job',
      reason: `a new ${input.kind.toLowerCase()} that matches no job on file`,
    };
  }
  return asked('the source matches no job on file');
}

// ---------------------------------------------------------------------------
// Replacement and rejection (design §4, §6).

export interface SettleOptions {
  /** The owner's zone, for comparing dates and wording them. */
  readonly timeZone: string;
}

export interface Replacement {
  readonly id: string;
  readonly by: string;
  readonly check: string;
}

/** Why settle changed an incoming detail's status. */
export type SettleCode =
  | 'rejected_before'
  | 'order_unknown'
  | 'confirmed_rival'
  | 'sensitive_change'
  | 'history'
  | 'note_against_document'
  | 'replaced_by_newer';

export interface Settlement {
  /** The incoming details with their final status and Check. */
  readonly details: readonly StoredDetail[];
  /** Existing details that become Replaced. */
  readonly replaced: readonly Replacement[];
  /** The codes behind each incoming detail settle changed, by its id. */
  readonly reasons: readonly {
    readonly id: string;
    readonly codes: readonly SettleCode[];
  }[];
}

/** Fields the Jobs row shows a single value of, whatever its label or day. */
function rowSingle(field: FieldName): boolean {
  const rule = FIELDS[field].column;
  return (
    rule.rule === 'newest' ||
    rule.rule === 'dates' ||
    rule.rule === 'rate' ||
    (rule.rule === 'accommodation' && rule.part !== 'hotel')
  );
}

const scopes = new WeakMap<StoredDetail, string>();
const keys = new WeakMap<StoredDetail, string>();

function scopeOf(d: StoredDetail): string {
  let scope = scopes.get(d);
  if (scope === undefined) {
    scope = JSON.stringify([
      d.jobId ?? '',
      d.field,
      d.day ?? '',
      scopeLabel(d.field, d.label, d.quote),
    ]);
    scopes.set(d, scope);
  }
  return scope;
}

/** `valueKey` of a stored detail, computed once per detail object. */
function keyOf(d: StoredDetail): string {
  let key = keys.get(d);
  if (key === undefined) {
    key = valueKey(d.field, d.value);
    keys.set(d, key);
  }
  return key;
}

function withStatus(
  d: StoredDetail,
  status: DetailStatus,
  reason: string
): StoredDetail {
  const prior = d.check
    .replace(/^Found on /, 'The checks passed on ')
    .replace(/^Needs review: /, '');
  const head = status === 'Needs review' ? 'Needs review' : status;
  return { ...d, status, check: `${head}: ${reason}. ${prior}`.trim() };
}

function whose(d: StoredDetail): string {
  if (d.origin === 'owner') return 'entered by you';
  if (d.origin === 'note') return 'your note';
  return d.status === 'Confirmed' ? 'confirmed' : 'not confirmed';
}

type Review = {
  readonly kind: 'review';
  readonly text: string;
  readonly code: SettleCode;
};

type Verdict =
  | { readonly kind: 'replace' }
  | { readonly kind: 'older' }
  | Review;

function noteAgainst(c: StoredDetail): Review {
  return {
    kind: 'review',
    code: 'note_against_document',
    text: `a document says ${c.value}; your note does not replace it until you confirm it`,
  };
}

function unordered(c: StoredDetail): Review {
  return {
    kind: 'review',
    code: 'order_unknown',
    text: `another source says ${c.value} (${whose(c)}) and which is newer is not known`,
  };
}

/** The review a newer `d` needs against `c`, or undefined when it may stand. */
function newerReview(d: StoredDetail, c: StoredDetail): Review | undefined {
  if (d.history) {
    return {
      kind: 'review',
      code: 'history',
      text: `${c.value} (${whose(c)}); quoted history says ${d.value}, and history never replaces a value by itself`,
    };
  }
  if (c.status === 'Confirmed' || c.origin !== 'document') {
    return {
      kind: 'review',
      code: 'confirmed_rival',
      text: `${c.value} (${whose(c)}); a newer source says ${d.value}, not confirmed`,
    };
  }
  if (FIELDS[d.field].sensitive) {
    return {
      kind: 'review',
      code: 'sensitive_change',
      text: `${c.value} (${whose(c)}); a newer source says ${d.value}, not confirmed; a change to ${d.field} waits for review`,
    };
  }
  return undefined;
}

/** Within the replacement scope (job, field, day, label). */
function verdict(d: StoredDetail, c: StoredDetail, timeZone: string): Verdict {
  if (d.origin === 'note' && c.origin === 'document') return noteAgainst(c);
  const order = compareSourceDates(d.sourceDate, c.sourceDate, timeZone);
  if (order === 'before') return { kind: 'older' };
  if (order === 'unknown') return unordered(c);
  return newerReview(d, c) ?? { kind: 'replace' };
}

/**
 * Against a value of the same row-single field under another label or day:
 * nothing is replaced, but a value that would become the row's waits for
 * review where a replacement would.
 */
function crossVerdict(
  d: StoredDetail,
  c: StoredDetail,
  timeZone: string
): Review | undefined {
  const order = compareSourceDates(d.sourceDate, c.sourceDate, timeZone);
  if (order === 'before') return undefined;
  if (d.origin === 'note' && c.origin === 'document') return noteAgainst(c);
  if (order === 'unknown') return unordered(c);
  return newerReview(d, c);
}

/**
 * Settles one source's checked details against the job's existing ones, in
 * order, so a later detail of the same source meets the earlier ones.
 * Details without a job are returned unchanged: they touch no Jobs row until
 * the owner files them.
 */
export function settle(
  existing: readonly StoredDetail[],
  incoming: readonly StoredDetail[],
  options: SettleOptions
): Settlement {
  const pool: StoredDetail[] = [...existing];
  const replaced: Replacement[] = [];
  const out: StoredDetail[] = [];
  const reasons: { id: string; codes: SettleCode[] }[] = [];
  const keep = (d: StoredDetail, codes: SettleCode[] = []): void => {
    out.push(d);
    pool.push(d);
    if (codes.length > 0)
      reasons.push({ id: d.id, codes: [...new Set(codes)] });
  };
  for (const raw of incoming) {
    if (
      raw.jobId === undefined ||
      raw.origin === 'owner' ||
      (raw.status !== 'Found' && raw.status !== 'Needs review')
    ) {
      keep(raw);
      continue;
    }
    const key = keyOf(raw);
    const rejected = pool.find(
      (r) =>
        r.status === 'Rejected' &&
        r.jobId === raw.jobId &&
        r.field === raw.field &&
        (r.day ?? '') === (raw.day ?? '') &&
        keyOf(r) === key
    );
    if (rejected) {
      keep(
        withStatus(
          raw,
          'Needs review',
          `you rejected this on ${dayInZone(rejected.decidedAt ?? rejected.received, options.timeZone)}`
        ),
        ['rejected_before']
      );
      continue;
    }
    if (raw.status !== 'Found' || FIELDS[raw.field].multiplicity === 'many') {
      keep(raw);
      continue;
    }
    const scope = scopeOf(raw);
    const rivals = pool.filter(
      (c) =>
        c.id !== raw.id &&
        isCurrent(c.status) &&
        scopeOf(c) === scope &&
        keyOf(c) !== key
    );
    const verdicts = rivals.map((c) => ({
      c,
      v: verdict(raw, c, options.timeZone),
    }));
    const cross = rowSingle(raw.field)
      ? pool.filter(
          (c) =>
            c.id !== raw.id &&
            isCurrent(c.status) &&
            c.jobId === raw.jobId &&
            c.field === raw.field &&
            scopeOf(c) !== scope &&
            keyOf(c) !== key
        )
      : [];
    const reviews: Review[] = [
      ...verdicts.flatMap(({ v }) => (v.kind === 'review' ? [v] : [])),
      ...cross.flatMap((c) => {
        const v = crossVerdict(raw, c, options.timeZone);
        return v ? [v] : [];
      }),
    ];
    const newer = verdicts.find(({ v }) => v.kind === 'older');
    if (reviews.length > 0) {
      keep(
        withStatus(
          raw,
          'Needs review',
          [...new Set(reviews.map((r) => r.text))].join('; ')
        ),
        reviews.map((r) => r.code)
      );
    } else if (newer) {
      keep(
        withStatus(
          raw,
          'Replaced',
          `replaced by ${newer.c.value} from a newer source`
        ),
        ['replaced_by_newer']
      );
    } else {
      for (const { c } of verdicts) {
        const check = `Replaced: replaced by ${raw.value} from a newer source. ${c.check}`;
        replaced.push({ id: c.id, by: raw.id, check });
        const at = pool.indexOf(c);
        pool[at] = { ...c, status: 'Replaced', check };
      }
      keep(raw);
    }
  }
  return { details: out, replaced, reasons };
}

// ---------------------------------------------------------------------------
// The Jobs row (design §6).

export interface DateRangeCell {
  readonly start: string;
  readonly end: string;
}

export type CellValue =
  | string
  | number
  | DateRangeCell
  | readonly string[]
  | null;

export type DerivedCells = Readonly<Record<DerivedColumn, CellValue>>;

export interface JobsRowDerivation {
  readonly cells: DerivedCells;
  /** Every day a detail names, ISO, sorted. */
  readonly days: readonly string[];
  /**
   * What a number cell cannot say ("£350/day (confirmed); a newer source
   * says £400/day, not confirmed"), for the summary and the assistant.
   */
  readonly notes: readonly {
    readonly column: DerivedColumn;
    readonly text: string;
  }[];
}

export interface JobsRowOptions {
  readonly timeZone: string;
}

interface ValueGroup {
  readonly key: string;
  readonly details: readonly StoredDetail[];
  readonly confirmed: boolean;
  /** The latest source date among its details, if any is dated. */
  readonly date?: string | undefined;
  readonly text: string;
}

function latest(
  dates: readonly (string | undefined)[],
  timeZone: string
): string | undefined {
  let best: string | undefined;
  for (const d of dates) {
    if (d === undefined) continue;
    if (best === undefined || compareSourceDates(d, best, timeZone) === 'after')
      best = d;
  }
  return best;
}

function groupValues(
  details: readonly StoredDetail[],
  timeZone: string
): ValueGroup[] {
  const groups = new Map<string, StoredDetail[]>();
  for (const d of details) {
    const key = keyOf(d);
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups].map(([key, ds]) => {
    const confirmed = ds.find(
      (d) => d.status === 'Confirmed' || d.origin === 'owner'
    );
    const date = latest(
      ds.map((d) => d.sourceDate),
      timeZone
    );
    const shown =
      confirmed ??
      ds.find((d) => d.sourceDate === date) ??
      (ds[ds.length - 1] as StoredDetail);
    return {
      key,
      details: ds,
      confirmed: confirmed !== undefined,
      date,
      text: shown.value.trim(),
    };
  });
}

interface Shown {
  readonly text: string;
  /** Rests on a Found detail the owner has not confirmed. */
  readonly unconfirmed: boolean;
  readonly winner?: ValueGroup | undefined;
  /**
   * The group a one-value cell rests on: an older confirmed one over a newer
   * unconfirmed winner, else the winner.
   */
  readonly chosen?: ValueGroup | undefined;
}

/**
 * The value of a set of current details: the newest value group, or every
 * group when which is newest is not known; an older confirmed value is kept
 * in view, and newer or unordered pending values are named.
 */
function show(
  current: readonly StoredDetail[],
  pending: readonly StoredDetail[],
  timeZone: string
): Shown | undefined {
  const groups = groupValues(current, timeZone);
  if (groups.length === 0) return undefined;
  const winner = groups.find((g) =>
    groups.every(
      (h) => h === g || compareSourceDates(g.date, h.date, timeZone) === 'after'
    )
  );
  let text: string;
  let unconfirmed: boolean;
  let chosen: ValueGroup | undefined;
  if (winner === undefined) {
    text = `${groups.map((g) => g.text).join(' / ')} (which is newer is not known)`;
    unconfirmed = groups.some((g) => !g.confirmed);
  } else {
    unconfirmed = !winner.confirmed;
    const olderConfirmed = groups.find((g) => g !== winner && g.confirmed);
    chosen = !winner.confirmed && olderConfirmed ? olderConfirmed : winner;
    text =
      !winner.confirmed && olderConfirmed
        ? `${olderConfirmed.text} (confirmed); a newer source says ${winner.text}, not confirmed`
        : winner.text;
  }
  const shownKeys = new Set(groups.map((g) => g.key));
  const notes: string[] = [];
  for (const p of pending) {
    if (shownKeys.has(keyOf(p))) continue;
    const order = winner
      ? compareSourceDates(p.sourceDate, winner.date, timeZone)
      : 'unknown';
    if (order === 'before') continue;
    const note =
      order === 'after'
        ? `a newer source says ${p.value.trim()}, not confirmed`
        : `another source says ${p.value.trim()}, not confirmed`;
    if (!notes.includes(note)) notes.push(note);
  }
  if (notes.length > 0) {
    const base =
      winner?.confirmed && !text.includes('(confirmed)')
        ? `${text} (confirmed)`
        : text;
    text = [base, ...notes].join('; ');
  }
  return { text, unconfirmed, winner, chosen };
}

function byDayLabel(
  details: readonly StoredDetail[]
): Map<string, StoredDetail[]> {
  const map = new Map<string, StoredDetail[]>();
  for (const d of details) {
    const key = JSON.stringify([
      d.day ?? '',
      scopeLabel(d.field, d.label, d.quote),
    ]);
    map.set(key, [...(map.get(key) ?? []), d]);
  }
  return map;
}

function dayText(day: string | undefined): string {
  return day === undefined ? '' : formatDay(day);
}

/** The detail of a value group a cell takes its words from. */
function lead(group: ValueGroup): StoredDetail | undefined {
  return (
    group.details.find((d) => d.origin === 'owner') ??
    group.details.find((d) => d.status === 'Confirmed') ??
    group.details[0]
  );
}

/**
 * Rate, Currency and Rate basis of one Rate detail: the number of its value;
 * currency, basis and tax words from the quote's amount with that number, or
 * from the owner's own value.
 */
function rateCells(
  d: StoredDetail
): { rate: number; currency: string | null; basis: string | null } | undefined {
  const value = parseAmount(d.value).entity;
  if (!value || value.value === undefined || value.ambiguous) return undefined;
  let written: AmountEntity | undefined = value;
  if (d.origin !== 'owner') {
    const same = effectiveAmounts(
      scanText(d.quote).flatMap((l) => l.amounts)
    ).filter((a) => !a.ambiguous && a.value === value.value);
    if (same.length !== 1) return undefined;
    written = same[0] as AmountEntity;
  }
  const basis = written.basis ?? written.preBasis;
  const tax = taxOf(written);
  const words = [
    basis ? BASIS_TEXT[basis] : '',
    tax ? TAX_TEXT[tax] : '',
  ].filter((w) => w !== '');
  return {
    rate: value.value,
    currency: written.currency ?? null,
    basis: words.length > 0 ? words.join(' ') : null,
  };
}

/** Computes every derived column of one job's row from its details. */
export function deriveJobsRow(
  details: readonly StoredDetail[],
  options: JobsRowOptions
): JobsRowDerivation {
  const tz = options.timeZone;
  const current = details.filter((d) => isCurrent(d.status));
  const pending = details.filter((d) => d.status === 'Needs review');
  const of = (
    list: readonly StoredDetail[],
    field: FieldName
  ): StoredDetail[] => list.filter((d) => d.field === field);
  const cells: Record<DerivedColumn, CellValue> = Object.fromEntries(
    DERIVED_COLUMNS.map((c) => [c, null])
  ) as Record<DerivedColumn, CellValue>;
  const unconfirmed = new Set<DerivedColumn>();

  for (const spec of Object.values(FIELDS)) {
    if (spec.column.rule !== 'newest') continue;
    const shown = show(of(current, spec.name), of(pending, spec.name), tz);
    if (!shown) continue;
    cells[spec.column.column] = shown.text;
    if (shown.unconfirmed) unconfirmed.add(spec.column.column);
  }

  // Dates: one quote stating a contiguous range, else empty.
  const dates = show(of(current, 'Dates'), [], tz);
  if (dates?.chosen) {
    const detail = lead(dates.chosen);
    const stated =
      detail !== undefined &&
      (detail.origin === 'owner' || parseDateRange(detail.quote).count === 1);
    const days = detail ? rangeDays(detail.value) : undefined;
    if (stated && days !== undefined && days.length > 0) {
      cells.Dates = {
        start: days[0] as string,
        end: days[days.length - 1] as string,
      };
      if (dates.unconfirmed) unconfirmed.add('Dates');
    }
  }

  // Days: every day a detail names.
  const dayConfirmed = new Map<string, boolean>();
  for (const d of current) {
    for (const day of datesNamed(d).dates) {
      const confirmed = d.status === 'Confirmed' || d.origin === 'owner';
      dayConfirmed.set(day, (dayConfirmed.get(day) ?? false) || confirmed);
    }
  }
  const days = [...dayConfirmed.keys()].sort();
  if (days.length > 0) {
    cells.Days = days.map(formatDay).join(', ');
    if ([...dayConfirmed.values()].some((c) => !c)) unconfirmed.add('Days');
  }

  // Call times: "day: value" for every Call time, newest within its day and label.
  const calls = byDayLabel(of(current, 'Call time'));
  const callPending = byDayLabel(of(pending, 'Call time'));
  const labelsPerDay = new Map<string, number>();
  for (const key of calls.keys()) {
    const [day] = JSON.parse(key) as [string, string];
    labelsPerDay.set(day, (labelsPerDay.get(day) ?? 0) + 1);
  }
  const callLines: { sort: string; text: string }[] = [];
  for (const [key, ds] of calls) {
    const [day, label] = JSON.parse(key) as [string, string];
    const shown = show(ds, callPending.get(key) ?? [], tz);
    if (!shown) continue;
    if (shown.unconfirmed) unconfirmed.add('Call times');
    const tag =
      (labelsPerDay.get(day) ?? 0) > 1 && label !== '' ? ` (${label})` : '';
    callLines.push({
      sort: `${day === '' ? '9999' : day}|${label}`,
      text:
        day === ''
          ? `${shown.text}${tag} (no day given)`
          : `${dayText(day)}: ${shown.text}${tag}`,
    });
  }
  if (callLines.length > 0) {
    cells['Call times'] = callLines
      .sort((a, b) => a.sort.localeCompare(b.sort))
      .map((l) => l.text)
      .join('; ');
  }

  // Travel: every Travel detail, by day.
  const travel = of(current, 'Travel').sort(
    (a, b) =>
      (a.day ?? '9999').localeCompare(b.day ?? '9999') ||
      a.received.localeCompare(b.received)
  );
  if (travel.length > 0) {
    cells.Travel = travel
      .map((d) =>
        d.day === undefined
          ? d.value.trim()
          : `${dayText(d.day)}: ${d.value.trim()}`
      )
      .join('; ');
    if (travel.some((d) => d.status !== 'Confirmed' && d.origin !== 'owner'))
      unconfirmed.add('Travel');
  }

  // Accommodation: Hotel, with Check-in and Check-out.
  const hotelParts: string[] = [];
  const hotels = byDayLabel(of(current, 'Hotel'));
  const hotelPending = byDayLabel(of(pending, 'Hotel'));
  const hotelLines: { sort: string; text: string }[] = [];
  for (const [key, ds] of hotels) {
    const [day] = JSON.parse(key) as [string, string];
    const shown = show(ds, hotelPending.get(key) ?? [], tz);
    if (!shown) continue;
    if (shown.unconfirmed) unconfirmed.add('Accommodation');
    hotelLines.push({
      sort: day === '' ? '0000' : day,
      text: day === '' ? shown.text : `${dayText(day)}: ${shown.text}`,
    });
  }
  if (hotelLines.length > 0) {
    hotelParts.push(
      hotelLines
        .sort((a, b) => a.sort.localeCompare(b.sort))
        .map((l) => l.text)
        .join('; ')
    );
  }
  for (const [field, word] of [
    ['Check-in', 'check-in'],
    ['Check-out', 'check-out'],
  ] as const) {
    const shown = show(of(current, field), of(pending, field), tz);
    if (!shown) continue;
    hotelParts.push(`${word} ${shown.text}`);
    if (shown.unconfirmed) unconfirmed.add('Accommodation');
  }
  if (hotelParts.length > 0) cells.Accommodation = hotelParts.join(', ');

  // Contacts: every Contact detail.
  const contacts = groupValues(of(current, 'Contact'), tz);
  if (contacts.length > 0) {
    cells.Contacts = contacts.map((g) => g.text).join('; ');
    if (contacts.some((g) => !g.confirmed)) unconfirmed.add('Contacts');
  }

  // Rate, Currency and Rate basis: from the Rate detail and its own quote only.
  const notes: { column: DerivedColumn; text: string }[] = [];
  const rate = show(of(current, 'Rate'), of(pending, 'Rate'), tz);
  if (rate) {
    const detail = rate.chosen ? lead(rate.chosen) : undefined;
    const parts = detail ? rateCells(detail) : undefined;
    if (parts) {
      cells.Rate = parts.rate;
      cells.Currency = parts.currency;
      cells['Rate basis'] = parts.basis;
      if (rate.unconfirmed) {
        for (const c of ['Rate', 'Currency', 'Rate basis'] as const)
          if (cells[c] !== null) unconfirmed.add(c);
      }
    }
    if (rate.text !== rate.chosen?.text)
      notes.push({ column: 'Rate', text: rate.text });
  }

  cells['Not confirmed'] = DERIVED_COLUMNS.filter((c) => unconfirmed.has(c));
  cells['Needs review'] = pending.length;
  return { cells, days, notes };
}

// ---------------------------------------------------------------------------
// Owner-typed cells (design §6, last paragraph).

export interface CellPlan {
  /** Cells to write, with their new values. */
  readonly writes: Partial<Record<DerivedColumn, CellValue>>;
  /** Cells the owner typed that the sources disagree with; kept as typed. */
  readonly kept: readonly {
    readonly column: DerivedColumn;
    readonly owner: CellValue;
    readonly sources: CellValue;
  }[];
}

function canonical(value: CellValue | undefined): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'string')
    return value.trim() === '' ? 'null' : JSON.stringify(value.trim());
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = (value as readonly string[])
      .map((v) => v.trim())
      .filter((v) => v !== '');
    return items.length === 0 ? 'null' : JSON.stringify([...items].sort());
  }
  const range = value as DateRangeCell;
  return JSON.stringify([range.start, range.end]);
}

export function cellsEqual(
  a: CellValue | undefined,
  b: CellValue | undefined
): boolean {
  return canonical(a) === canonical(b);
}

/**
 * Which derived cells to write: a cell that is empty or still holds what the
 * service last wrote takes the derived value; any other cell is the owner's
 * and stays, reported when the sources disagree with it.
 */
export function planJobsCells(
  derived: DerivedCells,
  current: Partial<Record<JobsColumn, CellValue>>,
  lastWritten: Partial<Record<JobsColumn, CellValue>>
): CellPlan {
  const writes: Partial<Record<DerivedColumn, CellValue>> = {};
  const kept: {
    column: DerivedColumn;
    owner: CellValue;
    sources: CellValue;
  }[] = [];
  for (const column of DERIVED_COLUMNS) {
    const now = current[column] ?? null;
    const next = derived[column];
    const ours =
      canonical(now) === 'null' || cellsEqual(now, lastWritten[column] ?? null);
    if (cellsEqual(now, next)) continue;
    if (ours) writes[column] = next;
    else if (canonical(next) !== 'null')
      kept.push({ column, owner: now, sources: next });
  }
  return { writes, kept };
}

/** The Details table's Name: "Field: value", marked when neither Found nor Confirmed. */
export function detailName(
  field: FieldName,
  value: string,
  status: DetailStatus
): string {
  const name = `${field}: ${value.trim()}`;
  return status === 'Found' || status === 'Confirmed'
    ? name
    : `Unconfirmed · ${name}`;
}
