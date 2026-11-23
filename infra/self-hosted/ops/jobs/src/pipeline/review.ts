// The owner's Review on Telegram (docs/supamac/jobs.md, "What the owner
// does", §4, "Edits in SupaMac"): a card per detail that needs a look, with
// its quote and page, and Confirm, Reject and Skip.
//
// Invariants:
// - Confirmed and Rejected come only from the owner. A button press is the
//   one action certain to be the owner's, so it is recorded as decided on
//   Telegram (`decidedVia: telegram`) with the time.
// - Before acting, the detail is read again. A card carries a fingerprint of
//   what it showed and where it is filed (status, field, label, value, day,
//   quote, page, job, source row); when the row no longer matches it
//   (changed in SupaMac since), nothing is written and the button reports
//   the detail's current state as a new card.
// - After a decision the job's row is derived again; a value equal to a
//   rejected one stays Needs review on later sources (derive.ts).
// - A source whose details no longer need review, and whose filing waits
//   for nothing, becomes Processed.
// - A card of a detail read from an image or a scan says so ("read by the
//   model from an image; no text was checked") and names the original, so
//   the Telegram unit can send its page image.
//
// Choice where the design is silent: confirming a value leaves the other
// values in its scope as they are; the row shows the newest, and a
// confirmed one over an older confirmed one (derive.ts).

import { createHash } from 'node:crypto';
import { SCAN_TEXT } from '../checks';
import { detailName } from '../derive';
import type { DetailStatus } from '../model';
import { pdfPageLink } from '../supamac/documents';
import type { PipelineContext } from './context';
import { recomputeJob } from './jobs';
import type { ReviewCard } from './notify';
import type { DetailRow } from './store';

export type ReviewAction = 'confirm' | 'reject' | 'skip';

export interface ReviewPress {
  readonly detailId: string;
  readonly action: ReviewAction;
  /** The fingerprint of the card the button was on. */
  readonly fingerprint: string;
}

export type ReviewResult =
  | {
      readonly kind: 'applied';
      readonly status: DetailStatus;
      readonly card: ReviewCard;
    }
  /** The detail changed since the card was sent; this is how it reads now. */
  | { readonly kind: 'changed'; readonly card: ReviewCard }
  | { readonly kind: 'skipped'; readonly card: ReviewCard }
  | { readonly kind: 'missing' };

/** A short digest of what a card shows; 12 hex characters fit a button's data. */
export function fingerprint(row: DetailRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.status ?? '',
        row.field ?? '',
        row.label,
        row.value,
        row.day ?? '',
        row.quote,
        row.page ?? null,
        [...row.jobIds].sort(),
        [...row.sourceIds].sort(),
      ])
    )
    .digest('hex')
    .slice(0, 12);
}

function card(ctx: PipelineContext, row: DetailRow): ReviewCard | undefined {
  if (row.field === undefined || row.status === undefined) return undefined;
  const meta = ctx.state.value.details[row.id];
  const sourceId = row.sourceIds[0];
  const source =
    sourceId === undefined ? undefined : ctx.state.value.sources[sourceId];
  const scan = meta?.pageKind === 'scan';
  let link: string | undefined;
  if (
    ctx.webApp !== undefined &&
    source?.type === 'pdf' &&
    source.documentId !== undefined
  ) {
    link = pdfPageLink(ctx.webApp, source.documentId, row.page);
  }
  return {
    detailId: row.id,
    jobId: row.jobIds[0],
    field: row.field,
    label: row.label,
    value: row.value,
    day: row.day,
    quote: row.quote,
    page: row.page,
    status: row.status,
    check: row.check,
    sourceId,
    sourceName: source?.name,
    documentId: source?.documentId ?? row.documentId,
    pageKind: meta?.pageKind,
    ...(scan ? { imageNote: SCAN_TEXT } : {}),
    fingerprint: fingerprint(row),
    ...(link !== undefined ? { link } : {}),
  };
}

/** The cards of the details that need review: of one source, of one job, or all. */
export async function reviewCards(
  ctx: PipelineContext,
  filter: { readonly sourceId?: string; readonly jobId?: string } = {}
): Promise<ReviewCard[]> {
  const read = await ctx.store.details({
    statuses: ['Needs review'],
    ...(filter.sourceId !== undefined ? { sourceId: filter.sourceId } : {}),
    ...(filter.jobId !== undefined ? { jobId: filter.jobId } : {}),
  });
  return read.rows.flatMap((r) => {
    const c = card(ctx, r);
    return c === undefined ? [] : [c];
  });
}

/** Applies a Review button press (see the header). */
export async function applyReview(
  ctx: PipelineContext,
  press: ReviewPress
): Promise<ReviewResult> {
  const row = (await ctx.store.details({ ids: [press.detailId] })).rows[0];
  const current = row === undefined ? undefined : card(ctx, row);
  if (row === undefined || current === undefined) return { kind: 'missing' };
  if (current.fingerprint !== press.fingerprint)
    return { kind: 'changed', card: current };
  if (press.action === 'skip') return { kind: 'skipped', card: current };
  const status: DetailStatus =
    press.action === 'confirm' ? 'Confirmed' : 'Rejected';
  const at = ctx.clock().toISOString();
  await ctx.store.updateDetail(row.id, {
    Status: status,
    Name: detailName(current.field, row.value, status),
  });
  await ctx.state.update((s) => {
    const meta = s.details[row.id] ?? {
      history: true,
      origin: 'document' as const,
    };
    s.details[row.id] = { ...meta, decidedAt: at, decidedVia: 'telegram' };
  });
  const jobId = row.jobIds[0];
  if (jobId !== undefined) await recomputeJob(ctx, jobId);
  const sourceId = row.sourceIds[0];
  if (sourceId !== undefined) await settleSource(ctx, sourceId);
  const after = (await ctx.store.details({ ids: [row.id] })).rows[0];
  const shown = after === undefined ? undefined : card(ctx, after);
  return { kind: 'applied', status, card: shown ?? current };
}

/** A source in Needs review becomes Processed once nothing about it needs a look. */
export async function settleSource(
  ctx: PipelineContext,
  sourceId: string
): Promise<void> {
  if (ctx.state.value.filing[sourceId] !== undefined) return;
  const meta = ctx.state.value.sources[sourceId];
  if (
    meta === undefined ||
    meta.stage !== 'done' ||
    meta.status !== 'Needs review'
  )
    return;
  const read = await ctx.store.details({ sourceId });
  if (read.partial || read.rows.some((r) => r.status === 'Needs review'))
    return;
  await ctx.store.updateSource(sourceId, { Status: 'Processed' });
  await ctx.state.update((s) => {
    const m = s.sources[sourceId];
    if (m !== undefined) {
      m.status = 'Processed';
      if (m.outcome !== undefined)
        m.outcome = { ...m.outcome, status: 'Processed' };
    }
  });
}
