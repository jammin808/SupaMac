// An email's HTML body as lines (docs/supamac/jobs.md §2: "the HTML part as
// text"), with html-to-text.
//
// Invariants:
// - Only text a reader sees is kept: an element with the `hidden` attribute
//   or an inline style of display:none, visibility:hidden or collapse,
//   mso-hide:all, an opacity of `OPACITY_MIN` or less, or a zero height,
//   max-height, width or max-width with its overflow hidden or clipped, is
//   dropped with everything inside it. Text in a font under `FONT_MIN_PX`
//   pixels (font-size, or the font shorthand) is dropped too, but an element
//   inside it that sets a readable size again is read, as a block of its own
//   (the font-size:0 layout of many email templates); em, rem and % sizes are
//   taken against a 16-pixel font. Images, SVG, templates, frames and objects
//   are dropped; <head>, <style> and <script> carry no text.
// - Text hidden in other ways is dropped too: an inline colour equal to the
//   element's own background or `transparent`, a text-indent or an absolute
//   or fixed position of `OFF_SCREEN_PX` or more off the page, and every
//   element carrying a class that a top-level rule of the email's own
//   stylesheet hides by any of these means (`.name` or `tag.name`).
// - What cannot be told from the HTML alone makes the body unsure, so every
//   detail from it needs review: text coloured white or near it (inline, or
//   by a stylesheet rule) with no background of another colour set on it or
//   around it, and a stylesheet rule that hides text through a selector
//   other than a plain class, or only inside an at-rule (a screen size).
// - Links stay as text: the link's words, then its address in brackets when
//   the address differs from the words ("mailto:" removed).
// - Nothing is wrapped and no letter's case is changed (headings and table
//   headers keep their case).
// - Quoted history keeps its "> " prefixes, one per level, so history.ts can
//   split it.
// - A table whose cells hold only inline content is written by table.ts (a
//   header row when its first row is all <th> or in <thead>); a layout table
//   (a cell holding blocks) gives each cell's content as blocks of its own,
//   so text from two cells never shares a line.
// - Nesting beyond `xmlDepth` elements is not walked, and the result says
//   so, for the Sources row's Note.

import type {
  DomNode,
  FormatCallback,
  FormatOptions,
  RecursiveCallback,
} from 'html-to-text';
import type { BlockTextBuilder } from 'html-to-text/lib/block-text-builder';
import { htmlToText } from 'html-to-text';
import { cell, type TableCell, type TableRow, tableLines } from './table';

/** An opacity at or below this shows nothing a reader can see. */
const OPACITY_MIN = 0.05;
/** Text in a smaller font, in CSS pixels, cannot be read. */
const FONT_MIN_PX = 2;
/** Text moved this far off the page (a negative indent or position) is not shown. */
const OFF_SCREEN_PX = 500;

export const WHITE_HTML =
  'the email has white text, which may not show against its background';
export const STYLESHEET_HIDES =
  'the email’s stylesheet hides some of its text in ways the service cannot follow';

/** Classes the email being read hides with a plain top-level rule. */
let hiddenClasses: ReadonlySet<string> = new Set();
/** Why the email being read may not show as read; set while it is walked. */
let unsureWhy: string | undefined;

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

const SKIPPED_TAGS = [
  'img',
  'svg',
  'template',
  'iframe',
  'object',
  'embed',
  'picture',
  'video',
  'audio',
  'canvas',
  'map',
];

/** The built-in format each tag gets, so an element checked for hiding is drawn as usual. */
const TAG_FORMATS: Readonly<
  Record<string, { format: string; options: FormatOptions }>
> = {
  article: {
    format: 'block',
    options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
  },
  aside: {
    format: 'block',
    options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
  },
  div: {
    format: 'block',
    options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
  },
  footer: {
    format: 'block',
    options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
  },
  form: {
    format: 'block',
    options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
  },
  header: {
    format: 'block',
    options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
  },
  main: {
    format: 'block',
    options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
  },
  nav: {
    format: 'block',
    options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
  },
  section: {
    format: 'block',
    options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
  },
  center: {
    format: 'block',
    options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
  },
  li: {
    format: 'block',
    options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
  },
  dt: {
    format: 'block',
    options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
  },
  dd: {
    format: 'block',
    options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
  },
  details: {
    format: 'block',
    options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
  },
  summary: {
    format: 'block',
    options: { leadingLineBreaks: 1, trailingLineBreaks: 1 },
  },
  p: {
    format: 'paragraph',
    options: { leadingLineBreaks: 2, trailingLineBreaks: 2 },
  },
  h1: {
    format: 'heading',
    options: { leadingLineBreaks: 2, trailingLineBreaks: 2, uppercase: false },
  },
  h2: {
    format: 'heading',
    options: { leadingLineBreaks: 2, trailingLineBreaks: 2, uppercase: false },
  },
  h3: {
    format: 'heading',
    options: { leadingLineBreaks: 2, trailingLineBreaks: 2, uppercase: false },
  },
  h4: {
    format: 'heading',
    options: { leadingLineBreaks: 2, trailingLineBreaks: 2, uppercase: false },
  },
  h5: {
    format: 'heading',
    options: { leadingLineBreaks: 2, trailingLineBreaks: 2, uppercase: false },
  },
  h6: {
    format: 'heading',
    options: { leadingLineBreaks: 2, trailingLineBreaks: 2, uppercase: false },
  },
  blockquote: {
    format: 'blockquote',
    options: {
      leadingLineBreaks: 2,
      trailingLineBreaks: 2,
      trimEmptyLines: true,
    },
  },
  br: { format: 'lineBreak', options: {} },
  hr: {
    format: 'horizontalLine',
    options: { leadingLineBreaks: 2, trailingLineBreaks: 2 },
  },
  ol: {
    format: 'orderedList',
    options: { leadingLineBreaks: 2, trailingLineBreaks: 2 },
  },
  ul: {
    format: 'unorderedList',
    options: { itemPrefix: ' * ', leadingLineBreaks: 2, trailingLineBreaks: 2 },
  },
  pre: {
    format: 'pre',
    options: { leadingLineBreaks: 2, trailingLineBreaks: 2 },
  },
  a: {
    format: 'anchor',
    options: {
      hideLinkHrefIfSameAsText: true,
      ignoreHref: false,
      linkBrackets: ['[', ']'],
      noAnchorUrl: true,
    },
  },
  table: { format: 'jobsTable', options: {} },
  wbr: { format: 'wbr', options: {} },
};

function attribute(elem: DomNode, name: string): string | undefined {
  const attribs: unknown = elem.attribs;
  if (typeof attribs !== 'object' || attribs === null || !(name in attribs))
    return undefined;
  const value: unknown = Reflect.get(attribs, name);
  return typeof value === 'string' ? value : undefined;
}

/** An inline style's declarations, lower case, `!important` removed; the last of a property wins. */
function declarations(style: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of style.split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    const value = part
      .slice(colon + 1)
      .replace(/!\s*important/gi, '')
      .trim()
      .toLowerCase();
    if (property !== '') out.set(property, value);
  }
  return out;
}

const PX_PER: Readonly<Record<string, number>> = {
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  em: 16,
  rem: 16,
  ex: 8,
  ch: 8,
  '%': 0.16,
};

/** A CSS length in pixels (em, rem and % against 16 px), or undefined for a keyword or anything else. */
function lengthPx(value: string): number | undefined {
  const m = /^\+?(\d*\.?\d+)(px|pt|pc|in|cm|mm|q|em|rem|ex|ch|%)?$/.exec(
    value.trim()
  );
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  if (m[2] === undefined) return n === 0 ? 0 : undefined;
  return n * (PX_PER[m[2]] ?? 1);
}

const isZero = (value: string | undefined): boolean =>
  value !== undefined && lengthPx(value) === 0;

function opacityOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = /^(\d*\.?\d+)(%)?$/.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === '%' ? n / 100 : n;
}

/** A CSS colour as `#rrggbb` where it can be read; otherwise its text. */
export function colourOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'white') return '#ffffff';
  if (v === 'black') return '#000000';
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short)
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  const rgb =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/.exec(
      v
    );
  if (rgb)
    return `#${[rgb[1], rgb[2], rgb[3]]
      .map((c) => Math.min(255, Number(c)).toString(16).padStart(2, '0'))
      .join('')}`;
  return v;
}

/** Whether a colour is white or near it (each channel at least F0). */
export function whiteColour(value: string | undefined): boolean {
  const c = colourOf(value);
  if (c === undefined || !/^#[0-9a-f]{6}$/.test(c)) return false;
  return [c.slice(1, 3), c.slice(3, 5), c.slice(5, 7)].every(
    (h) => Number.parseInt(h, 16) >= 0xf0
  );
}

/** The background colour a declaration block sets, if any. */
function backgroundOf(css: ReadonlyMap<string, string>): string | undefined {
  const bg = css.get('background-color') ?? css.get('background');
  if (bg === undefined) return undefined;
  const first = bg.split(/\s+(?![^(]*\))/)[0];
  return colourOf(first);
}

/** A signed CSS length in pixels, or undefined. */
function signedPx(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  const negative = v.startsWith('-');
  const px = lengthPx(negative ? v.slice(1) : v);
  return px === undefined ? undefined : negative ? -px : px;
}

/** Whether declarations hide what they apply to (see the header). */
function cssHides(css: ReadonlyMap<string, string>, fonts: boolean): boolean {
  if (css.get('display') === 'none') return true;
  const visibility = css.get('visibility');
  if (visibility === 'hidden' || visibility === 'collapse') return true;
  if (css.get('mso-hide') === 'all') return true;
  const opacity = opacityOf(css.get('opacity'));
  if (opacity !== undefined && opacity <= OPACITY_MIN) return true;
  const color = colourOf(css.get('color'));
  if (color === 'transparent') return true;
  const background = backgroundOf(css);
  if (color !== undefined && background !== undefined && color === background)
    return true;
  const indent = signedPx(css.get('text-indent'));
  if (indent !== undefined && indent <= -OFF_SCREEN_PX) return true;
  const position = css.get('position');
  if (
    (position === 'absolute' || position === 'fixed') &&
    ['left', 'top', 'right', 'bottom'].some((side) => {
      const at = signedPx(css.get(side));
      return at !== undefined && at <= -OFF_SCREEN_PX;
    })
  )
    return true;
  if (fonts) {
    const size = lengthPx(css.get('font-size') ?? '');
    if (size !== undefined && size < FONT_MIN_PX) return true;
  }
  return false;
}

/** Whether a background of a colour other than white is set on an element or around it. */
function backgroundBehind(elem: DomNode): boolean {
  let node: unknown = elem;
  for (let i = 0; i < 200 && typeof node === 'object' && node !== null; i++) {
    const tag = node as DomNode;
    const style = attribute(tag, 'style');
    const bg =
      (style !== undefined ? backgroundOf(declarations(style)) : undefined) ??
      colourOf(attribute(tag, 'bgcolor'));
    if (bg !== undefined && bg !== 'transparent' && !whiteColour(bg))
      return true;
    node = Reflect.get(tag, 'parent');
  }
  return false;
}

/** The classes a stylesheet hides with plain top-level rules, and whether it hides by others. */
export function stylesheetHiding(html: string): {
  readonly classes: Set<string>;
  readonly unsure?: string | undefined;
} {
  const classes = new Set<string>();
  let unsure: string | undefined;
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const css = (m[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    const preludes: string[] = [];
    let from = 0;
    for (let k = 0; k < css.length; k++) {
      const ch = css[k];
      if (ch === '{') {
        preludes.push(css.slice(from, k).trim());
        from = k + 1;
      } else if (ch === '}') {
        const prelude = preludes.pop();
        if (prelude !== undefined && !prelude.startsWith('@')) {
          const decl = declarations(css.slice(from, k));
          const inAtRule = preludes.length > 0;
          if (cssHides(decl, true)) {
            for (const selector of prelude.split(',')) {
              const plain = /^(?:[a-z][a-z0-9]*)?\.([a-z0-9_-]+)$/i.exec(
                selector.trim()
              );
              if (plain?.[1] !== undefined && !inAtRule)
                classes.add(plain[1].toLowerCase());
              else unsure ??= STYLESHEET_HIDES;
            }
          } else if (whiteColour(decl.get('color'))) {
            const bg = backgroundOf(decl);
            if (bg === undefined || whiteColour(bg)) unsure = WHITE_HTML;
          }
        }
        from = k + 1;
      }
    }
  }
  return { classes, ...(unsure !== undefined ? { unsure } : {}) };
}

/** Whether an element is hidden, with everything inside it, by its own attributes. */
export function isHidden(elem: DomNode): boolean {
  if (attribute(elem, 'hidden') !== undefined) return true;
  const classAttr = attribute(elem, 'class');
  if (
    classAttr !== undefined &&
    hiddenClasses.size > 0 &&
    classAttr
      .split(/\s+/)
      .some((c) => c !== '' && hiddenClasses.has(c.toLowerCase()))
  )
    return true;
  const style = attribute(elem, 'style');
  if (style === undefined) return false;
  const css = declarations(style);
  if (cssHides(css, false)) return true;
  if (whiteColour(css.get('color')) && !backgroundBehind(elem))
    unsureWhy = WHITE_HTML;
  const overflow = [
    css.get('overflow'),
    css.get('overflow-y'),
    css.get('overflow-x'),
  ].some((v) => v !== undefined && /\b(hidden|clip)\b/.test(v));
  if (
    overflow &&
    (isZero(css.get('height')) ||
      isZero(css.get('max-height')) ||
      isZero(css.get('width')) ||
      isZero(css.get('max-width')))
  ) {
    return true;
  }
  return false;
}

/**
 * Whether an element's own style sets a font too small to read ("tiny"),
 * sets a readable one ("shown"), or sets none, so its parent's applies.
 */
function fontOf(elem: DomNode): 'tiny' | 'shown' | undefined {
  const style = attribute(elem, 'style');
  if (style === undefined) return undefined;
  const css = declarations(style);
  let size = css.get('font-size');
  const font = css.get('font');
  if (font !== undefined) {
    // The shorthand's size is its first length (a weight such as 400 is
    // not one), before an optional "/line-height".
    const token = font
      .replace(/\s*\/\s*/g, '/')
      .split(/\s+/)
      .map((t) => t.split('/')[0] ?? '')
      .find((t) => lengthPx(t) !== undefined);
    if (token !== undefined) size = token;
  }
  if (size === undefined) return undefined;
  const px = lengthPx(size);
  if (px === undefined) return 'shown';
  return px < FONT_MIN_PX ? 'tiny' : 'shown';
}

/**
 * Walks the children of an element whose font is too small to read: its
 * own text is dropped, and each element inside that sets a readable font
 * again is walked as a block of its own.
 */
function walkTiny(
  children: readonly DomNode[],
  walk: RecursiveCallback,
  builder: BlockTextBuilder
): void {
  for (const c of children) {
    if (!isTag(c) || isHidden(c) || SKIPPED_TAGS.includes(c.name ?? ''))
      continue;
    if (fontOf(c) === 'shown') {
      builder.openBlock({ leadingLineBreaks: 1 });
      walk([c], builder);
      builder.closeBlock({ trailingLineBreaks: 1 });
    } else {
      walkTiny(c.children, walk, builder);
    }
  }
}

function isTag(node: DomNode): boolean {
  return node.type === 'tag' && node.name !== undefined;
}

const formatMaybeHidden: FormatCallback = (elem, walk, builder) => {
  if (isHidden(elem)) return;
  const tag = TAG_FORMATS[elem.name ?? ''];
  if (SKIPPED_TAGS.includes(elem.name ?? '')) return;
  if (fontOf(elem) === 'tiny') {
    walkTiny(elem.children, walk, builder);
    return;
  }
  const format = builder.options.formatters[tag?.format ?? 'inline'];
  if (format) format(elem, walk, builder, tag?.options ?? {});
};

/** Rows of a table, through thead, tbody and tfoot but not into nested tables. */
function tableRows(table: DomNode): { row: DomNode; head: boolean }[] {
  const out: { row: DomNode; head: boolean }[] = [];
  for (const c of table.children) {
    if (!isTag(c) || isHidden(c)) continue;
    if (c.name === 'tr') out.push({ row: c, head: false });
    else if (c.name === 'thead' || c.name === 'tbody' || c.name === 'tfoot') {
      for (const r of c.children) {
        if (isTag(r) && r.name === 'tr' && !isHidden(r))
          out.push({ row: r, head: c.name === 'thead' });
      }
    }
  }
  return out;
}

function rowCells(row: DomNode): DomNode[] {
  return row.children.filter(
    (c) => isTag(c) && (c.name === 'td' || c.name === 'th') && !isHidden(c)
  );
}

function hasBlocks(node: DomNode): boolean {
  const stack = [...node.children];
  let seen = 0;
  while (seen < 10_000) {
    const n = stack.pop();
    if (n === undefined) return false;
    seen++;
    if (!isTag(n)) continue;
    if (BLOCK_TAGS.has(n.name ?? '')) return true;
    stack.push(...n.children);
  }
  // A cell too large to inspect is treated as holding blocks.
  return true;
}

/**
 * The visible inline text of a cell, with link addresses as html-to-text
 * writes them; `tiny` says the cell's font is too small to read, until an
 * element inside sets a readable one.
 */
function inlineText(node: DomNode, tiny: boolean): string {
  let out = '';
  for (const c of node.children) {
    if (c.type === 'text') {
      if (!tiny) out += c.data ?? '';
      continue;
    }
    if (!isTag(c) || isHidden(c) || SKIPPED_TAGS.includes(c.name ?? ''))
      continue;
    const font = fontOf(c);
    const childTiny = font === undefined ? tiny : font === 'tiny';
    const inner = inlineText(c, childTiny);
    out += inner;
    if (c.name === 'a' && !childTiny) {
      const href = (attribute(c, 'href') ?? '').replace(/^mailto:/i, '');
      if (href !== '' && !href.startsWith('#') && href !== inner.trim())
        out += ` [${href}]`;
    }
  }
  return out.replace(/\s+/g, ' ');
}

function writeLines(builder: BlockTextBuilder, lines: readonly string[]): void {
  if (lines.length === 0) return;
  builder.openBlock({ leadingLineBreaks: 1 });
  lines.forEach((line, i) => {
    if (i > 0) builder.addLineBreak();
    builder.addInline(line);
  });
  builder.closeBlock({ trailingLineBreaks: 1 });
}

const formatTable: FormatCallback = (
  elem,
  walk: RecursiveCallback,
  builder
) => {
  if (isHidden(elem)) return;
  const rows = tableRows(elem);
  const cells = rows.map((r) => rowCells(r.row));
  // Whether each cell's font, or else its row's, is too small to read.
  const tiny = rows.map((r, i) =>
    (cells[i] ?? []).map((c) => (fontOf(c) ?? fontOf(r.row)) === 'tiny')
  );
  const simple = cells.every((row) => row.every((c) => !hasBlocks(c)));
  if (simple) {
    const table: TableRow[] = cells.map((row, i) =>
      row.map((c, j): TableCell => cell(inlineText(c, tiny[i]?.[j] === true)))
    );
    const first = rows[0];
    const firstCells = cells[0] ?? [];
    const header =
      first !== undefined &&
      rows.length > 1 &&
      (first.head ||
        (firstCells.length > 0 && firstCells.every((c) => c.name === 'th')));
    writeLines(builder, tableLines(table, header));
    return;
  }
  cells.forEach((row, i) => {
    builder.openBlock({ leadingLineBreaks: 1 });
    row.forEach((c, j) => {
      builder.openBlock({ leadingLineBreaks: 1 });
      if (tiny[i]?.[j] === true) walkTiny(c.children, walk, builder);
      else walk(c.children, builder);
      builder.closeBlock({ trailingLineBreaks: 1 });
    });
    builder.closeBlock({ trailingLineBreaks: 1 });
  });
};

/** Written where html-to-text stops walking; never part of an email's text. */
const CUT = 'jobs-html-depth-limit-0c4f';

export interface HtmlText {
  readonly lines: string[];
  /** Whether content nested deeper than the limit was left out. */
  readonly cut: boolean;
  /** Why some of the text may not show as read (see the header). */
  readonly unsure?: string | undefined;
}

/** The lines of an HTML body, blank lines removed. */
export function htmlLines(
  html: string,
  maxDepth: number,
  maxChars: number
): HtmlText {
  const sheet = stylesheetHiding(html);
  hiddenClasses = sheet.classes;
  unsureWhy = sheet.unsure;
  let text: string;
  try {
    text = readHtml(html, maxDepth, maxChars);
  } finally {
    hiddenClasses = new Set();
  }
  const unsure = unsureWhy;
  unsureWhy = undefined;
  const lines = text
    .split('\n')
    .map((l) => l.replaceAll(CUT, '').replace(/\s+$/u, ''))
    .filter((l) => l.replace(/^[>\s]+/, '') !== '');
  return {
    lines,
    cut: text.includes(CUT),
    ...(unsure !== undefined ? { unsure } : {}),
  };
}

function readHtml(html: string, maxDepth: number, maxChars: number): string {
  return htmlToText(html, {
    wordwrap: false,
    preserveNewlines: false,
    decodeEntities: true,
    limits: { maxDepth, maxInputLength: maxChars, ellipsis: CUT },
    formatters: { jobsHidden: formatMaybeHidden, jobsTable: formatTable },
    selectors: [
      ...Object.entries(TAG_FORMATS).map(([selector, f]) => ({
        selector,
        format: f.format,
        options: f.options,
      })),
      ...SKIPPED_TAGS.map((selector) => ({ selector, format: 'skip' })),
      { selector: '[hidden]', format: 'jobsHidden' },
      { selector: '[style]', format: 'jobsHidden' },
      { selector: '[class]', format: 'jobsHidden' },
    ],
  });
}
