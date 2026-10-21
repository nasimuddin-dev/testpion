import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestResult } from '../../packages/core/src/index.js';
import { agreementOf, bootstrapAgreement, calibrationReport, clearLabel, cohenKappa, collectSamples, confusionOf, hash12, readLabels, setLabel, tuneThreshold } from '../../packages/core/src/index.js';

describe('Cohen’s kappa and the agreement numbers (hand-computed tables)', () => {
  it('40/10/5/45: po 0.85, chance 0.5, kappa 0.7', () => {
    const a = agreementOf([...Array(40).fill({ judge: true, human: true }), ...Array(10).fill({ judge: true, human: false }), ...Array(5).fill({ judge: false, human: true }), ...Array(45).fill({ judge: false, human: false })]);
    expect(a.confusion).toEqual({ tp: 40, fp: 10, fn: 5, tn: 45 });
    expect(a.kappa).toBe(0.7);
    expect(a.accuracy).toBe(0.85);
    expect(a.tpr).toBe(0.889); // 40 / 45 of what the person passed
    expect(a.tnr).toBe(0.818); // 45 / 55 of what the person failed
    expect(a.precision).toBe(0.8);
  });
  it('perfect agreement is 1, chance level is 0, systematic disagreement is -1', () => {
    expect(cohenKappa({ tp: 5, fp: 0, fn: 0, tn: 5 }).kappa).toBe(1);
    expect(cohenKappa({ tp: 25, fp: 25, fn: 25, tn: 25 }).kappa).toBe(0);
    expect(cohenKappa({ tp: 0, fp: 5, fn: 5, tn: 0 }).kappa).toBe(-1);
  });
  it('a table with one class on both sides has no kappa, and says why', () => {
    const k = cohenKappa({ tp: 10, fp: 0, fn: 0, tn: 0 });
    expect(k.kappa).toBeUndefined();
    expect(k.note).toMatch(/one class/);
    expect(agreementOf([{ judge: true, human: true }]).kappaNote).toMatch(/not defined/);
    expect(cohenKappa(confusionOf([])).note).toMatch(/no labelled/);
  });
  it('a judge that always passes agrees often but has kappa 0', () => {
    const a = agreementOf([...Array(9).fill({ judge: true, human: true }), { judge: true, human: false }]);
    expect(a.accuracy).toBe(0.9);
    expect(a.kappa).toBe(0);
  });
});

describe('the bootstrap interval', () => {
  const pairs = [...Array(30).fill({ judge: true, human: true }), ...Array(5).fill({ judge: true, human: false }), ...Array(5).fill({ judge: false, human: true }), ...Array(30).fill({ judge: false, human: false })];
  it('is the same for the same pairs and seed, brackets the estimate, and differs with another seed', () => {
    const a = bootstrapAgreement(pairs);
    expect(bootstrapAgreement(pairs)).toEqual(a);
    const k = agreementOf(pairs).kappa!;
    expect(a.kappa![0]).toBeLessThan(k);
    expect(a.kappa![1]).toBeGreaterThan(k);
    expect(bootstrapAgreement(pairs, { seed: 7 })).not.toEqual(a);
    expect(bootstrapAgreement(pairs.slice(0, 2)).rounds).toBe(0);
  });
});

describe('threshold tuning', () => {
  const xs = [0.1, 0.2, 0.3].map((score) => ({ score, human: false })).concat([0.6, 0.7, 0.8].map((score) => ({ score, human: true })));
  it('finds the gap between the failing and the passing scores, and the gain over the current pass mark', () => {
    const t = tuneThreshold(xs, 'higher', 0.9)!;
    expect(t.threshold).toBe(0.45);
    expect(t.agreement.kappa).toBe(1);
    expect(t.current!.agreement.kappa).toBe(0);
    expect(t.gain).toBe(1);
    expect(t.warning).toMatch(/label more/);
  });
  it('a lower-is-better metric passes at or under the mark', () => {
    const t = tuneThreshold(xs.map((x) => ({ score: 1 - x.score, human: x.human })), 'lower', 0.1)!;
    expect(t.threshold).toBe(0.55);
    expect(t.agreement.kappa).toBe(1);
  });
  it('keeps the current mark when it is already as good as any', () => {
    expect(tuneThreshold(xs, 'higher', 0.5)!.gain).toBe(0);
    expect(tuneThreshold([], 'higher')).toBeUndefined();
  });
});

const result = (record: string, score: number, o: { passed?: boolean; answer?: string; judge?: string; na?: string } = {}): TestResult =>
  ({
    id: `eval:${record}`,
    name: record,
    status: (o.passed ?? score >= 0.7) ? 'passed' : 'failed',
    checks: [{ type: 'faithfulness', name: 'faithfulness', passed: o.passed ?? score >= 0.7, source: 'ai-judge', score, message: `score ${score}`, metadata: { threshold: 0.7, judge: { provider: 'mock', model: o.judge ?? 'm1' }, promptVersion: 'faithfulness-v1', ...(o.na ? { na: o.na } : {}) } }],
    metadata: { rag: { query: `q ${record}`, sample: { answer: o.answer ?? `a ${record}` } } },
  }) as unknown as TestResult;

async function* stream(rs: TestResult[]) {
  yield* rs;
}

describe('pairing results with labels', () => {
  const rs = [result('r1', 0.9), result('r2', 0.8), result('r3', 0.4), result('r4', 0.2), result('r5', 0.9, { judge: 'm2' }), result('r6', 0.5, { na: 'no claims' })];
  const label = (record: string, v: 'pass' | 'fail', extra: Record<string, unknown> = {}) => ({ record, metric: 'faithfulness', label: v, run: 'run-1', resultId: `eval:${record}`, at: 'now', ...extra }) as never;

  it('matches by record id, decides the judge’s verdict at the stored threshold, groups by judge, lists the disagreements', async () => {
    const c = await collectSamples(stream(rs), { labels: [label('r1', 'pass'), label('r2', 'fail'), label('r3', 'fail'), label('r4', 'pass'), label('r5', 'pass'), label('r6', 'pass'), label('gone', 'pass')] });
    expect(c.samples).toHaveLength(5);
    expect(c.missing).toBe(1);
    const rep = calibrationReport(c, { tune: true });
    const m = rep.metrics[0]!;
    expect(m.metric).toBe('faithfulness');
    expect(m.agreement.confusion).toEqual({ tp: 2, fp: 1, fn: 1, tn: 1 });
    expect(m.byJudge.map((j) => [j.judge, j.agreement.n])).toEqual([['mock/m1', 4], ['mock/m2', 1]]);
    expect(m.disagreements.map((d) => [d.record, d.judge, d.human])).toEqual([['r2', 'pass', 'fail'], ['r4', 'fail', 'pass']]);
    expect(m.threshold).toBe(0.7);
    expect(m.tuning).toBeDefined();
    expect(m.advice).toMatch(/Only 5 labelled/);
  });

  it('a label about another answer is stale and left out; a what-if threshold changes the verdicts', async () => {
    const labels = [label('r1', 'pass', { answerHash: hash12('a r1') }), label('r2', 'pass', { answerHash: hash12('an older answer') })];
    const c = await collectSamples(stream(rs), { labels, thresholds: { faithfulness: 0.95 } });
    expect(c.stale).toBe(1);
    expect(c.samples).toHaveLength(1);
    expect(c.samples[0]!.judgePass).toBe(false);
  });

  it('a good/bad review of a result counts as an overall label where there is none', async () => {
    const c = await collectSamples(stream(rs), { reviews: { 'eval:r1': { rating: 'good' }, 'eval:r3': { rating: 'good' } } });
    expect(c.samples.map((s) => [s.metric, s.source, s.judgePass, s.humanPass])).toEqual([['overall', 'review', true, true], ['overall', 'review', false, true]]);
  });
});

describe('the label file', () => {
  it('keeps one label per record and metric, newest wins, with provenance; clear removes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-labels-'));
    const store = { path: (...p: string[]) => join(dir, ...p) };
    try {
      setLabel(store, 'demo', { record: 'r1', metric: 'faithfulness', label: 'pass', run: 'run-1', resultId: 'eval:r1', by: 'ann', note: ' fine ' });
      setLabel(store, 'demo', { record: 'r1', metric: 'faithfulness', label: 'fail', run: 'run-2', resultId: 'eval:r1' });
      setLabel(store, 'demo', { record: 'r1', metric: 'overall', label: 'pass', run: 'run-2', resultId: 'eval:r1' });
      const f = readLabels(store, 'demo');
      expect(f.schemaVersion).toBe(1);
      expect(f.labels.map((l) => [l.metric, l.label, l.run])).toEqual([['faithfulness', 'fail', 'run-2'], ['overall', 'pass', 'run-2']]);
      expect(JSON.parse(readFileSync(join(dir, 'labels', 'demo.json'), 'utf8')).labels[0].at).toBeTruthy();
      expect(clearLabel(store, 'demo', 'r1', 'overall')).toBe(true);
      expect(clearLabel(store, 'demo', 'r1', 'overall')).toBe(false);
      expect(() => readLabels(store, '../evil')).toThrow(/not a label set name/);
      expect(existsSync(join(dir, 'evil.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
