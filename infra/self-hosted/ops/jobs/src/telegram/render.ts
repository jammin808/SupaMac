// What the bot says, as Telegram HTML (docs/supamac/jobs.md, "What the owner
// does", §4, §5, "Asking", Operations: Health), and the data its buttons
// carry.
//
// Invariants:
// - Every text that comes from a source, a model, a row or a person is put
//   on one line without control or format characters (ai/render.ts
//   `oneLine`) and escaped: `&`, `<` and `>` everywhere, and quotes too inside
//   an attribute. Only this module's own tags reach Telegram, and each opens
//   and closes on one line.
// - A message over 4,096 characters is split on line boundaries; a single
//   line over the limit is cut between tags, entities and characters (never
//   inside one), with its open tags closed at the cut and opened again after
//   it. The limit is counted in UTF-16 units of the HTML itself, which is at
//   least what Telegram counts. A keyboard goes on the last part only.
// - A Found detail is worded "found in <source>, p<n>, not confirmed by you";
//   a detail awaiting review is never called found; a detail read from an
//   image or a scan says "read by the model from an image; no text was
//   checked". Confirmed and Rejected are worded as the owner's own.
// - A filing question says the source's details touch no Jobs row until the
//   owner answers.
// - A Failed source's Retry says what pressing it costs: a source whose
//   model reply was saved but could not be used is read afresh, at the
//   model's cost; any other resumes from where it stopped and never buys a
//   reply already paid for.
// - An answer is printed as ai/render.ts wrote it, line by line, escaped; no
//   link of its own is made clickable.
// - A source's or a job's name, and a refused email's subject, are printed
//   with their links left out ("[link left out]"), as ai/render.ts prints
//   them: a name cites no detail, so a link in it is never made clickable.
//   A name is cut at `NAME_HTML_LIMIT` characters of HTML.
// - Callback data is at most 64 bytes, made only here and read back only
//   by `readCallback`, which takes nothing it did not make.
//
// Choices where the design is silent:
// - The summary's links into SupaMac are the service's own URLs (job and
//   source), so they are links; link previews are off on every message.
// - A value, quote or check on a card is cut at 1,500 characters of its
//   escaped HTML, and says so; when the three would still carry the card
//   past 4,096, each is cut shorter, so the card always keeps its quote and
//   status lines: a card is edited in place and cannot be split.
// - A scan's original goes with a caption under Telegram's 1,024, its
//   source's name cut to fit.
// - A job a filing button names is carried as the first 8 hex characters of
//   the SHA-256 of its id and matched against the question's candidates as
//   they stand when it is pressed, so a question asked again with other
//   candidates cannot file under a job it no longer offers.

import { createHash } from 'node:crypto';
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import type { AnswerJob } from '../ai/answer';
import { oneLine, type RenderedAnswer } from '../ai/render';
import { dropLinks } from '../ai/words';
import { formatDay, SCAN_TEXT } from '../checks';
import type { CellValue } from '../derive';
import {
  type DetailStatus,
  isCalendarDate,
  type SourceKind,
  type SourceStatus,
  type Via,
} from '../model';
import type {
  ConnectionChange,
  EditReport,
  FilingQuestion,
  RefusedMail,
  ReviewCard,
  ServiceNote,
  SourceFailure,
  SourceSummary,
} from '../pipeline/notify';
import { UUID_RE } from '../supamac/api';
import { type Button, type Keyboard, MAX_CAPTION_CHARS } from './api';

export const MESSAGE_LIMIT = 4096;
/** The most of one value, quote or check a card shows, in characters of HTML. */
export const CARD_TEXT_LIMIT = 1500;
/** The least a card cuts a value, quote or check to, to fit one message. */
const CARD_TEXT_FLOOR = 100;
/** The most of a source's or job's name printed, in characters of HTML. */
export const NAME_HTML_LIMIT = 400;
/** The most of a name in the bot's own words, before escaping. */
const NAME_TEXT_LIMIT = 200;
/** The most of a name a button shows. */
const BUTTON_NAME_LIMIT = 40;
/** The most jobs `/jobs` lists. */
export const JOBS_LIST_LIMIT = 20;

export interface OutMessage {
  /** Each at most MESSAGE_LIMIT characters, in order. */
  readonly parts: readonly string[];
  /** Buttons under the last part. */
  readonly keyboard?: Keyboard | undefined;
}

// ---------------------------------------------------------------------------
// Escaping.

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Text from outside the service, on one line and escaped. */
export function safe(text: string): string {
  return escapeHtml(oneLine(text));
}

/**
 * Free text a document or the model may have shaped (a reason, a note, a
 * name, a sender), on one line, escaped, with every link left out: only a
 * detail's own value and quote are shown with their links, beside their
 * status.
 */
export function prose(text: string): string {
  return safe(dropLinks(oneLine(text)).text);
}

/** Text shown as code, which Telegram never makes into a link. */
export function inert(text: string): string {
  return `<code>${safe(text)}</code>`;
}

/** `one` escaped, cut between characters to at most `limit` characters of HTML. */
function escapedWithin(
  one: string,
  limit: number
): { readonly html: string; readonly cut: boolean } {
  let html = '';
  for (const ch of one) {
    const e =
      ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch;
    if (html.length + e.length > limit) return { html, cut: true };
    html += e;
  }
  return { html, cut: false };
}

/** Text from outside on one line, escaped, at most `limit` characters of HTML and a note that it was cut. */
function cut(text: string, limit: number = CARD_TEXT_LIMIT): string {
  const r = escapedWithin(oneLine(text), limit);
  return r.cut ? `${r.html}… (cut here; the whole text is in SupaMac)` : r.html;
}

/** Text from outside on one line, escaped, at most `limit` characters of HTML and an ellipsis. */
function clip(text: string, limit: number): string {
  const r = escapedWithin(oneLine(text), limit);
  return r.cut ? `${r.html}…` : r.html;
}

/** A name as the service prints it, before escaping: one line, bounded, its links left out. */
export function nameText(
  name: string,
  limit: number = NAME_TEXT_LIMIT
): string {
  const one = dropLinks(oneLine(name)).text;
  if (one.length <= limit) return one;
  const end = /[\uD800-\uDBFF]/.test(one.charAt(limit - 2))
    ? limit - 2
    : limit - 1;
  return `${one.slice(0, end)}…`;
}

/** A name as the service prints it, as HTML (see the header). */
export function nameHtml(
  name: string,
  limit: number = NAME_HTML_LIMIT
): string {
  return clip(dropLinks(oneLine(name)).text, limit);
}

function link(href: string, text: string): string {
  return `<a href="${escapeAttr(href)}">${escapeHtml(text)}</a>`;
}

// ---------------------------------------------------------------------------
// Splitting.

type Token =
  | { readonly kind: 'open'; readonly text: string; readonly name: string }
  | { readonly kind: 'close'; readonly text: string; readonly name: string }
  | { readonly kind: 'text'; readonly text: string; readonly space: boolean };

const TOKEN_RE =
  /<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*)?>|&(?:#\d{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{0,31});|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g;

function tokens(line: string): Token[] {
  const out: Token[] = [];
  for (const m of line.matchAll(TOKEN_RE)) {
    const text = m[0];
    if (m[1] !== undefined)
      out.push({ kind: 'close', text, name: m[1].toLowerCase() });
    else if (m[2] !== undefined)
      out.push({ kind: 'open', text, name: m[2].toLowerCase() });
    else out.push({ kind: 'text', text, space: /^\s$/.test(text) });
  }
  return out;
}

interface OpenTag {
  readonly name: string;
  /** The opening tag as written, to open it again after a cut. */
  readonly text: string;
}

function closers(stack: readonly OpenTag[]): string {
  return [...stack]
    .reverse()
    .map((t) => `</${t.name}>`)
    .join('');
}

/** The tags open after `token`, given those open before it. */
function afterToken(open: readonly OpenTag[], token: Token): OpenTag[] {
  if (token.kind === 'open')
    return [...open, { name: token.name, text: token.text }];
  if (token.kind === 'close') {
    const at = open.map((t) => t.name).lastIndexOf(token.name);
    return at >= 0 ? open.slice(0, at) : [...open];
  }
  return [...open];
}

/**
 * Cuts one line over the limit between tokens, at its last space where
 * there is one, closing the tags open at the cut and opening them again at
 * the start of the next piece. A piece with its closing tags never passes
 * the limit: the tags a cut closes are closed later in the line, or are
 * still open at its end, and both were counted when the token was added.
 */
function splitLine(line: string, limit: number): string[] {
  const pieces: string[] = [];
  let startOpen: OpenTag[] = [];
  let prefix = '';
  let body: { token: Token; open: OpenTag[] }[] = [];
  let length = 0;
  let open: OpenTag[] = [];

  const flush = (count: number, dropNext: boolean): void => {
    const head = body.slice(0, count);
    const endOpen = head.at(-1)?.open ?? startOpen;
    pieces.push(
      `${prefix}${head.map((b) => b.token.text).join('')}${closers(endOpen)}`
    );
    let rest = body.slice(count);
    let restOpen = endOpen;
    if (dropNext && rest[0] !== undefined) {
      restOpen = rest[0].open;
      rest = rest.slice(1);
    }
    startOpen = restOpen;
    prefix = restOpen.map((t) => t.text).join('');
    body = rest;
    length = prefix.length + body.reduce((n, b) => n + b.token.text.length, 0);
  };

  for (const token of tokens(line)) {
    const next = afterToken(open, token);
    while (
      body.length > 0 &&
      length + token.text.length + closers(next).length > limit
    ) {
      let space = -1;
      for (let i = body.length - 1; i > 0; i--) {
        const b = body[i];
        if (b !== undefined && b.token.kind === 'text' && b.token.space) {
          space = i;
          break;
        }
      }
      if (space > 0) flush(space, true);
      else flush(body.length, false);
    }
    body.push({ token, open: next });
    length += token.text.length;
    open = next;
  }
  if (body.length > 0) flush(body.length, false);
  return pieces;
}

/** Splits a message on line boundaries into parts of at most `limit` characters. */
export function splitMessage(
  html: string,
  limit: number = MESSAGE_LIMIT
): string[] {
  const parts: string[] = [];
  let current = '';
  const push = (): void => {
    if (current.trim() !== '') parts.push(current.replace(/\n+$/, ''));
    current = '';
  };
  for (const line of html.split('\n')) {
    const pieces = line.length <= limit ? [line] : splitLine(line, limit);
    for (const piece of pieces) {
      if (current === '') current = piece;
      else if (current.length + 1 + piece.length <= limit)
        current = `${current}\n${piece}`;
      else {
        push();
        current = piece;
      }
    }
  }
  push();
  return parts;
}

function message(lines: readonly (string | undefined)[], keyboard?: Keyboard) {
  const html = lines.filter((l): l is string => l !== undefined).join('\n');
  const out: OutMessage = {
    parts: splitMessage(html),
    ...(keyboard !== undefined && keyboard.length > 0 ? { keyboard } : {}),
  };
  return out;
}

// ---------------------------------------------------------------------------
// Callback data.

export type Callback =
  /** The summary's Review: the first card of the source, as a new message. */
  | { readonly kind: 'review'; readonly sourceId: string }
  /** A card's Continue: the first card left of the source, in place. */
  | { readonly kind: 'continue'; readonly sourceId: string }
  | {
      readonly kind: 'decide';
      readonly action: 'confirm' | 'reject' | 'skip';
      readonly detailId: string;
      readonly fingerprint: string;
    }
  /** A scan's card: the original, as a document. */
  | {
      readonly kind: 'original';
      readonly detailId: string;
      readonly fingerprint: string;
    }
  | {
      readonly kind: 'file';
      readonly sourceId: string;
      readonly part: number | null;
      /** `jobKey` of a candidate, or a new job. */
      readonly job: string | 'new';
    }
  | {
      readonly kind: 'retry';
      readonly sourceId: string;
      /** A fresh reading, at the model's cost. */
      readonly fresh: boolean;
    };

const ACTION_CODES = { confirm: 'c', reject: 'x', skip: 's' } as const;
const FINGERPRINT_RE = /^[0-9A-Za-z_-]{4,20}$/;
const JOB_KEY_RE = /^[0-9a-f]{8}$/;

/** A job as a filing button names it (see the header). */
export function jobKey(jobId: string): string {
  return createHash('sha256').update(jobId).digest('hex').slice(0, 8);
}

export class RenderError extends Error {
  readonly kind = 'callback_data' as const;
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

function id(value: string, what: string): string {
  if (!UUID_RE.test(value)) throw new RenderError(`${what} must be a UUID`);
  return value.toLowerCase();
}

export function callbackData(callback: Callback): string {
  let data: string;
  switch (callback.kind) {
    case 'review':
      data = `v:${id(callback.sourceId, 'a source id')}`;
      break;
    case 'continue':
      data = `w:${id(callback.sourceId, 'a source id')}`;
      break;
    case 'decide':
    case 'original': {
      if (!FINGERPRINT_RE.test(callback.fingerprint))
        throw new RenderError('a fingerprint must be 4 to 20 plain characters');
      const code =
        callback.kind === 'original' ? 'o' : ACTION_CODES[callback.action];
      data = `${code}:${id(callback.detailId, 'a detail id')}:${callback.fingerprint}`;
      break;
    }
    case 'file': {
      const part = callback.part === null ? '-' : String(callback.part);
      if (
        callback.part !== null &&
        !(callback.part >= 0 && callback.part < 100)
      )
        throw new RenderError('a part is 0 to 99');
      if (callback.job !== 'new' && !JOB_KEY_RE.test(callback.job))
        throw new RenderError('a job key is 8 hex characters');
      data = `f:${id(callback.sourceId, 'a source id')}:${part}:${callback.job}`;
      break;
    }
    case 'retry':
      data = `${callback.fresh ? 'n' : 't'}:${id(callback.sourceId, 'a source id')}`;
      break;
  }
  if (new TextEncoder().encode(data).length > 64)
    throw new RenderError('callback data is over 64 bytes');
  return data;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CALLBACK_RE = new RegExp(
  `^(?:([vwtn]):(${UUID})|([cxso]):(${UUID}):([0-9A-Za-z_-]{4,20})|f:(${UUID}):(-|\\d{1,2}):([0-9a-f]{8}|new))$`
);

/** Reads callback data back; undefined for anything `callbackData` did not make. */
export function readCallback(data: string | undefined): Callback | undefined {
  if (data === undefined) return undefined;
  const m = CALLBACK_RE.exec(data);
  if (!m) return undefined;
  if (m[1] !== undefined && m[2] !== undefined) {
    const sourceId = m[2];
    if (m[1] === 'v') return { kind: 'review', sourceId };
    if (m[1] === 'w') return { kind: 'continue', sourceId };
    return { kind: 'retry', sourceId, fresh: m[1] === 'n' };
  }
  if (m[3] !== undefined && m[4] !== undefined && m[5] !== undefined) {
    if (m[3] === 'o')
      return { kind: 'original', detailId: m[4], fingerprint: m[5] };
    const action = m[3] === 'c' ? 'confirm' : m[3] === 'x' ? 'reject' : 'skip';
    return { kind: 'decide', action, detailId: m[4], fingerprint: m[5] };
  }
  if (m[6] !== undefined && m[7] !== undefined && m[8] !== undefined)
    return {
      kind: 'file',
      sourceId: m[6],
      part: m[7] === '-' ? null : Number(m[7]),
      job: m[8],
    };
  return undefined;
}

function button(text: string, callback: Callback): Button {
  return { text, data: callbackData(callback) };
}

function buttonName(name: string): string {
  const one = oneLine(name) || '(no name)';
  return one.length > BUTTON_NAME_LIMIT
    ? `${one.slice(0, BUTTON_NAME_LIMIT - 1)}…`
    : one;
}

// ---------------------------------------------------------------------------
// Words.

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** An instant in the owner's zone, "3 Mar 2027 14:05". */
export function instantText(iso: string, timeZone: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return oneLine(iso);
  return format(new TZDate(ms, timeZone), 'd MMM yyyy HH:mm');
}

function dayWords(text: string): string {
  return isCalendarDate(text) ? formatDay(text) : text;
}

/** A Jobs cell as the summary prints it. */
export function cellText(value: CellValue): string {
  if (value === null) return 'empty';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string')
    return value.trim() === '' ? 'empty' : `"${safe(dayWords(value))}"`;
  if (Array.isArray(value)) {
    const items = (value as readonly string[]).filter((v) => v.trim() !== '');
    return items.length === 0
      ? 'empty'
      : `"${items.map((v) => safe(dayWords(v))).join('; ')}"`;
  }
  const range = value as { start: string; end: string };
  return `${safe(dayWords(range.start))} to ${safe(dayWords(range.end))}`;
}

const VIA_WORDS: Readonly<Record<Via, string>> = {
  Email: 'by email',
  Telegram: 'on Telegram',
  Folder: 'in the Job intake folder',
  Note: 'as your note',
};

function kindWords(kind: SourceKind | undefined): string | undefined {
  if (kind === undefined || kind === 'Other') return undefined;
  if (kind === 'Not about a job') return 'not about a job';
  const lower = kind.toLowerCase();
  return `${/^[aeiou]/.test(lower) ? 'an' : 'a'} ${lower}`;
}

const SOURCE_STATUS_WORDS: Readonly<Record<SourceStatus, string>> = {
  Processing: 'still being read',
  Processed: 'read',
  'Needs review': 'read; something needs your look',
  'Not a job': 'read; not about a job',
  Skipped: 'not read',
  Failed: 'failed',
};

/** "invite.pdf, p2" */
function wherePhrase(
  name: string | undefined,
  page: number | undefined
): string {
  const shown = name === undefined ? '' : nameHtml(name);
  const source = shown !== '' ? shown : 'its source';
  return page !== undefined ? `${source}, p${page}` : source;
}

/** What a detail's status means, worded as design §4 asks; a reason is cut at `limit`. */
export function statusWords(
  card: ReviewCard,
  limit: number = CARD_TEXT_LIMIT
): string {
  const where = wherePhrase(card.sourceName, card.page);
  const scan = card.imageNote !== undefined;
  switch (card.status) {
    case 'Found':
      return scan
        ? `${safe(card.imageNote ?? '')} (${where}); not confirmed by you`
        : `found in ${where}, not confirmed by you`;
    case 'Needs review': {
      const reason = oneLine(card.check.replace(/^Needs review:\s*/u, ''));
      const why =
        reason !== '' ? `: ${cut(dropLinks(reason).text, limit)}` : '';
      return scan
        ? `${safe(card.imageNote ?? '')} (${where}); needs your review${why}; not confirmed by you`
        : `in ${where}; needs your review${why}; not confirmed by you`;
    }
    case 'Confirmed':
      return `confirmed by you (from ${where})`;
    case 'Rejected':
      return `rejected by you (from ${where})`;
    case 'Replaced':
      return `replaced by a newer source (was from ${where})`;
  }
}

// ---------------------------------------------------------------------------
// The source summary.

/** A job's name in bold, as the service prints a name. */
function jobName(name: string | undefined): string {
  return `<b>${nameHtml(name ?? '') || '(no name)'}</b>`;
}

export function summaryMessage(
  summary: SourceSummary,
  timeZone: string
): OutMessage {
  const lines: (string | undefined)[] = [];
  const kind = kindWords(summary.kind);
  const name = nameHtml(summary.name) || '(no name)';
  lines.push(
    `<b>${name}</b>: ${VIA_WORDS[summary.via]}${kind ? `, ${kind}` : ''}; ${SOURCE_STATUS_WORDS[summary.status]}.`
  );
  if (summary.jobs.length === 1) {
    const job = summary.jobs[0] as SourceSummary['jobs'][number];
    lines.push(
      `Filed under ${jobName(job.name)}${job.created ? ' (a new job)' : ''}.`
    );
  } else if (summary.jobs.length > 1) {
    lines.push('Filed under:');
    for (const job of summary.jobs)
      lines.push(`• ${jobName(job.name)}${job.created ? ' (a new job)' : ''}`);
  } else if (summary.status === 'Not a job') {
    lines.push('Not filed under a job.');
  } else {
    lines.push(
      'Not filed under a job yet; its details touch no Jobs row until it is.'
    );
  }
  const c = summary.counts;
  if (c.details === 0) {
    lines.push('No details were found in it.');
  } else {
    lines.push(
      `${plural(c.details, 'detail')}: ${c.found} found in ${name}, not confirmed by you; ${c.needsReview} ${c.needsReview === 1 ? 'needs' : 'need'} a look.`
    );
  }
  if (c.replaced > 0)
    lines.push(
      `${plural(c.replaced, 'older detail')} of the job ${c.replaced === 1 ? 'was' : 'were'} replaced.`
    );
  if (summary.changes.length > 0) {
    const where =
      summary.jobs.length === 1 ? ` in ${jobName(summary.jobs[0]?.name)}` : '';
    lines.push(`What changed${where}:`);
    for (const ch of summary.changes)
      lines.push(
        `• ${safe(ch.column)}: from ${cellText(ch.from)} to ${cellText(ch.to)}`
      );
  }
  if (summary.kept.length > 0) {
    lines.push('Kept as you typed it, though a source disagrees:');
    for (const k of summary.kept)
      lines.push(
        `• ${safe(k.column)}: yours ${cellText(k.owner)}; the sources say ${cellText(k.sources)}`
      );
  }
  if (summary.notes.length > 0) {
    lines.push('Notes:');
    for (const n of summary.notes) lines.push(`• ${prose(n)}`);
  }
  if (summary.sourceNote !== undefined && summary.sourceNote.trim() !== '')
    lines.push(`Note on the source: ${prose(summary.sourceNote)}`);
  if (summary.decidedInSupamac.length > 0) {
    lines.push(
      'Confirmed or rejected in SupaMac since the last summary. SupaMac records code run for you as you, so check that each was yours:'
    );
    for (const d of summary.decidedInSupamac)
      lines.push(
        `• ${prose(d.name)}: ${safe(d.status)} in SupaMac, ${escapeHtml(instantText(d.at, timeZone))}`
      );
  }
  const links: string[] = [];
  if (summary.links?.job !== undefined)
    links.push(link(summary.links.job, 'The job in SupaMac'));
  if (summary.links?.source !== undefined)
    links.push(link(summary.links.source, 'The source in SupaMac'));
  if (links.length > 0) lines.push(links.join(' · '));
  const keyboard: Keyboard =
    summary.review.length > 0
      ? [
          [
            button(`Review ${summary.review.length}`, {
              kind: 'review',
              sourceId: summary.sourceId,
            }),
          ],
        ]
      : [];
  return message(lines, keyboard);
}

// ---------------------------------------------------------------------------
// Review cards.

export interface CardOptions {
  /** A line above the card: what the last press did. */
  readonly lead?: string | undefined;
  /** How many other details of the source still need a look. */
  readonly remaining?: number | undefined;
}

/** A card's text with its value, quote and check each cut at `limit`. */
function cardHtml(
  card: ReviewCard,
  options: CardOptions,
  limit: number
): string {
  const lines: string[] = [];
  if (options.lead !== undefined) lines.push(options.lead, '');
  const label =
    oneLine(card.label) !== '' && oneLine(card.label) !== card.field
      ? ` (labelled "${cut(card.label, 200)}")`
      : '';
  lines.push(
    `<b>${safe(card.field)}</b>${label}: <b>${cut(card.value, limit)}</b>`
  );
  if (card.day !== undefined && card.day.trim() !== '')
    lines.push(`Day: ${cut(dayWords(card.day), 200)}`);
  lines.push(`Quote: "${cut(card.quote, limit)}"`);
  lines.push(`Status: ${statusWords(card, limit)}.`);
  if (card.link !== undefined)
    lines.push(link(card.link, 'The page in SupaMac'));
  if (options.remaining !== undefined)
    lines.push(
      options.remaining === 0
        ? 'Nothing else from this source needs a look.'
        : `${plural(options.remaining, 'other detail')} from this source ${options.remaining === 1 ? 'needs' : 'need'} a look.`
    );
  return lines.join('\n');
}

/**
 * A card's text and buttons; one part, since a card is edited in place. Its
 * value, quote and check are cut shorter until the card fits one message.
 */
export function reviewCardMessage(
  card: ReviewCard,
  options: CardOptions = {}
): { readonly html: string; readonly keyboard: Keyboard } {
  let limit = CARD_TEXT_LIMIT;
  let html = cardHtml(card, options, limit);
  while (html.length > MESSAGE_LIMIT && limit > CARD_TEXT_FLOOR) {
    limit = Math.max(CARD_TEXT_FLOOR, Math.floor(limit * 0.75));
    html = cardHtml(card, options, limit);
  }
  // Only a lead longer than a message could leave it over the limit.
  if (html.length > MESSAGE_LIMIT) html = splitMessage(html)[0] ?? '';
  const rows: Button[][] = [];
  if (card.status === 'Needs review' || card.status === 'Found') {
    const fp = card.fingerprint;
    const d = card.detailId;
    rows.push([
      button('Confirm', {
        kind: 'decide',
        action: 'confirm',
        detailId: d,
        fingerprint: fp,
      }),
      button('Reject', {
        kind: 'decide',
        action: 'reject',
        detailId: d,
        fingerprint: fp,
      }),
      button('Skip', {
        kind: 'decide',
        action: 'skip',
        detailId: d,
        fingerprint: fp,
      }),
    ]);
  } else if (card.sourceId !== undefined) {
    rows.push([
      button('Continue', { kind: 'continue', sourceId: card.sourceId }),
    ]);
  }
  if (card.imageNote !== undefined && card.documentId !== undefined)
    rows.push([
      button('Original', {
        kind: 'original',
        detailId: card.detailId,
        fingerprint: card.fingerprint,
      }),
    ]);
  return { html, keyboard: rows };
}

/** The caption of a scan's original: where it is, and that its text was not checked. */
export function originalCaption(
  card: Pick<ReviewCard, 'sourceName' | 'page'>
): string {
  const tail = `: the original. ${escapeHtml(SCAN_TEXT)}.`;
  const page = card.page !== undefined ? `, p${card.page}` : '';
  // The name's ellipsis takes one character more than its limit.
  const room = MAX_CAPTION_CHARS - tail.length - page.length - 1;
  const name =
    card.sourceName === undefined
      ? ''
      : nameHtml(card.sourceName, Math.min(NAME_HTML_LIMIT, room));
  return `${name !== '' ? name : 'the source'}${page}${tail}`;
}

/** What a press did, as the line above the next card. */
export function decisionLead(
  card: ReviewCard,
  status: DetailStatus | 'skipped'
): string {
  const what = `${safe(card.field)}: ${cut(card.value, 200)}`;
  if (status === 'skipped') return `Skipped ${what}; it still needs a look.`;
  if (status === 'Confirmed') return `Confirmed by you: ${what}.`;
  if (status === 'Rejected') return `Rejected by you: ${what}.`;
  return `${safe(status)}: ${what}.`;
}

export const CHANGED_LEAD =
  'This detail changed in SupaMac after the card was sent, so nothing was recorded. This is how it reads now:';

/** The end of a walk through a source's cards. */
export function walkEndMessage(
  sourceName: string | undefined,
  sourceId: string | undefined,
  lead: string | undefined,
  left: number
): { readonly html: string; readonly keyboard: Keyboard } {
  const lines: string[] = [];
  if (lead !== undefined) lines.push(lead, '');
  const shown = sourceName === undefined ? '' : nameHtml(sourceName);
  const name = shown !== '' ? `<b>${shown}</b>` : 'this source';
  if (left === 0) {
    lines.push(`Nothing else from ${name} needs a look.`);
    return { html: lines.join('\n'), keyboard: [] };
  }
  lines.push(
    `That was the last card of ${name} in this round; ${plural(left, 'detail')} you skipped still ${left === 1 ? 'needs' : 'need'} a look.`
  );
  return {
    html: lines.join('\n'),
    keyboard:
      sourceId !== undefined
        ? [[button('Start again', { kind: 'continue', sourceId })]]
        : [],
  };
}

export const MISSING_TEXT =
  'This detail is no longer in the Jobs database, so nothing was recorded.';

// ---------------------------------------------------------------------------
// Filing questions.

/** One message per part of the question, each with its own buttons. */
export function filingMessages(question: FilingQuestion): OutMessage[] {
  const total = question.parts.length;
  return question.parts.map((part, index) => {
    const lines: string[] = [];
    const which = total > 1 ? `part ${index + 1} of ${total} of ` : '';
    lines.push(
      `<b>Which job is ${which}${nameHtml(question.sourceName) || 'this source'} for?</b>`
    );
    if (part.names.length > 0)
      lines.push(
        `It names: ${part.names.map((n) => `"${nameHtml(n)}"`).join(', ')}`
      );
    if (part.reason.trim() !== '')
      lines.push(`Not filed by itself: ${prose(part.reason)}`);
    if (part.candidates.length === 1) {
      const c = part
        .candidates[0] as FilingQuestion['parts'][number]['candidates'][number];
      lines.push(`File under ${jobName(c.name)}? ${prose(c.why)}`);
    } else if (part.candidates.length > 1) {
      lines.push('It may be one of these:');
      for (const c of part.candidates)
        lines.push(`• ${jobName(c.name)}: ${prose(c.why)}`);
    } else {
      lines.push('No job on file matches it.');
    }
    lines.push('Its details touch no Jobs row until you answer.');
    const rows: Button[][] = part.candidates.map((c) => [
      button(
        part.candidates.length === 1
          ? 'Yes'
          : `File under ${buttonName(c.name)}`,
        {
          kind: 'file',
          sourceId: question.sourceId,
          part: part.part,
          job: jobKey(c.jobId),
        }
      ),
    ]);
    rows.push([
      button('New job', {
        kind: 'file',
        sourceId: question.sourceId,
        part: part.part,
        job: 'new',
      }),
    ]);
    return message(lines, rows);
  });
}

// ---------------------------------------------------------------------------
// Notes.

export function refusedMailMessage(note: RefusedMail): OutMessage {
  return message([
    '<b>An email to the jobs mailbox was refused and not read.</b>',
    `From: ${inert(note.from)}`,
    note.subject !== undefined
      ? `Subject: ${nameHtml(note.subject)}`
      : undefined,
    `The check that failed: ${prose(note.check)}`,
  ]);
}

/** The most senders a running refusal note lists by domain. */
export const REFUSAL_DOMAINS_SHOWN = 10;

/** Refusals since the first of a running note, kept up to date in one message. */
export interface RefusalTally {
  readonly count: number;
  readonly since: string;
  readonly domains: readonly string[];
  readonly last: RefusedMail;
}

/** One message for every refusal of the hour: the count, the sender domains, the last one in full. */
export function refusalTallyMessage(
  tally: RefusalTally,
  timeZone: string
): OutMessage {
  if (tally.count === 1) return refusedMailMessage(tally.last);
  const shown = tally.domains.slice(0, REFUSAL_DOMAINS_SHOWN);
  const more = tally.domains.length - shown.length;
  return message([
    `<b>${tally.count} emails to the jobs mailbox were refused and not read since ${escapeHtml(instantText(tally.since, timeZone))}.</b>`,
    `Sender domains: ${shown.map(inert).join(', ')}${more > 0 ? ` and ${more} more` : ''}`,
    `The last, from ${inert(tally.last.from)}: ${prose(tally.last.check)}`,
    'Each is in the mailbox’s Refused folder, and the service’s log has a line for each.',
  ]);
}

const CONNECTION_NAMES: Readonly<
  Record<ConnectionChange['connection'], string>
> = {
  supamac: 'SupaMac',
  anthropic: 'Anthropic (the model)',
  telegram: 'Telegram',
  mail: 'The jobs mailbox',
};

export function connectionMessage(
  change: ConnectionChange,
  timeZone: string
): OutMessage {
  const name = CONNECTION_NAMES[change.connection];
  const since = escapeHtml(instantText(change.since, timeZone));
  return message([
    change.up
      ? `${name} is answering again (since ${since}).`
      : `${name} is not answering (since ${since})${change.detail ? `: ${prose(change.detail)}` : '.'}`,
  ]);
}

const NOTE_HEADINGS: Readonly<Record<ServiceNote['kind'], string>> = {
  schema: 'The Jobs database',
  spend_limit: 'The AI spend limit',
  setup: 'Setup',
  error: 'The jobs service',
};

export function noteMessage(note: ServiceNote): OutMessage {
  return message([`<b>${NOTE_HEADINGS[note.kind]}</b>`, prose(note.text)]);
}

export function failureMessage(
  failure: SourceFailure,
  options: { readonly freshReading: boolean }
): OutMessage {
  const lines = [
    `<b>${nameHtml(failure.name) || 'A source'} failed.</b>`,
    `Why: ${prose(failure.reason)}`,
    failure.attempts > 0 ? `Attempts: ${failure.attempts}.` : undefined,
    options.freshReading
      ? 'The model’s reply could not be used. Read again asks the model for a fresh reading, at the model’s cost.'
      : 'Retry runs it again from where it stopped; a model reply already paid for is not bought again.',
  ];
  return message(lines, [
    [
      button(options.freshReading ? 'Read again (new cost)' : 'Retry', {
        kind: 'retry',
        sourceId: failure.retry.sourceId,
        fresh: options.freshReading,
      }),
    ],
  ]);
}

const EDIT_ACTIONS: Readonly<
  Record<EditReport['agent'][number]['action'], string>
> = {
  undone: 'undone',
  needs_review: 'set to Needs review',
  reported: 'left as it is',
};

const TABLE_NAMES: Readonly<
  Record<EditReport['agent'][number]['table'], string>
> = {
  details: 'Details',
  jobs: 'Jobs',
  sources: 'Sources',
};

/** Undefined when there is nothing to say. */
export function editsMessage(report: EditReport): OutMessage | undefined {
  if (report.agent.length === 0 && report.unchecked.length === 0)
    return undefined;
  const lines: string[] = [];
  if (report.agent.length > 0) {
    lines.push(
      '<b>An agent (the assistant or a routine) changed the Jobs database.</b> Documents can carry instructions; only you decide. What the service did:'
    );
    for (const a of report.agent) {
      const by =
        a.actingBot !== undefined && a.actingBot !== null && a.actingBot !== ''
          ? ` (by ${safe(a.actingBot)})`
          : '';
      lines.push(
        `• ${TABLE_NAMES[a.table]} "${prose(a.name)}": ${prose(a.what)}; ${EDIT_ACTIONS[a.action]}${by}`
      );
    }
  }
  if (report.unchecked.length > 0)
    lines.push(
      `These tables could not be checked change by change: ${report.unchecked.map((t) => safe(t)).join(', ')}.`
    );
  return message(lines);
}

// ---------------------------------------------------------------------------
// Answers, lists and the bot's own words.

/** An answer as ai/render.ts wrote it, escaped line by line. */
export function answerMessage(rendered: RenderedAnswer): OutMessage {
  const lines = rendered.lines.length > 0 ? rendered.lines : [rendered.text];
  return message(lines.map((l) => escapeHtml(l)));
}

/** The bot's own words, which may carry names and reasons: each line cleaned and escaped. */
export function plainMessage(text: string): OutMessage {
  return message(text.split('\n').map((l) => safe(l)));
}

function jobWhen(job: AnswerJob): string | undefined {
  if (job.dates !== undefined)
    return `${safe(dayWords(job.dates.start))} to ${safe(dayWords(job.dates.end))}`;
  const days = job.days ?? [];
  if (days.length === 0) return undefined;
  return days.map((d) => safe(dayWords(d))).join(', ');
}

function firstDay(job: AnswerJob): string {
  return job.dates?.start ?? job.days?.[0] ?? '9999-12-31';
}

/** `/jobs`: the jobs with a day from today on. */
export function jobsListMessage(
  jobs: readonly AnswerJob[],
  today: string,
  partial: boolean
): OutMessage {
  const lines: string[] = [];
  if (partial)
    lines.push('The search was cut short, so this list may be incomplete.');
  if (jobs.length === 0) {
    lines.push(
      `No job in the Jobs database has a day from ${safe(formatDay(today))} on.`
    );
    return message(lines);
  }
  const sorted = [...jobs].sort((a, b) =>
    firstDay(a) === firstDay(b)
      ? a.name.localeCompare(b.name)
      : firstDay(a) < firstDay(b)
        ? -1
        : 1
  );
  lines.push(`<b>Jobs from ${safe(formatDay(today))} on</b>`);
  for (const job of sorted.slice(0, JOBS_LIST_LIMIT)) {
    const when = jobWhen(job);
    const client = job.client !== undefined ? ` (${prose(job.client)})` : '';
    lines.push(`• ${jobName(job.name)}${client}${when ? `: ${when}` : ''}`);
  }
  if (sorted.length > JOBS_LIST_LIMIT)
    lines.push(
      `${plural(sorted.length - JOBS_LIST_LIMIT, 'more job')} not listed.`
    );
  lines.push(
    'Days and names come from details that may not be confirmed. Ask about a job to see each detail with its source and status.'
  );
  return message(lines);
}

export const HELP_TEXT = [
  'Send me a source and I read it into the Jobs database:',
  '• a file (PDF, Word, Excel, CSV, calendar file) or a photo',
  '• a message forwarded from someone',
  '• /add <text>: your own note, kept as "your note"',
  'Anything else you type is a question, answered from the Jobs database, for example "where am I staying in Leeds?".',
  '/jobs lists the jobs from today on.',
  '/tz <zone> sets your time zone, such as /tz Europe/London.',
  'Files over 20 MB cannot reach a Telegram bot: email them to the jobs mailbox instead.',
].join('\n');

export const LINKED_TEXT =
  'Linked: this chat now receives the jobs service’s messages, and only you can use this bot.';

export const TOO_BIG_TEXT =
  'Telegram bots cannot receive files over 20 MB, so this one was not read. Email it to the jobs mailbox, or drop it into the Job intake folder in SupaMac, instead.';

export const CAPTION_TEXT =
  'The caption was not read. To keep it, send it as your note with /add.';

export const UNREAD_TEXT =
  'This kind of message is not read. Send a file, a photo, a forwarded message or /add <note>, or type a question.';

export function offText(why: string): string {
  return `Telegram is not taking sources or questions now: ${why}.`;
}

export const HALT_CONFLICT_TEXT =
  'Another program is reading this bot’s messages: Telegram reported a second poller (HTTP 409). The jobs service stopped using Telegram. Revoke the bot token in BotFather (/revoke), put the new token in jobs.env and redeploy.';

export const HALT_WEBHOOK_TEXT =
  'A webhook is set on this bot, so another service receives its messages. The jobs service stopped using Telegram. Revoke the bot token in BotFather (/revoke), put the new token in jobs.env and redeploy.';
