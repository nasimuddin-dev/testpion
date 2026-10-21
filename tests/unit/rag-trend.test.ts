import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceStore, analyzeTrend, ragTrend, recordRun, regressionLines, regressionMarkdown, trendCsv, trendTable, type MetricComparison, type RunSummary, type TrendPoint } from '../../packages/core/src/index.js';

const point = (i: number, mean: number, o: Partial<TrendPoint> = {}, ci?: [number, number]): TrendPoint => ({ runId: `r${i}`, name: 'ev', at: `2026-10-0${i}T00:00:00Z`, n: 10, judge: 'mock/m1', versions: 'faithfulness@v1', metrics: { faithfulness: { mean, n: 10, naCount: 0, ...(ci ? { ci } : {}) } }, ...o });

describe('analyzeTrend', () => {
  it('names a metric that fell more than 0.05 against the median of the 3 runs before it', () => {
    const a = analyzeTrend([point(1, 0.9), point(2, 0.88), point(3, 0.91), point(4, 0.8)]);
    expect(a.findings).toHaveLength(1);
    expect(a.findings[0]).toMatchObject({ metric: 'faithfulness', change: 'dropped', from: 0.9, to: 0.8, delta: -0.1, against: 3, worse: true });
    expect(a.findings[0]!.text).toBe('faithfulness dropped 0.1 over 3 runs (0.9 to 0.8)');
  });
  it('a small move is quiet, unless the newest interval excludes the median and it is half the minimum', () => {
    expect(analyzeTrend([point(1, 0.9), point(2, 0.9), point(3, 0.87)]).findings).toEqual([]);
    expect(analyzeTrend([point(1, 0.9), point(2, 0.9), point(3, 0.87, {}, [0.86, 0.88])]).findings).toHaveLength(1);
  });
  it('a run measured by another judge is marked and never reported as a drop', () => {
    const a = analyzeTrend([point(1, 0.9), point(2, 0.9), point(3, 0.5, { judge: 'mock/m2' })]);
    expect(a.points.map((p) => !!p.judgeChanged)).toEqual([false, false, true]);
    expect(a.findings).toEqual([]);
    // and the runs before the change are not the baseline of the runs after it
    const b = analyzeTrend([point(1, 0.9), point(2, 0.9), point(3, 0.5, { judge: 'mock/m2' }), point(4, 0.5, { judge: 'mock/m2' }), point(5, 0.3, { judge: 'mock/m2' })]);
    expect(b.findings[0]).toMatchObject({ from: 0.5, against: 2 });
  });
  it('a lower-is-better metric that rose is worse', () => {
    const p = (i: number, m: number) => point(i, m, { metrics: { hallucination: { mean: m, n: 5, naCount: 0 } } });
    const a = analyzeTrend([p(1, 0.1), p(2, 0.1), p(3, 0.3)], { lower: new Set(['hallucination']) });
    expect(a.findings[0]).toMatchObject({ change: 'rose', worse: true });
  });
  it('csv and table carry a row per run and mark the judge change', () => {
    const pts = analyzeTrend([point(1, 0.9), point(2, 0.8, { judge: 'mock/m2' })]).points;
    expect(trendCsv(pts).split('\n')[0]).toBe('run,at,samples,judge,judge_changed,faithfulness,faithfulness_low,faithfulness_high');
    expect(trendCsv(pts).split('\n')[2]).toContain(',yes,0.8,');
    expect(trendTable(pts)).toContain('0.8*');
  });
});

describe('the regression table', () => {
  const c = {
    metrics: [
      { key: 'faithfulness', direction: 'higher', baseline: 0.86, current: 0.78, delta: -0.08, paired: 20, ci: [-0.12, -0.04], significant: true, change: 'regressed' },
      { key: 'recall@5', direction: 'higher', baseline: 0.7, current: 0.7, delta: 0, paired: 20, change: 'unchanged' },
      { key: 'answer-relevance', direction: 'higher', baseline: 0.7, current: 0.8, delta: 0.1, paired: 20, change: 'improved' },
    ],
    samples: { shared: 20, onlyCurrent: 0, onlyBaseline: 0 },
    regressions: [] as never[],
    improvements: [] as never[],
  } as unknown as MetricComparison;
  c.regressions = [c.metrics[0]!] as never;
  it('lists what moved, regressions first, with the judge and the cost; the same facts as one-line alerts', () => {
    const md = regressionMarkdown(c, { baseline: 'run-1', judge: 'mock/m1', costUsd: 0.0123, maxDrop: 0.05 });
    expect(md).toContain('### Against run-1');
    expect(md).toContain('judge mock/m1');
    expect(md).toContain('$0.0123');
    expect(md.indexOf('faithfulness')).toBeLessThan(md.indexOf('answer-relevance'));
    expect(md).not.toContain('recall@5');
    expect(md).toContain('-0.12 to -0.04');
    expect(regressionLines(c)).toEqual(['faithfulness 0.86 to 0.78 (-0.08, interval -0.12 to -0.04)']);
    expect(regressionMarkdown({ ...c, metrics: [c.metrics[1]!], regressions: [] }, { baseline: 'x' })).toContain('No metric moved');
  });
});

describe('ragTrend over stored runs', () => {
  it('reads each run once (cache beside the results), follows the evaluation by name, and flags a judge change', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-trend-'));
    const ws = WorkspaceStore.create(join(dir, 'ws'), 'trend');
    try {
      ws.saveLibrary('evaluations', { folders: [], items: [{ id: 'ev', name: 'Clinic RAG', data: { name: 'Clinic RAG', type: 'rag', evaluators: [] } as never }] });
      const make = async (i: number, scores: number[], model: string) => {
        const id = `run-${i}`;
        const d = ws.runDir(id);
        mkdirSync(d, { recursive: true });
        const rows = scores.map((s, k) => JSON.stringify({ id: `Clinic RAG:q${k}`, name: `q${k}`, status: 'passed', checks: [{ type: 'faithfulness', name: 'faithfulness', passed: s >= 0.7, source: 'ai-judge', score: s, message: '', metadata: { threshold: 0.7, judge: { provider: 'mock', model }, promptVersion: 'faithfulness-v1' } }], metadata: { rag: { query: `q${k}` } } }));
        writeFileSync(join(d, 'results.jsonl'), rows.join('\n') + '\n');
        const s = { runId: id, name: 'Clinic RAG', startedAt: `2026-10-0${i}T10:00:00.000Z`, finishedAt: `2026-10-0${i}T10:01:00.000Z`, durationMs: 1, total: scores.length, passed: scores.length, failed: 0, skipped: 0, errors: 0, latency: {}, tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, costUsd: 0, cancelled: false, scores: {}, reproducibility: {} } as unknown as RunSummary;
        await recordRun(ws, s, d);
      };
      await make(1, [0.9, 0.9, 0.9], 'm1');
      await make(2, [0.9, 0.9, 0.9], 'm1');
      await make(3, [0.5, 0.5, 0.5], 'm2');
      const t = await ragTrend(ws, { evaluation: 'clinic rag' });
      expect(t.evaluation).toBe('Clinic RAG');
      expect(t.points.map((p) => [p.runId, p.metrics.faithfulness?.mean, !!p.judgeChanged])).toEqual([['run-1', 0.9, false], ['run-2', 0.9, false], ['run-3', 0.5, true]]);
      expect(t.points[0]!.judge).toBe('mock/m2'.replace('m2', 'm1'));
      expect(t.findings).toEqual([]);
      expect(existsSync(join(ws.runDir('run-1'), 'rag-means.json'))).toBe(true);
      // a changed results file is read again
      writeFileSync(join(ws.runDir('run-1'), 'results.jsonl'), JSON.stringify({ id: 'Clinic RAG:q0', name: 'q0', status: 'passed', checks: [{ type: 'faithfulness', name: 'faithfulness', passed: true, source: 'ai-judge', score: 0.6, message: '', metadata: { judge: { provider: 'mock', model: 'm1' }, promptVersion: 'faithfulness-v1' } }] }) + '\n');
      expect((await ragTrend(ws, { evaluation: 'Clinic RAG', metrics: ['faithfulness'] })).points[0]!.metrics.faithfulness?.mean).toBe(0.6);
      await expect(ragTrend(ws, {})).rejects.toThrow(/Name an evaluation/);
    } finally {
      ws.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
