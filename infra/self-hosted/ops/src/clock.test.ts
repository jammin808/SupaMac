import { expect, test } from 'bun:test';
import {
  LambdaSchedule,
  nightlyDoneAtStart,
  nightlyDue,
  scheduledEvent,
} from './clock';

const NEXT = 'http://clock:9001/2018-06-01/runtime/invocation/next';

function poll(signal?: AbortSignal): Request {
  return new Request(NEXT, { signal });
}

test('a poll that is waiting gets the scheduled event when the tick comes', async () => {
  const schedule = new LambdaSchedule('email_refresh_handler');

  const waiting = schedule.fetch(poll());
  schedule.tick();
  const response = await waiting;

  expect(response.status).toBe(200);
  expect(response.headers.get('lambda-runtime-aws-request-id')).toBeTruthy();
  expect(
    Number(response.headers.get('lambda-runtime-deadline-ms'))
  ).toBeGreaterThan(Date.now());
  expect(response.headers.get('lambda-runtime-invoked-function-arn')).toBe(
    'arn:aws:lambda:us-east-1:000000000000:function:email_refresh_handler'
  );
  const event = await response.json();
  expect(event['detail-type']).toBe('Scheduled Event');
  expect(event.source).toBe('aws.events');
});

test('an event that became due before the poll is handed out at once', async () => {
  const schedule = new LambdaSchedule('email_scheduled_handler');

  schedule.tick();
  schedule.tick();
  const response = await schedule.fetch(poll());

  expect(response.status).toBe(200);
});

test('a handler that went away does not take the next event with it', async () => {
  const schedule = new LambdaSchedule('email_scheduled_handler');
  const gone = new AbortController();

  const abandoned = schedule.fetch(poll(gone.signal));
  gone.abort();
  await abandoned;
  schedule.tick();
  const response = await schedule.fetch(poll());

  expect(response.status).toBe(200);
});

test('a handler reports its result and its failure to the runtime API', async () => {
  const schedule = new LambdaSchedule('email_scheduled_handler');
  const base = 'http://clock:9002/2018-06-01/runtime';

  const done = await schedule.fetch(
    new Request(`${base}/invocation/abc/response`, {
      method: 'POST',
      body: 'null',
    })
  );
  const failed = await schedule.fetch(
    new Request(`${base}/invocation/abc/error`, { method: 'POST', body: '{}' })
  );
  const neverStarted = await schedule.fetch(
    new Request(`${base}/init/error`, { method: 'POST', body: '{}' })
  );
  const unknown = await schedule.fetch(new Request(`${base}/other`));

  expect([
    done.status,
    failed.status,
    neverStarted.status,
    unknown.status,
  ]).toEqual([202, 202, 202, 404]);
});

test('the scheduled event carries the time it is for', () => {
  const event = JSON.parse(scheduledEvent(new Date('2026-11-21T10:00:00Z')));

  expect(event.time).toBe('2026-11-21T10:00:00.000Z');
});

test('the nightly work runs once a day, from three in the morning UTC', () => {
  const before = new Date('2026-11-21T02:59:00Z');
  const after = new Date('2026-11-21T03:00:00Z');
  const nextDay = new Date('2026-11-22T03:00:00Z');

  expect(nightlyDue(before, undefined)).toBe(false);
  expect(nightlyDue(after, undefined)).toBe(true);
  expect(nightlyDue(after, '2026-11-21')).toBe(false);
  expect(nightlyDue(nextDay, '2026-11-21')).toBe(true);
});

test('a clock started after the nightly hour does not run the work again that day', () => {
  const afternoon = new Date('2026-11-21T15:00:00Z');
  const earlyMorning = new Date('2026-11-21T01:00:00Z');

  expect(nightlyDue(afternoon, nightlyDoneAtStart(afternoon))).toBe(false);
  expect(nightlyDoneAtStart(earlyMorning)).toBeUndefined();
});
