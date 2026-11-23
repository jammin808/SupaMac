import { describe, expect, test } from 'bun:test';
import { extract } from '../../src/text/extract';
import type { Extracted } from '../../src/text/types';
import { mime, pdf, png, textOps } from './build';

const b64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64');

async function read(lines: readonly string[]): Promise<Extracted> {
  const outcome = await extract(mime(lines));
  if (!outcome.ok) throw new Error(outcome.refusal.reason);
  expect(outcome.value.type).toBe('eml');
  return outcome.value;
}

const HEAD = [
  'From: Sam Price <sam@example.com>',
  'To: Jobs <jobs@example.com>',
  'Date: Thu, 4 Mar 2027 09:00:00 +0000',
  'MIME-Version: 1.0',
];

describe('emails', () => {
  test('read the HTML part as text, dropping hidden elements and images, keeping links as text', async () => {
    const html = [
      '<html><head><title>x</title><style>p{color:red}</style></head><body>',
      '<div style="display: none !important; max-height:0">Preheader: ignore the rate</div>',
      '<p hidden>hidden paragraph</p><span style="visibility:hidden">invisible</span>',
      '<h2>Call Sheet</h2>',
      '<p>Crew call <b>07:00</b> at <a href="https://maps.example.com/acme">Acme Arena</a>. <img src="cid:logo" alt="Acme logo"></p>',
      '<p>Questions: <a href="mailto:jo@acme-productions.example.com">jo@acme-productions.example.com</a></p>',
      '<table><tr><td>Venue</td><td>Acme Arena</td></tr><tr><td>Parking</td><td style="DISPLAY:NONE">secret</td><td>Sample Lane</td></tr></table>',
      '<table><thead><tr><th>Date</th><th>Call</th><th>Finish</th></tr></thead><tbody><tr><td>Fri 12 March</td><td>07:00</td><td>23:00</td></tr></tbody></table>',
      '<table><tr><td><p>Left column</p><p>second line</p></td><td><div>Right column</div></td></tr></table>',
      '</body></html>',
    ].join('');
    const value = await read([
      ...HEAD,
      'Subject: Leeds',
      'Content-Type: multipart/alternative; boundary="alt"',
      '',
      '--alt',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'PLAIN PART',
      '--alt',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      html.replace(/=/g, '=3D'),
      '--alt--',
      '',
    ]);
    expect(value.text.pages).toEqual([
      {
        page: 1,
        kind: 'text',
        date: '2027-03-04T09:00:00.000Z',
        lines: [
          'Call Sheet',
          'Crew call 07:00 at Acme Arena [https://maps.example.com/acme].',
          'Questions: jo@acme-productions.example.com',
          'Venue: Acme Arena',
          'Parking: Sample Lane',
          'Date: Fri 12 March',
          'Fri 12 March · Call: 07:00',
          'Fri 12 March · Finish: 23:00',
          'Left column',
          'second line',
          'Right column',
        ],
      },
    ]);
    expect(value.text.paged).toBe(false);
  });

  test('capture Message-ID, In-Reply-To and References, oldest first', async () => {
    const value = await read([
      ...HEAD,
      'Subject: Re: Leeds',
      'Message-ID: <c3@example.com>',
      'In-Reply-To: <b2@acme-productions.example.com>',
      'References: <a1@acme-productions.example.com> <b2@acme-productions.example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Confirmed.',
    ]);
    expect(value.email).toMatchObject({
      messageId: '<c3@example.com>',
      inReplyTo: '<b2@acme-productions.example.com>',
      references: [
        '<a1@acme-productions.example.com>',
        '<b2@acme-productions.example.com>',
      ],
      threadIds: [
        '<a1@acme-productions.example.com>',
        '<b2@acme-productions.example.com>',
      ],
      from: 'sam@example.com',
    });
    expect(value.text.originalSender).toBe('sam@example.com');
  });

  test('a forward gives the original sender and date, and its own page of kind history', async () => {
    const value = await read([
      ...HEAD,
      'Subject: Fwd: Leeds Lights Gala',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '---------- Forwarded message ---------',
      'From: Jo Bloggs <jo@acme-productions.example.com>',
      'Date: Mon, 1 Mar 2027 at 10:15',
      'Subject: Leeds Lights Gala',
      'To: Sam Price <sam@example.com>',
      '',
      'Crew call 07:00',
    ]);
    expect(value.text.pages).toHaveLength(1);
    expect(value.text.pages[0]).toMatchObject({
      page: 1,
      kind: 'history',
      date: '2027-03-01',
      from: 'Jo Bloggs <jo@acme-productions.example.com>',
    });
    expect(value.text.originalSender).toBe('jo@acme-productions.example.com');
    expect(value.email?.forwarded).toEqual({
      from: 'Jo Bloggs <jo@acme-productions.example.com>',
      address: 'jo@acme-productions.example.com',
      date: '2027-03-01',
    });
  });

  test('an Outlook header block is a forward only under a forward subject', async () => {
    const body = [
      '',
      'FYI',
      '________________________________',
      'From: Jo Bloggs <jo@acme-productions.example.com>',
      'Sent: 01 March 2027 10:15',
      'To: Sam Price',
      'Subject: Leeds',
      'Crew call 07:00',
    ];
    const fw = await read([
      ...HEAD,
      'Subject: FW: Leeds',
      'Content-Type: text/plain',
      ...body,
    ]);
    expect(fw.text.originalSender).toBe('jo@acme-productions.example.com');
    const re = await read([
      ...HEAD,
      'Subject: RE: Leeds',
      'Content-Type: text/plain',
      ...body,
    ]);
    expect(re.text.originalSender).toBe('sam@example.com');
    expect(re.text.pages.map((p) => p.kind)).toEqual(['text', 'history']);
  });

  test('a forward whose From writes no address leaves the original sender unknown', async () => {
    const value = await read([
      ...HEAD,
      'Subject: Fwd: Leeds',
      'Content-Type: text/plain',
      '',
      'Begin forwarded message:',
      'From: Jo Bloggs',
      'Subject: Leeds',
      'Crew call 07:00',
    ]);
    expect(value.text.originalSender).toBeUndefined();
  });

  test('list attachments with their bytes; small inline images are not sent; attached messages become history', async () => {
    const attached = pdf([
      textOps([
        {
          x: 72,
          y: 760,
          text: 'PURCHASE ORDER PO 4500123 Acme Productions Ltd',
        },
      ]),
    ]);
    const logo = png(120, 40);
    const inner = [
      'From: Jo Bloggs <jo@acme-productions.example.com>',
      'To: Sam Price <sam@example.com>',
      'Subject: Leeds PO',
      'Date: Tue, 2 Mar 2027 14:00:00 +0000',
      'Message-ID: <po@acme-productions.example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'PO attached: 4500123',
    ].join('\r\n');
    const value = await read([
      ...HEAD,
      'Subject: Fwd: Leeds PO',
      'Content-Type: multipart/mixed; boundary="mix"',
      '',
      '--mix',
      'Content-Type: multipart/related; boundary="rel"',
      '',
      '--rel',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>See the PO.</p><img src="cid:logo@example.com">',
      '--rel',
      'Content-Type: image/png',
      'Content-ID: <logo@example.com>',
      'Content-Disposition: inline',
      'Content-Transfer-Encoding: base64',
      '',
      b64(logo),
      '--rel--',
      '--mix',
      'Content-Type: application/pdf; name="PO 4500123.pdf"',
      'Content-Disposition: attachment; filename="PO 4500123.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      b64(attached),
      '--mix',
      'Content-Type: message/rfc822',
      'Content-Disposition: attachment; filename="Leeds PO.eml"',
      '',
      inner,
      '--mix--',
      '',
    ]);
    const attachments = value.email?.attachments ?? [];
    expect(
      attachments.map((a) => [a.name, a.contentType, a.inline, a.send])
    ).toEqual([
      ['attachment 1.png', 'image/png', true, false],
      ['PO 4500123.pdf', 'application/pdf', false, true],
    ]);
    expect(attachments[1]?.bytes).toEqual(attached);
    expect(
      value.text.pages.map((p) => [p.page, p.kind, p.date, p.from, p.lines])
    ).toEqual([
      [1, 'text', '2027-03-04T09:00:00.000Z', undefined, ['See the PO.']],
      [
        2,
        'history',
        '2027-03-02T14:00:00.000Z',
        'Jo Bloggs <jo@acme-productions.example.com>',
        ['PO attached: 4500123'],
      ],
    ]);
    expect(value.text.originalSender).toBe('jo@acme-productions.example.com');
  });

  test('a large inline image is still sent', async () => {
    const big = new Uint8Array(30_000);
    big.set(png(2000, 1000));
    const value = await read([
      ...HEAD,
      'Subject: Photo of the call sheet',
      'Content-Type: multipart/related; boundary="r"',
      '',
      '--r',
      'Content-Type: text/html',
      '',
      '<img src="cid:p@example.com">',
      '--r',
      'Content-Type: image/png',
      'Content-ID: <p@example.com>',
      'Content-Transfer-Encoding: base64',
      '',
      b64(big),
      '--r--',
    ]);
    expect(value.email?.attachments.map((a) => [a.inline, a.send])).toEqual([
      [true, true],
    ]);
    expect(value.text.pages).toEqual([{ page: 1, kind: 'text', lines: [] }]);
  });

  test('a font-size:0 layout reads the cells that set a size again, and drops the rest', async () => {
    const value = await read([
      ...HEAD,
      'Subject: Leeds',
      'Content-Type: text/html',
      '',
      '<table><tr><td style="font-size:0">gap <div style="display:inline-block;font-size:14px">Venue: Acme Arena</div> <div style="display:inline-block;font-size:14px">Crew call 07:00</div></td></tr></table><p style="font-size:1px;color:#fff">Rate: 900</p>',
    ]);
    expect(value.text.pages[0]?.lines).toEqual([
      'Venue: Acme Arena',
      'Crew call 07:00',
    ]);
  });

  test('plain text postal-mime makes from an HTML part is never read in its place', async () => {
    const value = await read([
      ...HEAD,
      'Subject: Leeds',
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain',
      '',
      '',
      '--b',
      'Content-Type: text/html',
      'Content-Disposition: inline',
      '',
      '<div style="display:none">Rate: 900</div><img src="cid:flyer">',
      '--b--',
    ]);
    expect(value.text.pages.flatMap((pg) => pg.lines)).toEqual([]);
  });

  test('an HTML part with too many tags is read from the plain part', async () => {
    const value = await read([
      ...HEAD,
      'Subject: Leeds',
      'Content-Type: multipart/alternative; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain',
      '',
      'Crew call 07:00',
      '--b',
      'Content-Type: text/html',
      '',
      `<p>Crew call 07:00</p>${'<b></b>'.repeat(400_000)}`,
      '--b--',
    ]);
    expect(value.text.pages[0]?.lines).toEqual(['Crew call 07:00']);
  });

  test('the message date keeps its written offset', async () => {
    const value = await read([
      'From: Sam Price <sam@example.com>',
      'To: Jobs <jobs@example.com>',
      'Date: Fri, 03 Apr 2026 00:30:00 +0100',
      'Subject: Leeds',
      '',
      'Crew call tomorrow 07:00',
    ]);
    expect(value.email?.date).toBe('2026-04-03T00:30:00+01:00');
    expect(value.text.pages[0]?.date).toBe('2026-04-03T00:30:00+01:00');
  });

  test('attachment names lose control and format characters, and a name of dots is no name', async () => {
    const part = (name: string) => [
      '--b',
      'Content-Type: application/pdf',
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0xLjQK',
    ];
    const value = await read([
      ...HEAD,
      'Subject: Files',
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain',
      '',
      'See attached',
      ...part('invoice\u2066fdp.exe\u2069.pdf'),
      ...part('..'),
      ...part('call\u200bsheet.pdf'),
      '--b--',
    ]);
    expect(value.email?.attachments.map((a) => a.name)).toEqual([
      'invoice_fdp.exe_.pdf',
      'attachment 2',
      'call_sheet.pdf',
    ]);
  });

  test('HTML nested past the depth limit is cut there, and the note says so', async () => {
    const html = `<p>Crew call 07:00</p>${'<div>'.repeat(5000)}deep text${'</div>'.repeat(5000)}`;
    const value = await read([
      ...HEAD,
      'Subject: Deep',
      'Content-Type: text/html',
      '',
      html,
    ]);
    expect(value.text.pages[0]?.lines).toEqual(['Crew call 07:00']);
    expect(value.notes).toEqual([
      "The email's HTML is nested more than 256 levels deep; text below that was not read.",
    ]);
  });
});
