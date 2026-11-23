import { serve } from 'bun';
import { expect, test } from 'bun:test';
import { queueUrl, sendMessage } from './sqs';
import { relayHandler } from './upload-relay';

const EVENT =
  '{"EventName":"s3:ObjectCreated:Put","Key":"doc-storage/a%20b.md","Records":[{"eventName":"s3:ObjectCreated:Put","s3":{"bucket":{"name":"doc-storage"},"object":{"key":"a%20b.md"}}}]}';

function post(body: string, authorization?: string): Request {
  return new Request('http://upload-relay:8080/', {
    method: 'POST',
    headers: authorization ? { authorization } : {},
    body,
  });
}

test('an event with the right token reaches the queue byte for byte', async () => {
  const forwarded: string[] = [];
  const handler = relayHandler({
    token: 'right-token',
    forward: async (body) => {
      forwarded.push(body);
    },
  });

  const response = await handler(post(EVENT, 'Bearer right-token'));

  expect(response.status).toBe(204);
  expect(forwarded).toEqual([EVENT]);
});

test('an event without the token, or with another, is refused and not forwarded', async () => {
  const forwarded: string[] = [];
  const handler = relayHandler({
    token: 'right-token',
    forward: async (body) => {
      forwarded.push(body);
    },
  });

  const missing = await handler(post(EVENT));
  const wrong = await handler(post(EVENT, 'Bearer wrong-token'));
  const bare = await handler(post(EVENT, 'right-token'));

  expect([missing.status, wrong.status, bare.status]).toEqual([401, 401, 401]);
  expect(forwarded).toEqual([]);
});

test('a queue failure answers non-2xx so the object store sends the event again', async () => {
  const handler = relayHandler({
    token: 'right-token',
    forward: async () => {
      throw new Error('queue is down');
    },
  });

  const response = await handler(post(EVENT, 'Bearer right-token'));

  expect(response.status).toBe(502);
});

test('sendMessage posts the body to the queue in the JSON protocol', async () => {
  const requests: {
    target: string | null;
    type: string | null;
    body: unknown;
  }[] = [];
  const queueService = serve({
    port: 0,
    fetch: async (request) => {
      requests.push({
        target: request.headers.get('x-amz-target'),
        type: request.headers.get('content-type'),
        body: await request.json(),
      });
      return Response.json({ MessageId: '1' });
    },
  });
  const awsUrl = `http://127.0.0.1:${queueService.port}`;

  await sendMessage(awsUrl, 'document-upload-finalizer-queue', EVENT);
  await queueService.stop();

  expect(requests).toEqual([
    {
      target: 'AmazonSQS.SendMessage',
      type: 'application/x-amz-json-1.0',
      body: {
        QueueUrl: `${awsUrl}/000000000000/document-upload-finalizer-queue`,
        MessageBody: EVENT,
      },
    },
  ]);
});

test('sendMessage rejects when the queue service refuses', async () => {
  const queueService = serve({
    port: 0,
    fetch: () => new Response('no such queue', { status: 400 }),
  });
  const awsUrl = `http://127.0.0.1:${queueService.port}`;

  const sent = sendMessage(awsUrl, 'missing-queue', EVENT);

  await expect(sent).rejects.toThrow('missing-queue');
  await queueService.stop();
});

test('a queue URL is the endpoint, the fixed account and the queue name', () => {
  expect(queueUrl('http://localstack:4566/', 'reminder-dispatch-queue')).toBe(
    'http://localstack:4566/000000000000/reminder-dispatch-queue'
  );
});
