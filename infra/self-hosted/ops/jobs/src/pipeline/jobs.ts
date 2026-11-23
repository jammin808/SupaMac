// Reading a job's details back as the core's StoredDetail, and rewriting its
// Jobs row (docs/supamac/jobs.md §6).
//
// Invariants:
// - A detail is its Details row joined with its state record (model.ts): a
//   row with no record leaves those fields unknown (no source date, from
//   history, origin from its source's Via), never filled from another column.
//   A row whose Field or Status is not one of the spec's options (the owner
//   added one) is left out of the derivation.
// - The Jobs row is written only through `planJobsCells`: a cell is written
//   when it is empty or still holds what the service last wrote; the owner's
//   cells stay. The write carries the Jobs table's version it was read at,
//   and a conflict reads and plans again (at most three times).
// - Not confirmed and Needs review are the service's marks on the row, not
//   values anyone types: they are always written, from the details and the
//   row as it is (rule zero, §6). Not confirmed lists every column whose
//   value rests on a Found detail the owner has not confirmed, and so leaves
//   out a column that holds a value the owner typed; an edit of either mark
//   is written over.
// - What is about to be written is saved first, so a write whose answer was
//   lost still counts as the service's on the next plan.
// - A job whose details were read only in part is not rewritten: its row
//   would be derived from some of its details.

import {
  type CellPlan,
  type CellValue,
  cellsEqual,
  deriveJobsRow,
  type JobsRowDerivation,
  planJobsCells,
} from '../derive';
import {
  DERIVED_COLUMNS,
  type DerivedColumn,
  type StoredDetail,
} from '../model';
import { SupaMacError } from '../supamac/client';
import { type PipelineContext, PipelineError, today } from './context';
import type { CellChange } from './notify';
import type { DetailMeta } from './state';
import { type DetailRow, type JobCells, jobCellsInput } from './store';

/** A Details row with its state record, as the core reads it. */
export function storedDetail(
  row: DetailRow,
  meta: DetailMeta | undefined,
  viaNote = false
): StoredDetail | undefined {
  if (row.field === undefined || row.status === undefined) return undefined;
  return {
    id: row.id,
    jobId: row.jobIds[0],
    sourceId: row.sourceIds[0] ?? '',
    field: row.field,
    label: row.label,
    value: row.value,
    day: row.day,
    quote: row.quote,
    page: row.page,
    status: row.status,
    check: row.check,
    received: row.received ?? '',
    documentId: row.documentId,
    sourceDate: meta?.sourceDate,
    history: meta?.history ?? true,
    origin: meta?.origin ?? (viaNote ? 'note' : 'document'),
    decidedAt: meta?.decidedAt,
    pageKind: meta?.pageKind,
    dayQuote: meta?.dayQuote,
  };
}

/** Rows as StoredDetails, looking up the Via of sources whose details have no record. */
export async function storedDetails(
  ctx: PipelineContext,
  rows: readonly DetailRow[]
): Promise<StoredDetail[]> {
  const metas = ctx.state.value.details;
  const missing = [
    ...new Set(
      rows.filter((r) => metas[r.id] === undefined).flatMap((r) => r.sourceIds)
    ),
  ];
  const noteSources = new Set<string>();
  if (missing.length > 0) {
    const sources = await ctx.store.sources({ ids: missing });
    for (const s of sources.rows) if (s.via === 'Note') noteSources.add(s.id);
  }
  const out: StoredDetail[] = [];
  for (const row of rows) {
    const d = storedDetail(
      row,
      metas[row.id],
      row.sourceIds.some((id) => noteSources.has(id))
    );
    if (d !== undefined) out.push(d);
  }
  return out;
}

/** Every detail of a job, as StoredDetails. */
export async function jobDetails(
  ctx: PipelineContext,
  jobId: string
): Promise<{ details: StoredDetail[]; partial: boolean }> {
  const read = await ctx.store.details({ jobId });
  return {
    details: await storedDetails(ctx, read.rows),
    partial: read.partial,
  };
}

export interface JobUpdate {
  readonly jobId: string;
  readonly name: string;
  readonly derivation: JobsRowDerivation;
  readonly plan: CellPlan;
  /** Cells written, from what to what (the review count and tags left out). */
  readonly changes: readonly CellChange[];
}

/** The row's marks (see the header): written always, and left out of what changed. */
const MARKS: ReadonlySet<DerivedColumn> = new Set([
  'Needs review',
  'Not confirmed',
]);

/**
 * The plan with the marks written from the row as it will be: Not confirmed
 * without the columns that keep a value the owner typed.
 */
export function withMarks(
  derivation: JobsRowDerivation,
  current: JobCells,
  plan: CellPlan
): CellPlan {
  const kept = plan.kept.filter((k) => !MARKS.has(k.column));
  const owners = new Set<string>(kept.map((k) => k.column));
  const writes: Partial<Record<DerivedColumn, CellValue>> = {};
  for (const [column, value] of Object.entries(plan.writes) as [
    DerivedColumn,
    CellValue,
  ][]) {
    if (!MARKS.has(column)) writes[column] = value;
  }
  const derived = derivation.cells['Not confirmed'];
  const notConfirmed = Array.isArray(derived)
    ? (derived as readonly string[]).filter((c) => !owners.has(c))
    : [];
  const marks: Partial<Record<DerivedColumn, CellValue>> = {
    'Not confirmed': notConfirmed,
    'Needs review': derivation.cells['Needs review'],
  };
  for (const [column, value] of Object.entries(marks) as [
    DerivedColumn,
    CellValue,
  ][]) {
    if (!cellsEqual(current[column] ?? null, value)) writes[column] = value;
  }
  return { writes, kept };
}

/** The derived cells as the planner compares them. */
function lastWrittenFor(
  ctx: PipelineContext,
  jobId: string,
  current: JobCells
): Partial<Record<DerivedColumn, CellValue>> {
  const saved = ctx.state.value.jobs[jobId];
  const out: Partial<Record<DerivedColumn, CellValue>> = {};
  for (const column of DERIVED_COLUMNS) {
    const pending = saved?.pending?.[column];
    const last = saved?.lastWritten[column];
    if (
      pending !== undefined &&
      cellsEqual(current[column], pending as CellValue)
    )
      out[column] = pending as CellValue;
    else if (last !== undefined) out[column] = last as CellValue;
  }
  return out;
}

type StateCell =
  | string
  | number
  | string[]
  | { start: string; end: string }
  | null;

/** Cells as the state keeps them: plain copies. */
function stateCells(
  cells: Partial<Record<DerivedColumn, CellValue>>
): Record<string, StateCell> {
  const out: Record<string, StateCell> = {};
  for (const [k, v] of Object.entries(cells) as [string, CellValue][]) {
    if (Array.isArray(v)) out[k] = [...(v as readonly string[])];
    else if (v !== null && typeof v === 'object') {
      const range = v as { start: string; end: string };
      out[k] = { start: range.start, end: range.end };
    } else out[k] = v as string | number | null;
  }
  return out;
}

/** Derives a job's row from its details and writes the cells it may. */
export async function recomputeJob(
  ctx: PipelineContext,
  jobId: string
): Promise<JobUpdate | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = await ctx.store.job(jobId);
    if (got === undefined) return undefined;
    const { details, partial } = await jobDetails(ctx, jobId);
    if (partial) {
      throw new PipelineError(
        'retryable',
        `the details of ${got.row.name || 'a job'} were read only in part; its row is left as it is`
      );
    }
    const derivation = deriveJobsRow(details, { timeZone: ctx.timeZone() });
    const current = got.row.cells;
    const plan = withMarks(
      derivation,
      current,
      planJobsCells(
        derivation.cells,
        current,
        lastWrittenFor(ctx, jobId, current)
      )
    );
    const writes = plan.writes;
    const changes: CellChange[] = (Object.keys(writes) as DerivedColumn[])
      .filter((c) => !MARKS.has(c))
      .map((column) => ({
        column,
        from: current[column] ?? null,
        to: writes[column] ?? null,
      }));
    const update = { jobId, name: got.row.name, derivation, plan, changes };
    if (Object.keys(writes).length === 0) return update;
    await ctx.state.update((s) => {
      const job = s.jobs[jobId] ?? { lastWritten: {} };
      job.pending = stateCells(writes);
      s.jobs[jobId] = job;
    });
    try {
      await ctx.store.updateJob(
        jobId,
        { ...jobCellsInput(writes), Updated: today(ctx) },
        { baseVersion: got.version }
      );
    } catch (error) {
      if (error instanceof SupaMacError && error.kind === 'conflict') continue;
      throw error;
    }
    await ctx.state.update((s) => {
      const job = s.jobs[jobId] ?? { lastWritten: {} };
      job.lastWritten = { ...job.lastWritten, ...stateCells(writes) };
      delete job.pending;
      s.jobs[jobId] = job;
    });
    return update;
  }
  throw new PipelineError(
    'retryable',
    'the Jobs row kept changing while the service wrote it'
  );
}
