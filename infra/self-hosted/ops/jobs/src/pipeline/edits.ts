// Edits in SupaMac (docs/supamac/jobs.md, "Edits in SupaMac"): every minute
// the service reads each watched table's changes since the version it last
// saw, skipping the versions its own writes produced, and acts on who made
// each one.
//
// Invariants:
// - The owner, with no agent recorded (changes.ts: "owner" means no agent the
//   journal names, which code run with the owner's key also is): a Status set
//   to Confirmed or Rejected is the owner's decision, recorded as decided in
//   SupaMac with the change's time. A Status set to Found or Replaced is not
//   taken: Found comes only from the service's checks, so the detail is set
//   Needs review. A Status set to Needs review stands. A changed Value,
//   Quote or Day, or a changed Field, Label, Page or Source (what the checks
//   were made on), is the owner's value ("entered by you"): its origin becomes
//   the owner's, and a Found or Needs review detail becomes Confirmed, since
//   the value is now the owner's own. Every one of these Status changes is
//   listed in the next summary, so a change the owner did not make shows up.
//   A row the owner adds is the owner's.
// - An agent (or anyone else): only the owner decides. A Status change is
//   undone; a change to a detail's Job is undone, since filing is the
//   owner's; a change of what a detail says (the columns above), or a new
//   row, is set Needs review with "changed by the assistant"; a change to a
//   Jobs row is undone; a change to a Sources row is reported. The owner is
//   told of each. Nothing is undone over a later change to the same row and
//   column, or when the row no longer holds what the agent wrote; a Jobs
//   undo is written at the version its row was read at.
// - Every job a change touched is derived again; owner-typed Jobs cells stay
//   (planJobsCells).
// - The versions seen move on only after every change of the poll was
//   handled and every job it touched derived again, so a failed poll reads
//   them again; handling is idempotent (decisions are keyed by detail and
//   time, and an undo checks the row first).
// - When the journal cannot list every change, the changes it lists are
//   still handled, every job is derived again, and the owner is told which
//   tables were not checked change by change.
// - A table seen for the first time starts at its current version: history
//   from before the service watched it is not replayed.
// - A change to a table's columns (added, renamed, retyped) asks the caller
//   to verify the schema again.

import { type CellValue, cellsEqual, detailName } from '../derive';
import {
  DERIVED_COLUMNS,
  type DerivedColumn,
  type DetailStatus,
  type FieldName,
} from '../model';
import type { HistoryCell } from '../supamac/api';
import {
  type Attribution,
  cellText,
  detailEdit,
  type RowChange,
  WATCHED_TABLES,
} from '../supamac/changes';
import { SupaMacError } from '../supamac/client';
import { readDate } from '../supamac/sql';
import type { ResolvedColumn, RowInput, TableKey } from '../supamac/tables';
import { dayText, type PipelineContext, PipelineError } from './context';
import { recomputeJob } from './jobs';
import type { EditReport } from './notify';
import { settleSource } from './review';
import type { DetailRow, JobRow } from './store';

export interface EditPollResult {
  readonly tables: readonly {
    readonly table: TableKey;
    readonly since: number;
    readonly version: number;
    readonly changes: number;
    readonly needsFullRead: boolean;
  }[];
  /** A watched table's columns changed: verify the schema again. */
  readonly schemaChanged: boolean;
  /** Jobs derived again. */
  readonly jobs: readonly string[];
  readonly report: EditReport;
}

type AgentNote = EditReport['agent'][number];

/** A cell of a change as the value a write takes, when it can be written back. */
export function historyInput(
  column: ResolvedColumn,
  cell: HistoryCell | undefined
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const kind = column.spec.kind;
  const multi = kind === 'tag' || kind === 'relation';
  if (cell === undefined || cell.type === 'clear')
    return { ok: true, value: multi ? [] : null };
  switch (kind) {
    case 'text':
      return cell.type === 'text'
        ? { ok: true, value: cell.value }
        : { ok: false };
    case 'number':
      return cell.type === 'number'
        ? { ok: true, value: cell.value }
        : { ok: false };
    case 'date':
      return cell.type === 'date'
        ? { ok: true, value: readDate(cell.value) }
        : { ok: false };
    case 'date_range':
      return cell.type === 'date_range'
        ? {
            ok: true,
            value: {
              start: readDate(cell.value.start),
              end: readDate(cell.value.end),
            },
          }
        : { ok: false };
    case 'select':
    case 'tag': {
      if (cell.type !== 'options') return { ok: false };
      const labels: string[] = [];
      for (const ref of cell.value) {
        const match = [...column.options].find(([, o]) =>
          'id' in ref
            ? ref.id === o.id
            : ref.label.toLowerCase() === o.label.toLowerCase()
        );
        if (match === undefined) return { ok: false };
        labels.push(match[0]);
      }
      return { ok: true, value: kind === 'tag' ? labels : (labels[0] ?? null) };
    }
    case 'document':
      return cell.type === 'entities'
        ? { ok: true, value: cell.value[0]?.entityId ?? null }
        : { ok: false };
    case 'relation':
      return cell.type === 'link' || cell.type === 'rows'
        ? { ok: true, value: [...cell.value] }
        : { ok: false };
  }
}

function relationIds(cell: HistoryCell | undefined): string[] {
  return cell !== undefined && (cell.type === 'link' || cell.type === 'rows')
    ? [...cell.value]
    : [];
}

/** Whether a later change of the batch wrote the same column of the same row. */
function overwritten(
  changes: readonly RowChange[],
  at: number,
  columnId: string
): boolean {
  const change = changes[at] as RowChange;
  return changes
    .slice(at + 1)
    .some((c) => c.rowId === change.rowId && c.columns.includes(columnId));
}

function shortText(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? `${one.slice(0, 79)}…` : one;
}

/** Reads every watched table's changes and acts on them (see the header). */
export async function pollEdits(ctx: PipelineContext): Promise<EditPollResult> {
  const schema = ctx.store.schema;
  const who: Attribution = {
    serviceUserId: schema.serviceUserId,
    ownerUserId: schema.ownerUserId,
    isServiceVersion: (tableId, version) =>
      ctx.state.isServiceVersion(tableId, version),
  };
  const tables: {
    table: TableKey;
    since: number;
    version: number;
    changes: number;
    needsFullRead: boolean;
  }[] = [];
  const jobs = new Set<string>();
  const sources = new Set<string>();
  const agent: AgentNote[] = [];
  const unchecked: string[] = [];
  let schemaChanged = false;
  let everyJob = false;
  let versions: Readonly<Record<TableKey, number>> | undefined;
  const advances: { tableId: string; version: number }[] = [];

  for (const table of WATCHED_TABLES) {
    const tableId = schema.tables[table].id;
    const seen = ctx.state.value.tables[tableId]?.seen;
    if (seen === undefined) {
      versions ??= await ctx.store.tableVersions();
      const start = versions[table];
      await ctx.state.update((s) => {
        s.tables[tableId] = {
          seen: start,
          written: s.tables[tableId]?.written ?? [],
        };
      });
      tables.push({
        table,
        since: start,
        version: start,
        changes: 0,
        needsFullRead: false,
      });
      continue;
    }
    const report = await ctx.store.tableChanges(table, seen, who);
    if (report.columns.length > 0) schemaChanged = true;
    if (report.needsFullRead) {
      unchecked.push(schema.tables[table].name);
      if (table !== 'sources') everyJob = true;
    }
    if (table === 'details')
      await detailChanges(ctx, report.changes, jobs, sources, agent);
    else if (table === 'jobs')
      await jobChanges(ctx, report.changes, jobs, agent);
    else sourceChanges(ctx, report.changes, agent);
    advances.push({ tableId, version: report.version });
    tables.push({
      table,
      since: seen,
      version: report.version,
      changes: report.changes.length,
      needsFullRead: report.needsFullRead,
    });
  }

  if (everyJob) {
    const all = await ctx.store.jobs();
    for (const j of all.rows) jobs.add(j.id);
  }
  for (const jobId of jobs) await recomputeJob(ctx, jobId);
  for (const sourceId of sources) await settleSource(ctx, sourceId);
  // Only now is every change of the poll handled and every job derived again.
  await ctx.state.update((s) => {
    for (const { tableId, version } of advances) {
      const t = s.tables[tableId] ?? { seen: 0, written: [] };
      t.seen = Math.max(t.seen, version);
      t.written = t.written.filter((v) => v > t.seen);
      s.tables[tableId] = t;
    }
  });
  const report: EditReport = { agent, unchecked };
  if (agent.length > 0 || unchecked.length > 0) {
    try {
      await ctx.notifier.edits(report);
    } catch (error) {
      ctx.logger.warn('edit report not delivered', { error });
    }
  }
  return { tables, schemaChanged, jobs: [...jobs], report };
}

// ---------------------------------------------------------------------------
// Details.

async function detailChanges(
  ctx: PipelineContext,
  changes: readonly RowChange[],
  jobs: Set<string>,
  sources: Set<string>,
  agent: AgentNote[]
): Promise<void> {
  if (changes.length === 0) return;
  const table = ctx.store.schema.tables.details;
  const columns = table.columns;
  const ids = [...new Set(changes.map((c) => c.rowId))];
  const rows = new Map<string, DetailRow>(
    (await ctx.store.details({ ids })).rows.map((r) => [r.id, r])
  );
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i] as RowChange;
    const row = rows.get(change.rowId);
    for (const id of [
      ...relationIds(change.before[columns.Job.id]),
      ...relationIds(change.after[columns.Job.id]),
      ...(row?.jobIds ?? []),
    ])
      jobs.add(id);
    for (const id of row?.sourceIds ?? []) sources.add(id);
    if (change.kind === 'delete') {
      if (change.author !== 'owner') {
        agent.push({
          table: 'details',
          rowId: change.rowId,
          name: 'a detail',
          what: 'deleted a detail',
          action: 'reported',
          actingBot: change.actingBot,
        });
      }
      continue;
    }
    if (row === undefined || row.field === undefined) continue;
    const edit = detailEdit(change, table);
    const day = dayText(ctx, change.at);
    if (change.author === 'owner') {
      await ownerDetailChange(ctx, change, edit, row, rows);
      continue;
    }
    await agentDetailChange(ctx, changes, i, edit, row, rows, day, agent);
  }
}

/**
 * The columns a detail's checks were made on beyond Value, Quote and Day:
 * its field, label, page and source. A change to one is a change of what the
 * detail says, as a value edit is.
 */
const CHECKED_COLUMNS: ReadonlySet<string> = new Set([
  'Field',
  'Label',
  'Page',
  'Source',
  'Source row',
]);

/** Whether a change rewrote what the detail says (see CHECKED_COLUMNS). */
function contentEdit(edit: ReturnType<typeof detailEdit>): string[] {
  const out: string[] = [];
  for (const [key, e] of [
    ['Value', edit.value],
    ['Quote', edit.quote],
    ['Day', edit.day],
  ] as const) {
    if (e !== undefined && JSON.stringify(e.before) !== JSON.stringify(e.after))
      out.push(key);
  }
  for (const key of edit.others) if (CHECKED_COLUMNS.has(key)) out.push(key);
  return out;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * An agent's change to a detail (see the header): only the owner decides, so
 * a Status or Job change is undone, and a change of what it says is set
 * Needs review.
 */
async function agentDetailChange(
  ctx: PipelineContext,
  changes: readonly RowChange[],
  i: number,
  edit: ReturnType<typeof detailEdit>,
  row: DetailRow,
  rows: Map<string, DetailRow>,
  day: string,
  agent: AgentNote[]
): Promise<void> {
  const change = changes[i] as RowChange;
  const columns = ctx.store.schema.tables.details.columns;
  const field = row.field as FieldName;
  const name = row.name || `${field}: ${row.value}`;
  // Filing is the owner's: a detail an agent moved goes back where it was.
  if (edit.others.includes('Job') && change.kind === 'update') {
    const jobId = columns.Job.id;
    const wrote = relationIds(change.after[jobId]);
    if (!overwritten(changes, i, jobId) && sameIds(row.jobIds, wrote)) {
      const back = relationIds(change.before[jobId]);
      await ctx.store.updateDetail(row.id, { Job: back });
      rows.set(row.id, { ...row, jobIds: back });
      agent.push({
        table: 'details',
        rowId: row.id,
        name,
        what: 'moved a detail to another job',
        action: 'undone',
        actingBot: change.actingBot,
      });
    } else {
      agent.push({
        table: 'details',
        rowId: row.id,
        name,
        what: 'moved a detail to another job; a later change stands',
        action: 'reported',
        actingBot: change.actingBot,
      });
    }
  }
  const current = rows.get(row.id) ?? row;
  const changed = contentEdit(edit);
  if (change.kind === 'insert' || changed.length > 0) {
    if (current.status !== 'Needs review') {
      const what =
        change.kind === 'insert'
          ? `added by the assistant on ${day}`
          : `changed by the assistant on ${day}${
              edit.value?.before.kind === 'text'
                ? ` (it was '${shortText(edit.value.before.text)}')`
                : changed.some((c) => c !== 'Value')
                  ? ` (${changed.join(', ')})`
                  : ''
            }`;
      await ctx.store.updateDetail(row.id, {
        Status: 'Needs review',
        Check: `Needs review: ${what}. ${row.check}`.trim(),
        Name: detailName(field, row.value, 'Needs review'),
      });
      rows.set(row.id, { ...current, status: 'Needs review' });
    }
    agent.push({
      table: 'details',
      rowId: row.id,
      name,
      what:
        change.kind === 'insert'
          ? 'added a detail'
          : changed.includes('Value')
            ? 'changed a detail’s value'
            : `changed a detail’s ${changed.join(', ')}`,
      action: 'needs_review',
      actingBot: change.actingBot,
    });
    return;
  }
  if (edit.status !== undefined) {
    const after = edit.status.after;
    const holds =
      after.kind === 'option' ? current.status === after.option : true;
    if (!overwritten(changes, i, columns.Status.id) && holds) {
      const back = historyInput(
        columns.Status,
        change.before[columns.Status.id]
      );
      const status = (
        back.ok && typeof back.value === 'string' ? back.value : 'Needs review'
      ) as DetailStatus;
      await ctx.store.updateDetail(row.id, {
        Status: status,
        Name: detailName(field, row.value, status),
      });
      rows.set(row.id, { ...current, status });
      agent.push({
        table: 'details',
        rowId: row.id,
        name,
        what: `set its status to ${after.kind === 'option' ? after.option : 'another value'}`,
        action: 'undone',
        actingBot: change.actingBot,
      });
    } else {
      agent.push({
        table: 'details',
        rowId: row.id,
        name,
        what: 'changed its status; a later change stands',
        action: 'reported',
        actingBot: change.actingBot,
      });
    }
    return;
  }
  const rest = edit.others.filter((c) => c !== 'Job');
  if (rest.length > 0 || edit.unpinned.length > 0) {
    agent.push({
      table: 'details',
      rowId: row.id,
      name,
      what: `changed ${rest.join(', ') || 'a column'}`,
      action: 'reported',
      actingBot: change.actingBot,
    });
  }
}

async function ownerDetailChange(
  ctx: PipelineContext,
  change: RowChange,
  edit: ReturnType<typeof detailEdit>,
  row: DetailRow,
  rows: Map<string, DetailRow>
): Promise<void> {
  const field = row.field as FieldName;
  const meta = ctx.state.value.details[row.id];
  if (change.kind === 'insert') {
    if (meta === undefined) {
      await ctx.state.update((s) => {
        s.details[row.id] = { history: false, origin: 'owner' };
      });
    }
    return;
  }
  const after =
    edit.status?.after.kind === 'option' ? edit.status.after.option : undefined;
  const before =
    edit.status?.before.kind === 'option'
      ? edit.status.before.option
      : undefined;
  const decided =
    after === 'Confirmed' || after === 'Rejected' ? after : undefined;
  const valueEdit = contentEdit(edit).length > 0;
  // Found and Replaced are the service's: the owner's Status counts only as
  // Confirmed or Rejected, and Found only ever comes from the checks.
  const notTaken =
    !valueEdit &&
    (after === 'Found' || after === 'Replaced') &&
    row.status === after
      ? after
      : undefined;
  const withdrawn =
    !valueEdit &&
    after === 'Needs review' &&
    (before === 'Confirmed' || before === 'Rejected');
  let status = row.status;
  if (valueEdit && (status === 'Found' || status === 'Needs review')) {
    status = 'Confirmed';
    await ctx.store.updateDetail(row.id, {
      Status: 'Confirmed',
      Check:
        `Entered by you in SupaMac on ${dayText(ctx, change.at)}. ${row.check}`.trim(),
      Name: detailName(field, row.value, 'Confirmed'),
    });
    rows.set(row.id, { ...row, status: 'Confirmed' });
  } else if (notTaken !== undefined) {
    status = 'Needs review';
    await ctx.store.updateDetail(row.id, {
      Status: 'Needs review',
      Check:
        `Needs review: set to ${notTaken} in SupaMac on ${dayText(ctx, change.at)}; only the service’s checks find a detail, and only you confirm one. ${row.check}`.trim(),
      Name: detailName(field, row.value, 'Needs review'),
    });
    rows.set(row.id, { ...row, status: 'Needs review' });
  } else if (valueEdit || decided !== undefined || withdrawn) {
    await ctx.store.updateDetail(row.id, {
      Name: detailName(field, row.value, row.status ?? 'Needs review'),
    });
  }
  const noted =
    decided ?? (valueEdit && status === 'Confirmed' ? 'Confirmed' : undefined);
  const listed =
    noted !== undefined
      ? valueEdit
        ? `${noted} (entered by you)`
        : noted
      : notTaken !== undefined
        ? `Needs review (set to ${notTaken} in SupaMac, which is not taken)`
        : withdrawn
          ? `Needs review (no longer ${before})`
          : undefined;
  if (!valueEdit && listed === undefined) return;
  await ctx.state.update((s) => {
    const current = s.details[row.id] ?? {
      history: true,
      origin: 'document' as const,
    };
    s.details[row.id] = {
      ...current,
      ...(valueEdit ? { origin: 'owner' as const, history: false } : {}),
      ...(noted !== undefined
        ? { decidedAt: change.at, decidedVia: 'supamac' as const }
        : {}),
    };
    // Every Status set in SupaMac is listed in the next summary, so a change
    // the owner did not make shows up.
    if (listed !== undefined) {
      const at = change.at;
      if (
        !s.notes.decidedInSupamac.some(
          (d) => d.detailId === row.id && d.at === at
        )
      ) {
        s.notes.decidedInSupamac.push({
          detailId: row.id,
          status: listed,
          name: `${field}: ${row.value}`,
          at,
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Jobs and Sources.

async function jobChanges(
  ctx: PipelineContext,
  changes: readonly RowChange[],
  jobs: Set<string>,
  agent: AgentNote[]
): Promise<void> {
  const table = ctx.store.schema.tables.jobs;
  const byId = new Map<string, ResolvedColumn>(
    Object.values(table.columns).map((c: ResolvedColumn) => [c.id, c])
  );
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i] as RowChange;
    jobs.add(change.rowId);
    if (change.author === 'owner') continue;
    if (change.kind !== 'update') {
      agent.push({
        table: 'jobs',
        rowId: change.rowId,
        name: 'a job',
        what: change.kind === 'insert' ? 'added a job' : 'deleted a job',
        action: 'reported',
        actingBot: change.actingBot,
      });
      continue;
    }
    const { job, undone } = await undoJobChange(ctx, changes, i, byId);
    agent.push({
      table: 'jobs',
      rowId: change.rowId,
      name: job?.name ?? 'a job',
      what: `changed ${change.columns.map((id) => byId.get(id)?.name ?? 'a column').join(', ')}`,
      action: undone ? 'undone' : 'reported',
      actingBot: change.actingBot,
    });
  }
}

/** A Jobs cell as a write takes it, read from the row; undefined when the row does not carry it. */
function jobCell(row: JobRow, key: string): CellValue | undefined {
  if (key === 'Name') return row.name === '' ? null : row.name;
  if (key === 'Booking') return row.booking ?? null;
  if ((DERIVED_COLUMNS as readonly string[]).includes(key))
    return row.cells[key as DerivedColumn] ?? null;
  return undefined;
}

/**
 * Puts back what an agent changed in a Jobs row: only the cells that still
 * hold what the agent wrote, written at the version they were read at, so a
 * value the owner typed since is never written over.
 */
async function undoJobChange(
  ctx: PipelineContext,
  changes: readonly RowChange[],
  i: number,
  byId: ReadonlyMap<string, ResolvedColumn>
): Promise<{ job: JobRow | undefined; undone: boolean }> {
  const change = changes[i] as RowChange;
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = await ctx.store.job(change.rowId);
    if (got === undefined) return { job: undefined, undone: false };
    const values: Record<string, unknown> = {};
    for (const columnId of change.columns) {
      const column = byId.get(columnId);
      if (column === undefined || overwritten(changes, i, columnId)) continue;
      const back = historyInput(column, change.before[columnId]);
      const wrote = historyInput(column, change.after[columnId]);
      const now = jobCell(got.row, column.key);
      if (!back.ok || !wrote.ok || now === undefined) continue;
      if (!cellsEqual(now, wrote.value as CellValue)) continue;
      values[column.key] = back.value;
    }
    if (Object.keys(values).length === 0)
      return { job: got.row, undone: false };
    try {
      await ctx.store.updateJob(change.rowId, values as RowInput<'jobs'>, {
        baseVersion: got.version,
      });
      return { job: got.row, undone: true };
    } catch (error) {
      if (error instanceof SupaMacError && error.kind === 'conflict') continue;
      throw error;
    }
  }
  throw new PipelineError(
    'retryable',
    'the Jobs row kept changing while an agent’s change was undone'
  );
}

function sourceChanges(
  ctx: PipelineContext,
  changes: readonly RowChange[],
  agent: AgentNote[]
): void {
  const table = ctx.store.schema.tables.sources;
  const byId = new Map<string, ResolvedColumn>(
    Object.values(table.columns).map((c: ResolvedColumn) => [c.id, c])
  );
  for (const change of changes) {
    if (change.author === 'owner') continue;
    const name = cellText(change.after[table.columns.Name.id]);
    agent.push({
      table: 'sources',
      rowId: change.rowId,
      name: name.kind === 'text' ? name.text : 'a source',
      what: `${change.kind === 'update' ? 'changed' : change.kind === 'insert' ? 'added' : 'deleted'} ${change.columns.map((id) => byId.get(id)?.name ?? 'a column').join(', ') || 'a row'}`,
      action: 'reported',
      actingBot: change.actingBot,
    });
  }
}
