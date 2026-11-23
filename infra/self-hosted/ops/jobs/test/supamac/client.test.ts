import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { Logger, type LogLevel } from '../../src/log';
import {
  type ApiRequest,
  API_KEY_HEADER,
  DEFAULT_SUPAMAC_BASE_URL,
  type FetchInit,
  fillTemplate,
  SupaMacClient,
  SupaMacError,
  type SupaMacErrorKind,
} from '../../src/supamac/client';

// A key shaped like a real one, valid for nothing, put together at run time.
const KEY = ['mak', 'a1'.repeat(32)].join('_');

interface Call {
  url: string;
  init: FetchInit;
}

function fake(answer: (call: Call) => Response | Promise<Response>): {
  calls: Call[];
  fetch: (url: string, init: FetchInit) => Promise<Response>;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return answer(call);
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const PING: ApiRequest<{ ok: boolean }> = {
  method: 'GET',
  template: '/databases/{id}',
  params: { id: '0190d5a8-0000-7000-8000-000000000001' },
  query: {},
  response: z.object({ ok: z.boolean() }),
};

function capture(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = new Logger({
    level: 'debug',
    clock: () => new Date('2027-03-13T07:30:00.000Z'),
    sink: (line: string, _level: LogLevel) => lines.push(line),
  });
  return { logger, lines };
}

async function failure(promise: Promise<unknown>): Promise<SupaMacError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SupaMacError);
    return error as SupaMacError;
  }
  throw new Error('expected a SupaMacError');
}

describe('requests', () => {
  test('go to the gateway with the key in its header only, and refuse redirects', async () => {
    const f = fake(() => json(200, { ok: true }));
    const client = new SupaMacClient({ apiKey: KEY, fetch: f.fetch });
    expect(client.baseUrl).toBe(DEFAULT_SUPAMAC_BASE_URL);
    expect(await client.send(PING)).toEqual({ ok: true });
    const call = f.calls[0] as Call;
    expect(call.url).toBe(
      'http://gateway:8081/dss/databases/0190d5a8-0000-7000-8000-000000000001'
    );
    expect(call.init.method).toBe('GET');
    expect(call.init.headers[API_KEY_HEADER]).toBe(KEY);
    expect(call.init.headers.authorization).toBeUndefined();
    expect(call.init.redirect).toBe('error');
    expect(call.url).not.toContain(KEY);
  });

  test('send JSON and bytes with their content types, and the query in order', async () => {
    const f = fake(() => json(200, { ok: true }));
    const client = new SupaMacClient({
      apiKey: KEY,
      baseUrl: 'http://gateway:8080/dss/',
      fetch: f.fetch,
    });
    await client.send({
      ...PING,
      method: 'POST',
      template: '/databases',
      params: {},
      body: { kind: 'json', value: { name: 'Jobs' } },
    });
    const bytes = new Uint8Array([37, 80, 68, 70]);
    await client.send({
      ...PING,
      method: 'POST',
      template: '/documents/upload',
      params: {},
      query: {
        fileName: 'Call sheet & notes.pdf',
        projectId: '0190d5a8-0000-7000-8000-000000000002',
      },
      body: { kind: 'bytes', value: bytes },
    });
    const [jsonCall, bytesCall] = f.calls as [Call, Call];
    expect(jsonCall.url).toBe('http://gateway:8080/dss/databases');
    expect(jsonCall.init.headers['content-type']).toBe('application/json');
    expect(jsonCall.init.body).toBe('{"name":"Jobs"}');
    expect(bytesCall.url).toBe(
      'http://gateway:8080/dss/documents/upload?fileName=Call+sheet+%26+notes.pdf&projectId=0190d5a8-0000-7000-8000-000000000002'
    );
    expect(bytesCall.init.headers['content-type']).toBe(
      'application/octet-stream'
    );
    expect(bytesCall.init.body).toBe(bytes);
  });

  test('fill each path parameter percent-encoded, and refuse a missing or unknown one', () => {
    expect(
      fillTemplate(
        '/entities/{entity_type}/{entity_id}/direct-access/{user_id}',
        {
          entity_type: 'database',
          entity_id: '0190d5a8-0000-7000-8000-000000000001',
          user_id: 'macro|sam.price@example.com',
        }
      )
    ).toBe(
      '/entities/database/0190d5a8-0000-7000-8000-000000000001/direct-access/macro%7Csam.price%40example.com'
    );
    expect(() => fillTemplate('/databases/{id}', {})).toThrow(SupaMacError);
    expect(() => fillTemplate('/databases', { id: 'x' })).toThrow(
      'no parameter {id}'
    );
    expect(() =>
      fillTemplate('/databases/{id}', { id: '../projects' })
    ).not.toThrow();
    expect(fillTemplate('/databases/{id}', { id: '../projects' })).toBe(
      '/databases/..%2Fprojects'
    );
  });

  test('refuse a bad key or base URL before anything is sent', () => {
    expect(() => new SupaMacClient({ apiKey: 'short' })).toThrow(SupaMacError);
    expect(() => new SupaMacClient({ apiKey: `${KEY}\r\nx-other: 1` })).toThrow(
      SupaMacError
    );
    expect(
      () => new SupaMacClient({ apiKey: KEY, baseUrl: 'ftp://gateway/dss' })
    ).toThrow('http or https');
    expect(
      () =>
        new SupaMacClient({
          apiKey: KEY,
          baseUrl: 'http://user:pw@gateway:8080/dss',
        })
    ).toThrow('credentials');
    expect(
      () => new SupaMacClient({ apiKey: KEY, baseUrl: 'not a url' })
    ).toThrow('not a URL');
  });
});

describe('answers', () => {
  test('are validated by the route schema', async () => {
    const client = new SupaMacClient({
      apiKey: KEY,
      fetch: fake(() => json(200, { ok: 'yes' })).fetch,
    });
    const error = await failure(client.send(PING));
    expect(error.kind).toBe('bad_response');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('at ok');

    const notJson = new SupaMacClient({
      apiKey: KEY,
      fetch: fake(() => new Response('<html>', { status: 200 })).fetch,
    });
    expect((await failure(notJson.send(PING))).kind).toBe('bad_response');
  });

  test('an empty body reads as null', async () => {
    const client = new SupaMacClient({
      apiKey: KEY,
      fetch: fake(() => new Response('', { status: 200 })).fetch,
    });
    expect(await client.send({ ...PING, response: z.null() })).toBeNull();
  });

  const cases: [number, SupaMacErrorKind, boolean][] = [
    [400, 'invalid', false],
    [401, 'unauthorised', false],
    [403, 'forbidden', false],
    [404, 'not_found', false],
    [409, 'conflict', false],
    [413, 'too_large', false],
    [422, 'invalid', false],
    [429, 'rate_limited', true],
    [500, 'server', true],
    [502, 'unavailable', true],
    [503, 'unavailable', true],
    [504, 'unavailable', true],
  ];
  test("a route's own meaning for a status wins: the upload route's 401 is no edit access to the folder", async () => {
    const client = new SupaMacClient({
      apiKey: KEY,
      fetch: fake(() =>
        json(401, { message: 'no edit access to the destination project' })
      ).fetch,
    });
    const upload = await failure(
      client.send({ ...PING, statusKinds: { 401: 'forbidden' } })
    );
    expect(upload.kind).toBe('forbidden');
    expect(upload.status).toBe(401);
    expect(upload.retryable).toBe(false);
    expect((await failure(client.send(PING))).kind).toBe('unauthorised');
  });

  for (const [status, kind, retryable] of cases) {
    test(`${status} is a ${kind} error, ${retryable ? '' : 'not '}retryable`, async () => {
      const client = new SupaMacClient({
        apiKey: KEY,
        fetch: fake(() =>
          json(status, { message: 'a table moved from its base version' })
        ).fetch,
      });
      const error = await failure(client.send(PING));
      expect(error.kind).toBe(kind);
      expect(error.retryable).toBe(retryable);
      expect(error.status).toBe(status);
      expect(error.route).toBe('GET /databases/{id}');
      expect(error.detail).toBe('a table moved from its base version');
    });
  }

  test('an op refusal keeps its index and the id it found taken', async () => {
    const client = new SupaMacClient({
      apiKey: KEY,
      fetch: fake(() =>
        json(400, {
          message: 'id taken',
          op: 0,
          row: null,
          column: null,
          taken: { kind: 'view', id: '0190d5a8-0000-7000-8000-000000000009' },
        })
      ).fetch,
    });
    const error = await failure(client.send(PING));
    expect(error.kind).toBe('invalid');
    expect(error.refusal).toEqual({
      op: 0,
      row: null,
      column: null,
      message: 'id taken',
      taken: { kind: 'view', id: '0190d5a8-0000-7000-8000-000000000009' },
    });
  });

  test('a plain-text error body is kept as the detail, shortened', async () => {
    const client = new SupaMacClient({
      apiKey: KEY,
      fetch: fake(() => new Response('x'.repeat(2000), { status: 500 })).fetch,
    });
    const error = await failure(client.send(PING));
    expect(error.detail).toHaveLength(500);
  });
});

describe('failures to answer', () => {
  test('a gateway that does not answer is unavailable and retryable', async () => {
    const client = new SupaMacClient({
      apiKey: KEY,
      fetch: async () => {
        throw new TypeError('connect ECONNREFUSED gateway:8080');
      },
    });
    const error = await failure(client.send(PING));
    expect(error.kind).toBe('unavailable');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('ECONNREFUSED');
  });

  test('no answer in time is a timeout, and the request is aborted', async () => {
    let aborted = false;
    const client = new SupaMacClient({
      apiKey: KEY,
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    const error = await failure(client.send(PING));
    expect(error.kind).toBe('timeout');
    expect(error.retryable).toBe(true);
    expect(aborted).toBe(true);
  });
});

describe('the key', () => {
  test('never reaches a log line or an error, even when the server echoes it', async () => {
    const { logger, lines } = capture();
    const client = new SupaMacClient({
      apiKey: KEY,
      logger,
      fetch: fake(() => json(401, { message: `key ${KEY} is revoked` })).fetch,
    });
    const error = await failure(client.send(PING));
    logger.error('request failed', { error });
    expect(error.message).not.toContain(KEY);
    expect(error.detail).not.toContain(KEY);
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(
      KEY
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(KEY);

    const failing = new SupaMacClient({
      apiKey: KEY,
      logger,
      fetch: async () => {
        throw new Error(`proxy refused header ${KEY}`);
      },
    });
    const network = await failure(failing.send(PING));
    expect(network.message).not.toContain(KEY);
  });

  test('an answer that is not JSON, or that breaks off, carries no error that quotes it', async () => {
    const notJson = new SupaMacClient({
      apiKey: KEY,
      fetch: fake(() => new Response(`key ${KEY}`, { status: 200 })).fetch,
    });
    const parse = await failure(notJson.send(PING));
    expect(parse.kind).toBe('bad_response');
    expect(parse.cause).toBeUndefined();

    const broken = new SupaMacClient({
      apiKey: KEY,
      fetch: fake(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"ok":'));
                controller.error(
                  new Error(`stream reset while reading for ${KEY}`)
                );
              },
            }),
            { status: 200 }
          )
      ).fetch,
    });
    const read = await failure(broken.send(PING));
    expect(read.kind).toBe('bad_response');
    expect(read.cause).toBeUndefined();
    expect(read.message).toContain('stream reset');
    expect([read.message, JSON.stringify(read)].join('\n')).not.toContain(KEY);
  });

  test('successful requests log the route and status, not headers', async () => {
    const { logger, lines } = capture();
    const client = new SupaMacClient({
      apiKey: KEY,
      logger,
      fetch: fake(() => json(200, { ok: true })).fetch,
      now: () => 0,
    });
    await client.send(PING);
    const line = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: 'debug',
      msg: 'supamac request',
      route: 'GET /databases/{id}',
      status: 200,
      ms: 0,
    });
    expect(lines.join('\n')).not.toContain(API_KEY_HEADER);
  });
});

describe('object downloads', () => {
  test('go to the gateway origin, keep the signed path and query, and carry no key', async () => {
    const f = fake(
      () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    );
    const client = new SupaMacClient({ apiKey: KEY, fetch: f.fetch });
    const bytes = await client.fetchObject(
      'https://api.example.com/local-storage/doc-storage/abc.pdf?X-Amz-Signature=sig&X-Amz-Expires=300',
      { maxBytes: 10 }
    );
    expect([...bytes]).toEqual([1, 2, 3]);
    const call = f.calls[0] as Call;
    expect(call.url).toBe(
      'http://gateway:8081/local-storage/doc-storage/abc.pdf?X-Amz-Signature=sig&X-Amz-Expires=300'
    );
    expect(call.init.headers[API_KEY_HEADER]).toBeUndefined();
    expect(call.init.redirect).toBe('error');
  });

  test('refuse a URL outside the object store and stop at the size limit', async () => {
    const f = fake(() => new Response(new Uint8Array(64), { status: 200 }));
    const client = new SupaMacClient({ apiKey: KEY, fetch: f.fetch });
    expect(
      (
        await failure(
          client.fetchObject('https://elsewhere.example.com/file.pdf', {
            maxBytes: 100,
          })
        )
      ).kind
    ).toBe('bad_response');
    expect(f.calls).toHaveLength(0);
    const tooBig = await failure(
      client.fetchObject('https://api.example.com/local-storage/x/y.pdf', {
        maxBytes: 10,
      })
    );
    expect(tooBig.kind).toBe('too_large');
    const declared = fake(
      () =>
        new Response('', {
          status: 200,
          headers: { 'content-length': '999999' },
        })
    );
    const c2 = new SupaMacClient({ apiKey: KEY, fetch: declared.fetch });
    expect(
      (
        await failure(
          c2.fetchObject('https://api.example.com/local-storage/x/y.pdf', {
            maxBytes: 10,
          })
        )
      ).kind
    ).toBe('too_large');
  });
});

describe('the deadline', () => {
  test('covers an answer whose body stops arriving, and a transport that ignores the abort', async () => {
    const stalled = new SupaMacClient({
      apiKey: KEY,
      timeoutMs: 20,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"ok":'));
            },
          }),
          { status: 200 }
        ),
    });
    const error = await failure(stalled.send(PING));
    expect(error.kind).toBe('timeout');

    const deaf = new SupaMacClient({
      apiKey: KEY,
      timeoutMs: 20,
      fetch: () => new Promise<Response>(() => {}),
    });
    expect((await failure(deaf.send(PING))).kind).toBe('timeout');
  });
});
