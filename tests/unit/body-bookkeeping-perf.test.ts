import { describe, expect, it, vi } from 'vitest';
import { Redactor, Tracer, headOfValue, summarizeParsed } from '../../packages/core/src/index.js';
import { SECRET_SCAN_CHARS, bodyTooBigToScan, collectBodySecrets, unscannedBodyNote } from '../../apps/desktop/backend/send-secrets.js';
import { expectWithin } from '../perf-budget.js';

/**
 * The bookkeeping of a send (the trace, the result row, the secrets of the request) costs O(what is kept), not O(the body):
 * a 14 MB GraphQL result was deep-redacted and pretty-printed whole to keep 64 KB, twice per step in a run (review 2026-10-27, 1 and 4).
 * Work is asserted by spies (the redactor never sees the whole value, JSON.parse never sees the whole body); time by the shared helpers.
 */
const MB = 1024 * 1024;
/** A parsed GraphQL result of about `bytes` of JSON. */
const gqlResult = (bytes: number) => ({ data: { items: Array.from({ length: Math.ceil(bytes / 70) }, (_, i) => ({ id: i, name: `item ${i}`, token: 'sk-live-abcdef0123456789' })) } });
const best = (n: number, fn: () => void) => {
  let ms = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    ms = Math.min(ms, performance.now() - t0);
  }
  return ms;
};
/** What clean() did before: redact the whole value, serialise it whole, cut. */
function oldClean(redactor: Redactor, v: unknown): unknown {
  const MAX = 64 * 1024;
  const r = redactor.redact(v);
  if (typeof r === 'string') return r.length > MAX ? r.slice(0, MAX) + `… [truncated ${r.length - MAX} chars]` : r;
  const s = JSON.stringify(r);
  if (s && s.length > MAX) return { truncated: true, preview: s.slice(0, MAX), originalChars: s.length };
  return r;
}
/** What the runner summarised before: the whole value pretty-printed, then cut (redacted by the trace afterwards). */
function oldSummary(redactor: Redactor, v: unknown, n: number): string {
  const s = typeof v === 'string' ? v : (JSON.stringify(redactor.redact(v), null, 2) ?? '');
  return s.length > n ? s.slice(0, n) + `… [${s.length - n} more chars]` : s;
}

describe('the trace output of a big GraphQL / gRPC / subscription result', () => {
  it('a 10 MB result is recorded from its head: under 20 ms, the redactor never sees the whole value', () => {
    const value = gqlResult(10 * MB);
    const redactor = new Redactor();
    redactor.addSecret('sk-live-abcdef0123456789');
    const seen: unknown[] = [];
    const real = redactor.redact.bind(redactor);
    redactor.redact = ((v: unknown, d?: number) => (d === undefined && seen.push(v), real(v, d))) as typeof redactor.redact;
    let out: { truncated?: boolean; preview?: string } = {};
    const ms = best(3, () => {
      const t = new Tracer('gql', redactor);
      const span = t.start('graphql', 'graphql');
      span.end({ output: value });
      out = t.trace.spans[0]!.output as typeof out;
    });
    expectWithin(ms, 20, 'trace output of a 10 MB GraphQL result');
    expect(out.truncated).toBe(true);
    expect(out.preview!.length).toBeLessThanOrEqual(64 * 1024);
    expect(out.preview).not.toContain('sk-live-abcdef0123456789');
    expect(out.preview).toContain('item 0');
    expect(seen.every((v) => v !== value)).toBe(true);
  });

  it('a long string output is cut before it is redacted, and a secret at the cut is not left half showing', () => {
    const redactor = new Redactor();
    const secret = 'SECRET' + 'x'.repeat(60);
    redactor.addSecret(secret);
    const t = new Tracer('s', redactor);
    const span = t.start('a', 'custom');
    span.end({ output: 'a'.repeat(64 * 1024 - 20) + secret + 'b'.repeat(2 * MB) });
    const out = t.trace.spans[0]!.output as string;
    expect(out).not.toContain('SECRET');
    expect(out).toMatch(/… \[truncated \d+ chars\]$/);
  });

  it('values up to 64 KB are recorded exactly as before (differential: old path vs new, several shapes)', () => {
    const redactor = new Redactor();
    redactor.addSecret('sk-live-abcdef0123456789');
    const shapes: unknown[] = [
      null,
      7,
      'plain text',
      { ok: true },
      gqlResult(1_000),
      gqlResult(30 * 1024),
      gqlResult(60 * 1024),
      [{ key: 'Authorization', value: 'Bearer abcdefghijkl' }, ['password', 'hunter2hunter2']],
      { password: 'hunter2hunter2', nested: { apiKey: 'abcdef123456', list: [1, 2, { token: 'zzzzzzzz' }] } },
      'x'.repeat(60 * 1024),
      { d: new Date(0), b: Buffer.from('abc'), u: undefined, n: null },
    ];
    for (const v of shapes) {
      const t = new Tracer('d', redactor);
      const span = t.start('a', 'custom');
      span.end({ output: v });
      expect(t.trace.spans[0]!.output, JSON.stringify(v)?.slice(0, 60)).toEqual(oldClean(redactor, v));
    }
  });
});

describe('the summary of a result in a run', () => {
  it('a 10 MB GraphQL result, a 10 MB gRPC unary and a subscription message are summarised in under 20 ms, never read whole', () => {
    const redactor = new Redactor();
    redactor.addSecret('sk-live-abcdef0123456789');
    const grpc = { messages: Array.from({ length: 120_000 }, (_, i) => ({ data: { id: i, name: `n${i}`, payload: 'p'.repeat(60) } })) };
    const subscription = { data: null, events: Array.from({ length: 100_000 }, (_, i) => ({ data: { tick: i, note: 'x'.repeat(90) } })), count: 100_000, completed: false };
    for (const [what, value] of [
      ['GraphQL', gqlResult(10 * MB)],
      ['gRPC unary', grpc],
      ['subscription', subscription],
    ] as const) {
      const seen: unknown[] = [];
      const real = redactor.redact.bind(redactor);
      const spy = { redact: ((v: unknown, d?: number) => (d === undefined && seen.push(v), real(v, d))) as typeof redactor.redact, redactString: redactor.redactString.bind(redactor) };
      let out = '';
      const ms = best(3, () => {
        out = summarizeParsed(spy, value, 16_000);
        summarizeParsed(spy, value, 1_500);
      });
      expectWithin(ms, 20, `summary of a 10 MB ${what} result (16,000 + 1,500)`);
      expect(out.length).toBeLessThan(16_100);
      expect(out).toMatch(/… \[more chars\]$/);
      expect(out).not.toContain('sk-live-abcdef0123456789');
      expect(seen.every((v) => v !== value), `${what}: the redactor was given the whole value`).toBe(true);
    }
  });

  it('values up to 64 KB are summarised exactly as before (differential)', () => {
    const redactor = new Redactor();
    redactor.addSecret('sk-live-abcdef0123456789');
    for (const v of [{ ok: 1 }, gqlResult(2_000), gqlResult(20 * 1024), gqlResult(60 * 1024), 'short', 'y'.repeat(40_000), [1, 2, 3], { events: [{ data: { a: 1 } }], count: 1 }]) {
      for (const n of [1_000, 1_500, 16_000]) expect(summarizeParsed(redactor, v, n), `${JSON.stringify(v).slice(0, 40)} @ ${n}`).toBe(oldSummary(redactor, v, n));
    }
  });
});

describe('headOfValue', () => {
  it('copies a small value whole (cut: false) and stops a big one at its budget', () => {
    expect(headOfValue({ a: [1, 2, 'x'] }, 1000)).toEqual({ value: { a: [1, 2, 'x'] }, cut: false });
    const big = headOfValue(Array.from({ length: 1000 }, (_, i) => ({ i })), 100);
    expect(big.cut).toBe(true);
    expect((big.value as unknown[]).length).toBeLessThan(40);
  });
});

describe('the secrets scan of a request body', () => {
  it('a 5 MB JSON body is not parsed: under 10 ms, JSON.parse never called with it, and its preview is not shown', () => {
    const redactor = new Redactor();
    const content = JSON.stringify({ blob: 'z'.repeat(5 * MB), password: 'hunter2hunter2' });
    const body = { type: 'json' as const, content };
    const parse = vi.spyOn(JSON, 'parse');
    try {
      let skipped = false;
      const ms = best(3, () => {
        skipped = collectBodySecrets(redactor, body as never).skipped;
        bodyTooBigToScan(body as never);
        unscannedBodyNote(body as never);
      });
      expectWithin(ms, 10, 'secrets scan of a 5 MB request body');
      expect(skipped).toBe(true);
      expect(parse.mock.calls.some((c) => c[0] === content)).toBe(false);
    } finally {
      parse.mockRestore();
    }
    expect(bodyTooBigToScan(body as never)).toBe(true);
    expect(unscannedBodyNote(body as never)).toMatch(/not recorded/);
    expect(unscannedBodyNote(body as never)).not.toContain('zzzz');
  });

  it('a body up to the cap is still scanned: the sensitive fields become secrets', () => {
    const redactor = new Redactor();
    const body = { type: 'json' as const, content: JSON.stringify({ user: 'a', password: 'hunter2hunter2', pad: 'q'.repeat(SECRET_SCAN_CHARS / 2) }) };
    expect(bodyTooBigToScan(body as never)).toBe(false);
    expect(collectBodySecrets(redactor, body as never).skipped).toBe(false);
    expect(redactor.redactString('echo hunter2hunter2 echo')).not.toContain('hunter2hunter2');
    // form fields are scanned as before
    const fields = { type: 'multipart' as const, fields: [{ key: 'api_key', value: 'abcdefgh1234', enabled: true, kind: 'text' }] };
    collectBodySecrets(redactor, fields as never);
    expect(redactor.redactString('abcdefgh1234')).not.toContain('abcdefgh1234');
  });
});
