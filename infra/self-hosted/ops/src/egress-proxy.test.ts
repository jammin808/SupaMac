// The egress proxy is the jobs service's only way out, so what it refuses
// matters as much as what it carries. Every test below talks to it over real
// sockets on 127.0.0.1; the allowed upstream is a local server, reached
// through an injected resolver and dialler so the rule against private
// addresses can be seen holding and letting through.

import { afterEach, describe, expect, test } from 'bun:test';
import { connect, createServer, type Server, type Socket } from 'node:net';
import {
  type Dial,
  type EgressProxy,
  forbiddenAddress,
  type LogLine,
  type ProxyOptions,
  parseAllowList,
  parseAuthority,
  startEgressProxy,
} from './egress-proxy';

// A public address from the documentation range: never dialled, only
// checked; the test dialler connects it to the local upstream.
const PUBLIC = '203.0.113.10';

type Upstream = {
  port: number;
  connections: number;
  received: Buffer[];
  server: Server;
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A TCP server that answers every chunk with the chunk in upper case. */
async function upstream(): Promise<Upstream> {
  const state: Upstream = {
    port: 0,
    connections: 0,
    received: [],
    server: createServer((socket) => {
      state.connections += 1;
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

/** Dials `PUBLIC` as the local upstream, and records each address asked for. */
function localDial(target: Upstream, dialled: string[]): Dial {
  return (address) => {
    dialled.push(address);
    return connect({ host: '127.0.0.1', port: target.port });
  };
}

async function proxy(
  options: Partial<ProxyOptions> & Pick<ProxyOptions, 'allow'>,
  logs: LogLine[]
): Promise<EgressProxy> {
  const started = await startEgressProxy({
    port: 0,
    host: '127.0.0.1',
    log: (line) => logs.push(line),
    ...options,
  });
  cleanups.push(() => started.close());
  return started;
}

type Client = {
  socket: Socket;
  text(): string;
  /** Resolves when what arrived so far satisfies `done`. */
  until(done: (text: string) => boolean, ms?: number): Promise<string>;
  closed: Promise<void>;
};

function client(port: number): Promise<Client> {
  return new Promise((ready, fail) => {
    const socket = connect({ host: '127.0.0.1', port });
    let text = '';
    const waiters: (() => void)[] = [];
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('latin1');
      for (const wake of waiters.splice(0)) {
        wake();
      }
    });
    socket.on('error', () => undefined);
    const closed = new Promise<void>((done) => socket.once('close', done));
    closed.then(() => {
      for (const wake of waiters.splice(0)) {
        wake();
      }
    });
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

/** Sends one request head and reads the whole answer until the proxy closes. */
async function ask(port: number, head: string): Promise<string> {
  const c = await client(port);
  c.socket.write(head);
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

describe('the allow-list', () => {
  test('is exact host:port entries, lower-cased, blank entries skipped', () => {
    const allow = parseAllowList(
      ' api.anthropic.com:443, API.Telegram.org:443,,imap.example.com:993 ,'
    );
    expect([...allow]).toEqual([
      'api.anthropic.com:443',
      'api.telegram.org:443',
      'imap.example.com:993',
    ]);
  });

  test('takes IP literals only as written', () => {
    expect([...parseAllowList('192.0.2.7:993,[2001:db8::1]:443')]).toEqual([
      '192.0.2.7:993',
      '[2001:db8::1]:443',
    ]);
  });

  test('refuses wildcards, URLs, missing or out-of-range ports, and nothing at all', () => {
    for (const entry of [
      '*.example.com:443',
      'example.*:443',
      '.example.com:443',
      'https://api.example.com:443',
      'api.example.com',
      'api.example.com:',
      'api.example.com:0',
      'api.example.com:65536',
      'api.example.com:443/path',
      'user@api.example.com:443',
      'api example.com:443',
      '2001:db8::1:443',
      '[not-an-address]:443',
    ]) {
      expect(() => parseAllowList(entry)).toThrow('JOBS_EGRESS_ALLOW');
    }
    expect(() => parseAllowList('')).toThrow('names no host:port');
    expect(() => parseAllowList(' , ')).toThrow('names no host:port');
  });

  test('reads a CONNECT target the same way', () => {
    expect(parseAuthority('Api.Example.COM:443')).toEqual({
      host: 'api.example.com',
      port: 443,
    });
    expect(parseAuthority('[2001:DB8::1]:993')).toEqual({
      host: '[2001:db8::1]',
      port: 993,
    });
    expect(parseAuthority('api.example.com')).toBeUndefined();
    expect(parseAuthority('/health')).toBeUndefined();
  });
});

describe('addresses', () => {
  test('private, loopback, link-local and other special ones are forbidden', () => {
    const forbidden: [string, string][] = [
      ['0.0.0.0', 'unspecified'],
      ['10.1.2.3', 'private'],
      ['100.64.0.1', 'shared'],
      ['127.0.0.1', 'loopback'],
      ['127.255.255.254', 'loopback'],
      ['169.254.169.254', 'link-local'],
      ['172.16.0.1', 'private'],
      ['172.31.255.255', 'private'],
      ['192.0.0.8', 'special'],
      ['192.168.1.1', 'private'],
      ['198.18.0.1', 'benchmarking'],
      ['224.0.0.1', 'multicast'],
      ['255.255.255.255', 'reserved'],
      ['::', 'unspecified'],
      ['::1', 'loopback'],
      ['::ffff:127.0.0.1', 'loopback'],
      ['::ffff:a00:1', 'private'],
      ['::ffff:0:192.168.0.1', 'private'],
      ['::127.0.0.1', 'not global unicast'],
      ['64:ff9b::10.0.0.1', 'private'],
      ['64:ff9b:1::1', 'nat64 local use'],
      ['fc00::1', 'unique-local'],
      ['fd12:3456::1', 'unique-local'],
      ['fe80::1', 'link-local'],
      ['fe80::1%eth0', 'link-local'],
      ['fec0::1', 'not global unicast'],
      ['ff02::1', 'multicast'],
      ['100::1', 'not global unicast'],
      ['2001:0:4136:e378::1', 'teredo'],
      ['2002:7f00:1::1', 'loopback'],
      ['2002:c0a8:101::1', 'private'],
      ['not-an-address', 'not an IP address'],
      ['1.2.3', 'not an IP address'],
      ['1:2:3:4:5:6:7:8:9', 'not an IP address'],
    ];
    expect(
      forbidden.map(([address]) => [address, forbiddenAddress(address)])
    ).toEqual(forbidden);
  });

  test('public unicast ones pass, up to the edges of the forbidden ranges', () => {
    for (const address of [
      PUBLIC,
      '192.0.2.1',
      '198.51.100.7',
      '9.255.255.255',
      '11.0.0.0',
      '100.63.255.255',
      '100.128.0.0',
      '172.15.255.255',
      '172.32.0.0',
      '192.167.255.255',
      '192.169.0.0',
      '223.255.255.255',
      '2001:db8::1',
      '::ffff:203.0.113.10',
      '64:ff9b::203.0.113.10',
      '2002:cb00:710a::1',
    ]) {
      expect([address, forbiddenAddress(address)]).toEqual([
        address,
        undefined,
      ]);
    }
  });
});

describe('the proxy', () => {
  test('tunnels bytes both ways to an allowed host, dialling the address it checked', async () => {
    const target = await upstream();
    const dialled: string[] = [];
    const resolved: string[] = [];
    const logs: LogLine[] = [];
    const p = await proxy(
      {
        allow: parseAllowList(`upstream.example.com:${target.port}`),
        resolve: async (host) => {
          resolved.push(host);
          return [PUBLIC];
        },
        dial: localDial(target, dialled),
      },
      logs
    );

    const c = await client(p.port);
    // Bytes sent with the head, before the answer, go through too.
    c.socket.write(
      `CONNECT Upstream.Example.COM:${target.port} HTTP/1.1\r\nHost: upstream.example.com:${target.port}\r\nProxy-Authorization: Basic c2VjcmV0\r\n\r\nhello`
    );
    await c.until((text) => text.endsWith('HELLO'));
    expect(c.text()).toBe('HTTP/1.1 200 Connection Established\r\n\r\nHELLO');
    c.socket.write(' world');
    await c.until((text) => text.endsWith('HELLO WORLD'));
    expect(p.active()).toBe(1);

    c.socket.end();
    await c.closed;
    await eventually(() => logs.length === 1);

    expect(resolved).toEqual(['upstream.example.com']);
    expect(dialled).toEqual([PUBLIC]);
    expect(Buffer.concat(target.received).toString()).toBe('hello world');
    expect(p.active()).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      host: 'upstream.example.com',
      port: target.port,
      address: PUBLIC,
      outcome: 'closed',
      bytesUp: 11,
      bytesDown: 11,
    });
    // Neither payload nor headers reach the log.
    const logged = JSON.stringify(logs);
    for (const secret of ['hello', 'HELLO', 'world', 'c2VjcmV0', 'Basic']) {
      expect(logged).not.toContain(secret);
    }
  });

  test('refuses an allowed name that resolves to a private address, and dials nothing', async () => {
    const target = await upstream();
    for (const addresses of [
      ['127.0.0.1'],
      ['10.0.0.5'],
      [PUBLIC, '172.18.0.4'],
      ['::ffff:127.0.0.1'],
      ['fd00::5'],
    ]) {
      const dialled: string[] = [];
      const logs: LogLine[] = [];
      const p = await proxy(
        {
          allow: parseAllowList(`upstream.example.com:${target.port}`),
          resolve: async () => addresses,
          dial: localDial(target, dialled),
        },
        logs
      );
      const answer = await ask(
        p.port,
        `CONNECT upstream.example.com:${target.port} HTTP/1.1\r\n\r\n`
      );
      expect([addresses, status(answer)]).toEqual([addresses, 403]);
      expect(dialled).toEqual([]);
      expect(logs[0]).toMatchObject({
        outcome: 'refused',
        reason: 'address not public',
      });
      await eventually(() => p.active() === 0);
    }
    expect(target.connections).toBe(0);
  });

  test('refuses a private address with the real dialler too', async () => {
    const target = await upstream();
    const logs: LogLine[] = [];
    // Listed by its own address, which is loopback: still refused.
    const p = await proxy(
      { allow: parseAllowList(`127.0.0.1:${target.port}`) },
      logs
    );
    const answer = await ask(
      p.port,
      `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\n\r\n`
    );
    expect(status(answer)).toBe(403);
    expect(target.connections).toBe(0);
    expect(logs[0]).toMatchObject({
      host: '127.0.0.1',
      reason: 'address not public',
      kind: 'loopback',
    });
  });

  test('refuses every request that is not CONNECT to an allowed host and port', async () => {
    const target = await upstream();
    const dialled: string[] = [];
    const logs: LogLine[] = [];
    const p = await proxy(
      {
        allow: parseAllowList(`upstream.example.com:${target.port}`),
        resolve: async () => [PUBLIC],
        dial: localDial(target, dialled),
      },
      logs
    );
    const port = target.port;
    const refused = [
      // Another host, a longer or shorter name, another port.
      `CONNECT other.example.com:${port} HTTP/1.1\r\n\r\n`,
      `CONNECT upstream.example.com.evil.example:${port} HTTP/1.1\r\n\r\n`,
      `CONNECT example.com:${port} HTTP/1.1\r\n\r\n`,
      `CONNECT upstream.example.com:${port + 1} HTTP/1.1\r\n\r\n`,
      `CONNECT upstream.example.com HTTP/1.1\r\n\r\n`,
      // The address the allowed name resolves to, as a literal.
      `CONNECT ${PUBLIC}:${port} HTTP/1.1\r\n\r\n`,
      `CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`,
      // Plain HTTP, in absolute and origin form, and other methods.
      `GET http://upstream.example.com:${port}/ HTTP/1.1\r\nHost: upstream.example.com\r\n\r\n`,
      'GET / HTTP/1.1\r\nHost: upstream.example.com\r\n\r\n',
      'POST /health HTTP/1.1\r\nContent-Length: 0\r\n\r\n',
      'HEAD /health HTTP/1.1\r\n\r\n',
      `OPTIONS upstream.example.com:${port} HTTP/1.1\r\n\r\n`,
    ];
    for (const head of refused) {
      const answer = await ask(p.port, head);
      expect([head, status(answer)]).toEqual([head, 403]);
    }
    expect(dialled).toEqual([]);
    expect(target.connections).toBe(0);
    expect(logs.map((line) => line.outcome)).toEqual(
      refused.map(() => 'refused')
    );
    await eventually(() => p.active() === 0);
  });

  test('answers 400 to what is not an HTTP/1 request head', async () => {
    const p = await proxy({ allow: parseAllowList('api.example.com:443') }, []);
    for (const head of [
      'CONNECT api.example.com:443 HTTP/2.0\r\n\r\n',
      'connect api.example.com:443 HTTP/1.1\r\n\r\n',
      '\x16\x03\x01\x02\x00\x01\x00\x01\xfc\r\n\r\n',
    ]) {
      expect(status(await ask(p.port, head))).toBe(400);
    }
  });

  test('answers GET /health with 200 and logs nothing for it', async () => {
    const logs: LogLine[] = [];
    const p = await proxy(
      { allow: parseAllowList('api.example.com:443') },
      logs
    );
    const answer = await ask(
      p.port,
      'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'
    );
    expect(status(answer)).toBe(200);
    expect(answer.endsWith('\r\n\r\nok\n')).toBe(true);
    expect(logs).toEqual([]);
  });

  test('answers 502 when the name does not resolve or no address answers', async () => {
    const closed = await upstream();
    const closedPort = closed.port;
    await new Promise<void>((done) => closed.server.close(() => done()));
    const logs: LogLine[] = [];
    const p = await proxy(
      {
        allow: parseAllowList('gone.example.com:443,down.example.com:443'),
        resolve: async (host) => {
          if (host === 'gone.example.com') {
            throw new Error('ENOTFOUND');
          }
          return [PUBLIC];
        },
        dial: () => connect({ host: '127.0.0.1', port: closedPort }),
      },
      logs
    );
    expect(
      status(await ask(p.port, 'CONNECT gone.example.com:443 HTTP/1.1\r\n\r\n'))
    ).toBe(502);
    expect(
      status(await ask(p.port, 'CONNECT down.example.com:443 HTTP/1.1\r\n\r\n'))
    ).toBe(502);
    expect(logs.map((line) => line.reason)).toEqual([
      'not resolved',
      'not reachable',
    ]);
    await eventually(() => p.active() === 0);
  });

  test('holds at most the configured number of tunnels', async () => {
    const target = await upstream();
    const logs: LogLine[] = [];
    const p = await proxy(
      {
        allow: parseAllowList(`upstream.example.com:${target.port}`),
        resolve: async () => [PUBLIC],
        dial: localDial(target, []),
        maxTunnels: 1,
      },
      logs
    );
    const head = `CONNECT upstream.example.com:${target.port} HTTP/1.1\r\n\r\n`;

    const first = await client(p.port);
    first.socket.write(head);
    await first.until((text) => text.includes('200 Connection Established'));

    expect(status(await ask(p.port, head))).toBe(503);
    // The health check still answers while the table is full.
    expect(status(await ask(p.port, 'GET /health HTTP/1.1\r\n\r\n'))).toBe(200);

    first.socket.end();
    await first.closed;
    await eventually(() => p.active() === 0);
    const again = await client(p.port);
    again.socket.write(`${head}ping`);
    await again.until((text) => text.endsWith('PING'));
    expect(logs.map((line) => line.reason ?? line.outcome)).toEqual([
      'too many tunnels',
      'closed',
    ]);
  });

  test('ends a tunnel that carries nothing for the idle time', async () => {
    const target = await upstream();
    const logs: LogLine[] = [];
    const p = await proxy(
      {
        allow: parseAllowList(`upstream.example.com:${target.port}`),
        resolve: async () => [PUBLIC],
        dial: localDial(target, []),
        idleMs: 150,
      },
      logs
    );
    const c = await client(p.port);
    c.socket.write(
      `CONNECT upstream.example.com:${target.port} HTTP/1.1\r\n\r\nping`
    );
    await c.until((text) => text.endsWith('PING'));
    const before = Date.now();
    await c.closed;
    expect(Date.now() - before).toBeGreaterThanOrEqual(100);
    expect(logs[0]).toMatchObject({ outcome: 'idle timeout', bytesUp: 4 });
    await eventually(() => p.active() === 0);
  });

  test('ends a busy tunnel at the total time', async () => {
    const target = await upstream();
    const logs: LogLine[] = [];
    const p = await proxy(
      {
        allow: parseAllowList(`upstream.example.com:${target.port}`),
        resolve: async () => [PUBLIC],
        dial: localDial(target, []),
        idleMs: 1000,
        totalMs: 300,
      },
      logs
    );
    const c = await client(p.port);
    c.socket.write(
      `CONNECT upstream.example.com:${target.port} HTTP/1.1\r\n\r\n`
    );
    await c.until((text) => text.includes('200 Connection Established'));
    const ticker = setInterval(() => c.socket.write('x'), 40);
    await c.closed;
    clearInterval(ticker);
    expect(logs[0]?.outcome).toBe('total timeout');
    expect(logs[0]?.bytesUp).toBeGreaterThan(2);
  });

  test('answers 400 to a head that is too large or too slow', async () => {
    const logs: LogLine[] = [];
    const p = await proxy(
      { allow: parseAllowList('api.example.com:443'), headMs: 150 },
      logs
    );
    const large = await ask(
      p.port,
      `CONNECT api.example.com:443 HTTP/1.1\r\nX-Pad: ${'a'.repeat(9000)}`
    );
    expect(status(large)).toBe(400);

    const slow = await client(p.port);
    slow.socket.write('CONNECT api.example.com:443 HTTP/1.1\r\n');
    await slow.closed;
    expect(status(slow.text())).toBe(400);
    expect(logs.map((line) => line.reason)).toEqual([
      'head too large',
      'head timeout',
    ]);
  });
});
