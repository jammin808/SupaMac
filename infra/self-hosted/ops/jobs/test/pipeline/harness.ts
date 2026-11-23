// A pipeline wired to fakes for tests: the in-memory store, a scripted model
// behind the real AiClient, the state in a temporary directory, a recording
// notifier and a clock the test moves. `restart` opens a new pipeline on the
// same state directory and store, as the service does after a crash.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BetaMessage,
  BetaMessageStreamParams,
  MessageCountTokensParams,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  AiClient,
  type MessagesClient,
  type MessageStreamLike,
} from '../../src/ai/anthropic';
import type { ExtractionReplyWire } from '../../src/ai/extract';
import { Logger } from '../../src/log';
import {
  type Extractor,
  Lane,
  type PipelineContext,
} from '../../src/pipeline/context';
import { HealthMonitor } from '../../src/pipeline/health';
import { RecordingNotifier } from '../../src/pipeline/notify';
import { Pipeline } from '../../src/pipeline/pipeline';
import { StateLedger, StateStore } from '../../src/pipeline/state';
import { extractInSandbox } from '../../src/text/sandbox';
import { jsonReply, refusal, usage } from '../ai/fake';
import { MemoryStore } from './memory-store';

export type Scripted = ExtractionReplyWire | 'refusal' | Error;

/** The model: answers each request by the first marker found in its text. */
export class ScriptedModel implements MessagesClient {
  readonly requests: BetaMessageStreamParams[] = [];
  constructor(readonly script: { marker: string; reply: Scripted }[]) {}

  /** The text of every block of the request's user message. */
  static textOf(body: BetaMessageStreamParams): string {
    const out: string[] = [];
    for (const m of body.messages) {
      if (typeof m.content === 'string') {
        out.push(m.content);
        continue;
      }
      for (const b of m.content ?? []) if (b.type === 'text') out.push(b.text);
    }
    return out.join('\n');
  }

  /** How many requests named the marker. */
  count(marker: string): number {
    return this.requests.filter((r) => ScriptedModel.textOf(r).includes(marker))
      .length;
  }

  readonly beta = {
    messages: {
      stream: (body: BetaMessageStreamParams): MessageStreamLike => {
        this.requests.push(body);
        const text = ScriptedModel.textOf(body);
        const entry = this.script.find((s) => text.includes(s.marker));
        return {
          finalMessage: async (): Promise<BetaMessage> => {
            if (entry === undefined)
              throw new Error('no scripted reply for this request');
            if (entry.reply instanceof Error) throw entry.reply;
            if (entry.reply === 'refusal') return refusal('cyber');
            return jsonReply(entry.reply, usage(3_000, 800));
          },
          abort: () => undefined,
        };
      },
      countTokens: async (
        _body: MessageCountTokensParams
      ): Promise<{ input_tokens: number }> => ({
        input_tokens: 3_000,
      }),
    },
  };
}

export interface World {
  readonly dir: string;
  readonly store: MemoryStore;
  readonly model: ScriptedModel;
  readonly notifier: RecordingNotifier;
  readonly lines: string[];
  now: number;
  state: StateStore;
  ctx: PipelineContext;
  pipeline: Pipeline;
}

export const START = Date.parse('2027-03-05T10:00:00Z');

async function wire(
  world: Omit<World, 'state' | 'ctx' | 'pipeline'> & Partial<World>,
  extract: Extractor
): Promise<void> {
  const clock = (): Date => new Date(world.now);
  const logger = new Logger({
    sink: (line) => world.lines.push(line),
    clock,
    level: 'debug',
  });
  const state = await StateStore.open(world.dir, { clock, logger });
  world.store.onWrite = (versions) => state.recordWritten(versions);
  world.store.clock = clock;
  const ai = new AiClient({
    client: world.model,
    monthlyLimitUsd: 50,
    ledger: new StateLedger(state),
    timeZone: 'Europe/London',
    clock,
    fallbacks: false,
  });
  const ctx: PipelineContext = {
    store: world.store,
    state,
    ai,
    notifier: world.notifier,
    logger,
    clock,
    timeZone: () => 'Europe/London',
    extract,
    webApp: { origin: 'https://supamac.example.com', basePath: '/app' },
    health: new HealthMonitor(state, world.notifier, clock, logger),
    lane: new Lane(),
  };
  world.state = state;
  world.ctx = ctx;
  world.pipeline = new Pipeline(ctx);
}

export async function makeWorld(
  script: { marker: string; reply: Scripted }[],
  options: { extract?: Extractor; store?: MemoryStore } = {}
): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-pipeline-'));
  const world = {
    dir,
    store: options.store ?? new MemoryStore(),
    model: new ScriptedModel(script),
    notifier: new RecordingNotifier(),
    lines: [] as string[],
    now: START,
  } as World;
  await wire(
    world,
    options.extract ?? ((bytes, hint) => extractInSandbox(bytes, hint))
  );
  return world;
}

/** A new pipeline on the same state directory, store and model: a restart. */
export async function restart(
  world: World,
  extract?: Extractor
): Promise<void> {
  await wire(
    world,
    extract ?? ((bytes, hint) => extractInSandbox(bytes, hint))
  );
}

export async function cleanup(world: World): Promise<void> {
  await rm(world.dir, { recursive: true, force: true });
}

/** Values of a row by column key. */
export type RowValues = Record<string, unknown>;
