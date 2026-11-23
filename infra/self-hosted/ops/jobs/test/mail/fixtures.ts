// Header blocks for the mail check's tests, shaped like what real providers
// write: a Gmail-style provider receiving mail (ARC headers above its own
// Authentication-Results, `header.i`, `header.s` and `header.b`, an
// oversigned `h=`), a Microsoft 365-style sender (its signature's `h=` leaves
// To out) and receiver (no authserv-id), and a provider that writes many
// methods with comments and quoted strings. Every domain, address and value
// is a placeholder (example.com, example.org, example.net, .example).

import type { MailPolicy } from '../../src/mail/auth';

export const JOBS = 'jobs@example.com';
export const OWNER = 'sam.price@example.org';
export const OFFICE = 'office@acme-productions.example.com';
export const PROVIDER = 'mx.example.com';

export const POLICY: MailPolicy = {
  authservId: PROVIDER,
  allowedSenders: [OWNER, OFFICE, 'sam.price@example.net'],
  jobsAddresses: [JOBS],
};

/** A header block: the lines joined by CRLF, then the empty line. */
export function block(lines: readonly string[]): string {
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/** A signature value starting with the prefix the provider's result quotes. */
export const SIG_B =
  'AbCdEf12GhIjKlMnOpQrStUvWxYz0123456789abcdefghijklmnopqrstuvwxyzAB+/CD==';

export const GMAIL_AR = [
  `Authentication-Results: ${PROVIDER};`,
  '       dkim=pass header.i=@example.org header.s=20230601 header.b=AbCdEf12;',
  '       spf=pass (example.com: domain of sam.price@example.org designates 192.0.2.10 as permitted sender) smtp.mailfrom=sam.price@example.org;',
  '       dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=example.org',
];

export const GMAIL_DKIM = [
  'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;',
  '        d=example.org; s=20230601; t=1803891601; x=1804496401; darn=example.com;',
  '        h=to:subject:message-id:date:from:mime-version:from:to:cc:subject',
  '         :date:message-id:reply-to;',
  '        bh=ZmFrZWJvZHloYXNoZmFrZWJvZHloYXNoZmFrZWI=;',
  `        b=${SIG_B.slice(0, 40)}`,
  `         ${SIG_B.slice(40)}`,
];

export interface GmailParts {
  readonly from?: string;
  readonly to?: string;
  readonly ar?: readonly string[];
  readonly dkim?: readonly string[];
  /** Fields between the provider's header and the message's own. */
  readonly middle?: readonly string[];
  readonly tail?: readonly string[];
}

/** A message as a Gmail-style provider delivers it to the jobs mailbox. */
export function gmailLines(parts: GmailParts = {}): string[] {
  return [
    `Delivered-To: ${JOBS}`,
    'Received: by 2002:a05:6a10:1234:b0:5f1:abcd:ef01 with SMTP id x12csp345678pxa;',
    '        Mon, 1 Mar 2027 09:00:02 -0800 (PST)',
    'X-Received: by 2002:a17:906:abcd:b0:a12:3456:7890 with SMTP id ab12mr123456ejb.1;',
    '        Mon, 01 Mar 2027 09:00:02 -0800 (PST)',
    'ARC-Seal: i=1; a=rsa-sha256; t=1803891602; cv=none;',
    '        d=example.com; s=arc-20240605;',
    '        b=ZmFrZUFSQ3NlYWw=',
    'ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com; s=arc-20240605;',
    '        h=to:subject:message-id:date:from:mime-version:dkim-signature;',
    '        bh=ZmFrZWJvZHloYXNo=; fh=ZmFrZQ==; b=ZmFrZUFSQ21zZw==',
    `ARC-Authentication-Results: i=1; ${PROVIDER};`,
    '       dkim=pass header.i=@example.org header.s=20230601 header.b=AbCdEf12;',
    '       spf=pass (example.com: domain of sam.price@example.org designates 192.0.2.10 as permitted sender) smtp.mailfrom=sam.price@example.org;',
    '       dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=example.org',
    'Return-Path: <sam.price@example.org>',
    'Received: from mail-sor-f41.example.org (mail-sor-f41.example.org. [192.0.2.10])',
    `        by ${PROVIDER} with SMTPS id a640c23a62f3a-a1234567890sor1234567.12.2027.03.01.09.00.02`,
    `        for <${JOBS}>`,
    '        (Transport Security);',
    '        Mon, 01 Mar 2027 09:00:02 -0800 (PST)',
    'Received-SPF: pass (example.com: domain of sam.price@example.org designates 192.0.2.10 as permitted sender) client-ip=192.0.2.10;',
    ...(parts.ar ?? GMAIL_AR),
    ...(parts.middle ?? []),
    ...(parts.dkim ?? GMAIL_DKIM),
    'X-Google-DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=1e100.example; s=20230601; h=x; bh=eA==; b=eA==',
    'X-Gm-Message-State: AOJu0YwFakeStateValue==',
    'MIME-Version: 1.0',
    `From: ${parts.from ?? `Sam Price <${OWNER}>`}`,
    'Date: Mon, 1 Mar 2027 17:00:00 +0000',
    'Message-ID: <CAFakeMessageId0001@mail.example.com>',
    'Subject: Fwd: Leeds Lights Gala - booking',
    `To: ${parts.to ?? JOBS}`,
    'Content-Type: multipart/mixed; boundary="000000000000abcdef0123456789"',
    ...(parts.tail ?? []),
  ];
}

export function gmail(parts: GmailParts = {}): string {
  return block(gmailLines(parts));
}

/**
 * A message from a Microsoft 365-style sender, as the Gmail-style provider
 * delivers it: the sender's signature lists From, Date, Subject, Message-ID,
 * Content-Type, MIME-Version and its own check header, but not To.
 */
export function microsoftSender(): string {
  return block([
    `Delivered-To: ${JOBS}`,
    'Received: from EUR05-AM6-obe.outbound.protection.example.net (mail-am6eur05on2040.outbound.protection.example.net. [192.0.2.40])',
    `        by ${PROVIDER} with ESMTPS id b5-20020a170906abcd;`,
    '        Mon, 01 Mar 2027 09:00:02 -0800 (PST)',
    `Authentication-Results: ${PROVIDER};`,
    '       dkim=pass header.i=@example.net header.s=selector1 header.b=Xy12Ab34;',
    '       arc=pass (i=1 spf=pass spfdomain=example.net dkim=pass dkdomain=example.net dmarc=pass fromdomain=example.net);',
    '       spf=pass (example.com: domain of sam.price@example.net designates 192.0.2.40 as permitted sender) smtp.mailfrom=sam.price@example.net;',
    '       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.net',
    'ARC-Seal: i=1; a=rsa-sha256; s=arcselector10001; d=microsoft.example; cv=none;',
    ' b=ZmFrZUFSQ3NlYWw=',
    'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.net;',
    ' s=selector1;',
    ' h=From:Date:Subject:Message-ID:Content-Type:MIME-Version:X-MS-Exchange-SenderADCheck;',
    ' bh=ZmFrZWJvZHloYXNoZmFrZWJvZHloYXNoZmFrZWI=;',
    ' b=Xy12Ab34ZmFrZVNpZ25hdHVyZVZhbHVlRm9yQVRlc3Q=',
    'From: Sam Price <sam.price@example.net>',
    `To: "${JOBS}" <${JOBS}>`,
    'Subject: FW: Call sheet',
    'Thread-Topic: Call sheet',
    'Thread-Index: AQHZFakeThreadIndex==',
    'Date: Mon, 1 Mar 2027 17:00:00 +0000',
    'Message-ID: <AM6PR05MB1234567890ABCDEF@AM6PR05MB1234.eurprd05.prod.outlook.example>',
    'Accept-Language: en-GB',
    'Content-Language: en-GB',
    'X-MS-Has-Attach: yes',
    'X-MS-Exchange-SenderADCheck: 1',
    'Content-Type: multipart/mixed; boundary="_004_AM6PR05MB_"',
    'MIME-Version: 1.0',
  ]);
}

/** The Authentication-Results a Microsoft 365-style mailbox writes: no authserv-id. */
export const MICROSOFT_AR = [
  'Authentication-Results: spf=pass (sender IP is 192.0.2.10)',
  ' smtp.mailfrom=example.org; dkim=pass (signature was verified)',
  ' header.d=example.org;dmarc=pass action=none',
  ' header.from=example.org;compauth=pass reason=100',
];

/** A provider that writes many methods, with comments and quoted strings, and an authserv-id per host. */
export const HOST = 'mx3.mailhost.example';
export const PROVIDER_AR = [
  `Authentication-Results: ${HOST};`,
  '    arc=none (no signatures found);',
  '    bimi=skipped (DMARC Policy is not at enforcement);',
  '    dkim=pass (2048-bit rsa key sha256) header.d=example.org',
  '      header.i=@example.org header.b="AbCdEf12" header.a=rsa-sha256',
  '      header.s=20230601 x-bits=2048;',
  '    dmarc=pass policy.published-domain-policy=none',
  '      policy.applied-disposition=none policy.evaluated-disposition=none',
  '      (p=none,d=none,d.eval=none) policy.policy-from=p',
  '      header.from=example.org;',
  '    iprev=pass smtp.remote-ip=192.0.2.10 (mail-sor-f41.example.org);',
  '    spf=pass smtp.mailfrom=sam.price@example.org',
  '      smtp.helo=mail-sor-f41.example.org;',
  '    x-aligned-from=pass (Address match);',
  '    x-me-sender=none;',
  '    x-ptr=pass smtp.helo=mail-sor-f41.example.org',
  '      policy.ptr=mail-sor-f41.example.org;',
  '    x-tls=pass smtp.version=TLSv1.3 smtp.cipher=TLS_AES_256_GCM_SHA384',
  '      smtp.bits=256/256',
];

/** A whole message: the header block, then a body that itself looks like headers. */
export function withBody(headers: string): Uint8Array {
  return new TextEncoder().encode(
    `${headers}--000000000000abcdef0123456789\r\nContent-Type: text/plain\r\n\r\nFrom: someone@example.net\r\nAuthentication-Results: ${PROVIDER}; dkim=pass header.d=example.net\r\n--000000000000abcdef0123456789--\r\n`
  );
}
