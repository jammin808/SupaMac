// The stack's clock: the work AWS does with EventBridge schedules.
//
//   bun clock.ts reminders   each minute, the reminder sweep tick
//   bun clock.ts email       the email schedules: the two Lambda handlers
//                            and the nightly CRM cleanup
//
// The email handlers are Lambda binaries, unchanged. A Lambda process asks a
// runtime API for its next event; this serves that API to each handler and
// answers with a scheduled event when one is due. The routes and headers are
// the ones crates/email_e2e/src/lambda.rs serves to the same binaries.

import { serve } from 'bun';
import { sendMessage } from './sqs';

// Queue names as crates/macro_queues gives them for ENVIRONMENT=local.
const REMINDER_QUEUE = 'reminder-dispatch-queue';
const CRM_CLEANUP_QUEUE = 'email-service-crm-cleanup-queue';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** The UTC hour the nightly work starts at. */
const NIGHTLY_HOUR = 3;
/** How long a handler may take, as its deadline header tells it. */
const INVOCATION_TIMEOUT_MS = 5 * MINUTE_MS;

const NEXT = '/2018-06-01/runtime/invocation/next';
const RESPONSE = /^\/2018-06-01\/runtime\/invocation\/[^/]+\/response$/;
const ERROR = /^\/2018-06-01\/runtime\/(invocation\/[^/]+|init)\/error$/;

/** The event EventBridge sends on a schedule. */
export function scheduledEvent(now: Date): string {
  return JSON.stringify({
    version: '0',
    id: crypto.randomUUID(),
    'detail-type': 'Scheduled Event',
    source: 'aws.events',
    account: '000000000000',
    time: now.toISOString(),
    region: 'us-east-1',
    resources: [],
    detail: {},
  });
}

/**
 * The Lambda runtime API for one handler process.
 *
 * `tick` makes one event due. The handler's poll for work gets it at once if
 * it is due, and otherwise waits for the next tick. Ticks while an event is
 * still due add nothing: a handler that fell behind runs once, not once per
 * missed tick.
 */
export class LambdaSchedule {
  private due = false;
  private waiting: (() => void) | undefined;

  constructor(private readonly handler: string) {}

  tick(): void {
    this.due = true;
    this.waiting?.();
  }

  fetch = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);

    if (request.method === 'GET' && pathname === NEXT) {
      return this.next(request);
    }
    if (request.method === 'POST' && RESPONSE.test(pathname)) {
      await request.arrayBuffer();
      console.log(`${this.handler}: done`);
      return new Response(null, { status: 202 });
    }
    if (request.method === 'POST' && ERROR.test(pathname)) {
      console.error(`${this.handler}: failed: ${await request.text()}`);
      return new Response(null, { status: 202 });
    }
    return new Response('not found', { status: 404 });
  };

  private async next(request: Request): Promise<Response> {
    if (!this.due) {
      const ticked = await new Promise<boolean>((resolve) => {
        const release = () => resolve(true);
        this.waiting = release;
        // A handler that went away must not take the event with it.
        request.signal.addEventListener('abort', () => {
          if (this.waiting === release) {
            this.waiting = undefined;
          }
          resolve(false);
        });
      });
      if (!ticked) {
        return new Response(null, { status: 499 });
      }
    }
    this.due = false;
    this.waiting = undefined;

    return new Response(scheduledEvent(new Date()), {
      headers: {
        'content-type': 'application/json',
        'lambda-runtime-aws-request-id': crypto.randomUUID(),
        'lambda-runtime-deadline-ms': String(
          Date.now() + INVOCATION_TIMEOUT_MS
        ),
        'lambda-runtime-invoked-function-arn': `arn:aws:lambda:us-east-1:000000000000:function:${this.handler}`,
      },
    });
  }
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Whether the nightly work is due: once per UTC day, from `NIGHTLY_HOUR` on.
 * `lastDay` is the day it last ran.
 */
export function nightlyDue(now: Date, lastDay: string | undefined): boolean {
  return now.getUTCHours() >= NIGHTLY_HOUR && utcDay(now) !== lastDay;
}

/**
 * The day to count the nightly work as done for when the clock starts. Past
 * the hour, today's: a restart must not run it a second time.
 */
export function nightlyDoneAtStart(now: Date): string | undefined {
  return now.getUTCHours() >= NIGHTLY_HOUR ? utcDay(now) : undefined;
}

function send(awsUrl: string, queue: string, body: object): void {
  sendMessage(awsUrl, queue, JSON.stringify(body)).then(
    () => console.log(`${queue}: sent`),
    // The next tick is the retry.
    (error) => console.error(`${queue}: not sent:`, error)
  );
}

function runSchedule(
  port: number,
  schedule: LambdaSchedule,
  everyMs: number
): void {
  // A handler's poll stays open until its next event, up to an hour.
  serve({ port, idleTimeout: 0, fetch: schedule.fetch });
  schedule.tick();
  setInterval(() => schedule.tick(), everyMs);
}

function runReminders(awsUrl: string): void {
  const sweep = () => send(awsUrl, REMINDER_QUEUE, { operation: 'sweep' });
  sweep();
  setInterval(sweep, MINUTE_MS);
}

function runEmail(awsUrl: string): void {
  runSchedule(9001, new LambdaSchedule('email_refresh_handler'), HOUR_MS);
  runSchedule(9002, new LambdaSchedule('email_scheduled_handler'), MINUTE_MS);

  let lastNightly = nightlyDoneAtStart(new Date());
  setInterval(() => {
    const now = new Date();
    if (nightlyDue(now, lastNightly)) {
      lastNightly = utcDay(now);
      send(awsUrl, CRM_CLEANUP_QUEUE, { operation: 'start_job' });
    }
  }, MINUTE_MS);
}

if (import.meta.main) {
  const awsUrl = process.env.LOCAL_AWS_URL;
  if (!awsUrl) {
    throw new Error('LOCAL_AWS_URL is not set');
  }

  const mode = process.argv[2];
  if (mode === 'reminders') {
    runReminders(awsUrl);
  } else if (mode === 'email') {
    runEmail(awsUrl);
  } else {
    throw new Error('usage: bun clock.ts reminders|email');
  }
  console.log(`clock running: ${mode}`);
}
