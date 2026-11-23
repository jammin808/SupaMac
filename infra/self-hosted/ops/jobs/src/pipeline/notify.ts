// What the pipeline tells the owner, as one interface the Telegram unit
// implements (docs/supamac/jobs.md, "What the owner does", §1, §3, §5,
// Operations: Health). The pipeline decides what is said and when; a
// notifier only delivers it.
//
// Invariants:
// - Every message is built from the service's own records: values are the
//   details' values verbatim, with their status; nothing here is model text.
// - A Found value is worded as found and not confirmed; Confirmed and
//   Rejected come only from the owner.
// - A notifier may throw (Telegram is down); the pipeline then keeps what it
//   would have said where it must not be lost (the list of decisions made in
//   SupaMac is drained only after a summary is delivered) and reports the
//   failure as connection health.
// - Connection changes reach `connection` at most once an hour per
//   connection (health.ts decides); `setup` carries each schema note once.

import type {
  DerivedColumn,
  DetailStatus,
  FieldName,
  PageKind,
  SourceKind,
  SourceStatus,
  Via,
} from '../model';
import type { CellValue } from '../derive';
import type { DecisionNote } from './state';

export interface CellChange {
  readonly column: DerivedColumn;
  readonly from: CellValue;
  readonly to: CellValue;
}

export interface SourceSummary {
  readonly sourceId: string;
  readonly name: string;
  readonly via: Via;
  readonly kind?: SourceKind | undefined;
  readonly status: SourceStatus;
  /** The jobs it was filed under; empty while it waits for the owner. */
  readonly jobs: readonly {
    readonly id: string;
    readonly name: string;
    readonly created: boolean;
  }[];
  readonly counts: {
    readonly details: number;
    readonly found: number;
    readonly needsReview: number;
    /** Older details of the job this source replaced. */
    readonly replaced: number;
  };
  /** What changed in the Jobs row, from what to what. */
  readonly changes: readonly CellChange[];
  /** Cells the owner typed that a source disagrees with; kept as typed. */
  readonly kept: readonly {
    readonly column: DerivedColumn;
    readonly owner: CellValue;
    readonly sources: CellValue;
  }[];
  /** What a number cell cannot say (the Rate), from the derivation. */
  readonly notes: readonly string[];
  /** Detail ids awaiting review, in order: the Review button steps through them. */
  readonly review: readonly string[];
  /** The Sources row's Note. */
  readonly sourceNote?: string | undefined;
  /** Details confirmed or rejected in SupaMac since the last summary. */
  readonly decidedInSupamac: readonly DecisionNote[];
  /** Links into SupaMac, when the web app's address is configured. */
  readonly links?:
    | {
        readonly job?: string | undefined;
        readonly source?: string | undefined;
      }
    | undefined;
}

export interface ReviewCard {
  readonly detailId: string;
  readonly jobId?: string | undefined;
  readonly field: FieldName;
  readonly label: string;
  readonly value: string;
  readonly day?: string | undefined;
  readonly quote: string;
  readonly page?: number | undefined;
  readonly status: DetailStatus;
  readonly check: string;
  readonly sourceId?: string | undefined;
  readonly sourceName?: string | undefined;
  /** The original's document, for the page image of a scan. */
  readonly documentId?: string | undefined;
  readonly pageKind?: PageKind | undefined;
  /** "read by the model from an image; no text was checked", for a scan. */
  readonly imageNote?: string | undefined;
  /** Short digest of what the card shows; a button carries it back. */
  readonly fingerprint: string;
  /** Where the source is in SupaMac, when the web app's address is configured. */
  readonly link?: string | undefined;
}

export interface FilingQuestion {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly parts: readonly {
    /** The reply's job index; null for a source of one job. */
    readonly part: number | null;
    readonly names: readonly string[];
    /** "File under <job>?" for each; New job is always offered. */
    readonly candidates: readonly {
      readonly jobId: string;
      readonly name: string;
      readonly why: string;
    }[];
    readonly reason: string;
  }[];
}

export interface RefusedMail {
  readonly from: string;
  readonly subject?: string | undefined;
  /** The check that failed. */
  readonly check: string;
}

export type Connection = 'supamac' | 'anthropic' | 'telegram' | 'mail';

export interface ConnectionChange {
  readonly connection: Connection;
  readonly up: boolean;
  readonly since: string;
  readonly detail?: string | undefined;
}

export interface SourceFailure {
  readonly sourceId: string;
  readonly name: string;
  readonly reason: string;
  readonly attempts: number;
  /** The Retry button: `Pipeline.retry(sourceId)`. */
  readonly retry: { readonly sourceId: string };
}

export interface EditReport {
  /** Changes an agent made and what the service did about each. */
  readonly agent: readonly {
    readonly table: 'details' | 'jobs' | 'sources';
    readonly rowId: string;
    readonly name: string;
    readonly what: string;
    readonly action: 'undone' | 'needs_review' | 'reported';
    readonly actingBot?: string | null | undefined;
  }[];
  /** The journal could not list every change: these tables were not checked change by change. */
  readonly unchecked: readonly string[];
}

export interface ServiceNote {
  readonly kind: 'schema' | 'spend_limit' | 'setup' | 'error';
  readonly text: string;
}

export interface Notifier {
  sourceSummary(summary: SourceSummary): Promise<void>;
  reviewCard(card: ReviewCard): Promise<void>;
  filingQuestion(question: FilingQuestion): Promise<void>;
  refusedMail(note: RefusedMail): Promise<void>;
  connection(change: ConnectionChange): Promise<void>;
  /** Setup notes, schema notes and the spend limit. */
  note(note: ServiceNote): Promise<void>;
  failure(failure: SourceFailure): Promise<void>;
  edits(report: EditReport): Promise<void>;
}

/** Says nothing: the notifier until the Telegram unit is configured. */
export class NullNotifier implements Notifier {
  async sourceSummary(): Promise<void> {}
  async reviewCard(): Promise<void> {}
  async filingQuestion(): Promise<void> {}
  async refusedMail(): Promise<void> {}
  async connection(): Promise<void> {}
  async note(): Promise<void> {}
  async failure(): Promise<void> {}
  async edits(): Promise<void> {}
}

export type Notice =
  | { readonly kind: 'summary'; readonly value: SourceSummary }
  | { readonly kind: 'review'; readonly value: ReviewCard }
  | { readonly kind: 'filing'; readonly value: FilingQuestion }
  | { readonly kind: 'refused'; readonly value: RefusedMail }
  | { readonly kind: 'connection'; readonly value: ConnectionChange }
  | { readonly kind: 'note'; readonly value: ServiceNote }
  | { readonly kind: 'failure'; readonly value: SourceFailure }
  | { readonly kind: 'edits'; readonly value: EditReport };

export type NoticeValue<K extends Notice['kind']> = Extract<
  Notice,
  { kind: K }
>['value'];

/** Keeps every notice, for tests; `failing` makes every call throw. */
export class RecordingNotifier implements Notifier {
  readonly notices: Notice[] = [];
  failing = false;

  private push(notice: Notice): Promise<void> {
    if (this.failing)
      return Promise.reject(new Error('the notifier is failing'));
    this.notices.push(notice);
    return Promise.resolve();
  }

  of<K extends Notice['kind']>(kind: K): NoticeValue<K>[] {
    return this.notices.flatMap((n) =>
      n.kind === kind ? [n.value as NoticeValue<K>] : []
    );
  }

  sourceSummary(value: SourceSummary): Promise<void> {
    return this.push({ kind: 'summary', value });
  }
  reviewCard(value: ReviewCard): Promise<void> {
    return this.push({ kind: 'review', value });
  }
  filingQuestion(value: FilingQuestion): Promise<void> {
    return this.push({ kind: 'filing', value });
  }
  refusedMail(value: RefusedMail): Promise<void> {
    return this.push({ kind: 'refused', value });
  }
  connection(value: ConnectionChange): Promise<void> {
    return this.push({ kind: 'connection', value });
  }
  note(value: ServiceNote): Promise<void> {
    return this.push({ kind: 'note', value });
  }
  failure(value: SourceFailure): Promise<void> {
    return this.push({ kind: 'failure', value });
  }
  edits(value: EditReport): Promise<void> {
    return this.push({ kind: 'edits', value });
  }
}
