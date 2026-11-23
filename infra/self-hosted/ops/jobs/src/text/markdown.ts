// The Markdown documents the service stores beside its sources
// (docs/supamac/jobs.md §2): the "<file> · text" document of a PDF, Word or
// Excel source, and the email document.
//
// Invariants:
// - No text from a source becomes markup, and every line reads back as
//   exactly its text. In the text document every line is a paragraph of its
//   own whose Markdown punctuation is backslash-escaped, whose <, > and & are
//   decimal character references (&#60;, &#62;, &#38;: SupaMac's Markdown
//   import decodes these and backslash escapes, and leaves named entities
//   such as &amp; as written), and whose first character cannot open a block
//   (heading, list, quote, rule, table, indented code). In the email
//   document each page's body is a fenced code block whose fence is longer
//   than any run of backticks inside it, so nothing in it can close it.
// - Headers, names and dates outside the fences are escaped as text lines.
//   A date is shown as written: a date, or a date and time with the offset
//   it was written in ("2026-04-03 00:30 +01:00", "… UTC"), never converted.
// - A bare address (https://…, www.…) stays text in CommonMark; a renderer
//   that links bare addresses may still link it, with its text unchanged.
// - Pages are headed "[p<n>]" as the extraction numbers them; a history page
//   adds its own date and sender, a scan page says its text was not read.

import type { SourceText, TextPage } from '../model';
import { splitLines } from '../normalize';
import type { EmailInfo } from './types';

/** Characters CommonMark (and GFM tables, strikethrough, math) treat as markup. */
const INLINE = /[\\`*_[\]{}|~$#!]/g;

/** One line of source text as Markdown that renders as exactly that text. */
export function escapeLine(text: string): string {
  const line = text.replace(/[\t\r\n\f\v]+/g, ' ').trim();
  // Punctuation first, so the "#" of a character reference is not escaped.
  const escaped = line
    .replace(INLINE, (ch) => `\\${ch}`)
    .replace(/&/g, '&#38;')
    .replace(/</g, '&#60;')
    .replace(/>/g, '&#62;');

  // A line that starts like a block (a list marker, an ordered-list number, a
  // setext underline or a thematic break) has that first mark escaped.
  return escaped
    .replace(/^([-+=])/, '\\$1')
    .replace(/^(\d{1,9})([.)])/, '$1\\$2');
}

/** A fence of backticks longer than any backtick run in `text`, and at least three. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g))
    longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function whenText(date: string | undefined): string | undefined {
  if (date === undefined) return undefined;
  const m =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      date
    );
  if (!m) return date;
  return `${m[1]} ${m[2]} ${m[3] === 'Z' ? 'UTC' : m[3]}`;
}

function pageHeading(page: TextPage): string {
  const parts = [`\\[p${page.page}\\]`];
  if (page.kind === 'history') {
    parts.push('quoted or forwarded message');
    const when = whenText(page.date);
    if (when !== undefined) parts.push(escapeLine(when));
    if (page.from !== undefined) parts.push(`from ${escapeLine(page.from)}`);
  }
  if (page.kind === 'scan') parts.push('scan');
  return `## ${parts.join(' · ')}`;
}

const SCAN_NOTE =
  'This page is an image or a scan: its text was not read, and the model reads it from the page image.';

/** The "<file> · text" document. */
export function textDocument(fileName: string, text: SourceText): string {
  const out: string[] = [`# ${escapeLine(`${fileName} · text`)}`, ''];
  if (text.pageTextOnly) {
    out.push(
      '_Only the page text of this file was read: it is over 600 pages or 25 MiB._',
      ''
    );
  }
  for (const page of text.pages) {
    out.push(pageHeading(page), '');
    if (page.kind === 'scan') out.push(`_${SCAN_NOTE}_`, '');
    for (const line of page.lines) {
      for (const part of splitLines(line)) {
        const escaped = escapeLine(part);
        if (escaped !== '') out.push(escaped, '');
      }
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

function listItem(label: string, value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  return [`- ${label}: ${escapeLine(value)}`];
}

/** The email document: its headers as a list, each page's body fenced. */
export function emailDocument(email: EmailInfo, text: SourceText): string {
  const out: string[] = [
    `# ${escapeLine(email.subject?.trim() || '(no subject)')}`,
    '',
  ];
  out.push(
    ...listItem('From', email.fromHeader ?? email.from),
    ...listItem('To', email.to.join(', ')),
    ...listItem('Cc', email.cc.join(', ')),
    ...listItem('Date', whenText(email.date)),
    ...listItem('Subject', email.subject),
    ...listItem('Message-ID', email.messageId),
    ...listItem('In-Reply-To', email.inReplyTo),
    ...listItem('References', email.references.join(' ')),
    ...listItem(
      'Attachments',
      email.attachments
        .map((a) => `${a.name} (${a.contentType}, ${a.bytes.length} bytes)`)
        .join('; ')
    ),
    ''
  );
  for (const page of text.pages) {
    out.push(pageHeading(page), '');
    const body = page.lines.flatMap((l) => splitLines(l)).join('\n');
    const fence = fenceFor(body);
    out.push(`${fence}text`, body, fence, '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}
