// Email messages (docs/supamac/jobs.md §2): the HTML part as text, else the
// plain part; quoted history and forwarded messages as pages of their own,
// each with its own date and sender; attachments listed for the pipeline.
//
// Invariants:
// - The HTML part is read when there is one; the plain part is read instead
//   when the HTML part shows no text (an image alone) or is too big to read
//   (over `htmlChars` characters or `xmlElements` tags), but only when every
//   text part is plain or has a plain alternative, so no plain text made
//   from the HTML (which would keep what the HTML hides) is ever read.
// - Page 1 is the message's own text, dated by its Date header as
//   `headerDate` reads it (the written date, time and offset kept, never
//   converted); it is left out when it has no text and history follows. Every later page is history:
//   quoted replies and forwarded messages in the body (history.ts), then each
//   attached message (message/rfc822), read the same way up to `emailDepth`
//   levels, whose own attachments join this message's.
// - `originalSender` is the first forwarded message's own From address when
//   the email forwards one (a Gmail or Apple Mail forward marker, an attached
//   message, or an Outlook header block under a "Fw:"/"Fwd:" subject), else the
//   email's From address. A forward whose From line writes no address leaves
//   it unknown rather than falling back to the forwarder.
// - Message-ID, In-Reply-To and References are kept as written; `threadIds`
//   holds References then In-Reply-To, oldest first, each once.
// - Every attachment is listed with its bytes, decoded name (`safeName`: no
//   control or format character, so no bidi override can reorder what the
//   owner reads) and declared type; the type is never trusted (each is
//   sniffed as its own source). An
//   inline image under `inlineImageBytes` (a signature or logo) is marked not
//   to send.
// - Parsing limits: at most 64 nested MIME parts deep and 2,000 parts; HTML
//   nested deeper than `xmlDepth` is cut there, and a note says so.

import PostalMime, {
  type Address,
  type Attachment,
  type Email,
} from 'postal-mime';
import type { SourceText, TextPage } from '../model';
import { addressOf, headerDate, type Segment, splitHistory } from './history';
import { htmlLines } from './html';
import { textLines } from './plain';
import {
  type EmailAttachment,
  type EmailInfo,
  ExtractError,
  type ForwardedHeader,
  type Limits,
} from './types';
import { errorText } from './zip';

const FORWARD_SUBJECT = /^\s*(?:(?:re|aw)\s*:\s*)*(?:fwd?|fw)\s*:/i;

const EXTENSIONS: Readonly<Record<string, string>> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'text/calendar': '.ics',
  'text/csv': '.csv',
  'text/plain': '.txt',
  'message/rfc822': '.eml',
};

function mailbox(
  address: Address | undefined
): { name: string; address: string } | undefined {
  if (!address || address.address === undefined) return undefined;
  return { name: address.name, address: address.address };
}

/** "Name <address>", or the address alone. */
export function displayAddress(address: Address): string {
  if (address.address === undefined) {
    return `${address.name}: ${address.group.map(displayAddress).join(', ')};`;
  }
  return address.name
    ? `${address.name} <${address.address}>`
    : address.address;
}

/**
 * A file name as it can be shown: control and format characters (bidi
 * overrides and isolates, zero-width marks), line separators and slashes
 * become "_", and a name of only dots and spaces is no name.
 */
export function safeName(name: string): string {
  const cleaned = name
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}/\\]/gu, '_')
    .replace(/\s+/gu, ' ')
    .trim();
  if (/^[.\s]*$/u.test(cleaned)) return '';
  return [...cleaned].slice(0, 200).join('');
}

/** The message's own Date header, as `headerDate` reads it. */
function messageDate(email: Email): string | undefined {
  return headerDate(email.headers.find((h) => h.key === 'date')?.value);
}

function messageIds(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.match(/<[^<>\s]+>/g) ?? [];
}

function bytesOf(content: Attachment['content']): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

function attachmentOf(
  a: Attachment,
  index: number,
  limits: Limits
): EmailAttachment {
  const bytes = bytesOf(a.content);
  const type = a.mimeType.toLowerCase();
  const inline =
    a.disposition === 'inline' ||
    a.related === true ||
    (a.contentId !== undefined && a.disposition !== 'attachment');
  const name = a.filename
    ? safeName(a.filename)
    : `attachment ${index + 1}${EXTENSIONS[type] ?? ''}`;
  const smallInlineImage =
    type.startsWith('image/') &&
    inline &&
    bytes.length < limits.inlineImageBytes;
  return {
    name: name === '' ? `attachment ${index + 1}` : name,
    contentType: a.mimeType,
    bytes,
    inline,
    contentId: a.contentId,
    send: !smallInlineImage,
  };
}

/** Opening tags in an HTML text, counted up to `cap`. */
function countTags(html: string, cap: number): number {
  let n = 0;
  for (
    let i = html.indexOf('<');
    i !== -1 && n < cap;
    i = html.indexOf('<', i + 1)
  ) {
    const next = html.charCodeAt(i + 1);
    // A letter: an element opens here.
    if ((next >= 65 && next <= 90) || (next >= 97 && next <= 122)) n++;
  }
  return n;
}

interface Parsed {
  readonly email: Email;
  readonly segments: Segment[];
  /** HTML nested deeper than the limit was left out. */
  readonly cut: boolean;
}

/**
 * The message's plain text, only when every text part of it is plain or has
 * a plain alternative. Where a part has none, postal-mime fills the plain
 * text in from the HTML by stripping its tags, which keeps text the HTML
 * hides; such a message has no plain text to fall back on.
 */
function ownPlainText(parser: PostalMime, email: Email): string | undefined {
  if (email.text === undefined) return undefined;
  // postal-mime's map of each text node to its plain and HTML parts; not in
  // its published types, so it is checked here, and its absence reads as no
  // plain text.
  const entries: unknown = Reflect.get(parser, 'textMap');
  if (!(entries instanceof Map) || entries.size === 0) return undefined;
  for (const entry of entries.values()) {
    const plain: unknown =
      typeof entry === 'object' && entry !== null && 'plain' in entry
        ? entry.plain
        : undefined;
    if (!Array.isArray(plain) || plain.length === 0) return undefined;
  }
  return email.text;
}

async function parse(bytes: Uint8Array, limits: Limits): Promise<Parsed> {
  let email: Email;
  const parser = new PostalMime({
    forceRfc822Attachments: true,
    attachmentEncoding: 'arraybuffer',
    maxNestingDepth: 64,
    maxPartCount: 2000,
  });
  try {
    email = await parser.parse(bytes);
  } catch (error) {
    throw new ExtractError(
      'damaged',
      `The email cannot be read (${errorText(error)}).`
    );
  }
  let body: string[] = [];
  let cut = false;
  const html = email.html;
  const readable =
    html !== undefined &&
    html.length <= limits.htmlChars &&
    countTags(html, limits.xmlElements + 1) <= limits.xmlElements;
  if (readable) {
    const read = htmlLines(html, limits.xmlDepth, limits.htmlChars);
    body = read.lines;
    cut = read.cut;
  }
  // The plain part stands in for an HTML part that is too big to read or
  // shows no text (an image alone, a part left empty).
  const plain = ownPlainText(parser, email);
  if (body.length === 0 && plain !== undefined) {
    body = textLines(plain);
    cut = false;
  } else if (!readable && html !== undefined) {
    throw new ExtractError('too_large', 'The email body is too long to read.');
  }
  return { email, segments: splitHistory(body), cut };
}

interface MessagePages {
  readonly pages: Omit<TextPage, 'page'>[];
  readonly attachments: EmailAttachment[];
  readonly forwarded?: ForwardedHeader | undefined;
  /** Some message's HTML was nested deeper than the limit. */
  readonly cut: boolean;
}

/** A message's pages without numbers, and the attachments of it and the messages inside it. */
async function messagePages(
  bytes: Uint8Array,
  limits: Limits,
  depth: number
): Promise<MessagePages & { email: Email }> {
  const { email, segments, cut } = await parse(bytes, limits);
  let anyCut = cut;
  const date = messageDate(email);
  const [own, ...history] = segments;
  const pages: Omit<TextPage, 'page'>[] = [];
  if (own && own.lines.length > 0)
    pages.push({ kind: 'text', date, lines: own.lines });

  const forwardSubject = FORWARD_SUBJECT.test(email.subject ?? '');
  let forwarded: ForwardedHeader | undefined;
  for (const s of history) {
    pages.push({ kind: 'history', date: s.date, from: s.from, lines: s.lines });
    if (
      forwarded === undefined &&
      (s.forward || (s.headed && forwardSubject))
    ) {
      forwarded = { from: s.from, address: addressOf(s.from), date: s.date };
    }
  }

  const attachments: EmailAttachment[] = [];
  for (const [index, a] of email.attachments.entries()) {
    if (
      a.mimeType.toLowerCase() === 'message/rfc822' &&
      depth < limits.emailDepth
    ) {
      const inner = await messagePages(bytesOf(a.content), limits, depth + 1);
      const innerFrom = inner.email.from
        ? displayAddress(inner.email.from)
        : undefined;
      const innerDate = messageDate(inner.email);
      inner.pages.forEach((p, i) => {
        const top = i === 0 && p.kind === 'text';
        pages.push(
          top
            ? {
                kind: 'history',
                date: innerDate,
                from: innerFrom,
                lines: p.lines,
              }
            : { ...p, kind: 'history' }
        );
      });
      if (forwarded === undefined) {
        forwarded = {
          from: innerFrom,
          address: mailbox(inner.email.from)?.address.toLowerCase(),
          date: innerDate,
        };
      }
      attachments.push(...inner.attachments);
      anyCut ||= inner.cut;
      continue;
    }
    attachments.push(attachmentOf(a, index, limits));
  }
  return { email, pages, attachments, forwarded, cut: anyCut };
}

export interface EmailText {
  readonly text: SourceText;
  readonly email: EmailInfo;
  /** Facts for the Sources row's Note. */
  readonly notes: readonly string[];
}

/** Reads an email message into pages and its header facts. */
export async function emailText(
  bytes: Uint8Array,
  limits: Limits
): Promise<EmailText> {
  const { email, pages, attachments, forwarded, cut } = await messagePages(
    bytes,
    limits,
    0
  );
  const empty: Omit<TextPage, 'page'> = { kind: 'text', lines: [] };
  const numbered: TextPage[] = (pages.length > 0 ? pages : [empty]).map(
    (p, i) => ({
      ...p,
      page: i + 1,
    })
  );
  const from = mailbox(email.from);
  const references = messageIds(email.references);
  const inReplyTo = messageIds(email.inReplyTo)[0];
  const threadIds = [
    ...new Set([
      ...references,
      ...(inReplyTo !== undefined ? [inReplyTo] : []),
    ]),
  ];
  const originalSender = forwarded
    ? forwarded.address
    : from?.address.toLowerCase();
  return {
    text: {
      pages: numbered,
      paged: numbered.length > 1,
      pageTextOnly: bytes.length > limits.pageTextOnlyBytes,
      originalSender,
    },
    email: {
      subject: email.subject,
      from: from?.address.toLowerCase(),
      fromHeader: email.from ? displayAddress(email.from) : undefined,
      to: (email.to ?? []).map(displayAddress),
      cc: (email.cc ?? []).map(displayAddress),
      date: messageDate(email),
      messageId: email.messageId,
      inReplyTo,
      references,
      threadIds,
      forwarded,
      attachments,
    },
    notes: cut
      ? [
          `The email's HTML is nested more than ${limits.xmlDepth} levels deep; text below that was not read.`,
        ]
      : [],
  };
}
