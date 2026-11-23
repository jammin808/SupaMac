// An independent review of the text unit (src/text) against
// docs/supamac/jobs.md §2 and its Security section ("Hostile files"), written
// without trusting the unit's own tests.
//
// A test pins behaviour the review found sound or a defect the review
// reported, now fixed: its assertions are the required behaviour.
//
// Every name, company and address is a placeholder (Acme Productions, Example
// Hotel, example.com, ZZ1 1ZZ).

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8 } from 'fflate';
import { checkDetail, indexSource } from '../../src/checks';
import { extract } from '../../src/text/extract';
import { writtenDate } from '../../src/text/history';
import { htmlLines } from '../../src/text/html';
import {
  emailDocument,
  escapeLine,
  textDocument,
} from '../../src/text/markdown';
import { extractInSandbox } from '../../src/text/sandbox';
import {
  type EmailInfo,
  type ExtractOutcome,
  type Extracted,
  LIMITS,
  REFUSAL_STATUS,
  type RefusalKind,
} from '../../src/text/types';
import { formatNumber } from '../../src/text/xlsx';
import { candidate } from '../fixtures';
import {
  concat,
  deflated,
  docx,
  ftyp,
  jpeg,
  mime,
  p,
  pdfString,
  png,
  type RawEntry,
  rawZip,
  row,
  S_NS,
  xlsx,
} from './build';

// ---------------------------------------------------------------------------
// Helpers

function ok(outcome: ExtractOutcome): Extracted {
  if (!outcome.ok)
    throw new Error(
      `refused: ${outcome.refusal.kind}: ${outcome.refusal.reason}`
    );
  return outcome.value;
}

function refusal(outcome: ExtractOutcome): RefusalKind {
  if (outcome.ok) throw new Error('expected a refusal');
  return outcome.refusal.kind;
}

const allLines = (e: Extracted): string[] =>
  e.text.pages.flatMap((pg) => [...pg.lines]);

const R_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** One local entry of a hand-made archive. */
interface Local {
  readonly entry: RawEntry;
  /** More central-directory names pointing at this same local entry. */
  readonly aliases?: readonly string[];
}

/**
 * A zip archive whose central directory may point several names at one local
 * entry (overlapping entries), so a file can make the reader inflate the same
 * bytes many times.
 */
function overlappingZip(locals: readonly Local[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let count = 0;
  for (const { entry, aliases = [] } of locals) {
    const name = strToU8(entry.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, entry.method, true);
    lv.setUint32(14, entry.crc, true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    for (const centralName of [entry.name, ...aliases]) {
      const n = strToU8(centralName);
      const cd = new Uint8Array(46 + n.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(10, entry.method, true);
      cv.setUint32(16, entry.crc, true);
      cv.setUint32(20, entry.data.length, true);
      cv.setUint32(24, entry.size, true);
      cv.setUint16(28, n.length, true);
      cv.setUint32(42, offset, true);
      cd.set(n, 46);
      central.push(cd);
      count++;
    }
    parts.push(local, entry.data);
    offset += local.length + entry.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return concat([...parts, ...central, end]);
}

/** The parts of an .xlsx workbook with `sheets` sheets, without the sheet parts. */
function workbookParts(sheets: number): RawEntry[] {
  const sheetEls = Array.from(
    { length: sheets },
    (_, i) =>
      `<sheet name="Leg ${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
  ).join('');
  const rels = Array.from(
    { length: sheets },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="${R_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  ).join('');
  const text: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    '_rels/.rels': `<?xml version="1.0"?><Relationships xmlns="${PKG_RELS}"><Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${S_NS}" xmlns:r="${R_NS}"><sheets>${sheetEls}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="${PKG_RELS}">${rels}</Relationships>`,
  };
  return Object.entries(text).map(([name, t]) => deflated(name, strToU8(t)));
}

/** A one-page PDF with its own resources and catalog entries; objects from 6 on are `extra`. */
function customPdf(
  content: string,
  resources: string,
  catalog = '',
  extra: readonly string[] = []
): Uint8Array {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`,
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources ${resources} /Contents 5 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...extra,
  ];
  let out = '%PDF-1.5\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets
    .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
    .join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(out, true);
}

/** One line of Helvetica 12 pt at (x, y), with operators before it inside BT. */
const line = (x: number, y: number, text: string, before = ''): string =>
  `BT ${before} /F1 12 Tf ${x} ${y} Td ${pdfString(text)} Tj ET`;

/** Two visible lines, enough that a page is never a scan for having little text. */
const PACK = [
  line(50, 800, 'Production pack for Acme Productions at Acme Arena'),
  line(50, 780, 'Please report to the production office on arrival'),
];

const RESOURCES =
  '<< /Font << /F1 3 0 R >> /ExtGState << /G0 7 0 R >> /Properties << /oc1 6 0 R >> >>';
const EXTRA = [
  '<< /Type /OCG /Name (Draft rates) >>',
  '<< /Type /ExtGState /ca 0 /CA 0 >>',
];
const OC_OFF =
  '/OCProperties << /OCGs [6 0 R] /D << /OFF [6 0 R] /Order [6 0 R] >> >>';

const HEADER = [
  'From: Sam Price <sam@example.com>',
  'To: jobs@example.com',
  'Message-ID: <review-1@example.com>',
  'MIME-Version: 1.0',
];

/** A one-part email with the given subject, Date header, body type and body lines. */
function email(
  subject: string,
  body: readonly string[],
  type = 'text/plain',
  date = 'Fri, 03 Apr 2026 10:30:00 +0100'
): Uint8Array {
  return mime([
    ...HEADER,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Content-Type: ${type}; charset=utf-8`,
    '',
    ...body,
  ]);
}

const EMPTY_INFO: EmailInfo = {
  subject: 'Call sheet',
  from: 'sam@example.com',
  to: [],
  cc: [],
  references: [],
  threadIds: [],
  attachments: [],
};

/**
 * What SupaMac's Markdown import (Lexical 0.45, which packages/lexical-core
 * pins) does to a run of text: a backslash before ASCII punctuation is
 * dropped and a decimal character reference is decoded. Named entities such
 * as &amp; are left as written.
 */
function lexicalText(md: string): string {
  return md
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/&#(\d+);/g, (_all, n: string) => String.fromCodePoint(Number(n)));
}

/** The fenced blocks of a Markdown text, and whether every fence closes. */
function fences(doc: string): { bodies: string[][]; closed: boolean } {
  const lines = doc.split('\n');
  const bodies: string[][] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^(`{3,})text$/.exec(lines[i] ?? '');
    if (!open) {
      i++;
      continue;
    }
    const fence = open[1] as string;
    const body: string[] = [];
    i++;
    // CommonMark closes a backtick fence on a line of at least as many backticks.
    while (
      i < lines.length &&
      !new RegExp(`^ {0,3}\`{${fence.length},}\\s*$`).test(lines[i] ?? '')
    ) {
      body.push(lines[i] ?? '');
      i++;
    }
    if (lines[i] !== fence) return { bodies, closed: false };
    bodies.push(body);
    i++;
  }
  return { bodies, closed: true };
}

const scratch = mkdtempSync(join(tmpdir(), 'jobs-review-u2-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A child script for the sandbox, written for this run only. */
function childScript(name: string, source: string): string {
  const path = join(scratch, `${name}.ts`);
  writeFileSync(path, source);
  return path;
}

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url));

// ---------------------------------------------------------------------------
// Hostile zips

describe('hostile zips', () => {
  test('a Word bomb in a later part (the footer) is stopped by the one budget for the archive', async () => {
    const files = docx(p('Venue: Acme Arena'), {
      footer: p('Footer'),
    });
    // Replace the footer with 60 MB of spaces inside one run.
    const bomb = strToU8(
      `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>${' '.repeat(60_000_000)}</w:t></w:r></w:p></w:ftr>`
    );
    const { unzipSync } = await import('fflate');
    const entries = Object.entries(unzipSync(files)).map(([name, data]) =>
      name === 'word/footer1.xml' ? deflated(name, bomb) : deflated(name, data)
    );
    const outcome = await extract(rawZip(entries), { name: 'pack.docx' });
    expect(refusal(outcome)).toBe('zip_unpacked');
    expect(REFUSAL_STATUS.zip_unpacked).toBe('Skipped');
  });

  test('overlapping entries (many names, one set of bytes) cannot multiply the cap', async () => {
    const sheet = strToU8(
      `<?xml version="1.0"?><worksheet xmlns="${S_NS}"><sheetData/><!--${' '.repeat(12_000_000)}--></worksheet>`
    );
    const sheet1 = deflated('xl/worksheets/sheet1.xml', sheet);
    const aliases = Array.from(
      { length: 7 },
      (_, i) => `xl/worksheets/sheet${i + 2}.xml`
    );
    const bytes = overlappingZip([
      ...workbookParts(8).map((entry) => ({ entry })),
      { entry: sheet1, aliases },
    ]);
    expect(bytes.length).toBeLessThan(200_000);
    expect(refusal(await extract(bytes, { name: 'tour.xlsx' }))).toBe(
      'zip_unpacked'
    );
  });

  test('an archive whose end record under-declares its entries is refused on the entries it holds', async () => {
    const entries = Array.from({ length: 600 }, (_, i) =>
      deflated(`word/media/logo${i}.xml`, strToU8('<x/>'))
    );
    const bytes = rawZip(entries);
    const end = bytes.length - 22;
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    view.setUint16(end + 8, 3, true);
    view.setUint16(end + 10, 3, true);
    expect(refusal(await extract(bytes, { name: 'pack.docx' }))).toBe(
      'zip_entries'
    );
  });

  test('501 entries are refused and 500 are read', async () => {
    const base = docx(p('Crew call 07:00'));
    const { unzipSync } = await import('fflate');
    const parts = Object.entries(unzipSync(base)).map(([n, d]) =>
      deflated(n, d)
    );
    const pad = (k: number): RawEntry[] =>
      Array.from({ length: k }, (_, i) =>
        deflated(`customXml/item${i}.xml`, strToU8('<x/>'))
      );
    const at500 = rawZip([...parts, ...pad(500 - parts.length)]);
    const at501 = rawZip([...parts, ...pad(501 - parts.length)]);
    expect(allLines(ok(await extract(at500, { name: 'a.docx' })))).toEqual([
      'Crew call 07:00',
    ]);
    expect(refusal(await extract(at501, { name: 'a.docx' }))).toBe(
      'zip_entries'
    );
  });

  test('path traversal names are never resolved outside the archive, and an absolute or ../ target reads only the real part', async () => {
    const { unzipSync } = await import('fflate');
    const files = unzipSync(docx(p('Venue: Acme Arena')));
    files['../../../../tmp/evil.xml'] = strToU8('<x/>');
    files['/etc/passwd'] = strToU8('root:x:0:0');
    files['C:\\Windows\\win.ini'] = strToU8('[fonts]');
    files['_rels/.rels'] = strToU8(
      new TextDecoder()
        .decode(files['_rels/.rels'])
        .replace(
          'Target="word/document.xml"',
          'Target="../../../../word/document.xml"'
        )
    );
    const entries = Object.entries(files).map(([n, d]) => deflated(n, d));
    expect(
      allLines(ok(await extract(rawZip(entries), { name: 'a.docx' })))
    ).toEqual(['Venue: Acme Arena']);
  });

  test('two entries whose names differ only in case are refused, so no reader sees a different part', async () => {
    const { unzipSync } = await import('fflate');
    const files = unzipSync(docx(p('Crew call 07:00')));
    const entries = Object.entries(files).map(([n, d]) => deflated(n, d));
    entries.push(deflated('WORD/DOCUMENT.XML', strToU8('<w:document/>')));
    expect(refusal(await extract(rawZip(entries), { name: 'a.docx' }))).toBe(
      'damaged'
    );
  });

  test('a shared-strings bomb under both zip caps is a deterministic refusal (Skipped), not a Failed source whose Retry cannot help', async () => {
    const { unzipSync, zipSync } = await import('fflate');
    const files = unzipSync(
      xlsx([{ name: 'Crew', rows: row(1, ['Role', 'Rate', 'City']) }], {
        strings: ['x'],
      })
    );
    // 45 MB of one-letter shared strings: under the 50 MB cap, 113 KB zipped.
    files['xl/sharedStrings.xml'] = strToU8(
      `<?xml version="1.0"?><sst xmlns="${S_NS}">${'<si><t>a</t></si>'.repeat(2_700_000)}</sst>`
    );
    const bytes = zipSync(files, { level: 9 });
    expect(bytes.length).toBeLessThan(200_000);
    const outcome = await extractInSandbox(bytes, { name: 'crew.xlsx' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Not "memory" (Failed): parsing millions of tiny elements would exhaust the child.
    expect(REFUSAL_STATUS[outcome.refusal.kind]).toBe('Skipped');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// XML entities and DTDs

describe('XML entities and DTDs', () => {
  async function withPart(
    bytes: Uint8Array,
    name: string,
    edit: (xml: string) => string
  ): Promise<ExtractOutcome> {
    const { unzipSync, zipSync } = await import('fflate');
    const files = unzipSync(bytes);
    const current = files[name];
    if (!current) throw new Error(`no ${name}`);
    files[name] = strToU8(edit(new TextDecoder().decode(current)));
    return extract(zipSync(files), { name: 'x' });
  }

  const LAUGHS =
    '<!DOCTYPE r [<!ENTITY a "lol"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;">]>';

  test('a DOCTYPE in any part a reader opens is refused before parsing', async () => {
    const sheet = xlsx(
      [{ name: 'Crew', rows: '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' }],
      { strings: ['Crew call 07:00'] }
    );
    const word = docx(p('Crew call 07:00'), { styles: '<w:docDefaults/>' });
    const cases: [Uint8Array, string][] = [
      [sheet, 'xl/sharedStrings.xml'],
      [sheet, 'xl/workbook.xml'],
      [sheet, 'xl/worksheets/sheet1.xml'],
      [sheet, 'xl/styles.xml'],
      [sheet, '[Content_Types].xml'],
      [word, '_rels/.rels'],
      [word, 'word/_rels/document.xml.rels'],
      [word, 'word/styles.xml'],
    ];
    for (const [bytes, part] of cases) {
      const outcome = await withPart(bytes, part, (xml) =>
        xml.replace('<?xml version="1.0"?>', `<?xml version="1.0"?>${LAUGHS}`)
      );
      expect([part, refusal(outcome)]).toEqual([part, 'hostile_xml']);
    }
  });

  test('a SYSTEM DOCTYPE after a comment, and one after CDATA, are refused too', async () => {
    const word = docx(p('Crew call 07:00'));
    for (const prefix of [
      '<!-- note --><!DOCTYPE w:document SYSTEM "http://evil.example.com/x.dtd">',
      '<![CDATA[x]]><!DOCTYPE w:document [<!ENTITY e "INJECTED">]>',
    ]) {
      const outcome = await withPart(word, 'word/document.xml', (xml) =>
        xml.replace('<w:document', `${prefix}<w:document`)
      );
      expect(refusal(outcome)).toBe('hostile_xml');
    }
  });

  test('an undeclared entity stays as written and a reference is decoded once only', async () => {
    const word = docx(p('Crew call 07:00'));
    const outcome = await withPart(word, 'word/document.xml', (xml) =>
      xml.replace('Crew call 07:00', '&xxe; &#x26;lt; &amp;amp; &#38;#60;')
    );
    expect(allLines(ok(outcome))).toEqual(['&xxe; &lt; &amp; &#60;']);
  });
});

// ---------------------------------------------------------------------------
// PDF

describe('PDF', () => {
  test('invisible text (render mode 3) makes the page a scan with no lines', async () => {
    const bytes = customPdf(
      [...PACK, line(50, 700, 'Hotel: Example Hotel', '3 Tr')].join('\n'),
      RESOURCES,
      '',
      EXTRA
    );
    const e = ok(await extract(bytes, { name: 'pack.pdf' }));
    expect(e.text.pages).toEqual([{ page: 1, kind: 'scan', lines: [] }]);
  });

  test('text scaled below one point makes the page a scan', async () => {
    const bytes = customPdf(
      [
        ...PACK,
        `q 0.01 0 0 0.01 50 700 cm ${line(0, 0, 'Hotel: Example Hotel')} Q`,
      ].join('\n'),
      RESOURCES,
      '',
      EXTRA
    );
    expect(
      ok(await extract(bytes, { name: 'pack.pdf' })).text.pages[0]?.kind
    ).toBe('scan');
  });

  test('text in two columns is read column by column, never joined across the gutter', async () => {
    const bytes = customPdf(
      [
        ...PACK,
        line(50, 700, 'Venue: Acme Arena'),
        line(320, 700, 'Hotel: Example Hotel'),
        line(50, 680, 'Load-in: 06:00'),
        line(320, 680, 'Check-in: TBC'),
      ].join('\n'),
      RESOURCES,
      '',
      EXTRA
    );
    const lines = allLines(ok(await extract(bytes, { name: 'pack.pdf' })));
    // Never "Venue: Acme Arena Hotel: Example Hotel" or
    // "Load-in: 06:00 Check-in: TBC" (a hedge from the other column).
    expect(lines).toContain('Venue: Acme Arena');
    expect(lines).toContain('Hotel: Example Hotel');
    expect(lines).toContain('Load-in: 06:00');
    expect(lines.some((l) => l.includes('06:00') && l.includes('TBC'))).toBe(
      false
    );
  });

  const invisible: [string, string, string][] = [
    [
      'text painted fully transparent (fill alpha 0)',
      line(50, 700, 'Hotel: Fake Inn', '/G0 gs'),
      '',
    ],
    [
      'text clipped away to a one-point box',
      `q 0 0 1 1 re W n ${line(50, 700, 'Hotel: Fake Inn')} Q`,
      '',
    ],
    [
      'text in an optional-content layer that is off',
      `/OC /oc1 BDC ${line(50, 700, 'Hotel: Fake Inn')} EMC`,
      OC_OFF,
    ],
  ];
  for (const [what, op, catalog] of invisible) {
    test(`${what} is not read as text the page shows`, async () => {
      const bytes = customPdf(
        [...PACK, op].join('\n'),
        RESOURCES,
        catalog,
        EXTRA
      );
      const e = ok(await extract(bytes, { name: 'pack.pdf' }));
      // The page never holds "Hotel: Fake Inn" as text it shows.
      expect(allLines(e)).not.toContain('Hotel: Fake Inn');
    });
  }
});

// ---------------------------------------------------------------------------
// Word

describe('Word', () => {
  test('hidden runs and deleted or moved-away tracked changes are dropped; insertions kept', async () => {
    const body = [
      '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>Rate: 900</w:t></w:r><w:r><w:t>Rate: 350</w:t></w:r></w:p>',
      '<w:p><w:del w:id="1" w:author="A"><w:r><w:delText>Hotel: Old Inn</w:delText></w:r></w:del><w:ins w:id="2" w:author="A"><w:r><w:t>Hotel: Example Hotel</w:t></w:r></w:ins></w:p>',
      '<w:p><w:del w:id="3" w:author="A"><w:r><w:t>Call 09:00</w:t></w:r></w:del></w:p>',
      '<w:moveFrom w:id="4" w:author="A"><w:p><w:r><w:t>Moved away</w:t></w:r></w:p></w:moveFrom>',
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>HYPERLINK "https://evil.example.com"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Booking link</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
    ].join('');
    expect(
      allLines(ok(await extract(docx(body), { name: 'pack.docx' })))
    ).toEqual(['Rate: 350', 'Hotel: Example Hotel', 'Booking link']);
  });

  test('a paragraph with no style of its own is hidden when the default paragraph style is hidden', async () => {
    const styles =
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:rPr><w:vanish/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/></w:style>';
    const body =
      '<w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr><w:r><w:t>Venue: Acme Arena</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Hotel: Fake Inn</w:t></w:r></w:p>';
    const lines = allLines(
      ok(await extract(docx(body, { styles }), { name: 'pack.docx' }))
    );
    // Word shows only the first paragraph; today both are read.
    expect(lines).toEqual(['Venue: Acme Arena']);
  });
});

// ---------------------------------------------------------------------------
// Excel

describe('Excel', () => {
  test('hidden and very hidden sheets, hidden rows and hidden columns are dropped', async () => {
    const bytes = xlsx([
      { name: 'Secret', state: 'veryHidden', rows: row(1, ['Rate: 900']) },
      {
        name: 'Crew',
        before: '<cols><col min="2" max="2" hidden="true"/></cols>',
        rows:
          row(1, ['Role', 'Private', 'Rate', 'City']) +
          row(2, ['Rigger', 'x', '£350', 'Leeds'], ' hidden="1"') +
          row(3, ['Driver', 'y', '£300', 'York']),
      },
    ]);
    expect(allLines(ok(await extract(bytes, { name: 'crew.xlsx' })))).toEqual([
      'Crew',
      'Role: Driver',
      'Driver · Rate: £300',
      'Driver · City: York',
    ]);
  });

  test('a currency comes only from the format, never from the locale', () => {
    expect(formatNumber(350, '[$£-809]#,##0.00')).toBe('£350.00');
    expect(formatNumber(350, '#,##0.00')).toBe('350.00');
    expect(formatNumber(350, '_-* #,##0.00_-')).toBe('350.00');
  });

  test('a value under the ";;;" format, which Excel shows as nothing, is not read', async () => {
    const bytes = xlsx(
      [
        {
          name: 'Crew',
          rows:
            row(1, ['Role', 'Rate', 'Notes']) +
            row(2, ['Rigger', { v: 900, s: 1 }, 'ok']),
        },
      ],
      {
        numFmts: '<numFmt numFmtId="164" formatCode=";;;"/>',
        cellXfs: '<xf numFmtId="0"/><xf numFmtId="164"/>',
      }
    );
    const lines = allLines(ok(await extract(bytes, { name: 'crew.xlsx' })));
    expect(lines.some((l) => l.includes('900'))).toBe(false);
  });

  test('words a number format writes ("/day", "+ VAT", "approx.") stay with the number', () => {
    expect(formatNumber(350, '"£"#,##0"/day"')).toBe('£350/day');
    expect(formatNumber(350, '#,##0.00" + VAT"')).toBe('350.00 + VAT');
    expect(formatNumber(350, '"approx. "0')).toBe('approx. 350');
  });

  test('a date format that shows no year or no day does not gain one from the serial', () => {
    // 46115 is Friday 3 April 2026.
    expect(formatNumber(46115, 'd-mmm')).not.toContain('2026');
    expect(formatNumber(46115, 'dd/mm')).not.toContain('2026');
    expect(formatNumber(46115, 'mmm-yy')).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatNumber(46115, 'mmmm yyyy')).not.toMatch(/-03$/);
  });
});

// ---------------------------------------------------------------------------
// Email: bodies, hidden HTML, history and forwards

describe('email bodies', () => {
  test('the HTML part is read when HTML and plain parts disagree', async () => {
    const bytes = mime([
      ...HEADER,
      'Subject: Call sheet',
      'Date: Fri, 03 Apr 2026 10:30:00 +0100',
      'Content-Type: multipart/alternative; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Crew call 08:00',
      '--b',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Crew call 07:00</p>',
      '--b--',
      '',
    ]);
    expect(allLines(ok(await extract(bytes, { name: 'm.eml' })))).toEqual([
      'Crew call 07:00',
    ]);
  });

  test('elements hidden by display, visibility, mso-hide or the hidden attribute are dropped, in tables too', () => {
    const html = [
      '<p>Crew call 07:00</p>',
      '<div style="display: none !important">Hotel: Fake Inn</div>',
      '<p style="DISPLAY:NONE">Rate: 900</p>',
      '<span style="visibility:hidden">Rate: 901</span>',
      '<div style="mso-hide: all">Rate: 902</div>',
      '<div hidden>Rate: 903</div>',
      '<table><tr><td style="display:none">Rate: 904</td><td>Venue</td><td>Acme Arena</td></tr></table>',
      '<p>Value<span style="display:none;">X</span>Y</p>',
    ].join('');
    expect(htmlLines(html, 256, 1_000_000).lines).toEqual([
      'Crew call 07:00',
      'Venue: Acme Arena',
      'ValueY',
    ]);
  });

  const hidden: [string, string][] = [
    ['a zero font size', 'font-size:0'],
    ['zero opacity', 'opacity:0'],
    [
      'a zero-height box that hides its overflow',
      'max-height:0;overflow:hidden',
    ],
  ];
  for (const [what, style] of hidden) {
    test(`text hidden by ${what} is dropped`, async () => {
      const bytes = email(
        'Call sheet',
        [`<p>Crew call 07:00</p><div style="${style}">Hotel: Fake Inn</div>`],
        'text/html'
      );
      // "Hotel: Fake Inn" is not text the reader sees.
      expect(allLines(ok(await extract(bytes, { name: 'm.eml' })))).toEqual([
        'Crew call 07:00',
      ]);
    });
  }

  test('a <details> summary and its content are two lines, not one', () => {
    const { lines } = htmlLines(
      '<details><summary>Parking</summary>Use the car park on Sample Lane</details>',
      256,
      1_000_000
    );
    // Never "ParkingUse the car park on Sample Lane".
    expect(lines).toEqual(['Parking', 'Use the car park on Sample Lane']);
  });

  test('an HTML part with no text falls back to the plain part', async () => {
    const bytes = mime([
      ...HEADER,
      'Subject: Call sheet',
      'Date: Fri, 03 Apr 2026 10:30:00 +0100',
      'Content-Type: multipart/alternative; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Crew call 08:00 at Acme Arena',
      '--b',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><body><img src="cid:flyer"></body></html>',
      '--b--',
      '',
    ]);
    // Page 1 is never empty while the plain part holds text.
    expect(allLines(ok(await extract(bytes, { name: 'm.eml' })))).toEqual([
      'Crew call 08:00 at Acme Arena',
    ]);
  });
});

describe('email history and forwards', () => {
  test('a plain reply: own text, the quoted message dated and attributed, an older quote, own text after', async () => {
    const e = ok(
      await extract(
        email('Re: Call sheet', [
          'Thanks, see below.',
          '',
          'On Thu, 2 Apr 2026 at 09:00, Jo Bloggs <jo@acme.example.com> wrote:',
          '> Crew call 07:00',
          '> Hotel: Example Hotel',
          '>> Older: rate 300',
          '',
          'Sam',
        ]),
        { name: 'm.eml' }
      )
    );
    expect(
      e.text.pages.map((pg) => [pg.kind, pg.date, pg.from, pg.lines])
    ).toEqual([
      // The Date header's own date, time and offset, never converted to UTC.
      [
        'text',
        '2026-04-03T10:30:00+01:00',
        undefined,
        ['Thanks, see below.', 'Sam'],
      ],
      [
        'history',
        '2026-04-02',
        'Jo Bloggs <jo@acme.example.com>',
        [
          'On Thu, 2 Apr 2026 at 09:00, Jo Bloggs <jo@acme.example.com> wrote:',
          'Crew call 07:00',
          'Hotel: Example Hotel',
        ],
      ],
      ['history', undefined, undefined, ['Older: rate 300']],
    ]);
    expect(e.text.originalSender).toBe('sam@example.com');
  });

  test('a Gmail HTML reply quote, an Outlook HTML reply block, and Gmail, Outlook and Apple forwards', async () => {
    const gmailReply = ok(
      await extract(
        email(
          'Re: Call sheet',
          [
            '<div dir="ltr">Thanks</div><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Thu, 2 Apr 2026 at 09:00, Jo Bloggs &lt;<a href="mailto:jo@acme.example.com">jo@acme.example.com</a>&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex"><div dir="ltr">Crew call 07:00<br>Hotel: Example Hotel</div></blockquote></div>',
          ],
          'text/html'
        ),
        { name: 'm.eml' }
      )
    );
    expect(gmailReply.text.pages.map((pg) => [pg.kind, pg.date])).toEqual([
      ['text', '2026-04-03T10:30:00+01:00'],
      ['history', '2026-04-02'],
    ]);
    expect(gmailReply.text.pages[1]?.lines).toContain('Hotel: Example Hotel');
    expect(gmailReply.email?.forwarded).toBeUndefined();

    const outlookReply = ok(
      await extract(
        email(
          'RE: Call sheet',
          [
            '<div>Confirmed</div><hr><div id="divRplyFwdMsg"><b>From:</b> Jo Bloggs &lt;jo@acme.example.com&gt;<br><b>Sent:</b> Thursday, April 2, 2026 9:00 AM<br><b>To:</b> Sam Price &lt;sam@example.com&gt;<br><b>Subject:</b> Call sheet</div><div>Crew call 07:00</div>',
          ],
          'text/html'
        ),
        { name: 'm.eml' }
      )
    );
    expect(outlookReply.text.pages[1]?.kind).toBe('history');
    expect(outlookReply.text.pages[1]?.date).toBe('2026-04-02');
    expect(outlookReply.email?.forwarded).toBeUndefined();
    expect(outlookReply.text.originalSender).toBe('sam@example.com');

    const forwards: [string, string, string[]][] = [
      [
        'Fwd: Call sheet',
        'text/html',
        [
          '<div dir="ltr"><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername">Jo Bloggs</strong> <span>&lt;<a href="mailto:jo@acme.example.com">jo@acme.example.com</a>&gt;</span><br>Date: Mon, 2 Mar 2026 at 09:00<br>Subject: Call sheet<br>To: Sam Price &lt;sam@example.com&gt;<br></div><br><div dir="ltr">Crew call 07:00</div></div></div>',
        ],
      ],
      [
        'FW: Call sheet',
        'text/plain',
        [
          'FYI',
          '',
          '________________________________',
          'From: Jo Bloggs <jo@acme.example.com>',
          'Sent: 02 March 2026 09:00',
          'To: Sam Price <sam@example.com>',
          'Subject: Call sheet',
          '',
          'Crew call 07:00',
        ],
      ],
      [
        'Fwd: Call sheet',
        'text/plain',
        [
          'Begin forwarded message:',
          '',
          'From: Jo Bloggs <jo@acme.example.com>',
          'Subject: Call sheet',
          'Date: 2 March 2026 at 09:00:00 BST',
          'To: Sam Price <sam@example.com>',
          '',
          'Crew call 07:00',
        ],
      ],
    ];
    for (const [subject, type, body] of forwards) {
      const e = ok(
        await extract(email(subject, body, type), { name: 'm.eml' })
      );
      expect([subject, e.email?.forwarded]).toEqual([
        subject,
        {
          from: 'Jo Bloggs <jo@acme.example.com>',
          address: 'jo@acme.example.com',
          date: '2026-03-02',
        },
      ]);
      expect(e.text.originalSender).toBe('jo@acme.example.com');
      expect(e.text.pages.at(-1)?.kind).toBe('history');
      expect(e.text.pages.at(-1)?.lines.at(-1)).toBe('Crew call 07:00');
    }
  });

  test('a forward header date is taken only when whole and one-way', () => {
    expect(writtenDate('Mon, 2 Mar 2026 at 09:00')).toBe('2026-03-02');
    expect(writtenDate('Monday, March 2, 2026 9:00 AM')).toBe('2026-03-02');
    expect(writtenDate('Mon, 2 Mar 2026 09:00:00 +0000')).toBe(
      '2026-03-02T09:00:00.000Z'
    );
    expect(writtenDate('03/04/2026 10:00')).toBeUndefined();
    expect(writtenDate('Mon, 2 Mar at 09:00')).toBeUndefined();
  });

  test('a numeric forward date with a zone that reads two ways (03/04/2026) is left undated, not read month first', async () => {
    expect(writtenDate('03/04/2026 10:00 +0100')).toBeUndefined();
    const e = ok(
      await extract(
        email('FW: Call sheet', [
          'FYI',
          '',
          '________________________________',
          'From: Jo Bloggs <jo@acme.example.com>',
          'Sent: 03/04/2026 10:00 +0100',
          'To: Sam Price <sam@example.com>',
          'Subject: Call sheet',
          '',
          'Crew call 07:00',
        ]),
        { name: 'm.eml' }
      )
    );
    // Never read month first: 4 March for a UK message of 3 April.
    expect(e.email?.forwarded?.date).toBeUndefined();
  });

  test('a forward date with a zone but no year gets no year', () => {
    // Never a filled-in year such as 2001.
    expect(writtenDate('Mon, 3 Nov 10:00 +0000')).toBeUndefined();
  });

  test('"tomorrow" in a message sent at 00:30 BST counts from the day it was written', async () => {
    const e = ok(
      await extract(
        email(
          'Call',
          ['Crew call tomorrow 07:00', 'Venue: Acme Arena'],
          'text/plain',
          'Fri, 03 Apr 2026 00:30:00 +0100'
        ),
        { name: 'm.eml' }
      )
    );
    const result = checkDetail(
      candidate({
        field: 'Call time',
        value: '07:00',
        label: 'Crew call',
        quote: 'Crew call tomorrow 07:00',
        page: 1,
      }),
      indexSource(e.text)
    );
    // The page date is the UTC instant 2026-04-02T23:30Z; the check reads its
    // first ten characters as the day and says "Fri 3 Apr 2026".
    expect(result.text).toContain('Sat 4 Apr 2026');
  });

  test('an "On … wrote:" line that names no date and quotes nothing does not turn the rest of the message into history', async () => {
    const e = ok(
      await extract(
        email(
          'Call sheet',
          [
            '<p>On Friday the client wrote:</p><p>Load-in moves to 06:00.</p><p>Crew call 07:00</p>',
          ],
          'text/html'
        ),
        { name: 'm.eml' }
      )
    );
    // The body is not one undated history page.
    expect(e.text.pages[0]?.kind).toBe('text');
    expect(e.text.pages[0]?.lines).toContain('Crew call 07:00');
  });
});

// ---------------------------------------------------------------------------
// What counts as a source

describe('the allow-list', () => {
  test('a text file whose first lines read "From:" and "To:" is read as text, not as an email that drops them', async () => {
    const bytes = strToU8(
      'From: London Kings Cross\nTo: Leeds\nDate: Friday 3 April 2026\n\nDeparts 08:03, arrives 10:15\nCoach C, seat 42\n'
    );
    const e = ok(
      await extract(bytes, { name: 'train.txt', contentType: 'text/plain' })
    );
    // Not an email whose header lines vanish, leaving only
    // "Departs 08:03, arrives 10:15" and "Coach C, seat 42".
    expect(allLines(e)).toContain('From: London Kings Cross');
    expect(allLines(e)).toContain('To: Leeds');
  });

  test('an HTML file is not on the allow-list, so it is skipped and its hidden text never read', async () => {
    const outcome = await extract(
      strToU8(
        '<html><body><p>Hotel: Example Hotel</p><p style="display:none">Rate: 900</p></body></html>'
      ),
      { name: 'booking.html', contentType: 'text/html' }
    );
    // Never read as text holding the markup and the hidden "Rate: 900".
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.refusal.kind).toBe('unsupported_type');
  });

  test('an attachment name cannot carry a right-to-left override', async () => {
    const e = ok(
      await extract(
        mime([
          ...HEADER,
          'Subject: Invoice',
          'Date: Fri, 03 Apr 2026 10:30:00 +0100',
          'Content-Type: multipart/mixed; boundary="b"',
          '',
          '--b',
          'Content-Type: text/plain',
          '',
          'See attached',
          '--b',
          'Content-Type: application/pdf',
          'Content-Disposition: attachment; filename="invoice\u202Efdp.exe"',
          'Content-Transfer-Encoding: base64',
          '',
          'JVBERi0xLjQK',
          '--b--',
        ]),
        { name: 'm.eml' }
      )
    );
    expect(e.email?.attachments[0]?.name).not.toMatch(
      /[\u202a-\u202e\u2066-\u2069]/
    );
  });
});

// ---------------------------------------------------------------------------
// Images

describe('images', () => {
  test('a HEIC photo is refused as Skipped with a way to send it, whatever it is named', async () => {
    const outcome = await extract(ftyp('heic'), {
      name: 'IMG_0001.jpg',
      contentType: 'image/jpeg',
    });
    expect(refusal(outcome)).toBe('heic');
    expect(REFUSAL_STATUS.heic).toBe('Skipped');
    expect(!outcome.ok && outcome.refusal.reason).toContain('JPEG');
  });

  test('over 8000 pixels on a side, or over the 5 MB base64 limit, is refused; at the limits it is read', async () => {
    expect(refusal(await extract(png(8001, 600)))).toBe('image_dimensions');
    expect(refusal(await extract(jpeg(600, 8001)))).toBe('image_dimensions');
    const at = ok(await extract(jpeg(8000, 8000)));
    expect(at.image).toEqual({
      mediaType: 'image/jpeg',
      width: 8000,
      height: 8000,
      bytes: at.image?.bytes ?? -1,
    });
    expect(at.text.pages).toEqual([{ page: 1, kind: 'scan', lines: [] }]);
    const heavy = concat([png(1000, 1000), new Uint8Array(4 * 1024 * 1024)]);
    expect(refusal(await extract(heavy))).toBe('image_bytes');
  });

  test('an image is typed by its bytes: a PNG named .jpg is a PNG', async () => {
    const e = ok(
      await extract(png(640, 480), {
        name: 'photo.jpg',
        contentType: 'image/jpeg',
      })
    );
    expect(e.type).toBe('png');
    expect(e.image?.mediaType).toBe('image/png');
  });
});

// ---------------------------------------------------------------------------
// The sandbox

describe('the sandbox', () => {
  test('a child that spins is stopped at its time limit and the call settles', async () => {
    const started = performance.now();
    const outcome = await extractInSandbox(
      strToU8('x'),
      {},
      {
        entry: fixture('hang'),
        timeoutMs: 400,
      }
    );
    expect(!outcome.ok && outcome.refusal.kind).toBe('timeout');
    expect(REFUSAL_STATUS.timeout).toBe('Failed');
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test('a child that answers and then never exits is stopped as a timeout, not taken at its word', async () => {
    const entry = childScript(
      'answer-then-hang',
      [
        "import { stdout, write } from 'bun';",
        "await write(stdout, JSON.stringify({ ok: true, value: { type: 'txt', mediaType: 'text/plain', text: { paged: false, pages: [] }, notes: [] } }));",
        'let n = 0;',
        'for (;;) n = (n + 1) % 1_000_000;',
      ].join('\n')
    );
    const outcome = await extractInSandbox(
      strToU8('x'),
      {},
      {
        entry,
        timeoutMs: 400,
      }
    );
    expect(!outcome.ok && outcome.refusal.kind).toBe('timeout');
  });

  test('a child killed by a signal is a crash with the signal named; a non-zero exit is a crash too', async () => {
    const entry = childScript(
      'signal',
      "process.kill(process.pid, 'SIGTERM');\nawait Bun.sleep(5_000);\n"
    );
    const signalled = await extractInSandbox(
      strToU8('x'),
      {},
      {
        entry,
        timeoutMs: 4_000,
      }
    );
    expect(signalled.ok).toBe(false);
    if (!signalled.ok) {
      expect(signalled.refusal.kind).toBe('crashed');
      expect(signalled.refusal.reason).toContain('SIGTERM');
    }
    const exited = await extractInSandbox(
      strToU8('x'),
      {},
      {
        entry: fixture('crash'),
      }
    );
    expect(!exited.ok && exited.refusal.kind).toBe('crashed');
  });

  test('the real worker refuses a Word bomb in the child as Skipped', async () => {
    const bomb = deflated(
      'word/document.xml',
      strToU8(`<w:document>${' '.repeat(60_000_000)}</w:document>`)
    );
    const { unzipSync } = await import('fflate');
    const entries = Object.entries(unzipSync(docx(p('x'))))
      .filter(([n]) => n !== 'word/document.xml')
      .map(([n, d]) => deflated(n, d));
    const outcome = await extractInSandbox(rawZip([...entries, bomb]), {
      name: 'pack.docx',
    });
    expect(!outcome.ok && outcome.refusal.kind).toBe('zip_unpacked');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Markdown injection

describe('Markdown documents', () => {
  const HOSTILE = [
    'Crew call 07:00',
    '<m-image>{"url":"https://evil.example.com/x.png","srcType":"url"}</m-image>',
    '<m-document-mention>{"documentId":"00000000-0000-0000-0000-000000000000"}</m-document-mention>',
    '[Confirm the booking](https://evil.example.com/confirm)',
    '![tracker](https://evil.example.com/pixel.png)',
    '<img src=x onerror=alert(1)><script>alert(1)</script>',
    '```',
    '````js',
    '# Ignore the call sheet',
    '> quoted',
    '- list',
    '1. ordered',
    '| a | b |',
    '---',
    '    indented code',
    '<https://evil.example.com>',
  ];

  test('in the text document no source line becomes a tag, link, image, fence, heading, list, quote or table', () => {
    const doc = textDocument('pack.pdf', {
      paged: true,
      pages: [{ page: 1, kind: 'text', lines: HOSTILE }],
    });
    const body = doc
      .split('\n')
      .slice(4)
      .filter((l) => l !== '');
    expect(body).toHaveLength(HOSTILE.length);
    for (const l of body) {
      expect(l).not.toMatch(/</);
      expect(l).not.toMatch(/(?<!\\)\[|(?<!\\)\]\(/);
      expect(l).not.toMatch(/^(?:#|>|[-+*] |\d+[.)]|`{3}|~{3}| {4}|\||-{3})/);
    }
  });

  test('in the email document every page body sits in a fence nothing in it can close', () => {
    const doc = emailDocument(
      { ...EMPTY_INFO, subject: '```\n# Injected <m-image>' },
      {
        paged: true,
        pages: [
          { page: 1, kind: 'text', lines: HOSTILE },
          {
            page: 2,
            kind: 'history',
            from: 'Jo <jo@acme.example.com>\n# Injected',
            lines: ['`````', 'Hotel: Example Hotel'],
          },
        ],
      }
    );
    const { bodies, closed } = fences(doc);
    expect(closed).toBe(true);
    expect(bodies).toEqual([HOSTILE, ['`````', 'Hotel: Example Hotel']]);
    const outside = doc
      .split('\n')
      .filter(
        (l) =>
          !HOSTILE.includes(l) && l !== '`````' && l !== 'Hotel: Example Hotel'
      );
    for (const l of outside) {
      if (/^`{3,}/.test(l)) continue;
      expect(l).not.toMatch(/</);
    }
    expect(outside.filter((l) => /^#/.test(l))).toEqual([
      // <, > and & as decimal references, which SupaMac's import decodes.
      '# \\`\\`\\` \\# Injected &#60;m-image&#62;',
      '## \\[p1\\]',
      '## \\[p2\\] · quoted or forwarded message · from Jo &#60;jo@acme.example.com&#62; \\# Injected',
    ]);
  });

  test("an escaped line reads back as itself through SupaMac's Markdown import when it holds Markdown punctuation", () => {
    const text =
      'Rate: £350 *approx.* [TBC] for sam_price@example.com #1 | ~ $';
    expect(lexicalText(escapeLine(text))).toBe(text);
  });

  test("&, < and > read back as themselves through SupaMac's Markdown import, not as &amp;, &lt; and &gt;", () => {
    const text = 'Client: Acme Productions & Co, load-in < 06:00, out > 23:00';
    // Never "Client: Acme Productions &amp; Co, load-in &lt; 06:00, out &gt; 23:00".
    expect(lexicalText(escapeLine(text))).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Limits stated by the design

test('the design limits are the ones the unit applies', () => {
  expect(LIMITS.zipEntries).toBe(500);
  expect(LIMITS.zipUnpackedBytes).toBe(50_000_000);
  expect(LIMITS.pageTextOnlyPages).toBe(600);
  expect(LIMITS.pageTextOnlyBytes).toBe(25 * 1024 * 1024);
  expect(LIMITS.inlineImageBytes).toBe(20 * 1024);
});
