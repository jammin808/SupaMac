import { describe, expect, test } from 'bun:test';
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  ANSWER_SYSTEM,
  ANSWER_TOOLS,
  type AnswerDetail,
  type AnswerJob,
  type AnswerSource,
  type AnswerTools,
  answerQuestion,
  type DetailsQuery,
  dayContext,
  echoContent,
  type JobsQuery,
  keepCitedLinks,
  linksIn,
  MAX_CALLS_PER_ROUND,
  MAX_RESULT_CHARS,
  numberOrDate,
  renderDetail,
  vouchedFor,
} from '../../src/ai/answer';
import {
  aiClient,
  FakeClient,
  fallbackBlock,
  jsonReply,
  message,
  NOW,
  refusal,
  text,
  thinking,
  toolUse,
} from './fake';

const CALL_SHEET: AnswerSource = {
  id: 'src-call-sheet',
  name: 'Leeds call sheet v2.pdf',
  kind: 'Call sheet',
  via: 'Email',
  status: 'Processed',
};
const HOTEL: AnswerSource = {
  id: 'src-hotel',
  name: 'Example Hotel booking confirmation',
  kind: 'Accommodation confirmation',
  via: 'Email',
  status: 'Processed',
};
const OLD_EMAIL: AnswerSource = {
  id: 'src-email',
  name: 'Re: Leeds Lights Gala crew',
  kind: 'Invite',
  via: 'Email',
  status: 'Processed',
};

const LEEDS: AnswerJob = {
  id: 'row-leeds',
  name: 'Leeds Lights Gala',
  client: 'Example Arts Trust',
  dates: { start: '2027-03-12', end: '2027-03-13' },
};

function detail(
  fields: Partial<AnswerDetail> &
    Pick<AnswerDetail, 'id' | 'field' | 'value' | 'quote'>
): AnswerDetail {
  return {
    jobId: 'row-leeds',
    label: fields.field,
    status: 'Found',
    check: 'Found on p1',
    origin: 'document',
    source: CALL_SHEET,
    ...fields,
  };
}

const DETAILS: AnswerDetail[] = [
  detail({
    id: 'd-call-sat',
    field: 'Call time',
    label: 'Crew call',
    value: '07:30',
    day: '2027-03-13',
    quote: 'Crew call 07:30',
    page: 1,
  }),
  detail({
    id: 'd-call-fri',
    field: 'Call time',
    label: 'Crew call',
    value: '07:00',
    day: '2027-03-12',
    quote: 'Crew call 07:00, performers 09:00',
    page: 1,
    status: 'Confirmed',
  }),
  detail({
    id: 'd-hotel',
    field: 'Hotel',
    value: 'Example Hotel Leeds, 1 Sample Mews, Leeds ZZ2 2ZZ',
    quote: 'Hotel: Example Hotel Leeds, 1 Sample Mews, Leeds ZZ2 2ZZ',
    source: HOTEL,
  }),
  detail({
    id: 'd-parking',
    field: 'Access and parking',
    label: 'Parking',
    value: 'see https://example.com/acme-arena/parking',
    quote: 'Parking: see https://example.com/acme-arena/parking',
    page: 2,
  }),
  detail({
    id: 'd-old-rate',
    field: 'Rate',
    value: '£300 per day',
    quote: 'Rate £300 per day',
    page: 2,
    status: 'Replaced',
    source: OLD_EMAIL,
  }),
];

const PENDING: AnswerDetail = detail({
  id: 'd-hotel-tbc',
  field: 'Hotel',
  value: 'TBC, likely the Example Hotel',
  quote: 'Hotel TBC, likely the Example Hotel',
  page: 2,
  status: 'Needs review',
  check: "Needs review: 'TBC' is on the same line",
});

const FAILED: AnswerSource = {
  id: 'src-rider',
  name: 'Leeds rider.docx',
  status: 'Failed',
  note: 'the extraction ran out of time',
};

interface Calls {
  jobs: JobsQuery[];
  details: DetailsQuery[];
  sourceText: string[];
  jobStatus: string[];
}

function tools(
  options: { jobs?: AnswerJob[]; partial?: boolean; failJobs?: boolean } = {}
): { tools: AnswerTools; calls: Calls } {
  const calls: Calls = { jobs: [], details: [], sourceText: [], jobStatus: [] };
  const jobs = options.jobs ?? [LEEDS];
  return {
    calls,
    tools: {
      jobs: async (q) => {
        calls.jobs.push(q);
        if (options.failJobs) throw new Error('SupaMac did not answer');
        return { jobs, partial: options.partial ?? false };
      },
      details: async (q) => {
        calls.details.push(q);
        const job = jobs.find((j) => j.id === q.job);
        if (!job) return undefined;
        return {
          job,
          details: DETAILS.filter(
            (d) =>
              d.jobId === q.job &&
              (q.field === undefined || d.field === q.field) &&
              (q.day === undefined || d.day === q.day)
          ),
          partial: false,
        };
      },
      sourceText: async (id) => {
        calls.sourceText.push(id);
        return {
          source: CALL_SHEET,
          pages: [{ page: 1, lines: ['Sat 13 March 2027', 'Crew call 07:30'] }],
          partial: false,
        };
      },
      jobStatus: async (id) => {
        calls.jobStatus.push(id);
        const job = jobs.find((j) => j.id === id);
        if (!job) return undefined;
        return { job, pending: [PENDING], failed: [FAILED], partial: false };
      },
    },
  };
}

function toolResults(
  m: BetaMessageParam | undefined
): BetaToolResultBlockParam[] {
  if (!m || !Array.isArray(m.content)) return [];
  return (m.content as BetaContentBlockParam[]).filter(
    (b): b is BetaToolResultBlockParam => b.type === 'tool_result'
  );
}

const ASK_JOBS = message({
  content: [
    thinking(),
    toolUse('tu-jobs', 'jobs', { from: '2027-03-13', to: '2027-03-13' }),
  ],
  stop: 'tool_use',
});
const ASK_DETAILS = message({
  content: [
    toolUse('tu-details', 'details', {
      job: 'row-leeds',
      field: 'Call time',
      day: '2027-03-13',
    }),
  ],
  stop: 'tool_use',
});
const ASK_ALL_DETAILS = message({
  content: [toolUse('tu-all', 'details', { job: 'row-leeds' })],
  stop: 'tool_use',
});

function answer(statements: unknown[]) {
  return jsonReply({ statements });
}

describe('days in the owner zone', () => {
  test('today and tomorrow in London on Friday 12 March 2027', () => {
    const days = dayContext(NOW, 'Europe/London');
    expect(days.today).toBe('2027-03-12');
    expect(days.tomorrow).toBe('2027-03-13');
    expect(days.yesterday).toBe('2027-03-11');
    expect(days.week.map((d) => d.weekday)).toEqual([
      'Friday',
      'Saturday',
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
    ]);
    expect(days.weekend).toEqual({ start: '2027-03-13', end: '2027-03-14' });
    expect(days.thisWeek).toEqual({ start: '2027-03-08', end: '2027-03-14' });
    expect(days.nextWeek).toEqual({ start: '2027-03-15', end: '2027-03-21' });
  });

  test('the same instant is already Saturday in Auckland', () => {
    const days = dayContext(
      new Date('2027-03-12T23:30:00Z'),
      'Pacific/Auckland'
    );
    expect(days.today).toBe('2027-03-13');
    expect(days.weekend).toEqual({ start: '2027-03-13', end: '2027-03-14' });
    expect(
      dayContext(new Date('2027-03-12T23:30:00Z'), 'Europe/London').today
    ).toBe('2027-03-12');
  });

  test('on a Sunday the weekend is today alone, and across the clock change days stay whole', () => {
    const sunday = dayContext(
      new Date('2027-03-28T12:00:00Z'),
      'Europe/London'
    );
    expect(sunday.today).toBe('2027-03-28');
    expect(sunday.weekend).toEqual({ start: '2027-03-28', end: '2027-03-28' });
    const night = dayContext(new Date('2027-03-27T23:30:00Z'), 'Europe/London');
    expect(night.today).toBe('2027-03-27');
    expect(night.tomorrow).toBe('2027-03-28');
  });
});

describe('the question loop', () => {
  test('two tool rounds, then the values are written by the service from the details', async () => {
    const fake = new FakeClient([
      ASK_JOBS,
      ASK_DETAILS,
      answer([
        { kind: 'details', words: 'Your crew call', details: ['d-call-sat'] },
      ]),
    ]);
    const { ai, ledger } = aiClient(fake);
    const t = tools();
    const out = await answerQuestion(ai, {
      question: 'What time is my call tomorrow?',
      now: NOW,
      timeZone: 'Europe/London',
      tools: t.tools,
    });
    expect(out.kind).toBe('answered');
    if (out.kind !== 'answered') return;
    expect(out.rounds).toBe(2);
    expect(out.rendered.lines).toEqual([
      'Your crew call:',
      `• Call time, Sat 13 Mar 2027 (tomorrow): 07:30 (the call sheet "Leeds call sheet v2.pdf", p1, says 'Crew call 07:30'; not confirmed by you)`,
      'Awaiting your review for "Leeds Lights Gala":',
      `• Hotel: TBC, likely the Example Hotel (the call sheet "Leeds call sheet v2.pdf", p2, says 'Hotel TBC, likely the Example Hotel'; awaiting your review: 'TBC' is on the same line)`,
      'Sources that failed for "Leeds Lights Gala":',
      '• "Leeds rider.docx": the extraction ran out of time',
    ]);
    expect(out.rendered.cited).toEqual(['d-call-sat']);
    expect(out.rendered.nothingFound).toBe(false);
    expect(t.calls.jobs).toEqual([{ from: '2027-03-13', to: '2027-03-13' }]);
    expect(t.calls.details).toEqual([
      { job: 'row-leeds', field: 'Call time', day: '2027-03-13' },
    ]);
    expect(t.calls.jobStatus).toEqual(['row-leeds']);
    expect(out.spends).toHaveLength(3);
    expect(ledger.entries).toHaveLength(3);

    // Every request: the three fixed tools, cached, at effort medium, tools on.
    expect(fake.requests).toHaveLength(3);
    for (const body of fake.requests) {
      expect(
        body.tools?.map((tool) => ('name' in tool ? tool.name : ''))
      ).toEqual(['jobs', 'details', 'source_text']);
      expect(body.tools?.[2]).toHaveProperty('cache_control', {
        type: 'ephemeral',
      });
      expect(
        body.tools?.every((tool) => 'strict' in tool && tool.strict === true)
      ).toBe(true);
      expect(body.system).toEqual([
        {
          type: 'text',
          text: ANSWER_SYSTEM,
          cache_control: { type: 'ephemeral' },
        },
      ]);
      expect(body.output_config?.effort).toBe('medium');
      expect(body.output_config?.format?.type).toBe('json_schema');
      expect(body.tool_choice).toEqual({ type: 'auto' });
      expect(body.cache_control).toEqual({ type: 'ephemeral' });
      expect(body.fallbacks).toBe('default');
    }
    // The days were worked out by the service and given with the question.
    const first = fake.requests[0]?.messages[0];
    const firstText =
      first && Array.isArray(first.content) && first.content[0]?.type === 'text'
        ? first.content[0].text
        : '';
    expect(firstText).toContain('- today: Friday 2027-03-12');
    expect(firstText).toContain('- tomorrow: 2027-03-13');
    expect(firstText).toContain('What time is my call tomorrow?');
    // The assistant turn is echoed unchanged and the results follow it.
    const third = fake.requests[2]?.messages ?? [];
    expect(third).toHaveLength(5);
    expect(third[1]).toEqual({ role: 'assistant', content: ASK_JOBS.content });
    const jobsResult = toolResults(third[2])[0];
    expect(jobsResult?.tool_use_id).toBe('tu-jobs');
    expect(JSON.parse(String(jobsResult?.content)).jobs[0].id).toBe(
      'row-leeds'
    );
    const detailsResult = JSON.parse(String(toolResults(third[4])[0]?.content));
    expect(detailsResult.details.map((d: { id: string }) => d.id)).toEqual([
      'd-call-sat',
    ]);
  });

  test('a value the model types itself is never shown', async () => {
    const fake = new FakeClient([
      ASK_JOBS,
      ASK_ALL_DETAILS,
      answer([
        {
          kind: 'details',
          words: 'Crew call is 08:00',
          details: ['d-call-sat'],
        },
        { kind: 'note', text: 'Your call is at 08:00, so leave by 06:30.' },
      ]),
    ]);
    const { ai } = aiClient(fake);
    const out = await answerQuestion(ai, {
      question: 'When is my call on Saturday?',
      now: NOW,
      timeZone: 'Europe/London',
      tools: tools().tools,
    });
    expect(out.kind).toBe('answered');
    if (out.kind !== 'answered') return;
    const shown = out.rendered.text;
    expect(shown).not.toContain('08:00');
    expect(shown).not.toContain('06:30');
    expect(shown).toContain(
      'Call time, Sat 13 Mar 2027 (tomorrow): 07:30 (the call sheet'
    );
    expect(out.rendered.refused).toEqual([
      'Words of the answer were left out: they gave a number or date of their own, not from a detail and not labelled as an estimate.',
      'A sentence of the answer was left out: it gave a number or date without labelling it as an estimate with its basis.',
    ]);
  });

  test('a date in free text is refused unless it is an estimate with its basis', async () => {
    const fake = new FakeClient([
      ASK_JOBS,
      ASK_ALL_DETAILS,
      answer([
        { kind: 'note', text: 'The load-out is on Sunday night.' },
        {
          kind: 'estimate',
          estimate: 'about 9 hours on site',
          basis: 'from the crew call to the curfew',
          details: ['d-call-sat'],
        },
        { kind: 'estimate', estimate: 'Monday', basis: '', details: [] },
      ]),
    ]);
    const { ai } = aiClient(fake);
    const out = await answerQuestion(ai, {
      question: 'How long is Saturday?',
      now: NOW,
      timeZone: 'Europe/London',
      tools: tools().tools,
    });
    expect(out.kind).toBe('answered');
    if (out.kind !== 'answered') return;
    expect(out.rendered.text).not.toContain('Sunday night');
    expect(out.rendered.text).not.toContain('Monday');
    expect(out.rendered.lines).toContain(
      'Estimate (not checked): about 9 hours on site. Based on: from the crew call to the curfew.'
    );
    expect(out.rendered.refused).toContain(
      'An estimate was left out: it did not say what it is based on.'
    );
    expect(out.rendered.refused).toContain(
      'A sentence of the answer was left out: it gave a number or date without labelling it as an estimate with its basis.'
    );
  });

  test('a link is kept only when a cited detail writes it', async () => {
    const fake = new FakeClient([
      ASK_JOBS,
      ASK_ALL_DETAILS,
      answer([
        {
          kind: 'details',
          words:
            'Parking is explained at https://example.com/acme-arena/parking',
          details: ['d-parking'],
        },
        {
          kind: 'note',
          text: 'There is also a map at https://maps.example.net/leeds.',
        },
        {
          kind: 'details',
          words: 'Directions: www.example.org/route',
          details: ['d-hotel'],
        },
      ]),
    ]);
    const { ai } = aiClient(fake);
    const out = await answerQuestion(ai, {
      question: 'Where do I park?',
      now: NOW,
      timeZone: 'Europe/London',
      tools: tools().tools,
    });
    expect(out.kind).toBe('answered');
    if (out.kind !== 'answered') return;
    const lines = out.rendered.lines;
    // The link is kept; "explained" is the model's own word, so the words are not vouched for.
    expect(lines[0]).toBe(
      'Parking is explained at https://example.com/acme-arena/parking (not checked):'
    );
    expect(lines).toContain(
      '(not checked) There is also a map at [link left out].'
    );
    expect(lines).toContain('Directions: [link left out]:');
    expect(out.rendered.text).not.toContain('maps.example.net');
    expect(out.rendered.text).not.toContain('example.org');
    expect(out.rendered.refused).toEqual([
      'A link that is in no cited detail was left out.',
    ]);
  });

  test('nothing found is decided from the tool results', async () => {
    const fake = new FakeClient([
      message({
        content: [
          toolUse('tu-1', 'jobs', { from: '2027-04-01', to: '2027-04-30' }),
        ],
        stop: 'tool_use',
      }),
      answer([{ kind: 'not_found', what: 'there is no job then' }]),
    ]);
    const { ai } = aiClient(fake);
    const t = tools({ jobs: [] });
    const out = await answerQuestion(ai, {
      question: 'Am I working in April?',
      now: NOW,
      timeZone: 'Europe/London',
      tools: t.tools,
    });
    expect(out.kind).toBe('answered');
    if (out.kind !== 'answered') return;
    expect(out.rendered.nothingFound).toBe(true);
    expect(out.rendered.lines).toEqual([
      '(not checked) Not found: there is no job then',
      'Nothing found in the Jobs database (jobs with a day from Thu 1 Apr 2027 to Fri 30 Apr 2027: 0).',
    ]);
    expect(t.calls.jobStatus).toEqual([]);
  });

  test('details found but none cited is not "nothing found"', async () => {
    const fake = new FakeClient([
      ASK_JOBS,
      ASK_ALL_DETAILS,
      answer([
        {
          kind: 'not_found',
          what: 'the call sheet says nothing about catering',
        },
      ]),
    ]);
    const { ai } = aiClient(fake);
    const out = await answerQuestion(ai, {
      question: 'Is there catering?',
      now: NOW,
      timeZone: 'Europe/London',
      tools: tools().tools,
    });
    expect(out.kind).toBe('answered');
    if (out.kind !== 'answered') return;
    expect(out.rendered.nothingFound).toBe(false);
    expect(out.rendered.lines[1]).toBe(
      'No detail was given as the answer; the search returned 5 details (jobs with a day from Sat 13 Mar 2027 (tomorrow) to Sat 13 Mar 2027 (tomorrow): 1; details of "Leeds Lights Gala": 5).'
    );
    // The review list follows for the job whose details were read.
    expect(out.rendered.lines).toContain(
      'Awaiting your review for "Leeds Lights Gala":'
    );
  });

  test('a replaced detail is shown only as what it was; an id no tool returned is left out', async () => {
    const fake = new FakeClient([
      ASK_JOBS,
      ASK_ALL_DETAILS,
      answer([
        {
          kind: 'details',
          words: 'The rate',
          details: ['d-old-rate', 'd-invented'],
        },
      ]),
    ]);
    const { ai } = aiClient(fake);
    const out = await answerQuestion(ai, {
      question: "What's the rate?",
      now: NOW,
      timeZone: 'Europe/London',
      tools: tools().tools,
    });
    expect(out.kind).toBe('answered');
    if (out.kind !== 'answered') return;
    expect(out.rendered.lines.slice(0, 2)).toEqual([
      'The rate:',
      `• Rate: was '£300 per day' (replaced; the invite "Re: Leeds Lights Gala crew", p2)`,
    ]);
    expect(out.rendered.refused).toEqual([
      'A detail the search did not return was left out.',
    ]);
  });

  test('details of a job no jobs result named is refused to the model, not run', async () => {
    const fake = new FakeClient([
      message({
        content: [toolUse('tu-guess', 'details', { job: 'row-guessed' })],
        stop: 'tool_use',
      }),
      answer([{ kind: 'not_found', what: 'no such job' }]),
    ]);
    const { ai } = aiClient(fake);
    const t = tools();
    const out = await answerQuestion(ai, {
      question: 'What about the other job?',
      now: NOW,
      timeZone: 'Europe/London',
      tools: t.tools,
    });
    expect(out.kind).toBe('answered');
    expect(t.calls.details).toEqual([]);
    const result = toolResults(fake.requests[1]?.messages[2])[0];
    expect(result?.is_error).toBe(true);
    expect(String(result?.content)).toContain('unknown job');
  });

  test('tool input that does not match its schema is refused to the model', async () => {
    const fake = new FakeClient([
      message({
        content: [toolUse('tu-bad', 'jobs', { from: '13/03/2027' })],
        stop: 'tool_use',
      }),
      answer([]),
    ]);
    const { ai } = aiClient(fake);
    const t = tools();
    await answerQuestion(ai, {
      question: 'Saturday?',
      now: NOW,
      timeZone: 'Europe/London',
      tools: t.tools,
    });
    expect(t.calls.jobs).toEqual([]);
    const result = toolResults(fake.requests[1]?.messages[2])[0];
    expect(result?.is_error).toBe(true);
    expect(String(result?.content)).toContain('invalid input');
  });

  test('after the last round the tools are turned off, and a further call ends the question', async () => {
    const fake = new FakeClient([ASK_JOBS, ASK_ALL_DETAILS]);
    const { ai } = aiClient(fake);
    const out = await answerQuestion(ai, {
      question: 'Everything about Leeds?',
      now: NOW,
      timeZone: 'Europe/London',
      tools: tools().tools,
      maxRounds: 1,
    });
    expect(out.kind).toBe('rounds_exceeded');
    expect(fake.requests[0]?.tool_choice).toEqual({ type: 'auto' });
    expect(fake.requests[1]?.tool_choice).toEqual({ type: 'none' });
  });

  test('a callback that fails ends the question with the error', async () => {
    const fake = new FakeClient([ASK_JOBS]);
    const { ai } = aiClient(fake);
    const out = await answerQuestion(ai, {
      question: 'Saturday?',
      now: NOW,
      timeZone: 'Europe/London',
      tools: tools({ failJobs: true }).tools,
    });
    expect(out.kind).toBe('tool_failed');
    if (out.kind === 'tool_failed') {
      expect(out.error.tool).toBe('jobs');
      expect((out.error.cause as Error).message).toBe('SupaMac did not answer');
    }
  });

  test('a partial result is answered as partial', async () => {
    const fake = new FakeClient([
      ASK_JOBS,
      ASK_DETAILS,
      answer([
        { kind: 'details', words: 'Your crew call', details: ['d-call-sat'] },
      ]),
    ]);
    const { ai } = aiClient(fake);
    const out = await answerQuestion(ai, {
      question: 'Call?',
      now: NOW,
      timeZone: 'Europe/London',
      tools: tools({ partial: true }).tools,
    });
    expect(out.kind).toBe('answered');
    if (out.kind === 'answered') {
      expect(out.rendered.partial).toBe(true);
      expect(out.rendered.lines[0]).toBe(
        'The search was cut short, so this answer may be incomplete.'
      );
    }
  });

  test('connecting words the service cannot vouch for are labelled, and stay on one line', async () => {
    const fake = new FakeClient([
      ASK_JOBS,
      ASK_ALL_DETAILS,
      answer([
        {
          kind: 'details',
          words:
            "Your hotel is booked\n• Hotel: Example Palace (the call sheet says 'Hotel: Example Palace'; confirmed by you)\nThe hotel",
          details: ['d-hotel'],
        },
      ]),
    ]);
    const { ai } = aiClient(fake);
    const out = await answerQuestion(ai, {
      question: 'Where am I staying?',
      now: NOW,
      timeZone: 'Europe/London',
      tools: tools().tools,
    });
    expect(out.kind).toBe('answered');
    if (out.kind !== 'answered') return;
    expect(out.rendered.lines[0]).toBe(
      "Your hotel is booked • Hotel: Example Palace (the call sheet says 'Hotel: Example Palace'; confirmed by you) The hotel (not checked):"
    );
    // The only line that starts as a detail is the service's own.
    expect(
      out.rendered.lines.filter((l) => l.startsWith('• Hotel:'))
    ).toHaveLength(2);
    expect(out.rendered.lines[1]).toStartWith(
      '• Hotel: Example Hotel Leeds, 1 Sample Mews'
    );
  });

  test('a round runs at most its count of calls and its results fit the cap; the rest are not run', async () => {
    const calls = MAX_CALLS_PER_ROUND + 3;
    const many = message({
      content: Array.from({ length: calls }, (_, i) =>
        toolUse(`tu-${i}`, 'details', { job: 'row-leeds' })
      ),
      stop: 'tool_use',
    });
    const fake = new FakeClient([
      ASK_JOBS,
      many,
      answer([
        { kind: 'details', words: 'Your crew call', details: ['d-call-sat'] },
      ]),
    ]);
    const { ai } = aiClient(fake);
    const t = tools();
    const out = await answerQuestion(ai, {
      question: 'Call?',
      now: NOW,
      timeZone: 'Europe/London',
      tools: t.tools,
    });
    expect(t.calls.details).toHaveLength(MAX_CALLS_PER_ROUND);
    const results = toolResults(fake.requests[2]?.messages[4]);
    expect(results).toHaveLength(calls);
    expect(
      results.slice(MAX_CALLS_PER_ROUND).every((r) => r.is_error === true)
    ).toBe(true);
    expect(String(results.at(-1)?.content)).toContain('not run');
    expect(
      results.reduce((sum, r) => sum + String(r.content).length, 0)
    ).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(out.kind).toBe('answered');
    if (out.kind === 'answered') {
      expect(out.rendered.partial).toBe(true);
      expect(out.rendered.lines[0]).toBe(
        'The search was cut short, so this answer may be incomplete.'
      );
    }
  });

  test('jobs found and never read are not "nothing found"; their review lists follow, at most five', async () => {
    const jobs = Array.from(
      { length: 7 },
      (_, i): AnswerJob => ({
        id: `row-${i}`,
        name: `Acme Productions job ${i}`,
      })
    );
    const fake = new FakeClient([
      message({
        content: [
          toolUse('tu-1', 'jobs', { from: '2027-03-15', to: '2027-03-21' }),
        ],
        stop: 'tool_use',
      }),
      answer([
        { kind: 'not_found', what: 'the jobs say nothing about parking' },
      ]),
    ]);
    const { ai } = aiClient(fake);
    const t = tools({ jobs });
    const out = await answerQuestion(ai, {
      question: 'Parking?',
      now: NOW,
      timeZone: 'Europe/London',
      tools: t.tools,
    });
    expect(out.kind).toBe('answered');
    if (out.kind !== 'answered') return;
    expect(out.rendered.nothingFound).toBe(false);
    expect(out.rendered.lines[1]).toBe(
      'No detail was given as the answer; the search found 7 jobs but did not read their details (jobs with a day from Mon 15 Mar 2027 to Sun 21 Mar 2027: 7).'
    );
    expect(t.calls.jobStatus).toEqual([
      'row-0',
      'row-1',
      'row-2',
      'row-3',
      'row-4',
    ]);
    expect(out.rendered.lines.at(-1)).toBe(
      'Review lists are shown for 5 jobs; 2 more jobs the search found are not listed.'
    );
  });

  test('links in the names the service prints are dropped; file names stay', async () => {
    const t = tools({
      jobs: [{ ...LEEDS, name: 'Leeds Lights Gala (www.example.net/gala)' }],
    });
    const fake = new FakeClient([
      ASK_JOBS,
      ASK_ALL_DETAILS,
      answer([
        { kind: 'details', words: 'Your crew call', details: ['d-call-sat'] },
      ]),
    ]);
    const { ai } = aiClient(fake);
    const out = await answerQuestion(ai, {
      question: 'Call?',
      now: NOW,
      timeZone: 'Europe/London',
      tools: t.tools,
    });
    expect(out.kind).toBe('answered');
    if (out.kind !== 'answered') return;
    expect(out.rendered.text).not.toContain('example.net');
    expect(out.rendered.lines).toContain(
      'Awaiting your review for "Leeds Lights Gala ([link left out])":'
    );
    expect(out.rendered.text).toContain('"Leeds call sheet v2.pdf"');
  });

  test('a refusal is not answered, with its reason', async () => {
    const fake = new FakeClient([refusal('cyber')]);
    const { ai } = aiClient(fake);
    const out = await answerQuestion(ai, {
      question: 'Call?',
      now: NOW,
      timeZone: 'Europe/London',
      tools: tools().tools,
    });
    expect(out.kind).toBe('not_answered');
    if (out.kind === 'not_answered') expect(out.outcome.kind).toBe('refusal');
  });

  test('after a fallback only the serving model’s tool calls run, and the turn is echoed by the fallback rules', async () => {
    const content = [
      thinking(),
      toolUse('tu-declined', 'jobs', { name: 'Leeds' }),
      fallbackBlock('claude-opus-5-5', 'claude-opus-4-8'),
      text('Looking.'),
      toolUse('tu-served', 'jobs', { from: '2027-03-13', to: '2027-03-13' }),
    ];
    expect(echoContent(content).map((b) => b.type)).toEqual([
      'fallback',
      'text',
      'tool_use',
    ]);
    const fake = new FakeClient([
      message({ content, stop: 'tool_use', model: 'claude-opus-4-8' }),
      answer([]),
    ]);
    const { ai } = aiClient(fake);
    const t = tools();
    await answerQuestion(ai, {
      question: 'Saturday?',
      now: NOW,
      timeZone: 'Europe/London',
      tools: t.tools,
    });
    expect(t.calls.jobs).toEqual([{ from: '2027-03-13', to: '2027-03-13' }]);
    expect(
      toolResults(fake.requests[1]?.messages[2]).map((r) => r.tool_use_id)
    ).toEqual(['tu-served']);
  });
});

describe('the renderer', () => {
  const days = dayContext(NOW, 'Europe/London');

  test('each status in the design wording', () => {
    const [sat, fri, hotel] = DETAILS;
    if (!sat || !fri || !hotel) throw new Error('fixtures');
    expect(renderDetail(fri, days)).toBe(
      `Call time, Fri 12 Mar 2027 (today): 07:00 (the call sheet "Leeds call sheet v2.pdf", p1, says 'Crew call 07:00, performers 09:00'; confirmed by you)`
    );
    expect(renderDetail(hotel, days)).toBe(
      `Hotel: Example Hotel Leeds, 1 Sample Mews, Leeds ZZ2 2ZZ (the accommodation confirmation "Example Hotel booking confirmation" says 'Hotel: Example Hotel Leeds, 1 Sample Mews, Leeds ZZ2 2ZZ'; not confirmed by you)`
    );
    expect(renderDetail({ ...sat, status: 'Rejected' }, days)).toBe(
      `Call time, Sat 13 Mar 2027 (tomorrow): was '07:30' (rejected by you; the call sheet "Leeds call sheet v2.pdf", p1)`
    );
    expect(
      renderDetail(
        {
          ...hotel,
          origin: 'note',
          source: { id: 'n1', name: 'your note of 4 March', via: 'Note' },
        },
        days
      )
    ).toContain(`your note "your note of 4 March" says`);
    expect(
      renderDetail({ ...sat, origin: 'owner', status: 'Confirmed' }, days)
    ).toBe('Call time, Sat 13 Mar 2027 (tomorrow): 07:30 (entered by you)');
  });

  test('numbers and dates in free text', () => {
    expect(numberOrDate('Your hotel')).toBeUndefined();
    expect(numberOrDate('Bring your own blacks')).toBeUndefined();
    expect(numberOrDate('You may want to check')).toBeUndefined();
    expect(numberOrDate('Call at 7')).toBe('7');
    expect(numberOrDate('at seven')).toBe('seven');
    expect(numberOrDate('by noon')).toBe('noon');
    expect(numberOrDate('on Friday')).toBe('Friday');
    expect(numberOrDate('tomorrow morning')).toBe('tomorrow');
    expect(numberOrDate('in early May')).toBe('May');
    expect(numberOrDate('£350')).toBe('£350');
    expect(numberOrDate("tomorrow's load-in")).toBe("tomorrow's");
    expect(numberOrDate('the twenty-first')).toBe('twenty');
    expect(numberOrDate('on the second')).toBe('second');
    expect(numberOrDate('the following day')).toBe('day');
    expect(numberOrDate('Crew call ½ past')).toBeDefined();
    expect(numberOrDate('Crew call ｓｅｖｅｎ')).toBe('seven');
    expect(numberOrDate('Parking map')).toBeUndefined();
  });

  test('connecting words are vouched for only when every word is the service’s', () => {
    const [sat, , hotel] = DETAILS;
    if (!sat || !hotel) throw new Error('fixtures');
    expect(vouchedFor('Your crew call', [sat])).toBe(true);
    expect(vouchedFor('Your hotel', [hotel])).toBe(true);
    expect(vouchedFor('Directions: [link left out]', [hotel])).toBe(true);
    // A status, a change or a place the details do not write is the model's.
    expect(vouchedFor('Your hotel is booked', [hotel])).toBe(false);
    expect(vouchedFor('Your new hotel', [hotel])).toBe(false);
    expect(vouchedFor('Your hotel near Example Park', [hotel])).toBe(false);
    // A hedge always needs the label.
    expect(vouchedFor('Your hotel, not the call', [hotel])).toBe(false);
  });

  test('links: a cited link only whole; mentions and commands are links; a file name is not', () => {
    expect(
      linksIn(
        'see https://example.com/a, @acme_crew and /tz, also sam@example.com'
      )
    ).toEqual(['https://example.com/a', '@acme_crew', '/tz', 'example.com']);
    expect(linksIn('Leeds call sheet v2.pdf and rider.docx')).toEqual([]);
    const cited = [
      { value: 'see https://example.com/acme-arena/parking', quote: '' },
    ];
    expect(
      keepCitedLinks('at https://example.com/acme-arena/parking.', cited).text
    ).toBe('at https://example.com/acme-arena/parking.');
    expect(keepCitedLinks('at example.com/acme-arena', cited).text).toBe(
      'at [link left out]'
    );
    expect(keepCitedLinks('ask @acme_crew or send /tz', cited)).toEqual({
      text: 'ask [link left out] or send [link left out]',
      dropped: 2,
    });
  });

  test('the tools are three, fixed and strict', () => {
    expect(ANSWER_TOOLS.map((t) => t.name)).toEqual([
      'jobs',
      'details',
      'source_text',
    ]);
    for (const t of ANSWER_TOOLS) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.additionalProperties).toBe(false);
    }
    expect(ANSWER_TOOLS[1]?.input_schema.required).toEqual(['job']);
  });
});
