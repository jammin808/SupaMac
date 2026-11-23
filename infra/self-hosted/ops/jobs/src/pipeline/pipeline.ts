// The pipeline as the ways in and main.ts use it: every step that writes
// runs on the one lane (context.ts), one at a time, in the order asked.
//
// Invariants:
// - No step calls another through this class: the lane is entered once per
//   request, so a step never waits on itself.
// - A question only reads (answers.ts), so it does not wait for the lane: a
//   long source does not hold an answer back.

import type { AnswerTools } from '../ai/answer';
import { isTimeZone } from '../config';
import { type AskOutcome, answerTools, ask } from './answers';
import type { PipelineContext } from './context';
import { pollEdits, type EditPollResult } from './edits';
import {
  answerFiling,
  type FilingAnswer,
  type FilingResult,
  resumeAnswers,
} from './filing';
import { pollFolder, type FolderPollResult } from './folder';
import {
  type EmailInput,
  processEmail,
  processSource,
  resume,
  retry,
  type SourceInput,
  type SourceResult,
} from './process';
import {
  applyReview,
  type ReviewPress,
  type ReviewResult,
  reviewCards,
} from './review';
import type { ReviewCard } from './notify';

export class Pipeline {
  constructor(readonly ctx: PipelineContext) {}

  /** A file, photo, forwarded message or `/add` note. */
  processSource(input: SourceInput): Promise<SourceResult> {
    return this.ctx.lane.run(() => processSource(this.ctx, input));
  }

  /** An email and its attachments; the mail unit moves the message by the result. */
  processEmail(input: EmailInput): Promise<SourceResult> {
    return this.ctx.lane.run(() => processEmail(this.ctx, input));
  }

  /**
   * Resumes Processing sources that are due, files answers saved but not yet
   * filed, and sends summaries and questions still owed.
   */
  resume(): Promise<SourceResult[]> {
    return this.ctx.lane.run(async () => {
      const results = await resume(this.ctx);
      await resumeAnswers(this.ctx);
      return results;
    });
  }

  /** A question asked on Telegram, answered from the Jobs database (design, Asking). */
  ask(
    question: string,
    options: {
      readonly key?: string | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {}
  ): Promise<AskOutcome> {
    return ask(this.ctx, question, options);
  }

  /** The queries a question runs, for an intake that drives the question loop itself. */
  answerTools(): AnswerTools {
    return answerTools(this.ctx);
  }

  /** The owner's Retry on a Failed source. */
  retry(sourceId: string): ReturnType<typeof retry> {
    return this.ctx.lane.run(() => retry(this.ctx, sourceId));
  }

  answerFiling(answer: FilingAnswer): Promise<FilingResult> {
    return this.ctx.lane.run(() => answerFiling(this.ctx, answer));
  }

  reviewCards(
    filter: { sourceId?: string; jobId?: string } = {}
  ): Promise<ReviewCard[]> {
    return this.ctx.lane.run(() => reviewCards(this.ctx, filter));
  }

  applyReview(press: ReviewPress): Promise<ReviewResult> {
    return this.ctx.lane.run(() => applyReview(this.ctx, press));
  }

  pollEdits(): Promise<EditPollResult> {
    return this.ctx.lane.run(() => pollEdits(this.ctx));
  }

  pollFolder(): Promise<FolderPollResult> {
    return this.ctx.lane.run(() => pollFolder(this.ctx));
  }

  /**
   * `/tz`: the owner's zone for dates from now on; false for a zone this
   * runtime does not know. The monthly spend keeps JOBS_TIME_ZONE's months.
   */
  setTimeZone(zone: string): Promise<boolean> {
    return this.ctx.lane.run(async () => {
      if (!isTimeZone(zone)) return false;
      await this.ctx.state.update((s) => {
        s.timeZone = zone;
      });
      return true;
    });
  }

  /** Settles once every step asked so far has settled. */
  idle(): Promise<void> {
    return this.ctx.lane.idle();
  }
}
