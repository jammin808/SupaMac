import { describe, expect, test } from 'bun:test';
import {
  aligned,
  checkMail,
  type MailDecision,
  organisationalDomain,
  parseAddressList,
  parseAuthenticationResults,
  parseDkimSignature,
  parseHeaderBlock,
} from '../../src/mail/auth';
import {
  block,
  GMAIL_AR,
  GMAIL_DKIM,
  gmail,
  gmailLines,
  HOST,
  JOBS,
  MICROSOFT_AR,
  microsoftSender,
  OWNER,
  POLICY,
  PROVIDER,
  PROVIDER_AR,
  SIG_B,
  withBody,
} from './fixtures';

// Addresses on real domains (webmail, public suffixes, look-alikes) are
// joined at run time: the repository's personal-data scan reads only
// example domains as placeholders. None of them is a real person's.
const AT = '@';

function refused(decision: MailDecision): {
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

describe('the mail check, on real-shaped header blocks', () => {
  test('a Gmail-style delivery of the owner’s forward passes', () => {
    expect(checkMail(gmail(), POLICY)).toEqual({
      ok: true,
      from: OWNER,
      dkimDomain: 'example.org',
    });
  });

  test('reads the header block of a whole message and nothing of its body', () => {
    expect(checkMail(withBody(gmail()), POLICY)).toEqual({
      ok: true,
      from: OWNER,
      dkimDomain: 'example.org',
    });
    const noResults = gmail({ ar: [] });
    const r = refused(checkMail(withBody(noResults), POLICY));
    expect(r.check).toBe('authentication-results');
    expect(r.reason).toBe(
      'Authentication-Results: the message has no Authentication-Results header'
    );
  });

  test('a provider’s own header with comments, quoted strings and many methods passes', () => {
    const decision = checkMail(gmail({ ar: PROVIDER_AR }), {
      ...POLICY,
      authservId: HOST,
    });
    expect(decision).toEqual({
      ok: true,
      from: OWNER,
      dkimDomain: 'example.org',
    });
  });

  test('an authserv-id that names another host of the same provider is refused', () => {
    const r = refused(
      checkMail(gmail({ ar: PROVIDER_AR }), {
        ...POLICY,
        authservId: 'mx.mailhost.example',
      })
    );
    expect(r).toEqual({
      check: 'authserv-id',
      reason: `Authentication-Results: the topmost Authentication-Results header is from ${HOST}, not mx.mailhost.example`,
      from: OWNER,
    });
  });

  test('a Microsoft 365-style sender’s signature does not cover To, so it is refused', () => {
    const r = refused(checkMail(microsoftSender(), POLICY));
    expect(r.check).toBe('signature');
    expect(r.from).toBe('sam.price@example.net');
    expect(r.reason).toBe(
      'DKIM signature: the signature for example.net does not cover To, so it could be replayed from mail sent to someone else'
    );
  });

  test('a Microsoft 365-style mailbox writes no authserv-id, so its header is refused', () => {
    const r = refused(checkMail(gmail({ ar: MICROSOFT_AR }), POLICY));
    expect(r.check).toBe('authserv-id');
    expect(r.reason).toBe(
      'Authentication-Results: the topmost Authentication-Results header names no authserv-id'
    );
  });

  test('a forged header lower in the block is never read', () => {
    const r = refused(
      checkMail(
        gmail({
          ar: [
            `Authentication-Results: ${PROVIDER};`,
            '       dkim=none (no signature);',
            '       spf=softfail (example.com: domain of transitioning sam.price@example.org does not designate 198.51.100.7 as permitted sender) smtp.mailfrom=sam.price@example.org;',
            '       dmarc=fail (p=NONE sp=QUARANTINE dis=NONE) header.from=example.org',
          ],
          middle: [
            'Received: from forger.example.net (forger.example.net [198.51.100.7]) by relay.example.net;',
            '        Mon, 01 Mar 2027 08:59:59 -0800',
            `Authentication-Results: ${PROVIDER};`,
            '       dkim=pass header.i=@example.org header.s=20230601 header.b=AbCdEf12',
          ],
        }),
        POLICY
      )
    );
    expect(r).toEqual({
      check: 'dkim',
      reason: 'DKIM: no dkim=pass',
      from: OWNER,
    });
  });

  test('the ARC copy of the results is not the provider’s header', () => {
    const lines = gmailLines({ ar: [] });
    const r = refused(checkMail(block(lines), POLICY));
    expect(r.check).toBe('authentication-results');
  });

  test('a topmost header from another authserv-id is refused, even when one below is the provider’s', () => {
    const r = refused(
      checkMail(
        gmail({
          ar: [
            'Authentication-Results: relay.example.net; dkim=pass header.d=example.org header.s=20230601 header.b=AbCdEf12',
            ...GMAIL_AR,
          ],
        }),
        POLICY
      )
    );
    expect(r).toEqual({
      check: 'authserv-id',
      reason: `Authentication-Results: the topmost Authentication-Results header is from relay.example.net, not ${PROVIDER}`,
      from: OWNER,
    });
  });

  test('dkim=pass for another domain is not aligned with From', () => {
    const r = refused(
      checkMail(
        gmail({
          ar: [
            `Authentication-Results: ${PROVIDER};`,
            '       dkim=pass header.i=@bulkmailer.example.com header.s=s1 header.b=AbCdEf12;',
            '       spf=pass smtp.mailfrom=bounce@bulkmailer.example.com;',
            '       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.org',
          ],
          dkim: [
            'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=bulkmailer.example.com; s=s1;',
            `        h=from:to:subject:date; bh=eA==; b=${SIG_B}`,
          ],
        }),
        POLICY
      )
    );
    expect(r).toEqual({
      check: 'dkim',
      reason:
        'DKIM: dkim=pass is for bulkmailer.example.com, which is not aligned with example.org',
      from: OWNER,
    });
  });

  test('a DMARC or SPF pass alone is not enough', () => {
    const r = refused(
      checkMail(
        gmail({
          ar: [
            `Authentication-Results: ${PROVIDER};`,
            '       spf=pass (example.com: domain of sam.price@example.org designates 192.0.2.10 as permitted sender) smtp.mailfrom=sam.price@example.org;',
            '       dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=example.org',
          ],
        }),
        POLICY
      )
    );
    expect(r).toEqual({
      check: 'dkim',
      reason: 'DKIM: no dkim=pass; SPF and DMARC passed, which is not enough',
      from: OWNER,
    });
  });

  test('a From with two addresses is refused', () => {
    const r = refused(
      checkMail(
        gmail({ from: `Sam Price <${OWNER}>, Other <other@example.org>` }),
        POLICY
      )
    );
    expect(r).toEqual({
      check: 'from',
      reason: 'From: the From header holds 2 addresses, not one',
      from: `${OWNER}, other@example.org`,
    });
  });

  test('two From headers are refused', () => {
    const r = refused(
      checkMail(
        gmail({ tail: ['From: Mallory <mallory@example.net>'] }),
        POLICY
      )
    );
    expect(r.check).toBe('from');
    expect(r.reason).toBe('From: the message has 2 From headers');
  });

  test('a From holding a group is refused', () => {
    const r = refused(checkMail(gmail({ from: `Crew: ${OWNER};` }), POLICY));
    expect(r.check).toBe('from');
    expect(r.reason).toBe('From: the From header holds a group');
  });

  test('an encoded display name passes; only the address counts', () => {
    expect(
      checkMail(gmail({ from: `=?UTF-8?B?U2FtIFByaWNl?= <${OWNER}>` }), POLICY)
        .ok
    ).toBe(true);
    // The display name decodes to the owner's address; the address is not.
    const disguised = refused(
      checkMail(
        gmail({
          from: '=?UTF-8?B?c2FtLnByaWNlQGV4YW1wbGUub3Jn?= <mallory@example.net>',
        }),
        POLICY
      )
    );
    expect(disguised).toEqual({
      check: 'sender',
      reason: 'Sender: mallory@example.net is not in JOBS_MAIL_ALLOWED_SENDERS',
      from: 'mallory@example.net',
    });
    const quoted = refused(
      checkMail(gmail({ from: `"${OWNER}" <mallory@example.net>` }), POLICY)
    );
    expect(quoted.check).toBe('sender');
    // An encoded word in place of an address is no address.
    const encoded = refused(
      checkMail(gmail({ from: '=?UTF-8?Q?sam.price=40example.org?=' }), POLICY)
    );
    expect(encoded.check).toBe('from');
    expect(encoded.from).not.toBe(OWNER);
  });

  test('a comment that holds an address does not count', () => {
    const r = refused(
      checkMail(gmail({ from: `mallory@example.net (${OWNER})` }), POLICY)
    );
    expect(r.check).toBe('sender');
    expect(r.from).toBe('mallory@example.net');
  });

  test('To not covered by h= is refused', () => {
    const r = refused(
      checkMail(
        gmail({
          dkim: [
            'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;',
            '        d=example.org; s=20230601;',
            '        h=subject:message-id:date:from:mime-version;',
            `        bh=eA==; b=${SIG_B}`,
          ],
        }),
        POLICY
      )
    );
    expect(r.check).toBe('signature');
    expect(r.reason).toContain('does not cover To');
  });

  test('a replay of mail signed for another address is refused', () => {
    const r = refused(
      checkMail(gmail({ to: 'Alex <alex@example.net>' }), POLICY)
    );
    expect(r).toEqual({
      check: 'to',
      reason:
        'To: To does not hold the jobs address, so the message was signed for someone else',
      from: OWNER,
    });
  });

  test('the jobs address among several recipients, or in a group, passes', () => {
    expect(
      checkMail(
        gmail({
          to: `Alex <alex@example.net>, "Jobs" <${JOBS.toUpperCase()}>`,
        }),
        POLICY
      ).ok
    ).toBe(true);
    expect(
      checkMail(gmail({ to: `Crew: alex@example.net, ${JOBS};` }), POLICY).ok
    ).toBe(true);
  });

  test('two To headers are refused', () => {
    const r = refused(
      checkMail(gmail({ tail: ['To: alex@example.net'] }), POLICY)
    );
    expect(r).toEqual({
      check: 'to',
      reason: 'To: the message has 2 To headers',
      from: OWNER,
    });
  });

  test('an unknown jobs address refuses every message, saying why', () => {
    const r = refused(checkMail(gmail(), { ...POLICY, jobsAddresses: [] }));
    expect(r.check).toBe('to');
    expect(r.reason).toContain('JOBS_MAIL_USER is not an email address');
  });

  test('a signature with a body length limit is refused', () => {
    const r = refused(
      checkMail(
        gmail({
          dkim: [
            'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.org;',
            `        s=20230601; l=120; h=from:to:subject:date; bh=eA==; b=${SIG_B}`,
          ],
        }),
        POLICY
      )
    );
    expect(r.check).toBe('signature');
    expect(r.reason).toContain('(l=)');
  });

  test('when the result does not say which signature passed, every signature of its domain must cover To', () => {
    const ar = [
      `Authentication-Results: ${PROVIDER}; dkim=pass (signature was verified) header.d=example.org; dmarc=pass header.from=example.org`,
    ];
    const both = [
      `DKIM-Signature: v=1; a=rsa-sha256; d=example.org; s=one; h=from:to:subject; bh=eA==; b=${SIG_B}`,
      'DKIM-Signature: v=1; a=rsa-sha256; d=example.org; s=two; h=from:subject; bh=eA==; b=ZZZZ',
    ];
    expect(refused(checkMail(gmail({ ar, dkim: both }), POLICY)).check).toBe(
      'signature'
    );
    expect(checkMail(gmail({ ar, dkim: both.slice(0, 1) }), POLICY).ok).toBe(
      true
    );
  });

  test('the selector and signature prefix pick the signature that passed', () => {
    const dkim = [
      'DKIM-Signature: v=1; a=rsa-sha256; d=example.org; s=old; h=from:subject; bh=eA==; b=ZZZZ',
      ...GMAIL_DKIM,
    ];
    expect(checkMail(gmail({ dkim }), POLICY).ok).toBe(true);
    const wrongPrefix = [
      `Authentication-Results: ${PROVIDER}; dkim=pass header.i=@example.org header.s=20230601 header.b=QQQQQQQQ`,
    ];
    const r = refused(checkMail(gmail({ ar: wrongPrefix }), POLICY));
    expect(r).toEqual({
      check: 'signature',
      reason:
        'DKIM signature: no DKIM-Signature header matches the dkim=pass for example.org',
      from: OWNER,
    });
  });

  test('alignment: a subdomain signs for the From domain', () => {
    const ar = [
      `Authentication-Results: ${PROVIDER}; dkim=pass header.d=mail.example.org header.s=s1; dmarc=pass header.from=example.org`,
    ];
    const dkim = [
      `DKIM-Signature: v=1; a=rsa-sha256; d=mail.example.org; s=s1; h=from:to:subject; bh=eA==; b=${SIG_B}`,
    ];
    expect(checkMail(gmail({ ar, dkim }), POLICY)).toEqual({
      ok: true,
      from: OWNER,
      dkimDomain: 'mail.example.org',
    });
  });

  test('a co.uk sender aligns only within its own registered domain', () => {
    const policy = { ...POLICY, allowedSenders: ['sam' + AT + 'acme.co.uk'] };
    const signed = (d: string): string =>
      gmail({
        from: 'Sam <sam' + AT + 'acme.co.uk>',
        ar: [
          `Authentication-Results: ${PROVIDER}; dkim=pass header.d=${d}; dmarc=pass header.from=acme.co.uk`,
        ],
        dkim: [
          `DKIM-Signature: v=1; a=rsa-sha256; d=${d}; s=s1; h=from:to; bh=eA==; b=${SIG_B}`,
        ],
      });
    expect(checkMail(signed('mail.acme.co.uk'), policy).ok).toBe(true);
    expect(refused(checkMail(signed('other.co.uk'), policy)).check).toBe(
      'dkim'
    );
    expect(refused(checkMail(signed('co.uk'), policy)).check).toBe('dkim');
  });

  test('folding, odd case and an upper-case authserv-id are read alike', () => {
    const lines = gmailLines({
      from: `Sam Price\r\n <SAM.PRICE@Example.ORG>`,
      to: `Jobs\r\n\t<jobs@example.com>`,
      ar: [
        'AUTHENTICATION-RESULTS: MX.Example.COM;',
        '\tDKIM=Pass header.i=@example.org',
        '\t  header.s=20230601',
        '\t  header.b=AbCdEf12;',
        '\tDMARC=Pass header.from=Example.ORG',
      ],
    }).map((l) => (l.startsWith('From:') ? l.replace('From:', 'fROM:') : l));
    expect(checkMail(block(lines), POLICY)).toEqual({
      ok: true,
      from: OWNER,
      dkimDomain: 'example.org',
    });
  });

  test('a pass inside a comment or a quoted string is not a pass', () => {
    const comment = [
      `Authentication-Results: ${PROVIDER}; dkim=fail (would be dkim=pass header.d=example.org; but the body changed) header.d=example.org`,
    ];
    expect(refused(checkMail(gmail({ ar: comment }), POLICY)).reason).toBe(
      'DKIM: no dkim=pass'
    );
    const quoted = [
      `Authentication-Results: ${PROVIDER}; dkim=neutral reason="bad; dkim=pass header.d=example.org" header.d=example.org`,
    ];
    expect(refused(checkMail(gmail({ ar: quoted }), POLICY)).reason).toBe(
      'DKIM: no dkim=pass'
    );
  });

  test('a result that names a property twice counts for nothing', () => {
    const ar = [
      `Authentication-Results: ${PROVIDER}; dkim=pass header.d=example.net header.d=example.org header.s=20230601`,
    ];
    expect(refused(checkMail(gmail({ ar }), POLICY)).check).toBe('dkim');
  });

  test('a header block that does not parse is refused', () => {
    const broken = gmail({ tail: ['this line has no colon'] });
    expect(refused(checkMail(broken, POLICY))).toEqual({
      check: 'headers',
      reason: 'Headers: a header line is not a header field',
      from: '(unknown)',
    });
    const bareCr = gmail({ tail: ['X-Note: one\rFrom: mallory@example.net'] });
    expect(refused(checkMail(bareCr, POLICY)).check).toBe('headers');
    expect(refused(checkMail(' X-Folded: first\r\n\r\n', POLICY)).check).toBe(
      'headers'
    );
  });

  test('a header of an unbalanced comment does not parse', () => {
    const ar = [
      `Authentication-Results: ${PROVIDER}; dkim=pass (unclosed header.d=example.org`,
    ];
    expect(refused(checkMail(gmail({ ar }), POLICY))).toEqual({
      check: 'authentication-results',
      reason:
        'Authentication-Results: the topmost Authentication-Results header does not parse',
      from: OWNER,
    });
  });

  test('no From, an unparsable From and a stranger are refused by name', () => {
    const noFrom = block(gmailLines().filter((l) => !l.startsWith('From:')));
    expect(refused(checkMail(noFrom, POLICY))).toEqual({
      check: 'from',
      reason: 'From: the message has no From header',
      from: '(no From)',
    });
    expect(
      refused(checkMail(gmail({ from: 'Sam <sam.price@example.org' }), POLICY))
    ).toEqual({
      check: 'from',
      reason: 'From: the From header does not parse',
      from: '(the From header does not parse)',
    });
    expect(
      refused(checkMail(gmail({ from: 'stranger@example.net' }), POLICY)).check
    ).toBe('sender');
  });

  test('a note never carries more than the sender and the check', () => {
    const long = `${'x'.repeat(300)}@example.net`;
    const r = refused(checkMail(gmail({ from: long }), POLICY));
    expect(r.from.length).toBeLessThanOrEqual(120);
    expect(r.reason).not.toContain('Leeds Lights Gala');
  });
});

describe('the parts of the check', () => {
  test('the header block unfolds and keeps every field in order', () => {
    const parsed = parseHeaderBlock(
      'A: one\r\n  two\r\nb : three\r\n\r\nC: body'
    );
    expect(parsed).toEqual({
      ok: true,
      fields: [
        { name: 'A', key: 'a', value: 'one  two' },
        { name: 'b', key: 'b', value: 'three' },
      ],
    });
  });

  test('address lists: display names, quotes, comments, groups, literals', () => {
    expect(
      parseAddressList(
        '"Price, Sam" <Sam.Price@Example.org>, (crew) alex@example.net, Team: a@example.com, b@example.com;, "x"@[192.0.2.1]'
      )
    ).toEqual({
      ok: true,
      groups: 1,
      mailboxes: [
        { address: 'sam.price@example.org', domain: 'example.org' },
        { address: 'alex@example.net', domain: 'example.net' },
        { address: 'a@example.com', domain: 'example.com' },
        { address: 'b@example.com', domain: 'example.com' },
        { address: 'x@[192.0.2.1]', domain: '[192.0.2.1]' },
      ],
    });
    expect(parseAddressList('Undisclosed recipients:;')).toEqual({
      ok: true,
      groups: 1,
      mailboxes: [],
    });
    for (const bad of [
      'sam@example.org <alex@example.net>',
      '<@route.example:sam@example.org>',
      'sam @ example . org',
      '"unclosed <sam@example.org>',
      'a@b@c',
    ])
      expect(parseAddressList(bad).ok).toBe(false);
  });

  test('Authentication-Results: the authserv-id, version, results and properties', () => {
    const parsed = parseAuthenticationResults(
      '"mx.example.com" 1; dkim=pass (good) header.d=example.org header.b="Ab;Cd"; spf/2=pass smtp.mailfrom=@example.org; none'
    );
    expect(parsed?.authservId).toBe('mx.example.com');
    expect(parsed?.results.map((r) => [r.method, r.result])).toEqual([
      ['dkim', 'pass'],
      ['spf', 'pass'],
    ]);
    expect(parsed?.results[0]?.properties.get('header.b')).toBe('Ab;Cd');
    expect(parsed?.results[1]?.properties.get('smtp.mailfrom')).toBe(
      '@example.org'
    );
    expect(parseAuthenticationResults(`${PROVIDER}; none`)).toEqual({
      authservId: PROVIDER,
      results: [],
    });
    const fields = parseHeaderBlock(block(PROVIDER_AR));
    if (!fields.ok) throw new Error(fields.reason);
    const provider = parseAuthenticationResults(fields.fields[0]?.value ?? '');
    expect(provider?.authservId).toBe(HOST);
    expect(provider?.results.map((r) => r.method)).toEqual([
      'arc',
      'bimi',
      'dkim',
      'dmarc',
      'iprev',
      'spf',
      'x-aligned-from',
      'x-me-sender',
      'x-ptr',
      'x-tls',
    ]);
    expect(parseAuthenticationResults('mx.example.com; dkim')).toBeUndefined();
    expect(parseAuthenticationResults('mx example; dkim=pass')).toBeUndefined();
  });

  test('DKIM-Signature: tags, folded lists, duplicates', () => {
    expect(
      parseDkimSignature(
        'v=1; a=rsa-sha256; d=Example.ORG; s=Sel1; h=From : To:\r\n subject; bh=eA==; b=Ab Cd\r\n Ef'
      )
    ).toEqual({
      d: 'example.org',
      s: 'sel1',
      i: '@example.org',
      h: ['from', 'to', 'subject'],
      b: 'AbCdEf',
      bodyLimit: false,
    });
    expect(
      parseDkimSignature('v=1; d=example.org; d=example.net; h=from; b=eA==')
    ).toBeUndefined();
    expect(parseDkimSignature('v=1; h=from; b=eA==')).toBeUndefined();
  });

  test('organisational domains, with the multi-label suffix rule', () => {
    expect(organisationalDomain('mail.example.org')).toBe('example.org');
    expect(organisationalDomain('a.b.acme.co.uk')).toBe('acme.co.uk');
    expect(organisationalDomain('crew.example.org.uk')).toBe('example.org.uk');
    expect(organisationalDomain('venue.example.com.au')).toBe('example.com.au');
    expect(organisationalDomain('example.ne.jp')).toBe('example.ne.jp');
    expect(organisationalDomain('co.uk')).toBeUndefined();
    expect(organisationalDomain('uk')).toBeUndefined();
    expect(organisationalDomain('Example.ORG.')).toBe('example.org');
    expect(aligned('mail.example.org', 'example.org')).toBe(true);
    expect(aligned('example.org', 'example.net')).toBe(false);
    expect(aligned('acme.co.uk', 'other.co.uk')).toBe(false);
  });

  test('alignment: the same domain, a subdomain or a parent; never a sibling or a suffix', () => {
    expect(aligned('example.org', 'Example.ORG.')).toBe(true);
    expect(aligned('mail.example.org', 'example.org')).toBe(true);
    expect(aligned('example.org', 'news.example.org')).toBe(true);
    expect(aligned('mail.example.org', 'news.example.org')).toBe(false);
    expect(aligned('other.uk.com', 'acme.uk.com')).toBe(false);
    expect(aligned('other.kent.sch.uk', 'acme.kent.sch.uk')).toBe(false);
    expect(aligned('co.uk', 'acme.co.uk')).toBe(false);
    expect(aligned('evil-example.org', 'example.org')).toBe(false);
    expect(aligned('example.org.example.net', 'example.org')).toBe(false);
  });

  test('DKIM-Signature: every tag RFC 6376 requires, and v=1', () => {
    const full = `v=1; a=rsa-sha256; d=example.org; s=s1; h=from:to; bh=eA==; b=${SIG_B}`;
    expect(parseDkimSignature(full)?.s).toBe('s1');
    for (const [tag, without] of [
      ['v', full.replace('v=1; ', '')],
      ['v=2', full.replace('v=1', 'v=2')],
      ['a', full.replace('a=rsa-sha256; ', '')],
      ['s', full.replace('s=s1; ', '')],
      ['bh', full.replace('bh=eA==; ', '')],
      ['empty s', full.replace('s=s1', 's=')],
    ] as const)
      expect([tag, parseDkimSignature(without)]).toEqual([tag, undefined]);
  });

  test('a header block ends at its first CRLF CRLF; a bare LF anywhere before it is refused', () => {
    const lf = refused(
      checkMail(gmail({ tail: ['X-Note: one\nTo: alex@example.net'] }), POLICY)
    );
    expect(lf).toEqual({
      check: 'headers',
      reason: 'Headers: a header line ends in a bare LF',
      from: '(unknown)',
    });
    // An LF-only blank line does not end the block early: the block runs on
    // to the CRLF CRLF and is refused for the bare LF.
    const early = new TextEncoder().encode(
      `${gmailLines().join('\r\n')}\n\nTo: alex@example.net\r\n\r\n`
    );
    expect(refused(checkMail(early, POLICY)).reason).toBe(
      'Headers: a header line ends in a bare LF'
    );
    // CRLF throughout, as IMAP gives it, reads as before.
    expect(checkMail(new TextEncoder().encode(gmail()), POLICY).ok).toBe(true);
    expect(parseHeaderBlock('\r\nFrom: x@example.org\r\n')).toEqual({
      ok: true,
      fields: [],
    });
  });
});

describe('the provider’s header, read whole', () => {
  // The provider's own results for a message from a host the From domain's
  // SPF allows: SPF and so DMARC pass, the sender's own signature fails.
  const SPF_ALIGNED = [
    `Authentication-Results: ${PROVIDER};`,
    '       dkim=fail (signature did not verify) header.i=@example.org header.s=s1 header.b=AbCdEf12;',
    '       spf=pass (example.com: domain of sam.price@example.org designates 192.0.2.66 as permitted sender) smtp.mailfrom=sam.price@example.org;',
    '       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.org',
  ];
  const FORGED_SIG = `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.org; s=s1; h=from:to:subject:date; bh=eA==; b=${SIG_B}`;

  test('a pass the sender folds into the provider’s header is refused beside the provider’s own result for that signature', () => {
    for (const added of [
      '\t; dkim=pass header.d=example.org header.s=s1',
      '\t; dkim=pass header.d=example.org',
      `\t; dkim=pass header.i=@example.org header.s=s1 header.b=${SIG_B.slice(0, 12)}`,
    ]) {
      const r = refused(
        checkMail(
          gmail({ ar: SPF_ALIGNED, middle: [added], dkim: [FORGED_SIG] }),
          POLICY
        )
      );
      expect([added, r.check, r.reason]).toEqual([
        added,
        'dkim',
        'DKIM: the provider’s header also says dkim=fail for the signature that passed',
      ]);
    }
  });

  test('dkim=none, or a DKIM result that names no signature, contradicts a pass', () => {
    for (const [other, said] of [
      ['dkim=none', 'dkim=none'],
      ['dkim=neutral (no key)', 'dkim=neutral'],
    ] as const) {
      const r = refused(
        checkMail(
          gmail({
            ar: [
              `Authentication-Results: ${PROVIDER}; ${other}; dkim=pass header.i=@example.org header.s=20230601 header.b=AbCdEf12; dmarc=pass header.from=example.org`,
            ],
          }),
          POLICY
        )
      );
      expect(r.reason).toBe(
        `DKIM: the provider’s header also says ${said} without naming a signature`
      );
    }
    const twice = refused(
      checkMail(
        gmail({
          ar: [
            `Authentication-Results: ${PROVIDER}; dkim=fail header.d=example.org header.d=example.net; dkim=pass header.i=@example.org header.s=20230601; dmarc=pass header.from=example.org`,
          ],
        }),
        POLICY
      )
    );
    expect(twice.reason).toBe(
      'DKIM: the provider’s header also holds a dkim=fail that gives a property twice'
    );
  });

  test('a failed signature of another domain, or of another selector, does not contradict the pass', () => {
    const ar = [
      `Authentication-Results: ${PROVIDER};`,
      '       dkim=pass header.i=@example.org header.s=20230601 header.b=AbCdEf12;',
      '       dkim=fail (body hash did not verify) header.i=@list.example.net header.s=s2 header.b=ZZZZ;',
      '       dkim=neutral (no key) header.d=example.org header.s=old;',
      '       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.org',
    ];
    const dkim = [
      ...GMAIL_DKIM,
      'DKIM-Signature: v=1; a=rsa-sha256; d=list.example.net; s=s2; h=from:to; bh=eA==; b=ZZZZ',
      'DKIM-Signature: v=1; a=rsa-sha256; d=example.org; s=old; h=from; bh=eA==; b=YYYY',
    ];
    expect(checkMail(gmail({ ar, dkim }), POLICY)).toEqual({
      ok: true,
      from: OWNER,
      dkimDomain: 'example.org',
    });
  });

  test('the provider’s one DMARC result must be a pass for the From domain', () => {
    const dkimPass =
      'dkim=pass header.i=@example.org header.s=20230601 header.b=AbCdEf12';
    const cases: [string, string][] = [
      [
        dkimPass,
        'DMARC: the provider’s header has no DMARC result for example.org; a DKIM pass is read only beside the provider’s DMARC pass (a domain with no DMARC record has none)',
      ],
      [
        `${dkimPass}; dmarc=none header.from=example.org`,
        'DMARC: the provider’s DMARC result for example.org is none',
      ],
      [
        `${dkimPass}; dmarc=fail header.from=example.org`,
        'DMARC: the provider’s DMARC result for example.org is fail',
      ],
      [
        `${dkimPass}; dmarc=fail header.from=example.org; dmarc=pass header.from=example.org`,
        'DMARC: the provider’s header holds 2 DMARC results, so it says nothing certain',
      ],
      [
        `${dkimPass}; dmarc=pass header.from=example.net`,
        'DMARC: the provider’s DMARC pass is for example.net, not example.org',
      ],
      [
        `${dkimPass}; dmarc=pass`,
        'DMARC: the provider’s DMARC pass names no header.from',
      ],
    ];
    for (const [results, reason] of cases) {
      const r = refused(
        checkMail(
          gmail({ ar: [`Authentication-Results: ${PROVIDER}; ${results}`] }),
          POLICY
        )
      );
      expect([results, r.check, r.reason]).toEqual([results, 'dmarc', reason]);
    }
  });

  test('a signer under the same suffix as an allowed sender is not aligned, DMARC pass or not', () => {
    for (const [sender, d] of [
      ['office' + AT + 'acme.uk.com', 'other.uk.com'],
      ['office' + AT + 'acme.eu.org', 'other.eu.org'],
      ['office' + AT + 'acme.kent.sch.uk', 'other.kent.sch.uk'],
    ] as const) {
      const domain = sender.split('@')[1] as string;
      const r = refused(
        checkMail(
          gmail({
            from: `Office <${sender}>`,
            ar: [
              `Authentication-Results: ${PROVIDER}; dkim=pass header.d=${d} header.s=s1; dmarc=pass header.from=${domain}`,
            ],
            dkim: [
              `DKIM-Signature: v=1; a=rsa-sha256; d=${d}; s=s1; h=from:to; bh=eA==; b=${SIG_B}`,
            ],
          }),
          { ...POLICY, allowedSenders: [sender] }
        )
      );
      expect([sender, r.reason]).toEqual([
        sender,
        `DKIM: dkim=pass is for ${d}, which is not aligned with ${domain}`,
      ]);
    }
  });

  test('a parent domain signs for its subdomain', () => {
    const policy = {
      ...POLICY,
      allowedSenders: ['sam' + AT + 'mail.example.org'],
    };
    const decision = checkMail(
      gmail({
        from: 'Sam <sam' + AT + 'mail.example.org>',
        ar: [
          `Authentication-Results: ${PROVIDER}; dkim=pass header.d=example.org header.s=s1; dmarc=pass header.from=mail.example.org`,
        ],
        dkim: [
          `DKIM-Signature: v=1; a=rsa-sha256; d=example.org; s=s1; h=from:to; bh=eA==; b=${SIG_B}`,
        ],
      }),
      policy
    );
    expect(decision).toEqual({
      ok: true,
      from: 'sam' + AT + 'mail.example.org',
      dkimDomain: 'example.org',
    });
  });
});

describe('the sender as a note shows it', () => {
  test('an address with a plain local part is shown whole; a domain as A-labels', () => {
    expect(
      refused(
        checkMail(gmail({ from: 'Mallory <Mallory@Example.NET>' }), POLICY)
      ).from
    ).toBe('mallory@example.net');
    const cyrillic = refused(
      checkMail(gmail({ from: 'Sam <sam.price@exаmple.org>' }), POLICY)
    );
    expect(cyrillic.from).toBe('sam.price' + AT + 'xn--exmple-4nf.org');
    expect(cyrillic.reason).toBe(
      'Sender: sam.price' +
        AT +
        'xn--exmple-4nf.org is not in JOBS_MAIL_ALLOWED_SENDERS'
    );
  });

  test('a quoted, non-ASCII or overlong local part is not shown', () => {
    for (const from of [
      '"Booking confirmed, pay at https://pay.example.net/x"@example.net',
      '"sam price"@example.net',
      'böokings@example.net',
      `${'a'.repeat(65)}@example.net`,
    ]) {
      const r = refused(checkMail(gmail({ from }), POLICY));
      expect([from, r.from, r.reason]).toEqual([
        from,
        '"…"@example.net',
        'Sender: "…"@example.net is not in JOBS_MAIL_ALLOWED_SENDERS',
      ]);
    }
  });

  test('an allowed sender is compared in ASCII case only', () => {
    expect(
      checkMail(gmail({ from: 'Sam <SAM.PRICE@EXAMPLE.ORG>' }), POLICY).ok
    ).toBe(true);
    const kelvin = refused(
      checkMail(gmail({ from: 'Sam <sam.price@example.orgK>' }), POLICY)
    );
    expect(kelvin.check).toBe('sender');
  });
});
