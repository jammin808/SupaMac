// Extraction of one source's text (docs/supamac/jobs.md §2), dispatched on the
// type its bytes show.
//
// Invariants:
// - The type is sniffed from the bytes: PDF ("%PDF-" in the first 1,024
//   bytes of a file that does not open with a mail header line), zip
//   archives whose [Content_Types].xml names a Word or Excel main part
//   (docx, xlsx), JPEG, PNG and WebP by their signatures, and text (plain.ts)
//   that is a calendar (BEGIN:VCALENDAR), an email (an RFC 5322 header block
//   whose From holds an address, with one of Date, Subject, Message-ID,
//   MIME-Version or To), CSV, or plain text.
// - The name and content type never admit a type. They choose between CSV
//   and plain text for bytes already known to be text (an .eml name or a
//   message/rfc822 type also reads a header block as an email), and they
//   refuse text bytes they name as a text format that is not plain text: an
//   extension or a type of HTML, XML, SVG, JSON, a script, a stylesheet,
//   Markdown, YAML, RTF or a contact card. Text that is markup (it opens with
//   a tag), JSON or a contact card (BEGIN:VCARD) is refused whatever it is
//   called. Text bytes under a binary type's name (a .pdf that is text) are
//   read as the text they are.
// - Plain text is read as written, though the design's list does not name
//   it: it is how a forwarded message's text arrives, and it is the same text
//   the CSV and email readers take.
// - HEIC and HEIF photos are refused with a reason (the service cannot
//   convert them: the design asks for conversion, which needs an image
//   decoder this service does not have); GIF images, Word 97–2003 and Excel
//   97–2003 files, other Office files, other archives and every other type are
//   refused as unsupported, never parsed.
// - Over `maxBytes` is refused; over `pageTextOnlyBytes` a source is read
//   from its page text only, and the result says so.
// - `extract` never throws for a file's content: a refusal is a value, and
//   an unexpected error inside a parser is reported as damaged with its
//   message.

import type { SourceText } from '../model';
import { csvLines } from './csv';
import { docxLines } from './docx';
import { emailText } from './email';
import { inspectImage } from './image';
import { calendarLines, decodeText, isCalendar, textLines } from './plain';
import { pdfText } from './pdf';
import {
  type Extracted,
  type ExtractHint,
  ExtractError,
  type ExtractOutcome,
  type ImageType,
  LIMITS,
  type Limits,
  MEDIA_TYPES,
  type SourceType,
  sizeText,
} from './types';
import { xlsxPages } from './xlsx';
import { attr, elements, localName, parseXml } from './xml';
import { errorText, looksLikeZip, openZip, type ZipArchive } from './zip';

export type Sniffed =
  | { readonly kind: 'pdf' }
  | { readonly kind: 'zip' }
  | { readonly kind: 'image'; readonly type: ImageType }
  | { readonly kind: 'heic' }
  | { readonly kind: 'text' }
  | { readonly kind: 'unsupported'; readonly what: string };

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length));

const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
  'mif2',
]);

/** What the bytes are, from their magic numbers. */
export function sniff(bytes: Uint8Array): Sniffed {
  // PDF readers accept a header anywhere in the first 1,024 bytes; a file
  // that opens with a mail header line is a message that mentions one.
  const head = ascii(bytes, 0, Math.min(bytes.length, 1024));
  const pdfAt = head.indexOf('%PDF-');
  if (pdfAt === 0 || (pdfAt > 0 && !/^[!-9;-~]+:/.test(head))) {
    return { kind: 'pdf' };
  }
  if (looksLikeZip(bytes)) return { kind: 'zip' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { kind: 'image', type: 'jpeg' };
  if (ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n')
    return { kind: 'image', type: 'png' };
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')
    return { kind: 'unsupported', what: 'a GIF image' };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP')
    return { kind: 'image', type: 'webp' };
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (HEIF_BRANDS.has(brand)) return { kind: 'heic' };
    return {
      kind: 'unsupported',
      what: brand.startsWith('avi')
        ? 'an AVIF image'
        : 'a video or ISO media file',
    };
  }
  if (
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  ) {
    return {
      kind: 'unsupported',
      what: 'a Word or Excel 97–2003 file (.doc, .xls)',
    };
  }
  if (ascii(bytes, 0, 4) === '{\\rt')
    return { kind: 'unsupported', what: 'a rich text file (.rtf)' };
  if (ascii(bytes, 0, 2) === 'BM')
    return { kind: 'unsupported', what: 'a bitmap image' };
  if (ascii(bytes, 0, 4) === 'II*\0' || ascii(bytes, 0, 4) === 'MM\0*')
    return { kind: 'unsupported', what: 'a TIFF image' };
  if (bytes[0] === 0x1f && bytes[1] === 0x8b)
    return { kind: 'unsupported', what: 'a gzip archive' };
  if (
    ascii(bytes, 0, 6) === '7z\xbc\xaf\x27\x1c' ||
    ascii(bytes, 0, 4) === 'Rar!'
  ) {
    return { kind: 'unsupported', what: 'an archive' };
  }
  return { kind: 'text' };
}

const WORD_MAIN =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const EXCEL_MAIN =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';

/** Which Office document a zip archive is, from its [Content_Types].xml. */
export function officeType(
  zip: ZipArchive,
  limits: Limits
): 'docx' | 'xlsx' | undefined {
  const types = zip.readText('[Content_Types].xml');
  if (types === undefined) return undefined;
  const root = parseXml(types, limits.xmlDepth, limits.xmlElements);
  const declared = new Set<string>();
  for (const o of elements(root)) {
    if (localName(o.name) !== 'Override') continue;
    const type = attr(o, 'ContentType');
    if (type !== undefined) declared.add(type.toLowerCase());
  }
  if (declared.has(WORD_MAIN)) return 'docx';
  if (declared.has(EXCEL_MAIN)) return 'xlsx';
  return undefined;
}

const EMAIL_HEADERS = /^(date|subject|message-id|mime-version|to)\s*:/im;
/** A From header whose value (or its folded continuation) holds an address. */
const FROM_ADDRESS =
  /^from\s*:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*@[^\s@<>]+\.[^\s@<>]+/im;

/** Whether text opens with an RFC 5322 header block that reads as an email. */
export function looksLikeEmail(text: string): boolean {
  const head = text.slice(0, 65_536);
  const end = head.search(/\r?\n\r?\n/);
  const block = end === -1 ? head : head.slice(0, end);
  const lines = block.split(/\r?\n/);
  const first = lines[0] ?? '';
  if (!/^[!-9;-~]+:/.test(first)) return false;
  for (const line of lines) {
    if (line === '' || /^[ \t]/.test(line)) continue;
    if (!/^[!-9;-~]+:/.test(line)) return false;
  }
  return FROM_ADDRESS.test(block) && EMAIL_HEADERS.test(block);
}

/**
 * Extensions of text formats that are not plain text: markup, data, styles,
 * contact cards and scripts. A name with one is not read as text.
 */
const OTHER_TEXT_EXTENSIONS = new Set([
  'html',
  'htm',
  'xhtml',
  'shtml',
  'mht',
  'mhtml',
  'xml',
  'xsl',
  'xslt',
  'svg',
  'json',
  'jsonl',
  'geojson',
  'js',
  'mjs',
  'cjs',
  'ts',
  'css',
  'vcf',
  'vcard',
  'md',
  'markdown',
  'yaml',
  'yml',
  'toml',
  'rtf',
  'tex',
  'plist',
  'url',
  'webloc',
  'sh',
  'bat',
  'cmd',
  'ps1',
  'py',
  'rb',
  'php',
]);

/** Content types that name a text format the service does not read. */
const OTHER_TEXT_TYPES =
  /^(?:text\/(?:html|xml|vcard|x-vcard|directory|markdown|x-markdown|javascript|css|x-python|x-sh|rtf|richtext|enriched|xsl)|application\/(?:json|xml|xhtml\+xml|javascript|x-javascript|ecmascript|rtf|x-sh|yaml|x-yaml|[\w.-]+\+(?:xml|json))|image\/svg\+xml)\b/i;

/** What a text source's name or type says it is, when that is not text the service reads. */
function namedOtherFormat(hint: ExtractHint): string | undefined {
  const ext = /\.([a-z][a-z0-9]{0,7})$/i
    .exec(hint.name ?? '')?.[1]
    ?.toLowerCase();
  if (ext !== undefined && OTHER_TEXT_EXTENSIONS.has(ext))
    return `a .${ext} file`;
  const type = (hint.contentType ?? '').trim().toLowerCase();
  if (OTHER_TEXT_TYPES.test(type))
    return `a file of type ${type.split(';')[0]}`;
  return undefined;
}

/** What text bytes are, when they are a format the service does not read. */
function otherTextFormat(text: string): string | undefined {
  const head = text
    .replace(/^\uFEFF/, '')
    .trimStart()
    .slice(0, 4096);
  if (/^<[!?a-z/]/i.test(head)) return 'an HTML or XML file';
  if (/^BEGIN:VCARD\b/i.test(head)) return 'a contact card (.vcf)';
  if (/^[[{]/.test(head)) {
    const whole = text.trim();
    if (whole.length <= 4 * 1024 * 1024) {
      try {
        JSON.parse(whole);
        return 'a JSON file';
      } catch {
        return undefined;
      }
    }
    if (/[\]}]$/.test(whole)) return 'a JSON file';
  }
  return undefined;
}

function isCsvHint(hint: ExtractHint): boolean {
  const type = (hint.contentType ?? '').toLowerCase();
  return (
    /\.(csv|tsv)$/i.test(hint.name ?? '') ||
    type.startsWith('text/csv') ||
    type.includes('comma-separated') ||
    type.startsWith('text/tab-separated')
  );
}

function isEmailHint(hint: ExtractHint): boolean {
  return (
    /\.eml$/i.test(hint.name ?? '') ||
    (hint.contentType ?? '').toLowerCase().startsWith('message/rfc822')
  );
}

function onePage(lines: string[], pageTextOnly: boolean): SourceText {
  return {
    paged: false,
    pages: [{ page: 1, kind: 'text', lines }],
    pageTextOnly,
  };
}

function result(
  type: SourceType,
  text: SourceText,
  extra: Partial<Extracted> = {}
): Extracted {
  const notes = [...(extra.notes ?? [])];
  if (text.pageTextOnly)
    notes.unshift('Read from its page text only: over 600 pages or 25 MiB.');
  return { type, mediaType: MEDIA_TYPES[type], ...extra, text, notes };
}

function unsupported(what: string): ExtractError {
  return new ExtractError(
    'unsupported_type',
    `The file is ${what}, which is not read. PDF, Word (.docx), Excel (.xlsx), CSV, text, email, calendar (.ics) and JPEG, PNG or WebP images are.`
  );
}

async function extractOrThrow(
  bytes: Uint8Array,
  hint: ExtractHint,
  limits: Limits
): Promise<Extracted> {
  if (bytes.length === 0) throw new ExtractError('empty', 'The file is empty.');
  if (bytes.length > limits.maxBytes) {
    throw new ExtractError(
      'too_large',
      `The file is ${sizeText(bytes.length)}, over the ${sizeText(limits.maxBytes)} read.`
    );
  }
  const pageTextOnly = bytes.length > limits.pageTextOnlyBytes;
  const sniffed = sniff(bytes);
  switch (sniffed.kind) {
    case 'pdf': {
      const pdf = await pdfText(bytes, limits);
      const notes =
        pdf.unreadPages.length > 0
          ? [
              `PDF.js could not read ${pdf.unreadPages.map((p) => `p${p}`).join(', ')}; left to the model as scans.`,
            ]
          : [];
      return result(
        'pdf',
        { paged: true, pages: pdf.pages, pageTextOnly: pdf.pageTextOnly },
        { pageCount: pdf.pageCount, notes }
      );
    }
    case 'zip': {
      const zip = openZip(bytes, limits);
      const type = officeType(zip, limits);
      if (type === 'docx')
        return result('docx', onePage(docxLines(zip, limits), pageTextOnly));
      if (type === 'xlsx') {
        const pages = xlsxPages(zip, limits);
        return result('xlsx', { paged: pages.length > 1, pages, pageTextOnly });
      }
      throw unsupported(
        'a zip archive or an Office file other than Word (.docx) or Excel (.xlsx)'
      );
    }
    case 'image': {
      const image = inspectImage(bytes, sniffed.type, limits);
      return result(
        sniffed.type,
        { paged: false, pages: [{ page: 1, kind: 'scan', lines: [] }] },
        { image }
      );
    }
    case 'heic':
      throw new ExtractError(
        'heic',
        'The photo is HEIC, which the service cannot convert. Send it as JPEG instead (on an iPhone: Settings, Camera, Formats, Most Compatible) or as a screenshot.'
      );
    case 'unsupported':
      throw unsupported(sniffed.what);
    case 'text': {
      const head = new TextDecoder('latin1').decode(bytes.subarray(0, 65_536));
      const isEmail =
        looksLikeEmail(head) || (isEmailHint(hint) && /^[!-9;-~]+:/.test(head));
      if (isEmail) {
        const { text, email, notes } = await emailText(bytes, limits);
        return result('eml', text, { email, notes });
      }
      const decoded = decodeText(bytes);
      if (!decoded) throw unsupported('binary data of an unknown kind');
      const other = otherTextFormat(decoded.text) ?? namedOtherFormat(hint);
      if (other !== undefined) throw unsupported(other);
      if (isCalendar(decoded.text))
        return result(
          'ics',
          onePage(calendarLines(decoded.text), pageTextOnly)
        );
      if (isCsvHint(hint))
        return result(
          'csv',
          onePage(csvLines(decoded.text, limits), pageTextOnly)
        );
      return result('txt', onePage(textLines(decoded.text), pageTextOnly));
    }
  }
}

/** Extracts a source's text, or says why it is refused. Never throws for content. */
export async function extract(
  bytes: Uint8Array,
  hint: ExtractHint = {},
  limits: Limits = LIMITS
): Promise<ExtractOutcome> {
  try {
    return { ok: true, value: await extractOrThrow(bytes, hint, limits) };
  } catch (error) {
    if (error instanceof ExtractError)
      return { ok: false, refusal: error.refusal };
    return {
      ok: false,
      refusal: {
        kind: 'damaged',
        reason: `The file could not be read (${errorText(error)}).`,
      },
    };
  }
}
