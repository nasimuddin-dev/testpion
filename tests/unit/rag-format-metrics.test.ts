/**
 * The catalogue rows for the shape of the answer (answer-regex, answer-length, answer-json-schema) and the cost of judging it
 * (judge-cost). Each worked example of metric-defs-format.ts is a case here. No model is called.
 */
import { describe, expect, it } from 'vitest';
import { getMetric, metricToCheck, resolveMetric, runChecks, scoreRagSample, type CheckContext, type CheckResult } from '../../packages/core/src/index.js';

const ctx = (text: string, over: Partial<CheckContext> = {}): CheckContext => ({ testType: 'rag', body: '', text, question: 'q', ...over });
const run = async (cfg: Record<string, unknown>, text: string) => (await runChecks([metricToCheck(String(cfg.type), Object.fromEntries(Object.entries(cfg).filter(([k]) => k !== 'type')))], ctx(text)))[0]!;

describe('answer-regex', () => {
  it('scores 1 when the answer matches, 0 when not, and the other way with not: true', async () => {
    expect((await run({ type: 'answer-regex', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, '2026-10-21')).score).toBe(1);
    expect((await run({ type: 'answer-regex', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, 'October 21')).score).toBe(0);
    expect((await run({ type: 'answer-regex', pattern: 'guarantee', flags: 'i', not: true }, 'We GUARANTEE it.')).score).toBe(0);
    expect((await run({ type: 'answer-regex', pattern: 'guarantee', not: true }, 'No promises.')).score).toBe(1);
  });
  it('says what is missing or wrong instead of scoring', async () => {
    expect((await run({ type: 'answer-regex' }, 'x')).message).toMatch(/needs a pattern/);
    const bad = await run({ type: 'answer-regex', pattern: '(' }, 'x');
    expect(bad.passed).toBe(false);
    expect(bad.message).toMatch(/invalid regex/);
  });
  it('is the metric behind the names regex-match, and the older regex check is untouched', async () => {
    expect(resolveMetric('regex-match')?.def.id).toBe('answer-regex');
    const r = (await runChecks([{ type: 'regex', pattern: 'a' }], ctx('abc')))[0]!;
    expect(r.passed).toBe(true);
  });
});

describe('answer-length', () => {
  it('counts words by default: 412 words with max 300 is 0', async () => {
    const long = Array.from({ length: 412 }, () => 'word').join(' ');
    const r = await run({ type: 'answer-length', max: 300 }, long);
    expect(r.score).toBe(0);
    expect(r.actual).toBe(412);
    expect((await run({ type: 'answer-length', max: 500, min: 100 }, long)).score).toBe(1);
  });
  it('counts characters and tokens (four characters) when asked', async () => {
    expect((await run({ type: 'answer-length', unit: 'characters', max: 5 }, 'abcdef')).score).toBe(0);
    expect((await run({ type: 'answer-length', unit: 'tokens', max: 2 }, 'abcdefgh')).score).toBe(1);
    expect((await run({ type: 'answer-length', unit: 'tokens', max: 2 }, 'abcdefghi')).score).toBe(0);
  });
  it('needs a bound', async () => {
    expect((await run({ type: 'answer-length' }, 'x')).message).toMatch(/needs a bound/);
  });
});

describe('answer-json-schema', () => {
  const schema = { type: 'object', required: ['id'] };
  it('a missing required key is 0; the JSON in a code fence counts', async () => {
    expect((await run({ type: 'answer-json-schema', schema }, '{"name":"Ann"}')).score).toBe(0);
    expect((await run({ type: 'answer-json-schema', schema }, '{"id":1}')).score).toBe(1);
    expect((await run({ type: 'answer-json-schema', schema }, 'Here you go:\n```json\n{"id": 2}\n```')).score).toBe(1);
  });
  it('prose is not JSON; with no schema any object or array passes', async () => {
    const prose = await run({ type: 'answer-json-schema', schema }, 'The id is 1.');
    expect(prose.score).toBe(0);
    expect(prose.message).toMatch(/not valid JSON/);
    expect((await run({ type: 'answer-json-schema' }, '[1,2]')).score).toBe(1);
    expect((await run({ type: 'answer-json-schema' }, '"just a string"')).score).toBe(0);
  });
  it('json-correctness (DeepEval) is its name', () => {
    expect(resolveMetric('json_correctness')?.def.id).toBe('answer-json-schema');
  });
});

describe('judge-cost', () => {
  const cfg = metricToCheck('judge-cost');
  const spent = (costUsd: number, calls: number): CheckResult => ({ type: 'x', name: 'x', passed: true, source: 'ai-judge', message: 'm', metadata: { judgeUsage: { calls, inputTokens: 10, outputTokens: 5, costUsd, cached: false } } });

  it('is the sum of what the other metrics of the sample spent, filled in by the sample scorer', async () => {
    const { checks } = await scoreRagSample([{ type: 'answer-length', max: 100 }, cfg], ctx('short answer'));
    const cost = checks.find((c) => c.type === 'judge-cost')!;
    // no judged metric ran: nothing was spent
    expect(cost.score).toBe(0);
    expect((cost.metadata as { calls: number }).calls).toBe(0);
    expect(checks.map((c) => c.type)).toEqual(['answer-length', 'judge-cost']);
  });

  it('adds the usage the metrics report and passes at or under max', async () => {
    const { judgeCostResult } = await import('../../packages/core/src/eval/rag/metrics-format.js');
    const r = judgeCostResult({ type: 'judge-cost', max: 0.002 }, [spent(0.0007, 2), spent(0.0005, 2)]);
    expect(r.score).toBe(0.0012);
    expect(r.passed).toBe(true);
    expect((r.metadata as { calls: number }).calls).toBe(4);
    expect(judgeCostResult({ type: 'judge-cost', max: 0.001 }, [spent(0.0012, 4)]).passed).toBe(false);
  });

  it('asked on its own it says where the number comes from (n/a)', async () => {
    const r = (await runChecks([cfg], ctx('x')))[0]!;
    expect((r.metadata as { na?: string }).na).toMatch(/other metrics/);
  });

  it('is lower-is-better in the operational group', () => {
    expect(getMetric('judge-cost')).toMatchObject({ direction: 'lower', group: 'operational' });
  });
});
