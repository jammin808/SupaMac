// A second look at the egress proxy from the side of someone who controls the
// jobs container and wants to reach anything but the allowed hosts: request
// lines and headers written to mislead, every way of spelling a host, a port
// or an address, DNS answers that change or hide a private address, and
// requests pipelined behind the first. Every test talks to the proxy over
// real sockets on 127.0.0.1; names resolve through an injected resolver and
// the dialler connects every checked address to a local upstream, so no test
// reaches the network.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  connect,
  createServer,
  isIP,
  type Server,
  type Socket,
} from 'node:net';
import {
  type EgressProxy,
  type LogLine,
  type ProxyOptions,
  parseAllowList,
  type Resolve,
  startEgressProxy,
} from './egress-proxy';

// Addresses from the documentation ranges: never dialled for real, only
// checked; the test dialler connects them to the local upstream.
const PUBLIC = '203.0.113.10';
const PUBLIC6 = '2001:db8::10';
const ALLOWED = 'api.example.com:443';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

type Upstream = { port: number; received: Buffer[]; server: Server };

/** A TCP server that answers every chunk with the chunk in upper case. */
async function upstream(): Promise<Upstream> {
  const state: Upstream = {
    port: 0,
    received: [],
    server: createServer((socket) => {
      socket.on('data', (chunk: Buffer) => {
        state.received.push(chunk);
        socket.write(chunk.toString('latin1').toUpperCase());
      });
      socket.on('error', () => undefined);
    }),
  };
  await new Promise<void>((ready) =>
    state.server.listen(0, '127.0.0.1', ready)
  );
  const address = state.server.address();
  state.port = typeof address === 'object' && address ? address.port : 0;
  cleanups.push(
    () => new Promise<void>((done) => state.server.close(() => done()))
  );
  return state;
}

type Harness = {
  proxy: EgressProxy;
  logs: LogLine[];
  /** Every name the proxy asked the resolver for. */
  resolved: string[];
  /** Every `address:port` the proxy dialled. */
  dialled: string[];
  target: Upstream;
};

/**
 * A proxy whose resolver answers `answer(host, n)` for the n-th lookup
 * (from 0), and whose dialler connects every address to a local upstream.
 */
async function harness(
  allow: string,
  answer: (host: string, n: number) => string[] | Promise<string[]> = () => [
    PUBLIC,
  ],
  options: Partial<ProxyOptions> = {}
): Promise<Harness> {
  const target = await upstream();
  const logs: LogLine[] = [];
  const resolved: string[] = [];
  const dialled: string[] = [];
  const proxy = await startEgressProxy({
    allow: parseAllowList(allow),
    port: 0,
    host: '127.0.0.1',
    log: (line) => logs.push(line),
    resolve: async (host) => {
      resolved.push(host);
      return answer(host, resolved.length - 1);
    },
    dial: (address, port) => {
      dialled.push(`${address}:${port}`);
      return connect({ host: '127.0.0.1', port: target.port });
    },
    ...options,
  });
  cleanups.push(() => proxy.close());
  return { proxy, logs, resolved, dialled, target };
}

type Client = {
  socket: Socket;
  text(): string;
  /** Resolves when what arrived so far satisfies `done`. */
  until(done: (text: string) => boolean, ms?: number): Promise<string>;
  closed: Promise<void>;
};

function client(port: number, allowHalfOpen = false): Promise<Client> {
  return new Promise((ready, fail) => {
    const socket = connect({ host: '127.0.0.1', port, allowHalfOpen });
    let text = '';
    const waiters: (() => void)[] = [];
    const wakeAll = (): void => {
      for (const wake of waiters.splice(0)) {
        wake();
      }
    };
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('latin1');
      wakeAll();
    });
    socket.on('error', () => undefined);
    const closed = new Promise<void>((done) => socket.once('close', done));
    closed.then(wakeAll);
    socket.once('connect', () =>
      ready({
        socket,
        text: () => text,
        closed,
        until: (done, ms = 3000) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(
              () =>
                reject(
                  new Error(`timed out; received ${JSON.stringify(text)}`)
                ),
              ms
            );
            const check = (): void => {
              if (done(text)) {
                clearTimeout(timer);
                resolve(text);
              } else if (socket.destroyed) {
                clearTimeout(timer);
                reject(new Error(`closed; received ${JSON.stringify(text)}`));
              } else {
                waiters.push(check);
              }
            };
            check();
          }),
      })
    );
    socket.once('error', fail);
    cleanups.push(async () => {
      socket.destroy();
    });
  });
}

/** Sends `bytes` and reads the whole answer until the proxy closes. */
async function ask(port: number, bytes: string): Promise<string> {
  const c = await client(port);
  c.socket.write(bytes, 'latin1');
  await c.closed;
  return c.text();
}

function status(answer: string): number {
  return Number(/^HTTP\/1\.1 (\d{3}) /.exec(answer)?.[1]);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Waits until `condition` holds, for at most a second. */
async function eventually(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited >= 1000) {
      throw new Error('the condition never held');
    }
    await sleep(10);
  }
}

/**
 * Sends each request head on a connection of its own and returns
 * `[head, status]` pairs, so a failure names the head that got through.
 */
async function statuses(
  port: number,
  heads: string[]
): Promise<[string, number][]> {
  const answers: [string, number][] = [];
  for (const head of heads) {
    answers.push([head, status(await ask(port, head))]);
  }
  return answers;
}

/** Opens a tunnel and returns the client once the proxy said 200. */
async function opened(port: number, head: string): Promise<Client> {
  const c = await client(port);
  c.socket.write(head);
  await c.until((text) => text.includes('\r\n\r\n'));
  expect(status(c.text())).toBe(200);
  return c;
}

describe('requests written to mislead', () => {
  test('a plain request in absolute form, or any method but CONNECT, is refused before any lookup', async () => {
    const h = await harness(ALLOWED);
    const heads = [
      'GET http://api.example.com:443/ HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n',
      'GET https://api.example.com/ HTTP/1.1\r\n\r\n',
      'POST http://api.example.com:443/v1 HTTP/1.1\r\nContent-Length: 0\r\n\r\n',
      'OPTIONS * HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n',
      'GET http://gateway:8080/dss/ HTTP/1.1\r\n\r\n',
      'GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\n\r\n',
      'HEAD /health HTTP/1.1\r\n\r\n',
      'GET /health?x=1 HTTP/1.1\r\n\r\n',
      'GET /HEALTH HTTP/1.1\r\n\r\n',
    ];
    expect(await statuses(h.proxy.port, heads)).toEqual(
      heads.map((head) => [head, 403])
    );
    expect(h.resolved).toEqual([]);
    expect(h.dialled).toEqual([]);
  });

  test('a CONNECT target that is anything but host:port is refused before any lookup', async () => {
    const h = await harness(ALLOWED);
    const targets = [
      'http://api.example.com:443',
      '//api.example.com:443',
      'api.example.com:443/',
      'api.example.com:443/v1',
      'api.example.com:443?x',
      'api.example.com:443#x',
      'user@api.example.com:443',
      'user:pass@api.example.com:443',
      'api.example.com',
      'api.example.com:',
      ':443',
      'api.example.com:443:443',
      '[api.example.com]:443',
    ];
    const heads = targets.map((target) => `CONNECT ${target} HTTP/1.1\r\n\r\n`);
    expect(await statuses(h.proxy.port, heads)).toEqual(
      heads.map((head) => [head, 403])
    );
    expect(h.resolved).toEqual([]);
    expect(h.dialled).toEqual([]);
  });

  test('a request line that is not exactly `METHOD target HTTP/1.x` is answered 400 before any lookup', async () => {
    const h = await harness(ALLOWED);
    const heads = [
      'connect api.example.com:443 HTTP/1.1\r\n\r\n',
      'Connect api.example.com:443 HTTP/1.1\r\n\r\n',
      'CONNECT  api.example.com:443 HTTP/1.1\r\n\r\n',
      'CONNECT\tapi.example.com:443 HTTP/1.1\r\n\r\n',
      ' CONNECT api.example.com:443 HTTP/1.1\r\n\r\n',
      'CONNECT api.example.com:443 HTTP/1.1 \r\n\r\n',
      'CONNECT api.example.com:443\r\n\r\n',
      'CONNECT api.example.com:443 HTTP/2.0\r\n\r\n',
      'CONNECT api.example.com:443 http/1.1\r\n\r\n',
      // A bare LF ends no line here: the whole head is one malformed line.
      'CONNECT api.example.com:443 HTTP/1.1\nHost: api.example.com\r\n\r\n',
      'CONNECT api.example.com:443 HTTP/1.1\rX\r\n\r\n',
      'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n',
    ];
    expect(await statuses(h.proxy.port, heads)).toEqual(
      heads.map((head) => [head, 400])
    );
    expect(h.resolved).toEqual([]);
    expect(h.dialled).toEqual([]);
  });

  test('headers never choose the destination: only the request line does', async () => {
    const h = await harness(ALLOWED);
    // A refused target is not rescued by headers naming an allowed one.
    const refused = await ask(
      h.proxy.port,
      'CONNECT gateway:8080 HTTP/1.1\r\nHost: api.example.com:443\r\nX-Forwarded-Host: api.example.com:443\r\nForwarded: host=api.example.com:443\r\n\r\n'
    );
    expect(status(refused)).toBe(403);
    expect(h.resolved).toEqual([]);

    // An allowed target goes to the address checked for it, whatever the
    // headers name.
    const c = await opened(
      h.proxy.port,
      'CONNECT api.example.com:443 HTTP/1.1\r\nHost: 10.0.0.5:22\r\nX-Forwarded-For: 10.0.0.5\r\nForwarded: for=10.0.0.5;host=gateway:8080\r\nVia: 1.1 gateway\r\n\r\n'
    );
    c.socket.end();
    await c.closed;
    expect(h.resolved).toEqual(['api.example.com']);
    expect(h.dialled).toEqual([`${PUBLIC}:443`]);
  });

  test('only the first request on a connection is answered; what follows it is never routed', async () => {
    const h = await harness(ALLOWED);
    const health = await ask(
      h.proxy.port,
      'GET /health HTTP/1.1\r\n\r\nCONNECT api.example.com:443 HTTP/1.1\r\n\r\n'
    );
    expect(status(health)).toBe(200);
    expect(health.endsWith('\r\n\r\nok\n')).toBe(true);
    const refused = await ask(
      h.proxy.port,
      'CONNECT gateway:8080 HTTP/1.1\r\n\r\nCONNECT api.example.com:443 HTTP/1.1\r\n\r\n'
    );
    expect(status(refused)).toBe(403);
    await sleep(100);
    expect(h.resolved).toEqual([]);
    expect(h.dialled).toEqual([]);
  });

  test('a CONNECT inside a tunnel is bytes for the upstream, never a second request', async () => {
    const h = await harness(ALLOWED);
    const c = await opened(
      h.proxy.port,
      'CONNECT api.example.com:443 HTTP/1.1\r\n\r\n'
    );
    const inner = 'CONNECT 10.0.0.5:22 HTTP/1.1\r\n\r\n';
    c.socket.write(inner);
    await c.until((text) => text.endsWith(inner.toUpperCase()));
    c.socket.end();
    await c.closed;
    expect(Buffer.concat(h.target.received).toString()).toBe(inner);
    expect(h.resolved).toEqual(['api.example.com']);
    expect(h.dialled).toEqual([`${PUBLIC}:443`]);
  });
});

describe('ports', () => {
  test('a port that is not listed is refused however it is written', async () => {
    const h = await harness(ALLOWED);
    const ports = [
      '80',
      '22',
      '444',
      '442',
      '4443',
      '8080',
      '0',
      '65536',
      '99999',
      '+443',
      '-443',
      '443.0',
      '0x1bb',
      '1e3',
      '443 ',
      ' 443',
      // Full-width digits, as UTF-8 bytes.
      '\u00ef\u00bc\u0094\u00ef\u00bc\u0094\u00ef\u00bc\u0093',
    ];
    const heads = ports.map(
      (port) => `CONNECT api.example.com:${port} HTTP/1.1\r\n\r\n`
    );
    const answers = await statuses(h.proxy.port, heads);
    for (const [head, code] of answers) {
      expect([head, code === 400 || code === 403]).toEqual([head, true]);
    }
    expect(h.resolved).toEqual([]);
    expect(h.dialled).toEqual([]);
  });

  test('leading zeros name the listed port itself, and the tunnel dials exactly that port', async () => {
    const h = await harness(ALLOWED);
    const c = await opened(
      h.proxy.port,
      'CONNECT api.example.com:00443 HTTP/1.1\r\n\r\n'
    );
    c.socket.end();
    await c.closed;
    expect(h.dialled).toEqual([`${PUBLIC}:443`]);
  });
});

describe('host names and IP literals', () => {
  test('a host that is not exactly a listed name is refused before any lookup', async () => {
    const h = await harness(ALLOWED);
    const hosts = [
      'api.example.com.',
      'api.example.com..',
      '.api.example.com',
      'api..example.com',
      'example.com',
      'api.example.co',
      'api.example.com.evil.example',
      'evil.example.api.example.com',
      'api-example.com',
      'api.example.com\0',
      'api.example.com%00',
      'api%2eexample.com',
      '*.example.com',
      '*',
      // Cyrillic `а` in place of Latin `a`, as UTF-8 bytes.
      'api.exÐ°mple.com',
      'xn--api-example.com',
      'localhost',
      'gateway',
      'jobs-egress',
      'document-storage-service',
      'minio',
      'postgres',
    ];
    const heads = hosts.map((host) => `CONNECT ${host}:443 HTTP/1.1\r\n\r\n`);
    expect(await statuses(h.proxy.port, heads)).toEqual(
      heads.map((head) => [head, 403])
    );
    expect(h.resolved).toEqual([]);
    expect(h.dialled).toEqual([]);
  });

  test('an IP literal that is not listed is refused in every notation, before any lookup', async () => {
    const h = await harness(ALLOWED);
    const hosts = [
      '127.0.0.1',
      '127.1',
      '2130706433',
      '0x7f000001',
      '0x7f.1',
      '0177.0.0.1',
      '017700000001',
      '10.0.0.5',
      '172.17.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '0',
      PUBLIC,
      '[::1]',
      '[::]',
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '[0:0:0:0:0:ffff:7f00:1]',
      '[64:ff9b::a00:5]',
      '[2002:a00:5::1]',
      '[fe80::1]',
      '[fe80::1%eth0]',
      '[fe80::1%25eth0]',
      '[fd00::1]',
      `[${PUBLIC6}]`,
      '::1',
    ];
    const heads = hosts.map((host) => `CONNECT ${host}:443 HTTP/1.1\r\n\r\n`);
    expect(await statuses(h.proxy.port, heads)).toEqual(
      heads.map((head) => [head, 403])
    );
    expect(h.resolved).toEqual([]);
    expect(h.dialled).toEqual([]);
  });

  test('a listed IPv4 literal that is not public is refused with the system resolver, and nothing is dialled', async () => {
    const listed = [
      '169.254.169.254:80',
      '10.0.0.5:443',
      '172.17.0.1:443',
      '192.168.1.1:443',
      '100.64.0.1:443',
      '0.0.0.0:443',
      '127.0.0.1:443',
      '198.18.0.1:443',
    ];
    const target = await upstream();
    const logs: LogLine[] = [];
    const dialled: string[] = [];
    // No resolver given: the system's, which answers an IP literal with
    // itself and asks no DNS server.
    const proxy = await startEgressProxy({
      allow: parseAllowList(listed.join(',')),
      port: 0,
      host: '127.0.0.1',
      log: (line) => logs.push(line),
      dial: (address, port) => {
        dialled.push(`${address}:${port}`);
        return connect({ host: '127.0.0.1', port: target.port });
      },
    });
    cleanups.push(() => proxy.close());
    const heads = listed.map((pair) => `CONNECT ${pair} HTTP/1.1\r\n\r\n`);
    expect(await statuses(proxy.port, heads)).toEqual(
      heads.map((head) => [head, 403])
    );
    expect(dialled).toEqual([]);
    expect(
      logs.every(
        (line) =>
          line.outcome === 'refused' && line.reason === 'address not public'
      )
    ).toBe(true);
    expect(logs).toHaveLength(listed.length);
  });
});

describe('DNS answers', () => {
  test('a name is resolved once per tunnel and only the addresses checked are dialled (rebinding)', async () => {
    // The answer flips between a public and a private address on every
    // lookup, as a rebinding name server would.
    const h = await harness(ALLOWED, (_host, n) =>
      n % 2 === 0 ? [PUBLIC] : ['10.0.0.5']
    );
    const first = await opened(
      h.proxy.port,
      'CONNECT api.example.com:443 HTTP/1.1\r\n\r\n'
    );
    first.socket.end();
    await first.closed;
    const second = await ask(
      h.proxy.port,
      'CONNECT api.example.com:443 HTTP/1.1\r\n\r\n'
    );
    expect(status(second)).toBe(403);
    const third = await opened(
      h.proxy.port,
      'CONNECT api.example.com:443 HTTP/1.1\r\n\r\n'
    );
    third.socket.end();
    await third.closed;

    expect(h.resolved).toEqual([
      'api.example.com',
      'api.example.com',
      'api.example.com',
    ]);
    // The dialler is handed addresses, never the name to look up again.
    expect(h.dialled).toEqual([`${PUBLIC}:443`, `${PUBLIC}:443`]);
  });

  test('an answer that holds or hides a non-public address anywhere is refused, and nothing is dialled', async () => {
    const answers: string[][] = [
      [PUBLIC, '10.0.0.5'],
      ['10.0.0.5', PUBLIC],
      [PUBLIC, PUBLIC6, 'fd00::1'],
      ['::ffff:10.0.0.5'],
      ['::ffff:a00:5'],
      ['::ffff:0:a00:5'],
      ['64:ff9b::a00:5'],
      ['64:ff9b::10.0.0.5'],
      ['64:ff9b:1::1'],
      ['2002:a00:5::1'],
      ['2002:7f00:1::1'],
      ['2001:0:4136:e378:8000:63bf:3fff:fdd2'],
      ['::a00:5'],
      ['::10.0.0.5'],
      ['fe80::1%eth0'],
      ['fec0::1'],
      ['ff02::1'],
      ['::'],
      ['::1'],
      ['0.0.0.0'],
      ['127.0.0.53'],
      ['169.254.169.254'],
      ['172.17.0.1'],
      ['100.64.0.1'],
      ['198.18.0.1'],
      ['192.0.0.8'],
      ['224.0.0.251'],
      ['255.255.255.255'],
      ['localhost'],
      ['gateway'],
      [''],
      ['010.0.0.5'],
      ['1.2.3'],
    ];
    const results: [string[], number][] = [];
    let current: string[] = [];
    const h = await harness(ALLOWED, () => current);
    for (const answer of answers) {
      current = answer;
      results.push([
        answer,
        status(
          await ask(
            h.proxy.port,
            'CONNECT api.example.com:443 HTTP/1.1\r\n\r\n'
          )
        ),
      ]);
    }
    expect(results).toEqual(answers.map((answer) => [answer, 403]));
    expect(h.dialled).toEqual([]);
    expect(h.target.received).toEqual([]);
  });

  test('a lookup that never answers ends in 502 within the connect time, and frees its tunnel', async () => {
    const h = await harness(
      ALLOWED,
      () => new Promise<string[]>(() => undefined),
      {
        connectMs: 100,
        maxTunnels: 1,
      }
    );
    const answer = await ask(
      h.proxy.port,
      'CONNECT api.example.com:443 HTTP/1.1\r\n\r\n'
    );
    expect(status(answer)).toBe(502);
    await eventually(() => h.proxy.active() === 0);
    expect(h.dialled).toEqual([]);
  });
});

describe('listed IPv6 literals and slow heads', () => {
  // The allow-list takes `[v6]:port`. The system resolver (node:dns lookup)
  // answers ENOTFOUND for `[2001:db8::10]` and answers `2001:db8::10` with
  // itself, which this resolver repeats: a listed IPv6 literal opens a
  // tunnel to that address only if the brackets never reach the resolver.
  test('a listed public IPv6 literal is tunnelled to that address', async () => {
    const systemLike: Resolve = async (host) => {
      if (isIP(host) === 0) {
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
          code: 'ENOTFOUND',
        });
      }
      return [host];
    };
    const h = await harness(`[${PUBLIC6}]:443`, (host) => systemLike(host));
    const c = await client(h.proxy.port);
    c.socket.write(`CONNECT [${PUBLIC6}]:443 HTTP/1.1\r\n\r\n`);
    await c.until((text) => text.includes('\r\n\r\n'));
    expect(status(c.text())).toBe(200);
    expect(h.dialled).toEqual([`${PUBLIC6}:443`]);
  });

  // A head that completes during the 400's linger must not be routed: the
  // allowed host would be resolved and dialled for a request already
  // refused, and the bytes after the head would reach it.
  test('a request answered 400 for a slow head is never routed', async () => {
    const h = await harness(ALLOWED, () => [PUBLIC], { headMs: 100 });
    const c = await client(h.proxy.port, true);
    c.socket.write('CONNECT api.example.com:443 HTTP/1.1\r\n');
    await c.until((text) => status(text) === 400);
    c.socket.write('\r\nlate bytes');
    await sleep(300);
    expect(h.resolved).toEqual([]);
    expect(h.dialled).toEqual([]);
    expect(h.target.received).toEqual([]);
  });
});
