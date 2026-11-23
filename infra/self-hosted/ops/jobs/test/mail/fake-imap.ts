// An in-process IMAP mailbox and an ImapFlow-like client over it, for the
// mailbox reader's tests: folders of messages with UIDs, flags and arrival
// dates, MOVE, the header-only fetch and the full-source fetch, the events
// ImapFlow emits, and the failures a test asks for (a command the server
// refuses is thrown as imapflow throws a tagged NO or BAD). It records every
// command, so a test can show that a refused message's body was never read.

import type {
  FetchedMessage,
  FetchQuery,
  ImapClient,
  ImapClientFactory,
  ListedMailbox,
} from '../../src/mail/imap';

export interface StoredMessage {
  readonly uid: number;
  readonly raw: Uint8Array;
  readonly flags: Set<string>;
  readonly internalDate: Date;
  /** What RFC822.SIZE reports; the raw length unless set. */
  readonly size?: number | undefined;
  /** What BODY[HEADER] gives, when a test wants it to differ from the source's. */
  readonly headers?: Uint8Array | undefined;
}

export type Command =
  | { readonly op: 'connect'; readonly verifyOnly: boolean }
  | { readonly op: 'logout' }
  | { readonly op: 'list' }
  | { readonly op: 'create'; readonly path: string }
  | { readonly op: 'open'; readonly path: string }
  | { readonly op: 'search' }
  | { readonly op: 'fetch'; readonly range: string; readonly query: FetchQuery }
  | {
      readonly op: 'fetchOne';
      readonly range: string;
      readonly query: FetchQuery;
    }
  | { readonly op: 'move'; readonly uid: number; readonly to: string }
  | { readonly op: 'unflag'; readonly uid: number; readonly flags: string[] };

/** The header block of a message: up to and including its first empty line. */
export function headerBlockOf(raw: Uint8Array): Uint8Array {
  for (let i = 0; i + 3 < raw.length; i++) {
    if (
      raw[i] === 0x0d &&
      raw[i + 1] === 0x0a &&
      raw[i + 2] === 0x0d &&
      raw[i + 3] === 0x0a
    )
      return raw.slice(0, i + 4);
  }
  return raw.slice();
}

export class FakeImapServer {
  readonly folders = new Map<string, StoredMessage[]>([['INBOX', []]]);
  readonly commands: Command[] = [];
  readonly clients: FakeImapClient[] = [];
  uidValidity = 7n;
  private nextUid = 100;
  /** Thrown by every connect while set. */
  connectError: unknown;
  /** Thrown by the next INBOX open, once. */
  openError: unknown;
  /** UIDs the server will not move. */
  readonly unmovable = new Set<number>();
  /** Answers CREATE with an error (the folder then has to be listed). */
  createFails = false;
  /** The path prefix the server lists and makes folders under. */
  prefix = '';
  /** Answers FETCH with no header block. */
  omitHeaders = false;
  /** Runs on every FETCH with its range, after it is recorded; a throw is the server's answer. */
  beforeFetch: ((range: string) => void) | undefined;
  /** The same, for the single-message fetch. */
  beforeFetchOne: ((range: string) => void) | undefined;

  deliver(
    raw: Uint8Array,
    options: {
      flags?: string[];
      size?: number;
      headers?: Uint8Array;
      at?: Date;
    } = {}
  ): number {
    const uid = this.nextUid++;
    this.inbox.push({
      uid,
      raw,
      flags: new Set(options.flags ?? []),
      internalDate: options.at ?? new Date('2027-03-01T17:00:05Z'),
      ...(options.size !== undefined ? { size: options.size } : {}),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
    });
    this.client?.emit('exists', {
      path: 'INBOX',
      count: this.inbox.length,
      prevCount: this.inbox.length - 1,
    });
    return uid;
  }

  get inbox(): StoredMessage[] {
    return this.folders.get('INBOX') as StoredMessage[];
  }

  folder(name: string): StoredMessage[] {
    return this.folders.get(this.prefix + name) ?? [];
  }

  uids(name: string): number[] {
    return (this.folders.get(name) ?? []).map((m) => m.uid);
  }

  /** The newest client, as the reader holds it. */
  get client(): FakeImapClient | undefined {
    return this.clients[this.clients.length - 1];
  }

  count(op: Command['op']): number {
    return this.commands.filter((c) => c.op === op).length;
  }

  factory(): ImapClientFactory {
    return ({ verifyOnly }) => {
      const client = new FakeImapClient(this, verifyOnly);
      this.clients.push(client);
      return client;
    };
  }
}

type Listener = (arg: unknown) => void;

export class FakeImapClient implements ImapClient {
  usable = false;
  closed = false;
  private selected: string | undefined;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    private readonly server: FakeImapServer,
    private readonly verifyOnly: boolean
  ) {}

  on(event: 'error' | 'close' | 'exists', listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, arg?: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(arg);
  }

  /** The server drops the connection. */
  drop(): void {
    this.usable = false;
    this.emit('close');
  }

  private live(): void {
    if (!this.usable) {
      const error = new Error('Connection not available') as Error & {
        code: string;
      };
      error.code = 'NoConnection';
      throw error;
    }
  }

  async connect(): Promise<void> {
    this.server.commands.push({ op: 'connect', verifyOnly: this.verifyOnly });
    if (this.server.connectError !== undefined) throw this.server.connectError;
    this.usable = !this.verifyOnly;
  }

  async logout(): Promise<void> {
    this.server.commands.push({ op: 'logout' });
    this.usable = false;
    this.emit('close');
  }

  close(): void {
    this.closed = true;
    this.usable = false;
  }

  async list(): Promise<readonly ListedMailbox[]> {
    this.live();
    this.server.commands.push({ op: 'list' });
    return [...this.server.folders.keys()].map((path) => {
      const parts = path.split('.');
      return {
        path,
        name: parts[parts.length - 1] as string,
        parent: parts.slice(0, -1),
      };
    });
  }

  async mailboxCreate(path: string): Promise<{ readonly path: string }> {
    this.live();
    this.server.commands.push({ op: 'create', path });
    if (this.server.createFails) {
      this.server.folders.set(this.server.prefix + path, []);
      throw new Error('Mailbox already exists');
    }
    const full = this.server.prefix + path;
    if (!this.server.folders.has(full)) this.server.folders.set(full, []);
    return { path: full };
  }

  async mailboxOpen(path: string): Promise<{
    readonly path: string;
    readonly uidValidity: bigint;
    readonly exists: number;
  }> {
    this.live();
    this.server.commands.push({ op: 'open', path });
    if (this.server.openError !== undefined) {
      const error = this.server.openError;
      this.server.openError = undefined;
      throw error;
    }
    this.selected = path;
    return {
      path,
      uidValidity: this.server.uidValidity,
      exists: this.server.folders.get(path)?.length ?? 0,
    };
  }

  private box(): StoredMessage[] {
    if (this.selected === undefined) throw new Error('no mailbox selected');
    return this.server.folders.get(this.selected) ?? [];
  }

  async search(): Promise<number[]> {
    this.live();
    this.server.commands.push({ op: 'search' });
    return this.box().map((m) => m.uid);
  }

  private view(m: StoredMessage, query: FetchQuery): FetchedMessage {
    return {
      uid: m.uid,
      ...(query.size ? { size: m.size ?? m.raw.length } : {}),
      ...(query.flags ? { flags: new Set(m.flags) } : {}),
      ...(query.internalDate ? { internalDate: m.internalDate } : {}),
      ...(query.headers && !this.server.omitHeaders
        ? { headers: m.headers ?? headerBlockOf(m.raw) }
        : {}),
      ...(query.source ? { source: m.raw.slice() } : {}),
    };
  }

  async *fetch(
    range: string,
    query: FetchQuery
  ): AsyncGenerator<FetchedMessage> {
    this.live();
    this.server.commands.push({ op: 'fetch', range, query });
    this.server.beforeFetch?.(range);
    const wanted = new Set(range.split(',').map(Number));
    for (const m of this.box())
      if (wanted.has(m.uid)) yield this.view(m, query);
  }

  async fetchOne(
    range: string,
    query: FetchQuery
  ): Promise<FetchedMessage | false> {
    this.live();
    this.server.commands.push({ op: 'fetchOne', range, query });
    this.server.beforeFetchOne?.(range);
    const m = this.box().find((x) => x.uid === Number(range));
    return m === undefined ? false : this.view(m, query);
  }

  async messageMove(range: string, destination: string): Promise<unknown> {
    this.live();
    const uid = Number(range);
    this.server.commands.push({ op: 'move', uid, to: destination });
    if (this.server.unmovable.has(uid)) return false;
    const box = this.box();
    const at = box.findIndex((m) => m.uid === uid);
    const target = this.server.folders.get(destination);
    if (at < 0 || target === undefined) return false;
    const [m] = box.splice(at, 1);
    target.push(m as StoredMessage);
    return { path: this.selected, destination };
  }

  async messageFlagsRemove(range: string, flags: string[]): Promise<boolean> {
    this.live();
    const uid = Number(range);
    this.server.commands.push({ op: 'unflag', uid, flags });
    const m = this.box().find((x) => x.uid === uid);
    if (m === undefined) return false;
    for (const f of flags) m.flags.delete(f);
    return true;
  }
}

/** An error as imapflow raises it for a refused login. */
export function loginRefused(): Error {
  const error = new Error('Authentication failed.') as Error & {
    authenticationFailed: boolean;
    serverResponseCode: string;
  };
  error.authenticationFailed = true;
  error.serverResponseCode = 'AUTHENTICATIONFAILED';
  return error;
}

/** An error as Node raises it for a socket or TLS failure. */
export function socketError(code: string, message = code): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
