// Builds small source files for the text tests: Word and Excel packages,
// hand-written PDFs, image headers and raw zip archives. Every name, company
// and address is a placeholder (Acme Productions, Example Hotel, example.com,
// ZZ1 1ZZ).

import { deflateSync, strToU8, zipSync } from 'fflate';
import { crc32 } from '../../src/text/zip';

export const W_NS =
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const S_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';

export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A paragraph of plain runs. */
export function p(...runs: string[]): string {
  return `<w:p>${runs.map((t) => `<w:r><w:t xml:space="preserve">${xmlEscape(t)}</w:t></w:r>`).join('')}</w:p>`;
}

/** A table of rows of cell texts; `header` marks the first row as a repeat header row. */
export function tbl(rows: string[][], header = false): string {
  const body = rows
    .map((cells, i) => {
      const trPr = header && i === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
      return `<w:tr>${trPr}${cells.map((c) => `<w:tc>${c === '' ? '<w:p/>' : p(c)}</w:tc>`).join('')}</w:tr>`;
    })
    .join('');
  return `<w:tbl><w:tblPr/>${body}</w:tbl>`;
}

export interface DocxParts {
  readonly styles?: string;
  readonly header?: string;
  readonly footer?: string;
  readonly extra?: Record<string, string>;
}

/** A .docx package whose body is `body` (w:body children). */
export function docx(body: string, parts: DocxParts = {}): Uint8Array {
  const rels: string[] = [];
  const overrides = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
  ];
  const files: Record<string, Uint8Array> = {};
  if (parts.styles) {
    files['word/styles.xml'] = strToU8(
      `<?xml version="1.0"?><w:styles xmlns:w="${W_NS}">${parts.styles}</w:styles>`
    );
    rels.push(
      `<Relationship Id="rIdS" Type="${R_NS}/styles" Target="styles.xml"/>`
    );
  }
  if (parts.header) {
    files['word/header1.xml'] = strToU8(
      `<?xml version="1.0"?><w:hdr xmlns:w="${W_NS}">${parts.header}</w:hdr>`
    );
    rels.push(
      `<Relationship Id="rIdH" Type="${R_NS}/header" Target="header1.xml"/>`
    );
  }
  if (parts.footer) {
    files['word/footer1.xml'] = strToU8(
      `<?xml version="1.0"?><w:ftr xmlns:w="${W_NS}">${parts.footer}</w:ftr>`
    );
    rels.push(
      `<Relationship Id="rIdF" Type="${R_NS}/footer" Target="footer1.xml"/>`
    );
  }
  for (const [name, text] of Object.entries(parts.extra ?? {}))
    files[name] = strToU8(text);
  files['[Content_Types].xml'] = strToU8(
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>${overrides.join('')}</Types>`
  );
  files['_rels/.rels'] = strToU8(
    `<?xml version="1.0"?><Relationships xmlns="${PKG_RELS}"><Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  files['word/_rels/document.xml.rels'] = strToU8(
    `<?xml version="1.0"?><Relationships xmlns="${PKG_RELS}">${rels.join('')}</Relationships>`
  );
  files['word/document.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>${body}<w:sectPr/></w:body></w:document>`
  );
  return zipSync(files);
}

export interface Sheet {
  readonly name: string;
  /** sheetData children (row elements). */
  readonly rows: string;
  readonly state?: 'hidden' | 'veryHidden';
  /** Elements before sheetData (cols). */
  readonly before?: string;
  /** Elements after sheetData (mergeCells). */
  readonly after?: string;
}

export interface XlsxParts {
  readonly strings?: readonly string[];
  /** numFmt elements and cellXfs xf elements. */
  readonly numFmts?: string;
  readonly cellXfs?: string;
  readonly date1904?: boolean;
}

/** An .xlsx package with the given sheets. */
export function xlsx(
  sheets: readonly Sheet[],
  parts: XlsxParts = {}
): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const overrides = [
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
  ];
  const rels: string[] = [];
  const sheetEls: string[] = [];
  sheets.forEach((s, i) => {
    const n = i + 1;
    files[`xl/worksheets/sheet${n}.xml`] = strToU8(
      `<?xml version="1.0"?><worksheet xmlns="${S_NS}" xmlns:r="${R_NS}">${s.before ?? ''}<sheetData>${s.rows}</sheetData>${s.after ?? ''}</worksheet>`
    );
    rels.push(
      `<Relationship Id="rId${n}" Type="${R_NS}/worksheet" Target="worksheets/sheet${n}.xml"/>`
    );
    sheetEls.push(
      `<sheet name="${xmlEscape(s.name)}" sheetId="${n}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${n}"/>`
    );
  });
  if (parts.strings) {
    files['xl/sharedStrings.xml'] = strToU8(
      `<?xml version="1.0"?><sst xmlns="${S_NS}">${parts.strings.map((t) => `<si><t xml:space="preserve">${xmlEscape(t)}</t></si>`).join('')}</sst>`
    );
    rels.push(
      `<Relationship Id="rIdSS" Type="${R_NS}/sharedStrings" Target="sharedStrings.xml"/>`
    );
  }
  files['xl/styles.xml'] = strToU8(
    `<?xml version="1.0"?><styleSheet xmlns="${S_NS}">${parts.numFmts ? `<numFmts>${parts.numFmts}</numFmts>` : ''}<cellXfs>${parts.cellXfs ?? '<xf numFmtId="0"/>'}</cellXfs></styleSheet>`
  );
  rels.push(
    `<Relationship Id="rIdST" Type="${R_NS}/styles" Target="styles.xml"/>`
  );
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0"?><workbook xmlns="${S_NS}" xmlns:r="${R_NS}">${parts.date1904 ? '<workbookPr date1904="1"/>' : '<workbookPr/>'}<sheets>${sheetEls.join('')}</sheets></workbook>`
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0"?><Relationships xmlns="${PKG_RELS}">${rels.join('')}</Relationships>`
  );
  files['_rels/.rels'] = strToU8(
    `<?xml version="1.0"?><Relationships xmlns="${PKG_RELS}"><Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  );
  files['[Content_Types].xml'] = strToU8(
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${overrides.join('')}</Types>`
  );
  return zipSync(files);
}

/** A row of cells: strings are inline strings, numbers are numbers (with an optional style). */
export function row(
  r: number,
  cells: readonly (string | number | { v: number; s: number } | undefined)[],
  attrs = ''
): string {
  const out = cells.map((c, i) => {
    const ref = `${String.fromCharCode(65 + i)}${r}`;
    if (c === undefined) return '';
    if (typeof c === 'string')
      return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(c)}</t></is></c>`;
    if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
    return `<c r="${ref}" s="${c.s}"><v>${c.v}</v></c>`;
  });
  return `<row r="${r}"${attrs}>${out.join('')}</row>`;
}

export interface RawEntry {
  readonly name: string;
  /** The stored bytes: deflated when `method` is 8. */
  readonly data: Uint8Array;
  readonly method: number;
  /** The uncompressed size the archive declares. */
  readonly size: number;
  readonly crc: number;
  readonly flags?: number;
}

/** A zip archive written field by field, so a test can make it declare anything. */
export function rawZip(entries: readonly RawEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = strToU8(e.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, e.flags ?? 0, true);
    lv.setUint16(8, e.method, true);
    lv.setUint32(14, e.crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, e.flags ?? 0, true);
    cv.setUint16(10, e.method, true);
    cv.setUint32(16, e.crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(local, e.data);
    central.push(cd);
    offset += local.length + e.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return concat([...parts, ...central, end]);
}

/** A deflated entry with its true size and checksum. */
export function deflated(name: string, data: Uint8Array): RawEntry {
  return {
    name,
    data: deflateSync(data),
    method: 8,
    size: data.length,
    crc: crc32(data),
  };
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A PDF string literal, escaped. */
export function pdfString(text: string): string {
  return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/** A content stream that writes each line at its position in Helvetica 12 pt. */
export function textOps(
  lines: readonly { x: number; y: number; text: string }[],
  mode = 0
): string {
  return lines
    .map(
      (l) =>
        `BT ${mode} Tr /F1 12 Tf ${l.x} ${l.y} Td ${pdfString(l.text)} Tj ET`
    )
    .join('\n');
}

export interface PdfPage {
  readonly content: string;
  readonly rotate?: number;
}

/** A PDF of pages with the given content streams, A4, Helvetica as /F1. */
export function pdf(pages: readonly (string | PdfPage)[]): Uint8Array {
  const objects: string[] = [];
  const kids: number[] = [];
  let n = 4;
  const pageObjects: string[] = [];
  for (const page of pages) {
    const { content, rotate } =
      typeof page === 'string' ? { content: page, rotate: undefined } : page;
    const pageNo = n++;
    const contentNo = n++;
    kids.push(pageNo);
    pageObjects.push(
      `${pageNo} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]${rotate ? ` /Rotate ${rotate}` : ''} /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNo} 0 R >>\nendobj\n`
    );
    pageObjects.push(
      `${contentNo} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`
    );
  }
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>\nendobj\n`
  );
  objects.push(
    '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n'
  );
  objects.push(...pageObjects);
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const o of objects) {
    offsets.push(out.length);
    out += o;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets
    .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
    .join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(out, true);
}

/** A PNG signature and IHDR chunk for an image of the given size. */
export function png(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(25);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, 13);
  ihdr.set(strToU8('IHDR'), 4);
  v.setUint32(8, width);
  v.setUint32(12, height);
  ihdr[16] = 8;
  ihdr[17] = 2;
  v.setUint32(21, crc32(ihdr.subarray(4, 21)));
  const iend = new Uint8Array([
    0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
    iend,
  ]);
}

/** A JPEG start with a baseline frame header for the given size. */
export function jpeg(width: number, height: number): Uint8Array {
  const sof = [
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ];
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    ...strToU8('JFIF\0'),
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    ...sof,
    0xff,
    0xd9,
  ]);
}

/** A GIF header for the given size. */
export function gif(width: number, height: number): Uint8Array {
  return new Uint8Array([
    ...strToU8('GIF89a'),
    width & 0xff,
    width >> 8,
    height & 0xff,
    height >> 8,
    0,
    0,
    0,
    0x3b,
  ]);
}

/** An ISO media file whose ftyp names `brand` (heic for an iPhone photo). */
export function ftyp(brand: string): Uint8Array {
  return new Uint8Array([
    0,
    0,
    0,
    0x18,
    ...strToU8('ftyp'),
    ...strToU8(brand),
    0,
    0,
    0,
    0,
    ...strToU8('mif1heic'),
  ]);
}

/** A raw RFC 5322 message with CRLF line ends. */
export function mime(lines: readonly string[]): Uint8Array {
  return strToU8(lines.join('\r\n'));
}
