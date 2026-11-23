// XML for the zip-based files (docx, xlsx), parsed with entities off
// (docs/supamac/jobs.md, Security: "XML is parsed with entities off").
//
// Invariants:
// - A document with a DOCTYPE or an entity declaration is refused before it
//   is parsed; OOXML never carries one, so nothing can expand.
// - Nesting and elements are measured by a linear scan before parsing;
//   deeper than `xmlDepth` is refused, so no recursive step below can
//   overflow the stack, and more than `xmlElements` elements is refused as
//   too large, so no part can exhaust memory while its tree is built.
// - The parser decodes no entities. Only the five predefined ones and
//   numeric character references are decoded here, in text and attribute
//   values; CDATA is kept as written; any other `&name;` stays literal.

import { XMLParser } from 'fast-xml-parser';
import { ExtractError, LIMITS } from './types';
import { errorText } from './zip';

export interface XNode {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XChild[];
}
export type XChild = XNode | string;

const PREDEFINED: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

function fromCodePoint(code: number): string | undefined {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return undefined;
  if (code >= 0xd800 && code <= 0xdfff) return undefined;
  return String.fromCodePoint(code);
}

/** Decodes the predefined entities and numeric references; leaves anything else as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(
    /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,4});/g,
    (all, ref: string) => {
      if (ref.startsWith('#x'))
        return fromCodePoint(Number.parseInt(ref.slice(2), 16)) ?? all;
      if (ref.startsWith('#'))
        return fromCodePoint(Number.parseInt(ref.slice(1), 10)) ?? all;
      return PREDEFINED[ref] ?? all;
    }
  );
}

function hostile(reason: string): ExtractError {
  return new ExtractError(
    'hostile_xml',
    `The file's XML ${reason}, so it is not read.`
  );
}

/**
 * Measures the deepest element nesting with one pass, skipping comments,
 * CDATA, processing instructions and quoted attribute values. Refuses a
 * DOCTYPE, anything nested deeper than `maxDepth`, and more than
 * `maxElements` elements.
 */
export function checkXml(
  text: string,
  maxDepth: number,
  maxElements: number = LIMITS.xmlElements
): number {
  let depth = 0;
  let deepest = 0;
  let count = 0;
  let i = text.indexOf('<');
  while (i !== -1 && i < text.length) {
    const next = text[i + 1];
    if (next === '!') {
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        if (end === -1) break;
        i = text.indexOf('<', end + 3);
        continue;
      }
      if (text.startsWith('<![CDATA[', i)) {
        const end = text.indexOf(']]>', i + 9);
        if (end === -1) break;
        i = text.indexOf('<', end + 3);
        continue;
      }
      throw hostile('declares a DOCTYPE or entities');
    }
    if (next === '?') {
      const end = text.indexOf('?>', i + 2);
      if (end === -1) break;
      i = text.indexOf('<', end + 2);
      continue;
    }
    // A tag: find its end outside quoted attribute values.
    let j = i + 1;
    let quote = '';
    while (j < text.length) {
      const ch = text[j];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j++;
    }
    if (j >= text.length) break;
    if (next === '/') {
      depth = Math.max(0, depth - 1);
    } else {
      count++;
      if (count > maxElements) {
        throw new ExtractError(
          'too_large',
          `The file has more than ${maxElements.toLocaleString('en-GB')} XML elements in one part, too many to read safely. Save it as a PDF and send that instead.`
        );
      }
      if (text[j - 1] !== '/') {
        depth++;
        if (depth > deepest) deepest = depth;
        if (depth > maxDepth)
          throw hostile(`is nested more than ${maxDepth} levels deep`);
      }
    }
    i = text.indexOf('<', j + 1);
  }
  return deepest;
}

const TEXT = '#text';
const CDATA = '#cdata';
const ATTRS = ':@';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toChildren(items: unknown): XChild[] {
  const out: XChild[] = [];
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (!isRecord(item)) continue;
    for (const [key, value] of Object.entries(item)) {
      if (key === ATTRS) continue;
      if (key === TEXT) {
        if (typeof value === 'string') out.push(decodeEntities(value));
        else if (typeof value === 'number' || typeof value === 'boolean')
          out.push(String(value));
        continue;
      }
      if (key === CDATA) {
        // CDATA is kept as written: no entity is decoded inside it.
        if (Array.isArray(value)) {
          for (const part of value) {
            if (isRecord(part) && typeof part[TEXT] === 'string')
              out.push(part[TEXT]);
          }
        }
        continue;
      }
      const attrs: Record<string, string> = {};
      const rawAttrs = item[ATTRS];
      if (isRecord(rawAttrs)) {
        for (const [name, v] of Object.entries(rawAttrs)) {
          if (typeof v === 'string') attrs[name] = decodeEntities(v);
          else if (typeof v === 'number' || typeof v === 'boolean')
            attrs[name] = String(v);
        }
      }
      out.push({ name: key, attrs, children: toChildren(value) });
    }
  }
  return out;
}

/** Parses one XML document and returns its root element. */
export function parseXml(
  text: string,
  maxDepth: number,
  maxElements: number = LIMITS.xmlElements
): XNode {
  checkXml(text, maxDepth, maxElements);
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    processEntities: false,
    htmlEntities: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    cdataPropName: CDATA,
    commentPropName: false,
    allowBooleanAttributes: false,
    maxNestedTags: maxDepth + 1,
  });
  let parsed: unknown;
  try {
    parsed = parser.parse(text);
  } catch (error) {
    throw new ExtractError(
      'damaged',
      `The file's XML does not parse (${errorText(error)}).`
    );
  }
  const root = toChildren(parsed).find(
    (c): c is XNode => typeof c !== 'string'
  );
  if (!root)
    throw new ExtractError('damaged', 'The file holds an empty XML part.');
  return root;
}

/** The local part of a qualified name ("w:p" → "p"). */
export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

export function elements(node: XNode): XNode[] {
  return node.children.filter((c): c is XNode => typeof c !== 'string');
}

export function child(node: XNode, name: string): XNode | undefined {
  return elements(node).find((c) => c.name === name);
}

/** All text directly or indirectly inside, in document order. */
export function textOf(node: XNode): string {
  let out = '';
  const stack: XChild[] = [...node.children].reverse();
  for (let c = stack.pop(); c !== undefined; c = stack.pop()) {
    if (typeof c === 'string') out += c;
    else stack.push(...[...c.children].reverse());
  }
  return out;
}

/** An attribute by its qualified name or, failing that, its local name. */
export function attr(node: XNode, name: string): string | undefined {
  const direct = node.attrs[name];
  if (direct !== undefined) return direct;
  const local = localName(name);
  for (const [key, value] of Object.entries(node.attrs)) {
    if (localName(key) === local) return value;
  }
  return undefined;
}
