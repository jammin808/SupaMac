// CSV text (docs/supamac/jobs.md §2): RFC 4180 records, each cell as
// "<column header>: <value>" with the row's first cell as its key (table.ts).
//
// Invariants:
// - Fields follow RFC 4180: a field that starts with a double quote runs to
//   its closing quote, with "" for a quote inside and line breaks kept; a
//   quote anywhere else is an ordinary character. A quoted field still open
//   at the end of the file is refused as damaged, never guessed closed.
// - The delimiter is the one of comma, semicolon and tab that occurs most in
//   the first record outside quotes (Excel writes semicolons in some
//   locales); comma when none occurs.
// - Every value is kept as written: CSV has no formats to apply.
// - More than `maxCells` non-empty cells are refused, never cut short.

import { cell, inferredTableLines, type TableRow } from './table';
import { ExtractError, type Limits } from './types';

const DELIMITERS = [',', ';', '\t'] as const;

/** The delimiter of a CSV text, from its first record. */
export function sniffDelimiter(text: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (let i = 0; i < text.length && i < 65_536; i++) {
    const ch = text[i] as string;
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && counts.has(ch))
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best = ',';
  let most = 0;
  for (const d of DELIMITERS) {
    const n = counts.get(d) ?? 0;
    if (n > most) {
      best = d;
      most = n;
    }
  }
  return best;
}

/** Parses CSV text into records of fields (RFC 4180). */
export function parseCsv(
  text: string,
  delimiter = sniffDelimiter(text)
): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let i = 0;
  const n = text.length;
  let atFieldStart = true;
  while (i < n) {
    const ch = text[i] as string;
    if (atFieldStart && ch === '"') {
      // A quoted field: up to the closing quote; "" is a quote.
      i++;
      let closed = false;
      while (i < n) {
        const q = text[i] as string;
        if (q === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        field += q;
        i++;
      }
      if (!closed) {
        throw new ExtractError(
          'damaged',
          'The CSV file has a quoted field that is never closed, so it is not read.'
        );
      }
      atFieldStart = false;
      continue;
    }
    if (ch === delimiter) {
      record.push(field);
      field = '';
      atFieldStart = true;
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      atFieldStart = true;
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    atFieldStart = false;
    i++;
  }
  if (!atFieldStart || field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((r) => r.some((f) => f.trim() !== ''));
}

/** The lines of a CSV text. */
export function csvLines(
  text: string,
  limits: Pick<Limits, 'maxCells'>
): string[] {
  const records = parseCsv(text);
  let cells = 0;
  const rows: TableRow[] = records.map((r) =>
    r.map((f) => {
      if (f.trim() === '') return undefined;
      cells++;
      if (cells > limits.maxCells) {
        throw new ExtractError(
          'too_many_cells',
          `The CSV file has more than ${limits.maxCells.toLocaleString('en-GB')} filled cells, so it is not read.`
        );
      }
      return cell(f, /^[-+]?[£€$]?\d[\d,.]*%?$/.test(f.trim()));
    })
  );
  return inferredTableLines(rows);
}
