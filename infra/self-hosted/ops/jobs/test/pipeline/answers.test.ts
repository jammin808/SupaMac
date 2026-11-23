import { afterEach, describe, expect, test } from 'bun:test';
import { pagesOfMarkdown } from '../../src/pipeline/answers';
import { Pipeline } from '../../src/pipeline/pipeline';
import { extract } from '../../src/text/extract';
import { textDocument } from '../../src/text/markdown';
import { EMAIL_REPLY, INVITE_PDF_REPLY, inviteEmail } from './fixtures';
import { cleanup, makeWorld, type World } from './harness';

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await cleanup(w);
});

async function booked(): Promise<{ w: World; jobId: string; pdf: string }> {
  const w = await makeWorld(
    [
      { marker: 'S1: "Leeds Lights Gala - booking"', reply: EMAIL_REPLY },
      { marker: 'S1: "invite.pdf"', reply: INVITE_PDF_REPLY },
    ],
    { extract: (bytes, hint) => extract(bytes, hint) }
  );
  worlds.push(w);
  await w.pipeline.processEmail({ raw: inviteEmail() });
  const [job] = w.store.rows('jobs');
  const pdf = w.store.rows('sources').find(([, v]) => v.Name === 'invite.pdf');
  return {
    w,
    jobId: (job as [string, unknown])[0],
    pdf: (pdf as [string, unknown])[0],
  };
}

describe('the answer tools over the pinned tables', () => {
  test('jobs are found by the words of their name, client or venue, and by a day of theirs', async () => {
    const { w, jobId } = await booked();
    const tools = w.pipeline.answerTools();
    expect(
      (await tools.jobs({ name: 'gala leeds' })).jobs.map((j) => j.id)
    ).toEqual([jobId]);
    expect((await tools.jobs({ name: 'Example Arts' })).jobs).toHaveLength(1);
    expect((await tools.jobs({ name: 'York' })).jobs).toEqual([]);
    const on13 = await tools.jobs({ from: '2027-03-13', to: '2027-03-13' });
    expect(on13).toMatchObject({ partial: false });
    expect(on13.jobs.map((j) => j.id)).toEqual([jobId]);
    expect(on13.jobs[0]?.days).toContain('2027-03-13');
    expect(
      (await tools.jobs({ from: '2027-04-01', to: '2027-04-30' })).jobs
    ).toEqual([]);
  });

  test('details of one job carry their status, origin and source; an unknown job is undefined', async () => {
    const { w, jobId } = await booked();
    const tools = w.pipeline.answerTools();
    const calls = await tools.details({ job: jobId, field: 'Call time' });
    expect(calls?.details.map((d) => [d.value, d.day, d.status])).toEqual([
      ['07:00', '2027-03-12', 'Found'],
      ['07:30', '2027-03-13', 'Found'],
    ]);
    expect(calls?.details[0]).toMatchObject({
      origin: 'document',
      source: { name: 'invite.pdf', via: 'Email' },
    });
    expect(calls?.job.name).toBe('Leeds Lights Gala');
    const friday = await tools.details({ job: jobId, day: '2027-03-12' });
    expect(friday?.details.map((d) => d.value)).toEqual(['07:00']);
    expect(await tools.details({ job: 'not-a-job' })).toBeUndefined();
  });

  test('a source’s text is read back from its text document, page by page', async () => {
    const { w, pdf } = await booked();
    const text = await w.pipeline.answerTools().sourceText(pdf);
    expect(text?.partial).toBe(false);
    expect(text?.source.name).toBe('invite.pdf');
    expect(text?.pages.map((p) => p.page)).toEqual([1]);
    expect(text?.pages[0]?.lines).toContain('Crew call 07:00');
    expect(text?.pages[0]?.lines).toContain('PO: 4500123');
    expect(await w.pipeline.answerTools().sourceText('not-a-source')).toBe(
      undefined
    );
  });

  test('a job’s status lists its details awaiting review and its failed sources', async () => {
    const { w, jobId } = await booked();
    const status = await w.pipeline.answerTools().jobStatus(jobId);
    expect(status?.pending.map((d) => d.field)).toEqual(['Hotel']);
    expect(status?.failed).toEqual([]);
    expect(await w.pipeline.answerTools().jobStatus('not-a-job')).toBe(
      undefined
    );
  });

  test('with the AI off a question is not asked', async () => {
    const { w } = await booked();
    const off = new Pipeline({
      ...w.ctx,
      ai: undefined,
      aiOff: 'ANTHROPIC_API_KEY is not set',
    });
    expect(await off.ask('Where am I staying in Leeds?')).toEqual({
      kind: 'ai_off',
      reason: 'ANTHROPIC_API_KEY is not set',
    });
    expect(w.model.requests).toHaveLength(2);
  });
});

describe('pagesOfMarkdown', () => {
  test('reads every line of a text document back as written, markup and all', () => {
    const lines = [
      '# Not a heading & <b>bold</b>',
      '1. Not a list: *starred* _under_ [link](x)',
      '- PO: 4500123 | £350/day + VAT',
    ];
    const markdown = textDocument('pack.pdf', {
      paged: true,
      pages: [
        { page: 1, kind: 'text', lines },
        { page: 2, kind: 'scan', lines: [] },
      ],
    });
    expect(pagesOfMarkdown(markdown)).toEqual([
      { page: 1, lines },
      { page: 2, lines: [] },
    ]);
  });
});
