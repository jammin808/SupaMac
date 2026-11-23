// Carries the object store's "object created" events to the upload finalizer.
//
// On AWS the bucket notifies the finalizer's queue itself. The object store
// here can only call a webhook, so it calls this, and this puts the event on
// the queue unchanged: the finalizer reads the same S3 event either way.
//
// Any failure answers non-2xx, which makes the object store keep the event
// and send it again. A lost event is a document that never finishes
// uploading.

import { timingSafeEqual } from 'node:crypto';
import { serve } from 'bun';
import { sendMessage } from './sqs';

export type RelayOptions = {
  /** What the object store sends as its bearer token. */
  token: string;
  /** Delivers one event body to the finalizer's queue. */
  forward: (body: string) => Promise<void>;
};

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function relayHandler(options: RelayOptions) {
  return async (request: Request): Promise<Response> => {
    // The health check, and the object store's probe of its webhook target.
    if (request.method === 'GET' || request.method === 'HEAD') {
      return new Response('ok');
    }
    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }

    const authorization = request.headers.get('authorization') ?? '';
    if (!sameToken(authorization, `Bearer ${options.token}`)) {
      return new Response('unauthorized', { status: 401 });
    }

    const body = await request.text();
    if (body.length === 0) {
      return new Response('empty event', { status: 400 });
    }

    try {
      await options.forward(body);
    } catch (error) {
      console.error('could not queue an upload event:', error);
      return new Response('could not queue the event', { status: 502 });
    }
    return new Response(null, { status: 204 });
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

if (import.meta.main) {
  const awsUrl = required('LOCAL_AWS_URL');
  const queue = required('UPLOAD_FINALIZER_QUEUE');

  const server = serve({
    port: 8080,
    fetch: relayHandler({
      token: required('MINIO_NOTIFY_WEBHOOK_AUTH_TOKEN_UPLOADS'),
      forward: (body) => sendMessage(awsUrl, queue, body),
    }),
  });
  console.log(
    `upload relay listening on :${server.port}, forwarding to ${queue}`
  );
}
