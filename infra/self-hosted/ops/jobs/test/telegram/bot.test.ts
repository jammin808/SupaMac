// The bot against an in-process fake of the Bot API and a fake pipeline:
// who is heard, what counts as a source or a question, how updates are
// acknowledged, and how the loop meets a 409, a webhook and a 429.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnswerTools, JobsQuery } from '../../src/ai/answer';
import { Logger } from '../../src/log';
import type { AskOutcome } from '../../src/pipeline/answers';
import type { FilingAnswer, FilingResult } from '../../src/pipeline/filing';
import type { Connection, ReviewCard } from '../../src/pipeline/notify';
import type { SourceInput, SourceResult } from '../../src/pipeline/process';
import type { ReviewPress, ReviewResult } from '../../src/pipeline/review';
import { StateStore } from '../../src/pipeline/state';
import { SupaMacError } from '../../src/supamac/client';
import {
  BotApi,
  MAX_DOWNLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  TelegramError,
} from '../../src/telegram/api';
import {
  Bot,
  type BotPipeline,
  type RetryOutcome,
  TelegramNotifier,
} from '../../src/telegram/bot';
import {
  CAPTION_TEXT,
  CHANGED_LEAD,
  HALT_CONFLICT_TEXT,
  HALT_WEBHOOK_TEXT,
  TOO_BIG_TEXT,
} from '../../src/telegram/render';
import {
  FakeBotApi,
  OWNER,
  STRANGER,
  TOKEN,
  user,
  wellFormed,
} from './fake-bot-api';

const SOURCE_ID = '0b5b4b8e-55a5-4b8e-9b0e-2b8f0c1a2d3e';
const START = Date.parse('2027-03-05T10:00:00Z');
const SECRET_PART = TOKEN.split(':')[1] as string;

function answered(lines: string[]): AskOutcome {
  return {
    kind: 'answered',
    rendered: {
      text: lines.join('\n'),
      lines,
      cited: [],
      refused: [],
      nothingFound: false,
      partial: false,
    },
    answer: { statements: [] },
    rounds: 1,
    spends: [],
  };
}

class FakePipeline implements BotPipeline {
  readonly sources: SourceInput[] = [];
  readonly questions: { text: string; key?: string | undefined }[] = [];
  readonly zones: string[] = [];
  readonly jobsQueries: JobsQuery[] = [];
  readonly retries: string[] = [];
  result: SourceResult = {
    kind: 'finished',
    sourceId: SOURCE_ID,
    status: 'Processed',
    children: [],
  };
  outcome: AskOutcome = answered(['An answer.']);
  /** Holds processSource until released, when set. */
  gate: Promise<void> | undefined;

  async processSource(input: SourceInput): Promise<SourceResult> {
    await this.gate;
    this.sources.push(input);
    return this.result;
  }
  async ask(
    question: string,
    options?: { readonly key?: string | undefined }
  ): Promise<AskOutcome> {
    this.questions.push({ text: question, key: options?.key });
    return this.outcome;
  }
  answerTools(): AnswerTools {
    return {
      jobs: async (q) => {
        this.jobsQueries.push(q);
        return {
          jobs: [
            {
              id: 'j2',
              name: 'Glasgow Expo',
              days: ['2027-04-02'],
            },
            {
              id: 'j1',
              name: 'Leeds Lights Gala',
              client: 'Example Arts Trust',
              dates: { start: '2027-03-12', end: '2027-03-13' },
            },
          ],
          partial: false,
        };
      },
      details: async () => undefined,
      sourceText: async () => undefined,
      jobStatus: async () => undefined,
    };
  }
  async retry(sourceId: string): Promise<RetryOutcome> {
    this.retries.push(sourceId);
    return { kind: 'finished', sourceId, status: 'Processed', children: [] };
  }
  async answerFiling(_answer: FilingAnswer): Promise<FilingResult> {
    return { kind: 'no_question' };
  }
  async reviewCards(): Promise<ReviewCard[]> {
    return [];
  }
  async applyReview(_press: ReviewPress): Promise<ReviewResult> {
    return { kind: 'missing' };
  }
  async setTimeZone(zone: string): Promise<boolean> {
    this.zones.push(zone);
    return true;
  }
}

class FakeHealth {
  readonly succeeded: string[] = [];
  readonly failures: string[] = [];
  readonly connections: { name: Connection; up: boolean; detail?: string }[] =
    [];
  readonly health = {
    succeeded: (name: string) => {
      this.succeeded.push(name);
    },
    failed: (name: string, error: string) => {
      this.failures.push(`${name}: ${error}`);
    },
    connection: async (name: Connection, up: boolean, detail?: string) => {
      this.connections.push({ name, up, ...(detail ? { detail } : {}) });
    },
  };
}

const dirs: string[] = [];
const bots: Bot[] = [];
afterEach(async () => {
  for (const b of bots.splice(0)) await b.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup(
  options: {
    linked?: boolean;
    off?: string;
    fetch?: FakeBotApi['fetch'];
    downloadDocument?: (documentId: string) => Promise<Uint8Array>;
  } = {}
) {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-telegram-'));
  dirs.push(dir);
  const world = { now: START };
  const clock = (): Date => new Date(world.now);
  const lines: string[] = [];
  const logger = new Logger({
    sink: (line) => lines.push(line),
    clock,
    level: 'debug',
  });
  const state = await StateStore.open(dir, { clock, logger });
  if (options.linked !== false) await state.setOwnerId(OWNER);
  const fake = new FakeBotApi();
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    waits.push(ms);
    await new Promise((resolve) => setTimeout(resolve, 1));
  };
  const api = new BotApi({
    token: TOKEN,
    fetch: options.fetch ?? fake.fetch,
    logger,
    sleep,
  });
  const notifier = new TelegramNotifier({
    api,
    state,
    logger,
    timeZone: () => 'Europe/London',
  });
  const pipeline = new FakePipeline();
  const health = new FakeHealth();
  const fresh: string[] = [];
  const bot = new Bot({
    api,
    notifier,
    state,
    pipeline,
    logger,
    clock,
    timeZone: () => 'Europe/London',
    health: health.health,
    off: options.off,
    freshRetry: async (sourceId) => {
      fresh.push(sourceId);
      return { kind: 'finished', sourceId, status: 'Failed', children: [] };
    },
    downloadDocument:
      options.downloadDocument ?? (async () => new Uint8Array([1, 2, 3])),
    sleep,
    busyPollMs: 1,
  });
  bots.push(bot);
  const poll = async (): Promise<void> => {
    await bot.pollOnce();
    await bot.idle();
  };
  return {
    world,
    fake,
    api,
    notifier,
    bot,
    pipeline,
    state,
    lines,
    health,
    waits,
    fresh,
    poll,
  };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const PDF = new TextEncoder().encode('%PDF-1.7 placeholder');

describe('linking', () => {
  test('the right code links its sender, and the code is spent', async () => {
    const s = await setup({ linked: false });
    const code = (await s.state.linkCode()) as string;
    s.fake.text(OWNER, `/start ${code}`);
    await s.poll();
    expect(s.state.ownerId).toBe(OWNER);
    expect(s.state.value.telegram.linkSpent).toBe(true);
    expect(await s.state.linkCode()).toBeUndefined();
    expect(s.fake.last(OWNER).text).toContain('Linked: this chat now receives');
  });

  test('a wrong code links no one and gets no answer; the right one still works', async () => {
    const s = await setup({ linked: false });
    const code = (await s.state.linkCode()) as string;
    s.fake.text(STRANGER, '/start WRONGCODE2');
    await s.poll();
    expect(s.state.ownerId).toBeUndefined();
    expect(s.fake.sent).toEqual([]);
    expect(s.lines.some((l) => l.includes('WRONGCODE2'))).toBe(false);
    s.fake.text(OWNER, `/start ${code.toLowerCase()}`);
    await s.poll();
    expect(s.state.ownerId).toBe(OWNER);
  });

  test('a second /start is ignored, with the spent code or any other', async () => {
    const s = await setup({ linked: false });
    const code = (await s.state.linkCode()) as string;
    s.fake.text(OWNER, `/start ${code}`);
    await s.poll();
    const sent = s.fake.sent.length;
    s.fake.text(STRANGER, `/start ${code}`);
    s.fake.text(OWNER, `/start ${code}`);
    s.fake.text(OWNER, '/start');
    await s.poll();
    expect(s.state.ownerId).toBe(OWNER);
    expect(s.fake.sent.length).toBe(sent);
    expect(s.fake.to(STRANGER)).toEqual([]);
  });

  test('before linking, nothing but a /start code is read', async () => {
    const s = await setup({ linked: false });
    s.fake.files.set('f1', { path: 'documents/file_1.pdf', bytes: PDF });
    s.fake.message(OWNER, {
      document: { file_id: 'f1', file_unique_id: 'u1', file_name: 'a.pdf' },
    });
    s.fake.text(OWNER, 'where am I staying?');
    await s.poll();
    expect(s.pipeline.sources).toEqual([]);
    expect(s.pipeline.questions).toEqual([]);
    expect(s.fake.count('getFile')).toBe(0);
    expect(s.fake.sent).toEqual([]);
  });
});

describe('who is heard', () => {
  test('an update from another user is dropped unread and unanswered, and acknowledged', async () => {
    const s = await setup();
    s.fake.files.set('f1', { path: 'documents/file_1.pdf', bytes: PDF });
    s.fake.text(STRANGER, 'where am I staying?');
    s.fake.message(STRANGER, {
      document: { file_id: 'f1', file_unique_id: 'u1', file_name: 'a.pdf' },
    });
    const press = s.fake.push({
      callback_query: {
        id: 'q-stranger',
        from: user(STRANGER),
        chat_instance: 'ci',
        message: {
          message_id: 1,
          chat: { id: STRANGER, type: 'private' },
          date: 1,
        },
        data: `t:${SOURCE_ID}`,
      },
    });
    await s.poll();
    expect(s.pipeline.sources).toEqual([]);
    expect(s.pipeline.questions).toEqual([]);
    expect(s.pipeline.retries).toEqual([]);
    expect(s.fake.count('getFile')).toBe(0);
    expect(s.fake.count('sendMessage')).toBe(0);
    expect(s.fake.answered).toEqual([]);
    expect(s.state.value.telegram.offset).toBe(press + 1);
  });

  test('a press by the owner on a message in another chat is dropped', async () => {
    const s = await setup();
    s.fake.push({
      callback_query: {
        id: 'q-elsewhere',
        from: user(OWNER),
        chat_instance: 'ci',
        message: {
          message_id: 1,
          chat: { id: -100_555, type: 'group' },
          date: 1,
        },
        data: `t:${SOURCE_ID}`,
      },
    });
    await s.poll();
    expect(s.fake.answered).toEqual([]);
    expect(s.pipeline.retries).toEqual([]);
  });

  test('a group chat is dropped, even the owner’s message in it', async () => {
    const s = await setup();
    s.fake.push({
      message: {
        message_id: 9,
        from: user(OWNER),
        chat: { id: -100_123, type: 'group', title: 'Crew' },
        date: 1_772_701_200,
        text: 'where am I staying?',
      },
    });
    s.fake.push({
      message: {
        message_id: 10,
        from: user(OWNER),
        chat: { id: -100_124, type: 'supergroup', title: 'Crew' },
        date: 1_772_701_200,
        text: '/add a note',
      },
    });
    // A group chat whose id were the owner's own is still not a private chat.
    s.fake.push({
      message: {
        message_id: 11,
        from: user(OWNER),
        chat: { id: OWNER, type: 'supergroup', title: 'Crew' },
        date: 1_772_701_200,
        text: 'where am I staying?',
      },
    });
    await s.poll();
    expect(s.pipeline.questions).toEqual([]);
    expect(s.pipeline.sources).toEqual([]);
    expect(s.fake.count('sendMessage')).toBe(0);
  });

  test('a channel post is dropped', async () => {
    const s = await setup();
    const id = s.fake.push({
      channel_post: {
        message_id: 3,
        sender_chat: { id: -100_999, type: 'channel', title: 'News' },
        chat: { id: -100_999, type: 'channel', title: 'News' },
        date: 1_772_701_200,
        text: 'Crew call 07:00',
      },
    });
    await s.poll();
    expect(s.pipeline.sources).toEqual([]);
    expect(s.pipeline.questions).toEqual([]);
    expect(s.fake.count('sendMessage')).toBe(0);
    expect(s.state.value.telegram.offset).toBe(id + 1);
  });
});

describe('sources and questions', () => {
  test('a document is a source, downloaded by the service', async () => {
    const s = await setup();
    s.fake.files.set('f1', {
      path: 'documents/file_1.pdf',
      bytes: PDF,
      size: PDF.length,
    });
    s.fake.message(OWNER, {
      document: {
        file_id: 'f1',
        file_unique_id: 'u1',
        file_name: 'call/sheet v2.pdf',
        mime_type: 'application/pdf',
        file_size: PDF.length,
      },
    });
    await s.poll();
    expect(s.pipeline.sources).toHaveLength(1);
    const input = s.pipeline.sources[0] as SourceInput;
    expect(input.via).toBe('Telegram');
    expect(input.name).toBe('call-sheet v2.pdf');
    expect(input.contentType).toBe('application/pdf');
    expect([...input.bytes]).toEqual([...PDF]);
    expect(input.received).toBe('2026-03-05T09:00:00.000Z');
    expect(input.from).toBe('Sam on Telegram');
    expect(s.fake.downloads).toEqual(['documents/file_1.pdf']);
    // The pipeline's summary is the owner's one message about it.
    expect(s.fake.sent).toEqual([]);
  });

  test('a photo is a source: its largest size', async () => {
    const s = await setup();
    s.fake.files.set('big', { path: 'photos/file_9.jpg', bytes: PDF });
    s.fake.message(OWNER, {
      photo: [
        {
          file_id: 'small',
          file_unique_id: 's',
          width: 90,
          height: 60,
          file_size: 900,
        },
        {
          file_id: 'big',
          file_unique_id: 'b',
          width: 1280,
          height: 960,
          file_size: 90_000,
        },
        {
          file_id: 'mid',
          file_unique_id: 'm',
          width: 320,
          height: 240,
          file_size: 9_000,
        },
      ],
    });
    await s.poll();
    expect(s.fake.calls.find((c) => c.method === 'getFile')?.body.file_id).toBe(
      'big'
    );
    expect(s.pipeline.sources[0]?.contentType).toBe('image/jpeg');
    expect(s.pipeline.sources[0]?.name).toBe('photo-2026-03-05-090000.jpg');
  });

  test('a forwarded message is a source, dated by its own date', async () => {
    const s = await setup();
    s.fake.message(OWNER, {
      text: 'Crew call moved to 08:00 on Sat 13 March 2027',
      forward_origin: {
        type: 'user',
        date: 1_772_614_800,
        sender_user: {
          id: 55,
          is_bot: false,
          first_name: 'Jo',
          last_name: 'Bloggs',
        },
      },
    });
    await s.poll();
    const input = s.pipeline.sources[0] as SourceInput;
    expect(input.via).toBe('Telegram');
    expect(new TextDecoder().decode(input.bytes)).toBe(
      'Crew call moved to 08:00 on Sat 13 March 2027\n'
    );
    expect(input.sent).toBe('2026-03-04T09:00:00.000Z');
    expect(input.from).toBe('Jo Bloggs');
    expect(input.name).toStartWith('Forwarded message 2026-03-04');
    expect(s.pipeline.questions).toEqual([]);
  });

  test('/add is your note, never a document', async () => {
    const s = await setup();
    s.fake.text(
      OWNER,
      '/add Parking is behind the stage door\nGate code on arrival'
    );
    s.fake.text(OWNER, '/add');
    await s.poll();
    expect(s.pipeline.sources).toHaveLength(1);
    const input = s.pipeline.sources[0] as SourceInput;
    expect(input.via).toBe('Note');
    expect(new TextDecoder().decode(input.bytes)).toBe(
      'Parking is behind the stage door\nGate code on arrival\n'
    );
    expect(s.fake.last().text).toContain('Write the note after /add');
  });

  test('typed text is a question, never a source; the answer is escaped', async () => {
    const s = await setup();
    s.pipeline.outcome = answered([
      '• Hotel: Example Hotel <Leeds> & Spa (the call sheet "x.pdf", p1, says \'Hotel: Example Hotel <Leeds> & Spa\'; not confirmed by you)',
    ]);
    const id = s.fake.text(OWNER, 'where am I staying in Leeds?');
    await s.poll();
    expect(s.pipeline.sources).toEqual([]);
    expect(s.pipeline.questions).toEqual([
      { text: 'where am I staying in Leeds?', key: `telegram:${id}` },
    ]);
    const reply = s.fake.last();
    expect(reply.text).toContain('Example Hotel &lt;Leeds&gt; &amp; Spa');
    expect(wellFormed(reply.text)).toBe(true);
  });

  test('a question while the AI is off is answered with why', async () => {
    const s = await setup();
    s.pipeline.outcome = {
      kind: 'ai_off',
      reason: 'ANTHROPIC_API_KEY is not set',
    };
    s.fake.text(OWNER, 'where am I staying?');
    await s.poll();
    expect(s.fake.last().text).toBe(
      'Questions need the model, which is off: ANTHROPIC_API_KEY is not set.'
    );
  });

  test('while the Telegram way in is off, sources and questions are refused with why', async () => {
    const s = await setup({
      off: 'the AI is off: JOBS_MONTHLY_LIMIT_USD is not set',
    });
    s.fake.text(OWNER, 'where am I staying?');
    s.fake.text(OWNER, '/add a note');
    await s.poll();
    expect(s.pipeline.questions).toEqual([]);
    expect(s.pipeline.sources).toEqual([]);
    expect(s.fake.last().text).toContain(
      'Telegram is not taking sources or questions now'
    );
  });

  test('a caption is not read, and the owner is told', async () => {
    const s = await setup();
    s.fake.files.set('f1', { path: 'documents/file_1.pdf', bytes: PDF });
    s.fake.message(OWNER, {
      caption: 'this is for Leeds',
      document: { file_id: 'f1', file_unique_id: 'u1', file_name: 'a.pdf' },
    });
    await s.poll();
    expect(s.pipeline.sources).toHaveLength(1);
    expect(s.fake.last().text).toBe(CAPTION_TEXT);
  });

  test('a source recorded before is not read again, and the owner is told', async () => {
    const s = await setup();
    s.pipeline.result = {
      kind: 'duplicate',
      sourceId: SOURCE_ID,
      status: 'Processed',
      children: [],
    };
    s.fake.text(OWNER, '/add Parking behind the stage door');
    await s.poll();
    expect(s.fake.last().text).toContain(
      'was recorded before (Processed), so it is not read again.'
    );
  });

  test('a file over 20 MB is not fetched; the owner is told to email it', async () => {
    const s = await setup();
    s.fake.message(OWNER, {
      document: {
        file_id: 'huge',
        file_unique_id: 'h',
        file_name: 'pack.pdf',
        file_size: MAX_DOWNLOAD_BYTES + 1,
      },
    });
    await s.poll();
    expect(s.fake.count('getFile')).toBe(0);
    expect(s.pipeline.sources).toEqual([]);
    expect(s.fake.last().text).toBe(TOO_BIG_TEXT);
    // Telegram refusing it as too big is the same answer.
    s.fake.fail('getFile', {
      status: 400,
      body: {
        ok: false,
        error_code: 400,
        description: 'Bad Request: file is too big',
      },
    });
    s.fake.message(OWNER, {
      document: {
        file_id: 'unsized',
        file_unique_id: 'x',
        file_name: 'pack2.pdf',
      },
    });
    await s.poll();
    expect(s.pipeline.sources).toEqual([]);
    expect(s.fake.last().text).toBe(TOO_BIG_TEXT);
  });

  test('/tz takes a zone this runtime knows, and refuses another', async () => {
    const s = await setup();
    s.fake.text(OWNER, '/tz Europe/Paris');
    s.fake.text(OWNER, '/tz Nowhere/Atlantis');
    s.fake.text(OWNER, '/tz');
    await s.poll();
    expect(s.pipeline.zones).toEqual(['Europe/Paris']);
    const texts = s.fake.to(OWNER).map((m) => m.text);
    expect(texts[0]).toContain('Your time zone is now Europe/Paris');
    expect(texts[1]).toContain('That is not a time zone I know');
    expect(texts[2]).toContain('Your time zone is Europe/London');
  });

  test('/jobs lists the jobs from today on, by their first day, from the pipeline’s tools', async () => {
    const s = await setup();
    s.fake.text(OWNER, '/jobs');
    await s.poll();
    expect(s.pipeline.jobsQueries).toEqual([{ from: '2027-03-05' }]);
    const text = s.fake.last().text;
    expect(text).toContain('<b>Jobs from Fri 5 Mar 2027 on</b>');
    expect(text.indexOf('Leeds Lights Gala')).toBeLessThan(
      text.indexOf('Glasgow Expo')
    );
    expect(text).toContain(
      '• <b>Leeds Lights Gala</b> (Example Arts Trust): Fri 12 Mar 2027 to Sat 13 Mar 2027'
    );
    expect(text).toContain('may not be confirmed');
  });

  test('other content and unknown commands are answered, not read', async () => {
    const s = await setup();
    s.fake.message(OWNER, { voice: { file_id: 'v', duration: 3 } });
    s.fake.text(OWNER, '/delete everything');
    await s.poll();
    const texts = s.fake.to(OWNER).map((m) => m.text);
    expect(
      texts.some((t) => t.startsWith('This kind of message is not read'))
    ).toBe(true);
    expect(
      texts.some((t) => t.startsWith('/delete is not a command here'))
    ).toBe(true);
    expect(s.pipeline.questions).toEqual([]);
  });
});

describe('acknowledging updates', () => {
  test('an update is acknowledged only once handled, and never past one still in hand', async () => {
    const s = await setup();
    const gate = deferred();
    s.pipeline.gate = gate.promise;
    const note = s.fake.text(OWNER, '/add Parking behind the stage door');
    const question = s.fake.text(OWNER, 'where am I staying?');
    const second = s.fake.text(OWNER, 'when is the crew call?');
    await s.bot.pollOnce();
    // Questions run one at a time beside the note: once the second is
    // answered, the first has been handled and its acknowledgement asked for.
    await until(() => s.fake.sent.length === 2, 'both answers');
    await s.bot.acknowledged();
    expect(s.pipeline.questions).toHaveLength(2);
    expect(s.state.value.telegram.offset ?? 0).toBeLessThanOrEqual(note);
    expect(s.state.isUpdateProcessed(question)).toBe(false);
    // Telegram sends all three again; none is taken twice.
    await s.bot.pollOnce();
    expect(s.pipeline.questions).toHaveLength(2);
    expect(s.pipeline.sources).toHaveLength(0);
    gate.resolve();
    await s.bot.idle();
    expect(s.pipeline.sources).toHaveLength(1);
    expect(s.state.value.telegram.offset).toBe(second + 1);
    for (const id of [note, question, second])
      expect(s.state.isUpdateProcessed(id)).toBe(true);
  });

  test('an update handled before is ignored when it comes again', async () => {
    const s = await setup();
    const id = s.fake.text(OWNER, '/add Parking behind the stage door');
    const update = s.fake.queued()[0] as Record<string, unknown> & {
      update_id: number;
    };
    await s.poll();
    expect(s.pipeline.sources).toHaveLength(1);
    await s.state.update((st) => {
      st.telegram.offset = id;
    });
    s.fake.pushAgain(update);
    await s.poll();
    expect(s.pipeline.sources).toHaveLength(1);
    expect(s.state.value.telegram.offset).toBe(id + 1);
  });

  test('a failure that can pass is tried again later; after the third the owner is told', async () => {
    const s = await setup();
    s.pipeline.gate = Promise.reject(
      new SupaMacError(
        'unavailable',
        '/databases/query',
        'SupaMac did not answer'
      )
    );
    s.pipeline.gate.catch(() => undefined);
    const id = s.fake.text(OWNER, '/add Parking behind the stage door');
    await s.poll();
    expect(s.state.isUpdateProcessed(id)).toBe(false);
    // Not taken again before its time.
    await s.poll();
    expect(s.fake.sent).toEqual([]);
    s.world.now += 61_000;
    await s.poll();
    expect(s.state.isUpdateProcessed(id)).toBe(false);
    s.world.now += 301_000;
    await s.poll();
    expect(s.state.isUpdateProcessed(id)).toBe(true);
    expect(s.fake.last().text).toContain(
      'Something you sent could not be taken'
    );
    expect(s.fake.last().text).toContain('Send it again.');
  });

  test('a failure that passes is handled on the next try', async () => {
    const s = await setup();
    s.fake.files.set('f1', { path: 'documents/file_1.pdf', bytes: PDF });
    s.fake.fail('getFile', new Error('socket hang up'));
    const id = s.fake.message(OWNER, {
      document: { file_id: 'f1', file_unique_id: 'u1', file_name: 'a.pdf' },
    });
    await s.poll();
    expect(s.pipeline.sources).toEqual([]);
    s.world.now += 61_000;
    await s.poll();
    expect(s.pipeline.sources).toHaveLength(1);
    expect(s.state.isUpdateProcessed(id)).toBe(true);
  });
});

describe('the loop', () => {
  test('a 409 stops polling and tells the owner to revoke the token; nothing else is sent', async () => {
    const s = await setup();
    s.fake.fail('getUpdates', {
      status: 409,
      body: {
        ok: false,
        error_code: 409,
        description: 'Conflict: terminated by other getUpdates request',
      },
    });
    s.bot.start();
    await until(() => s.notifier.halted !== undefined, 'the halt');
    await s.bot.stop();
    expect(s.fake.count('getUpdates')).toBe(1);
    expect(s.fake.last().text).toBe(`<b>${HALT_CONFLICT_TEXT}</b>`);
    expect(s.health.failures.some((f) => f.startsWith('telegram: '))).toBe(
      true
    );
    const error = await s.notifier
      .note({ kind: 'error', text: 'later' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramError);
    expect((error as TelegramError).kind).toBe('halted');
    expect(s.fake.sent).toHaveLength(1);
  });

  test('a webhook set on the bot stops it before it polls', async () => {
    const s = await setup();
    s.fake.webhookUrl = 'https://hooks.example.com/bot';
    s.bot.start();
    await until(() => s.notifier.halted !== undefined, 'the halt');
    await s.bot.stop();
    expect(s.fake.count('getUpdates')).toBe(0);
    expect(s.fake.last().text).toBe(`<b>${HALT_WEBHOOK_TEXT}</b>`);
  });

  test('a 429 on a poll is waited out for its retry_after', async () => {
    const s = await setup();
    s.fake.fail('getUpdates', {
      status: 429,
      body: {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 5',
        parameters: { retry_after: 5 },
      },
    });
    s.fake.text(OWNER, 'where am I staying?');
    s.bot.start();
    await until(() => s.pipeline.questions.length === 1, 'the question');
    await s.bot.stop();
    expect(s.waits).toContain(5_000);
    expect(s.health.succeeded).toContain('telegram');
  });

  test('a poll that fails is retried with backoff, reported as Telegram not answering, and the token is in no line', async () => {
    let calls = 0;
    const fake = new FakeBotApi();
    const fetch: FakeBotApi['fetch'] = async (url, init) => {
      if (url.endsWith('/getUpdates') && calls++ < 2)
        throw new Error(`connect ECONNREFUSED ${url}`);
      return fake.fetch(url, init);
    };
    const s = await setup({ fetch });
    s.bot.start();
    await until(
      () => s.health.connections.some((c) => c.up) && calls > 2,
      'recovery'
    );
    await s.bot.stop();
    const down = s.health.connections.filter((c) => !c.up);
    expect(down.length).toBe(2);
    expect(s.waits.slice(0, 2)).toEqual([1_000, 2_000]);
    for (const c of down) expect(c.detail).not.toContain(SECRET_PART);
    for (const f of s.health.failures) expect(f).not.toContain(SECRET_PART);
    expect(s.lines.some((l) => l.includes('telegram poll failed'))).toBe(true);
    for (const line of s.lines) expect(line).not.toContain(SECRET_PART);
  });
});

describe('the notifier', () => {
  test('with no one linked, it says so rather than send to anyone', async () => {
    const s = await setup({ linked: false });
    const error = await s.notifier
      .note({ kind: 'setup', text: 'hello' })
      .catch((e: unknown) => e);
    expect((error as TelegramError).kind).toBe('not_linked');
    expect(s.fake.sent).toEqual([]);
  });

  test('a failure whose saved reply could not be used offers a fresh reading; the press runs one', async () => {
    const s = await setup();
    const hash = 'a'.repeat(64);
    await s.state.update((st) => {
      st.sources[SOURCE_ID] = {
        hash,
        via: 'Telegram',
        name: 'notes.txt',
        received: '2027-03-05T10:00:00.000Z',
        stage: 'done',
        status: 'Failed',
        uploadNotes: [],
      };
      st.replies[hash] = {
        text: '{}',
        savedAt: '2027-03-05T10:00:00.000Z',
        model: 'claude-opus-5-5',
        inputTokens: 1,
        outputTokens: 1,
        usd: 0.01,
        jobs: [],
        attachmentsLeftOut: [],
        invalid: 'the reply did not match the schema',
      };
    });
    await s.notifier.failure({
      sourceId: SOURCE_ID,
      name: 'notes.txt',
      reason: 'the reply did not match the schema',
      attempts: 1,
      retry: { sourceId: SOURCE_ID },
    });
    const card = s.fake.last();
    expect(card.text).toContain('a fresh reading, at the model’s cost');
    s.fake.press(OWNER, card, s.fake.button(card, 'Read again (new cost)'));
    await s.poll();
    expect(s.fresh).toEqual([SOURCE_ID]);
    expect(s.pipeline.retries).toEqual([]);
    expect(s.fake.answered).toHaveLength(1);
    expect(card.text).toBe('notes.txt was tried again: Failed.');
    expect(card.keyboard).toEqual([]);
  });

  test('another failure’s Retry is the pipeline’s own', async () => {
    const s = await setup();
    await s.notifier.failure({
      sourceId: SOURCE_ID,
      name: 'pack.pdf',
      reason: 'the text reader ran out of time',
      attempts: 3,
      retry: { sourceId: SOURCE_ID },
    });
    const card = s.fake.last();
    s.fake.press(OWNER, card, s.fake.button(card, 'Retry'));
    await s.poll();
    expect(s.pipeline.retries).toEqual([SOURCE_ID]);
    expect(s.fresh).toEqual([]);
  });
});

describe('a stop, a halt and a press repeated', () => {
  const DETAIL = '4f9f8fc2-99e9-4fc2-9f42-6fc24a5e6172';
  const card = (over: Partial<ReviewCard> = {}): ReviewCard => ({
    detailId: DETAIL,
    field: 'Call time',
    label: 'Crew call',
    value: '07:00',
    quote: 'Crew call 07:00 TBC',
    page: 2,
    status: 'Needs review',
    check: 'Needs review: the quote hedges (TBC)',
    sourceId: SOURCE_ID,
    sourceName: 'call-sheet.pdf',
    fingerprint: 'a1b2c3d4e5f6',
    ...over,
  });

  test('work queued behind a halt is not run and not acknowledged, so the next start takes it', async () => {
    const s = await setup();
    const gate = deferred();
    s.pipeline.gate = gate.promise;
    const note = s.fake.text(OWNER, '/add Parking behind the stage door');
    const zone = s.fake.text(OWNER, '/tz Europe/Dublin');
    s.bot.start();
    await until(() => s.fake.count('getUpdates') >= 1, 'the first poll');
    s.fake.fail('getUpdates', {
      status: 409,
      body: {
        ok: false,
        error_code: 409,
        description: 'Conflict: terminated by other getUpdates request',
      },
    });
    await until(() => s.notifier.halted !== undefined, 'the halt');
    gate.resolve();
    await s.bot.stop();
    expect(s.pipeline.sources).toHaveLength(1);
    expect(s.pipeline.zones).toEqual([]);
    expect(s.state.isUpdateProcessed(note)).toBe(true);
    expect(s.state.isUpdateProcessed(zone)).toBe(false);
    expect(s.state.value.telegram.offset).toBe(note + 1);
    await expect(s.bot.pollOnce()).rejects.toThrow(TelegramError);
  });

  test('work not yet started when the service stops is left unacknowledged; work under way finishes', async () => {
    const s = await setup();
    const gate = deferred();
    s.pipeline.gate = gate.promise;
    const note = s.fake.text(OWNER, '/add Parking behind the stage door');
    const zone = s.fake.text(OWNER, '/tz Europe/Dublin');
    s.bot.start();
    await until(() => s.fake.count('getUpdates') >= 1, 'the first poll');
    const stopping = s.bot.stop();
    gate.resolve();
    await stopping;
    expect(s.pipeline.sources).toHaveLength(1);
    expect(s.state.isUpdateProcessed(note)).toBe(true);
    expect(s.pipeline.zones).toEqual([]);
    expect(s.state.isUpdateProcessed(zone)).toBe(false);
    expect(s.state.value.telegram.offset).toBe(note + 1);
    expect(s.fake.sent).toEqual([]);
  });

  test('a press of the owner’s own decision this bot did not see says it was already decided, not that SupaMac changed it', async () => {
    const s = await setup();
    await s.state.update((st) => {
      st.details[DETAIL] = {
        history: false,
        origin: 'document',
        decidedAt: '2027-03-05T09:00:00.000Z',
        decidedVia: 'telegram',
      };
    });
    const now = card({ status: 'Confirmed', fingerprint: 'f0f0f0f0f0f0' });
    s.pipeline.applyReview = async () => ({ kind: 'changed', card: now });
    await s.notifier.reviewCard(card());
    const sent = s.fake.last();
    s.fake.press(OWNER, sent, s.fake.button(sent, 'Confirm'));
    await s.poll();
    expect(sent.text).toStartWith(
      'You already confirmed this detail on Telegram, so nothing more was recorded.'
    );
    expect(sent.text).not.toContain(CHANGED_LEAD);
    expect(sent.text).toContain('confirmed by you');
    expect(sent.keyboard.flat().map((b) => b.text)).toEqual(['Continue']);
  });

  test('a detail decided in SupaMac is reported as changed there', async () => {
    const s = await setup();
    await s.state.update((st) => {
      st.details[DETAIL] = {
        history: false,
        origin: 'document',
        decidedAt: '2027-03-05T09:00:00.000Z',
        decidedVia: 'supamac',
      };
    });
    const now = card({ status: 'Confirmed', fingerprint: 'f0f0f0f0f0f0' });
    s.pipeline.applyReview = async () => ({ kind: 'changed', card: now });
    await s.notifier.reviewCard(card());
    const sent = s.fake.last();
    s.fake.press(OWNER, sent, s.fake.button(sent, 'Confirm'));
    await s.poll();
    expect(sent.text).toStartWith(CHANGED_LEAD);
  });

  test('refused link codes are logged without the codes, once a minute, with their count', async () => {
    const s = await setup({ linked: false });
    const code = (await s.state.linkCode()) as string;
    for (let i = 0; i < 5; i++) s.fake.text(STRANGER, `/start WRONGCODE${i}`);
    await s.poll();
    const refused = (): string[] =>
      s.lines.filter((l) => l.includes('telegram link code refused'));
    expect(refused()).toHaveLength(1);
    s.world.now += 61_000;
    s.fake.text(STRANGER, '/start WRONGCODEX');
    await s.poll();
    expect(refused()).toHaveLength(2);
    expect(JSON.parse(refused()[1] as string).refused).toBe(5);
    for (const line of s.lines) {
      expect(line).not.toContain('WRONGCODE');
      expect(line).not.toContain(code);
    }
    expect(s.fake.sent).toEqual([]);
    s.fake.text(OWNER, `/start ${code}`);
    await s.poll();
    expect(s.state.ownerId).toBe(OWNER);
  });

  test('an original over Telegram’s upload limit is not sent; the owner is told where it is', async () => {
    const s = await setup({
      downloadDocument: async () => new Uint8Array(MAX_UPLOAD_BYTES + 1),
    });
    const scan = card({
      imageNote: 'read by the model from an image; no text was checked',
      documentId: '2d7d6da0-77c7-4da0-9d20-4da02e3c4f50',
      pageKind: 'scan',
    });
    s.pipeline.applyReview = async () => ({ kind: 'skipped', card: scan });
    await s.notifier.reviewCard(scan);
    const sent = s.fake.last();
    s.fake.press(OWNER, sent, s.fake.button(sent, 'Original'));
    await s.poll();
    expect(s.fake.documents).toEqual([]);
    expect(s.fake.last().text).toContain('open it in SupaMac');
    expect(s.fake.last().text).not.toContain('could not be taken');
  });
});
