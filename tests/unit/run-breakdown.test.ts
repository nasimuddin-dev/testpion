import { describe, expect, it } from 'vitest';
import { breakdownHtml, runBreakdown, type TestResult } from '@testpion/core';

const r = (name: string, status: TestResult['status'], latencyMs: number, type = 'http', failedCheck?: string): TestResult =>
  ({ id: name, name, type, status, startedAt: '', durationMs: latencyMs + 5, latencyMs, attempts: 1, checks: failedCheck ? [{ type: 'assert', name: failedCheck, passed: false, source: 'assertion', message: '' }] : [] }) as TestResult;

describe('runBreakdown', () => {
  it('buckets latencies, ranks the slowest and counts per type and failing check', () => {
    const b = runBreakdown();
    for (const x of [r('a', 'passed', 20), r('b', 'passed', 70), r('c', 'failed', 300, 'http', 'status is 200'), r('d', 'error', 1200, 'grpc', 'status is 200'), r('e', 'skipped', 0), r('f', 'passed', 90, 'graphql')]) b.add(x);
    const out = b.result();
    expect(out.timed).toBe(5);
    // < 50, 50–100, 100–250, 250–500, 500–1000, 1000–2500 (trailing empty buckets dropped)
    expect(out.histogram.map((h) => [h.fromMs, h.passed, h.failed])).toEqual([
      [0, 1, 0],
      [50, 2, 0],
      [100, 0, 0],
      [250, 0, 1],
      [500, 0, 0],
      [1000, 0, 1],
    ]);
    expect(out.slowest.map((s) => s.name)).toEqual(['d', 'c', 'f', 'b', 'a']);
    expect(out.byType).toEqual({ http: { passed: 2, failed: 1, skipped: 1 }, grpc: { passed: 0, failed: 1, skipped: 0 }, graphql: { passed: 1, failed: 0, skipped: 0 } });
    expect(out.failingChecks).toEqual([{ name: 'status is 200', count: 2 }]);
  });

  it('puts very slow results in the open-ended last bucket', () => {
    const b = runBreakdown();
    b.add(r('slow', 'passed', 9000));
    const h = b.result().histogram;
    expect(h).toHaveLength(8);
    expect(h[7]).toEqual({ fromMs: 5000, toMs: undefined, passed: 1, failed: 0 });
  });
});

describe('runBreakdown scores', () => {
  it('buckets evaluator scores in fifths with their mean', () => {
    const b = runBreakdown();
    const scored = (score: number) => ({ id: String(score), name: 'x', type: 'llm', status: 'passed', startedAt: '', durationMs: 1, attempts: 1, checks: [{ type: 'similarity', name: 'answer looks right', passed: score >= 0.5, source: 'heuristic', message: '', score }] }) as unknown as TestResult;
    for (const s of [0.1, 0.5, 0.9, 1, 0.95]) b.add(scored(s));
    expect(b.result().scores).toEqual([{ name: 'similarity', buckets: [1, 0, 1, 0, 3], mean: 0.69, count: 5 }]);
  });
});

describe('runBreakdown flaky tests', () => {
  it('lists tests that passed only after a retry, most attempts first', () => {
    const b = runBreakdown();
    const t = (name: string, status: string, attempts: number) => ({ id: name, name, type: 'http', status, startedAt: '', durationMs: 1, attempts, checks: [] }) as unknown as TestResult;
    for (const x of [t('steady', 'passed', 1), t('wobbly', 'passed', 2), t('shaky', 'passed', 3), t('broken', 'failed', 3)]) b.add(x);
    expect(b.result().flaky).toEqual([
      { id: 'shaky', name: 'shaky', attempts: 3 },
      { id: 'wobbly', name: 'wobbly', attempts: 2 },
    ]);
  });

  it('adds up where the time of requests went, by phase', () => {
    const b = runBreakdown();
    const timed = (name: string, timing: Record<string, unknown>) => ({ ...r(name, 'passed', 100), metadata: { timing } }) as TestResult;
    b.add(timed('new', { dnsMs: 4, tcpMs: 10, tlsMs: 20.04, ttfbMs: 50, downloadMs: 6, reusedConnection: false }));
    b.add(timed('reused', { ttfbMs: 30, downloadMs: 2, reusedConnection: true }));
    b.add(r('no-timing', 'passed', 10, 'grpc'));
    expect(b.result().phases).toEqual({ requests: 2, newConnections: 1, reused: 1, dnsMs: 4, tcpMs: 10, tlsMs: 20, ttfbMs: 80, downloadMs: 8 });
    const page = breakdownHtml(b.result());
    expect(page).toContain('Where the time went');
    expect(page).toContain('2 requests · 1 new connection, 1 reused');
    expect(page).toContain('<td>Server (TTFB)</td>');
    const none = runBreakdown();
    none.add(r('a', 'passed', 5));
    expect(none.result().phases).toBeUndefined();
  });
});

describe('OWASP coverage of a run', () => {
  const withChecks = (name: string, checks: Array<[string, boolean]>): TestResult => ({ ...r(name, 'passed', 10, 'llm'), checks: checks.map(([type, passed]) => ({ type, name: type, passed, source: 'assertion', message: '' })) }) as TestResult;
  it('counts the tests that covered each category and those that failed there; nothing when no test covered one', () => {
    const none = runBreakdown();
    none.add(r('plain', 'passed', 10));
    expect(none.result().owasp).toBeUndefined();
    const b = runBreakdown();
    b.add(withChecks('a', [['prompt-injection-resistance', true], ['attack-resisted', false]]));
    b.add(withChecks('b', [['pii-leakage', true]]));
    b.add(withChecks('c', [['jailbreak-resistance', true]]));
    const owasp = b.result().owasp!;
    expect(owasp).toHaveLength(10);
    expect(owasp.filter((c) => c.tests).map((c) => [c.id, c.tests, c.failed])).toEqual([
      ['LLM01:2025', 2, 1],
      ['LLM02:2025', 1, 0],
    ]);
  });
});

