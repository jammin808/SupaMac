// The queries behind a question asked on Telegram (docs/supamac/jobs.md,
// "Asking"): the four callbacks of ai/answer.ts's AnswerTools, run by the
// service over the pinned tables, and the question entry point.
//
// Invariants:
// - Every query is the service's own, narrowed by job or by status: `jobs`
//   reads the Jobs rows and the details awaiting review, found or confirmed
//   (for their days); `details` and `jobStatus` read one job's details and
//   sources; `sourceText` reads one source's text document. Nothing the
//   model writes becomes a query but the job, field, day and source the
//   tool schemas allow, and a job or source id is looked up, never trusted.
// - A read the server reports as cut short is answered as partial, and so is
//   a source text cut to `MAX_SOURCE_TEXT_CHARS`.
// - A detail carries its own record (origin, from the state) and its source's
//   name, kind, Via, status and Note, so the renderer can say where it came
//   from and how sure it is.
// - Questions only read: they do not wait on the lane that writes.
//
// Choices where the design is silent:
// - `jobs(from, to)` takes a job whose Dates range meets the range, or one
//   with a detail (awaiting review, found or confirmed) on a day in it.
//   `jobs(name)` takes a job whose name, client, venue or event holds every
//   word of the name, in any order.
// - The source text is read back from the `· text` document (an email's own
//   document for an email) as SupaMac holds it, page by page; a source with
//   neither has no text.

import {
  type AnswerDetail,
  type AnswerJob,
  type AnswerOutcome,
  type AnswerSource,
  type AnswerTools,
  answerQuestion,
  type DetailsQuery,
  type JobsQuery,
} from '../ai/answer';
import { DETAIL_STATUSES, type StoredDetail } from '../model';
import { termsOf } from '../normalize';
import { SupaMacError } from '../supamac/client';
import type { PipelineContext } from './context';
import { storedDetails } from './jobs';
import type { DetailRow, JobRow, SourceRow } from './store';

/** The most characters of one source's text a question reads. */
export const MAX_SOURCE_TEXT_CHARS = 120_000;

/** Statuses whose days place a job on a day. */
const DAY_STATUSES = ['Found', 'Confirmed', 'Needs review'] as const;

function answerJob(row: JobRow, days: readonly string[] = []): AnswerJob {
  const client = row.cells.Client;
  const dates = row.cells.Dates;
  return {
    id: row.id,
    name: row.name || '(no name)',
    ...(typeof client === 'string' && client.trim() !== '' ? { client } : {}),
    ...(dates !== null &&
    dates !== undefined &&
    typeof dates === 'object' &&
    !Array.isArray(dates)
      ? {
          dates: {
            start: (dates as { start: string }).start,
            end: (dates as { end: string }).end,
          },
        }
      : {}),
    ...(days.length > 0 ? { days: [...new Set(days)].sort() } : {}),
  };
}

function answerSource(row: SourceRow | undefined, id: string): AnswerSource {
  return {
    id,
    name: row?.name || '(a source)',
    ...(row?.kind !== undefined ? { kind: row.kind } : {}),
    ...(row?.via !== undefined ? { via: row.via } : {}),
    ...(row?.status !== undefined ? { status: row.status } : {}),
    ...(row?.note !== undefined ? { note: row.note } : {}),
  };
}

function answerDetail(d: StoredDetail, source: AnswerSource): AnswerDetail {
  return {
    id: d.id,
    jobId: d.jobId,
    field: d.field,
    label: d.label,
    value: d.value,
    day: d.day,
    quote: d.quote,
    page: d.page,
    status: d.status,
    check: d.check,
    origin: d.origin,
    source,
  };
}

/** Details with their sources, read by the sources' ids. */
async function withSources(
  ctx: PipelineContext,
  rows: readonly DetailRow[]
): Promise<{ details: AnswerDetail[]; partial: boolean }> {
  const ids = [...new Set(rows.flatMap((r) => r.sourceIds))];
  const sources = await ctx.store.sources({ ids });
  const byId = new Map(sources.rows.map((s) => [s.id, s]));
  const stored = await storedDetails(ctx, rows);
  return {
    details: stored.map((d) =>
      answerDetail(d, answerSource(byId.get(d.sourceId), d.sourceId))
    ),
    partial: sources.partial,
  };
}

function inRange(day: string, from?: string, to?: string): boolean {
  return (from === undefined || day >= from) && (to === undefined || day <= to);
}

/** Whether every word of `name` is a word of one of the job's texts. */
function namedBy(row: JobRow, name: string): boolean {
  const wanted = termsOf(name);
  if (wanted.length === 0) return true;
  const texts = [row.name, row.cells.Client, row.cells.Venue, row.cells.Event];
  const have = new Set(
    texts.flatMap((t) => (typeof t === 'string' ? termsOf(t) : []))
  );
  return wanted.every((w) => have.has(w));
}

/** Pages of a text document as SupaMac holds it: "[p<n>]" headings, then their lines. */
export function pagesOfMarkdown(
  markdown: string
): { page: number; lines: string[] }[] {
  const pages: { page: number; lines: string[] }[] = [];
  let current: { page: number; lines: string[] } | undefined;
  for (const raw of markdown.split(/\r?\n/)) {
    const heading = /^#{1,6}\s*\\?\[p(\d+)\\?\]/.exec(raw);
    if (heading) {
      current = { page: Number(heading[1]), lines: [] };
      pages.push(current);
      continue;
    }
    if (current === undefined) continue;
    const line = raw.trim();
    if (line === '' || /^`{3,}/.test(line) || /^_.*_$/.test(line)) continue;
    current.lines.push(
      line
        .replace(/\\([\\`*_[\]{}|~$#!+\-=.)>(<&])/g, '$1')
        .replace(/&#(\d{2,3});/g, (_m, code: string) =>
          String.fromCharCode(Number(code))
        )
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
    );
  }
  return pages;
}

/** Reads a document's Markdown; undefined when it is not one (a PDF) or is gone. */
async function markdownOf(
  ctx: PipelineContext,
  documentId: string | undefined
): Promise<string | undefined> {
  if (documentId === undefined) return undefined;
  try {
    return (await ctx.store.readMarkdown(documentId)).markdown;
  } catch (error) {
    if (
      error instanceof SupaMacError &&
      (error.kind === 'not_found' || error.kind === 'invalid')
    )
      return undefined;
    throw error;
  }
}

/** The four queries the question loop runs, over the pinned tables. */
export function answerTools(ctx: PipelineContext): AnswerTools {
  return {
    async jobs(query: JobsQuery) {
      const jobs = await ctx.store.jobs();
      const dated = query.from !== undefined || query.to !== undefined;
      const days = new Map<string, string[]>();
      let partial = jobs.partial;
      if (dated) {
        const read = await ctx.store.details({ statuses: [...DAY_STATUSES] });
        partial ||= read.partial;
        for (const d of read.rows) {
          const jobId = d.jobIds[0];
          if (jobId === undefined || d.day === undefined) continue;
          days.set(jobId, [...(days.get(jobId) ?? []), d.day]);
        }
      }
      const out: AnswerJob[] = [];
      for (const row of jobs.rows) {
        if (query.name !== undefined && !namedBy(row, query.name)) continue;
        const own = days.get(row.id) ?? [];
        const job = answerJob(row, own);
        if (dated) {
          const range = job.dates;
          const meets =
            (range !== undefined &&
              (query.to === undefined || range.start <= query.to) &&
              (query.from === undefined || range.end >= query.from)) ||
            own.some((d) => inRange(d, query.from, query.to));
          if (!meets) continue;
        }
        out.push(job);
      }
      return { jobs: out, partial };
    },

    async details(query: DetailsQuery) {
      const got = await ctx.store.job(query.job);
      if (got === undefined) return undefined;
      const read = await ctx.store.details({ jobId: got.row.id });
      const rows = read.rows.filter(
        (r) =>
          (query.field === undefined || r.field === query.field) &&
          (query.day === undefined || r.day === query.day) &&
          r.status !== undefined &&
          (DETAIL_STATUSES as readonly string[]).includes(r.status)
      );
      const found = await withSources(ctx, rows);
      const days = read.rows.flatMap((r) =>
        r.day !== undefined &&
        r.status !== undefined &&
        (DAY_STATUSES as readonly string[]).includes(r.status)
          ? [r.day]
          : []
      );
      return {
        job: answerJob(got.row, days),
        details: found.details,
        partial: read.partial || found.partial,
      };
    },

    async sourceText(sourceId: string) {
      const row = (await ctx.store.sources({ ids: [sourceId] })).rows[0];
      if (row === undefined) return undefined;
      const markdown =
        (await markdownOf(ctx, row.textDocumentId)) ??
        (row.via === 'Email' && ctx.state.value.sources[row.id]?.type === 'eml'
          ? await markdownOf(ctx, row.documentId)
          : undefined);
      if (markdown === undefined) return undefined;
      const pages = pagesOfMarkdown(markdown);
      let room = MAX_SOURCE_TEXT_CHARS;
      let cut = false;
      const kept: { page: number; lines: string[] }[] = [];
      for (const page of pages) {
        const lines: string[] = [];
        for (const line of page.lines) {
          if (line.length > room) {
            cut = true;
            break;
          }
          room -= line.length;
          lines.push(line);
        }
        kept.push({ page: page.page, lines });
        if (cut) break;
      }
      return {
        source: answerSource(row, row.id),
        pages: kept,
        partial: cut,
      };
    },

    async jobStatus(jobId: string) {
      const got = await ctx.store.job(jobId);
      if (got === undefined) return undefined;
      const [pending, failed] = await Promise.all([
        ctx.store.details({ jobId, statuses: ['Needs review'] }),
        ctx.store.sources({ jobId, statuses: ['Failed'] }),
      ]);
      const found = await withSources(ctx, pending.rows);
      return {
        job: answerJob(got.row),
        pending: found.details,
        failed: failed.rows.map((s) => answerSource(s, s.id)),
        partial: pending.partial || failed.partial || found.partial,
      };
    },
  };
}

export type AskOutcome =
  | AnswerOutcome
  | { readonly kind: 'ai_off'; readonly reason: string };

/** A question the owner asked on Telegram, answered from the pinned tables. */
export function ask(
  ctx: PipelineContext,
  question: string,
  options: {
    readonly key?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {}
): Promise<AskOutcome> {
  if (ctx.ai === undefined) {
    return Promise.resolve({
      kind: 'ai_off',
      reason: ctx.aiOff ?? 'the AI settings are missing',
    });
  }
  return answerQuestion(ctx.ai, {
    question,
    now: ctx.clock(),
    timeZone: ctx.timeZone(),
    tools: answerTools(ctx),
    key: options.key,
    signal: options.signal,
  });
}
