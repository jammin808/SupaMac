// The store the pipeline is given before the Jobs database is verified
// (main.ts starts the intakes first, so the owner's notifier can deliver the
// schema's notes): every call waits for the verified store and then runs on
// it.
//
// Invariants:
// - No call reaches SupaMac before `resolve`; after `fail` every call is
//   refused with the start's own error, so nothing is written to a database
//   the service could not verify.
// - `schema` is known only once resolved; read before that, it refuses with
//   a retryable error.

import type { Attribution, TableChangeReport } from '../supamac/changes';
import type { FolderDocument, Uploaded } from '../supamac/documents';
import type {
  FolderKey,
  JobsSchema,
  RowInput,
  TableKey,
} from '../supamac/tables';
import { PipelineError } from './context';
import type {
  DetailFilter,
  DetailRow,
  JobRow,
  JobsStore,
  Read,
  SourceFilter,
  SourceRow,
  StatusValues,
} from './store';

export class PendingStore implements JobsStore {
  private target: JobsStore | undefined;
  private readonly ready: Promise<JobsStore>;
  private settle: (store: JobsStore) => void = () => undefined;
  private refuse: (error: unknown) => void = () => undefined;

  constructor() {
    this.ready = new Promise<JobsStore>((resolve, reject) => {
      this.settle = resolve;
      this.refuse = reject;
    });
    // A start that fails before any call is made leaves nothing unhandled.
    this.ready.catch(() => undefined);
  }

  /** The verified store: every call waiting and every later one runs on it. */
  resolve(store: JobsStore): void {
    this.target = store;
    this.settle(store);
  }

  /** The start failed: every call is refused with its error. */
  fail(error: unknown): void {
    if (this.target === undefined) this.refuse(error);
  }

  get schema(): JobsSchema {
    if (this.target === undefined)
      throw new PipelineError(
        'retryable',
        'the Jobs database is not verified yet'
      );
    return this.target.schema;
  }

  private on(): Promise<JobsStore> {
    return this.target !== undefined
      ? Promise.resolve(this.target)
      : this.ready;
  }

  async insertSource(values: RowInput<'sources'>): Promise<string> {
    return (await this.on()).insertSource(values);
  }
  async updateSource(id: string, values: RowInput<'sources'>): Promise<void> {
    return (await this.on()).updateSource(id, values);
  }
  async sources(filter: SourceFilter): Promise<Read<SourceRow>> {
    return (await this.on()).sources(filter);
  }
  async insertDetails(rows: readonly RowInput<'details'>[]): Promise<string[]> {
    return (await this.on()).insertDetails(rows);
  }
  async updateDetail(id: string, values: RowInput<'details'>): Promise<void> {
    return (await this.on()).updateDetail(id, values);
  }
  async details(filter: DetailFilter): Promise<Read<DetailRow>> {
    return (await this.on()).details(filter);
  }
  async insertJob(values: RowInput<'jobs'>): Promise<string> {
    return (await this.on()).insertJob(values);
  }
  async updateJob(
    id: string,
    values: RowInput<'jobs'>,
    options?: { readonly baseVersion?: number | undefined }
  ): Promise<void> {
    return (await this.on()).updateJob(id, values, options);
  }
  async jobs(ids?: readonly string[]): Promise<Read<JobRow>> {
    return (await this.on()).jobs(ids);
  }
  async job(id: string): Promise<{ row: JobRow; version: number } | undefined> {
    return (await this.on()).job(id);
  }
  async writeStatus(
    rowId: string | undefined,
    values: StatusValues
  ): Promise<string> {
    return (await this.on()).writeStatus(rowId, values);
  }
  async tableVersions(): Promise<Readonly<Record<TableKey, number>>> {
    return (await this.on()).tableVersions();
  }
  async tableChanges(
    table: TableKey,
    since: number,
    who: Attribution
  ): Promise<TableChangeReport> {
    return (await this.on()).tableChanges(table, since, who);
  }
  async uploadFile(
    name: string,
    bytes: Uint8Array,
    folder: FolderKey
  ): Promise<Uploaded> {
    return (await this.on()).uploadFile(name, bytes, folder);
  }
  async uploadMarkdown(
    name: string,
    markdown: string,
    folder: FolderKey
  ): Promise<Uploaded> {
    return (await this.on()).uploadMarkdown(name, markdown, folder);
  }
  async folderDocuments(folder: FolderKey): Promise<FolderDocument[]> {
    return (await this.on()).folderDocuments(folder);
  }
  async downloadDocument(id: string): Promise<Uint8Array> {
    return (await this.on()).downloadDocument(id);
  }
  async moveDocument(id: string, folder: FolderKey): Promise<void> {
    return (await this.on()).moveDocument(id, folder);
  }
  async readMarkdown(
    id: string
  ): Promise<{ markdown: string; revision: string }> {
    return (await this.on()).readMarkdown(id);
  }
  async writeMarkdown(
    id: string,
    markdown: string,
    revision: string
  ): Promise<void> {
    return (await this.on()).writeMarkdown(id, markdown, revision);
  }
}
