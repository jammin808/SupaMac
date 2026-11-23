// The answer to a question as the owner reads it (docs/supamac/jobs.md,
// "Asking"): every value written by the service from its detail, and the
// model's own words checked (words.ts) and labelled.
//
// Invariants:
// - A detail is written from its stored fields alone: its field, its day
//   (today, tomorrow or yesterday named), its value verbatim, its source and
//   page, its quote and its status. A replaced or rejected detail is shown
//   only as "was ...".
// - Everything the model wrote is put on one line, without control or format
//   characters, so it can never start a line that looks like the service's.
// - Connecting words with a number or date of their own are left out, and the
//   details they introduce are still printed. Connecting words the service
//   cannot vouch for are shown with "(not checked)". A note or a not-found is
//   always "(not checked)" and is left out when it writes a number or date;
//   an estimate is always labelled as one, with its basis.
// - A link is kept only when a cited detail writes it whole. Links in the
//   names the service prints (sources, jobs, the words of a search) and in a
//   failed source's note are dropped, since they cite nothing.
// - "Nothing found" is decided from the tool results: nothing was searched,
//   or the searches found no job, or the details of every job they found were
//   read and none came back. A job found but never read is not "nothing".
// - The review list (details awaiting review, failed sources) of every job
//   the answer is about follows, from the pipeline; when there were more jobs
//   than lists, the answer says how many were left out.

import { formatDay } from '../checks';
import { isCalendarDate } from '../model';
import { stripUnsafe } from '../normalize';
import type {
  Answer,
  AnswerDetail,
  DayContext,
  Findings,
  JobStatus,
  SearchRecord,
} from './answer';
import { dropLinks, keepCitedLinks, numberOrDate, vouchedFor } from './words';

const LINK_LEFT_OUT = 'A link that is in no cited detail was left out.';

/** A day as the answer prints it, with today, tomorrow or yesterday named. */
export function dayLabel(iso: string, days: DayContext): string {
  const named =
    iso === days.today
      ? ' (today)'
      : iso === days.tomorrow
        ? ' (tomorrow)'
        : iso === days.yesterday
          ? ' (yesterday)'
          : '';
  return `${formatDay(iso)}${named}`;
}

/** Text the model or a document wrote, as one line with nothing invisible. */
export function oneLine(text: string): string {
  return stripUnsafe(text)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

type OnDrop = () => void;
const ignore: OnDrop = () => undefined;

/** A name the service prints, quoted, on one line and without links. */
function quotedName(name: string, onDrop: OnDrop = ignore): string {
  const kept = dropLinks(oneLine(name));
  if (kept.dropped > 0) onDrop();
  return `"${kept.text}"`;
}

function sourceWords(detail: AnswerDetail, onDrop: OnDrop): string {
  const s = detail.source;
  const name = quotedName(s.name, onDrop);
  const kind =
    s.kind && s.kind !== 'Other' && s.kind !== 'Not about a job'
      ? `the ${s.kind.toLowerCase()} ${name}`
      : name;
  return detail.page !== undefined ? `${kind}, p${detail.page}` : kind;
}

/** `the call sheet "Leeds v2.pdf", p2`: the design's "the call sheet, p2", with the source's name. */
export function sourcePhrase(detail: AnswerDetail): string {
  return sourceWords(detail, ignore);
}

function reviewReason(check: string, onDrop: OnDrop): string {
  const kept = dropLinks(oneLine(check.replace(/^Needs review:\s*/u, '')));
  if (kept.dropped > 0) onDrop();
  return kept.text;
}

function writeDetail(
  detail: AnswerDetail,
  days: DayContext,
  onDrop: OnDrop
): string {
  const when =
    detail.day && isCalendarDate(detail.day)
      ? `, ${dayLabel(detail.day, days)}`
      : '';
  const head = `${detail.field}${when}`;
  const value = detail.value.trim();
  if (detail.status === 'Replaced' || detail.status === 'Rejected') {
    const why = detail.status === 'Replaced' ? 'replaced' : 'rejected by you';
    return `${head}: was '${value}' (${why}; ${sourceWords(detail, onDrop)})`;
  }
  let said: string;
  if (detail.origin === 'owner') said = 'entered by you';
  else if (detail.origin === 'note')
    said = `your note ${quotedName(detail.source.name, onDrop)} says '${detail.quote.trim()}'`;
  else
    said = `${sourceWords(detail, onDrop)}${detail.page !== undefined ? ',' : ''} says '${detail.quote.trim()}'`;
  let status: string;
  if (detail.status === 'Confirmed') status = 'confirmed by you';
  else if (detail.status === 'Found') status = 'not confirmed by you';
  else {
    const reason = reviewReason(detail.check, onDrop);
    status = `awaiting your review${reason ? `: ${reason}` : ''}`;
  }
  return detail.origin === 'owner' && detail.status === 'Confirmed'
    ? `${head}: ${value} (${said})`
    : `${head}: ${value} (${said}; ${status})`;
}

/** One detail, written by the service from its stored fields alone. */
export function renderDetail(detail: AnswerDetail, days: DayContext): string {
  return writeDetail(detail, days, ignore);
}

export interface RenderedAnswer {
  readonly text: string;
  readonly lines: readonly string[];
  /** The detail ids printed as answers, in order. */
  readonly cited: readonly string[];
  /** What was left out, and why; already in `lines`. */
  readonly refused: readonly string[];
  /** Decided from the tool results. */
  readonly nothingFound: boolean;
  readonly partial: boolean;
}

export interface RenderInput {
  readonly answer: Answer;
  readonly findings: Findings;
  readonly statuses: readonly JobStatus[];
  readonly days: DayContext;
  /** Jobs the answer is about whose review lists were not fetched (over the cap). */
  readonly statusesLeftOut?: number | undefined;
}

function describeSearch(
  s: SearchRecord,
  days: DayContext,
  onDrop: OnDrop
): string {
  if (s.tool === 'jobs') {
    const parts: string[] = [];
    if (s.query.from && s.query.to)
      parts.push(
        `with a day from ${dayLabel(s.query.from, days)} to ${dayLabel(s.query.to, days)}`
      );
    else if (s.query.from)
      parts.push(`with a day from ${dayLabel(s.query.from, days)}`);
    else if (s.query.to)
      parts.push(`with a day up to ${dayLabel(s.query.to, days)}`);
    if (s.query.name)
      parts.push(`named like ${quotedName(s.query.name, onDrop)}`);
    return `jobs ${parts.join(' and ')}: ${s.count}`;
  }
  if (s.tool === 'details') {
    const parts = [
      `details of ${s.jobName ? quotedName(s.jobName, onDrop) : 'a job'}`,
    ];
    if (s.query.field) parts.push(`for ${s.query.field}`);
    if (s.query.day) parts.push(`on ${dayLabel(s.query.day, days)}`);
    return `${parts.join(' ')}: ${s.count}`;
  }
  return `a source's text: ${s.count} pages`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Writes the answer: every value from its detail, the model's words checked. */
export function renderAnswer(input: RenderInput): RenderedAnswer {
  const { answer, findings, days } = input;
  const lines: string[] = [];
  const refused: string[] = [];
  const cited: string[] = [];
  const refuse = (text: string) => {
    if (!refused.includes(text)) refused.push(text);
  };
  const linkDropped = () => refuse(LINK_LEFT_OUT);
  const partial =
    findings.searches.some((s) => s.partial) ||
    (findings.notRun ?? 0) > 0 ||
    input.statuses.some((s) => s.partial);
  if (partial)
    lines.push('The search was cut short, so this answer may be incomplete.');

  const resolve = (ids: readonly string[]): AnswerDetail[] => {
    const out: AnswerDetail[] = [];
    for (const id of ids) {
      const d = findings.details.get(id);
      if (d === undefined) {
        refuse('A detail the search did not return was left out.');
        continue;
      }
      if (!out.includes(d)) out.push(d);
    }
    return out;
  };
  const cite = (ds: readonly AnswerDetail[]) => {
    for (const d of ds) if (!cited.includes(d.id)) cited.push(d.id);
  };
  const bullet = (d: AnswerDetail) => `• ${writeDetail(d, days, linkDropped)}`;

  for (const statement of answer.statements) {
    if (statement.kind === 'details') {
      const ds = resolve(statement.details);
      if (ds.length === 0) continue;
      cite(ds);
      let words = oneLine(statement.words).replace(/[:\s]+$/u, '');
      if (words !== '' && numberOrDate(words) !== undefined) {
        refuse(
          'Words of the answer were left out: they gave a number or date of their own, not from a detail and not labelled as an estimate.'
        );
        words = '';
      }
      if (words !== '') {
        const kept = keepCitedLinks(words, ds);
        if (kept.dropped > 0) linkDropped();
        words = vouchedFor(words, ds)
          ? kept.text
          : `${kept.text} (not checked)`;
        lines.push(`${words}:`);
      }
      for (const d of ds) lines.push(bullet(d));
      continue;
    }
    if (statement.kind === 'estimate') {
      const ds = resolve(statement.details);
      const basis = oneLine(statement.basis);
      const estimate = oneLine(statement.estimate);
      if (basis === '' || estimate === '') {
        refuse('An estimate was left out: it did not say what it is based on.');
        continue;
      }
      cite(ds);
      const e = keepCitedLinks(estimate, ds);
      const b = keepCitedLinks(basis, ds);
      if (e.dropped + b.dropped > 0) linkDropped();
      lines.push(`Estimate (not checked): ${e.text}. Based on: ${b.text}.`);
      for (const d of ds) lines.push(bullet(d));
      continue;
    }
    const text = oneLine(
      statement.kind === 'note' ? statement.text : statement.what
    );
    if (text === '') continue;
    if (numberOrDate(text) !== undefined) {
      refuse(
        'A sentence of the answer was left out: it gave a number or date without labelling it as an estimate with its basis.'
      );
      continue;
    }
    const kept = dropLinks(text);
    if (kept.dropped > 0) linkDropped();
    lines.push(
      statement.kind === 'note'
        ? `(not checked) ${kept.text}`
        : `(not checked) Not found: ${kept.text}`
    );
  }

  const nothing = nothingFoundLine(findings, cited.length, days, linkDropped);
  if (nothing.line !== undefined) lines.push(nothing.line);

  for (const r of refused) lines.push(`(${r})`);

  for (const status of input.statuses) {
    const name = quotedName(status.job.name);
    if (status.pending.length === 0) {
      lines.push(`Awaiting your review for ${name}: none.`);
    } else {
      lines.push(`Awaiting your review for ${name}:`);
      for (const d of status.pending)
        lines.push(`• ${writeDetail(d, days, ignore)}`);
    }
    if (status.failed.length > 0) {
      lines.push(`Sources that failed for ${name}:`);
      for (const s of status.failed) {
        const note = s.note ? dropLinks(oneLine(s.note)).text : '';
        lines.push(`• ${quotedName(s.name)}${note ? `: ${note}` : ''}`);
      }
    }
  }
  const leftOut = input.statusesLeftOut ?? 0;
  if (leftOut > 0)
    lines.push(
      `Review lists are shown for ${plural(input.statuses.length, 'job')}; ${plural(leftOut, 'more job')} the search found ${leftOut === 1 ? 'is' : 'are'} not listed.`
    );

  return {
    text: lines.join('\n'),
    lines,
    cited,
    refused,
    nothingFound: nothing.nothingFound,
    partial,
  };
}

/** What the answer says when it cites no detail, decided from the searches. */
function nothingFoundLine(
  findings: Findings,
  citedCount: number,
  days: DayContext,
  onDrop: OnDrop
): { line?: string; nothingFound: boolean } {
  if (citedCount > 0) return { nothingFound: false };
  const searched = findings.searches.filter((s) => s.tool !== 'source_text');
  if (searched.length === 0)
    return { line: 'Nothing found: nothing was searched.', nothingFound: true };
  const described = searched
    .map((s) => describeSearch(s, days, onDrop))
    .join('; ');
  const detailsSeen = findings.details.size;
  const read = new Set(
    searched.flatMap((s) => (s.tool === 'details' ? [s.query.job] : []))
  );
  const jobs = [...findings.jobs.keys()];
  const unread = jobs.filter((id) => !read.has(id));
  if (detailsSeen === 0 && unread.length === 0)
    return {
      line: `Nothing found in the Jobs database (${described}).`,
      nothingFound: true,
    };
  if (detailsSeen === 0) {
    const which =
      unread.length === jobs.length
        ? jobs.length === 1
          ? 'its details'
          : 'their details'
        : `the details of ${unread.length} of them`;
    return {
      line: `No detail was given as the answer; the search found ${plural(jobs.length, 'job')} but did not read ${which} (${described}).`,
      nothingFound: false,
    };
  }
  return {
    line: `No detail was given as the answer; the search returned ${plural(detailsSeen, 'detail')} (${described}).`,
    nothingFound: false,
  };
}
