// PDF text (docs/supamac/jobs.md §2): per page, in reading order, by line; a
// page with little or no text layer, or with invisible text, is a scan.
//
// Invariants:
// - PDF.js runs in this process with nothing fetched: its worker module is
//   loaded from the package (no worker script, no network), `useWorkerFetch`
//   is off, the standard fonts and CMaps are read from the package's own
//   folders, no image is decoded (`maxImageSize: 0`), XFA forms are off, and
//   `isEvalSupported: false` is passed (this PDF.js build has no eval path
//   at all; the option keeps it off if a build ever reads it). Parsing
//   errors reject instead of being papered over (`stopAtErrors`).
// - Pages are numbered from 1 as the PDF orders them.
// - A line is the text items whose baselines sit at one height of the page as
//   it is shown (its rotation applied) and that follow one another without a
//   gap wider than `COLUMN_GAP` font sizes. A wider gap (a column gutter, the
//   space between two table cells) ends the line, and the text after it is a
//   line of its own, so text from two columns set that far apart is never one
//   line. Lines run
//   top to bottom and, at one height, left to right: a page in columns or a
//   table is read across, one piece of each column at a time. Text running
//   in another direction is a line of its own. An item drawn twice at the
//   same place (fake bold) counts once.
// - A page is a scan when it shows fewer than `scanMinChars` non-space
//   characters, or when any glyph on it is drawn so that it does not show:
//   text render mode 3 or 7 (OCR over a scanned image), a fill (or stroke)
//   opacity of `ALPHA_MIN` or less for what the mode paints, inside an
//   optional-content layer the document's default view turns off, wholly
//   outside the clipping path in force (tracked as the bounding box of each
//   clip path, a form's box included, through save and restore), in a font
//   under one point, or outside the page box (text wholly off the page PDF.js
//   leaves out, so it is never read). A scan page with invisible text has no
//   lines (its text layer is not what it shows); a page that is a scan only
//   for having little text keeps the lines it shows.
// - Glyphs filled in white or near white (each channel at least `WHITE_MIN`
//   of 255) count as shown, since nothing is rendered to see what is behind
//   them, but they make the page unsure (`WHITE_TEXT`): white text on a
//   coloured banner is ordinary, white text on a white page is hidden, and
//   only the page itself tells them apart, so every detail from such a page
//   needs review.
// - Glyphs drawn by annotations (form-field appearances) are not counted:
//   their text is not part of the page's text content, so it is never read.
// - A page PDF.js cannot read (it rejects under `stopAtErrors`) is a scan
//   with no lines, and is named in the Sources row's Note.
// - A password-protected PDF is refused; one over `maxPdfPages` pages is
//   refused; over `pageTextOnlyPages` pages or `pageTextOnlyBytes` bytes it is
//   read from its page text only.
//
// Not handled: form-field values (widget annotations) are not read, so a
// filled form with little other text is a scan for the model; text drawn in
// the colour of what is behind it (white on white, under an image) is taken
// as shown (white makes its page unsure, see above), because nothing is
// rendered; a clip path is taken as its bounding
// box, so text inside the box but outside a curved clip counts as shown;
// columns closer than `COLUMN_GAP` font sizes are read as one line;
// right-to-left scripts are ordered left to right.

import type {
  DocumentInitParameters,
  PDFDocumentProxy,
  PDFPageProxy,
} from 'pdfjs-dist/types/src/display/api';
import type { TextPage } from '../model';
import { ExtractError, type Limits } from './types';
import { errorText } from './zip';

/** The text render modes that paint nothing (PDF 32000-1, 9.3.6). */
const INVISIBLE_MODES = new Set([3, 7]);
/** Modes that fill glyphs, and modes that stroke them. */
const FILL_MODES = new Set([0, 2, 4, 6]);
const STROKE_MODES = new Set([1, 2, 5, 6]);

/** An opacity at or below this paints nothing a reader can see. */
export const ALPHA_MIN = 0.05;

/** A fill whose every channel is at least this (of 255) is white or near it. */
export const WHITE_MIN = 0xf0;

export const WHITE_TEXT =
  'the page has white text, which may not show on the page';

/** Whether a PDF.js fill colour (`#rrggbb`) is white or near it. */
export function nearWhite(hex: unknown): boolean {
  if (typeof hex !== 'string') return false;
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return false;
  return [m[1], m[2], m[3]].every(
    (c) => Number.parseInt(c ?? '0', 16) >= WHITE_MIN
  );
}

/**
 * A gap between two items wider than this many font sizes (the larger of the
 * two) ends a line. One tab to the next default stop (1.27 cm) leaves at most
 * three sizes of 12 pt text, so a label and its value set apart by a tab stay
 * one line; a column gutter or the gap between table cells is usually wider.
 */
export const COLUMN_GAP = 3;

/** Saved graphics states and marked-content levels kept; deeper ones are counted only. */
const MAX_STACK = 1024;

/** PDF.js operator codes this module reads (pdfjs-dist OPS). */
export interface OpCodes {
  readonly save: number;
  readonly restore: number;
  readonly transform: number;
  readonly setGState: number;
  readonly setTextRenderingMode: number;
  readonly setFillRGBColor?: number | undefined;
  readonly setFont: number;
  readonly setCharSpacing: number;
  readonly setWordSpacing: number;
  readonly setHScale: number;
  readonly setLeading: number;
  readonly setLeadingMoveText: number;
  readonly setTextRise: number;
  readonly moveText: number;
  readonly setTextMatrix: number;
  readonly nextLine: number;
  readonly beginText: number;
  readonly showText: number;
  readonly showSpacedText: number;
  readonly nextLineShowText: number;
  readonly nextLineSetSpacingShowText: number;
  readonly clip: number;
  readonly eoClip: number;
  readonly constructPath: number;
  readonly paintFormXObjectBegin: number;
  readonly paintFormXObjectEnd: number;
  readonly beginGroup: number;
  readonly endGroup: number;
  readonly beginMarkedContent: number;
  readonly beginMarkedContentProps: number;
  readonly endMarkedContent: number;
  readonly beginAnnotation: number;
  readonly endAnnotation: number;
}

export interface GlyphCounts {
  readonly visible: number;
  readonly invisible: number;
  /** Shown glyphs filled in white or near it. */
  readonly white?: number | undefined;
}

/** An affine matrix [a b c d e f], as PDF.js writes one. */
export type Matrix = readonly number[];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function apply(m: Matrix, x: number, y: number): [number, number] {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
  return [a * x + c * y + e, b * x + d * y + f];
}

/** The matrix that applies `first`, then `then`. */
function multiply(first: Matrix, then: Matrix): Matrix {
  const [a1 = 1, b1 = 0, c1 = 0, d1 = 1, e1 = 0, f1 = 0] = first;
  const [a2 = 1, b2 = 0, c2 = 0, d2 = 1, e2 = 0, f2 = 0] = then;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

/** An axis-aligned box [x0, y0, x1, y1]; x0 > x1 is the empty box. */
type Box = readonly [number, number, number, number];

const EMPTY: Box = [1, 1, 0, 0];

/** The bounding box of a box's corners mapped through `m`. */
function mapBox(box: Box, m: Matrix): Box {
  const [x0, y0, x1, y1] = box;
  const corners = [
    apply(m, x0, y0),
    apply(m, x1, y0),
    apply(m, x0, y1),
    apply(m, x1, y1),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function intersect(a: Box, b: Box): Box {
  const box: Box = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return box[0] > box[2] || box[1] > box[3] ? EMPTY : box;
}

/** Whether two boxes share any point, half a point of tolerance allowed. */
function touches(a: Box, b: Box): boolean {
  const slack = 0.5;
  if (a[0] > a[2] || b[0] > b[2]) return false;
  return (
    a[0] <= b[2] + slack &&
    b[0] <= a[2] + slack &&
    a[1] <= b[3] + slack &&
    b[1] <= a[3] + slack
  );
}

/** Finite numbers from an array or typed array of `length`, or undefined. */
function numberList(value: unknown, length: number): number[] | undefined {
  const list = arrayOf(value);
  if (list === undefined || list.length !== length) return undefined;
  const out: number[] = [];
  for (const v of list) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    out.push(v);
  }
  return out;
}

function arrayOf(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (value instanceof Float32Array || value instanceof Float64Array)
    return Array.from(value);
  return undefined;
}

/** A box from four numbers in any corner order. */
function boxOf(list: readonly number[]): Box {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = list;
  return [
    Math.min(x0, x1),
    Math.min(y0, y1),
    Math.max(x0, x1),
    Math.max(y0, y1),
  ];
}

/**
 * A clip path's box from PDF.js's [minX, minY, maxX, maxY]: the empty box
 * for an empty path (PDF.js writes its bounds as infinities), undefined when
 * it is not four numbers.
 */
function clipBoxOf(value: unknown): Box | undefined {
  const list = arrayOf(value);
  if (list === undefined || list.length !== 4) return undefined;
  if (!list.every((v) => typeof v === 'number' && !Number.isNaN(v)))
    return undefined;
  const [x0, y0, x1, y1] = list as readonly number[];
  if ((x0 as number) > (x1 as number) || (y0 as number) > (y1 as number))
    return EMPTY;
  if (!list.every((v) => Number.isFinite(v))) return undefined;
  return boxOf(list as readonly number[]);
}

function argList(args: unknown): readonly unknown[] {
  return Array.isArray(args) ? args : [];
}

function numberArg(args: unknown, i: number): number | undefined {
  const v = argList(args)[i];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function glyphText(glyph: unknown): string {
  if (typeof glyph === 'string') return glyph;
  if (typeof glyph === 'object' && glyph !== null && 'unicode' in glyph) {
    return typeof glyph.unicode === 'string' ? glyph.unicode : '';
  }
  return '';
}

function glyphWidth(glyph: unknown): number {
  if (typeof glyph === 'object' && glyph !== null && 'width' in glyph) {
    const w = glyph.width;
    if (typeof w === 'number' && Number.isFinite(w)) return w;
  }
  // No width given: an average glyph's advance.
  return 500;
}

function glyphIsSpace(glyph: unknown): boolean {
  if (typeof glyph === 'object' && glyph !== null && 'isSpace' in glyph)
    return glyph.isSpace === true;
  return glyphText(glyph) === ' ';
}

interface GraphicsState {
  ctm: Matrix;
  /** The clipping path's bounding box in user space; undefined is the whole page. */
  clip: Box | undefined;
  mode: number;
  fillAlpha: number;
  strokeAlpha: number;
  /** The fill colour is white or near it. */
  fillWhite: boolean;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
}

/** The parts of a show-text operation this module measures. */
interface Run {
  /** Non-space glyphs. */
  readonly glyphs: number;
  /** The advance in text space (font size, spacing and scaling applied). */
  readonly advance: number;
}

function measureRun(glyphs: unknown, gs: GraphicsState): Run {
  let advance = 0;
  let count = 0;
  for (const g of Array.isArray(glyphs) ? glyphs : []) {
    if (typeof g === 'number') {
      if (Number.isFinite(g)) advance -= (g / 1000) * gs.fontSize * gs.hScale;
      continue;
    }
    const space = glyphIsSpace(g);
    advance +=
      ((glyphWidth(g) / 1000) * gs.fontSize +
        gs.charSpacing +
        (space ? gs.wordSpacing : 0)) *
      gs.hScale;
    if (glyphText(g).trim() !== '') count += 1;
  }
  return { glyphs: count, advance };
}

export interface CountOptions {
  /**
   * Whether an optional-content group or membership (the properties of an
   * "OC" marked-content sequence, as PDF.js gives them) is shown in the
   * document's default view. Everything is shown when it is not given.
   */
  readonly isVisible?: ((properties: unknown) => boolean) | undefined;
}

/**
 * Counts the non-space glyphs an operator list draws so that they show, and
 * those it draws so that they do not (an invisible render mode, no opacity,
 * a layer that is off, or wholly outside the clip), following the graphics
 * state through save and restore, form XObjects and groups.
 */
export function countGlyphs(
  fnArray: readonly number[],
  argsArray: readonly unknown[],
  ops: OpCodes,
  options: CountOptions = {}
): GlyphCounts {
  const isVisible = options.isVisible ?? (() => true);
  let gs: GraphicsState = {
    ctm: IDENTITY,
    clip: undefined,
    mode: 0,
    fillAlpha: 1,
    strokeAlpha: 1,
    fillWhite: false,
    fontSize: 0,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
  };
  const saved: GraphicsState[] = [];
  let unsaved = 0;
  const marked: boolean[] = [];
  let unmarked = 0;
  let hiddenLevels = 0;
  let annotation = 0;
  let pendingClip = false;
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let visible = 0;
  let invisible = 0;
  let white = 0;

  const push = (): void => {
    if (saved.length < MAX_STACK) saved.push({ ...gs });
    else unsaved++;
  };
  const pop = (): void => {
    if (unsaved > 0) unsaved--;
    else gs = saved.pop() ?? gs;
  };
  const moveText = (tx: number, ty: number): void => {
    tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  const show = (glyphs: unknown): void => {
    const run = measureRun(glyphs, gs);
    if (run.glyphs > 0) {
      const size = Math.abs(gs.fontSize);
      const box = mapBox(
        [
          Math.min(0, run.advance),
          gs.rise - 0.3 * size,
          Math.max(0, run.advance),
          gs.rise + size,
        ],
        multiply(tm, gs.ctm)
      );
      const fills = FILL_MODES.has(gs.mode);
      const strokes = STROKE_MODES.has(gs.mode);
      // A mode outside 0–7 is drawn as a fill, as PDF.js draws it.
      const paints =
        fills || strokes || INVISIBLE_MODES.has(gs.mode)
          ? (fills && gs.fillAlpha > ALPHA_MIN) ||
            (strokes && gs.strokeAlpha > ALPHA_MIN)
          : gs.fillAlpha > ALPHA_MIN;
      const clipped = gs.clip !== undefined && !touches(gs.clip, box);
      if (paints && hiddenLevels === 0 && !clipped) {
        visible += run.glyphs;
        if (fills && gs.fillWhite) white += run.glyphs;
      } else invisible += run.glyphs;
    }
    tm = multiply([1, 0, 0, 1, run.advance, 0], tm);
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === ops.beginAnnotation) {
      annotation++;
      continue;
    }
    if (fn === ops.endAnnotation) {
      annotation = Math.max(0, annotation - 1);
      continue;
    }
    if (annotation > 0) continue;

    switch (fn) {
      case ops.save:
      case ops.beginGroup:
        push();
        break;
      case ops.restore:
      case ops.endGroup:
      case ops.paintFormXObjectEnd:
        pop();
        break;
      case ops.paintFormXObjectBegin: {
        push();
        const matrix = numberList(argList(args)[0], 6);
        if (matrix) gs.ctm = multiply(matrix, gs.ctm);
        const bbox = numberList(argList(args)[1], 4);
        if (bbox) {
          const region = mapBox(boxOf(bbox), gs.ctm);
          gs.clip = gs.clip ? intersect(gs.clip, region) : region;
        }
        break;
      }
      case ops.transform: {
        const m = numberList(args, 6);
        if (m) gs.ctm = multiply(m, gs.ctm);
        break;
      }
      case ops.clip:
      case ops.eoClip:
        pendingClip = true;
        break;
      case ops.constructPath: {
        if (pendingClip) {
          const minMax = clipBoxOf(argList(args)[2]);
          if (minMax) {
            const region = minMax === EMPTY ? EMPTY : mapBox(minMax, gs.ctm);
            gs.clip = gs.clip ? intersect(gs.clip, region) : region;
          }
        }
        pendingClip = false;
        break;
      }
      case ops.setGState: {
        for (const entry of argList(argList(args)[0])) {
          const [key, value] = argList(entry);
          if (typeof value === 'number' && Number.isFinite(value)) {
            if (key === 'ca') gs.fillAlpha = value;
            else if (key === 'CA') gs.strokeAlpha = value;
          } else if (key === 'Font') {
            const size = numberArg(value, 1);
            if (size !== undefined) gs.fontSize = size;
          }
        }
        break;
      }
      case ops.setTextRenderingMode: {
        const mode = numberArg(args, 0);
        if (mode !== undefined) gs.mode = mode;
        break;
      }
      case ops.setFillRGBColor:
        gs.fillWhite = nearWhite(argList(args)[0]);
        break;
      case ops.setFont: {
        const size = numberArg(args, 1);
        if (size !== undefined) gs.fontSize = size;
        break;
      }
      case ops.setCharSpacing:
        gs.charSpacing = numberArg(args, 0) ?? gs.charSpacing;
        break;
      case ops.setWordSpacing:
        gs.wordSpacing = numberArg(args, 0) ?? gs.wordSpacing;
        break;
      case ops.setHScale: {
        const scale = numberArg(args, 0);
        if (scale !== undefined) gs.hScale = scale / 100;
        break;
      }
      case ops.setLeading:
        gs.leading = numberArg(args, 0) ?? gs.leading;
        break;
      case ops.setTextRise:
        gs.rise = numberArg(args, 0) ?? gs.rise;
        break;
      case ops.beginText:
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case ops.setTextMatrix: {
        const m = numberList(argList(args)[0], 6) ?? numberList(args, 6);
        if (m) {
          tm = m;
          tlm = m;
        }
        break;
      }
      case ops.moveText:
        moveText(numberArg(args, 0) ?? 0, numberArg(args, 1) ?? 0);
        break;
      case ops.setLeadingMoveText: {
        const ty = numberArg(args, 1) ?? 0;
        gs.leading = -ty;
        moveText(numberArg(args, 0) ?? 0, ty);
        break;
      }
      case ops.nextLine:
        moveText(0, -gs.leading);
        break;
      case ops.showText:
      case ops.showSpacedText:
        // PDF.js gives every text-showing operator its glyphs as the first argument.
        show(argList(args)[0]);
        break;
      case ops.nextLineShowText:
        moveText(0, -gs.leading);
        show(argList(args)[0]);
        break;
      case ops.nextLineSetSpacingShowText:
        gs.wordSpacing = numberArg(args, 0) ?? gs.wordSpacing;
        gs.charSpacing = numberArg(args, 1) ?? gs.charSpacing;
        moveText(0, -gs.leading);
        show(argList(args)[2]);
        break;
      case ops.beginMarkedContent:
      case ops.beginMarkedContentProps: {
        const hidden =
          fn === ops.beginMarkedContentProps &&
          argList(args)[0] === 'OC' &&
          !isVisible(argList(args)[1]);
        if (marked.length < MAX_STACK) {
          marked.push(hidden);
          if (hidden) hiddenLevels++;
        } else {
          unmarked++;
        }
        break;
      }
      case ops.endMarkedContent:
        if (unmarked > 0) unmarked--;
        else if (marked.pop() === true) hiddenLevels--;
        break;
      default:
        break;
    }
  }
  return { visible, invisible, ...(white > 0 ? { white } : {}) };
}

/** A text item's text and place, as PDF.js gives them. */
export interface PdfTextItem {
  readonly str: string;
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
}

interface Placed {
  readonly str: string;
  readonly x: number;
  readonly end: number;
  readonly y: number;
  readonly size: number;
  /** Runs left to right on the shown page. */
  readonly horizontal: boolean;
}

export interface LineResult {
  readonly lines: string[];
  /** Non-space characters of the text the page shows. */
  readonly visibleChars: number;
  /** Non-space characters drawn too small or outside the page box. */
  readonly hiddenChars: number;
}

function nonSpace(text: string): number {
  return text.replace(/\s+/gu, '').length;
}

/** Places one item on the shown page, or returns undefined for an unusable one. */
function place(item: PdfTextItem, viewport: Matrix): Placed | undefined {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = item.transform;
  if (![a, b, c, d, e, f, item.width, item.height].every(Number.isFinite))
    return undefined;

  // The text's own direction, as a unit vector in PDF user space, mapped
  // onto the shown page to tell left-to-right text from rotated text.
  const scale = Math.hypot(a, b) || 1;
  const ux = a / scale;
  const uy = b / scale;
  const [x0, y0] = apply(viewport, e, f);
  const [xd, yd] = apply(viewport, e + ux, f + uy);
  const dx = xd - x0;
  const dy = yd - y0;
  const horizontal = dx > 0 && Math.abs(dy) <= Math.abs(dx) * 0.05;

  return {
    str: item.str,
    x: x0,
    end: x0 + dx * item.width,
    y: y0,
    size: Math.max(Math.abs(item.height), Math.hypot(c, d)),
    horizontal,
  };
}

/**
 * Joins one baseline's items left to right, with a space where they stand
 * apart, into one line per run of items no gap wider than `COLUMN_GAP` font
 * sizes divides.
 */
function splitLine(items: readonly Placed[]): string[] {
  const sorted = [...items].sort((p, q) => p.x - q.x);
  const out: string[] = [];
  let text = '';
  let last: Placed | undefined;
  for (const p of sorted) {
    const duplicate =
      last !== undefined &&
      last.str === p.str &&
      Math.abs(last.x - p.x) <= Math.max(1, 0.2 * p.size) &&
      Math.abs(last.y - p.y) <= Math.max(1, 0.2 * p.size);
    if (duplicate) continue;

    if (last) {
      const gap = p.x - last.end;
      if (gap > COLUMN_GAP * Math.max(last.size, p.size)) {
        out.push(text);
        text = '';
      } else {
        const spaced = /\s$/u.test(text) || /^\s/u.test(p.str);
        if (!spaced && gap > 0.15 * Math.min(last.size, p.size)) text += ' ';
      }
    }
    text += p.str;
    last = p;
  }
  out.push(text);
  return out.map((t) => t.replace(/\s+/gu, ' ').trim()).filter((t) => t !== '');
}

/**
 * Groups text items into lines in reading order on the page as shown.
 * `viewport` maps PDF user space to the shown page (y down), `box` is the
 * shown page's width and height.
 */
export function groupLines(
  items: readonly PdfTextItem[],
  viewport: Matrix,
  box: { readonly width: number; readonly height: number }
): LineResult {
  const placed: Placed[] = [];
  let hiddenChars = 0;
  let visibleChars = 0;
  for (const item of items) {
    if (item.str.trim() === '') continue;
    const p = place(item, viewport);
    if (!p) continue;
    const chars = nonSpace(item.str);
    const outside =
      p.x < -1 || p.y < -1 || p.x > box.width + 1 || p.y > box.height + 1;
    if (p.size < 1 || outside) {
      hiddenChars += chars;
      continue;
    }
    visibleChars += chars;
    placed.push(p);
  }

  // Left-to-right items join the line whose baseline is within 0.4 of a
  // font size; anything else is a line of its own. Lines run top to bottom.
  const flowing = placed
    .filter((p) => p.horizontal)
    .sort((p, q) => p.y - q.y || p.x - q.x);
  const lines: { y: number; size: number; items: Placed[] }[] = [];
  for (const p of flowing) {
    const line = lines.at(-1);
    if (line && Math.abs(p.y - line.y) <= 0.4 * Math.max(line.size, p.size)) {
      line.items.push(p);
    } else {
      lines.push({ y: p.y, size: p.size, items: [p] });
    }
  }
  for (const p of placed) {
    if (!p.horizontal) lines.push({ y: p.y, size: p.size, items: [p] });
  }
  lines.sort((l, m) => l.y - m.y);

  const out = lines.flatMap((l) => splitLine(l.items));
  return { lines: out, visibleChars, hiddenChars };
}

/** Decides a page's kind and lines from its text and its operator list. */
export function pageFromText(
  page: number,
  text: LineResult,
  glyphs: GlyphCounts,
  minChars: number
): TextPage {
  const invisible = glyphs.invisible > 0 || text.hiddenChars > 0;
  if (invisible) return { page, kind: 'scan', lines: [] };
  if (text.visibleChars < minChars)
    return { page, kind: 'scan', lines: text.lines };
  if ((glyphs.white ?? 0) > 0)
    return { page, kind: 'text', unsure: WHITE_TEXT, lines: text.lines };
  return { page, kind: 'text', lines: text.lines };
}

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

declare global {
  // Read by PDF.js to run its worker in this process instead of starting one.
  var pdfjsWorker: { readonly WorkerMessageHandler: unknown } | undefined;
}

let loaded: Promise<{ pdfjs: Pdfjs; root: string }> | undefined;

/** Loads PDF.js with its worker in this process, once. */
function loadPdfjs(): Promise<{ pdfjs: Pdfjs; root: string }> {
  loaded ??= (async () => {
    globalThis.pdfjsWorker = await import(
      'pdfjs-dist/legacy/build/pdf.worker.mjs'
    );
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const manifest = new URL(import.meta.resolve('pdfjs-dist/package.json'));
    const root = decodeURIComponent(new URL('.', manifest).pathname);
    return { pdfjs, root };
  })();
  return loaded;
}

function opCodes(pdfjs: Pdfjs): OpCodes {
  const { OPS } = pdfjs;
  return {
    save: OPS.save,
    restore: OPS.restore,
    transform: OPS.transform,
    setGState: OPS.setGState,
    setTextRenderingMode: OPS.setTextRenderingMode,
    setFillRGBColor: OPS.setFillRGBColor,
    setFont: OPS.setFont,
    setCharSpacing: OPS.setCharSpacing,
    setWordSpacing: OPS.setWordSpacing,
    setHScale: OPS.setHScale,
    setLeading: OPS.setLeading,
    setLeadingMoveText: OPS.setLeadingMoveText,
    setTextRise: OPS.setTextRise,
    moveText: OPS.moveText,
    setTextMatrix: OPS.setTextMatrix,
    nextLine: OPS.nextLine,
    beginText: OPS.beginText,
    showText: OPS.showText,
    showSpacedText: OPS.showSpacedText,
    nextLineShowText: OPS.nextLineShowText,
    nextLineSetSpacingShowText: OPS.nextLineSetSpacingShowText,
    clip: OPS.clip,
    eoClip: OPS.eoClip,
    constructPath: OPS.constructPath,
    paintFormXObjectBegin: OPS.paintFormXObjectBegin,
    paintFormXObjectEnd: OPS.paintFormXObjectEnd,
    beginGroup: OPS.beginGroup,
    endGroup: OPS.endGroup,
    beginMarkedContent: OPS.beginMarkedContent,
    beginMarkedContentProps: OPS.beginMarkedContentProps,
    endMarkedContent: OPS.endMarkedContent,
    beginAnnotation: OPS.beginAnnotation,
    endAnnotation: OPS.endAnnotation,
  };
}

function numbers(values: readonly unknown[]): number[] | undefined {
  const out: number[] = [];
  for (const v of values) {
    if (typeof v !== 'number') return undefined;
    out.push(v);
  }
  return out;
}

export interface PdfText {
  readonly pages: TextPage[];
  readonly pageCount: number;
  readonly pageTextOnly: boolean;
  /** Pages PDF.js could not read, left to the model as scans. */
  readonly unreadPages: number[];
}

/** Reads a PDF's pages. Throws ExtractError for a PDF it refuses. */
export async function pdfText(
  bytes: Uint8Array,
  limits: Limits
): Promise<PdfText> {
  const { pdfjs, root } = await loadPdfjs();
  const ops = opCodes(pdfjs);
  const params: DocumentInitParameters & { readonly isEvalSupported: false } = {
    data: bytes.slice(),
    isEvalSupported: false,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWasm: false,
    enableXfa: false,
    stopAtErrors: true,
    maxImageSize: 0,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    standardFontDataUrl: `${root}standard_fonts/`,
    cMapUrl: `${root}cmaps/`,
    cMapPacked: true,
  };
  const task = pdfjs.getDocument(params);
  try {
    let doc: PDFDocumentProxy;
    try {
      doc = await task.promise;
    } catch (error) {
      if (error instanceof pdfjs.PasswordException) {
        throw new ExtractError(
          'encrypted',
          'The PDF is password-protected, so it cannot be read.'
        );
      }
      throw new ExtractError(
        'damaged',
        `The PDF cannot be opened (${errorText(error)}).`
      );
    }

    const count = doc.numPages;
    if (!Number.isInteger(count) || count < 1) {
      throw new ExtractError('damaged', 'The PDF has no pages.');
    }
    if (count > limits.maxPdfPages) {
      throw new ExtractError(
        'too_many_pages',
        `The PDF has ${count.toLocaleString('en-GB')} pages, more than the ${limits.maxPdfPages.toLocaleString('en-GB')} read.`
      );
    }

    const isVisible = await layerVisibility(doc);
    const pages: TextPage[] = [];
    const unreadPages: number[] = [];
    for (let n = 1; n <= count; n++) {
      const page = await readPage(doc, n, ops, isVisible, limits);
      if (page === undefined) {
        unreadPages.push(n);
        pages.push({ page: n, kind: 'scan', lines: [] });
      } else {
        pages.push(page);
      }
    }
    return {
      pages,
      pageCount: count,
      pageTextOnly:
        count > limits.pageTextOnlyPages ||
        bytes.length > limits.pageTextOnlyBytes,
      unreadPages,
    };
  } finally {
    await task.destroy();
  }
}

/**
 * Whether an optional-content layer is on in the document's default view. A
 * document whose layer settings cannot be read has every layer counted as
 * off, so text in one makes its page a scan.
 */
async function layerVisibility(
  doc: PDFDocumentProxy
): Promise<(properties: unknown) => boolean> {
  try {
    const config = await doc.getOptionalContentConfig();
    return (properties) => {
      try {
        return config.isVisible(properties) !== false;
      } catch {
        return false;
      }
    };
  } catch {
    return () => false;
  }
}

/** One page, or undefined when PDF.js cannot read it. */
async function readPage(
  doc: PDFDocumentProxy,
  n: number,
  ops: OpCodes,
  isVisible: (properties: unknown) => boolean,
  limits: Limits
): Promise<TextPage | undefined> {
  let page: PDFPageProxy;
  try {
    page = await doc.getPage(n);
  } catch {
    return undefined;
  }
  try {
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent({ includeMarkedContent: false });
    const list = await page.getOperatorList();
    const items: PdfTextItem[] = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const transform = numbers(item.transform);
      if (!transform || transform.length !== 6) continue;
      items.push({
        str: item.str,
        transform,
        width: item.width,
        height: item.height,
      });
    }
    const lines = groupLines(items, viewport.transform, {
      width: viewport.width,
      height: viewport.height,
    });
    const glyphs = countGlyphs(list.fnArray, list.argsArray, ops, {
      isVisible,
    });
    return pageFromText(n, lines, glyphs, limits.scanMinChars);
  } catch {
    return undefined;
  } finally {
    page.cleanup();
  }
}
