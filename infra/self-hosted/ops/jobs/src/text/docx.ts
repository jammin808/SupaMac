// Word (.docx) text (docs/supamac/jobs.md §2): paragraphs in order, tables
// cell by cell; hidden text and deleted tracked changes dropped.
//
// Invariants:
// - Only text Word shows is kept: runs hidden with w:vanish (directly, by
//   their character style, by their paragraph's style, or by the default
//   paragraph style for a paragraph that names none or names a style the
//   document does not define, or by the document defaults) are dropped, and so
//   are deleted and moved-away tracked changes (w:del, w:moveFrom), field
//   instructions (w:instrText) and the fallback copy of alternate content.
//   Inserted tracked changes (w:ins, w:moveTo) are kept, as Word shows them.
// - A paragraph is a line; a line break inside it (w:br, w:cr) starts a new
//   line. Text boxes inside a paragraph are lines of their own after it.
// - Tables follow table.ts. A table has a header row only when its first row
//   is marked as one (w:tblHeader, "repeat as header row"); a vertically
//   merged cell's text is the row key of every row it spans.
// - Page headers come before the body and footers, footnotes and endnotes
//   after it; a header or footer line already given is not repeated.
// - Comments are not document text and are not read.

import { type TableCell, type TableRow, tableLines } from './table';
import { ExtractError, type Limits } from './types';
import { attr, child, elements, localName, parseXml, type XNode } from './xml';
import type { ZipArchive } from './zip';

interface StyleInfo {
  readonly vanish?: boolean | undefined;
  readonly basedOn?: string | undefined;
}

interface Context {
  readonly styles: ReadonlyMap<string, StyleInfo>;
  /** The default paragraph style's id (w:type="paragraph" w:default="1"). */
  readonly defaultParagraph?: string | undefined;
  readonly defaultHidden: boolean;
}

function onOff(node: XNode | undefined): boolean | undefined {
  if (!node) return undefined;
  const val = attr(node, 'w:val');
  if (val === undefined) return true;
  return !['0', 'false', 'off', 'none'].includes(val.toLowerCase());
}

function rPrVanish(rPr: XNode | undefined): boolean | undefined {
  if (!rPr) return undefined;
  return onOff(child(rPr, 'w:vanish'));
}

function styleHidden(
  ctx: Context,
  id: string | undefined
): boolean | undefined {
  let current = id;
  for (let i = 0; current !== undefined && i < 20; i++) {
    const style = ctx.styles.get(current);
    if (!style) return undefined;
    if (style.vanish !== undefined) return style.vanish;
    current = style.basedOn;
  }
  return undefined;
}

function readStyles(zip: ZipArchive, limits: Limits): Context {
  const styles = new Map<string, StyleInfo>();
  let defaultHidden = false;
  let defaultParagraph: string | undefined;
  const text = zip.readText('word/styles.xml');
  if (text === undefined) return { styles, defaultHidden };
  const root = parseXml(text, limits.xmlDepth, limits.xmlElements);
  const defaults = child(root, 'w:docDefaults');
  const rPrDefault = defaults ? child(defaults, 'w:rPrDefault') : undefined;
  if (rPrDefault)
    defaultHidden = rPrVanish(child(rPrDefault, 'w:rPr')) ?? false;
  for (const style of elements(root)) {
    if (style.name !== 'w:style') continue;
    const id = attr(style, 'w:styleId');
    if (id === undefined) continue;
    const basedOn = child(style, 'w:basedOn');
    styles.set(id, {
      vanish: rPrVanish(child(style, 'w:rPr')),
      basedOn: basedOn ? attr(basedOn, 'w:val') : undefined,
    });
    if (
      defaultParagraph === undefined &&
      attr(style, 'w:type') === 'paragraph' &&
      ['1', 'true', 'on'].includes(
        (attr(style, 'w:default') ?? '').toLowerCase()
      )
    ) {
      defaultParagraph = id;
    }
  }
  return { styles, defaultParagraph, defaultHidden };
}

/** Relationship targets of a part, resolved against the part's folder. */
function relationships(
  zip: ZipArchive,
  part: string,
  limits: Limits
): { type: string; target: string }[] {
  const slash = part.lastIndexOf('/');
  const folder = slash === -1 ? '' : part.slice(0, slash + 1);
  const relsPath = `${folder}_rels/${part.slice(slash + 1)}.rels`;
  const text = zip.readText(relsPath);
  if (text === undefined) return [];
  const root = parseXml(text, limits.xmlDepth, limits.xmlElements);
  const out: { type: string; target: string }[] = [];
  for (const rel of elements(root)) {
    if (localName(rel.name) !== 'Relationship') continue;
    if (attr(rel, 'TargetMode') === 'External') continue;
    const type = attr(rel, 'Type');
    const target = attr(rel, 'Target');
    if (type === undefined || target === undefined) continue;
    out.push({ type, target: resolvePart(folder, target) });
  }
  return out;
}

export function resolvePart(folder: string, target: string): string {
  const parts = (
    target.startsWith('/') ? target.slice(1) : folder + target
  ).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

/** The main document part's path, from the package relationships. */
export function mainPart(zip: ZipArchive, limits: Limits): string | undefined {
  return relationships(zip, '', limits).find((r) =>
    r.type.endsWith('/officeDocument')
  )?.target;
}

/** Collects the visible text of runs into lines, with text boxes kept apart. */
class LineBuilder {
  readonly lines: string[] = [];
  readonly boxes: string[] = [];
  #current = '';

  add(text: string): void {
    this.#current += text;
  }

  breakLine(): void {
    this.lines.push(this.#current);
    this.#current = '';
  }

  finish(): string[] {
    this.breakLine();
    return [...this.lines, ...this.boxes]
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter((l) => l !== '');
  }
}

function paragraphStyleHidden(ctx: Context, p: XNode): boolean | undefined {
  const pPr = child(p, 'w:pPr');
  const pStyle = pPr ? child(pPr, 'w:pStyle') : undefined;
  const named = pStyle ? attr(pStyle, 'w:val') : undefined;
  // Word gives a paragraph with no style, or an unknown one, the default
  // paragraph style.
  const id =
    named !== undefined && ctx.styles.has(named) ? named : ctx.defaultParagraph;
  return styleHidden(ctx, id);
}

function runHidden(
  ctx: Context,
  run: XNode,
  paragraphHidden: boolean | undefined
): boolean {
  const rPr = child(run, 'w:rPr');
  const direct = rPrVanish(rPr);
  if (direct !== undefined) return direct;
  const rStyle = rPr ? child(rPr, 'w:rStyle') : undefined;
  const byStyle = styleHidden(ctx, rStyle ? attr(rStyle, 'w:val') : undefined);
  if (byStyle !== undefined) return byStyle;
  return paragraphHidden ?? ctx.defaultHidden;
}

function walkRun(
  ctx: Context,
  run: XNode,
  out: LineBuilder,
  paragraphHidden: boolean | undefined
): void {
  const hidden = runHidden(ctx, run, paragraphHidden);
  for (const node of elements(run)) {
    switch (node.name) {
      case 'w:t':
        if (!hidden)
          out.add(node.children.filter((c) => typeof c === 'string').join(''));
        break;
      case 'w:tab':
      case 'w:ptab':
        if (!hidden) out.add(' ');
        break;
      case 'w:br':
      case 'w:cr':
        if (!hidden) out.breakLine();
        break;
      case 'w:noBreakHyphen':
        if (!hidden) out.add('-');
        break;
      case 'w:drawing':
      case 'w:pict':
      case 'w:object':
        for (const box of textBoxes(node))
          out.boxes.push(...blockLines(ctx, box));
        break;
      case 'mc:AlternateContent':
        walkAlternate(node, (choice) => {
          for (const n of elements(choice)) {
            if (n.name === 'w:drawing' || n.name === 'w:pict') {
              for (const box of textBoxes(n))
                out.boxes.push(...blockLines(ctx, box));
            }
          }
        });
        break;
      default:
        // w:delText, w:instrText, w:softHyphen, w:sym, w:fldChar, w:rPr and
        // the rest carry no shown text.
        break;
    }
  }
}

/** Calls `visit` with the first mc:Choice, or the fallback when there is none. */
function walkAlternate(node: XNode, visit: (n: XNode) => void): void {
  const choice = elements(node).find((c) => c.name === 'mc:Choice');
  const fallback = elements(node).find((c) => c.name === 'mc:Fallback');
  const pick = choice ?? fallback;
  if (pick) visit(pick);
}

/** The w:txbxContent elements under a drawing or picture, not inside one another. */
function textBoxes(node: XNode): XNode[] {
  const found: XNode[] = [];
  const stack: XNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop() as XNode;
    if (n.name === 'w:txbxContent') {
      found.push(n);
      continue;
    }
    if (n.name === 'mc:AlternateContent') {
      walkAlternate(n, (choice) => stack.push(choice));
      continue;
    }
    for (const c of elements(n).reverse()) stack.push(c);
  }
  return found;
}

function walkInline(
  ctx: Context,
  node: XNode,
  out: LineBuilder,
  paragraphHidden: boolean | undefined
): void {
  for (const c of elements(node)) {
    switch (c.name) {
      case 'w:r':
        walkRun(ctx, c, out, paragraphHidden);
        break;
      case 'w:del':
      case 'w:moveFrom':
      case 'w:pPr':
        break;
      case 'mc:AlternateContent':
        walkAlternate(c, (choice) =>
          walkInline(ctx, choice, out, paragraphHidden)
        );
        break;
      case 'w:sdt': {
        const content = child(c, 'w:sdtContent');
        if (content) walkInline(ctx, content, out, paragraphHidden);
        break;
      }
      default:
        // w:hyperlink, w:ins, w:moveTo, w:smartTag, w:customXml, w:fldSimple,
        // w:bdo, w:dir and similar wrappers hold runs.
        if (c.name.startsWith('w:')) walkInline(ctx, c, out, paragraphHidden);
        break;
    }
  }
}

function paragraphLines(ctx: Context, p: XNode): string[] {
  const out = new LineBuilder();
  walkInline(ctx, p, out, paragraphStyleHidden(ctx, p));
  return out.finish();
}

function vMerge(tc: XNode): 'restart' | 'continue' | undefined {
  const tcPr = child(tc, 'w:tcPr');
  const merge = tcPr ? child(tcPr, 'w:vMerge') : undefined;
  if (!merge) return undefined;
  return attr(merge, 'w:val') === 'restart' ? 'restart' : 'continue';
}

function gridSpan(tc: XNode): number {
  const tcPr = child(tc, 'w:tcPr');
  const span = tcPr ? child(tcPr, 'w:gridSpan') : undefined;
  const n = span ? Number.parseInt(attr(span, 'w:val') ?? '1', 10) : 1;
  return Number.isInteger(n) && n > 0 && n <= 64 ? n : 1;
}

/** Rows and cells of a table, looking through content controls and custom XML. */
function rowsOf(node: XNode): XNode[] {
  const rows: XNode[] = [];
  for (const c of elements(node)) {
    if (c.name === 'w:tr') rows.push(c);
    else if (c.name === 'w:sdt') {
      const content = child(c, 'w:sdtContent');
      if (content) rows.push(...rowsOf(content));
    } else if (c.name === 'w:customXml' || c.name === 'w:ins')
      rows.push(...rowsOf(c));
  }
  return rows;
}

function cellsOf(row: XNode): XNode[] {
  const cells: XNode[] = [];
  for (const c of elements(row)) {
    if (c.name === 'w:tc') cells.push(c);
    else if (c.name === 'w:sdt') {
      const content = child(c, 'w:sdtContent');
      if (content) cells.push(...cellsOf(content));
    } else if (c.name === 'w:customXml') cells.push(...cellsOf(c));
  }
  return cells;
}

function isHeaderRow(row: XNode): boolean {
  const trPr = child(row, 'w:trPr');
  return onOff(trPr ? child(trPr, 'w:tblHeader') : undefined) === true;
}

function tableLinesOf(ctx: Context, table: XNode): string[] {
  const rows: TableRow[] = [];
  const above = new Map<number, TableCell>();
  const xmlRows = rowsOf(table);
  for (const tr of xmlRows) {
    const row: (TableCell | undefined)[] = [];
    let column = 0;
    for (const tc of cellsOf(tr)) {
      const merge = vMerge(tc);
      let content: TableCell = { lines: blockLines(ctx, tc) };
      if (merge === 'continue' && content.lines.length === 0) {
        content = above.get(column) ?? content;
      }
      if (merge !== undefined) above.set(column, content);
      else above.delete(column);
      row[column] = content;
      column += gridSpan(tc);
    }
    rows.push(row);
  }
  const header =
    xmlRows.length > 1 && xmlRows[0] !== undefined && isHeaderRow(xmlRows[0]);
  return tableLines(rows, header);
}

/** Lines of block content (a body, a cell, a text box, a header). */
function blockLines(ctx: Context, node: XNode): string[] {
  const out: string[] = [];
  for (const c of elements(node)) {
    switch (c.name) {
      case 'w:p':
        out.push(...paragraphLines(ctx, c));
        break;
      case 'w:tbl':
        out.push(...tableLinesOf(ctx, c));
        break;
      case 'w:sdt': {
        const content = child(c, 'w:sdtContent');
        if (content) out.push(...blockLines(ctx, content));
        break;
      }
      case 'w:customXml':
      case 'w:ins':
      case 'w:moveTo':
      case 'w:txbxContent':
        out.push(...blockLines(ctx, c));
        break;
      case 'mc:AlternateContent':
        walkAlternate(c, (choice) => out.push(...blockLines(ctx, choice)));
        break;
      default:
        break;
    }
  }
  return out;
}

function noteLines(
  ctx: Context,
  root: XNode,
  name: 'w:footnote' | 'w:endnote'
): string[] {
  const out: string[] = [];
  for (const note of elements(root)) {
    if (note.name !== name) continue;
    const type = attr(note, 'w:type');
    if (
      type === 'separator' ||
      type === 'continuationSeparator' ||
      type === 'continuationNotice'
    ) {
      continue;
    }
    out.push(...blockLines(ctx, note));
  }
  return out;
}

/** The lines of a Word document, in reading order. */
export function docxLines(zip: ZipArchive, limits: Limits): string[] {
  const main = mainPart(zip, limits) ?? 'word/document.xml';
  const text = zip.readText(main);
  if (text === undefined) {
    throw new ExtractError('damaged', 'The Word file has no document part.');
  }
  const ctx = readStyles(zip, limits);
  const root = parseXml(text, limits.xmlDepth, limits.xmlElements);
  const body = child(root, 'w:body');
  if (!body)
    throw new ExtractError('damaged', 'The Word file has no document body.');

  const rels = relationships(zip, main, limits);
  const partLines = (kind: string): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const rel of rels) {
      if (!rel.type.endsWith(`/${kind}`)) continue;
      const xml = zip.readText(rel.target);
      if (xml === undefined) continue;
      for (const line of blockLines(
        ctx,
        parseXml(xml, limits.xmlDepth, limits.xmlElements)
      )) {
        if (seen.has(line)) continue;
        seen.add(line);
        out.push(line);
      }
    }
    return out;
  };
  const notes = (
    kind: 'footnotes' | 'endnotes',
    name: 'w:footnote' | 'w:endnote'
  ): string[] => {
    const rel = rels.find((r) => r.type.endsWith(`/${kind}`));
    const xml = rel ? zip.readText(rel.target) : undefined;
    return xml === undefined
      ? []
      : noteLines(
          ctx,
          parseXml(xml, limits.xmlDepth, limits.xmlElements),
          name
        );
  };

  return [
    ...partLines('header'),
    ...blockLines(ctx, body),
    ...partLines('footer'),
    ...notes('footnotes', 'w:footnote'),
    ...notes('endnotes', 'w:endnote'),
  ];
}
