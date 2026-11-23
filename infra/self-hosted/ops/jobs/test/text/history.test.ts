import { describe, expect, test } from 'bun:test';
import {
  addressOf,
  attributionSender,
  headerDate,
  splitHistory,
  writtenDate,
} from '../../src/text/history';

describe('splitHistory', () => {
  test('a Gmail reply: own text, then the quoted message with its date and sender, then older quotes', () => {
    const segments = splitHistory([
      'Hi Sam, call is now 08:00 on the Saturday.',
      '',
      'On Mon, 1 Mar 2027 at 10:15, Jo Bloggs <jo@acme-productions.example.com> wrote:',
      '> Call time 07:00 on Sat 13 March 2027',
      '>',
      '> On Sun, 28 Feb 2027 at 18:00, Sam Price <sam@example.com> wrote:',
      '> > Is the call still 06:00?',
      '',
      'Thanks, Sam',
    ]);
    expect(segments).toEqual([
      {
        lines: ['Hi Sam, call is now 08:00 on the Saturday.', 'Thanks, Sam'],
        history: false,
        forward: false,
        headed: false,
      },
      {
        lines: [
          'On Mon, 1 Mar 2027 at 10:15, Jo Bloggs <jo@acme-productions.example.com> wrote:',
          'Call time 07:00 on Sat 13 March 2027',
        ],
        history: true,
        forward: false,
        headed: false,
        from: 'Jo Bloggs <jo@acme-productions.example.com>',
        date: '2027-03-01',
      },
      {
        lines: [
          'On Sun, 28 Feb 2027 at 18:00, Sam Price <sam@example.com> wrote:',
          'Is the call still 06:00?',
        ],
        history: true,
        forward: false,
        headed: false,
        from: 'Sam Price <sam@example.com>',
        date: '2027-02-28',
      },
    ]);
  });

  test('a Gmail forward runs to the end, headed by its own From and Date', () => {
    const [own, forwarded] = splitHistory([
      'For the Leeds job.',
      '---------- Forwarded message ---------',
      'From: Jo Bloggs <jo@acme-productions.example.com>',
      'Date: Mon, 1 Mar 2027 at 10:15',
      'Subject: Leeds Lights Gala call sheet',
      'To: Sam Price <sam@example.com>',
      '',
      'Crew call 07:00',
      'PO: 4500123',
    ]);
    expect(own?.lines).toEqual(['For the Leeds job.']);
    expect(forwarded).toMatchObject({
      history: true,
      forward: true,
      headed: true,
      from: 'Jo Bloggs <jo@acme-productions.example.com>',
      date: '2027-03-01',
    });
    expect(forwarded?.lines.slice(-2)).toEqual([
      'Crew call 07:00',
      'PO: 4500123',
    ]);
  });

  test('Apple Mail and Outlook forwards and quotes are split too', () => {
    const apple = splitHistory([
      'Begin forwarded message:',
      'From: Example Hotel <reservations@example-hotel.example.com>',
      'Subject: Booking confirmation',
      'Date: 2 March 2027 at 09:30:00 GMT',
      'Booking reference: MAL-77821',
    ]);
    expect(apple[1]).toMatchObject({
      forward: true,
      date: '2027-03-02T09:30:00.000Z',
    });

    const outlook = splitHistory([
      'See below',
      '________________________________',
      'From: Jo Bloggs <jo@acme-productions.example.com>',
      'Sent: Monday, March 1, 2027 10:15 AM',
      'To: Sam Price',
      'Subject: RE: Leeds',
      'Rate £350/day',
    ]);
    expect(outlook[1]).toMatchObject({
      forward: false,
      headed: true,
      date: '2027-03-01',
      lines: expect.arrayContaining(['Rate £350/day']),
    });

    const bare = splitHistory([
      'Thanks',
      'From: Jo Bloggs',
      'Sent: 01 March 2027 10:15',
      'Subject: Leeds',
      'Load-in 08:00',
    ]);
    expect(bare[1]).toMatchObject({
      headed: true,
      from: 'Jo Bloggs',
      date: '2027-03-01',
    });

    const oneLine = splitHistory([
      'ok',
      'From: Jo Bloggs <jo@example.com> Sent: 1 March 2027 10:15 To: Sam Subject: Leeds',
      'Crew call 07:00',
    ]);
    expect(oneLine[1]).toMatchObject({
      headed: true,
      from: 'Jo Bloggs <jo@example.com>',
      date: '2027-03-01',
    });

    const original = splitHistory([
      '-----Original Message-----',
      'From: Jo Bloggs',
      'Date: 01/03/2027',
      'Rate £300',
    ]);
    expect(original[1]).toMatchObject({
      headed: true,
      from: 'Jo Bloggs',
      date: undefined,
    });
  });

  test('bare quoting with no attribution is history without a date', () => {
    const segments = splitHistory([
      '> Crew call 07:00',
      '> Rate £300',
      'Agreed, see you there',
    ]);
    expect(segments.map((s) => [s.history, s.lines, s.date])).toEqual([
      [false, ['Agreed, see you there'], undefined],
      [true, ['Crew call 07:00', 'Rate £300'], undefined],
    ]);
  });

  test('an attribution wrapped over two lines is still one', () => {
    const segments = splitHistory([
      'On Mon, 1 Mar 2027 at 10:15, Jo Bloggs <',
      'jo@example.com> wrote:',
      '> Call 07:00',
    ]);
    expect(segments[1]).toMatchObject({
      from: 'Jo Bloggs < jo@example.com>',
      date: '2027-03-01',
    });
  });
});

describe('written dates and senders', () => {
  test('a date is taken only when it is whole and reads one way', () => {
    expect(writtenDate('Mon, 1 Mar 2027 at 10:15')).toBe('2027-03-01');
    expect(writtenDate('Mon, 1 Mar 2027 10:15:00 +0000')).toBe(
      '2027-03-01T10:15:00.000Z'
    );
    expect(writtenDate('01/03/2027 10:15')).toBeUndefined();
    expect(writtenDate('Monday 1 March')).toBeUndefined();
    expect(writtenDate('2027-03-01 10:15')).toBe('2027-03-01');
  });

  test('a date written with a time and a zone keeps the written date, time and offset', () => {
    expect(writtenDate('Fri, 3 Apr 2026 00:30:00 +0100')).toBe(
      '2026-04-03T00:30:00+01:00'
    );
    expect(writtenDate('Thursday, April 2, 2026 9:00 PM GMT-05:00')).toBe(
      '2026-04-02T21:00:00-05:00'
    );
    expect(writtenDate('13/04/2026 10:00 +0100')).toBe(
      '2026-04-13T10:00:00+01:00'
    );
    // A two-way numeric date, a missing year, a two-digit numeric year or a
    // weekday that disagrees gives no date at all.
    expect(writtenDate('03/04/2026 10:00 +0100')).toBeUndefined();
    expect(writtenDate('Mon, 3 Nov 10:00 +0000')).toBeUndefined();
    expect(writtenDate('13/04/26 10:00')).toBeUndefined();
    expect(writtenDate('Tue, 2 Mar 2026 10:00')).toBeUndefined();
    // A zone named by letters other than GMT or UTC is not read.
    expect(writtenDate('2 March 2026 at 09:00:00 BST')).toBe('2026-03-02');
  });

  test("a message's Date header keeps its offset; without a zone it is a date only", () => {
    expect(headerDate('Fri, 03 Apr 2026 00:30:00 +0100')).toBe(
      '2026-04-03T00:30:00+01:00'
    );
    expect(headerDate('Fri, 03 Apr 2026 10:30:00 +0100 (BST)')).toBe(
      '2026-04-03T10:30:00+01:00'
    );
    expect(headerDate('Thu, 4 Mar 2027 09:00:00 +0000')).toBe(
      '2027-03-04T09:00:00.000Z'
    );
    expect(headerDate('3 Apr 26 10:30 EST')).toBe('2026-04-03T10:30:00-05:00');
    expect(headerDate('Fri, 03 Apr 2026 10:30:00')).toBe('2026-04-03');
    expect(headerDate('03/04/2026 10:30')).toBeUndefined();
    expect(headerDate(undefined)).toBeUndefined();
  });

  test('an "On … wrote:" line before unquoted text starts history only when it names a date or time', () => {
    expect(
      splitHistory([
        'On Friday the client wrote:',
        'Load-in moves to 06:00.',
        'Crew call 07:00',
      ]).map((s) => [s.history, s.lines])
    ).toEqual([
      [
        false,
        [
          'On Friday the client wrote:',
          'Load-in moves to 06:00.',
          'Crew call 07:00',
        ],
      ],
    ]);
    expect(
      splitHistory([
        'Thanks',
        'On 2 Apr 2026, Jo Bloggs wrote:',
        'Crew call 07:00',
      ]).map((s) => [s.history, s.date])
    ).toEqual([
      [false, undefined],
      [true, '2026-04-02'],
    ]);
  });

  test('the sender is what follows the date and time; the address is inside it', () => {
    expect(attributionSender('On 1 Mar 2027, at 10:15, Jo Bloggs wrote:')).toBe(
      'Jo Bloggs'
    );
    expect(
      attributionSender(
        'On Monday, March 1, 2027 10:15 AM, Jo Bloggs <jo@example.com> wrote:'
      )
    ).toBe('Jo Bloggs <jo@example.com>');
    expect(addressOf('Jo Bloggs <Jo@Acme-Productions.example.com>')).toBe(
      'jo@acme-productions.example.com'
    );
    expect(addressOf('jo@example.com')).toBe('jo@example.com');
    expect(addressOf('Jo Bloggs')).toBeUndefined();
  });
});
