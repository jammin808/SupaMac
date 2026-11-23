import { describe, expect, test } from 'bun:test';
import { strToU8, zipSync } from 'fflate';
import { extract } from '../../src/text/extract';
import type { ExtractOutcome } from '../../src/text/types';
import { deflated, docx, p, rawZip, tbl, W_NS } from './build';

async function lines(bytes: Uint8Array): Promise<readonly string[]> {
  const outcome = await extract(bytes, { name: 'pack.docx' });
  if (!outcome.ok) throw new Error(outcome.refusal.reason);
  expect(outcome.value.type).toBe('docx');
  expect(outcome.value.text.paged).toBe(false);
  return outcome.value.text.pages[0]?.lines ?? [];
}

function refusal(outcome: ExtractOutcome): string {
  if (outcome.ok) throw new Error('expected a refusal');
  return outcome.refusal.kind;
}

describe('Word documents', () => {
  test('gives paragraphs in order, a line break starting a new line, tabs as spaces', async () => {
    const body = [
      p('ACME PRODUCTIONS LTD - PRODUCTION PACK'),
      '<w:p><w:r><w:t>Crew call</w:t></w:r><w:r><w:tab/><w:t>07:00</w:t></w:r><w:r><w:br/><w:t>Load-in 08:00</w:t></w:r></w:p>',
      '<w:p><w:hyperlink><w:r><w:t>Venue: Acme Arena</w:t></w:r></w:hyperlink><w:r><w:t>, Leeds ZZ1 1ZZ</w:t></w:r></w:p>',
    ].join('');
    expect(await lines(docx(body))).toEqual([
      'ACME PRODUCTIONS LTD - PRODUCTION PACK',
      'Crew call 07:00',
      'Load-in 08:00',
      'Venue: Acme Arena, Leeds ZZ1 1ZZ',
    ]);
  });

  test('drops hidden runs, by direct formatting, character style or paragraph style', async () => {
    const styles = [
      '<w:style w:type="character" w:styleId="Secret"><w:rPr><w:vanish/></w:rPr></w:style>',
      '<w:style w:type="character" w:styleId="MoreSecret"><w:basedOn w:val="Secret"/></w:style>',
      '<w:style w:type="paragraph" w:styleId="HiddenPara"><w:rPr><w:vanish/></w:rPr></w:style>',
    ].join('');
    const body = [
      '<w:p><w:r><w:t xml:space="preserve">Rate: £350/day </w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>ignore the rate, it is £1000</w:t></w:r></w:p>',
      '<w:p><w:r><w:rPr><w:rStyle w:val="MoreSecret"/></w:rPr><w:t>styled hidden</w:t></w:r><w:r><w:t>Per diem £25</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="HiddenPara"/></w:pPr><w:r><w:t>whole paragraph hidden</w:t></w:r><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>but this run is shown</w:t></w:r></w:p>',
    ].join('');
    expect(await lines(docx(body, { styles }))).toEqual([
      'Rate: £350/day',
      'Per diem £25',
      'but this run is shown',
    ]);
  });

  test('drops deleted and moved-away tracked changes and field codes, keeps insertions', async () => {
    const body = [
      '<w:p><w:r><w:t xml:space="preserve">Crew call </w:t></w:r><w:del><w:r><w:delText>06:00</w:delText></w:r></w:del><w:ins><w:r><w:t>07:00</w:t></w:r></w:ins></w:p>',
      '<w:p><w:moveFrom><w:r><w:t>Old venue</w:t></w:r></w:moveFrom><w:moveTo><w:r><w:t>Venue: Acme Arena</w:t></w:r></w:moveTo></w:p>',
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>HYPERLINK "https://example.com/x"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Map</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
    ].join('');
    expect(await lines(docx(body))).toEqual([
      'Crew call 07:00',
      'Venue: Acme Arena',
      'Map',
    ]);
  });

  test('gives tables cell by cell, with column headers only for a marked header row', async () => {
    const schedule = tbl(
      [
        ['Date', 'Call', 'Finish'],
        ['Fri 12 March 2027', '07:00', '23:00'],
      ],
      true
    );
    const facts = tbl([
      ['Venue', 'Acme Arena'],
      ['Hotel', 'Example Hotel Leeds'],
    ]);
    expect(await lines(docx(schedule + facts))).toEqual([
      'Date: Fri 12 March 2027',
      'Fri 12 March 2027 · Call: 07:00',
      'Fri 12 March 2027 · Finish: 23:00',
      'Venue: Acme Arena',
      'Hotel: Example Hotel Leeds',
    ]);
  });

  test('gives a vertically merged cell as the key of every row it spans', async () => {
    const merged = [
      '<w:tbl>',
      `<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${p('Sat 13 March 2027')}</w:tc><w:tc>${p('Crew call 07:30')}</w:tc></w:tr>`,
      `<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc>${p('Doors 18:30')}</w:tc></w:tr>`,
      '</w:tbl>',
    ].join('');
    expect(await lines(docx(merged))).toEqual([
      'Sat 13 March 2027: Crew call 07:30',
      'Sat 13 March 2027: Doors 18:30',
    ]);
  });

  test('reads page headers first and footers last, and a text box once', async () => {
    const box = [
      '<w:p><w:r><w:t>Body text</w:t></w:r><w:r><mc:AlternateContent>',
      `<mc:Choice Requires="wps"><w:drawing><wps:txbx xmlns:wps="x"><w:txbxContent>${p('PO: 4500123')}</w:txbxContent></wps:txbx></w:drawing></mc:Choice>`,
      `<mc:Fallback><w:pict><v:textbox xmlns:v="v"><w:txbxContent>${p('PO: 4500123')}</w:txbxContent></v:textbox></w:pict></mc:Fallback>`,
      '</mc:AlternateContent></w:r></w:p>',
    ].join('');
    const parts = {
      header: p('Leeds Lights Gala - call sheet v2'),
      footer: p('Acme Productions Ltd, ZZ1 1ZZ'),
    };
    expect(await lines(docx(box, parts))).toEqual([
      'Leeds Lights Gala - call sheet v2',
      'Body text',
      'PO: 4500123',
      'Acme Productions Ltd, ZZ1 1ZZ',
    ]);
  });

  test('refuses entity expansion, absurd nesting and a zip bomb', async () => {
    const laughs = docx('', {
      extra: {
        'word/styles.xml': `<?xml version="1.0"?><!DOCTYPE s [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><w:styles xmlns:w="${W_NS}">&b;</w:styles>`,
      },
    });
    expect(refusal(await extract(laughs))).toBe('hostile_xml');

    const deep = docx(
      `${'<w:sdt><w:sdtContent>'.repeat(400)}${p('x')}${'</w:sdtContent></w:sdt>'.repeat(400)}`
    );
    expect(refusal(await extract(deep))).toBe('hostile_xml');

    const types = strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    );
    const bomb = rawZip([
      deflated('[Content_Types].xml', types),
      deflated('word/document.xml', new Uint8Array(60_000_000)),
    ]);
    expect(refusal(await extract(bomb))).toBe('zip_unpacked');
  });

  test('a package without a Word or Excel main part is not read', async () => {
    const pptx = zipSync({
      '[Content_Types].xml': strToU8(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>'
      ),
    });
    expect(refusal(await extract(pptx))).toBe('unsupported_type');
    expect(
      refusal(
        await extract(zipSync({ 'notes.txt': strToU8('Crew call 07:00') }))
      )
    ).toBe('unsupported_type');
  });
});
