// The owner's answers to filing questions (docs/supamac/jobs.md §5): "File
// under <job>?" with Yes and New job, for a source the rules could not place.
//
// Invariants:
// - Until a part is answered its details carry no Job, so no Jobs row is
//   touched; the answer files them, settles them against the job's own
//   details (derive.ts: replacement, review, rejected-value stickiness) and
//   rewrites that job's row.
// - A source that describes several jobs is answered part by part, each
//   part filing the details whose CandidateDetail.job names it; a detail
//   that names no job stays unfiled.
// - An answer names a job on file or asks for a new one; a part answers
//   once. The answer is saved before anything is filed, and marked filed
//   once its details are filed and the source written, so a restart (the
//   resume, or the same press delivered again) files what was answered
//   rather than asking again or saying it is done.
// - An attachment that waited with its email is filed once the email is:
//   with it when the email went under one job and nothing in the attachment
//   conflicts, else by its own rules, which may ask again.
//
// Choice where the design is silent: Yes may name any job on file, not only
// the candidates the question listed, since the owner may know better.

import { decideFiling, detailName } from '../derive';
import type { SourceStatus, StoredDetail } from '../model';
import { type PipelineContext, PipelineError } from './context';
import { type JobUpdate, recomputeJob, storedDetails } from './jobs';
import {
  attachmentState,
  filingFacts,
  newJobName,
  partialGuard,
  sendFilingQuestion,
  sendPendingSummary,
  settleUnder,
} from './process';
import type { PendingFiling, SourceMeta } from './state';

export type FilingChoice =
  | { readonly kind: 'job'; readonly jobId: string }
  | { readonly kind: 'new_job' };

export interface FilingAnswer {
  readonly sourceId: string;
  /** The question's part; null for a source of one job. */
  readonly part: number | null;
  readonly choice: FilingChoice;
}

export type FilingResult =
  | {
      readonly kind: 'filed';
      readonly jobId: string;
      readonly created: boolean;
      /** Parts still waiting for an answer. */
      readonly remaining: number;
    }
  | { readonly kind: 'no_question' }
  | { readonly kind: 'answered'; readonly jobId: string }
  | { readonly kind: 'refused'; readonly reason: string };

/** Files a source's unfiled details of one part under a job and rewrites the job's row. */
async function fileDetails(
  ctx: PipelineContext,
  sourceId: string,
  part: number | null,
  jobId: string
): Promise<JobUpdate | undefined> {
  const read = await ctx.store.details({ sourceId });
  if (read.partial) {
    throw new PipelineError(
      'retryable',
      'the source’s details were read only in part'
    );
  }
  const metas = ctx.state.value.details;
  const rows = read.rows.filter(
    (r) =>
      r.jobIds.length === 0 && (part === null || metas[r.id]?.jobIndex === part)
  );
  const incoming = await storedDetails(ctx, rows);
  const settled = await settleUnder(ctx, jobId, incoming);
  for (const d of settled.details) {
    await ctx.store.updateDetail(d.id, {
      Job: [jobId],
      Status: d.status,
      Check: d.check,
      Name: detailName(d.field, d.value, d.status),
    });
  }
  if (settled.replaced.length > 0) {
    const replaced = await ctx.store.details({
      ids: settled.replaced.map((r) => r.id),
    });
    for (const r of settled.replaced) {
      const row = replaced.rows.find((x) => x.id === r.id);
      if (row?.field === undefined) continue;
      await ctx.store.updateDetail(r.id, {
        Status: 'Replaced',
        Check: r.check,
        Name: detailName(row.field, row.value, 'Replaced'),
      });
    }
  }
  return recomputeJob(ctx, jobId);
}

/** The status a source takes once nothing about it waits for filing. */
async function settledStatus(
  ctx: PipelineContext,
  sourceId: string
): Promise<SourceStatus> {
  const read = await ctx.store.details({ sourceId });
  return read.rows.some((r) => r.status === 'Needs review')
    ? 'Needs review'
    : 'Processed';
}

/** Writes the source's Job and Status after an answer, and its summary. */
async function afterFiling(
  ctx: PipelineContext,
  sourceId: string,
  filedPart: number | null,
  updates: readonly JobUpdate[],
  newJobId?: string
): Promise<void> {
  const pending = ctx.state.value.filing[sourceId];
  const answered = (pending?.parts ?? []).flatMap((p) =>
    p.answer ? [p.answer.jobId] : []
  );
  const meta = ctx.state.value.sources[sourceId] as SourceMeta | undefined;
  const jobIds = [...new Set([...(meta?.outcome?.jobIds ?? []), ...answered])];
  const open = (pending?.parts ?? []).some((p) => p.answer === undefined);
  const status: SourceStatus = open
    ? 'Needs review'
    : await settledStatus(ctx, sourceId);
  await ctx.store.updateSource(sourceId, { Job: jobIds, Status: status });
  await ctx.state.update((s) => {
    const m = s.sources[sourceId];
    if (m !== undefined) {
      m.status = status;
      m.outcome = { ...(m.outcome ?? { note: '' }), status, jobIds };
      m.summaryPending = true;
      if (newJobId !== undefined) m.newJobId = newJobId;
    }
    if (!open) delete s.filing[sourceId];
    else
      for (const p of s.filing[sourceId]?.parts ?? [])
        if (p.part === filedPart && p.answer !== undefined)
          p.answer.filed = true;
  });
  await sendPendingSummary(ctx, sourceId, updates);
  if (!open) {
    for (const child of Object.values(ctx.state.value.filing)) {
      if (child.waitingFor === sourceId)
        await refileAttachment(ctx, child.sourceId);
    }
  }
}

/** The owner's answer to a filing question. */
export async function answerFiling(
  ctx: PipelineContext,
  answer: FilingAnswer
): Promise<FilingResult> {
  const pending = ctx.state.value.filing[answer.sourceId];
  if (pending === undefined) return { kind: 'no_question' };
  if (pending.waitingFor !== undefined) {
    return {
      kind: 'refused',
      reason: 'it is filed with its email; answer the email’s question',
    };
  }
  const part = pending.parts.find((p) => p.part === answer.part);
  if (part === undefined)
    return { kind: 'refused', reason: 'the question has no such part' };
  if (part.answer?.filed === true)
    return { kind: 'answered', jobId: part.answer.jobId };
  if (part.answer !== undefined)
    return fileAnswer(
      ctx,
      answer.sourceId,
      answer.part,
      part.answer.jobId,
      part.answer.choice === 'new_job'
    );

  let jobId: string;
  let created = false;
  if (answer.choice.kind === 'job') {
    const job = await ctx.store.job(answer.choice.jobId);
    if (job === undefined)
      return { kind: 'refused', reason: 'that job is not on file' };
    jobId = job.row.id;
  } else {
    const read = await ctx.store.details({ sourceId: answer.sourceId });
    const metas = ctx.state.value.details;
    const mine = read.rows.flatMap((r) =>
      r.field !== undefined &&
      r.status !== undefined &&
      (answer.part === null || metas[r.id]?.jobIndex === answer.part)
        ? [{ field: r.field, status: r.status, value: r.value }]
        : []
    );
    const meta = ctx.state.value.sources[answer.sourceId];
    jobId = await ctx.store.insertJob({
      Name: newJobName(mine, part.names, meta?.name ?? ''),
    });
    created = true;
  }
  await ctx.state.update((s) => {
    const p = s.filing[answer.sourceId]?.parts.find(
      (x) => x.part === answer.part
    );
    if (p !== undefined)
      p.answer = {
        jobId,
        choice: answer.choice.kind,
        at: ctx.clock().toISOString(),
      };
  });
  return fileAnswer(ctx, answer.sourceId, answer.part, jobId, created);
}

/** Files a saved answer's part and writes the source (fileDetails, afterFiling). */
async function fileAnswer(
  ctx: PipelineContext,
  sourceId: string,
  part: number | null,
  jobId: string,
  created: boolean
): Promise<FilingResult> {
  const update = await fileDetails(ctx, sourceId, part, jobId);
  await afterFiling(
    ctx,
    sourceId,
    part,
    update ? [update] : [],
    created ? jobId : undefined
  );
  const remaining =
    ctx.state.value.filing[sourceId]?.parts.filter(
      (p) => p.answer === undefined
    ).length ?? 0;
  return { kind: 'filed', jobId, created, remaining };
}

/**
 * Files every answer that was saved but not yet filed (a stop between the
 * two); run with the resume, so a restart files what the owner answered.
 */
export async function resumeAnswers(ctx: PipelineContext): Promise<void> {
  for (const sourceId of Object.keys(ctx.state.value.filing)) {
    const parts = ctx.state.value.filing[sourceId]?.parts ?? [];
    for (const { part } of parts) {
      // Read again each time: filing one part writes the others' marks.
      const answer = ctx.state.value.filing[sourceId]?.parts.find(
        (p) => p.part === part
      )?.answer;
      if (answer === undefined || answer.filed === true) continue;
      await fileAnswer(
        ctx,
        sourceId,
        part,
        answer.jobId,
        answer.choice === 'new_job'
      );
    }
  }
}

/** Files an attachment that waited with its email (see the header). */
export async function refileAttachment(
  ctx: PipelineContext,
  sourceId: string
): Promise<void> {
  const pending = ctx.state.value.filing[sourceId];
  const meta = ctx.state.value.sources[sourceId];
  if (pending === undefined || meta === undefined) return;
  const read = await ctx.store.details({ sourceId });
  const details: StoredDetail[] = await storedDetails(ctx, read.rows);
  const { facts, names, partial } = await filingFacts(ctx);
  const decision = partialGuard(
    decideFiling(
      {
        ...pending.input,
        details: details.map((d) => ({
          field: d.field,
          value: d.value,
          day: d.day,
          status: d.status,
          quote: d.quote,
        })),
        attachmentOf: attachmentState(ctx, meta),
      },
      facts
    ),
    partial
  );
  if (decision.action === 'file' || decision.action === 'new_job') {
    const jobId =
      decision.action === 'file'
        ? decision.jobId
        : await ctx.store.insertJob({
            Name: newJobName(details, [], meta.name),
          });
    await ctx.state.update((s) => {
      const p = s.filing[sourceId];
      if (p !== undefined) {
        delete p.waitingFor;
        p.parts = p.parts.map((x) => ({
          ...x,
          answer: { jobId, choice: 'job', at: ctx.clock().toISOString() },
        }));
      }
    });
    const update = await fileDetails(ctx, sourceId, null, jobId);
    await afterFiling(
      ctx,
      sourceId,
      null,
      update ? [update] : [],
      decision.action === 'new_job' ? jobId : undefined
    );
    return;
  }
  if (decision.action === 'not_a_job') {
    await ctx.store.updateSource(sourceId, { Status: 'Not a job' });
    await ctx.state.update((s) => {
      delete s.filing[sourceId];
      const m = s.sources[sourceId];
      if (m !== undefined) m.status = 'Not a job';
    });
    return;
  }
  const candidates =
    decision.action === 'ask'
      ? decision.candidates.map((c) => ({
          jobId: c.jobId,
          name: names.get(c.jobId) ?? '(a job)',
          why: c.why,
        }))
      : [];
  const question: PendingFiling = {
    ...pending,
    parts: [
      {
        part: null,
        names: pending.parts[0]?.names ?? [],
        candidates,
        reason: decision.reason,
      },
    ],
    notified: false,
  };
  delete question.waitingFor;
  await ctx.state.update((s) => {
    s.filing[sourceId] = question;
  });
  await sendFilingQuestion(ctx, sourceId);
}
