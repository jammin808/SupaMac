// The mail check (docs/supamac/jobs.md §1), made on a message's header block
// alone, before its body is fetched. Pure: no I/O, no clock.
//
// Invariants:
// - A message is accepted only when every rule holds, checked in this order,
//   and the first that fails is the refusal's named check:
//   1. `from`, `sender`: exactly one From header, holding exactly one
//      mailbox (no group), whose address, compared case-insensitively, is an
//      allowed sender. Case is ASCII case: no other letter (U+212A KELVIN
//      SIGN, say) folds into an ASCII one.
//   2. `authentication-results`, `authserv-id`: the topmost
//      Authentication-Results header, and only that one, parses (RFC 8601,
//      comments and quoted strings included) and carries the provider's
//      authserv-id (compared case-insensitively). A header lower in the
//      block, which anyone sending the message can write, is never read.
//   3. `dkim`: that header shows `dkim=pass` for a domain aligned with the
//      From address's domain (see the choices below). A DMARC or SPF pass
//      alone is not enough.
//   4. `signature`: every DKIM-Signature the passing result names (by its
//      domain, and its selector and signature prefix when the result gives
//      them) parses, is aligned, signs From and To, and has no body length
//      limit (`l=`). When the result does not say which of several
//      signatures of its domain passed, each of them must hold.
//   5. `dkim`: nothing else in that header contradicts the pass: no other
//      DKIM result for a signature the pass names, and no DKIM result that
//      names no signature (`dkim=none`, or one given a property twice).
//   6. `dmarc`: that header holds exactly one DMARC result; it is `pass`,
//      and its `header.from` is the From domain.
//   7. `to`: exactly one To header, holding the jobs address, so mail signed
//      for someone else cannot be replayed into the mailbox.
// - Addresses are read from the raw header values, never from decoded text:
//   an encoded word (RFC 2047) is only ever part of a display name or an
//   address that matches nothing. Display names and comments never count.
// - A header block that does not parse is refused: a line that is neither a
//   field nor a continuation, a bare CR, an LF not preceded by CR (the block
//   ends at its first CRLF CRLF, never at a bare LF, so no reader splitting
//   lines another way sees a header this check did not), a NUL, more than
//   MAX_FIELDS fields or MAX_HEADER_BYTES bytes. So is a From, To or
//   Authentication-Results value that does not parse.
// - The check rests on the provider writing its own Authentication-Results
//   on top of every message it delivers (design, Setup 1). A provider that
//   writes none, or writes one without an authserv-id, has every message
//   refused. A sender can add to that header but never remove from it: a
//   first line the sender starts with a space or tab unfolds (RFC 5322)
//   into the header the provider wrote last, and a provider that copies a
//   value holding an unquoted `;` lets the rest of it read as a result.
//   Rules 5 and 6 are what such an added `dkim=pass` meets: a provider
//   reports a result for each signature it verifies, the sender's own
//   included, and computes DMARC from the same evaluation, so its own
//   `dkim=fail` or `dmarc=fail` stands beside the added pass. Left open: a
//   message from a host the From domain's SPF allows (so the provider's
//   DMARC passes) whose forged signature the provider leaves out of its
//   results.
// - The refusal's text names the failed check and carries only addresses,
//   domains and an authserv-id from the headers, each stripped of control
//   characters and shortened: never a subject or any other content. A
//   sender's address is shown with its local part only when that is a plain
//   ASCII dot-atom of at most 64 characters (otherwise `"…"@<domain>`: a
//   quoted local part is free text the sender chose), and its domain as
//   A-labels, so a look-alike shows as what it is.
//
// Choices where the design is silent, each the more cautious one:
// - Alignment is narrower than DMARC's relaxed alignment, which is the same
//   organisational domain by the Public Suffix List; this module does not
//   hold that list. The signing domain must be the From domain, a subdomain
//   of it, or a parent of it (a DNS parent controls the From domain's
//   delegation, so its signature proves no less), and neither may be a
//   suffix the list below knows. Two siblings (mail.example.org signing for
//   news.example.org) are not aligned, and two registrants under one suffix
//   (acme.uk.com and other.uk.com, whatever the list holds) never are.
// - The DMARC pass of rule 6 is required beyond the design's dkim=pass: a
//   From domain that publishes no DMARC record has its mail refused, saying
//   so (a record with `p=none` is enough).
// - Two To headers are refused: a signature lists To once and covers only
//   the lowest, so another To above it would be unsigned.
// - A DKIM-Signature is read only with every tag RFC 6376 requires (`v=1`,
//   `a`, `b`, `bh`, `d`, `h`, `s`), so each one read is one the provider
//   must have verified. One with a duplicated tag is invalid (§3.2), and one
//   with `l=` is refused, since text appended after the signed length would
//   pass.
// - The provider's result is matched to its signature by `header.d`, else by
//   `header.i` (the signature's `i=`, `@<d>` by default), then narrowed by
//   `header.s` and by `header.b` as a prefix of the signature's `b=`.
// - A result property given twice makes that result count for nothing as a
//   pass, and as anything else it contradicts a pass (rule 5).

import { domainToASCII } from 'node:url';

/** The policy the check applies; addresses and the authserv-id as configured. */
export interface MailPolicy {
  /** JOBS_MAIL_AUTHSERV_ID. */
  readonly authservId: string;
  /** JOBS_MAIL_ALLOWED_SENDERS, lower case. */
  readonly allowedSenders: readonly string[];
  /** The jobs mailbox's own addresses, lower case; empty when unknown. */
  readonly jobsAddresses: readonly string[];
}

export type MailCheckName =
  | 'headers'
  | 'from'
  | 'sender'
  | 'authentication-results'
  | 'authserv-id'
  | 'dkim'
  | 'signature'
  | 'dmarc'
  | 'to';

export type MailDecision =
  | {
      readonly ok: true;
      /** The From address, lower case. */
      readonly from: string;
      /** The signing domain whose pass accepted the message. */
      readonly dkimDomain: string;
    }
  | {
      readonly ok: false;
      readonly check: MailCheckName;
      /** What failed, for the owner's note: the check's label, then why. */
      readonly reason: string;
      /** The sender as far as the headers say, for the owner's note. */
      readonly from: string;
    };

export const MAX_HEADER_BYTES = 1024 * 1024;
export const MAX_FIELDS = 1000;

// ---------------------------------------------------------------------------
// The header block.

export interface HeaderField {
  /** The name as written. */
  readonly name: string;
  /** The name in lower case. */
  readonly key: string;
  /** The value unfolded (CRLF removed, its whitespace kept), trimmed. */
  readonly value: string;
}

export type HeaderBlock =
  | { readonly ok: true; readonly fields: readonly HeaderField[] }
  | { readonly ok: false; readonly reason: string };

const FIELD_LINE = /^([\x21-\x39\x3b-\x7e]+)[ \t]*:([\s\S]*)$/;

/** Lower case for ASCII letters only: no other letter folds into an ASCII one. */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** Where the header block of `text` ends: after the CRLF of its last line. */
function textBlockEnd(text: string): number {
  if (text.startsWith('\r\n')) return 0;
  const blank = text.indexOf('\r\n\r\n');
  return blank < 0 ? text.length : blank + 2;
}

/** Where the header block of `bytes` ends, as textBlockEnd; never far past MAX_HEADER_BYTES. */
function byteBlockEnd(bytes: Uint8Array): number {
  if (bytes[0] === 0x0d && bytes[1] === 0x0a) return 0;
  const limit = Math.min(bytes.length, MAX_HEADER_BYTES + 4);
  for (let i = 0; i + 3 < limit; i++)
    if (
      bytes[i] === 0x0d &&
      bytes[i + 1] === 0x0a &&
      bytes[i + 2] === 0x0d &&
      bytes[i + 3] === 0x0a
    )
      return i + 2;
  return bytes.length;
}

/**
 * The fields of a header block, in order, up to its first empty line (so a
 * whole message may be given). Lines end in CRLF; see the header for what is
 * refused.
 */
export function parseHeaderBlock(input: Uint8Array | string): HeaderBlock {
  let text: string;
  if (typeof input === 'string') {
    text = input.slice(0, textBlockEnd(input));
  } else {
    const end = byteBlockEnd(input);
    if (end > MAX_HEADER_BYTES)
      return { ok: false, reason: 'the header block is too large' };
    text = new TextDecoder('utf-8').decode(input.subarray(0, end));
  }
  const fields: { name: string; value: string }[] = [];
  let size = 0;
  for (const line of text.split('\r\n')) {
    size += line.length + 2;
    if (size > MAX_HEADER_BYTES)
      return { ok: false, reason: 'the header block is too large' };
    if (line === '') break;
    if (line.includes('\n'))
      return { ok: false, reason: 'a header line ends in a bare LF' };
    if (line.includes('\r') || line.includes('\0'))
      return { ok: false, reason: 'a header line holds a bare CR or a NUL' };
    if (line[0] === ' ' || line[0] === '\t') {
      const current = fields[fields.length - 1];
      if (current === undefined)
        return {
          ok: false,
          reason: 'the header block starts with a continuation line',
        };
      current.value += line;
      continue;
    }
    const m = FIELD_LINE.exec(line);
    if (m === null)
      return { ok: false, reason: 'a header line is not a header field' };
    if (fields.length >= MAX_FIELDS)
      return { ok: false, reason: 'the message has too many header fields' };
    fields.push({ name: m[1] as string, value: m[2] as string });
  }
  return {
    ok: true,
    fields: fields.map((f) => ({
      name: f.name,
      key: f.name.toLowerCase(),
      value: f.value.replace(/^[ \t]+|[ \t]+$/g, ''),
    })),
  };
}

// ---------------------------------------------------------------------------
// Addresses (RFC 5322 address-list, read strictly; obsolete forms refused).

type AddressToken =
  | { readonly t: 'atom'; readonly v: string }
  | { readonly t: 'quoted'; readonly v: string }
  | { readonly t: 'literal'; readonly v: string }
  | { readonly t: 'special'; readonly v: string };

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/;
const ADDRESS_STOP = new Set([
  ' ',
  '\t',
  '(',
  ')',
  '"',
  '[',
  ']',
  '<',
  '>',
  '@',
  ',',
  ':',
  ';',
  '\\',
]);

function lexAddresses(value: string): AddressToken[] | undefined {
  if (CONTROL.test(value)) return undefined;
  const out: AddressToken[] = [];
  let i = 0;
  const n = value.length;
  while (i < n) {
    const c = value[i] as string;
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '(') {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const d = value[i];
        if (d === '\\') {
          i += 2;
          continue;
        }
        if (d === '(') depth++;
        else if (d === ')') depth--;
        i++;
      }
      if (depth > 0) return undefined;
      continue;
    }
    if (c === '"') {
      const q = readQuoted(value, i);
      if (q === undefined) return undefined;
      out.push({ t: 'quoted', v: q.value });
      i = q.end;
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      let v = '';
      let closed = false;
      while (j < n) {
        const d = value[j] as string;
        if (d === '\\' || d === '[') return undefined;
        if (d === ']') {
          closed = true;
          j++;
          break;
        }
        v += d;
        j++;
      }
      if (!closed) return undefined;
      out.push({ t: 'literal', v: v.trim() });
      i = j;
      continue;
    }
    if (c === '<' || c === '>' || c === '@' || c === ',' || c === ':') {
      out.push({ t: 'special', v: c });
      i++;
      continue;
    }
    if (c === ';') {
      out.push({ t: 'special', v: c });
      i++;
      continue;
    }
    if (ADDRESS_STOP.has(c)) return undefined;
    let j = i;
    while (j < n && !ADDRESS_STOP.has(value[j] as string)) j++;
    out.push({ t: 'atom', v: value.slice(i, j) });
    i = j;
  }
  return out;
}

/** A quoted string at `start` (its opening quote): its content unescaped, and where it ends. */
function readQuoted(
  text: string,
  start: number
): { value: string; end: number } | undefined {
  let value = '';
  let i = start + 1;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '\\') {
      if (i + 1 >= text.length) return undefined;
      value += text[i + 1];
      i += 2;
      continue;
    }
    if (c === '"') return { value, end: i + 1 };
    value += c;
    i++;
  }
  return undefined;
}

const DOT_ATOM =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~\u0080-\uffff-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~\u0080-\uffff-]+)*$/u;

export interface Mailbox {
  /** local@domain, ASCII letters in lower case. */
  readonly address: string;
  /** The domain, ASCII letters in lower case (a literal keeps its brackets). */
  readonly domain: string;
}

export type AddressList =
  | {
      readonly ok: true;
      readonly mailboxes: readonly Mailbox[];
      /** How many groups the list holds. */
      readonly groups: number;
    }
  | { readonly ok: false };

function isSpecial(token: AddressToken | undefined, v: string): boolean {
  return token?.t === 'special' && token.v === v;
}

/** The mailboxes of an address-list header value (From, To). */
export function parseAddressList(value: string): AddressList {
  const tokens = lexAddresses(value);
  if (tokens === undefined) return { ok: false };
  const mailboxes: Mailbox[] = [];
  let groups = 0;
  let pos = 0;

  const addrSpec = (from: number, to: number): Mailbox | undefined => {
    if (to - from !== 3) return undefined;
    const local = tokens[from];
    const at = tokens[from + 1];
    const domain = tokens[from + 2];
    if (!isSpecial(at, '@')) return undefined;
    let localText: string;
    if (local?.t === 'atom' && DOT_ATOM.test(local.v)) localText = local.v;
    else if (local?.t === 'quoted')
      localText = DOT_ATOM.test(local.v)
        ? local.v
        : `"${local.v.replace(/(["\\])/g, '\\$1')}"`;
    else return undefined;
    let domainText: string;
    if (domain?.t === 'atom' && DOT_ATOM.test(domain.v))
      domainText = asciiLower(domain.v);
    else if (domain?.t === 'literal') domainText = `[${asciiLower(domain.v)}]`;
    else return undefined;
    return {
      address: asciiLower(`${localText}@${domainText}`),
      domain: domainText,
    };
  };

  /** One mailbox from `pos` up to a token in `ends` (or the end). */
  const mailbox = (ends: readonly string[]): Mailbox | undefined => {
    let end = pos;
    while (end < tokens.length && !ends.some((e) => isSpecial(tokens[end], e)))
      end++;
    const open = tokens.findIndex(
      (t, k) => k >= pos && k < end && isSpecial(t, '<')
    );
    let found: Mailbox | undefined;
    if (open >= 0) {
      for (let k = pos; k < open; k++) {
        const t = tokens[k];
        if (t?.t !== 'atom' && t?.t !== 'quoted') return undefined;
      }
      if (!isSpecial(tokens[end - 1], '>')) return undefined;
      found = addrSpec(open + 1, end - 1);
    } else {
      found = addrSpec(pos, end);
    }
    if (found === undefined) return undefined;
    pos = end;
    return found;
  };

  while (pos < tokens.length) {
    if (isSpecial(tokens[pos], ',')) {
      pos++;
      continue;
    }
    // A group: a display name, then ':'.
    let k = pos;
    while (k < tokens.length) {
      const t = tokens[k];
      if (t?.t !== 'atom' && t?.t !== 'quoted') break;
      k++;
    }
    if (isSpecial(tokens[k], ':')) {
      groups++;
      pos = k + 1;
      while (pos < tokens.length && !isSpecial(tokens[pos], ';')) {
        if (isSpecial(tokens[pos], ',')) {
          pos++;
          continue;
        }
        const m = mailbox([',', ';']);
        if (m === undefined) return { ok: false };
        mailboxes.push(m);
      }
      if (!isSpecial(tokens[pos], ';')) return { ok: false };
      pos++;
    } else {
      const m = mailbox([',']);
      if (m === undefined) return { ok: false };
      mailboxes.push(m);
    }
    if (pos < tokens.length && !isSpecial(tokens[pos], ','))
      return { ok: false };
  }
  return { ok: true, mailboxes, groups };
}

// ---------------------------------------------------------------------------
// Authentication-Results (RFC 8601).

export interface AuthResult {
  /** The method, lower case (`dkim`, `spf`, `dmarc`, ...). */
  readonly method: string;
  /** The result, lower case (`pass`, `fail`, ...). */
  readonly result: string;
  /** `ptype.property` (lower case) to value, and `reason`. */
  readonly properties: ReadonlyMap<string, string>;
  /** A property was given twice: the result says nothing certain. */
  readonly ambiguous: boolean;
}

export interface AuthenticationResults {
  /** Undefined when the header starts with a result instead. */
  readonly authservId: string | undefined;
  readonly results: readonly AuthResult[];
}

/** The text with every comment replaced by a space; undefined when unbalanced. */
function stripComments(text: string): string | undefined {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      out += c;
      if (c === '\\') {
        if (i + 1 >= text.length) return undefined;
        out += text[++i];
      } else if (c === '"') quoted = false;
      continue;
    }
    if (depth > 0) {
      if (c === '\\') {
        if (i + 1 >= text.length) return undefined;
        i++;
      } else if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) out += ' ';
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
      out += c;
    } else if (c === '(') depth = 1;
    else if (c === ')') return undefined;
    else out += c;
  }
  return quoted || depth > 0 ? undefined : out;
}

/** Splits on `;` outside quoted strings. */
function splitSemicolons(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      current += c;
      if (c === '\\' && i + 1 < text.length) current += text[++i];
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    if (c === ';') {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: a token holds no control character
const TOKEN = /^[^\s()<>@,;:\\"/[\]?=\x00-\x1f\x7f]+$/;
const KEYWORD = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/;
const PROPERTY = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/;

function parseAuthservId(head: string): string | undefined {
  if (head.startsWith('"')) {
    const q = readQuoted(head, 0);
    if (q === undefined) return undefined;
    const rest = head.slice(q.end).trim();
    if (rest !== '' && !/^\d+$/.test(rest)) return undefined;
    return q.value === '' ? undefined : q.value;
  }
  const m = /^(\S+)(?:[ \t]+(\d+))?$/.exec(head);
  if (m === null || !TOKEN.test(m[1] as string)) return undefined;
  return m[1];
}

function parseResinfo(segment: string): AuthResult | undefined {
  let i = 0;
  const s = segment;
  const ws = (): void => {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  };
  const match = (re: RegExp): string | undefined => {
    const m = re.exec(s.slice(i));
    if (m === null) return undefined;
    i += m[0].length;
    return m[0];
  };
  ws();
  const method = match(KEYWORD);
  if (method === undefined) return undefined;
  ws();
  if (s[i] === '/') {
    i++;
    ws();
    if (match(/^\d+/) === undefined) return undefined;
    ws();
  }
  if (s[i] !== '=') return undefined;
  i++;
  ws();
  const result = match(KEYWORD);
  if (result === undefined) return undefined;
  const properties = new Map<string, string>();
  let ambiguous = false;
  for (;;) {
    ws();
    if (i >= s.length) break;
    const key = match(PROPERTY);
    if (key === undefined) return undefined;
    ws();
    if (s[i] !== '=') return undefined;
    i++;
    ws();
    let value: string;
    if (s[i] === '"') {
      const q = readQuoted(s, i);
      if (q === undefined) return undefined;
      value = q.value;
      i = q.end;
    } else {
      const v = match(/^[^\s"]+/);
      if (v === undefined) return undefined;
      value = v;
    }
    const name = key.toLowerCase();
    if (properties.has(name)) ambiguous = true;
    properties.set(name, value);
  }
  return {
    method: method.toLowerCase(),
    result: result.toLowerCase(),
    properties,
    ambiguous,
  };
}

/** An Authentication-Results value; undefined when it does not parse. */
export function parseAuthenticationResults(
  value: string
): AuthenticationResults | undefined {
  if (CONTROL.test(value)) return undefined;
  const stripped = stripComments(value);
  if (stripped === undefined) return undefined;
  const [first = '', ...rest] = splitSemicolons(stripped);
  const head = first.trim();
  let authservId: string | undefined;
  const results: AuthResult[] = [];
  if (!head.startsWith('"') && head.includes('=')) {
    const r = parseResinfo(head);
    if (r === undefined) return undefined;
    results.push(r);
  } else {
    authservId = parseAuthservId(head);
    if (authservId === undefined) return undefined;
  }
  for (const segment of rest) {
    const s = segment.trim();
    if (s === '' || /^none$/i.test(s)) continue;
    const r = parseResinfo(s);
    if (r === undefined) return undefined;
    results.push(r);
  }
  return { authservId, results };
}

// ---------------------------------------------------------------------------
// DKIM-Signature (RFC 6376 §3.5), the tags the check needs.

export interface DkimSignature {
  /** The signing domain, normalised. */
  readonly d: string;
  /** The selector, ASCII letters in lower case. */
  readonly s: string;
  /** The agent identifier, ASCII letters in lower case; `@<d>` when not given. */
  readonly i: string;
  /** The signed header names, lower case, in order. */
  readonly h: readonly string[];
  /** The signature, whitespace removed. */
  readonly b: string;
  /** Whether it limits the signed body length. */
  readonly bodyLimit: boolean;
}

/**
 * A DKIM-Signature value; undefined when it is not a valid signature: a tag
 * RFC 6376 requires is missing or empty, `v` is not 1, or a tag repeats.
 */
export function parseDkimSignature(value: string): DkimSignature | undefined {
  const tags = new Map<string, string>();
  for (const part of value.split(';')) {
    const p = part.trim();
    if (p === '') continue;
    const m = /^([A-Za-z][A-Za-z0-9_]*)[ \t]*=([\s\S]*)$/.exec(p);
    if (m === null) return undefined;
    const name = m[1] as string;
    if (tags.has(name)) return undefined;
    tags.set(name, (m[2] as string).trim());
  }
  if (tags.get('v') !== '1') return undefined;
  if ((tags.get('a') ?? '') === '' || (tags.get('bh') ?? '') === '')
    return undefined;
  const d = normaliseDomain(tags.get('d') ?? '');
  const h = tags.get('h');
  const b = tags.get('b');
  const s = asciiLower(tags.get('s')?.replace(/\s/g, '') ?? '');
  if (d === undefined || h === undefined || b === undefined || s === '')
    return undefined;
  const headers = h
    .split(':')
    .map((x) => asciiLower(x.replace(/\s/g, '')))
    .filter((x) => x !== '');
  if (headers.length === 0) return undefined;
  const i = asciiLower(tags.get('i')?.replace(/\s/g, '') ?? '');
  return {
    d,
    s,
    i: i !== '' ? i : `@${d}`,
    h: headers,
    b: b.replace(/\s/g, ''),
    bodyLimit: tags.has('l'),
  };
}

// ---------------------------------------------------------------------------
// Domains and alignment.

/** A domain in lower-case ASCII (A-labels), with no trailing dot; undefined when it is not one. */
export function normaliseDomain(domain: string): string | undefined {
  let d = domain.trim().replace(/\.$/, '');
  if (d === '' || /[\s@]/.test(d)) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this finds any character outside ASCII
  if (/[^\x00-\x7f]/.test(d)) d = domainToASCII(d);
  d = d.toLowerCase();
  if (
    !/^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9])?)+$/.test(
      d
    )
  )
    return undefined;
  return d;
}

// The suffixes under which names are registered at the third level. This is
// not the Public Suffix List: it is the common multi-label suffixes, plus
// every `ac`, `co`, `com`, `edu`, `gov`, `net` or `org` under a two-letter
// country code. It only refuses a pass for a suffix itself (`co.uk`);
// alignment never treats two domains under one suffix as one organisation
// (see the header), so a suffix it lacks lets no other registrant align.
const MULTI_LABEL_SUFFIXES = new Set([
  'ltd.uk',
  'me.uk',
  'nhs.uk',
  'plc.uk',
  'police.uk',
  'sch.uk',
  'asn.au',
  'id.au',
  'ad.jp',
  'ed.jp',
  'go.jp',
  'gr.jp',
  'lg.jp',
  'ne.jp',
  'or.jp',
  'geek.nz',
  'gen.nz',
  'govt.nz',
  'kiwi.nz',
  'maori.nz',
  'school.nz',
  'go.kr',
  'ne.kr',
  'or.kr',
  're.kr',
  'firm.in',
  'gen.in',
  'ind.in',
  'res.in',
  'gob.ar',
  'gob.es',
  'nom.es',
  'gob.mx',
  'go.th',
  'in.th',
  'or.th',
  'go.id',
  'or.id',
  'sch.id',
  'web.id',
  'idv.tw',
  'idv.hk',
  'gen.tr',
  'k12.tr',
  'muni.il',
  'ne.ke',
  'or.ke',
  'go.ke',
]);
const COUNTRY_SECOND_LEVELS = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'gov',
  'net',
  'org',
]);

function multiLabelSuffix(last2: string): boolean {
  if (MULTI_LABEL_SUFFIXES.has(last2)) return true;
  const [second, tld] = last2.split('.') as [string, string];
  return /^[a-z]{2}$/.test(tld) && COUNTRY_SECOND_LEVELS.has(second);
}

/** The registered domain under the suffixes above; undefined for a suffix itself. */
export function organisationalDomain(domain: string): string | undefined {
  const d = normaliseDomain(domain);
  if (d === undefined) return undefined;
  const labels = d.split('.');
  if (labels.length < 2) return undefined;
  const suffixLength = multiLabelSuffix(labels.slice(-2).join('.')) ? 2 : 1;
  if (labels.length <= suffixLength) return undefined;
  return labels.slice(-(suffixLength + 1)).join('.');
}

/**
 * Whether a signing domain is aligned with the From domain (either order):
 * the same domain, or one a subdomain of the other, and neither a suffix
 * itself. See the header for why this is narrower than DMARC's.
 */
export function aligned(a: string, b: string): boolean {
  const da = normaliseDomain(a);
  const db = normaliseDomain(b);
  if (da === undefined || db === undefined) return false;
  if (
    organisationalDomain(da) === undefined ||
    organisationalDomain(db) === undefined
  )
    return false;
  return da === db || da.endsWith(`.${db}`) || db.endsWith(`.${da}`);
}

// ---------------------------------------------------------------------------
// The check.

/** Message text made safe and short for a note. */
function shown(text: string, max = 120): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
  const clean = text.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const ASCII_DOT_ATOM =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const ADDRESS_LITERAL = /^\[(?:ipv6:)?[0-9a-f.:]+\]$/i;

/**
 * An address as a note shows it (see the header): the local part only when
 * it is a plain ASCII dot-atom, the domain as A-labels.
 */
function noteAddress(address: string): string {
  const at = address.lastIndexOf('@');
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const shownLocal =
    local.length <= 64 && ASCII_DOT_ATOM.test(local) ? local : '"…"';
  const shownDomain = ADDRESS_LITERAL.test(domain)
    ? domain
    : (normaliseDomain(domain) ?? '…');
  return shown(`${shownLocal}@${shownDomain}`);
}

function refuse(
  check: MailCheckName,
  reason: string,
  from: string
): MailDecision {
  const label: Record<MailCheckName, string> = {
    headers: 'Headers',
    from: 'From',
    sender: 'Sender',
    'authentication-results': 'Authentication-Results',
    'authserv-id': 'Authentication-Results',
    dkim: 'DKIM',
    signature: 'DKIM signature',
    dmarc: 'DMARC',
    to: 'To',
  };
  return { ok: false, check, reason: `${label[check]}: ${reason}`, from };
}

interface Named {
  /** The domain the result names, normalised. */
  readonly domain: string;
  /** The message's signatures it can be about. */
  readonly candidates: readonly DkimSignature[];
}

/**
 * The signatures a DKIM result names (see the header's matching rule);
 * undefined when it names no domain that parses.
 */
function namedSignatures(
  result: AuthResult,
  signatures: readonly DkimSignature[]
): Named | undefined {
  const headerD = result.properties.get('header.d');
  const headerI = result.properties.get('header.i');
  const headerS = result.properties.get('header.s');
  const headerB = result.properties.get('header.b');
  let domain: string | undefined;
  let candidates: DkimSignature[];
  if (headerD !== undefined) {
    domain = normaliseDomain(headerD);
    if (domain === undefined) return undefined;
    candidates = signatures.filter((s) => s.d === domain);
  } else if (headerI !== undefined) {
    const i = asciiLower(headerI);
    const at = i.lastIndexOf('@');
    domain = at >= 0 ? normaliseDomain(i.slice(at + 1)) : undefined;
    if (domain === undefined) return undefined;
    candidates = signatures.filter((s) => s.i === i);
  } else {
    return undefined;
  }
  if (headerS !== undefined) {
    const s = asciiLower(headerS);
    candidates = candidates.filter((x) => x.s === s);
  }
  if (headerB !== undefined)
    candidates = candidates.filter((x) => x.b.startsWith(headerB));
  return { domain, candidates };
}

type PassOutcome =
  | {
      readonly kind: 'ok';
      readonly domain: string;
      readonly result: AuthResult;
      readonly signatures: readonly DkimSignature[];
    }
  | { readonly kind: 'unaligned'; readonly domain: string }
  | { readonly kind: 'signature'; readonly reason: string };

function evaluatePass(
  result: AuthResult,
  fromDomain: string,
  signatures: readonly DkimSignature[]
): PassOutcome | undefined {
  const named = namedSignatures(result, signatures);
  if (named === undefined) return undefined;
  const { domain, candidates } = named;
  if (!aligned(domain, fromDomain)) return { kind: 'unaligned', domain };
  if (candidates.length === 0)
    return {
      kind: 'signature',
      reason: `no DKIM-Signature header matches the dkim=pass for ${shown(domain)}`,
    };
  for (const sig of candidates) {
    if (!aligned(sig.d, fromDomain))
      return {
        kind: 'signature',
        reason: `the signature for ${shown(sig.d)} is not aligned with ${shown(fromDomain)}`,
      };
    if (sig.bodyLimit)
      return {
        kind: 'signature',
        reason: `the signature for ${shown(sig.d)} signs only part of the body (l=)`,
      };
    if (!sig.h.includes('from'))
      return {
        kind: 'signature',
        reason: `the signature for ${shown(sig.d)} does not cover From`,
      };
    if (!sig.h.includes('to'))
      return {
        kind: 'signature',
        reason: `the signature for ${shown(sig.d)} does not cover To, so it could be replayed from mail sent to someone else`,
      };
  }
  return { kind: 'ok', domain, result, signatures: candidates };
}

/** Rule 5: what else in the provider's header says the pass is not its own; undefined when nothing does. */
function contradiction(
  ar: AuthenticationResults,
  pass: Extract<PassOutcome, { kind: 'ok' }>,
  signatures: readonly DkimSignature[]
): string | undefined {
  for (const r of ar.results) {
    if (r.method !== 'dkim' || r === pass.result) continue;
    if (r.result === 'pass' && !r.ambiguous) continue;
    const said = `dkim=${shown(r.result, 20)}`;
    if (r.ambiguous)
      return `the provider’s header also holds a ${said} that gives a property twice`;
    const named = namedSignatures(r, signatures);
    if (named === undefined)
      return `the provider’s header also says ${said} without naming a signature`;
    if (named.candidates.some((s) => pass.signatures.includes(s)))
      return `the provider’s header also says ${said} for the signature that passed`;
  }
  return undefined;
}

/** Rule 6: why the provider's DMARC result does not stand with the pass; undefined when it does. */
function dmarcProblem(
  ar: AuthenticationResults,
  fromDomain: string
): string | undefined {
  const dmarcs = ar.results.filter((r) => r.method === 'dmarc');
  if (dmarcs.length === 0)
    return `the provider’s header has no DMARC result for ${shown(fromDomain)}; a DKIM pass is read only beside the provider’s DMARC pass (a domain with no DMARC record has none)`;
  if (dmarcs.length > 1)
    return `the provider’s header holds ${dmarcs.length} DMARC results, so it says nothing certain`;
  const dmarc = dmarcs[0] as AuthResult;
  if (dmarc.ambiguous)
    return 'the provider’s DMARC result gives a property twice';
  if (dmarc.result !== 'pass')
    return `the provider’s DMARC result for ${shown(fromDomain)} is ${shown(dmarc.result, 20)}`;
  const headerFrom = dmarc.properties.get('header.from');
  if (headerFrom === undefined)
    return 'the provider’s DMARC pass names no header.from';
  const domain = normaliseDomain(headerFrom);
  if (domain !== fromDomain)
    return `the provider’s DMARC pass is for ${shown(domain ?? headerFrom)}, not ${shown(fromDomain)}`;
  return undefined;
}

/** The mail check of design §1 on a header block (or a whole message). */
export function checkMail(
  headers: Uint8Array | string,
  policy: MailPolicy
): MailDecision {
  const block = parseHeaderBlock(headers);
  if (!block.ok) return refuse('headers', block.reason, '(unknown)');
  const fields = block.fields;

  // 1. From.
  const froms = fields.filter((f) => f.key === 'from');
  if (froms.length === 0)
    return refuse('from', 'the message has no From header', '(no From)');
  const fromList = froms.flatMap((f) => {
    const list = parseAddressList(f.value);
    return list.ok ? list.mailboxes.map((m) => noteAddress(m.address)) : [];
  });
  const shownFrom =
    fromList.length > 0
      ? shown(fromList.join(', '))
      : '(the From header does not parse)';
  if (froms.length > 1)
    return refuse(
      'from',
      `the message has ${froms.length} From headers`,
      shownFrom
    );
  const list = parseAddressList((froms[0] as HeaderField).value);
  if (!list.ok)
    return refuse('from', 'the From header does not parse', shownFrom);
  if (list.groups > 0)
    return refuse('from', 'the From header holds a group', shownFrom);
  if (list.mailboxes.length !== 1)
    return refuse(
      'from',
      `the From header holds ${list.mailboxes.length} addresses, not one`,
      shownFrom
    );
  const sender = list.mailboxes[0] as Mailbox;
  if (!policy.allowedSenders.includes(sender.address)) {
    const who = noteAddress(sender.address);
    return refuse('sender', `${who} is not in JOBS_MAIL_ALLOWED_SENDERS`, who);
  }
  const from = sender.address;
  const fromDomain = normaliseDomain(sender.domain);
  if (fromDomain === undefined)
    return refuse('from', 'the From address has no domain to align', from);

  // 2. The topmost Authentication-Results, and only it.
  const top = fields.find((f) => f.key === 'authentication-results');
  if (top === undefined)
    return refuse(
      'authentication-results',
      'the message has no Authentication-Results header',
      from
    );
  const ar = parseAuthenticationResults(top.value);
  if (ar === undefined)
    return refuse(
      'authentication-results',
      'the topmost Authentication-Results header does not parse',
      from
    );
  if (ar.authservId === undefined)
    return refuse(
      'authserv-id',
      'the topmost Authentication-Results header names no authserv-id',
      from
    );
  if (asciiLower(ar.authservId) !== asciiLower(policy.authservId))
    return refuse(
      'authserv-id',
      `the topmost Authentication-Results header is from ${shown(ar.authservId, 80)}, not ${shown(policy.authservId, 80)}`,
      from
    );

  // 3 and 4. A DKIM pass aligned with From, whose signature covers To.
  const signatures = fields
    .filter((f) => f.key === 'dkim-signature')
    .map((f) => parseDkimSignature(f.value))
    .filter((s): s is DkimSignature => s !== undefined);
  const passes = ar.results.filter(
    (r) => r.method === 'dkim' && r.result === 'pass' && !r.ambiguous
  );
  const outcomes = passes
    .map((r) => evaluatePass(r, fromDomain, signatures))
    .filter((o): o is PassOutcome => o !== undefined);
  const accepted = outcomes.find(
    (o): o is Extract<PassOutcome, { kind: 'ok' }> => o.kind === 'ok'
  );
  if (accepted === undefined) {
    const signature = outcomes.find((o) => o.kind === 'signature');
    if (signature !== undefined)
      return refuse('signature', signature.reason, from);
    const unaligned = outcomes.filter((o) => o.kind === 'unaligned');
    if (unaligned.length > 0)
      return refuse(
        'dkim',
        `dkim=pass is for ${shown(unaligned.map((o) => o.domain).join(', '))}, which is not aligned with ${shown(fromDomain)}`,
        from
      );
    const others = ar.results
      .filter(
        (r) =>
          (r.method === 'dmarc' || r.method === 'spf') && r.result === 'pass'
      )
      .map((r) => r.method.toUpperCase());
    return refuse(
      'dkim',
      others.length > 0
        ? `no dkim=pass; ${[...new Set(others)].join(' and ')} passed, which is not enough`
        : 'no dkim=pass',
      from
    );
  }

  // 5. Nothing else the provider says contradicts the pass.
  const against = contradiction(ar, accepted, signatures);
  if (against !== undefined) return refuse('dkim', against, from);

  // 6. The provider's own DMARC pass for the From domain.
  const dmarc = dmarcProblem(ar, fromDomain);
  if (dmarc !== undefined) return refuse('dmarc', dmarc, from);

  // 7. To holds the jobs address.
  const tos = fields.filter((f) => f.key === 'to');
  if (tos.length !== 1)
    return refuse(
      'to',
      tos.length === 0
        ? 'the message has no To header'
        : `the message has ${tos.length} To headers`,
      from
    );
  const toList = parseAddressList((tos[0] as HeaderField).value);
  if (!toList.ok) return refuse('to', 'the To header does not parse', from);
  if (policy.jobsAddresses.length === 0)
    return refuse(
      'to',
      'the jobs address is not known (JOBS_MAIL_USER is not an email address)',
      from
    );
  if (!toList.mailboxes.some((m) => policy.jobsAddresses.includes(m.address)))
    return refuse(
      'to',
      'To does not hold the jobs address, so the message was signed for someone else',
      from
    );
  return { ok: true, from, dkimDomain: accepted.domain };
}
