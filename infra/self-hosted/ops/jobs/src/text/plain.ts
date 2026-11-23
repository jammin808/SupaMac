// Plain-text sources: decoding, text files and calendar files
// (docs/supamac/jobs.md §2: "Calendar file (.ics): as text").
//
// Invariants:
// - Bytes are text only when they decode without NUL bytes and with few
//   other control characters: UTF-8 (with or without a byte order mark),
//   UTF-16 with a byte order mark, or, failing UTF-8, Windows-1252 (what
//   Excel writes CSV in). Anything else is binary and never read as text.
// - A text file's lines are its lines as written.
// - A calendar file's folded lines (RFC 5545 §3.1) are unfolded, which
//   restores the content line the file holds, and its TEXT escapes are
//   decoded, so an escaped "\n" in a description starts a line of its own.
//   Base64 attachments inside it are dropped.

import { splitLines } from '../normalize';

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export interface DecodedText {
  readonly text: string;
  readonly encoding: TextEncoding;
}

function controlShare(text: string): number {
  let control = 0;
  const sample = text.length > 65_536 ? text.slice(0, 65_536) : text;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) return 1;
    if (
      (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c) ||
      c === 0x7f
    )
      control++;
  }
  return sample.length === 0 ? 0 : control / sample.length;
}

/** Decodes bytes as text, or returns undefined when they are not text. */
export function decodeText(bytes: Uint8Array): DecodedText | undefined {
  let decoded: DecodedText | undefined;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    decoded = {
      text: new TextDecoder('utf-16le').decode(bytes.subarray(2)),
      encoding: 'utf-16le',
    };
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    decoded = {
      text: new TextDecoder('utf-16be').decode(bytes.subarray(2)),
      encoding: 'utf-16be',
    };
  } else {
    const body =
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
        ? bytes.subarray(3)
        : bytes;
    try {
      decoded = {
        text: new TextDecoder('utf-8', { fatal: true }).decode(body),
        encoding: 'utf-8',
      };
    } catch {
      decoded = {
        text: new TextDecoder('windows-1252').decode(body),
        encoding: 'windows-1252',
      };
    }
  }
  return controlShare(decoded.text) > 0.01 ? undefined : decoded;
}

/** The non-empty lines of a text, trimmed of trailing whitespace. */
export function textLines(text: string): string[] {
  return splitLines(text)
    .map((l) => l.replace(/\s+$/u, ''))
    .filter((l) => l.trim() !== '');
}

/** Whether a text is an iCalendar file. */
export function isCalendar(text: string): boolean {
  return /^\s*BEGIN:VCALENDAR\b/i.test(text.slice(0, 1024));
}

function unescapeIcs(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_all, ch: string) =>
    ch === 'n' || ch === 'N' ? '\n' : ch
  );
}

/** A calendar file's lines: unfolded, TEXT escapes decoded, binary attachments dropped. */
export function calendarLines(text: string): string[] {
  const raw = text.split(/\r\n|\n|\r/);
  const unfolded: string[] = [];
  for (const line of raw) {
    if (
      (line.startsWith(' ') || line.startsWith('\t')) &&
      unfolded.length > 0
    ) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }
  const out: string[] = [];
  for (const line of unfolded) {
    if (/^ATTACH[;:]/i.test(line) && /ENCODING=BASE64/i.test(line)) continue;
    out.push(...unescapeIcs(line).split('\n'));
  }
  return out.map((l) => l.replace(/\s+$/u, '')).filter((l) => l.trim() !== '');
}
