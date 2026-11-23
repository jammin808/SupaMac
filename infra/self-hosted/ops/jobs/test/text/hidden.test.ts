// Text a sender can make invisible in the original is never read as shown:
// it is dropped where the file says plainly that it does not show, and the
// page is unsure (every detail from it needs review) where only the
// rendered page could tell. Every name and address is a placeholder.

import { describe, expect, test } from 'bun:test';
import { checkDetail, indexSource } from '../../src/checks';
import { extract } from '../../src/text/extract';
import {
  htmlLines,
  STYLESHEET_HIDES,
  stylesheetHiding,
  WHITE_HTML,
} from '../../src/text/html';
import { WHITE_TEXT } from '../../src/text/pdf';
import { candidate } from '../fixtures';
import { docx, p, pdf, textOps, xmlEscape } from './build';

const run = (text: string, rPr: string): string =>
  `<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;

async function docxLines(body: string): Promise<readonly string[]> {
  const outcome = await extract(docx(body), { name: 'pack.docx' });
  if (!outcome.ok) throw new Error(outcome.refusal.reason);
  return outcome.value.text.pages.flatMap((page) => page.lines);
}

describe('Word', () => {
  test('a white run and a run under two points are dropped', async () => {
    const lines = await docxLines(
      `<w:p>${run('Venue: Acme Arena', '')}</w:p>` +
        `<w:p>${run('Invoice to: Other Company Ltd', '<w:color w:val="FFFFFF"/>')}</w:p>` +
        `<w:p>${run('Hotel: Example Hotel', '<w:color w:val="FEFEFE"/>')}</w:p>` +
        `<w:p>${run('Contact: someone@example.com', '<w:sz w:val="2"/>')}</w:p>` +
        `<w:p>${run('Parking: rear gate', '<w:color w:val="auto" w:themeColor="background1"/>')}</w:p>`
    );
    expect(lines).toEqual(['Venue: Acme Arena']);
  });

  test('white text on a shaded run, paragraph or table cell is shown and kept', async () => {
    const lines = await docxLines(
      `<w:p>${run('Crew call: 07:00', '<w:color w:val="FFFFFF"/><w:shd w:val="clear" w:fill="1F3864"/>')}</w:p>` +
        `<w:p><w:pPr><w:shd w:val="clear" w:fill="C00000"/></w:pPr>${run('Day 1', '<w:color w:val="FFFFFF"/>')}</w:p>` +
        `<w:tbl><w:tblPr/><w:tr><w:tc><w:tcPr><w:shd w:val="clear" w:fill="000000"/></w:tcPr>${p(
          'ignored'
        )
          .replace('<w:r>', '<w:r><w:rPr><w:color w:val="FFFFFF"/></w:rPr>')
          .replace('ignored', 'Load-in')}</w:tc></w:tr></w:tbl>`
    );
    expect(lines).toEqual(['Crew call: 07:00', 'Day 1', 'Load-in']);
  });
});

describe('PDF', () => {
  test('a page with white glyphs keeps its lines but is unsure; a black one is not', async () => {
    const white = await extract(
      pdf([
        `${textOps([{ x: 72, y: 760, text: 'Venue: Acme Arena' }])}\n1 1 1 rg\n${textOps([{ x: 72, y: 700, text: 'Invoice to: Other Company Ltd' }])}`,
      ]),
      { name: 'pack.pdf' }
    );
    expect(white.ok && white.value.text.pages[0]).toEqual({
      page: 1,
      kind: 'text',
      unsure: WHITE_TEXT,
      lines: ['Venue: Acme Arena', 'Invoice to: Other Company Ltd'],
    });
    const black = await extract(
      pdf([
        `0 0 0 rg\n${textOps([{ x: 72, y: 760, text: 'Venue: Acme Arena' }])}`,
      ]),
      { name: 'pack.pdf' }
    );
    expect(black.ok && black.value.text.pages[0]?.unsure).toBeUndefined();
  });
});

describe('HTML', () => {
  const lines = (html: string) => htmlLines(html, 256, 1_000_000);

  test('text hidden by a stylesheet class, by colour, or off the page is dropped', () => {
    const read = lines(
      '<html><head><style>.x { display: none } p.ghost{font-size:0px}</style></head><body>' +
        '<p>Venue: Acme Arena</p>' +
        '<p class="x">Invoice to: Other Company Ltd</p>' +
        '<p class="ghost">Hotel: Example Hotel</p>' +
        '<p style="color:#000;background-color:black">Contact: someone@example.com</p>' +
        '<p style="color: transparent">Parking: rear gate</p>' +
        '<p style="text-indent:-9999px">PO: 12345</p>' +
        '<div style="position:absolute;left:-2000px">Rate: 900</div>' +
        '</body></html>'
    );
    expect(read.lines).toEqual(['Venue: Acme Arena']);
    expect(read.unsure).toBeUndefined();
  });

  test('white text with no background around it makes the body unsure; on a dark band it is plain text', () => {
    const plain = lines(
      '<table><tr><td bgcolor="#1f3864"><span style="color:#ffffff">Crew call 07:00</span></td></tr></table>'
    );
    expect(plain.lines).toEqual(['Crew call 07:00']);
    expect(plain.unsure).toBeUndefined();
    const white = lines(
      '<p>Venue: Acme Arena</p><p style="color:#fff">Invoice to: Other Company Ltd</p>'
    );
    expect(white.unsure).toBe(WHITE_HTML);
  });

  test('a stylesheet that hides by a selector it cannot follow, or only on some screens, makes the body unsure', () => {
    expect(
      stylesheetHiding('<style>div > p { display:none }</style>').unsure
    ).toBe(STYLESHEET_HIDES);
    expect(
      stylesheetHiding(
        '<style>@media (max-width:600px) { .mobile-hide { display:none } }</style>'
      )
    ).toEqual({ classes: new Set(), unsure: STYLESHEET_HIDES });
    expect(stylesheetHiding('<style>.x{display:none}</style>')).toEqual({
      classes: new Set(['x']),
    });
  });
});

describe('the checks', () => {
  test('a detail quoted from an unsure page needs review, with why', () => {
    const r = checkDetail(
      candidate({
        field: 'Venue',
        label: 'Venue',
        value: 'Acme Arena',
        quote: 'Venue: Acme Arena',
        page: 1,
      }),
      indexSource({
        paged: true,
        pages: [
          {
            page: 1,
            kind: 'text',
            unsure: WHITE_TEXT,
            lines: ['Venue: Acme Arena'],
          },
        ],
      })
    );
    expect(r.status).toBe('Needs review');
    expect(r.failed.map((f) => f.code)).toContain('page_unsure');
  });
});
