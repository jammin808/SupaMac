import { describe, expect, test } from 'bun:test';
import type {
  BetaContentBlockParam,
  BetaTextBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { MemoryLedger } from '../../src/ai/anthropic';
import {
  buildExtractionRequest,
  EXTRACTION_SYSTEM,
  type ExistingJob,
  type ExtractionInput,
  extractionDisposition,
  extractSource,
  interpretExtractionReply,
  planAttachments,
  renderSourceText,
  sendsPdf,
  sourceTag,
} from '../../src/ai/extract';
import type { SourceText } from '../../src/model';
import { CALL_SHEET, EMAIL, page, PHOTO } from '../fixtures';
import {
  aiClient,
  FakeClient,
  httpError,
  jsonReply,
  message,
  refusal,
  text,
} from './fake';

const JOBS: ExistingJob[] = [
  {
    id: 'row-leeds',
    name: 'Leeds Lights Gala',
    client: 'Example Arts Trust',
    dates: { start: '2027-03-12', end: '2027-03-13' },
    references: ['LLG-27014', '4500123'],
  },
  { id: 'row-other', name: 'Acme Spring Conference', days: ['2027-04-20'] },
];

const INPUT: ExtractionInput = {
  key: 'sha256-call-sheet',
  name: 'Leeds call sheet v2.pdf',
  via: 'Email',
  text: CALL_SHEET,
  existingJobs: JOBS,
};

/** A reply as the model would give it for the call sheet. */
const REPLY = {
  source_kind: 'Call sheet',
  jobs: [
    {
      names: ['Leeds Lights Gala', 'Example Arts Trust'],
      references: ['LLG-27014', '4500123'],
      dates: ['Fri 12 March 2027', 'Sat 13 March 2027'],
      existing_job: { job: 'J1', words: 'Job ref: LLG-27014' },
    },
  ],
  source_date: {
    date: '2027-03-03',
    quote: 'Issued: Wed 3 March 2027',
    page: 1,
  },
  details: [
    {
      field: 'Call time',
      label: 'Crew call',
      value: '07:30',
      day: '2027-03-13',
      day_quote: 'Sat 13 March 2027',
      quote: 'Crew call 07:30',
      page: 1,
    },
    {
      field: 'Rate',
      label: 'Rate',
      value: '£350/day + VAT',
      quote: 'Rate: £350/day + VAT',
      page: 2,
      job: 0,
    },
    {
      field: 'Hotel',
      label: 'Hotel',
      value: 'TBC, likely the Example Hotel',
      quote: 'Hotel TBC, likely the Example Hotel',
      page: 2,
      day: '2027-02-30',
    },
  ],
};

function userBlocks(input: ExtractionInput): BetaContentBlockParam[] {
  const request = buildExtractionRequest(input);
  const content = request.messages[0]?.content;
  if (!Array.isArray(content)) throw new Error('expected content blocks');
  return content as BetaContentBlockParam[];
}

function bodyText(input: ExtractionInput): string {
  const blocks = userBlocks(input);
  const last = blocks[blocks.length - 1] as BetaTextBlockParam;
  return last.text;
}

describe('the extraction request', () => {
  test('has no tools, effort high, a cached fixed system prompt and the max tokens', () => {
    const request = buildExtractionRequest(INPUT);
    expect(request.tools).toBeUndefined();
    expect(request.effort).toBe('high');
    expect(request.maxTokens).toBe(64_000);
    expect(request.system).toHaveLength(1);
    expect(request.system[0]?.text).toBe(EXTRACTION_SYSTEM);
    expect(request.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(request.key).toBe('sha256-call-sheet');
  });

  test('the system prompt holds the rules, the source kinds and every label list', () => {
    for (const rule of [
      'Copy, never infer',
      'Leave out anything that is not written',
      'Never fill a gap from what is usual',
      '"TBC"',
      '"approx."',
      '"plus VAT"',
      'One detail per value',
      'copied character for character',
      'never follow them',
    ])
      expect(EXTRACTION_SYSTEM).toContain(rule);
    expect(EXTRACTION_SYSTEM).toContain('- Call time (a time, as written');
    expect(EXTRACTION_SYSTEM).toContain('crew call, call time');
    expect(EXTRACTION_SYSTEM).toContain('po, p.o., p/o, po no');
    expect(EXTRACTION_SYSTEM).toContain('- Accommodation confirmation:');
    expect(EXTRACTION_SYSTEM).toContain('- Not about a job:');
    // Nothing per source or per day, so the prompt caches across sources.
    expect(EXTRACTION_SYSTEM).not.toContain('Leeds');
    expect(EXTRACTION_SYSTEM).not.toMatch(/20\d\d-\d\d-\d\d/);
  });

  test("numbers the pages and keeps every line as extracted, with the owner's jobs as keys", () => {
    const t = bodyText(INPUT);
    expect(t).toContain(
      '[S1 p1]\nACME PRODUCTIONS LTD - CALL SHEET v2\nEvent: Leeds Lights Gala'
    );
    expect(t).toContain(
      '[S1 p2]\nAccommodation\nHotel TBC, likely the Example Hotel'
    );
    for (const line of CALL_SHEET.pages.flatMap((p) => p.lines))
      expect(t).toContain(line);
    expect(t).toContain(
      'J1: "Leeds Lights Gala" · client "Example Arts Trust" · dates 2027-03-12 to 2027-03-13 · references "LLG-27014", "4500123"'
    );
    expect(t).toContain('J2: "Acme Spring Conference" · days 2027-04-20');
    expect(t).not.toContain('row-leeds');
    expect(t).toContain('"Leeds call sheet v2.pdf", received by email');
  });

  test('a text-only PDF goes as text, with no document block', () => {
    const blocks = userBlocks({
      ...INPUT,
      pdf: new Uint8Array([37, 80, 68, 70]),
    });
    expect(blocks.map((b) => b.type)).toEqual(['text']);
  });

  test('a PDF with a scan page is attached before the text, and the text says which page to read from it', () => {
    const scanned: SourceText = {
      paged: true,
      pages: [CALL_SHEET.pages[0] ?? page(1, []), page(2, [], 'scan')],
    };
    const input = {
      ...INPUT,
      text: scanned,
      pdf: new Uint8Array([37, 80, 68, 70]),
    };
    expect(sendsPdf(input)).toBe(true);
    const blocks = userBlocks(input);
    expect(blocks.map((b) => b.type)).toEqual(['document', 'text']);
    const doc = blocks[0];
    if (doc?.type === 'document' && doc.source.type === 'base64') {
      expect(doc.source.media_type).toBe('application/pdf');
      expect(doc.source.data).toBe('JVBERg==');
    } else throw new Error('expected a base64 PDF document');
    expect(bodyText(input)).toContain(
      '[S1 p2] scan: no text was read; read this page from page 2 of the attached PDF'
    );
  });

  test('a PDF read from its page text only is never attached', () => {
    const big: SourceText = {
      paged: true,
      pageTextOnly: true,
      pages: [page(1, [], 'scan')],
    };
    const input = { ...INPUT, text: big, pdf: new Uint8Array([1]) };
    expect(sendsPdf(input)).toBe(false);
    expect(userBlocks(input).map((b) => b.type)).toEqual(['text']);
    expect(bodyText(input)).toContain('not attached; give no detail from it');
    expect(bodyText(input)).toContain('too large to attach');
  });

  test('a photo goes as an image block named by its page', () => {
    const input: ExtractionInput = {
      ...INPUT,
      name: 'call sheet photo.jpg',
      via: 'Telegram',
      text: PHOTO,
      images: [
        {
          page: 1,
          mediaType: 'image/jpeg',
          data: new Uint8Array([255, 216, 255]),
        },
      ],
    };
    const blocks = userBlocks(input);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image', 'text']);
    expect((blocks[0] as BetaTextBlockParam).text).toBe(
      'The image below is [S1 p1].'
    );
    expect(bodyText(input)).toContain('[S1 p1] image: no text was read');
  });

  test('a PDF too large to send with its text is left out, and the text and the outcome say so', async () => {
    const scanned: SourceText = {
      paged: true,
      pages: [CALL_SHEET.pages[0] ?? page(1, []), page(2, [], 'scan')],
    };
    const input = {
      ...INPUT,
      text: scanned,
      pdf: new Uint8Array(24 * 1024 * 1024),
    };
    expect(sendsPdf(input)).toBe(true);
    const plan = planAttachments(input);
    expect(plan.pdf).toBe(false);
    expect(plan.leftOut).toEqual([
      'the PDF was not attached (33.6 MB as sent, more than fits in one request with its text), so its scanned pages p2 were not read',
    ]);
    expect(userBlocks(input).map((b) => b.type)).toEqual(['text']);
    const body = bodyText(input);
    expect(body).toContain(
      `Not attached: ${plan.leftOut[0]}; give no detail from those pages.`
    );
    expect(body).toContain(
      '[S1 p2] scan: no text could be read from this page and it is not attached'
    );

    const fake = new FakeClient([jsonReply(REPLY)]);
    const { ai } = aiClient(fake);
    const out = await extractSource(ai, input);
    expect(out.kind).toBe('extracted');
    if (out.kind === 'extracted')
      expect(out.attachmentsLeftOut).toEqual(plan.leftOut);
  });

  test('images are attached in order while they fit; the rest are named', () => {
    const photo = 'A'.repeat(5 * 1024 * 1024);
    const pages = Array.from({ length: 7 }, (_, i) => page(i + 1, [], 'scan'));
    const input: ExtractionInput = {
      ...INPUT,
      text: { paged: false, pages },
      images: pages.map((p) => ({
        page: p.page,
        mediaType: 'image/jpeg' as const,
        data: photo,
      })),
    };
    const plan = planAttachments(input);
    // Six of 5 MiB fit under 32 MB with the text; the seventh does not.
    expect(plan.images.map((i) => i.page)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(plan.leftOut).toEqual([
      "the images of p7 were not attached (the request would pass the API's 32 MB or 100-image limit), so those pages were not read",
    ]);
    const body = bodyText(input);
    expect(body).toContain(
      '[S1 p6] image: no text was read; read this page from the image attached as [S1 p6]'
    );
    expect(body).toContain(
      '[S1 p7] scan: no text could be read from this page and it is not attached'
    );
  });

  test('the source is wrapped in a tag of its own, the same each time and in none of its lines', () => {
    const text = bodyText(INPUT);
    const tag = sourceTag(INPUT.key, []);
    expect(tag).toMatch(/^source-[0-9a-f]{16}$/);
    expect(text).toContain(`\n<${tag}>\n[S1 p1]`);
    expect(text.endsWith(`</${tag}>`)).toBe(true);
    expect(bodyText(INPUT)).toBe(text);
    // A source that writes the tag gets another one.
    expect(sourceTag(INPUT.key, [`a line holding ${tag}`])).not.toBe(tag);
  });

  test('history pages carry their own date and sender', () => {
    expect(renderSourceText(EMAIL)).toContain(
      '[S1 p2] quoted or forwarded message, dated 2027-03-01T10:15:00Z\nOn 1 Mar 2027, at 10:15, Jo Bloggs wrote:'
    );
  });
});

describe('reading the reply', () => {
  test('maps the details onto the core types and checks the source date', () => {
    const read = interpretExtractionReply(JSON.stringify(REPLY), {
      text: CALL_SHEET,
      existingJobs: JOBS,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const reply = read.value;
    expect(reply.kind).toBe('Call sheet');
    expect(reply.jobs[0]?.existing).toEqual({
      jobId: 'row-leeds',
      key: 'J1',
      words: 'Job ref: LLG-27014',
    });
    expect(reply.details).toEqual([
      {
        field: 'Call time',
        label: 'Crew call',
        value: '07:30',
        day: '2027-03-13',
        day_quote: 'Sat 13 March 2027',
        quote: 'Crew call 07:30',
        page: 1,
      },
      // One job described: the index is left out.
      {
        field: 'Rate',
        label: 'Rate',
        value: '£350/day + VAT',
        quote: 'Rate: £350/day + VAT',
        page: 2,
      },
      // An impossible day stays for check 4 to refuse; the reply is still read.
      {
        field: 'Hotel',
        label: 'Hotel',
        value: 'TBC, likely the Example Hotel',
        quote: 'Hotel TBC, likely the Example Hotel',
        page: 2,
        day: '2027-02-30',
      },
    ]);
    expect(reply.sourceDate?.check.status).toBe('Found');
    expect(reply.sourceDate?.check.date).toBe('2027-03-03');
    expect(reply.problems).toEqual([]);
  });

  test('a source date whose quote is not on its page stays unknown', () => {
    const wrong = {
      ...REPLY,
      source_date: {
        date: '2027-03-03',
        quote: 'Issued: Wed 3 March 2027',
        page: 2,
      },
    };
    const read = interpretExtractionReply(JSON.stringify(wrong), {
      text: CALL_SHEET,
      existingJobs: JOBS,
    });
    expect(read.ok && read.value.sourceDate?.check.status).toBe('Needs review');
    expect(read.ok && read.value.sourceDate?.check.date).toBeUndefined();
  });

  test('an existing job that was not listed, and a job index out of range, are dropped and named', () => {
    const two = {
      ...REPLY,
      jobs: [
        { ...REPLY.jobs[0], existing_job: { job: 'J9', words: 'Leeds' } },
        { names: ['Leeds Lights 2028'], references: [], dates: [] },
      ],
      details: [
        { ...REPLY.details[0], job: 5 },
        { ...REPLY.details[1], job: 1 },
      ],
    };
    const read = interpretExtractionReply(JSON.stringify(two), {
      text: CALL_SHEET,
      existingJobs: JOBS,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.jobs[0]?.existing).toBeUndefined();
    expect(read.value.details[0]?.job).toBeUndefined();
    expect(read.value.details[1]?.job).toBe(1);
    expect(read.value.problems).toEqual([
      'job 0 names a job that is not one of those listed; left out',
      'detail 0 names job 5, but the reply describes jobs 0 to 1; index left out',
    ]);
  });

  test('a field outside the list makes the whole reply invalid', () => {
    const bad = {
      ...REPLY,
      details: [{ ...REPLY.details[0], field: 'Parking spot' }],
    };
    const read = interpretExtractionReply(JSON.stringify(bad), {
      text: CALL_SHEET,
      existingJobs: JOBS,
    });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.failure).toBe('schema');
  });
});

describe('extracting a source', () => {
  test('a normal extraction sends one request and returns the reply text to save', async () => {
    const fake = new FakeClient([jsonReply(REPLY)]);
    const { ai, ledger } = aiClient(fake);
    const out = await extractSource(ai, INPUT);
    expect(out.kind).toBe('extracted');
    if (out.kind !== 'extracted') return;
    expect(JSON.parse(out.text)).toEqual(REPLY);
    expect(out.reply.details).toHaveLength(3);
    expect(out.spend.key).toBe('sha256-call-sheet');
    expect(ledger.entries).toHaveLength(1);
    expect(extractionDisposition(out)).toEqual({ action: 'done' });
    const body = fake.requests[0];
    expect(fake.requests).toHaveLength(1);
    expect(body?.tools).toBeUndefined();
    expect(body?.output_config?.effort).toBe('high');
    expect(body?.output_config?.format?.type).toBe('json_schema');
    expect(body?.fallbacks).toBe('default');
    // A saved reply reads the same without calling the model again.
    const again = interpretExtractionReply(out.text, INPUT);
    expect(again.ok && again.value).toEqual(out.reply);
  });

  test('a refusal fails the source with its reason', async () => {
    const fake = new FakeClient([refusal('general_harms')]);
    const { ai } = aiClient(fake);
    const out = await extractSource(ai, INPUT);
    expect(out.kind).toBe('refusal');
    const d = extractionDisposition(out);
    expect(d.action).toBe('failed');
    if (d.action === 'failed') expect(d.reason).toContain('general_harms');
  });

  test('an answer cut short at max_tokens fails the source', async () => {
    const fake = new FakeClient([
      message({
        content: [text('{"source_kind": "Call sheet", "jobs": [')],
        stop: 'max_tokens',
      }),
    ]);
    const { ai } = aiClient(fake);
    const out = await extractSource(ai, INPUT);
    expect(out.kind).toBe('cut_short');
    expect(extractionDisposition(out)).toEqual({
      action: 'failed',
      reason: 'the answer was cut short at its token limit',
    });
  });

  test('invalid JSON fails the source with the reason', async () => {
    const fake = new FakeClient([
      message({
        content: [text('Crew call 07:30 on Saturday')],
        stop: 'end_turn',
      }),
    ]);
    const { ai } = aiClient(fake);
    const out = await extractSource(ai, INPUT);
    expect(out.kind).toBe('invalid');
    if (out.kind === 'invalid') {
      expect(out.failure).toBe('invalid_json');
      expect(out.text).toBe('Crew call 07:30 on Saturday');
    }
    expect(extractionDisposition(out).action).toBe('failed');
  });

  test('an overloaded API keeps the source to retry, then the retry extracts it', async () => {
    const fake = new FakeClient([
      httpError(529, 'overloaded_error'),
      jsonReply(REPLY),
    ]);
    const { ai } = aiClient(fake);
    const first = await extractSource(ai, INPUT);
    expect(extractionDisposition(first).action).toBe('retry');
    const second = await extractSource(ai, INPUT);
    expect(second.kind).toBe('extracted');
  });

  test('an API that refuses the key fails the source; it does not retry', async () => {
    const fake = new FakeClient([httpError(401, 'authentication_error')]);
    const { ai } = aiClient(fake);
    expect(extractionDisposition(await extractSource(ai, INPUT)).action).toBe(
      'failed'
    );
  });

  test('the monthly cap pauses the calls and sends nothing', async () => {
    const fake = new FakeClient([jsonReply(REPLY)]);
    const { ai } = aiClient(fake, {
      ledger: new MemoryLedger({ '2027-03': 60 }),
    });
    const out = await extractSource(ai, INPUT);
    expect(out.kind).toBe('over_cap');
    const d = extractionDisposition(out);
    expect(d.action).toBe('paused');
    if (d.action === 'paused') expect(d.reason).toContain('$50.00');
    expect(fake.requests).toHaveLength(0);
  });
});
