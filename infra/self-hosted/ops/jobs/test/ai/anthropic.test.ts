import { describe, expect, test } from 'bun:test';
import { APIConnectionError } from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  AiError,
  COMPUTED_LABEL,
  cacheWritesOf,
  classifyError,
  DEFAULT_MODEL,
  DEFAULT_PRICES,
  FALLBACK_BETA,
  MemoryLedger,
  monthOf,
  parseStructured,
  priceUsage,
} from '../../src/ai/anthropic';
import {
  aiClient,
  FakeClient,
  fallbackBlock,
  httpError,
  jsonReply,
  message,
  refusal,
  streamError,
  text,
  usage,
} from './fake';

const Reply = z.object({ venue: z.string() });

const REQUEST = {
  purpose: 'extraction' as const,
  key: 'hash-1',
  effort: 'high' as const,
  maxTokens: 8_000,
  system: [{ type: 'text' as const, text: 'Read the source.' }],
  messages: [{ role: 'user' as const, content: 'Venue: Acme Arena' }],
};

describe('the request body', () => {
  test('streams with max_tokens, explicit effort and default fallbacks, and nothing banned', async () => {
    const fake = new FakeClient([jsonReply({ venue: 'Acme Arena' })]);
    const { ai } = aiClient(fake);
    const out = await ai.callStructured(REQUEST, Reply);
    expect(out.kind).toBe('ok');
    const body = fake.requests[0];
    expect(body?.model).toBe(DEFAULT_MODEL);
    expect(body?.max_tokens).toBe(8_000);
    expect(body?.output_config?.effort).toBe('high');
    expect(body?.output_config?.format?.type).toBe('json_schema');
    expect(body?.betas).toEqual([FALLBACK_BETA]);
    expect(body?.fallbacks).toBe('default');
    for (const banned of [
      'thinking',
      'temperature',
      'top_p',
      'top_k',
      'tool_choice',
      'tools',
    ])
      expect(body && banned in body).toBe(false);
  });

  test('fallbacks can be switched off', async () => {
    const fake = new FakeClient([jsonReply({ venue: 'Acme Arena' })]);
    const { ai } = aiClient(fake, { fallbacks: false });
    await ai.callStructured(REQUEST, Reply);
    expect(fake.requests[0]?.betas).toBeUndefined();
    expect(fake.requests[0]?.fallbacks).toBeUndefined();
  });

  test('the token count is of the same prompt, without the sending fields', async () => {
    const fake = new FakeClient([jsonReply({ venue: 'Acme Arena' })]);
    const { ai } = aiClient(fake);
    await ai.callStructured(REQUEST, Reply);
    const counted = fake.counted[0];
    expect(counted?.messages).toEqual(fake.requests[0]?.messages ?? []);
    expect(counted?.system).toEqual(fake.requests[0]?.system ?? []);
    expect(counted && 'max_tokens' in counted).toBe(false);
    expect(counted && 'fallbacks' in counted).toBe(false);
  });

  test('a request without a positive max_tokens is refused before any call', async () => {
    const fake = new FakeClient([]);
    const { ai } = aiClient(fake);
    const out = await ai.call({ ...REQUEST, maxTokens: 0 });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.error.kind).toBe('config');
    expect(fake.counted).toHaveLength(0);
  });
});

describe('outcomes', () => {
  test('a normal structured reply is validated and its cost recorded as computed', async () => {
    const fake = new FakeClient([
      jsonReply(
        { venue: 'Acme Arena' },
        usage(10_000, 2_000, { cacheRead: 5_000, cacheWrite: 1_000 })
      ),
    ]);
    const { ai, ledger } = aiClient(fake);
    const out = await ai.callStructured(REQUEST, Reply);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value).toEqual({ venue: 'Acme Arena' });
    // 10,000 x $4 + 2,000 x $20 + 5,000 x $0.20 + 1,000 x $5, per million.
    expect(out.spend.usd).toBeCloseTo(0.086, 10);
    expect(out.spend.computed).toBe(true);
    expect(out.spend.label).toBe(COMPUTED_LABEL);
    expect(out.spend.month).toBe('2027-03');
    expect(out.spend.key).toBe('hash-1');
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.spent('2027-03')).toBeCloseTo(0.086, 10);
  });

  test('a refusal is a typed result, and its tokens are still recorded', async () => {
    const fake = new FakeClient([refusal('cyber')]);
    const { ai, ledger } = aiClient(fake);
    const out = await ai.callStructured(REQUEST, Reply);
    expect(out.kind).toBe('refusal');
    if (out.kind !== 'refusal') return;
    expect(out.category).toBe('cyber');
    expect(out.reason).toContain('declined');
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.tokens.input).toBe(2_000);
  });

  test('max_tokens is a cut-short result, never parsed', async () => {
    const fake = new FakeClient([
      message({ content: [text('{"venue": "Acme Ar')], stop: 'max_tokens' }),
    ]);
    const { ai } = aiClient(fake);
    const out = await ai.callStructured(REQUEST, Reply);
    expect(out.kind).toBe('cut_short');
    if (out.kind === 'cut_short') expect(out.stopReason).toBe('max_tokens');
  });

  test('invalid JSON and a schema mismatch are typed invalid results', async () => {
    const fake = new FakeClient([
      message({ content: [text('Venue: Acme Arena')], stop: 'end_turn' }),
      jsonReply({ place: 'Acme Arena' }),
    ]);
    const { ai } = aiClient(fake);
    const first = await ai.callStructured(REQUEST, Reply);
    expect(first.kind).toBe('invalid');
    if (first.kind === 'invalid') {
      expect(first.failure).toBe('invalid_json');
      expect(first.text).toBe('Venue: Acme Arena');
    }
    const second = await ai.callStructured(REQUEST, Reply);
    expect(second.kind).toBe('invalid');
    if (second.kind === 'invalid') expect(second.failure).toBe('schema');
  });

  test('an overloaded API is retryable, and the next call succeeds', async () => {
    const fake = new FakeClient([
      httpError(529, 'overloaded_error'),
      jsonReply({ venue: 'Acme Arena' }),
    ]);
    const { ai, ledger } = aiClient(fake);
    const first = await ai.callStructured(REQUEST, Reply);
    expect(first.kind).toBe('error');
    if (first.kind === 'error') {
      expect(first.error.kind).toBe('overloaded');
      expect(first.error.retryable).toBe(true);
      expect(first.error.status).toBe(529);
    }
    expect(ledger.entries).toHaveLength(0);
    const second = await ai.callStructured(REQUEST, Reply);
    expect(second.kind).toBe('ok');
    expect(ledger.entries).toHaveLength(1);
  });

  test('a fallback reply is read after the last fallback block when the whole text is not JSON', () => {
    const m = message({
      content: [
        text('{"venue": "Ac'),
        fallbackBlock('claude-opus-5-5', 'claude-opus-4-8'),
        text('{"venue": "Acme Arena"}'),
      ],
      stop: 'end_turn',
    });
    const parsed = parseStructured(m, Reply);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.venue).toBe('Acme Arena');
  });
});

describe('the monthly cap', () => {
  test('at or over the limit no request is counted or sent', async () => {
    const fake = new FakeClient([jsonReply({ venue: 'Acme Arena' })]);
    const ledger = new MemoryLedger({ '2027-03': 50 });
    const { ai } = aiClient(fake, { ledger });
    const out = await ai.callStructured(REQUEST, Reply);
    expect(out.kind).toBe('over_cap');
    if (out.kind === 'over_cap') {
      expect(out.spentUsd).toBe(50);
      expect(out.limitUsd).toBe(50);
      expect(out.estimateUsd).toBeUndefined();
    }
    expect(fake.counted).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });

  test('a request whose worst case would pass the limit is refused after counting', async () => {
    const fake = new FakeClient([jsonReply({ venue: 'Acme Arena' })], 100_000);
    const ledger = new MemoryLedger({ '2027-03': 49.5 });
    const { ai } = aiClient(fake, { ledger });
    const out = await ai.callStructured(REQUEST, Reply);
    expect(out.kind).toBe('over_cap');
    if (out.kind === 'over_cap') {
      // Three attempts may be billed, each reading all the input and writing
      // up to max_tokens: 100,000 in at $4 and 8,000 out at $20 (the requested
      // model), then 100,000 at $5 and 8,000 at $25 for each of the two
      // fallback models. The request has no cache breakpoint.
      expect(out.estimateUsd).toBeCloseTo(0.56 + 0.7 + 0.7, 10);
      expect(out.inputTokens).toBe(100_000);
    }
    expect(fake.counted).toHaveLength(1);
    expect(fake.requests).toHaveLength(0);
  });

  test('the worst case prices the input at the cache-write rate the breakpoints ask for', async () => {
    const fake = new FakeClient([]);
    const { ai } = aiClient(fake, { fallbacks: false });
    // 100,000 in and 16,000 out on the requested model ($4, $20, five-minute
    // writes $5, one-hour writes twice the input price).
    expect(
      ai.worstCase(100_000, 16_000, { fiveMinute: false, hour: false })
    ).toBeCloseTo(0.72, 10);
    expect(
      ai.worstCase(100_000, 16_000, { fiveMinute: true, hour: false })
    ).toBeCloseTo(0.82, 10);
    expect(
      ai.worstCase(100_000, 16_000, { fiveMinute: true, hour: true })
    ).toBeCloseTo(1.12, 10);
    expect(
      cacheWritesOf({
        system: [
          { type: 'text', text: 'Read.', cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: 'Venue: Acme Arena' }],
      })
    ).toEqual({ fiveMinute: true, hour: false });
    expect(
      cacheWritesOf({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'x',
                cache_control: { type: 'ephemeral', ttl: '1h' },
              },
            ],
          },
        ],
      })
    ).toEqual({ fiveMinute: false, hour: true });
    expect(
      cacheWritesOf({ messages: [{ role: 'user', content: 'x' }] })
    ).toEqual({
      fiveMinute: false,
      hour: false,
    });
  });

  test('a request in flight holds its worst case, so a second one cannot spend the same room', async () => {
    // Fallbacks off, no cache breakpoint: each worst case is 100,000 x $4 +
    // 16,000 x $20 = $0.72; together they would pass the $1.00 limit.
    const reply = () =>
      message({
        content: [text('{}')],
        stop: 'end_turn',
        usage: usage(100_000, 16_000),
      });
    const fake = new FakeClient([reply(), reply()], 100_000);
    const ledger = new MemoryLedger();
    const { ai } = aiClient(fake, {
      ledger,
      monthlyLimitUsd: 1,
      fallbacks: false,
    });
    const request = { ...REQUEST, maxTokens: 16_000 };
    const [a, b] = await Promise.all([ai.call(request), ai.call(request)]);
    expect([a.kind, b.kind]).toEqual(['ok', 'over_cap']);
    if (b.kind === 'over_cap') {
      expect(b.heldUsd).toBeCloseTo(0.72, 10);
      expect(b.reason).toContain('held for requests in flight');
    }
    expect(fake.requests).toHaveLength(1);
    expect(ledger.spent('2027-03')).toBeCloseTo(0.72, 10);

    // Once the first reply is recorded its hold is gone: the next check sees
    // the recorded $0.72 alone, and $0.72 more does not fit.
    const third = await ai.call(request);
    expect(third.kind).toBe('over_cap');
    if (third.kind === 'over_cap') expect(third.heldUsd).toBeUndefined();
  });

  test('a call that fails releases its hold', async () => {
    const fake = new FakeClient(
      [httpError(500, 'api_error'), jsonReply({ venue: 'Acme Arena' })],
      100_000
    );
    const { ai } = aiClient(fake, { monthlyLimitUsd: 1, fallbacks: false });
    const request = { ...REQUEST, maxTokens: 16_000 };
    expect((await ai.call(request)).kind).toBe('error');
    expect((await ai.call(request)).kind).toBe('ok');
  });

  test('last month does not count against this month', async () => {
    const fake = new FakeClient([jsonReply({ venue: 'Acme Arena' })]);
    const ledger = new MemoryLedger({ '2027-02': 500 });
    const { ai } = aiClient(fake, { ledger });
    expect((await ai.callStructured(REQUEST, Reply)).kind).toBe('ok');
  });

  test("the month is the owner's, across the clock change and far from UTC", () => {
    const at = new Date('2027-03-31T23:30:00Z');
    expect(monthOf(at, 'Europe/London')).toBe('2027-04');
    expect(monthOf(new Date('2027-03-31T22:30:00Z'), 'Europe/London')).toBe(
      '2027-03'
    );
    expect(monthOf(new Date('2027-03-31T10:30:00Z'), 'Pacific/Auckland')).toBe(
      '2027-03'
    );
    expect(monthOf(new Date('2027-03-31T11:30:00Z'), 'Pacific/Auckland')).toBe(
      '2027-04'
    );
  });

  test('a negative or missing limit is a configuration error', () => {
    const fake = new FakeClient([]);
    expect(() => aiClient(fake, { monthlyLimitUsd: -1 })).toThrow(AiError);
    expect(() => aiClient(fake, { monthlyLimitUsd: Number.NaN })).toThrow(
      AiError
    );
  });
});

describe('pricing', () => {
  test('a fallback attempt is priced at its own model, the declined attempt at the requested one', () => {
    const m = message({
      content: [text('{}')],
      stop: 'end_turn',
      model: 'claude-opus-4-8',
      usage: usage(1_000, 500, {
        iterations: [
          {
            type: 'message',
            model: null,
            input_tokens: 1_000,
            output_tokens: 0,
            cache_creation: null,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          {
            type: 'fallback_message',
            model: 'claude-opus-4-8',
            input_tokens: 1_000,
            output_tokens: 500,
            cache_creation: null,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        ],
      }),
    });
    const priced = priceUsage(m, 'claude-opus-5-5', DEFAULT_PRICES);
    expect(priced.attempts.map((a) => a.model)).toEqual([
      'claude-opus-5-5',
      'claude-opus-4-8',
    ]);
    expect(priced.usd).toBeCloseTo(
      (1_000 * 4 + 1_000 * 5 + 500 * 25) / 1e6,
      10
    );
    expect(priced.tokens.input).toBe(2_000);
  });

  test('a model with no configured price is charged the highest price, and says so', () => {
    const m = message({
      content: [],
      stop: 'end_turn',
      model: 'claude-unknown',
      usage: usage(1_000_000, 0),
    });
    const priced = priceUsage(m, 'claude-opus-5-5', DEFAULT_PRICES);
    expect(priced.usd).toBe(5);
    expect(priced.attempts[0]?.pricedAs).toContain('claude-unknown');
  });
});

describe('error classification', () => {
  const cases: [string, unknown, string, boolean][] = [
    ['429', httpError(429, 'rate_limit_error'), 'rate_limited', true],
    ['500', httpError(500, 'api_error'), 'server', true],
    ['503', httpError(503, 'api_error'), 'server', true],
    ['529', httpError(529, 'overloaded_error'), 'overloaded', true],
    [
      'a stream overloaded event',
      streamError('overloaded_error'),
      'overloaded',
      true,
    ],
    [
      'a stream invalid request event',
      streamError('invalid_request_error'),
      'response',
      false,
    ],
    [
      'a connection failure',
      new APIConnectionError({ message: 'reset' }),
      'connection',
      true,
    ],
    ['400', httpError(400, 'invalid_request_error'), 'request', false],
    ['401', httpError(401, 'authentication_error'), 'auth', false],
    ['402', httpError(402, 'billing_error'), 'billing', false],
    ['404', httpError(404, 'not_found_error'), 'request', false],
    [
      'a workspace spend limit',
      httpError(429, 'rate_limit_error', 'enforced_spend_limit_reached'),
      'spend_limit',
      false,
    ],
    ['anything else', new TypeError('boom'), 'unknown', false],
  ];
  for (const [name, error, kind, retryable] of cases) {
    test(`${name} is ${kind}, ${retryable ? 'retryable' : 'final'}`, () => {
      const e = classifyError(error);
      expect(e.kind).toBe(kind as AiError['kind']);
      expect(e.retryable).toBe(retryable);
      expect(e.cause).toBe(error);
    });
  }

  test('a reply whose cost cannot be recorded is still returned, with the error', async () => {
    const fake = new FakeClient([jsonReply({ venue: 'Acme Arena' })]);
    const ledger = new MemoryLedger();
    ledger.record = () => {
      throw new Error('disk full');
    };
    const { ai } = aiClient(fake, { ledger });
    const out = await ai.callStructured(REQUEST, Reply);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.venue).toBe('Acme Arena');
    expect(out.ledgerError?.kind).toBe('ledger');
    expect(out.spend.usd).toBeGreaterThan(0);
  });

  test('a ledger that cannot be read stops the call, to retry', async () => {
    const fake = new FakeClient([jsonReply({ venue: 'Acme Arena' })]);
    const ledger = new MemoryLedger();
    ledger.spent = () => {
      throw new Error('state volume unreadable');
    };
    const { ai } = aiClient(fake, { ledger });
    const out = await ai.call(REQUEST);
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.error.kind).toBe('ledger');
      expect(out.error.retryable).toBe(true);
    }
    expect(fake.counted).toHaveLength(0);
  });

  test('a token count that fails is a typed error, and nothing is sent', async () => {
    const fake = new FakeClient([jsonReply({ venue: 'Acme Arena' })]);
    fake.countError = httpError(503, 'api_error');
    const { ai } = aiClient(fake);
    const out = await ai.call(REQUEST);
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.error.retryable).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });
});
