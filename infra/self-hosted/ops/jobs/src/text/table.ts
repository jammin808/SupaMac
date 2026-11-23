// Tables as lines (docs/supamac/jobs.md §2): each cell its own line, written
// as "<column header>: <value>" when the table has a header row, with the
// row's first cell as the line's key.
//
// Invariants:
// - A line only puts side by side what the table itself puts together: a
//   cell's own text, the header of its column, and the first cell of its row.
//   Two cells' texts are never joined into one value.
// - A cell with several lines (paragraphs, line breaks) gives one line per
//   line of its text, each with the same prefix, so no two of its lines are
//   joined.
// - The header row is used only when the caller says the table has one:
//   structurally (a docx repeat-header row, HTML <th> cells) or by
//   `looksLikeHeader`, which accepts only a first row of short, distinct
//   text cells in a table of three or more columns. `inferredTableLines`
//   (spreadsheets, CSV) first sets aside up to three title rows of one cell
//   each, which become lines of their own.
// - The key is the first cell's text when it is one line of at most 80
//   characters; otherwise the row's lines have no key and the first cell's
//   lines stand alone. A header cell's lines are joined with spaces.
//
// Line forms:
// - with a header: first column "<header>: <value>"; other columns
//   "<key> · <header>: <value>" ("<header>: <value>" when the row has no key);
// - without one: other columns "<key>: <value>"; the first column alone only
//   when nothing else in its row has text.

import { splitLines } from '../normalize';

export interface TableCell {
  /** The cell's text lines, trimmed, without empty ones. */
  readonly lines: readonly string[];
  /** Whether the cell holds a number or date rather than text (header test). */
  readonly numeric?: boolean | undefined;
}

/** Cells by column index; a missing or empty cell has no lines. */
export type TableRow = readonly (TableCell | undefined)[];

const MAX_KEY = 80;
const MAX_HEADER = 40;

export function cellText(cell: TableCell | undefined): string {
  return cell ? cell.lines.join(' ').trim() : '';
}

function hasText(cell: TableCell | undefined): cell is TableCell {
  return cell !== undefined && cell.lines.some((l) => l.trim() !== '');
}

/** Builds a cell from raw text, splitting it into trimmed non-empty lines. */
export function cell(text: string, numeric = false): TableCell {
  const lines = splitLines(text)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '');
  return numeric ? { lines, numeric } : { lines };
}

/**
 * Whether the first row reads as a header: at least two cells with text, all
 * text (no numbers or dates), each short and distinct, in a table of three or
 * more columns with at least one row below.
 */
export function looksLikeHeader(rows: readonly TableRow[]): boolean {
  const [first, ...rest] = rows;
  if (!first || rest.length === 0) return false;
  const width = Math.max(...rows.map((r) => r.length));
  if (width < 3) return false;
  const texts: string[] = [];
  for (const c of first) {
    if (!hasText(c)) continue;
    if (c.numeric) return false;
    const t = cellText(c);
    if (t.length > MAX_HEADER) return false;
    texts.push(t.toLowerCase());
  }
  return texts.length >= 2 && new Set(texts).size === texts.length;
}

/** The lines of a table; `header` says whether its first row is a header row. */
export function tableLines(
  rows: readonly TableRow[],
  header: boolean
): string[] {
  const out: string[] = [];
  const headers = header && rows[0] ? rows[0].map((c) => cellText(c)) : [];
  const body = header ? rows.slice(1) : rows;
  for (const row of body) {
    const first = row[0];
    const keyText = first && first.lines.length === 1 ? cellText(first) : '';
    const key =
      keyText !== '' && keyText.length <= MAX_KEY ? keyText : undefined;
    const others = row.some((c, i) => i > 0 && hasText(c));
    row.forEach((c, column) => {
      if (!hasText(c)) return;
      const head = headers[column] ?? '';
      for (const line of c.lines) {
        if (header) {
          const label = head !== '' ? `${head}: ` : '';
          const prefix = column > 0 && key !== undefined ? `${key} · ` : '';
          out.push(`${prefix}${label}${line}`);
        } else if (column === 0) {
          if (!others || key === undefined) out.push(line);
        } else {
          out.push(key !== undefined ? `${key}: ${line}` : line);
        }
      }
    });
  }
  if (header && body.length === 0) {
    for (const h of headers) if (h !== '') out.push(h);
  }
  return out;
}

const MAX_TITLE_ROWS = 3;

function filled(row: TableRow): number {
  return row.filter(hasText).length;
}

/**
 * The lines of a table that says nothing about its header (a sheet, a CSV):
 * title rows of a single cell at the top stand alone, and the rest has a
 * header row when `looksLikeHeader` says so.
 */
export function inferredTableLines(rows: readonly TableRow[]): string[] {
  let titles = 0;
  while (titles < MAX_TITLE_ROWS && titles < rows.length - 1) {
    const row = rows[titles];
    if (!row || filled(row) !== 1) break;
    titles++;
  }
  const body = rows.slice(titles);
  const header = looksLikeHeader(body);
  if (titles === 0 || !header) return tableLines(rows, looksLikeHeader(rows));
  return [
    ...tableLines(rows.slice(0, titles), false),
    ...tableLines(body, true),
  ];
}
