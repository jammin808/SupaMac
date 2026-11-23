// The jobs service's only way out (docs/supamac/jobs.md, Security): an HTTP
// CONNECT forward proxy on the `jobs` network, which has no route out, and
// the `egress` network, which has.
//
// What must stay true:
// - A tunnel opens only for `CONNECT <host>:<port>` whose host and port are
//   an entry of the allow-list (JOBS_EGRESS_ALLOW, comma-separated
//   `host:port`): the host compared exactly, ignoring case, with no
//   wildcards; an IP literal only where the list names it. Every other
//   request (a plain HTTP request in any form, another method, another host
//   or port) is answered 403 and the connection closed. `GET /health` is
//   the one other request answered, with 200, for the compose health check.
// - The proxy resolves an allowed name itself and dials the address it
//   checked, never the name again; a listed IP literal is dialled as
//   written, without a lookup. A name with any address that is private,
//   loopback, link-local or otherwise not a public unicast address
//   (`forbiddenAddress`) is refused with 403, so DNS cannot point an allowed
//   name inside the stack or the VPS. A listed IP literal is held to the
//   same rule.
// - A tunnel ends when either side closes, after IDLE_MS with no byte
//   either way, or after TOTAL_MS whatever flows. At most MAX_TUNNELS are
//   open or being opened at once; one more is answered 503. A request head
//   over HEAD_MAX_BYTES, or not complete within HEAD_MS, is answered 400,
//   and nothing the client sends after it is read as a request.
// - One JSON line per request on stdout: host, port, outcome, byte counts
//   each way and duration. Never a byte of payload or a header.
//
// The defaults leave room for the jobs service's own connections: the
// mailbox's IMAP connection stays open between polls and imapflow drops it
// after five idle minutes itself, Telegram's long poll waits 50 seconds,
// and a model reply streams for minutes.

import { lookup } from 'node:dns/promises';
import {
  connect,
  createServer,
  isIP,
  type Server,
  type Socket,
} from 'node:net';

export const DEFAULT_PORT = 3128;
export const MAX_TUNNELS = 32;
export const IDLE_MS = 10 * 60_000;
export const TOTAL_MS = 60 * 60_000;
export const HEAD_MS = 10_000;
export const CONNECT_MS = 15_000;
export const HEAD_MAX_BYTES = 8 * 1024;
export const ANSWER_LINGER_MS = 2_000;

/** Every address `host` resolves to. */
export type Resolve = (host: string) => Promise<string[]>;
/** A socket connecting to `address:port`; it emits `connect` or `error`. */
export type Dial = (address: string, port: number) => Socket;
export type LogLine = Record<string, string | number>;

/** `host:port` keys, the host lower-cased (an IPv6 literal in brackets). */
export type AllowList = ReadonlySet<string>;

export type ProxyOptions = {
  allow: AllowList;
  /** Where to listen; port 0 picks a free one. */
  port?: number;
  host?: string;
  resolve?: Resolve;
  dial?: Dial;
  log?: (line: LogLine) => void;
  maxTunnels?: number;
  idleMs?: number;
  totalMs?: number;
  headMs?: number;
  connectMs?: number;
};

export type EgressProxy = {
  port: number;
  /** Tunnels open or being opened. */
  active(): number;
  /** Stops listening and ends every connection. */
  close(): Promise<void>;
};

const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DNS_NAME = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})*$`);

function validHost(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) {
    return isIP(host.slice(1, -1)) === 6;
  }
  return isIP(host) === 4 || (host.length <= 253 && DNS_NAME.test(host));
}

/** `host:port` as a request or the allow-list writes it, or undefined. */
export function parseAuthority(
  text: string
): { host: string; port: number } | undefined {
  const match = /^(\[[0-9A-Fa-f:.]+\]|[^\s:[\]/@]+):(\d{1,5})$/.exec(text);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const host = match[1].toLowerCase();
  const port = Number(match[2]);
  if (port < 1 || port > 65535 || !validHost(host)) {
    return undefined;
  }
  return { host, port };
}

/**
 * The allow-list from JOBS_EGRESS_ALLOW. Blank entries are skipped; any
 * other entry that is not `host:port` (a wildcard, a URL, a missing or
 * out-of-range port) throws, naming the entry.
 */
export function parseAllowList(text: string): AllowList {
  const entries = new Set<string>();
  for (const raw of text.split(',')) {
    const entry = raw.trim();
    if (entry === '') {
      continue;
    }
    const authority = parseAuthority(entry);
    if (!authority) {
      throw new Error(
        `JOBS_EGRESS_ALLOW: "${entry}" is not host:port (an exact host name or IP literal, no wildcard, and a port from 1 to 65535)`
      );
    }
    entries.add(`${authority.host}:${authority.port}`);
  }
  if (entries.size === 0) {
    throw new Error('JOBS_EGRESS_ALLOW names no host:port');
  }
  return entries;
}

function ipv4Value(text: string): number | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) {
    return undefined;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) {
      return undefined;
    }
    value = value * 256 + Number(part);
  }
  return value;
}

/** The eight 16-bit groups of an IPv6 address, or undefined. */
function ipv6Groups(text: string): number[] | undefined {
  let s = text.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) {
    s = s.slice(0, zone);
  }
  // A dotted IPv4 tail becomes two groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4Value(tail);
    if (v4 === undefined) {
      return undefined;
    }
    s = `${s.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) {
    return undefined;
  }
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    return undefined;
  }
  const groups = [...head, ...Array(missing).fill('0'), ...rest];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return undefined;
  }
  return groups.map((group) => Number.parseInt(group, 16));
}

const IPV4_FORBIDDEN: [base: string, prefix: number, why: string][] = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'shared'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'special'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

function ipv4Forbidden(value: number): string | undefined {
  for (const [base, prefix, why] of IPV4_FORBIDDEN) {
    const size = 2 ** (32 - prefix);
    const start = ipv4Value(base) ?? 0;
    if (value >= start && value < start + size) {
      return why;
    }
  }
  return undefined;
}

/**
 * Why an address must not be dialled, or undefined for a public unicast
 * address. IPv6 is public only inside 2000::/3; an IPv6 address that
 * carries an IPv4 one (mapped, translated, NAT64, 6to4) is judged by the
 * IPv4 address. Anything that does not parse is forbidden.
 */
export function forbiddenAddress(address: string): string | undefined {
  const v4 = ipv4Value(address);
  if (v4 !== undefined) {
    return ipv4Forbidden(v4);
  }
  const g = ipv6Groups(address);
  if (!g) {
    return 'not an IP address';
  }
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const embedded = g6 * 65536 + g7;
  const zeroTo = (end: number): boolean =>
    g.slice(0, end).every((group) => group === 0);
  if (zeroTo(8)) {
    return 'unspecified';
  }
  if (zeroTo(7) && g7 === 1) {
    return 'loopback';
  }
  if (
    zeroTo(4) &&
    ((g4 === 0 && g5 === 0xffff) || (g4 === 0xffff && g5 === 0))
  ) {
    return ipv4Forbidden(embedded);
  }
  if (g0 === 0x64 && g1 === 0xff9b) {
    return g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0
      ? ipv4Forbidden(embedded)
      : 'nat64 local use';
  }
  if ((g0 & 0xfe00) === 0xfc00) {
    return 'unique-local';
  }
  if ((g0 & 0xffc0) === 0xfe80) {
    return 'link-local';
  }
  if ((g0 & 0xff00) === 0xff00) {
    return 'multicast';
  }
  if ((g0 & 0xe000) !== 0x2000) {
    return 'not global unicast';
  }
  if (g0 === 0x2001 && g1 === 0) {
    return 'teredo';
  }
  if (g0 === 0x2002) {
    return ipv4Forbidden(g1 * 65536 + g2);
  }
  return undefined;
}

async function systemResolve(host: string): Promise<string[]> {
  const answers = await lookup(host, { all: true });
  return answers.map((answer) => answer.address);
}

function systemDial(address: string, port: number): Socket {
  return connect({ host: address, port });
}

function writeLog(line: LogLine): void {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      service: 'jobs-egress',
      ...line,
    })
  );
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  400: 'Bad Request',
  403: 'Forbidden',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/**
 * Answers and closes. What the client still sends is read and dropped until
 * it closes too, or for ANSWER_LINGER_MS, so that closing does not reset the
 * connection before the client has read the answer.
 */
function answer(socket: Socket, status: number, body: string): void {
  const text = `${body}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`
  );
  socket.on('data', () => undefined);
  socket.resume();
  const timer = setTimeout(() => socket.destroy(), ANSWER_LINGER_MS);
  socket.once('close', () => clearTimeout(timer));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** Dials the first address that answers within `ms`, IPv4 first. */
async function dialFirst(
  dial: Dial,
  addresses: string[],
  port: number,
  ms: number
): Promise<{ socket: Socket; address: string }> {
  const ordered = [
    ...addresses.filter((address) => isIP(address) === 4),
    ...addresses.filter((address) => isIP(address) !== 4),
  ];
  for (const address of ordered) {
    const socket = dial(address, port);
    const connected = await new Promise<boolean>((settle) => {
      const timer = setTimeout(() => done(false), ms);
      const onConnect = (): void => done(true);
      const onError = (): void => done(false);
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('error', onError);
        if (!ok) {
          // Errors after the attempt is given up are of no interest.
          socket.on('error', () => undefined);
          socket.destroy();
        }
        settle(ok);
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
    if (connected) {
      return { socket, address };
    }
  }
  throw new Error('no address answered');
}

export function startEgressProxy(options: ProxyOptions): Promise<EgressProxy> {
  const resolve = options.resolve ?? systemResolve;
  const dial = options.dial ?? systemDial;
  const log = options.log ?? writeLog;
  const maxTunnels = options.maxTunnels ?? MAX_TUNNELS;
  const idleMs = options.idleMs ?? IDLE_MS;
  const totalMs = options.totalMs ?? TOTAL_MS;
  const headMs = options.headMs ?? HEAD_MS;
  const connectMs = options.connectMs ?? CONNECT_MS;
  // Clients still sending their head count too, so one that opens many
  // and sends nothing cannot hold the process's sockets, while a full table
  // of tunnels still leaves room for the health check.
  const maxClients = maxTunnels * 2;

  let tunnels = 0;
  const clients = new Set<Socket>();
  const upstreams = new Set<Socket>();

  const tunnel = async (
    client: Socket,
    host: string,
    port: number,
    early: Buffer
  ): Promise<void> => {
    const started = Date.now();
    let closed = false;
    client.once('close', () => {
      closed = true;
    });

    // An IP literal is its own address: it is never handed to the resolver,
    // which answers a bracketed IPv6 literal with "not found".
    const literal = host.startsWith('[')
      ? host.slice(1, -1)
      : isIP(host) === 4
        ? host
        : undefined;
    let addresses: string[];
    try {
      addresses =
        literal === undefined
          ? await withTimeout(resolve(host), connectMs)
          : [literal];
    } catch {
      log({ host, port, outcome: 'refused', reason: 'not resolved' });
      answer(client, 502, 'the host did not resolve');
      return;
    }
    if (addresses.length === 0) {
      log({ host, port, outcome: 'refused', reason: 'not resolved' });
      answer(client, 502, 'the host did not resolve');
      return;
    }
    for (const address of addresses) {
      const why = forbiddenAddress(address);
      if (why !== undefined) {
        log({
          host,
          port,
          outcome: 'refused',
          reason: 'address not public',
          address,
          kind: why,
        });
        answer(
          client,
          403,
          'the host resolves to an address that is not public'
        );
        return;
      }
    }

    let upstream: Socket;
    let address: string;
    try {
      ({ socket: upstream, address } = await dialFirst(
        dial,
        addresses,
        port,
        connectMs
      ));
    } catch {
      log({ host, port, outcome: 'refused', reason: 'not reachable' });
      answer(client, 502, 'the host did not answer');
      return;
    }
    if (closed) {
      upstream.destroy();
      log({ host, port, outcome: 'client gone', bytesUp: 0, bytesDown: 0 });
      return;
    }
    upstreams.add(upstream);

    let bytesUp = 0;
    let bytesDown = 0;
    let finished = false;
    const finish = (outcome: string): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(idle);
      clearTimeout(total);
      client.destroy();
      upstream.destroy();
      upstreams.delete(upstream);
      log({
        host,
        port,
        address,
        outcome,
        bytesUp,
        bytesDown,
        ms: Date.now() - started,
      });
    };
    const idle = setTimeout(() => finish('idle timeout'), idleMs);
    const total = setTimeout(() => finish('total timeout'), totalMs);

    client.on('data', (chunk: Buffer) => {
      bytesUp += chunk.length;
      idle.refresh();
      if (!upstream.write(chunk)) {
        client.pause();
      }
    });
    upstream.on('data', (chunk: Buffer) => {
      bytesDown += chunk.length;
      idle.refresh();
      if (!client.write(chunk)) {
        upstream.pause();
      }
    });
    upstream.on('drain', () => client.resume());
    client.on('drain', () => upstream.resume());
    // A side that ends its half is passed on, so a TLS close reaches the
    // other end; the tunnel is over when both sockets are closed.
    client.on('end', () => upstream.end());
    upstream.on('end', () => client.end());
    client.on('close', () => {
      if (upstream.destroyed || upstream.writableEnded) {
        finish('closed');
      } else {
        upstream.end();
      }
    });
    upstream.on('close', () => {
      if (client.destroyed || client.writableEnded) {
        finish('closed');
      } else {
        client.end();
      }
    });
    client.on('error', () => finish('error'));
    upstream.on('error', () => finish('error'));

    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (early.length > 0) {
      bytesUp += early.length;
      upstream.write(early);
    }
    client.resume();
  };

  const handle = (client: Socket): void => {
    if (clients.size >= maxClients) {
      client.destroy();
      return;
    }
    clients.add(client);
    client.once('close', () => clients.delete(client));
    client.on('error', () => client.destroy());

    let head = Buffer.alloc(0);
    const headTimer = setTimeout(() => {
      // The reader goes first: a head completed during the answer's linger
      // is never routed.
      stop();
      log({ outcome: 'refused', reason: 'head timeout' });
      answer(client, 400, 'the request head did not arrive in time');
    }, headMs);

    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > HEAD_MAX_BYTES) {
          stop();
          log({ outcome: 'refused', reason: 'head too large' });
          answer(client, 400, 'the request head is too large');
        }
        return;
      }
      stop();
      if (end > HEAD_MAX_BYTES) {
        log({ outcome: 'refused', reason: 'head too large' });
        answer(client, 400, 'the request head is too large');
        return;
      }
      route(
        client,
        head.subarray(0, end).toString('latin1'),
        head.subarray(end + 4)
      );
    };
    const stop = (): void => {
      clearTimeout(headTimer);
      client.off('data', onData);
      client.pause();
    };
    client.once('close', () => clearTimeout(headTimer));
    client.on('data', onData);
  };

  const route = (client: Socket, head: string, early: Buffer): void => {
    const line = head.split('\r\n', 1)[0] ?? '';
    const request = /^([A-Z]{1,16}) (\S{1,2048}) HTTP\/1\.[01]$/.exec(line);
    if (!request?.[1] || !request[2]) {
      log({ outcome: 'refused', reason: 'not an HTTP request' });
      answer(client, 400, 'not an HTTP/1.1 request');
      return;
    }
    const [, method, target] = request;
    if (method === 'GET' && target === '/health') {
      answer(client, 200, 'ok');
      return;
    }
    if (method !== 'CONNECT') {
      log({ method, outcome: 'refused', reason: 'not CONNECT' });
      answer(client, 403, 'only CONNECT to an allowed host is served');
      return;
    }
    const authority = parseAuthority(target);
    if (!authority) {
      log({ method, outcome: 'refused', reason: 'not host:port' });
      answer(client, 403, 'only CONNECT to an allowed host is served');
      return;
    }
    const { host, port } = authority;
    if (!options.allow.has(`${host}:${port}`)) {
      log({ host, port, outcome: 'refused', reason: 'not allowed' });
      answer(client, 403, 'only CONNECT to an allowed host is served');
      return;
    }
    if (tunnels >= maxTunnels) {
      log({ host, port, outcome: 'refused', reason: 'too many tunnels' });
      answer(client, 503, 'too many tunnels are open');
      return;
    }
    tunnels += 1;
    let released = false;
    const release = (): void => {
      if (!released) {
        released = true;
        tunnels -= 1;
      }
    };
    client.once('close', release);
    tunnel(client, host, port, early).catch(() => {
      log({ host, port, outcome: 'error' });
      client.destroy();
    });
  };

  const server: Server = createServer(handle);
  return new Promise((ready, fail) => {
    server.once('error', fail);
    server.listen(
      options.port ?? DEFAULT_PORT,
      options.host ?? '0.0.0.0',
      () => {
        server.off('error', fail);
        const bound = server.address();
        const port = typeof bound === 'object' && bound ? bound.port : 0;
        ready({
          port,
          active: () => tunnels,
          close: () =>
            new Promise<void>((done) => {
              for (const socket of [...clients, ...upstreams]) {
                socket.destroy();
              }
              server.close(() => done());
            }),
        });
      }
    );
  });
}

function listenPort(text: string | undefined): number {
  if (text === undefined || text.trim() === '') {
    return DEFAULT_PORT;
  }
  const port = Number(text);
  if (!/^\d{1,5}$/.test(text.trim()) || port < 1 || port > 65535) {
    throw new Error('JOBS_EGRESS_PORT must be a port from 1 to 65535');
  }
  return port;
}

if (import.meta.main) {
  try {
    const allow = parseAllowList(process.env.JOBS_EGRESS_ALLOW ?? '');
    const proxy = await startEgressProxy({
      allow,
      port: listenPort(process.env.JOBS_EGRESS_PORT),
    });
    writeLog({
      outcome: 'listening',
      port: proxy.port,
      allow: [...allow].join(','),
    });
    const stop = (): void => {
      proxy.close().then(() => writeLog({ outcome: 'stopped' }));
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch (error) {
    writeLog({
      outcome: 'not started',
      reason: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}
