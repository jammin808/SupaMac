import { describe, expect, test } from 'bun:test';
import {
  type CheckResult,
  checkDetail,
  checkDetails,
  checkSourceDate,
  type FailureCode,
  formatDay,
  indexSource,
  SCAN_TEXT,
  scopeLabel,
  valueKey,
} from '../src/checks';
import type { CandidateDetail, SourceText } from '../src/model';
import {
  CALL_SHEET,
  candidate,
  DAY_HEADINGS,
  EMAIL,
  HOTEL,
  ISSUED,
  NO_YEAR,
  PHOTO,
  page,
  PURCHASE_ORDER,
  SHOW_DAY_IN_FULL,
} from './fixtures';

const sheet = indexSource(CALL_SHEET);

function run(c: CandidateDetail, text: SourceText = CALL_SHEET): CheckResult {
  return checkDetail(c, text === CALL_SHEET ? sheet : indexSource(text));
}

function codes(r: CheckResult): FailureCode[] {
  return r.failed.map((f) => f.code);
}

function expectFound(r: CheckResult): void {
  expect(r.failed).toEqual([]);
  expect(r.status).toBe('Found');
}

function expectReview(r: CheckResult, ...expected: FailureCode[]): void {
  expect(r.status).toBe('Needs review');
  for (const code of expected) expect(codes(r)).toContain(code);
}

describe('check 1: the quote is on the page it names', () => {
  test('a quote valid on p2 but named p3 needs review and says where it is', () => {
    const r = run(
      candidate({
        field: 'Rate',
        value: '£350/day + VAT',
        quote: 'Rate: £350/day + VAT',
        page: 3,
      })
    );
    expectReview(r, 'page_unknown');
    const misnamed = run(
      candidate({
        field: 'Rate',
        value: '£350/day + VAT',
        quote: 'Rate: £350/day + VAT',
        page: 1,
      })
    );
    expectReview(misnamed, 'quote_not_on_page');
    expect(misnamed.text).toContain('it is on p2');
  });

  test('a paged source must name its page', () => {
    const r = run(
      candidate({
        field: 'Venue',
        value: 'Acme Arena',
        quote: 'Venue: Acme Arena',
      })
    );
    expectReview(r, 'page_missing');
    expect(r.text).toContain('it is on p1');
  });

  test('a one-page source without page numbers needs no page', () => {
    expectFound(
      run(
        candidate({
          field: 'Booking reference',
          value: 'MAL-77821',
          quote: 'Booking reference: MAL-77821',
        }),
        HOTEL
      )
    );
  });

  test('the quote "8" is not found inside "2028"', () => {
    expectReview(
      run(
        candidate({ field: 'Call time', value: '08:00', quote: '8', page: 1 })
      ),
      'quote_not_on_page'
    );
  });

  test('a quote that spans lines is refused, so lines are never joined', () => {
    expectReview(
      run(
        candidate({
          field: 'Call time',
          value: '07:30',
          quote: 'Sat 13 March 2027\nCrew call 07:30',
          page: 1,
        })
      ),
      'quote_spans_lines'
    );
  });

  test('an empty quote or value needs review', () => {
    expectReview(
      run(
        candidate({
          field: 'Venue',
          value: 'Acme Arena',
          quote: ' ',
          page: 1,
        })
      ),
      'no_quote'
    );
    expectReview(
      run(
        candidate({
          field: 'Venue',
          value: '',
          quote: 'Venue: Acme Arena',
          page: 1,
        })
      ),
      'no_value'
    );
  });

  test('a quote cut short of its entity needs review', () => {
    expectReview(
      run(
        candidate({
          field: 'Rate',
          value: '£400',
          quote: 'Second rate: £400',
          page: 2,
        })
      ),
      'quote_cut_short'
    );
  });

  test('a quote repeated on the page passes only when every occurrence reads the same', () => {
    const same: SourceText = {
      paged: false,
      pages: [
        page(1, [
          'Dress code: show blacks',
          'Reminder - Dress code: show blacks',
        ]),
      ],
    };
    const r = run(
      candidate({
        field: 'Dress code',
        value: 'show blacks',
        quote: 'Dress code: show blacks',
      }),
      same
    );
    expectFound(r);
    expect(r.text).toContain('occurs 2 times on p1, the same each time');

    const differ: SourceText = {
      paged: false,
      pages: [
        page(1, [
          'Dress code: show blacks',
          'Dress code: show blacks or smart casual',
        ]),
      ],
    };
    expectReview(
      run(
        candidate({
          field: 'Dress code',
          value: 'show blacks',
          quote: 'Dress code: show blacks',
        }),
        differ
      ),
      'hedge_left_out',
      'quote_repeats_differently'
    );
  });

  test('scan and image pages always need review', () => {
    const r = run(
      candidate({ field: 'Call time', value: '08:00', quote: 'Call 08:00' }),
      PHOTO
    );
    expectReview(r, 'scan_page');
    expect(r.text).toBe(
      'Needs review: read by the model from an image; no text was checked'
    );
    expect(r.pageKind).toBe('scan');
  });
});

describe('check 2: the quote names the field', () => {
  test('a quote without a label word for the field needs review', () => {
    expectReview(
      run(
        candidate({
          field: 'Venue',
          value: 'Acme Arena',
          quote: 'Acme Arena, Example Way',
          page: 1,
        })
      ),
      'no_label'
    );
  });

  test('the label must sit outside the value', () => {
    const r = run(
      candidate({
        field: 'Hotel',
        value: 'Accommodation',
        quote: 'Accommodation',
        page: 2,
      })
    );
    expectReview(r, 'label_only_in_value');
  });

  test('a label the model gives must be in the quote', () => {
    expectReview(
      run(
        candidate({
          field: 'Call time',
          label: 'Performer call',
          value: '07:30',
          quote: 'Crew call 07:30',
          page: 1,
          day: '2027-03-13',
          day_quote: 'Sat 13 March 2027',
        })
      ),
      'model_label_not_in_quote'
    );
  });

  test('Other uses the model label, which must be in the quote', () => {
    const r = run(
      candidate({
        field: 'Other',
        label: 'Crew room',
        value: 'Room 2B, level 1',
        quote: 'Crew room: Room 2B, level 1',
        page: 2,
      })
    );
    expectFound(r);
    expect(r.label).toBe('crew room');
    expectReview(
      run(
        candidate({
          field: 'Other',
          value: 'Room 2B, level 1',
          quote: 'Crew room: Room 2B, level 1',
          page: 2,
        })
      ),
      'no_other_label'
    );
    expectReview(
      run(
        candidate({
          field: 'Other',
          label: 'Green room',
          value: 'Room 2B, level 1',
          quote: 'Crew room: Room 2B, level 1',
          page: 2,
        })
      ),
      'model_label_not_in_quote'
    );
  });

  test('a PO label glued to its number counts as a label', () => {
    expectFound(
      run(
        candidate({
          field: 'PO number',
          value: '4500123',
          quote: 'Ref PO-4500123',
        }),
        { paged: false, pages: [page(1, ['Ref PO-4500123'])] }
      )
    );
  });
});

describe('check 3: the value is in the quote, and nothing more', () => {
  test('"Accommodation is not provided" never yields "Accommodation provided"', () => {
    expectReview(
      run(
        candidate({
          field: 'Hotel',
          value: 'Accommodation provided',
          quote: 'Accommodation is not provided for local crew',
          page: 2,
        })
      ),
      'value_not_in_quote'
    );
    expectReview(
      run(
        candidate({
          field: 'Hotel',
          value: 'provided for local crew',
          quote: 'Accommodation is not provided for local crew',
          page: 2,
        })
      ),
      'hedge_left_out'
    );
    const provided: SourceText = {
      paged: false,
      pages: [page(1, ['Accommodation: provided (2 nights)'])],
    };
    expectFound(
      run(
        candidate({
          field: 'Hotel',
          value: 'provided',
          quote: 'Accommodation: provided',
        }),
        provided
      )
    );
  });

  test("two contacts' phone numbers are never mixed", () => {
    const quote =
      'Production manager Sam Price 07700 900123, stage manager Alex Lee 07700 900456';
    expectReview(
      run(
        candidate({
          field: 'Contact',
          value: 'Sam Price 07700 900456',
          quote,
          page: 1,
        })
      ),
      'value_not_in_quote'
    );
    const r = run(
      candidate({
        field: 'Contact',
        value: 'Sam Price 07700 900123',
        quote,
        page: 1,
      })
    );
    expectFound(r);
    expect(r.label).toBe('production manager');
  });

  test('"Hotel TBC, likely the Example Hotel" keeps its hedges or needs review', () => {
    const r = run(
      candidate({
        field: 'Hotel',
        value: 'the Example Hotel',
        quote: 'Hotel TBC, likely the Example Hotel',
        page: 2,
      })
    );
    expectReview(r, 'hedge_left_out');
    expect(r.text).toContain("'tbc' is in the quote but not in the value");
    expect(r.text).toContain("'likely' is in the quote but not in the value");
    expectFound(
      run(
        candidate({
          field: 'Hotel',
          value: 'TBC, likely the Example Hotel',
          quote: 'Hotel TBC, likely the Example Hotel',
          page: 2,
        })
      )
    );
  });

  test('"Load-in 08:00 or 09:00 TBC" valued 08:00 needs review', () => {
    const r = run(
      candidate({
        field: 'Load-in',
        value: '08:00',
        quote: 'Load-in 08:00 or 09:00 TBC',
        page: 1,
        day: '2027-03-12',
        day_quote: 'Fri 12 March 2027',
      })
    );
    expectReview(r, 'quote_several', 'hedge_left_out');
    expect(
      r.failed.filter((f) => f.code === 'hedge_left_out').map((f) => f.text)
    ).toEqual([
      "'or' is in the quote but not in the value",
      "'tbc' is in the quote but not in the value",
    ]);
  });

  test('"Crew call 07:00, performers 09:00" valued 09:00 needs review', () => {
    const r = run(
      candidate({
        field: 'Call time',
        value: '09:00',
        quote: 'Crew call 07:00, performers 09:00',
        page: 1,
        day: '2027-03-12',
        day_quote: 'Fri 12 March 2027',
      })
    );
    expectReview(r, 'quote_several');
    expect(r.text).toContain('the quote holds 2 times, not one');
  });

  test('"PO 4500123 Supplier no. 88812" valued 88812 needs review, and "no." is not a negation', () => {
    const r = run(
      candidate({
        field: 'PO number',
        value: '88812',
        quote: 'PO 4500123 Supplier no. 88812',
      }),
      PURCHASE_ORDER
    );
    expectReview(r, 'quote_several');
    expect(codes(r)).not.toContain('hedge_left_out');
  });

  test('a hedge on the same line outside the quote counts, in any of its sentences', () => {
    const r = run(
      candidate({
        field: 'Load-in',
        value: '08:00',
        quote: 'Get-in 08:00',
        page: 2,
      })
    );
    expectReview(r, 'hedge_left_out');
    expect(r.text).toContain("'tbc' is in the same line but not in the value");
    const later = run(
      candidate({
        field: 'Load-out',
        value: '23:00',
        quote: 'Get-out from 23:00',
        page: 2,
      })
    );
    expectReview(later, 'hedge_left_out');
    expect(later.text).toContain(
      "'not' is in the same line but not in the value"
    );
  });

  test('a question mark is a hedge', () => {
    const asked: SourceText = {
      paged: false,
      pages: [page(1, ['Load-in 08:00?'])],
    };
    expectReview(
      run(
        candidate({ field: 'Load-in', value: '08:00', quote: 'Load-in 08:00' }),
        asked
      ),
      'hedge_left_out'
    );
  });

  test('a time missing am or pm is never filled in; one written the same way passes', () => {
    expectReview(
      run(
        candidate({
          field: 'Load-in',
          value: '08:30',
          quote: 'Load in 8.30 for the second crew',
          page: 2,
        })
      ),
      'not_written'
    );
    expectFound(
      run(
        candidate({
          field: 'Load-in',
          value: '8.30',
          quote: 'Load in 8.30',
          page: 2,
        })
      )
    );
  });

  test('a value that drops the source am or pm, or reads another hour, needs review', () => {
    const pm: SourceText = {
      paged: false,
      pages: [page(1, ['Show 8pm', 'Doors 20:00', 'Get-in 08:00'])],
    };
    expectReview(
      run(
        candidate({ field: 'Show time', value: '8:00', quote: 'Show 8pm' }),
        pm
      ),
      'left_out'
    );
    expectReview(
      run(
        candidate({ field: 'Show time', value: '8:00', quote: 'Doors 20:00' }),
        pm
      ),
      'disagree'
    );
    expectFound(
      run(
        candidate({ field: 'Load-in', value: '8:00', quote: 'Get-in 08:00' }),
        pm
      )
    );
    expectFound(
      run(
        candidate({ field: 'Show time', value: '20:00', quote: 'Show 8pm' }),
        pm
      )
    );
  });

  test('a bare number is never a time', () => {
    expectReview(
      run(
        candidate({
          field: 'Call time',
          value: '07:00',
          quote: 'Call at 7 for riggers',
          page: 2,
        })
      ),
      'quote_none'
    );
  });

  test('"£350/day + VAT": tax words and basis stay in the value', () => {
    const r = run(
      candidate({
        field: 'Rate',
        value: '£350/day + VAT',
        quote: 'Rate: £350/day + VAT',
        page: 2,
      })
    );
    expectFound(r);
    expect(r.label).toBe('rate');
    const noTax = run(
      candidate({
        field: 'Rate',
        value: '£350/day',
        quote: 'Rate: £350/day + VAT',
        page: 2,
      })
    );
    expectReview(noTax, 'left_out');
    expect(noTax.text).toContain('the tax words');
    expectReview(
      run(
        candidate({
          field: 'Rate',
          value: '£350 + VAT',
          quote: 'Rate: £350/day + VAT',
          page: 2,
        })
      ),
      'left_out'
    );
    expectReview(
      run(
        candidate({
          field: 'Rate',
          value: '£300/day + VAT',
          quote: 'Rate: £350/day + VAT',
          page: 2,
        })
      ),
      'disagree'
    );
  });

  test('no currency is inferred', () => {
    const plain: SourceText = {
      paged: false,
      pages: [page(1, ['Rate: 350 + VAT'])],
    };
    expectReview(
      run(
        candidate({
          field: 'Rate',
          value: '£350 + VAT',
          quote: 'Rate: 350 + VAT',
        }),
        plain
      ),
      'not_written'
    );
    expectFound(
      run(
        candidate({
          field: 'Rate',
          value: '350 + VAT',
          quote: 'Rate: 350 + VAT',
        }),
        plain
      )
    );
  });

  test('a number that reads two ways needs review', () => {
    expectFound(
      run(
        candidate({
          field: 'Rate',
          value: '€1.200,00',
          quote: 'Fee €1.200,00',
        }),
        {
          paged: false,
          pages: [page(1, ['Fee €1.200,00'])],
        }
      )
    );
    const r = run(
      candidate({ field: 'Rate', value: '€1.200', quote: 'Fee €1.200' }),
      { paged: false, pages: [page(1, ['Fee €1.200'])] }
    );
    expectReview(r, 'ambiguous_number');
  });

  test('a value with words the quote does not have needs review', () => {
    expectReview(
      run(
        candidate({
          field: 'Call time',
          value: '07:30 at stage door',
          quote: 'Crew call 07:30',
          page: 1,
          day: '2027-03-13',
          day_quote: 'Sat 13 March 2027',
        })
      ),
      'value_words_not_in_quote'
    );
  });

  test('a typed value keeps a hedge it carries, and then passes', () => {
    const tbc: SourceText = {
      paged: false,
      pages: [page(1, ['Load-in 08:00 TBC'])],
    };
    expectFound(
      run(
        candidate({
          field: 'Load-in',
          value: '08:00 TBC',
          quote: 'Load-in 08:00 TBC',
        }),
        tbc
      )
    );
    expectReview(
      run(
        candidate({
          field: 'Load-in',
          value: '08:00',
          quote: 'Load-in 08:00 TBC',
        }),
        tbc
      ),
      'hedge_left_out'
    );
  });

  test('a date value without a year is completed only from a full date on the same page', () => {
    const r = run(
      candidate({
        field: 'Check-in',
        value: '2027-03-12',
        quote: 'Check-in: Fri 12 March 2027',
      }),
      HOTEL
    );
    expectFound(r);
    const noYear: SourceText = {
      paged: false,
      pages: [
        page(1, [
          'Arriving Friday 12 March 2027',
          'Check-in: Fri 12 March',
          'Check-out: Sun 14 March 2027',
        ]),
      ],
    };
    const completed = run(
      candidate({
        field: 'Check-in',
        value: '2027-03-12',
        quote: 'Check-in: Fri 12 March',
      }),
      noYear
    );
    expectFound(completed);
    expect(completed.completions).toEqual(['year from p1']);
    expect(completed.text).toContain('year from p1');
    const twoYears: SourceText = {
      paged: false,
      pages: [
        page(1, [
          'Check-in: Fri 12 March',
          'Booked 20 December 2026',
          'Check-out: Sun 14 March 2027',
        ]),
      ],
    };
    expectReview(
      run(
        candidate({
          field: 'Check-in',
          value: '2027-03-12',
          quote: 'Check-in: Fri 12 March',
        }),
        twoYears
      ),
      'not_written'
    );
    // Another full date on the page never supplies the year.
    const otherDate: SourceText = {
      paged: false,
      pages: [
        page(1, ['Check-in: Fri 12 March', 'Check-out: Sun 14 March 2027']),
      ],
    };
    const other = run(
      candidate({
        field: 'Check-in',
        value: '2027-03-12',
        quote: 'Check-in: Fri 12 March',
      }),
      otherDate
    );
    expectReview(other, 'not_written');
    expect(other.text).toContain('p1 does not write that date in full');
  });

  test('a weekday that is given must agree with the date', () => {
    const wrong: SourceText = {
      paged: false,
      pages: [page(1, ['Show date: Sat 14 March 2027'])],
    };
    const r = run(
      candidate({
        field: 'Dates',
        value: '14 March 2027',
        quote: 'Show date: Sat 14 March 2027',
      }),
      wrong
    );
    expectReview(r, 'weekday_disagrees');
    expect(r.text).toContain('Sun 14 Mar 2027');
  });

  test('a value may not add a weekday the source does not write', () => {
    const plain: SourceText = {
      paged: false,
      pages: [page(1, ['Show date: 13 March 2027'])],
    };
    expectReview(
      run(
        candidate({
          field: 'Dates',
          value: 'Sat 13 March 2027',
          quote: 'Show date: 13 March 2027',
        }),
        plain
      ),
      'not_written'
    );
  });

  test('"14/03" reads one way; "12/03/2027" needs the month in words somewhere in the source', () => {
    const uk: SourceText = {
      paged: false,
      pages: [page(1, ['Arrival 14/03/2027'])],
    };
    expectFound(
      run(
        candidate({
          field: 'Check-in',
          value: '2027-03-14',
          quote: 'Arrival 14/03/2027',
        }),
        uk
      )
    );
    const resolved = run(
      candidate({
        field: 'Check-in',
        value: '2027-03-12',
        quote: 'Arrival 12/03/2027',
      }),
      HOTEL
    );
    expectFound(resolved);
    expect(resolved.text).toContain("'12/03/2027' read as 12 Mar from p1");
    const unresolved = run(
      candidate({
        field: 'Check-in',
        value: '2027-03-12',
        quote: 'Arrival 12/03/2027',
      }),
      NO_YEAR
    );
    expectReview(unresolved, 'ambiguous_date');
    expect(unresolved.text).toContain('12 Mar or 3 Dec');
  });

  test('Dates need a single date or one contiguous range in the quote', () => {
    const dates: SourceText = {
      paged: false,
      pages: [
        page(1, [
          'Dates: Fri 12 - Sat 13 March 2027',
          'Dates: 12th & 14th March 2027',
        ]),
      ],
    };
    expectFound(
      run(
        candidate({
          field: 'Dates',
          value: '12-13 March 2027',
          quote: 'Dates: Fri 12 - Sat 13 March 2027',
        }),
        dates
      )
    );
    expectReview(
      run(
        candidate({
          field: 'Dates',
          value: '12 March 2027',
          quote: 'Dates: 12th & 14th March 2027',
        }),
        dates
      ),
      'quote_several'
    );
  });
});

describe('check 4: the day is written', () => {
  const sat = {
    field: 'Call time' as const,
    value: '07:30',
    quote: 'Crew call 07:30',
    page: 1,
  };

  test('a day from the nearest heading above is Found, with the day kept', () => {
    const r = run(
      candidate({
        ...sat,
        label: 'Crew call',
        day: '2027-03-13',
        day_quote: 'Sat 13 March 2027',
      })
    );
    expectFound(r);
    expect(r.day).toBe('2027-03-13');
    expect(r.label).toBe('crew call');
    expect(r.page).toBe(1);
    expect(r.text).toBe(
      "Found on p1: value '07:30' matches '07:30'; label 'crew call'; day Sat 13 Mar 2027 from the heading 'Sat 13 March 2027'"
    );
  });

  test('on a call sheet with two day headings, a heading with another date between needs review', () => {
    const r = run(
      candidate({ ...sat, day: '2027-03-12', day_quote: 'Fri 12 March 2027' })
    );
    expectReview(r, 'date_between');
    expect(r.day).toBeUndefined();
  });

  test('a heading whose date is not the day needs review', () => {
    expectReview(
      run(
        candidate({ ...sat, day: '2027-03-12', day_quote: 'Sat 13 March 2027' })
      ),
      'disagree'
    );
  });

  test('a heading below the quote or on another page is not the heading', () => {
    expectReview(
      run(
        candidate({
          field: 'Call time',
          value: '07:00',
          quote: 'Crew call 07:00',
          page: 1,
          day: '2027-03-13',
          day_quote: 'Sat 13 March 2027',
        })
      ),
      'day_quote_not_found'
    );
  });

  test('a day named nowhere needs review', () => {
    expectReview(
      run(candidate({ ...sat, day: '2027-03-13' })),
      'day_not_written'
    );
  });

  test('a day in the quote itself is enough', () => {
    const r = run(
      candidate({
        field: 'Check-in',
        value: 'Fri 12 March 2027',
        quote: 'Check-in: Fri 12 March 2027',
        day: '2027-03-12',
      }),
      HOTEL
    );
    expectFound(r);
    expect(r.day).toBe('2027-03-12');
  });

  test('"the following day" needs review, with the calculation shown as one', () => {
    const r = run(
      candidate({
        field: 'Load-out',
        value: '01:00',
        quote: 'Load-out the following day 01:00',
        page: 1,
        day: '2027-03-14',
      })
    );
    expectReview(r, 'relative_day');
    expect(r.text).toBe(
      "Needs review: 'the following day' counted from 'sat 13 march 2027' is Sun 14 Mar 2027 (calculated, not written); it matches the day given"
    );
  });

  test('"Day 2" with no date is counted from "Day 1" and needs review', () => {
    const r = run(
      candidate({
        ...sat,
        page: undefined,
        day: '2027-03-13',
        day_quote: 'DAY 2',
      }),
      DAY_HEADINGS
    );
    expectReview(r, 'relative_day');
    expect(r.text).toContain(
      'is Sat 13 Mar 2027 (calculated, not written); it matches the day given'
    );
    const wrong = run(
      candidate({
        ...sat,
        page: undefined,
        day: '2027-03-14',
        day_quote: 'DAY 2',
      }),
      DAY_HEADINGS
    );
    expect(wrong.text).toContain('the day given is Sun 14 Mar 2027');
  });

  test('"Day 1" beside a written date is a label, not a relative day', () => {
    expectFound(
      run(
        candidate({
          field: 'Call time',
          value: '08:00',
          quote: 'Crew call 08:00',
          day: '2027-03-12',
          day_quote: 'DAY 1 - FRI 12 MARCH 2027',
        }),
        DAY_HEADINGS
      )
    );
  });

  test('a heading missing its month and year is completed from the page, or needs review', () => {
    expectReview(
      run(
        candidate({
          ...sat,
          page: undefined,
          day: '2027-03-13',
          day_quote: 'Sat 13th',
        }),
        NO_YEAR
      ),
      'not_written'
    );
    // An issue date never supplies the month and year of another day.
    expectReview(
      run(
        candidate({
          ...sat,
          page: undefined,
          day: '2027-03-13',
          day_quote: 'Sat 13th',
        }),
        ISSUED
      ),
      'not_written'
    );
    const r = run(
      candidate({
        ...sat,
        page: undefined,
        day: '2027-03-13',
        day_quote: 'Sat 13th',
      }),
      SHOW_DAY_IN_FULL
    );
    expectFound(r);
    expect(r.completions).toEqual(['month and year from p1']);
  });

  test('a dated line that is not a heading is not the day of the quote', () => {
    const r = run(
      candidate({
        ...sat,
        page: undefined,
        day: '2027-03-03',
        day_quote: '3 March 2027',
      }),
      ISSUED
    );
    expectReview(r, 'day_quote_not_heading');
  });

  test('a weekday-only day needs review', () => {
    expectReview(
      run(
        candidate({
          field: 'Call time',
          value: '08:00',
          quote: 'Call time is now 08:00 on the Saturday',
          page: 1,
          day: '2027-03-13',
        }),
        EMAIL
      ),
      'day_not_written'
    );
  });

  test('a day that is not a calendar date needs review', () => {
    expectReview(
      run(
        candidate({ ...sat, day: '2027-02-30', day_quote: 'Sat 13 March 2027' })
      ),
      'day_invalid'
    );
  });
});

describe('history pages', () => {
  test('a detail from quoted history is marked with the page date', () => {
    const r = run(
      candidate({
        field: 'Call time',
        value: '07:00',
        quote: 'Call time 07:00 on Sat 13 March 2027',
        page: 2,
        day: '2027-03-13',
      }),
      EMAIL
    );
    expectFound(r);
    expect(r.pageKind).toBe('history');
    expect(r.historyDate).toBe('2027-03-01T10:15:00Z');
    expect(
      r.text.startsWith('From quoted history dated 2027-03-01. Found on p2:')
    ).toBe(true);
  });
});

describe('checkDetails', () => {
  test('checks every detail of a source against one index', () => {
    const results = checkDetails(
      [
        candidate({
          field: 'Booking reference',
          value: 'MAL-77821',
          quote: 'Booking reference: MAL-77821',
        }),
        candidate({
          field: 'Hotel',
          value: 'Example Hotel Leeds',
          quote: 'Hotel: Example Hotel Leeds, 1 Sample Street, Leeds ZZ2 2ZZ',
        }),
        candidate({
          field: 'Check-out',
          value: 'Sun 14 March 2027',
          quote: 'Check-out: Sun 14 March 2027 by 11:00',
        }),
        candidate({
          field: 'Check-in',
          value: '15:00',
          quote: 'Check-in: Fri 12 March 2027 from 15:00',
        }),
      ],
      HOTEL
    );
    expect(results.map((r) => r.status)).toEqual([
      'Found',
      'Found',
      'Found',
      'Needs review',
    ]);
    expect(results[3]?.failed.map((f) => f.code)).toContain('value_not_parsed');
  });
});

describe('valueKey and scopeLabel', () => {
  test('two writings of the same value share a key', () => {
    expect(valueKey('Rate', '£350.00')).toBe(valueKey('Rate', 'GBP 350'));
    expect(valueKey('Call time', '08:00')).toBe(valueKey('Call time', '8am'));
    expect(valueKey('Call time', '08:00')).not.toBe(
      valueKey('Call time', '8:00')
    );
    expect(valueKey('Hotel', 'The  Example Hotel')).toBe(
      valueKey('Hotel', 'the example hotel')
    );
    expect(valueKey('PO number', 'PO-4500123')).toBe(
      valueKey('PO number', '4500123')
    );
    expect(valueKey('Check-in', '2027-03-12')).toBe(
      valueKey('Check-in', '12 March 2027')
    );
    expect(valueKey('Load-in', '08:00 TBC')).not.toBe(
      valueKey('Load-in', '08:00')
    );
    expect(valueKey('Rate', 'ex VAT £350')).toBe(
      valueKey('Rate', '£350 ex VAT')
    );
    expect(valueKey('Rate', '$350')).not.toBe(valueKey('Rate', 'USD 350'));
  });

  test('the label a check gives is the scope label derive uses', () => {
    for (const c of [
      candidate({
        field: 'Call time',
        value: '07:30',
        quote: 'Crew call 07:30',
        page: 1,
        day: '2027-03-13',
        day_quote: 'Sat 13 March 2027',
      }),
      candidate({
        field: 'Call time',
        label: 'CREW CALL',
        value: '07:30',
        quote: 'Crew call 07:30',
        page: 1,
        day: '2027-03-13',
        day_quote: 'Sat 13 March 2027',
      }),
      candidate({
        field: 'Rate',
        value: '£350/day + VAT',
        quote: 'Rate: £350/day + VAT',
        page: 2,
      }),
    ]) {
      expect(run(c).label).toBe(scopeLabel(c.field, c.label, c.quote));
    }
  });

  test('the scope label is the model label, else the longest lexicon label in the quote', () => {
    expect(scopeLabel('Call time', 'Crew Call', 'Crew call 07:00')).toBe(
      'crew call'
    );
    expect(scopeLabel('Call time', '', 'Crew call 07:00')).toBe('crew call');
    expect(scopeLabel('Load-in', '', 'Get-in 08:00')).toBe('get-in');
    expect(scopeLabel('Venue', '', 'Acme Arena')).toBe('');
  });
});

describe('labels that name the field alone', () => {
  const one = (line: string) => ({ paged: false, pages: [page(1, [line])] });

  test('a label shared with a field of the same kind does not name the field', () => {
    const r = run(
      candidate({
        field: 'Hotel address',
        value: '1 Sample Street, Leeds',
        quote: 'Address: 1 Sample Street, Leeds',
      }),
      one('Address: 1 Sample Street, Leeds')
    );
    expectReview(r, 'label_names_other_field');
    expect(r.text).toContain("'address' is a label for Venue address too");
    expectReview(
      run(
        candidate({
          field: 'Call time',
          value: '08:00',
          quote: 'Start time: 08:00',
        }),
        one('Start time: 08:00')
      ),
      'label_names_other_field'
    );
    expectFound(
      run(
        candidate({
          field: 'Venue address',
          value: '1 Sample Street, Leeds',
          quote: 'Venue address: 1 Sample Street, Leeds',
        }),
        one('Venue address: 1 Sample Street, Leeds')
      )
    );
  });

  test('a text field takes a typed field label only when its value is not that type', () => {
    expectFound(
      run(
        candidate({
          field: 'Event',
          value: 'Acme Gala',
          quote: 'Show: Acme Gala',
        }),
        one('Show: Acme Gala')
      )
    );
    expectReview(
      run(
        candidate({ field: 'Event', value: '19:30', quote: 'Show 19:30' }),
        one('Show 19:30')
      ),
      'label_names_other_field'
    );
    expectFound(
      run(
        candidate({ field: 'Show time', value: '19:30', quote: 'Show 19:30' }),
        one('Show 19:30')
      )
    );
  });

  test('"no" between a numbered noun and a reference is "number"', () => {
    expectFound(
      run(
        candidate({
          field: 'PO number',
          value: '4500123',
          quote: 'PO no 4500123',
        }),
        one('PO no 4500123')
      )
    );
  });
});

describe('tax words, headings and odd sources', () => {
  const one = (lines: string[]) => ({ paged: false, pages: [page(1, lines)] });

  test('tax words in the quote the parser does not join to the amount still stay in the value', () => {
    const r = run(
      candidate({
        field: 'Rate',
        value: '£350',
        quote: 'Fee: £350, VAT to be added',
      }),
      one(['Fee: £350, VAT to be added'])
    );
    expectReview(r, 'left_out');
    expect(r.text).toContain(
      "the tax words 'vat' in the quote are left out of the value"
    );
  });

  test('a date heading before the quote, on its line or the line above, is the day', () => {
    expectFound(
      run(
        candidate({
          field: 'Call time',
          value: '08:00',
          quote: 'crew call 08:00',
          day: '2027-03-12',
          day_quote: 'Fri 12 March 2027',
        }),
        one(['Fri 12 March 2027: crew call 08:00'])
      )
    );
    expectFound(
      run(
        candidate({
          field: 'Call time',
          value: '08:00',
          quote: 'Crew call 08:00',
          day: '2027-03-12',
          day_quote: 'Fri 12 March 2027',
        }),
        one(['Call sheet - Fri 12 March 2027', 'Crew call 08:00'])
      )
    );
  });

  test('an ambiguous numeric date is settled by the same date in words of the same year', () => {
    const r = run(
      candidate({
        field: 'Call time',
        value: '07:00',
        day: '2027-04-03',
        quote: 'Crew call 07:00 on 03/04/2027',
      }),
      one(['Issued 3 April 2027', 'Crew call 07:00 on 03/04/2027'])
    );
    expectFound(r);
    expect(r.text).toContain("'03/04/2027' read as 3 Apr from p1");
  });

  test('a source with no pages reads as a scan, and an impossible day never throws', () => {
    const r = checkDetail(
      candidate({
        field: 'Venue',
        value: 'Acme Hall',
        quote: 'Venue: Acme Hall',
      }),
      indexSource({ paged: false, pages: [] })
    );
    expectReview(r, 'scan_page');
    expect(r.text).toBe(`Needs review: ${SCAN_TEXT}`);
    const odd = run(
      candidate({
        field: 'Load-out',
        value: '09:00',
        quote: 'Load-out the following day 09:00',
        day: '2027-02-30',
      }),
      one(['Sat 13 March 2027', 'Load-out the following day 09:00'])
    );
    expectReview(odd, 'day_invalid', 'relative_day');
    expect(formatDay('2027-02-30')).toBe('2027-02-30');
  });

  test('a value or label holding any line break is refused, not thrown', () => {
    for (const value of ['07:00\u000b', '07:00\u2028', '07:00\r08:00']) {
      expectReview(
        run(
          candidate({ field: 'Call time', value, quote: 'Crew call 07:00' }),
          one(['Crew call 07:00'])
        ),
        'value_spans_lines'
      );
    }
    expectReview(
      run(
        candidate({
          field: 'Call time',
          label: 'Crew\u000ccall',
          value: '07:00',
          quote: 'Crew call 07:00',
        }),
        one(['Crew call 07:00'])
      ),
      'label_spans_lines'
    );
    expect(scopeLabel('Call time', '', 'Crew call\u000b07:00')).toBe('');
  });
});

describe('checkSourceDate', () => {
  const one = (line: string) =>
    indexSource({ paged: false, pages: [page(1, [line])] });

  test('an issue or revision date written in full is Found', () => {
    for (const [line, date] of [
      ['Issued: Wed 3 March 2027', '2027-03-03'],
      ['Revision 3 - 12 Feb 2027', '2027-02-12'],
      ['Call sheet 2 of 3 - 12 Feb 2027', '2027-02-12'],
    ] as const) {
      const r = checkSourceDate({ date, quote: line }, one(line));
      expect(r.status).toBe('Found');
      expect(r.date).toBe(date);
    }
  });

  test('another date, no year, two dates, a hedge or no such line needs review', () => {
    const review = (line: string, date: string, quote = line) => {
      const r = checkSourceDate({ date, quote }, one(line));
      expect(r.status).toBe('Needs review');
      expect(r.date).toBeUndefined();
      return r.text;
    };
    expect(review('Issued 3 March 2027', '2027-03-04')).toContain('4 Mar 2027');
    expect(review('Updated 3 March', '2027-03-03')).toContain('not written');
    review('Dates 12-14 March 2027', '2027-03-12');
    review('Revised date TBC: 3 March 2027', '2027-03-03');
    review('Issued 3 March 2027', '2027-03-03', 'Issued 4 March 2027');
    review('Issued 3 March 2027', '2027-02-30');
  });

  test('a paged source must name the page', () => {
    const r = checkSourceDate(
      { date: '2027-03-03', quote: 'Issued: Wed 3 March 2027' },
      sheet
    );
    expect(r.status).toBe('Needs review');
    expect(
      checkSourceDate(
        { date: '2027-03-03', quote: 'Issued: Wed 3 March 2027', page: 1 },
        sheet
      ).status
    ).toBe('Found');
  });
});
