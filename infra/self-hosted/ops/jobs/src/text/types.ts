// What text extraction returns and what it refuses (docs/supamac/jobs.md §2).
//
// Invariants:
// - A source's type is what its bytes are (sniffed from magic numbers and
//   structure), never what its name or the sender's content type says. The
//   name and content type only choose between renderings of bytes already
//   known to be plain text (CSV or text, an email).
// - Only the types in SOURCE_TYPES are read. Anything else is refused before
//   any parser sees it, with a reason the owner can read.
// - Every refusal is a value with a `kind` and an owner-facing `reason`;
//   nothing in this unit fails silently or returns partial text as whole.
// - Limits are counted on what is actually read (bytes inflated, pages,
//   cells), not on sizes a file declares about itself.
//
// Choices where the design is silent, each the more cautious one:
// - A file over 64 MiB is refused outright (the design's 25 MiB rule reads
//   larger files as page text only; something must bound the child process).
// - A PDF over 2,000 pages is refused; from 601 to 2,000 pages it is read as
//   page text only.
// - A spreadsheet or CSV with more than 100,000 non-empty cells is refused
//   rather than cut short.
// - The Claude image limit of 5 MB is applied to the image's base64 form, so
//   a photo of about 3.75 MiB or more is refused with a reason.
// - An XML part (docx, xlsx) with more than 300,000 elements is refused, and
//   an email's HTML body with more than 300,000 tags is read from its plain
//   part (or refused without one), before parsing. Measured, a parsed element
//   costs 500 to 700 bytes of the child's memory: a Word file at the cap
//   peaks between 288 and 320 MiB in the child, under its 384 MiB limit, so
//   a file of millions of tiny elements is refused (Skipped) instead of
//   killing the child (Failed, which a Retry cannot help). A 100,000-cell
//   sheet is about 210,000 elements.
// - A deterministic refusal (wrong type, over a limit, damaged) is Skipped:
//   trying again cannot change it. Only a sandbox failure (time, memory, a
//   crash) is Failed, so the owner's Retry button can help.

import type { SourceStatus, SourceText } from '../model';

export const SOURCE_TYPES = [
  'pdf',
  'docx',
  'xlsx',
  'csv',
  'txt',
  'eml',
  'jpeg',
  'png',
  'webp',
  'ics',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export type ImageType = 'jpeg' | 'png' | 'webp';
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export const MEDIA_TYPES: Readonly<Record<SourceType, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  eml: 'message/rfc822',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  ics: 'text/calendar',
};

export const MIB = 1024 * 1024;

export interface Limits {
  /** Refused above this many bytes. */
  readonly maxBytes: number;
  /** Above this many bytes only the page text is read (design §2). */
  readonly pageTextOnlyBytes: number;
  /** A PDF with more pages is read from its page text only (design §2). */
  readonly pageTextOnlyPages: number;
  /** A PDF with more pages is refused. */
  readonly maxPdfPages: number;
  /** A zip-based file with more entries is refused (design §2). */
  readonly zipEntries: number;
  /** A zip-based file is refused once this many bytes are inflated (design §2). */
  readonly zipUnpackedBytes: number;
  /** A spreadsheet or CSV with more non-empty cells is refused. */
  readonly maxCells: number;
  /** XML nested deeper than this is refused. */
  readonly xmlDepth: number;
  /**
   * An XML part with more elements is refused, and an HTML body with more
   * tags is not converted, before either is parsed: a parsed element costs
   * hundreds of bytes, so a small part of tiny elements would otherwise
   * exhaust the child's memory.
   */
  readonly xmlElements: number;
  /** Claude's limit on either side of an image, in pixels. */
  readonly imageSide: number;
  /** Claude's limit on one image, counted on its base64 form. */
  readonly imageBase64Bytes: number;
  /** Inline email images under this size are not sent to the model (design §2). */
  readonly inlineImageBytes: number;
  /** A PDF page with fewer visible non-space characters is a scan. */
  readonly scanMinChars: number;
  /** Messages attached inside messages are read this many levels deep. */
  readonly emailDepth: number;
  /** An HTML body longer than this many characters is not converted. */
  readonly htmlChars: number;
}

export const LIMITS: Limits = {
  maxBytes: 64 * MIB,
  pageTextOnlyBytes: 25 * MIB,
  pageTextOnlyPages: 600,
  maxPdfPages: 2000,
  zipEntries: 500,
  zipUnpackedBytes: 50_000_000,
  maxCells: 100_000,
  xmlDepth: 256,
  xmlElements: 300_000,
  imageSide: 8000,
  imageBase64Bytes: 5 * MIB,
  inlineImageBytes: 20 * 1024,
  scanMinChars: 32,
  emailDepth: 3,
  htmlChars: 16_000_000,
};

export const REFUSAL_KINDS = [
  /** Not on the allow-list. */
  'unsupported_type',
  /** A HEIC or HEIF photo, which the service cannot convert. */
  'heic',
  'empty',
  'too_large',
  'too_many_pages',
  'zip_entries',
  'zip_unpacked',
  'too_many_cells',
  /** An image wider or taller than the model accepts. */
  'image_dimensions',
  /** An image heavier than the model accepts. */
  'image_bytes',
  /** Password-protected or encrypted. */
  'encrypted',
  /** The bytes do not hold a readable file of their type. */
  'damaged',
  /** XML with a DOCTYPE, entity declarations or absurd nesting. */
  'hostile_xml',
  /** The extraction child ran out of time. */
  'timeout',
  /** The extraction child went over its memory limit. */
  'memory',
  /** The extraction child exited without a result. */
  'crashed',
  /** The extraction child answered with something that is not a result. */
  'bad_output',
] as const;
export type RefusalKind = (typeof REFUSAL_KINDS)[number];

export interface Refusal {
  readonly kind: RefusalKind;
  /** One sentence for the owner and the Sources row's Note. */
  readonly reason: string;
}

/** The Sources row status a refusal of each kind gives the source. */
export const REFUSAL_STATUS: Readonly<
  Record<RefusalKind, Extract<SourceStatus, 'Skipped' | 'Failed'>>
> = {
  unsupported_type: 'Skipped',
  heic: 'Skipped',
  empty: 'Skipped',
  too_large: 'Skipped',
  too_many_pages: 'Skipped',
  zip_entries: 'Skipped',
  zip_unpacked: 'Skipped',
  too_many_cells: 'Skipped',
  image_dimensions: 'Skipped',
  image_bytes: 'Skipped',
  encrypted: 'Skipped',
  damaged: 'Skipped',
  hostile_xml: 'Skipped',
  timeout: 'Failed',
  memory: 'Failed',
  crashed: 'Failed',
  bad_output: 'Failed',
};

/** A refusal raised inside extraction; `extract` turns it into a value. */
export class ExtractError extends Error {
  readonly kind: RefusalKind;
  constructor(kind: RefusalKind, reason: string) {
    super(reason);
    this.name = 'ExtractError';
    this.kind = kind;
  }

  get refusal(): Refusal {
    return { kind: this.kind, reason: this.message };
  }
}

export interface ImageInfo {
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export interface EmailAttachment {
  /** The decoded file name, or one made from the part's number and type. */
  readonly name: string;
  /** The part's Content-Type as sent; never trusted for the type. */
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /** Shown inside the message (inline disposition or referenced by Content-ID). */
  readonly inline: boolean;
  readonly contentId?: string | undefined;
  /**
   * False for an inline image under 20 KB (a signature or logo): it stays
   * with the email and is never sent to the model (design §2).
   */
  readonly send: boolean;
}

/** A forwarded message's own header, as the forward writes it. */
export interface ForwardedHeader {
  /** The From line's value as written ("Jo Bloggs <jo@example.com>"). */
  readonly from?: string | undefined;
  /** The address inside it, when it writes one. */
  readonly address?: string | undefined;
  /**
   * Its own date as `writtenDate` reads it: an ISO instant that keeps the
   * written date, time and offset when the header writes a numeric zone (or
   * GMT, UTC), else an ISO date; absent when it could read two ways or has
   * no year.
   */
  readonly date?: string | undefined;
}

export interface EmailInfo {
  readonly subject?: string | undefined;
  /** The From address. */
  readonly from?: string | undefined;
  /** The From header as a display string ("Name <address>"). */
  readonly fromHeader?: string | undefined;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  /**
   * The Date header as `headerDate` reads it: an ISO instant that keeps the
   * written date, time and offset ("2026-04-03T00:30:00+01:00", "…Z" for
   * UTC), an ISO date when it has no zone, absent when it does not parse.
   */
  readonly date?: string | undefined;
  readonly messageId?: string | undefined;
  readonly inReplyTo?: string | undefined;
  readonly references: readonly string[];
  /** References then In-Reply-To, oldest first, each once: SourceRecord.threadIds. */
  readonly threadIds: readonly string[];
  /** The first forwarded message, when the email forwards one. */
  readonly forwarded?: ForwardedHeader | undefined;
  readonly attachments: readonly EmailAttachment[];
}

export interface Extracted {
  readonly type: SourceType;
  readonly mediaType: string;
  readonly text: SourceText;
  readonly image?: ImageInfo | undefined;
  readonly email?: EmailInfo | undefined;
  /** A PDF's page count. */
  readonly pageCount?: number | undefined;
  /** Facts for the Sources row's Note ("812 pages: read from page text only"). */
  readonly notes: readonly string[];
}

export type ExtractOutcome =
  | { readonly ok: true; readonly value: Extracted }
  | { readonly ok: false; readonly refusal: Refusal };

/** What the sender says the file is; used only between text renderings. */
export interface ExtractHint {
  readonly name?: string | undefined;
  readonly contentType?: string | undefined;
}

export function sizeText(bytes: number): string {
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}
