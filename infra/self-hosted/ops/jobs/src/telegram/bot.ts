// The SupaMac bot on Telegram (docs/supamac/jobs.md §1 Telegram, "What the
// owner does", §4 and §5 as the owner answers them, "Asking", Security: the
// bot token, Setup), and the Notifier the pipeline tells the owner through.
//
// Invariants:
// - Only the owner is heard: a message counts only from a private chat whose
//   id equals the sender's id equals the linked owner's (or
//   JOBS_TELEGRAM_OWNER_ID's), and a button press only from that account on
//   a message in that chat. Every other update is dropped unread and
//   unanswered (no reply, no answerCallbackQuery, no file fetched), and
//   acknowledged so it never comes back.
// - Linking: with no owner, a private `/start <code>` is checked against the
//   state's single-use code in constant time, first against the state as it
//   is read (so a wrong code writes nothing), then by state.ts
//   `spendLinkCode`, which burns the code on success; a wrong code gets no
//   answer, and every later `/start`, right or wrong, is ignored.
// - A source is a document, a photo (its largest size), a forwarded message
//   or `/add <text>` (Via Note: "your note"). Plain typed text is a question,
//   never a source. Sources and questions are taken only while the Telegram
//   way in is on; linking and the notes work whatever it is.
// - An update is acknowledged (its id recorded and the offset moved past it)
//   only once it is handled, and in id order: one still in hand holds back
//   the offset for every later one, so a restart never loses it. An update
//   already recorded is ignored. An acknowledgement whose state write failed
//   is written again before the next poll. An update that cannot be read
//   (taking it throws) is acknowledged unread, so it holds back nothing.
// - A stop or a halt is not a handling: work it cuts short, and work not yet
//   started, stays in hand unacknowledged, so the next start takes it again;
//   the owner is not asked to send it again.
// - Work that writes (sources, `/tz`, button presses) runs one at a time in
//   the order it came; questions and lists run one at a time beside it, so a
//   long source does not hold an answer back. A press is answered with
//   answerCallbackQuery as it arrives; what it did is then shown by editing
//   its message.
// - A Review press re-reads the detail first (review.ts): a card whose detail
//   changed in SupaMac records nothing and shows the detail as it now reads.
//   The owner's own press again (a double tap, or a press delivered again)
//   is not a change in SupaMac: when nothing changed since this bot recorded
//   it, the card moves on as the first press did; when it was decided on
//   Telegram that way but this bot did not see it, it says it was already
//   decided and shows the detail as it now reads.
// - A question goes to the pipeline's answer path (answers.ts, with the four
//   AnswerTools queries it supplies); the answer is ai/render.ts's, escaped.
// - A 409 Conflict, or a webhook set on the bot, halts the bot: polling stops,
//   the owner is told once to revoke the token, and nothing else is sent or
//   fetched with the token (no file, no press answered).
// - No message carries the token; every error text shown or logged is masked.
//
// Choices where the design is silent, each the more cautious one:
// - A file's caption is neither a note nor a question; the owner is told it
//   was not read.
// - A failed update is tried again (1, 5, 15 minutes) while the failure is
//   one that can pass, then the owner is told to send it again and it is
//   acknowledged; a later update handled meanwhile is acknowledged after it.
//   A restart while a source is in hand may answer a question asked
//   meanwhile a second time; it never loses a source.
// - The halt stops the bot, not the service: an intake has no way to stop
//   the service, and a start that threw would restart into the same note.
//   /health shows the Telegram loop failing from then on.
// - A Review press on a summary sends the first card as a new message, and
//   each Confirm, Reject or Skip edits that card into the next one, so the
//   summary stays as it was.
// - A scan's card has an Original button that sends the original file (no
//   page image is rendered on this stack).
// - A wrong link code is logged without the code, at most once a minute,
//   with the count refused since the last line.
// - A scan's original over Telegram's upload limit is not sent; the owner is
//   told to open it in SupaMac.

import { createHash, timingSafeEqual } from 'node:crypto';
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { type AnswerTools, dayContext } from '../ai/answer';
import { isTimeZone } from '../config';
import type { Logger } from '../log';
import type { DetailStatus } from '../model';
import type { AskOutcome } from '../pipeline/answers';
import { errorText, isRetryable } from '../pipeline/context';
import type {
  FilingAnswer,
  FilingChoice,
  FilingResult,
} from '../pipeline/filing';
import type {
  Connection,
  ConnectionChange,
  EditReport,
  FilingQuestion,
  Notifier,
  RefusedMail,
  ReviewCard,
  ServiceNote,
  SourceFailure,
  SourceSummary,
} from '../pipeline/notify';
import type { Pipeline } from '../pipeline/pipeline';
import type { SourceInput, SourceResult } from '../pipeline/process';
import type { ReviewPress, ReviewResult } from '../pipeline/review';
import type { StateStore } from '../pipeline/state';
import {
  type BotApi,
  type CallbackQuery,
  hasUnreadContent,
  type IncomingUpdate,
  type Keyboard,
  MAX_DOWNLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  type Message,
  type SentMessage,
  type Sleep,
  sleep as realSleep,
  TelegramError,
} from './api';
import {
  answerMessage,
  CAPTION_TEXT,
  CHANGED_LEAD,
  type Callback,
  connectionMessage,
  decisionLead,
  editsMessage,
  escapeHtml,
  failureMessage,
  filingMessages,
  HALT_CONFLICT_TEXT,
  HALT_WEBHOOK_TEXT,
  HELP_TEXT,
  jobKey,
  jobsListMessage,
  LINKED_TEXT,
  MISSING_TEXT,
  nameHtml,
  nameText,
  noteMessage,
  type OutMessage,
  offText,
  originalCaption,
  plainMessage,
  readCallback,
  refusedMailMessage,
  reviewCardMessage,
  safe,
  summaryMessage,
  TOO_BIG_TEXT,
  UNREAD_TEXT,
  walkEndMessage,
} from './render';

/** Tries of one update before the owner is told to send it again. */
export const MAX_UPDATE_ATTEMPTS = 3;
const UPDATE_BACKOFF_MS = [60_000, 300_000, 900_000];
/** The wait before polling again while every update Telegram returned is in hand. */
export const BUSY_POLL_MS = 3_000;
const MAX_POLL_BACKOFF_MS = 60_000;
const UNAUTHORISED_BACKOFF_MS = 300_000;
/** The decisions this bot recorded that it remembers, to know a press repeated. */
const REMEMBERED_DECISIONS = 256;
/** The least time between two log lines about refused link codes. */
const REFUSED_CODE_LOG_MS = 60_000;

export type RetryOutcome = Awaited<ReturnType<Pipeline['retry']>>;

/** What the bot asks of the pipeline (pipeline.ts). */
export interface BotPipeline {
  processSource(input: SourceInput): Promise<SourceResult>;
  ask(
    question: string,
    options?: {
      readonly key?: string | undefined;
      readonly signal?: AbortSignal | undefined;
    }
  ): Promise<AskOutcome>;
  answerTools(): AnswerTools;
  retry(sourceId: string): Promise<RetryOutcome>;
  answerFiling(answer: FilingAnswer): Promise<FilingResult>;
  reviewCards(filter?: {
    sourceId?: string;
    jobId?: string;
  }): Promise<ReviewCard[]>;
  applyReview(press: ReviewPress): Promise<ReviewResult>;
  setTimeZone(zone: string): Promise<boolean>;
}

/** What the bot reports to the service's health (health.ts). */
export interface BotHealth {
  succeeded(name: string): void;
  failed(name: string, error: string): void;
  connection(name: Connection, up: boolean, detail?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// The notifier.

export interface NotifierOptions {
  readonly api: BotApi;
  readonly state: StateStore;
  readonly logger: Logger;
  readonly timeZone: () => string;
  /** JOBS_TELEGRAM_OWNER_ID, when set. */
  readonly ownerId?: number | undefined;
}

/** Whether a Failed source's saved model reply is one that could not be used. */
export function savedInvalidReply(
  state: StateStore,
  sourceId: string
): boolean {
  const hash = state.value.sources[sourceId]?.hash;
  return hash !== undefined && state.value.replies[hash]?.invalid !== undefined;
}

/** Tells the owner on Telegram; throws when no one is linked, the bot halted, or Telegram refused. */
export class TelegramNotifier implements Notifier {
  private haltedWith: string | undefined;

  constructor(private readonly options: NotifierOptions) {}

  /** Why the bot halted, once it has. */
  get halted(): string | undefined {
    return this.haltedWith;
  }

  /** The owner's Telegram id, when linked. */
  get owner(): number | undefined {
    return this.options.ownerId ?? this.options.state.ownerId;
  }

  /** The owner's chat; throws when the bot halted or no one is linked. */
  ownerChat(): number {
    if (this.haltedWith !== undefined)
      throw new TelegramError(
        'halted',
        'notify',
        'the bot stopped using Telegram; revoke its token'
      );
    const owner = this.owner;
    if (owner === undefined)
      throw new TelegramError(
        'not_linked',
        'notify',
        'no Telegram account is linked yet'
      );
    return owner;
  }

  /** Sends every part of a message to the owner; the last one carries the buttons. */
  async send(message: OutMessage): Promise<SentMessage | undefined> {
    const chat = this.ownerChat();
    let last: SentMessage | undefined;
    for (const [i, part] of message.parts.entries()) {
      last = await this.options.api.sendMessage(
        chat,
        part,
        i === message.parts.length - 1 ? message.keyboard : undefined
      );
    }
    return last;
  }

  /** Stops every later message; tells the owner this one, once. */
  async halt(text: string): Promise<void> {
    if (this.haltedWith !== undefined) return;
    const owner = this.owner;
    this.haltedWith = text;
    if (owner === undefined) return;
    try {
      await this.options.api.sendMessage(owner, `<b>${escapeHtml(text)}</b>`);
    } catch (error) {
      this.options.logger.warn('telegram halt note not delivered', { error });
    }
  }

  async sourceSummary(summary: SourceSummary): Promise<void> {
    await this.send(summaryMessage(summary, this.options.timeZone()));
  }

  async reviewCard(card: ReviewCard): Promise<void> {
    const chat = this.ownerChat();
    const m = reviewCardMessage(card);
    await this.options.api.sendMessage(chat, m.html, m.keyboard);
  }

  async filingQuestion(question: FilingQuestion): Promise<void> {
    const messages = filingMessages(question);
    this.ownerChat();
    for (const m of messages) await this.send(m);
  }

  async refusedMail(note: RefusedMail): Promise<void> {
    await this.send(refusedMailMessage(note));
  }

  async connection(change: ConnectionChange): Promise<void> {
    await this.send(connectionMessage(change, this.options.timeZone()));
  }

  async note(note: ServiceNote): Promise<void> {
    await this.send(noteMessage(note));
  }

  async failure(failure: SourceFailure): Promise<void> {
    await this.send(
      failureMessage(failure, {
        freshReading: savedInvalidReply(this.options.state, failure.sourceId),
      })
    );
  }

  async edits(report: EditReport): Promise<void> {
    const m = editsMessage(report);
    if (m !== undefined) await this.send(m);
  }
}

// ---------------------------------------------------------------------------
// What an update is.

export interface FileRef {
  readonly fileId: string;
  readonly size?: number | undefined;
  readonly name: string;
  readonly contentType?: string | undefined;
  readonly hasCaption: boolean;
}

export type Route =
  /** Not the owner's, or nothing the bot reads: unread and unanswered. */
  | { readonly kind: 'drop' }
  | { readonly kind: 'link'; readonly code: string; readonly userId: number }
  /** The owner's, but nothing to do (a `/start` after linking). */
  | { readonly kind: 'ignore' }
  | { readonly kind: 'help' }
  | { readonly kind: 'jobs' }
  | { readonly kind: 'tz'; readonly zone?: string | undefined }
  | { readonly kind: 'note'; readonly text: string }
  | { readonly kind: 'file'; readonly file: FileRef; readonly photo: boolean }
  | { readonly kind: 'forward'; readonly text: string }
  | { readonly kind: 'question'; readonly text: string }
  | { readonly kind: 'unknown_command'; readonly command: string }
  | { readonly kind: 'unread' };

const COMMAND_RE =
  /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]{1,64})?(?:\s+([\s\S]*))?$/;
const LINK_CODE_RE = /^[A-Za-z0-9]{4,64}$/;

/** Whether a message is in a private chat with its own sender, a person. */
function privateFromSender(m: Message): boolean {
  return (
    m.chat.type === 'private' &&
    m.from !== undefined &&
    !m.from.is_bot &&
    m.sender_chat === undefined &&
    m.chat.id === m.from.id
  );
}

/** Whether a button press is the owner's, on a message in the owner's chat. */
export function isOwnerPress(
  q: CallbackQuery,
  owner: number | undefined
): boolean {
  return (
    owner !== undefined &&
    !q.from.is_bot &&
    q.from.id === owner &&
    q.message !== undefined &&
    q.message.chat.type === 'private' &&
    q.message.chat.id === owner
  );
}

/** A name from Telegram as a source's name: one line, no path, bounded. */
export function sourceName(name: string | undefined, fallback: string): string {
  const clean = (name ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/[\\/]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (clean === '') return fallback;
  return clean.length > 120 ? clean.slice(0, 120) : clean;
}

/** The largest size of a photo: most pixels, then most bytes. */
export function largestPhoto<
  T extends { width: number; height: number; file_size?: number | undefined },
>(sizes: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const s of sizes) {
    if (
      best === undefined ||
      s.width * s.height > best.width * best.height ||
      (s.width * s.height === best.width * best.height &&
        (s.file_size ?? 0) > (best.file_size ?? 0))
    )
      best = s;
  }
  return best;
}

function stamp(seconds: number, timeZone: string): string {
  return format(new TZDate(seconds * 1000, timeZone), 'yyyy-MM-dd-HHmmss');
}

/** What a message is, for the owner (see the header); `drop` for anyone else. */
export function routeMessage(
  m: Message,
  owner: number | undefined,
  timeZone: string
): Route {
  if (!privateFromSender(m) || m.from === undefined) return { kind: 'drop' };
  const text = m.text?.trim();
  const command = text === undefined ? null : COMMAND_RE.exec(text);
  const name = command?.[1]?.toLowerCase();
  const argument = command?.[2]?.trim();
  if (owner === undefined) {
    if (
      name === 'start' &&
      argument !== undefined &&
      LINK_CODE_RE.test(argument)
    )
      return { kind: 'link', code: argument, userId: m.from.id };
    return { kind: 'drop' };
  }
  if (m.from.id !== owner) return { kind: 'drop' };

  const forwarded =
    m.forward_origin !== undefined || m.forward_date !== undefined;
  if (m.document !== undefined) {
    return {
      kind: 'file',
      photo: false,
      file: {
        fileId: m.document.file_id,
        size: m.document.file_size,
        name: sourceName(
          m.document.file_name,
          `document-${stamp(m.date, timeZone)}`
        ),
        contentType: m.document.mime_type,
        hasCaption: (m.caption ?? '').trim() !== '',
      },
    };
  }
  const photo = largestPhoto(m.photo ?? []);
  if (photo !== undefined) {
    return {
      kind: 'file',
      photo: true,
      file: {
        fileId: photo.file_id,
        size: photo.file_size,
        name: `photo-${stamp(m.date, timeZone)}.jpg`,
        contentType: 'image/jpeg',
        hasCaption: (m.caption ?? '').trim() !== '',
      },
    };
  }
  if (forwarded) {
    const body = (m.text ?? m.caption ?? '').trim();
    return body === '' ? { kind: 'unread' } : { kind: 'forward', text: body };
  }
  if (hasUnreadContent(m)) return { kind: 'unread' };
  if (name !== undefined) {
    switch (name) {
      case 'start':
        return { kind: 'ignore' };
      case 'help':
        return { kind: 'help' };
      case 'jobs':
        return { kind: 'jobs' };
      case 'tz':
        return { kind: 'tz', zone: argument === '' ? undefined : argument };
      case 'add':
        return { kind: 'note', text: argument ?? '' };
      default:
        return { kind: 'unknown_command', command: name };
    }
  }
  if (text !== undefined && text !== '') return { kind: 'question', text };
  return { kind: 'unread' };
}

const WORK_ROUTES: ReadonlySet<Route['kind']> = new Set([
  'file',
  'forward',
  'note',
  'tz',
]);

/** Where a forward came from, as the Sources row's From. */
function originName(m: Message): string | undefined {
  const o = m.forward_origin;
  if (o === undefined) return undefined;
  const user = o.sender_user;
  if (user !== undefined)
    return [user.first_name, user.last_name].filter(Boolean).join(' ');
  if (o.sender_user_name !== undefined) return o.sender_user_name;
  const chat = o.sender_chat ?? o.chat;
  return chat?.title ?? chat?.username;
}

function accountName(m: Message): string | undefined {
  const from = m.from;
  if (from === undefined) return undefined;
  return from.username !== undefined
    ? `@${from.username} on Telegram`
    : `${from.first_name} on Telegram`;
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

const ZONE_RE = /^[A-Za-z][A-Za-z0-9_+\-/]{1,63}$/;

// ---------------------------------------------------------------------------
// The bot.

export interface BotOptions {
  readonly api: BotApi;
  readonly notifier: TelegramNotifier;
  readonly state: StateStore;
  readonly pipeline: BotPipeline;
  readonly logger: Logger;
  readonly clock: () => Date;
  readonly timeZone: () => string;
  readonly health?: BotHealth | undefined;
  /** Why sources and questions are off; undefined while the way in is on. */
  readonly off?: string | undefined;
  /** The Retry of a source whose saved reply could not be used: a fresh reading. */
  readonly freshRetry: (sourceId: string) => Promise<RetryOutcome>;
  /** An original's bytes from SupaMac, for a scan's card. */
  readonly downloadDocument: (documentId: string) => Promise<Uint8Array>;
  readonly sleep?: Sleep | undefined;
  readonly busyPollMs?: number | undefined;
}

type Chain = 'work' | 'talk';

export class Bot {
  private readonly api: BotApi;
  private readonly notifier: TelegramNotifier;
  private readonly state: StateStore;
  private readonly pipeline: BotPipeline;
  private readonly logger: Logger;
  private readonly sleep: Sleep;

  /** Updates taken and not yet acknowledged, in id order. */
  private order: number[] = [];
  /** Updates being handled, or handled and waiting for an earlier one. */
  private readonly inHand = new Set<number>();
  private readonly finished = new Set<number>();
  /** Handled without a word: acknowledged without recording each one. */
  private readonly quiet = new Set<number>();
  private readonly attempts = new Map<number, number>();
  private readonly retryAt = new Map<number, number>();
  private readonly chains: Record<Chain, Promise<void>> = {
    work: Promise.resolve(),
    talk: Promise.resolve(),
  };
  private readonly tasks = new Set<Promise<void>>();
  private acking: Promise<void> = Promise.resolve();
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;
  /**
   * The decisions this bot recorded, by detail: the fingerprint pressed and
   * the card's fingerprint after it, to know the same press again.
   */
  private readonly decisions = new Map<
    string,
    {
      readonly pressed: string;
      readonly status: DetailStatus;
      readonly after: string;
    }
  >();
  private refusedCodes = 0;
  private refusedLoggedAt: number | undefined;

  constructor(private readonly options: BotOptions) {
    this.api = options.api;
    this.notifier = options.notifier;
    this.state = options.state;
    this.pipeline = options.pipeline;
    this.logger = options.logger;
    this.sleep = options.sleep ?? realSleep;
  }

  private get signal(): AbortSignal | undefined {
    return this.controller?.signal;
  }

  /** Whether a stop or a halt came: work is left in hand, unacknowledged. */
  private get standingDown(): boolean {
    return this.signal?.aborted === true || this.notifier.halted !== undefined;
  }

  private mask(text: string): string {
    return this.logger.secrets.mask(this.api.mask(text));
  }

  // --- The loop.

  /** Starts polling in the background; `stop` ends it. */
  start(signal?: AbortSignal): void {
    if (this.running !== undefined) return;
    const controller = new AbortController();
    this.controller = controller;
    if (signal?.aborted) controller.abort();
    else
      signal?.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
    this.running = this.run(controller.signal).catch((error: unknown) => {
      this.logger.error('telegram loop ended', { error });
    });
  }

  /**
   * Stops polling and waits for the work under way; what the stop cuts
   * short, or had not started, is left unacknowledged for the next start.
   */
  async stop(): Promise<void> {
    this.controller?.abort();
    await this.running;
    await this.idle();
  }

  /** Settles once every update taken so far is handled and acknowledged as far as it can be. */
  async idle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.all([...this.tasks]);
    await this.acknowledged();
  }

  /** Settles once every acknowledgement asked for so far is written. */
  async acknowledged(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.acking;
      await current;
    } while (current !== this.acking);
  }

  private async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    let webhookChecked = false;
    while (!signal.aborted && this.notifier.halted === undefined) {
      try {
        if (!webhookChecked) {
          const hook = await this.api.getWebhookInfo({ signal });
          if (hook.url !== '') {
            await this.halt('webhook');
            return;
          }
          webhookChecked = true;
        }
        const polled = await this.pollOnce(signal);
        failures = 0;
        if (polled.received > 0 && polled.started === 0)
          await this.sleep(this.options.busyPollMs ?? BUSY_POLL_MS, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof TelegramError && error.kind === 'conflict') {
          await this.halt('conflict');
          return;
        }
        failures++;
        const text = this.mask(errorText(error));
        this.options.health?.failed('telegram', text);
        this.logger.warn('telegram poll failed', { error, failures });
        await this.reportConnection(false, text);
        let wait = Math.min(MAX_POLL_BACKOFF_MS, 1000 * 2 ** (failures - 1));
        if (error instanceof TelegramError) {
          if (error.kind === 'rate_limited' && error.retryAfter !== undefined)
            wait = Math.max(wait, error.retryAfter * 1000);
          if (error.kind === 'unauthorised') wait = UNAUTHORISED_BACKOFF_MS;
        }
        await this.sleep(wait, signal);
      }
    }
  }

  private async reportConnection(up: boolean, detail?: string): Promise<void> {
    try {
      await this.options.health?.connection('telegram', up, detail);
    } catch (error) {
      this.logger.warn('telegram health not recorded', { error });
    }
  }

  private async halt(why: 'conflict' | 'webhook'): Promise<void> {
    const text = why === 'conflict' ? HALT_CONFLICT_TEXT : HALT_WEBHOOK_TEXT;
    this.logger.error('telegram halted: revoke the bot token', { why });
    this.options.health?.failed('telegram', text);
    await this.notifier.halt(text);
  }

  /** One getUpdates, and each update it brings taken in hand. */
  async pollOnce(
    signal?: AbortSignal
  ): Promise<{ received: number; started: number }> {
    if (this.notifier.halted !== undefined)
      throw new TelegramError(
        'halted',
        'getUpdates',
        'the bot stopped using Telegram; revoke its token'
      );
    // An acknowledgement a failed write left behind is written first, so the
    // offset this poll sends is past every update already handled.
    const head = this.order[0];
    if (head !== undefined && this.finished.has(head)) {
      this.drain();
      await this.acknowledged();
    }
    const updates = await this.api.getUpdates(
      this.state.value.telegram.offset,
      {
        signal,
      }
    );
    this.options.health?.succeeded('telegram');
    await this.reportConnection(true);
    let started = 0;
    for (const update of updates) {
      if (signal?.aborted === true) break;
      if (await this.take(update)) started++;
    }
    return { received: updates.length, started };
  }

  // --- Taking updates in hand, and acknowledging them in order.

  private track(id: number): void {
    this.inHand.add(id);
    if (!this.order.includes(id)) {
      this.order.push(id);
      this.order.sort((a, b) => a - b);
    }
  }

  private done(id: number, quiet = false): void {
    if (quiet) this.quiet.add(id);
    this.finished.add(id);
    this.drain();
  }

  /**
   * Writes the acknowledgements due, in id order. A write that fails leaves
   * its update at the head, finished; the next poll writes it again.
   */
  private drain(): void {
    this.acking = this.acking
      .then(async () => {
        while (this.order.length > 0) {
          const head = this.order[0] as number;
          if (!this.finished.has(head)) break;
          const next = this.order[1];
          const lastOfRun = next === undefined || !this.finished.has(next);
          if (!this.quiet.has(head) || lastOfRun)
            await this.state.markUpdateProcessed(head);
          this.order.shift();
          this.finished.delete(head);
          this.quiet.delete(head);
          this.inHand.delete(head);
          this.attempts.delete(head);
          this.retryAt.delete(head);
        }
      })
      .catch((error: unknown) => {
        this.logger.warn('telegram update not acknowledged', { error });
      });
  }

  /** Takes an update in hand; true when it was new work. */
  private async take(update: IncomingUpdate): Promise<boolean> {
    const id = update.id;
    if (this.inHand.has(id)) return false;
    const due = this.retryAt.get(id);
    if (due !== undefined && due > this.options.clock().getTime()) return false;
    this.track(id);
    try {
      return await this.takeTracked(update);
    } catch (error) {
      // Nothing was done with it: acknowledged unread, so it holds back no
      // later acknowledgement and does not come back with every poll.
      this.logger.warn('telegram update could not be read; left unread', {
        updateId: id,
        error,
      });
      this.done(id, true);
      return true;
    }
  }

  /** Takes an update `take` is tracking (see the header). */
  private async takeTracked(update: IncomingUpdate): Promise<boolean> {
    const id = update.id;
    if (this.state.isUpdateProcessed(id)) {
      this.done(id, true);
      return true;
    }
    const owner = this.notifier.owner;
    if (update.kind === 'other') {
      this.done(id, true);
      return true;
    }
    if (update.kind === 'callback') {
      const q = update.query;
      if (!isOwnerPress(q, owner) || q.message === undefined) {
        this.done(id, true);
        return true;
      }
      try {
        await this.api.answerCallbackQuery(q.id);
      } catch (error) {
        this.logger.warn('telegram press not answered', { error });
      }
      const callback = readCallback(q.data);
      if (callback === undefined) {
        this.logger.warn('telegram press with unknown data');
        this.done(id);
        return true;
      }
      const at = { chat: q.message.chat.id, messageId: q.message.message_id };
      this.queue('work', update, () => this.onPress(callback, at));
      return true;
    }
    const route = routeMessage(update.message, owner, this.options.timeZone());
    if (route.kind === 'drop' || route.kind === 'ignore') {
      this.done(id, route.kind === 'drop');
      return true;
    }
    if (route.kind === 'link') {
      // Handled before the next update is read, so the owner's next message
      // counts; a refused code is acknowledged without a record of its own.
      try {
        const linked = await this.link(route.code, route.userId);
        this.done(id, !linked);
      } catch (error) {
        await this.failed(update, error);
      }
      return true;
    }
    this.queue(WORK_ROUTES.has(route.kind) ? 'work' : 'talk', update, () =>
      this.onMessage(update.message, route, id)
    );
    return true;
  }

  private queue(
    chain: Chain,
    update: IncomingUpdate,
    task: () => Promise<void>
  ): void {
    const run = this.chains[chain].then(() => this.handle(update, task));
    this.chains[chain] = run;
    this.tasks.add(run);
    void run.finally(() => this.tasks.delete(run));
  }

  /** Runs one update's work; never throws. */
  private async handle(
    update: IncomingUpdate,
    task: () => Promise<void>
  ): Promise<void> {
    // Not started after a stop or a halt: left in hand for the next start.
    if (this.standingDown) return;
    try {
      await task();
      this.done(update.id);
    } catch (error) {
      await this.failed(update, error);
    }
  }

  private async failed(update: IncomingUpdate, error: unknown): Promise<void> {
    const id = update.id;
    if (this.standingDown) {
      // Cut short by a stop or a halt, which is not a handling: it stays in
      // hand, unacknowledged, and the next start takes it again.
      this.logger.info('telegram update left for the next start', {
        updateId: id,
        error,
      });
      return;
    }
    const count = (this.attempts.get(id) ?? 0) + 1;
    const canPass =
      isRetryable(error) ||
      (error instanceof TelegramError &&
        (error.kind === 'network' ||
          error.kind === 'timeout' ||
          error.kind === 'server' ||
          error.kind === 'rate_limited'));
    this.logger.warn('telegram update not handled', {
      updateId: id,
      attempt: count,
      error,
    });
    if (canPass && count < MAX_UPDATE_ATTEMPTS) {
      this.attempts.set(id, count);
      this.retryAt.set(
        id,
        this.options.clock().getTime() +
          (UPDATE_BACKOFF_MS[count - 1] ?? 900_000)
      );
      // Taken again from a later poll; it holds back every later acknowledgement.
      this.inHand.delete(id);
      return;
    }
    await this.reply(
      plainMessage(
        `Something you sent could not be taken: ${this.mask(errorText(error))}. Send it again.`
      )
    );
    this.done(id);
  }

  // --- Messages.

  private async reply(message: OutMessage): Promise<void> {
    if (message.parts.length === 0) return;
    try {
      await this.notifier.send(message);
    } catch (error) {
      this.logger.warn('telegram reply not delivered', { error });
    }
  }

  /** Spends the link code; true when this account is now the owner. */
  private async link(code: string, userId: number): Promise<boolean> {
    // A code that is not the one held is refused before the state is
    // touched, so a stranger's guesses cost no write.
    const linked =
      this.codeMatches(code) && (await this.state.spendLinkCode(code, userId));
    if (!linked) {
      this.refusedCode();
      return false;
    }
    this.logger.info('telegram owner linked');
    await this.reply(plainMessage(`${LINKED_TEXT}\n\n${HELP_TEXT}`));
    return true;
  }

  /** Whether `code` is the state's unspent link code, compared in constant time. */
  private codeMatches(code: string): boolean {
    const t = this.state.value.telegram;
    const held = t.linkCode?.code;
    if (t.ownerId !== undefined || t.linkSpent || held === undefined)
      return false;
    const digest = (text: string): Buffer =>
      createHash('sha256').update(text).digest();
    return timingSafeEqual(digest(held), digest(code.trim().toUpperCase()));
  }

  /** Logs refused link codes, without the codes, at most once a minute. */
  private refusedCode(): void {
    this.refusedCodes++;
    const now = this.options.clock().getTime();
    if (
      this.refusedLoggedAt !== undefined &&
      now - this.refusedLoggedAt < REFUSED_CODE_LOG_MS
    )
      return;
    this.logger.warn('telegram link code refused', {
      refused: this.refusedCodes,
    });
    this.refusedCodes = 0;
    this.refusedLoggedAt = now;
  }

  private async onMessage(
    m: Message,
    route: Route,
    updateId: number
  ): Promise<void> {
    const off = this.options.off;
    const takesWork =
      route.kind === 'file' ||
      route.kind === 'forward' ||
      route.kind === 'note' ||
      route.kind === 'question';
    if (off !== undefined && takesWork) {
      await this.reply(plainMessage(offText(off)));
      return;
    }
    switch (route.kind) {
      case 'help':
        await this.reply(plainMessage(HELP_TEXT));
        return;
      case 'jobs':
        await this.listJobs();
        return;
      case 'tz':
        await this.setTimeZone(route.zone);
        return;
      case 'note':
        if (route.text === '') {
          await this.reply(
            plainMessage(
              'Write the note after /add, for example: /add Parking is behind the stage door.'
            )
          );
          return;
        }
        await this.takeSource({
          via: 'Note',
          name: `Your note ${stamp(m.date, this.options.timeZone())}`,
          bytes: new TextEncoder().encode(`${route.text}\n`),
          contentType: 'text/plain',
          from: accountName(m),
          received: iso(m.date),
        });
        return;
      case 'forward':
        await this.takeSource({
          via: 'Telegram',
          name: `Forwarded message ${stamp(m.forward_origin?.date ?? m.forward_date ?? m.date, this.options.timeZone())}`,
          bytes: new TextEncoder().encode(`${route.text}\n`),
          contentType: 'text/plain',
          from: originName(m) ?? accountName(m),
          received: iso(m.date),
          ...(m.forward_origin !== undefined
            ? { sent: iso(m.forward_origin.date) }
            : {}),
        });
        return;
      case 'file':
        await this.takeFile(m, route.file);
        return;
      case 'question':
        await this.answer(route.text, updateId);
        return;
      case 'unknown_command':
        await this.reply(
          plainMessage(
            `/${route.command} is not a command here. /help lists what I take.`
          )
        );
        return;
      case 'unread':
        await this.reply(plainMessage(UNREAD_TEXT));
        return;
      case 'drop':
      case 'ignore':
      case 'link':
        return;
    }
  }

  private async takeFile(m: Message, file: FileRef): Promise<void> {
    if (file.size !== undefined && file.size > MAX_DOWNLOAD_BYTES) {
      await this.reply(plainMessage(TOO_BIG_TEXT));
      return;
    }
    let bytes: Uint8Array;
    try {
      // Nothing is fetched with the token once the bot halted.
      this.notifier.ownerChat();
      const info = await this.api.getFile(file.fileId, { signal: this.signal });
      this.notifier.ownerChat();
      bytes = await this.api.download(info, MAX_DOWNLOAD_BYTES, {
        signal: this.signal,
      });
    } catch (error) {
      if (error instanceof TelegramError && error.kind === 'too_big') {
        await this.reply(plainMessage(TOO_BIG_TEXT));
        return;
      }
      throw error;
    }
    const forwarded = m.forward_origin?.date;
    await this.takeSource({
      via: 'Telegram',
      name: file.name,
      bytes,
      contentType: file.contentType,
      from:
        (forwarded !== undefined ? originName(m) : undefined) ?? accountName(m),
      received: iso(m.date),
      ...(forwarded !== undefined ? { sent: iso(forwarded) } : {}),
    });
    if (file.hasCaption) await this.reply(plainMessage(CAPTION_TEXT));
  }

  /** Hands a source to the pipeline; the pipeline's summary is the owner's message, else a receipt. */
  private async takeSource(input: SourceInput): Promise<void> {
    const result = await this.pipeline.processSource(input);
    const name = nameText(input.name);
    if (result.kind === 'duplicate') {
      await this.reply(
        plainMessage(
          `${name} was recorded before${result.status !== undefined ? ` (${result.status})` : ''}, so it is not read again.`
        )
      );
    } else if (result.kind === 'waiting') {
      await this.reply(
        plainMessage(
          result.paused
            ? `${name} is recorded and waits: ${this.mask(result.reason)}.`
            : `${name} is recorded; reading it did not finish (${this.mask(result.reason)}). The service tries again.`
        )
      );
    } else if (result.status === 'Skipped') {
      const why =
        this.state.value.sources[result.sourceId]?.outcome?.note ?? '';
      await this.reply(
        plainMessage(`${name} was not read${why ? `: ${why}` : '.'}`)
      );
    }
  }

  private async answer(question: string, updateId: number): Promise<void> {
    let outcome: AskOutcome;
    try {
      outcome = await this.pipeline.ask(question, {
        key: `telegram:${updateId}`,
        signal: this.signal,
      });
    } catch (error) {
      // A question is not asked twice: the model may already have been paid.
      this.logger.warn('telegram question failed', { error });
      await this.reply(
        plainMessage(
          `The question was not answered: ${this.mask(errorText(error))}.`
        )
      );
      return;
    }
    if (outcome.kind === 'answered') {
      await this.reply(answerMessage(outcome.rendered));
      return;
    }
    const text =
      outcome.kind === 'ai_off'
        ? `Questions need the model, which is off: ${this.mask(outcome.reason)}.`
        : `The question was not answered: ${this.mask(outcome.reason)}.`;
    await this.reply(plainMessage(text));
  }

  private async listJobs(): Promise<void> {
    const today = dayContext(
      this.options.clock(),
      this.options.timeZone()
    ).today;
    const result = await this.pipeline.answerTools().jobs({ from: today });
    await this.reply(jobsListMessage(result.jobs, today, result.partial));
  }

  private async setTimeZone(zone: string | undefined): Promise<void> {
    if (zone === undefined) {
      await this.reply(
        plainMessage(
          `Your time zone is ${this.options.timeZone()}. Change it with /tz <zone>, for example /tz Europe/London.`
        )
      );
      return;
    }
    const ok =
      ZONE_RE.test(zone) &&
      isTimeZone(zone) &&
      (await this.pipeline.setTimeZone(zone));
    await this.reply(
      plainMessage(
        ok
          ? `Your time zone is now ${zone}: days are worked out there from now on. Times stay as each source writes them.`
          : 'That is not a time zone I know. Use a name such as Europe/London or America/New_York.'
      )
    );
  }

  // --- Button presses.

  private async edit(
    at: { chat: number; messageId: number },
    html: string,
    keyboard: Keyboard
  ): Promise<void> {
    this.notifier.ownerChat();
    try {
      await this.api.editMessageText(at.chat, at.messageId, html, keyboard);
    } catch (error) {
      if (
        error instanceof TelegramError &&
        (error.kind === 'bad_request' || error.kind === 'invalid_response')
      ) {
        // The message cannot be edited (too old, or gone): say it anew.
        this.logger.warn('telegram message not edited; sent anew', { error });
        await this.api.sendMessage(at.chat, html, keyboard);
        return;
      }
      throw error;
    }
  }

  private async onPress(
    callback: Callback,
    at: { chat: number; messageId: number }
  ): Promise<void> {
    switch (callback.kind) {
      case 'review': {
        const cards = await this.pipeline.reviewCards({
          sourceId: callback.sourceId,
        });
        const first = cards[0];
        if (first === undefined) {
          await this.reply(
            plainMessage('Nothing from this source needs a look now.')
          );
          return;
        }
        const m = reviewCardMessage(first, { remaining: cards.length - 1 });
        this.notifier.ownerChat();
        await this.api.sendMessage(at.chat, m.html, m.keyboard);
        return;
      }
      case 'continue': {
        const cards = await this.pipeline.reviewCards({
          sourceId: callback.sourceId,
        });
        const first = cards[0];
        if (first === undefined) {
          const name = this.state.value.sources[callback.sourceId]?.name;
          const end = walkEndMessage(name, callback.sourceId, undefined, 0);
          await this.edit(at, end.html, end.keyboard);
          return;
        }
        const m = reviewCardMessage(first, { remaining: cards.length - 1 });
        await this.edit(at, m.html, m.keyboard);
        return;
      }
      case 'decide':
        await this.decide(callback, at);
        return;
      case 'original':
        await this.original(callback);
        return;
      case 'file':
        await this.file(callback, at);
        return;
      case 'retry':
        await this.retry(callback, at);
        return;
    }
  }

  private async decide(
    callback: Extract<Callback, { kind: 'decide' }>,
    at: { chat: number; messageId: number }
  ): Promise<void> {
    const before = await this.pipeline.reviewCards();
    const result = await this.pipeline.applyReview({
      detailId: callback.detailId,
      action: callback.action,
      fingerprint: callback.fingerprint,
    });
    if (result.kind === 'missing') {
      await this.edit(at, escapeHtml(MISSING_TEXT), []);
      return;
    }
    if (result.kind === 'changed') {
      await this.changed(callback, at, before, result.card);
      return;
    }
    if (result.kind === 'applied')
      this.remember(callback, result.status, result.card.fingerprint);
    const lead = decisionLead(
      result.card,
      result.kind === 'skipped' ? 'skipped' : result.status
    );
    await this.walkOn(callback.detailId, at, before, result.card, lead);
  }

  /** A press whose card no longer matches its detail (see the header). */
  private async changed(
    callback: Extract<Callback, { kind: 'decide' }>,
    at: { chat: number; messageId: number },
    before: readonly ReviewCard[],
    card: ReviewCard
  ): Promise<void> {
    const pressed: DetailStatus | undefined =
      callback.action === 'confirm'
        ? 'Confirmed'
        : callback.action === 'reject'
          ? 'Rejected'
          : undefined;
    const ownDecision =
      pressed !== undefined &&
      card.status === pressed &&
      this.state.value.details[callback.detailId]?.decidedVia === 'telegram';
    if (ownDecision) {
      const own = this.decisions.get(callback.detailId);
      if (
        own !== undefined &&
        own.pressed === callback.fingerprint &&
        own.status === pressed &&
        own.after === card.fingerprint
      ) {
        // The same press again, and nothing changed since it was recorded.
        await this.walkOn(
          callback.detailId,
          at,
          before,
          card,
          decisionLead(card, pressed)
        );
        return;
      }
      const m = reviewCardMessage(card, {
        lead: escapeHtml(
          `You already ${pressed === 'Confirmed' ? 'confirmed' : 'rejected'} this detail on Telegram, so nothing more was recorded. This is how it reads now:`
        ),
      });
      await this.edit(at, m.html, m.keyboard);
      return;
    }
    const m = reviewCardMessage(card, { lead: escapeHtml(CHANGED_LEAD) });
    await this.edit(at, m.html, m.keyboard);
  }

  /** Records a decision this bot made, so the same press again is known. */
  private remember(
    callback: Extract<Callback, { kind: 'decide' }>,
    status: DetailStatus,
    after: string
  ): void {
    this.decisions.delete(callback.detailId);
    this.decisions.set(callback.detailId, {
      pressed: callback.fingerprint,
      status,
      after,
    });
    while (this.decisions.size > REMEMBERED_DECISIONS) {
      const oldest = this.decisions.keys().next().value;
      if (oldest === undefined) break;
      this.decisions.delete(oldest);
    }
  }

  /** After a press: the next card of the source, or the end of the walk, under `lead`. */
  private async walkOn(
    detailId: string,
    at: { chat: number; messageId: number },
    before: readonly ReviewCard[],
    card: ReviewCard,
    lead: string
  ): Promise<void> {
    const sourceId = card.sourceId;
    if (sourceId === undefined) {
      await this.edit(at, lead, []);
      return;
    }
    // The next card is the next one of this source in the order shown, so a
    // skipped card comes back only when the owner starts again.
    const order = before
      .filter((c) => c.sourceId === sourceId)
      .map((c) => c.detailId);
    const after = await this.pipeline.reviewCards({ sourceId });
    const byId = new Map(after.map((c) => [c.detailId, c]));
    const position = order.indexOf(detailId);
    const nextId =
      order.slice(position + 1).find((d) => d !== detailId && byId.has(d)) ??
      after.find((c) => c.detailId !== detailId && !order.includes(c.detailId))
        ?.detailId;
    const next = nextId === undefined ? undefined : byId.get(nextId);
    if (next === undefined) {
      const end = walkEndMessage(card.sourceName, sourceId, lead, after.length);
      await this.edit(at, end.html, end.keyboard);
      return;
    }
    const m = reviewCardMessage(next, { lead, remaining: after.length - 1 });
    await this.edit(at, m.html, m.keyboard);
  }

  private async original(
    callback: Extract<Callback, { kind: 'original' }>
  ): Promise<void> {
    // A Skip records nothing: it returns the card as it reads now.
    const result = await this.pipeline.applyReview({
      detailId: callback.detailId,
      action: 'skip',
      fingerprint: callback.fingerprint,
    });
    const card = result.kind === 'missing' ? undefined : result.card;
    if (card?.documentId === undefined) {
      await this.reply(plainMessage('The original is not held in SupaMac.'));
      return;
    }
    const chat = this.notifier.ownerChat();
    const bytes = await this.options.downloadDocument(card.documentId);
    if (bytes.length > MAX_UPLOAD_BYTES) {
      await this.reply(
        plainMessage(
          `The original of ${nameText(card.sourceName ?? 'this source')} is over 50 MB, more than Telegram takes from a bot; open it in SupaMac.`
        )
      );
      return;
    }
    await this.api.sendDocument(
      chat,
      sourceName(card.sourceName, 'original'),
      bytes,
      originalCaption(card)
    );
  }

  private async file(
    callback: Extract<Callback, { kind: 'file' }>,
    at: { chat: number; messageId: number }
  ): Promise<void> {
    const pending = this.state.value.filing[callback.sourceId];
    const meta = this.state.value.sources[callback.sourceId];
    const name = nameText(meta?.name ?? 'the source');
    const part = pending?.parts.find((p) => p.part === callback.part);
    let choice: FilingChoice | undefined;
    let jobName: string | undefined;
    if (callback.job === 'new') choice = { kind: 'new_job' };
    else {
      const matches = (part?.candidates ?? []).filter(
        (c) => jobKey(c.jobId) === callback.job
      );
      const only = matches.length === 1 ? matches[0] : undefined;
      if (only !== undefined) {
        choice = { kind: 'job', jobId: only.jobId };
        jobName = only.name;
      }
    }
    if (pending === undefined) {
      await this.edit(
        at,
        escapeHtml(`${name}: this question was already answered.`),
        []
      );
      return;
    }
    if (choice === undefined || part === undefined) {
      if (part === undefined || part.answer !== undefined) {
        await this.edit(
          at,
          escapeHtml(`${name}: this part was already answered.`),
          []
        );
        return;
      }
      const current = filingMessages({
        sourceId: callback.sourceId,
        sourceName: name,
        parts: [
          {
            part: part.part,
            names: part.names,
            candidates: part.candidates,
            reason: part.reason,
          },
        ],
      })[0];
      const html = `${escapeHtml('That choice is no longer offered; nothing was filed. The question as it stands:')}\n\n${current?.parts.join('\n') ?? ''}`;
      await this.edit(at, html, current?.keyboard ?? []);
      return;
    }
    const result = await this.pipeline.answerFiling({
      sourceId: callback.sourceId,
      part: callback.part,
      choice,
    });
    let text: string;
    switch (result.kind) {
      case 'filed':
        text = `Filed ${nameHtml(name)} under ${jobName !== undefined ? `<b>${nameHtml(jobName)}</b>` : 'a new job'}.${result.remaining > 0 ? ` ${result.remaining} more ${result.remaining === 1 ? 'part waits' : 'parts wait'} for an answer.` : ''}`;
        break;
      case 'answered':
        text = `${nameHtml(name)} was already filed; nothing changed.`;
        break;
      case 'no_question':
        text = `${nameHtml(name)}: this question was already answered.`;
        break;
      case 'refused':
        text = `${nameHtml(name)} was not filed: ${safe(result.reason)}.`;
        break;
    }
    await this.edit(at, text, []);
  }

  private async retry(
    callback: Extract<Callback, { kind: 'retry' }>,
    at: { chat: number; messageId: number }
  ): Promise<void> {
    const name = nameText(
      this.state.value.sources[callback.sourceId]?.name ?? 'The source'
    );
    const outcome = callback.fresh
      ? await this.options.freshRetry(callback.sourceId)
      : await this.pipeline.retry(callback.sourceId);
    let text: string;
    switch (outcome.kind) {
      case 'not_failed':
        text =
          outcome.status === 'Failed'
            ? `${name}: the service no longer holds it, so it cannot be read again. Send it again.`
            : `${name} is no longer failed${outcome.status !== undefined ? ` (${outcome.status})` : ''}.`;
        break;
      case 'finished':
        text = `${name} was tried again: ${outcome.status}.`;
        break;
      case 'waiting':
        text = `${name} was tried again and waits: ${this.mask(outcome.reason)}.`;
        break;
      case 'duplicate':
        text = `${name} was recorded before; it is not read again.`;
        break;
    }
    await this.edit(at, escapeHtml(text), []);
  }
}
