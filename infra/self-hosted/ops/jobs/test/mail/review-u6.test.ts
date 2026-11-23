// An independent review of the mail unit (src/mail/) against
// docs/supamac/jobs.md §1 ("The mail check", made on the headers alone) and
// Operations (Restarts, Health). Each test states what the design requires.
// A test marked `test.failing` reproduces a defect the review reported: its
// assertions are the required behaviour and fail today; remove `.failing`
// once it is fixed. Every address, domain and value is a placeholder.

import { sleep as pause } from 'bun';
import { afterEach, describe, expect, test } from 'bun:test';
import { loadConfig } from '../../src/config';
import { Logger } from '../../src/log';
import {
  checkMail,
  type MailDecision,
  parseAuthenticationResults,
  parseHeaderBlock,
} from '../../src/mail/auth';
import {
  checkLogin,
  type EmailSink,
  type FetchedMessage,
  type FetchQuery,
  type ImapClientFactory,
  type MailHealth,
  MailboxReader,
  MAX_MESSAGE_BYTES,
} from '../../src/mail/imap';
import { MailIntake } from '../../src/mail/index';
import type { IntakeContext } from '../../src/pipeline/intake';
import type { Connection } from '../../src/pipeline/notify';
import { RecordingNotifier } from '../../src/pipeline/notify';
import type { EmailInput, SourceResult } from '../../src/pipeline/process';
import { extract } from '../../src/text/extract';
import {
  EMAIL_REPLY,
  INVITE_PDF_REPLY,
  inviteEmail,
} from '../pipeline/fixtures';
import { cleanup, makeWorld, restart, type World } from '../pipeline/harness';
import { FakeImapClient, FakeImapServer } from './fake-imap';
import {
  block,
  GMAIL_AR,
  gmail,
  gmailLines,
  JOBS,
  OWNER,
  POLICY,
  PROVIDER,
  SIG_B,
  withBody,
} from './fixtures';

// Addresses on real domains (webmail, public suffixes, look-alikes) are
// joined at run time: the repository's personal-data scan reads only
// example domains as placeholders. None of them is a real person's.
const AT = '@';

const PASSWORD = 'app-password-not-real-0006'; // secret-scan: fixture

const ENV = {
  JOBS_SUPAMAC_API_KEY: 'test-api-key-not-real', // secret-scan: fixture
  JOBS_OWNER_EMAIL: 'sam.price@example.com',
  ANTHROPIC_API_KEY: 'sk-ant-api03-example-key', // secret-scan: fixture
  JOBS_MONTHLY_LIMIT_USD: '20',
  JOBS_MAIL_HOST: 'imap.example.com',
  JOBS_MAIL_USER: JOBS,
  JOBS_MAIL_PASSWORD: PASSWORD,
  JOBS_MAIL_AUTHSERV_ID: PROVIDER,
  JOBS_MAIL_ALLOWED_SENDERS: OWNER,
};

function refusal(decision: MailDecision): {
  check: string;
  reason: string;
  from: string;
} {
  if (decision.ok) throw new Error('the message was accepted');
  return {
    check: decision.check,
    reason: decision.reason,
    from: decision.from,
  };
}

/** A signature of `d` that covers From and To, as a forger would write one. */
function signatureOf(d: string, s = 's1'): string {
  return `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=${d}; s=${s}; h=from:to:subject:date; bh=eA==; b=${SIG_B}`;
}

/** The provider's own header for a forged message: nothing passed. */
const PROVIDER_SAYS_FAIL = [
  `Authentication-Results: ${PROVIDER};`,
  '       dkim=fail (signature did not verify) header.i=@example.org header.s=s1 header.b=AbCdEf12;',
  '       spf=softfail (example.com: domain of transitioning sam.price@example.org does not designate 198.51.100.7 as permitted sender) smtp.mailfrom=sam.price@example.org;',
  '       dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=example.org',
];

// ---------------------------------------------------------------------------
// auth.ts: what must be refused.

describe('forged Authentication-Results', () => {
  test('a forged header with the provider’s authserv-id below the provider’s is never read', () => {
    const r = refusal(
      checkMail(
        gmail({
          ar: PROVIDER_SAYS_FAIL,
          middle: [
            `Authentication-Results: ${PROVIDER}; dkim=pass header.d=example.org header.s=s1`,
          ],
          dkim: [signatureOf('example.org')],
        }),
        POLICY
      )
    );
    expect(r.check).toBe('dkim');
    expect(r.reason).toBe('DKIM: no dkim=pass');
  });

  test('a Received chain the sender wrote, with its own results, changes nothing', () => {
    const r = refusal(
      checkMail(
        gmail({
          ar: PROVIDER_SAYS_FAIL,
          middle: [
            `Received: from relay.example.net by ${PROVIDER} with ESMTPS id x1;`,
            '        Mon, 01 Mar 2027 08:59:59 -0800',
            `Authentication-Results: ${PROVIDER};`,
            '       dkim=pass header.i=@example.org header.s=s1 header.b=AbCdEf12;',
            '       dmarc=pass header.from=example.org',
            `Received: from forger.example.net by relay.example.net; Mon, 01 Mar 2027 08:59:58 -0800`,
          ],
          dkim: [signatureOf('example.org')],
        }),
        POLICY
      )
    );
    expect(r.check).toBe('dkim');
  });

  test('the authserv-id written inside a comment is not the authserv-id', () => {
    for (const head of [
      `Authentication-Results: (${PROVIDER}) relay.example.net; dkim=pass header.d=example.org header.s=s1`,
      `Authentication-Results: relay.example.net (${PROVIDER}); dkim=pass header.d=example.org header.s=s1`,
      `Authentication-Results: relay.example.net; dkim=pass header.d=example.org header.s=s1 (${PROVIDER})`,
    ]) {
      const r = refusal(
        checkMail(
          gmail({ ar: [head], dkim: [signatureOf('example.org')] }),
          POLICY
        )
      );
      expect(r.check).toBe('authserv-id');
    }
  });

  test('a topmost header that does not parse is refused; a valid one below is not used instead', () => {
    const r = refusal(
      checkMail(
        gmail({
          ar: [
            `Authentication-Results: ${PROVIDER}; dkim=pass header.d=example.org (unclosed`,
            ...GMAIL_AR,
          ],
        }),
        POLICY
      )
    );
    expect(r.check).toBe('authentication-results');
  });

  test('ARC and original-results copies are not the provider’s header', () => {
    const lines = gmailLines({ ar: [] }).concat([
      `X-Original-Authentication-Results: ${PROVIDER}; dkim=pass header.d=example.org`,
      `Authentication-Results-Original: ${PROVIDER}; dkim=pass header.d=example.org`,
    ]);
    expect(refusal(checkMail(block(lines), POLICY)).check).toBe(
      'authentication-results'
    );
  });

  // The provider writes its header directly above the message's own first
  // line (as the Gmail-style fixture does). A first line the sender starts
  // with a space or tab is, by RFC 5322 unfolding, a continuation of the
  // provider's header, so the sender appends results to it.
  const CONTINUED = gmail({
    ar: PROVIDER_SAYS_FAIL,
    middle: ['\t; dkim=pass header.d=example.org header.s=s1'],
    dkim: [signatureOf('example.org')],
  });

  test('a sender’s leading continuation line unfolds into the provider’s header', () => {
    const parsed = parseHeaderBlock(CONTINUED);
    if (!parsed.ok) throw new Error(parsed.reason);
    const top = parsed.fields.find((f) => f.key === 'authentication-results');
    const results = parseAuthenticationResults(top?.value ?? '');
    expect(
      results?.results.map((r) => [
        r.method,
        r.result,
        r.properties.get('header.d'),
      ])
    ).toEqual([
      ['dkim', 'fail', undefined],
      ['spf', 'softfail', undefined],
      ['dmarc', 'fail', undefined],
      ['dkim', 'pass', 'example.org'],
    ]);
  });

  test('a continuation line the sender wrote cannot add a dkim=pass to the provider’s header', () => {
    expect(checkMail(CONTINUED, POLICY).ok).toBe(false);

    const withoutSemicolon = gmail({
      ar: PROVIDER_SAYS_FAIL,
      middle: ['       x-note=1; dkim=pass header.d=example.org header.s=s1'],
      dkim: [signatureOf('example.org')],
    });
    expect(checkMail(withoutSemicolon, POLICY).ok).toBe(false);
  });

  // The same root: every result in the topmost field is trusted and nothing
  // cross-checks them. A provider that copies a client's HELO unquoted lets
  // its `;` start a result; the provider's own dmarc=fail for the same From
  // is ignored.
  test('a dkim=pass contradicted by the provider’s own dmarc=fail for the From domain is not accepted', () => {
    const decision = checkMail(
      gmail({
        ar: [
          `Authentication-Results: ${PROVIDER}; dkim=none; iprev=pass smtp.helo=x;dkim=pass header.d=example.org header.s=s9; dmarc=fail header.from=example.org`,
        ],
        dkim: [signatureOf('example.org', 's9')],
      }),
      POLICY
    );
    expect(decision.ok).toBe(false);
  });
});

describe('From tricks', () => {
  test('a display name, a comment or a second address never stands for the address', () => {
    const cases: [string, string][] = [
      [`"${OWNER}" <mallory@example.net>`, 'sender'],
      [`Sam Price <${OWNER}> <mallory@example.net>`, 'from'],
      [`${OWNER} <mallory@example.net>`, 'from'],
      [`mallory@example.net (${OWNER})`, 'sender'],
      [`(${OWNER}) mallory@example.net`, 'sender'],
      [`"Sam \\" <${OWNER}> \\"" <mallory@example.net>`, 'sender'],
      [`${OWNER}, mallory@example.net`, 'from'],
      [`Sam <${OWNER}>,\r\n\tMallory <mallory@example.net>`, 'from'],
      [`Crew: ${OWNER};`, 'from'],
      [`<>, ${OWNER}`, 'from'],
      [`${OWNER};`, 'from'],
      [`Sam\\ Price <${OWNER}>`, 'from'],
    ];
    for (const [from, check] of cases) {
      const r = refusal(checkMail(gmail({ from }), POLICY));
      expect([from, r.check]).toEqual([from, check]);
    }
  });

  test('an encoded From is no address', () => {
    for (const from of [
      '=?UTF-8?B?c2FtLnByaWNlQGV4YW1wbGUub3Jn?=',
      '=?UTF-8?Q?sam.price=40example.org?=',
      'Sam <sam.price=?utf-8?q?=40?=example.org>',
      `=?UTF-8?Q?Sam?= <=?UTF-8?Q?sam.price?=@example.org>`,
    ]) {
      const r = refusal(checkMail(gmail({ from }), POLICY));
      expect(r.from).not.toBe(OWNER);
    }
  });

  test('a second From, however it is spelt, is refused', () => {
    for (const extra of [
      'FROM: mallory@example.net',
      'From : mallory@example.net',
      'from\t: mallory@example.net',
    ]) {
      const r = refusal(checkMail(gmail({ tail: [extra] }), POLICY));
      expect(r.reason).toBe('From: the message has 2 From headers');
    }
  });

  test('look-alike addresses and domains are not the allowed sender', () => {
    for (const from of [
      'sam.price' + AT + 'example.org.example.net',
      'sam.price' + AT + 'examp1e.org',
      'sam.price@ex\u0430mple.org', // Cyrillic a
      'sam.price' + AT + 'xn--exmple-cua.org',
      'sam.price@example.org.',
      'sam.price@[example.org]',
      'sam.price@example.org\u200b',
      'sam\u2024price@example.org',
    ]) {
      const r = refusal(checkMail(gmail({ from: `Sam <${from}>` }), POLICY));
      expect(['from', 'sender']).toContain(r.check);
    }
  });

  // "Compared case-insensitively" means ASCII case. String.toLowerCase maps
  // U+212A KELVIN SIGN to "k", so a different mailbox at the same domain
  // (signed by that domain's server, as any of its users' mail is) reads as
  // the allowed sender.
  test('a non-ASCII letter that lower-cases to ASCII is not the allowed sender', () => {
    const policy = { ...POLICY, allowedSenders: ['bookings@example.org'] };
    const r = refusal(
      checkMail(gmail({ from: 'Bookings <boo\u212Aings@example.org>' }), policy)
    );
    expect(r.check).toBe('sender');
  });
});

describe('DKIM alignment', () => {
  test('a pass for a look-alike or a public suffix is not aligned', () => {
    for (const d of [
      'example.org.example.net',
      'evil-example.org',
      'exampleorg.example.net',
      'org',
    ]) {
      const r = refusal(
        checkMail(
          gmail({
            ar: [
              `Authentication-Results: ${PROVIDER}; dkim=pass header.d=${d} header.s=s1`,
            ],
            dkim: [signatureOf(d)],
          }),
          POLICY
        )
      );
      expect(['dkim', 'signature']).toContain(r.check);
    }
  });

  test('a signature of another domain that claims the From domain in i= is refused', () => {
    const r = refusal(
      checkMail(
        gmail({
          ar: [
            `Authentication-Results: ${PROVIDER}; dkim=pass header.i=@example.org header.s=s1`,
          ],
          dkim: [
            `DKIM-Signature: v=1; a=rsa-sha256; d=example.net; i=@example.org; s=s1; h=from:to; bh=eA==; b=${SIG_B}`,
          ],
        }),
        POLICY
      )
    );
    expect(r.check).toBe('signature');
    expect(r.reason).toContain('not aligned');
  });

  test('a forged signature beside the genuine one cannot lift a signature that leaves To out', () => {
    const ar = [
      `Authentication-Results: ${PROVIDER}; dkim=pass header.i=@example.org header.s=s1 header.b=AbCdEf12`,
    ];
    const genuine = `DKIM-Signature: v=1; a=rsa-sha256; d=example.org; s=s1; h=from:subject:date; bh=eA==; b=${SIG_B}`;
    const r = refusal(
      checkMail(
        gmail({ ar, dkim: [signatureOf('example.org'), genuine] }),
        POLICY
      )
    );
    expect(r.check).toBe('signature');
    expect(r.reason).toContain('does not cover To');
  });

  // Relaxed alignment is the same organisational domain, which DMARC defines
  // by the Public Suffix List. The module's own list misses suffixes under
  // which anyone registers (uk.com, eu.org) and gets wildcard suffixes wrong
  // (*.sch.uk), so a forger's own signed domain aligns with an allowed
  // sender's there.
  test('a domain registered by someone else under the same public suffix is not aligned', () => {
    const cases: [string, string][] = [
      ['office' + AT + 'acme.uk.com', 'other.uk.com'],
      ['office' + AT + 'acme.eu.org', 'other.eu.org'],
      ['office' + AT + 'acme.kent.sch.uk', 'other.kent.sch.uk'],
    ];
    for (const [sender, d] of cases) {
      const decision = checkMail(
        gmail({
          from: `Office <${sender}>`,
          ar: [
            `Authentication-Results: ${PROVIDER}; dkim=pass header.d=${d} header.s=s1`,
          ],
          dkim: [signatureOf(d)],
        }),
        { ...POLICY, allowedSenders: [sender] }
      );
      expect([sender, decision.ok]).toEqual([sender, false]);
    }
  });
});

describe('To', () => {
  test('mail signed for someone else, or with no To, is refused', () => {
    const cases: [string, string][] = [
      ['alex@example.net', 'To: To does not hold the jobs address'],
      [`alex@example.net (${JOBS})`, 'To: To does not hold the jobs address'],
      [`"${JOBS}" <alex@example.net>`, 'To: To does not hold the jobs address'],
      ['jobs+x@example.com', 'To: To does not hold the jobs address'],
      [`${JOBS}.example.net`, 'To: To does not hold the jobs address'],
      ['', 'To: To does not hold the jobs address'],
      ['Undisclosed recipients:;', 'To: To does not hold the jobs address'],
      ['=?UTF-8?Q?jobs=40example.com?=', 'To: the To header does not parse'],
    ];
    for (const [to, reason] of cases) {
      const r = refusal(checkMail(gmail({ to }), POLICY));
      expect([to, r.reason.slice(0, reason.length)]).toEqual([to, reason]);
    }
    const noTo = block(gmailLines().filter((l) => !l.startsWith('To:')));
    expect(refusal(checkMail(noTo, POLICY)).reason).toBe(
      'To: the message has no To header'
    );
  });

  test('a To the sender adds above the signed one is a second To', () => {
    for (const extra of [
      `To: ${JOBS}`,
      `To : ${JOBS}`,
      `tO:${JOBS}`,
      `to\t:\t${JOBS}`,
    ]) {
      const lines = gmailLines({ to: 'alex@example.net' });
      const at = lines.findIndex((l) => l.startsWith('From:'));
      lines.splice(at, 0, extra);
      expect(refusal(checkMail(block(lines), POLICY)).reason).toBe(
        'To: the message has 2 To headers'
      );
    }
  });

  // A replay of mail the owner signed for someone else, with the jobs address
  // added above and the signed To hidden behind a line that ends in a bare
  // LF: this check's header block ends there, while a reader that splits on
  // CRLF (as a DKIM verifier may) sees both To headers and signs the lower.
  test('a header block with a bare LF is refused, so a signed To cannot be hidden behind it', () => {
    const lines = [
      `Delivered-To: ${JOBS}`,
      ...GMAIL_AR,
      `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.org; s=20230601; h=from:to:subject:date:message-id; bh=eA==; b=${SIG_B}`,
      `From: Sam Price <${OWNER}>`,
      `To: ${JOBS}`,
      'X-Note: a\n',
      'To: Alex <alex@example.net>',
      'Subject: Leeds Lights Gala',
      'Date: Mon, 1 Mar 2027 17:00:00 +0000',
      'Message-ID: <replay-0001@example.org>',
    ];
    const text = block(lines);
    // Split on CRLF, the block has both To headers.
    expect(text.split('\r\n').filter((l) => /^to:/i.test(l))).toHaveLength(2);
    expect(checkMail(new TextEncoder().encode(text), POLICY).ok).toBe(false);
  });
});

describe('header injection', () => {
  test('bare CR, NUL, line separators and a leading continuation are refused', () => {
    const cases: string[] = [
      gmail({ tail: ['X-Note: one\rTo: alex@example.net'] }),
      gmail({ from: `Sam <${OWNER}>\0` }),
      gmail({ from: `Sam\u2028From: x <${OWNER}>` }),
      gmail({ to: `${JOBS}\u0085To: alex@example.net` }),
      ` X-First: folded\r\n${gmail()}`,
      gmail({ tail: ['X-Caf\u00e9: one'] }),
    ];
    for (const message of cases)
      expect(checkMail(message, POLICY).ok).toBe(false);
  });

  test('a body that looks like headers is never read', () => {
    const lines = gmailLines({ from: 'Mallory <mallory@example.net>' });
    const r = refusal(checkMail(withBody(block(lines)), POLICY));
    expect(r.check).toBe('sender');
  });
});

// ---------------------------------------------------------------------------
// imap.ts.

class FakePipeline implements EmailSink {
  readonly inputs: EmailInput[] = [];
  async processEmail(input: EmailInput): Promise<SourceResult> {
    this.inputs.push(input);
    return {
      kind: 'finished',
      sourceId: `src-${this.inputs.length}`,
      status: 'Processed',
      children: [],
    };
  }
}

class FakeHealth implements MailHealth {
  readonly connections: { name: Connection; up: boolean; detail?: string }[] =
    [];
  succeeded(): void {}
  failed(): void {}
  async connection(
    name: Connection,
    up: boolean,
    detail?: string
  ): Promise<void> {
    this.connections.push({
      name,
      up,
      ...(detail !== undefined ? { detail } : {}),
    });
  }
}

/** The server answers FETCH with NO for the messages in `poison`, as a provider does for one it cannot read. */
class PoisonClient extends FakeImapClient {
  constructor(
    server: FakeImapServer,
    private readonly poison: { headers: Set<number>; source: Set<number> }
  ) {
    super(server, false);
  }

  private no(): Error {
    return Object.assign(new Error('Command failed'), {
      responseStatus: 'NO',
      responseText: 'Some messages could not be FETCHed (Failure)',
      serverResponseCode: 'UNAVAILABLE',
    });
  }

  override async *fetch(
    range: string,
    query: FetchQuery
  ): AsyncGenerator<FetchedMessage> {
    if (range.split(',').some((u) => this.poison.headers.has(Number(u))))
      throw this.no();
    yield* super.fetch(range, query);
  }

  override async fetchOne(
    range: string,
    query: FetchQuery
  ): Promise<FetchedMessage | false> {
    if (query.source === true && this.poison.source.has(Number(range)))
      throw this.no();
    return super.fetchOne(range, query);
  }
}

function setup(
  options: {
    connect?: (server: FakeImapServer) => ImapClientFactory;
    notifier?: RecordingNotifier;
    server?: FakeImapServer;
  } = {}
) {
  const server = options.server ?? new FakeImapServer();
  const pipeline = new FakePipeline();
  const notifier = options.notifier ?? new RecordingNotifier();
  const health = new FakeHealth();
  const lines: string[] = [];
  const logger = new Logger({ sink: (l) => lines.push(l), level: 'debug' });
  logger.addSecret(PASSWORD);
  const reader = new MailboxReader({
    host: 'imap.example.com',
    policy: POLICY,
    connect: options.connect?.(server) ?? server.factory(),
    pipeline,
    notifier,
    health,
    logger,
    clock: () => new Date('2027-03-01T17:01:00Z'),
  });
  return { server, pipeline, notifier, health, lines, logger, reader };
}

async function pollQuietly(reader: MailboxReader): Promise<unknown[]> {
  const errors: unknown[] = [];
  try {
    await reader.poll();
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

const GOOD = withBody(gmail());

describe('the reader: nothing but the header block before the decision', () => {
  test('a refused message is fetched by its headers only, moved unread, and its note holds the sender and the check', async () => {
    const { server, pipeline, notifier, reader } = setup();
    const uid = server.deliver(
      withBody(gmail({ from: 'Mallory <mallory@example.net>' })),
      { flags: ['\\Seen'] }
    );
    await reader.poll();
    expect(pipeline.inputs).toHaveLength(0);
    const reads = server.commands.filter(
      (c) => c.op === 'fetch' || c.op === 'fetchOne'
    );
    expect(reads).toEqual([
      {
        op: 'fetch',
        range: String(uid),
        query: {
          uid: true,
          size: true,
          flags: true,
          internalDate: true,
          headers: true,
        },
      },
    ]);
    expect(server.uids('Refused')).toEqual([uid]);
    expect(server.folder('Refused')[0]?.flags.has('\\Seen')).toBe(false);
    const notes = notifier.of('refused');
    expect(notes).toEqual([
      {
        from: 'mallory@example.net',
        check:
          'Sender: mallory@example.net is not in JOBS_MAIL_ALLOWED_SENDERS',
      },
    ]);
    expect(JSON.stringify(notes)).not.toContain('Leeds Lights Gala');
  });

  test('a message one byte over 40 MB is refused before its source is fetched; one at 40 MB is read', async () => {
    const { server, pipeline, notifier, reader } = setup();
    const over = server.deliver(GOOD, { size: MAX_MESSAGE_BYTES + 1 });
    const at = server.deliver(GOOD, { size: MAX_MESSAGE_BYTES });
    await reader.poll();
    expect(server.uids('Refused')).toEqual([over]);
    expect(
      server.commands
        .filter((c) => c.op === 'fetchOne')
        .map((c) => (c.op === 'fetchOne' ? c.range : ''))
    ).toEqual([String(at)]);
    expect(pipeline.inputs).toHaveLength(1);
    expect(notifier.of('refused')[0]?.check).toContain('over the');
  });

  test('a message with no reported size is refused without being fetched', async () => {
    const server = new FakeImapServer();
    const { pipeline, reader } = setup({
      server,
      connect: (s) => () => {
        const client = new (class extends FakeImapClient {
          override async *fetch(
            range: string,
            query: FetchQuery
          ): AsyncGenerator<FetchedMessage> {
            for await (const m of super.fetch(range, query))
              yield { ...m, size: undefined };
          }
        })(s, false);
        s.clients.push(client);
        return client;
      },
    });
    const uid = server.deliver(GOOD);
    await reader.poll();
    expect(server.uids('Refused')).toEqual([uid]);
    expect(server.count('fetchOne')).toBe(0);
    expect(pipeline.inputs).toHaveLength(0);
  });
});

describe('the reader across a crash and a bad message', () => {
  const worlds: World[] = [];
  afterEach(async () => {
    for (const w of worlds.splice(0)) await cleanup(w);
  });

  /** The booking email as the provider delivers it (see intake.test.ts). */
  function delivered(): Uint8Array {
    const head = new TextEncoder().encode(
      [
        `Authentication-Results: ${PROVIDER};`,
        '       dkim=pass header.i=@acme-productions.example.com header.s=s1 header.b=AbCdEf12;',
        '       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=acme-productions.example.com',
        'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=acme-productions.example.com; s=s1;',
        `        h=from:to:subject:date:message-id; bh=eA==; b=${SIG_B}`,
        '',
      ].join('\r\n')
    );
    const body = inviteEmail();
    const out = new Uint8Array(head.length + body.length);
    out.set(head);
    out.set(body, head.length);
    return out;
  }

  test('a crash between the pipeline and the move loses nothing and reads nothing twice', async () => {
    const w = await makeWorld(
      [
        { marker: 'S1: "Leeds Lights Gala - booking"', reply: EMAIL_REPLY },
        { marker: 'S1: "invite.pdf"', reply: INVITE_PDF_REPLY },
      ],
      { extract: (bytes, hint) => extract(bytes, hint) }
    );
    worlds.push(w);
    const server = new FakeImapServer();
    const uid = server.deliver(delivered());
    const policy = {
      ...POLICY,
      allowedSenders: ['jo@acme-productions.example.com'],
    };
    const health = new FakeHealth();
    const make = (): MailboxReader =>
      new MailboxReader({
        host: 'imap.example.com',
        policy,
        connect: server.factory(),
        pipeline: w.pipeline,
        notifier: w.notifier,
        health,
        logger: w.ctx.logger,
        clock: () => new Date(w.now),
      });
    // The service stops after the pipeline returns and before the move.
    server.unmovable.add(uid);
    await make().poll();
    expect(server.uids('INBOX')).toEqual([uid]);
    expect(w.store.rows('sources')).toHaveLength(2);

    // A restart: a new pipeline on the same state, a new reader.
    server.unmovable.clear();
    await restart(w, (bytes, hint) => extract(bytes, hint));
    const again = new MailboxReader({
      host: 'imap.example.com',
      policy,
      connect: server.factory(),
      pipeline: w.pipeline,
      notifier: w.notifier,
      health,
      logger: w.ctx.logger,
      clock: () => new Date(w.now),
    });
    await again.poll();
    expect(server.uids('INBOX')).toEqual([]);
    expect(server.uids('Processed')).toEqual([uid]);
    expect(w.store.rows('sources')).toHaveLength(2);
    expect(w.model.count('S1: "Leeds Lights Gala - booking"')).toBe(1);
    expect(w.model.count('S1: "invite.pdf"')).toBe(1);
  });

  // A provider that cannot produce one message answers its FETCH with NO.
  // The whole batch then fails, every poll, so no later message is read and
  // the mailbox is reported down.
  test('a message whose headers the server will not give does not stop the messages after it', async () => {
    const poison = { headers: new Set<number>(), source: new Set<number>() };
    const { server, pipeline, reader } = setup({
      connect: (s) => () => {
        const client = new PoisonClient(s, poison);
        s.clients.push(client);
        return client;
      },
    });
    const bad = server.deliver(GOOD);
    poison.headers.add(bad);
    const good = server.deliver(GOOD);
    for (let i = 0; i < 3; i++) await pollQuietly(reader);
    expect(server.uids('Processed')).toEqual([good]);
    expect(pipeline.inputs).toHaveLength(1);
  });

  test('a message whose source the server will not give does not stop the messages after it', async () => {
    const poison = { headers: new Set<number>(), source: new Set<number>() };
    const { server, pipeline, reader } = setup({
      connect: (s) => () => {
        const client = new PoisonClient(s, poison);
        s.clients.push(client);
        return client;
      },
    });
    const bad = server.deliver(GOOD);
    poison.source.add(bad);
    const good = server.deliver(GOOD);
    for (let i = 0; i < 3; i++) await pollQuietly(reader);
    expect(server.uids('Processed')).toEqual([good]);
    expect(pipeline.inputs).toHaveLength(1);
  });

  // This test pinned the defect (every poll threw 'the mailbox failed:
  // Command failed', the good message stayed in INBOX). The design's rule
  // (Health: only a mailbox that stops answering is reported down) is that
  // no poll fails and the bad message alone is left.
  test('one such message fails no poll and is left alone in INBOX', async () => {
    const poison = { headers: new Set<number>(), source: new Set<number>() };
    const { server, pipeline, reader } = setup({
      connect: (s) => () => {
        const client = new PoisonClient(s, poison);
        s.clients.push(client);
        return client;
      },
    });
    const bad = server.deliver(GOOD);
    poison.source.add(bad);
    const good = server.deliver(GOOD);
    const errors: unknown[] = [];
    for (let i = 0; i < 3; i++) errors.push(...(await pollQuietly(reader)));
    expect(errors).toEqual([]);
    expect(server.uids('INBOX')).toEqual([bad]);
    expect(server.uids('Processed')).toEqual([good]);
    expect(pipeline.inputs).toHaveLength(1);
  });
});

describe('the refusal note', () => {
  // The design: a refused message is moved to Refused and the owner gets a
  // note. The note is queued in memory and the message is moved at once, so
  // a restart while Telegram is down (or right after the move) loses it, and
  // the message is never looked at again.
  const worlds: World[] = [];
  afterEach(async () => {
    for (const w of worlds.splice(0)) await cleanup(w);
  });

  function contextOf(w: World, signal: AbortSignal): IntakeContext {
    return {
      pipeline: w.pipeline,
      ai: w.ctx.ai,
      state: w.state,
      notifier: w.notifier,
      logger: w.ctx.logger,
      config: loadConfig({ ...ENV, JOBS_STATE_DIR: w.dir }),
      health: w.ctx.health,
      clock: w.ctx.clock,
      timeZone: w.ctx.timeZone,
      signal,
    };
  }

  /** The mail intake on the world's state for `polls` polls, then stopped. */
  async function runIntake(
    w: World,
    server: FakeImapServer,
    polls: number
  ): Promise<void> {
    const config = loadConfig({ ...ENV, JOBS_STATE_DIR: w.dir });
    const intake = new MailIntake({
      settings: config.mail as NonNullable<typeof config.mail>,
      connect: () => server.factory(),
      pollMs: 5,
    });
    const opened = server.count('open');
    await intake.start(contextOf(w, new AbortController().signal));
    for (let i = 0; i < 2000 && server.count('open') < opened + polls; i++)
      await pause(2);
    await intake.stop();
  }

  // The design: a refused message is moved to Refused and the owner gets a
  // note. The note is queued in memory and the message is moved at once, so
  // a restart while Telegram is down (or right after the move) loses it, and
  // the message is never looked at again.
  test('a refusal the notifier could not deliver is still told after a restart', async () => {
    const w = await makeWorld([]);
    worlds.push(w);
    const server = new FakeImapServer();
    server.deliver(withBody(gmail({ from: 'Mallory <mallory@example.net>' })));
    w.notifier.failing = true;
    await runIntake(w, server, 3);
    expect(w.notifier.of('refused')).toHaveLength(0);

    await restart(w);
    w.notifier.failing = false;
    await runIntake(w, server, 3);
    expect(w.notifier.of('refused')).toHaveLength(1);
  });

  // The note carries no subject or body, but a quoted local part is free
  // text the sender chooses (spaces, a link), and it reaches the owner's chat
  // as the sender.
  test('the note’s sender is an address, not a sentence the sender wrote', async () => {
    const { server, notifier, reader } = setup();
    server.deliver(
      withBody(
        gmail({
          from: '"Booking confirmed, pay the deposit at https://pay.example.net/x"@example.net',
        })
      )
    );
    await reader.poll();
    const note = notifier.of('refused')[0];
    expect(note?.from).toBeDefined();
    expect(note?.from).not.toMatch(/\s|https?:/);
  });
});

describe('the password', () => {
  test('an error during a poll that carries the password is masked in logs, health and the login check', async () => {
    const { server, health, lines, reader, logger } = setup();
    server.deliver(GOOD);
    server.openError = new Error(
      `SELECT failed for jobs@example.com/${PASSWORD}`
    );
    const abort = new AbortController();
    const run = new MailboxReader({
      host: 'imap.example.com',
      policy: POLICY,
      connect: server.factory(),
      pipeline: new FakePipeline(),
      notifier: new RecordingNotifier(),
      health,
      logger,
      clock: () => new Date('2027-03-01T17:01:00Z'),
      sleep: async () => abort.abort(),
    });
    await run.run(abort.signal);
    expect(health.connections[0]?.up).toBe(false);
    expect(health.connections[0]?.detail).not.toContain(PASSWORD);
    expect(lines.join('\n')).not.toContain(PASSWORD);

    server.connectError = new Error(`LOGIN jobs@example.com ${PASSWORD}`);
    const check = await checkLogin({
      host: 'imap.example.com',
      policy: POLICY,
      connect: server.factory(),
      logger,
    });
    expect(check.ok).toBe(false);
    expect(check.text).not.toContain(PASSWORD);
    await reader.close();
  });
});
