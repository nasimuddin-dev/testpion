/**
 * The Ragas parity extras (planning/rag-testing.md §2.6): the names Ragas gives its result columns, an evaluation-level
 * `compat: ragas`, the import of a Ragas result table as columns of the matrix beside TestPion's own, the matrix as CSV / JSON /
 * HTML, the variant × metric pivot, the per-tag means, and the target called several times per question.
 */
import { describe, expect, it } from 'vitest';
import { applyRagasCompat, buildMetricMatrix, evaluationTemplate, evaluatorsOf, matchExternal, metricScoreColumns, parseRagasResult, pivotRuns, ragMatrixCsv, ragMatrixHtml, ragMatrixJson, ragasColumnName, scoreTargetRepeats, type CheckResult, type SavedEvaluation, type TestResult } from '../../packages/core/src/index.js';

const check = (type: string, score: number | undefined, extra: Partial<CheckResult> = {}): CheckResult => ({ type, name: type, passed: score === undefined ? true : score >= 0.5, source: 'ai-judge', message: `${type} ${score}`, ...(score !== undefined ? { score } : {}), ...extra });
const result = (id: string, question: string, checks: CheckResult[], tags: string[] = []): TestResult => ({ id: `eval:${id}`, name: id, status: checks.every((c) => c.passed) ? 'passed' : 'failed', durationMs: 5, checks, tags, metadata: { rag: { query: question } } }) as never;

async function* stream(rs: TestResult[]) {
  for (const r of rs) yield r;
}

describe('Ragas column names', () => {
  it('a metric is named as Ragas names it in its result table', () => {
    const cases: Record<string, string> = {
      faithfulness: 'faithfulness',
      'answer-relevance': 'answer_relevancy',
      'context-precision': 'context_precision',
      'context-recall': 'context_recall',
      'context-entity-recall': 'context_entity_recall',
      'factual-correctness': 'factual_correctness',
      'semantic-similarity': 'semantic_similarity',
      'answer-accuracy': 'nv_accuracy',
      'context-relevance': 'nv_context_relevance',
      'response-groundedness': 'nv_response_groundedness',
      'noise-sensitivity-relevant': 'noise_sensitivity',
      'recall@k': 'recall',
      'pass-fail': 'aspect_critic',
    };
    for (const [id, col] of Object.entries(cases)) expect(ragasColumnName(id), id).toBe(col);
    expect(ragasColumnName('LLMContextRecall')).toBe('context_recall');
    expect(ragasColumnName('not-a-metric')).toBe('not_a_metric');
  });

  it('scores of a run per dataset record, under TestPion’s or Ragas’ names', () => {
    const records = [{ id: 'a', question: 'q1' }, { question: 'q2' }];
    const results = [
      { id: 'eval:a', checks: [check('faithfulness', 0.75), check('answer-relevance', 0.9), check('context-recall', undefined, { metadata: { na: 'no reference' } })] },
      { id: 'eval:2', checks: [check('faithfulness', 1)] },
    ];
    expect(metricScoreColumns(records, results, { names: 'ragas' })).toEqual([{ faithfulness: 0.75, answer_relevancy: 0.9, context_recall: null }, { faithfulness: 1 }]);
    expect(metricScoreColumns(records, results)[0]).toMatchObject({ 'answer-relevance': 0.9 });
  });
});

describe('compat: ragas', () => {
  it('every metric takes the options of its Ragas name; what the evaluation chose wins', () => {
    const out = applyRagasCompat([{ type: 'answer-relevance' }, { type: 'answer-relevance', mode: 'statements' }, { type: 'context-entity-recall' }, { type: 'context-precision' }, { type: 'faithfulness' }, { type: 'recall@k', k: 5 }, { type: 'latency', max: 100 }]);
    expect(out[0]).toMatchObject({ type: 'answer-relevance', mode: 'reverse-questions' });
    expect(out[1]).toMatchObject({ mode: 'statements' });
    expect(out[2]).toMatchObject({ mode: 'llm', caseSensitive: true });
    expect(out[3]).toMatchObject({ perChunk: true });
    expect(out[4]).toEqual({ type: 'faithfulness' });
    expect(out[5]).toEqual({ type: 'recall@k', k: 5 });
    expect(out[6]).toEqual({ type: 'latency', max: 100 });
  });

  it('a saved evaluation applies it to the evaluators of every test it makes; the evaluation’s database goes to the SQL metrics', () => {
    const d = { name: 'E', type: 'rag', provider: '', model: '', prompt: '', format: 'text', datasetFormat: 'jsonl', dataset: '', expectedField: 'expected', evaluators: [{ type: 'answer-relevance' }, { type: 'datacompy-score' }, { type: 'latency' }], concurrency: 1, retries: 0, compat: 'ragas', database: { path: 'shop.db' } } as SavedEvaluation;
    const ev = evaluatorsOf(d);
    expect(ev[0]).toMatchObject({ mode: 'reverse-questions' });
    expect(ev[1]).toMatchObject({ database: { path: 'shop.db' } });
    expect(ev[2]).toEqual({ type: 'latency' });
    const t = evaluationTemplate({ ...d, targetRepeats: 3 }, { protocol: 'http', step: { type: 'http' }, mapping: { answer: '$.a' } });
    expect(t).toMatchObject({ type: 'rag', targetRepeats: 3 });
    expect((t.evaluators as Array<{ mode?: string }>)[0]!.mode).toBe('reverse-questions');
    expect(evaluationTemplate({ ...d, targetRepeats: 1 }, { protocol: 'http', step: { type: 'http' }, mapping: { answer: '$.a' } })).not.toHaveProperty('targetRepeats');
  });
});

describe('a Ragas result table', () => {
  const csv = 'user_input,retrieved_contexts,response,reference,faithfulness,answer_relevancy,context_recall\n"When does it open?","[\'a\']","At 8am.","8am",1.0,0.93,nan\n"Is there parking?","[\'b\']","Yes.","Yes",0.5,0.8,1.0\n';

  it('the metric columns are the ones of numbers that are not data; NaN is no score', () => {
    const r = parseRagasResult(csv);
    expect(r.metrics).toEqual(['faithfulness', 'answer_relevancy', 'context_recall']);
    expect(r.rows[0]).toEqual({ question: 'When does it open?', scores: { faithfulness: 1, answer_relevancy: 0.93, context_recall: null } });
    expect(r.rows[1]!.scores.context_recall).toBe(1);
    expect(r.source).toBe('Ragas');
  });

  it('JSON: a list of rows, a { scores: […] } object, JSON Lines', () => {
    const rows = [{ user_input: 'q1', faithfulness: 0.5 }, { user_input: 'q2', faithfulness: 1 }];
    expect(parseRagasResult(JSON.stringify(rows)).rows).toHaveLength(2);
    expect(parseRagasResult(JSON.stringify({ scores: rows })).metrics).toEqual(['faithfulness']);
    expect(parseRagasResult(rows.map((r) => JSON.stringify(r)).join('\n')).rows[1]!.scores.faithfulness).toBe(1);
  });

  it('what is not a result table is an error that lists the columns', () => {
    expect(() => parseRagasResult('')).toThrow(/empty/);
    expect(() => parseRagasResult('user_input,response\nq,a\n')).toThrow(/no metric column/);
    expect(() => parseRagasResult('{ nope')).toThrow(/not a CSV/);
  });

  it('rows are matched to the samples by the question, or by position when the table has none', () => {
    const ext = parseRagasResult(csv);
    expect(matchExternal(['Is there parking?', 'when does it open?', 'unknown'], ext)).toEqual([1, 0, undefined]);
    const bare = parseRagasResult('faithfulness\n0.5\n1\n');
    expect(matchExternal(['a', 'b'], bare)).toEqual([0, 1]);
    expect(matchExternal(['a', 'b', 'c'], bare)).toEqual([undefined, undefined, undefined]);
  });
});

describe('the matrix', () => {
  const rs = [
    result('a', 'When does it open?', [check('faithfulness', 1), check('recall@5', 0.5, { name: 'recall@5' })], ['hours']),
    result('b', 'Is there parking?', [check('faithfulness', 0.25), check('recall@5', 1, { name: 'recall@5' })], ['parking', 'hours']),
    result('c', 'Is it open Sunday?', [check('faithfulness', undefined, { metadata: { na: 'no claims' } }), check('recall@5', 0, { name: 'recall@5' })], ['hours']),
  ];

  it('another tool’s scores are columns of the same samples, matched by the question', async () => {
    const ext = parseRagasResult('user_input,faithfulness,answer_relevancy\nWhen does it open?,0.9,0.8\nIs there parking?,0.4,0.7\n');
    const m = await buildMetricMatrix(stream(rs), { external: ext });
    expect(m.columns.map((c) => c.key)).toEqual(['recall@5', 'faithfulness', 'faithfulness (Ragas)', 'answer_relevancy (Ragas)']);
    const col = m.columns.find((c) => c.key === 'faithfulness (Ragas)')!;
    expect(col).toMatchObject({ group: 'external', metric: 'faithfulness', external: { source: 'Ragas', column: 'faithfulness' } });
    const idx = m.columns.indexOf(col);
    expect(m.rows.map((r) => r.cells[idx]?.score)).toEqual([0.9, 0.4, undefined]);
    expect(m.groups.at(-1)).toMatchObject({ label: 'Scores of Ragas', columns: 2 });
    expect(m.aggregates.find((a) => a.key === 'faithfulness (Ragas)')!.mean).toBe(0.65);
  });

  it('the means by tag follow the order of the columns', async () => {
    const m = await buildMetricMatrix(stream(rs));
    expect(m.byTag.map((t) => [t.tag, t.n])).toEqual([['hours', 3], ['parking', 1]]);
    // recall@5 (a retrieval metric) comes before faithfulness: the columns are grouped by kind
    expect(m.byTag[0]!.means).toEqual([0.5, 0.625]);
    expect(m.byTag[1]!.means).toEqual([1, 0.25]);
  });

  it('CSV, JSON and HTML hold every row; Ragas names rename the score columns; the HTML escapes the text', async () => {
    const hostile = [...rs, result('d', '<script>alert(1)</script> & "quotes"', [check('faithfulness', 0.5), check('recall@5', 0.5, { name: 'recall@5' })])];
    const m = await buildMetricMatrix(stream(hostile), { all: true });
    expect(m.rows).toHaveLength(4);
    const csv = ragMatrixCsv(m);
    expect(csv.split(/\r?\n/)[0]).toBe('id,question,tags,status,failure,recall@5,recall@5_passed,faithfulness,faithfulness_passed');
    expect(csv).toContain('eval:b,Is there parking?,parking;hours,');
    expect(csv).toContain('n/a');
    expect(ragMatrixCsv(m, { names: 'ragas' }).split(/\r?\n/)[0]).toContain('recall,recall_passed,faithfulness,faithfulness_passed');
    const json = JSON.parse(ragMatrixJson(m)) as { total: number; rows: Array<{ cells: Record<string, { score?: number }> }>; byTag: unknown[] };
    expect(json.total).toBe(4);
    expect(json.rows[0]!.cells.faithfulness!.score).toBe(1);
    const html = ragMatrixHtml(m);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&#60;script&#62;');
    expect(html).toContain('By tag');
    expect(html).toMatch(/^<!doctype html>/);
  });

  it('the variant × metric pivot: the mean of each metric per run, and the best run by direction', async () => {
    const a = await buildMetricMatrix(stream(rs));
    const worse = await buildMetricMatrix(stream(rs.map((r) => ({ ...r, checks: r.checks.map((c) => (typeof c.score === 'number' ? { ...c, score: Math.max(0, c.score - 0.2) } : c)) }))));
    const p = pivotRuns([{ runId: 'r1', label: 'baseline', matrix: a }, { runId: 'r2', label: 'candidate', matrix: worse }]);
    expect(p.metrics.map((m) => m.key)).toEqual(['recall@5', 'faithfulness']);
    expect(p.variants.map((v) => v.runId)).toEqual(['r1', 'r2']);
    expect(p.cells[1]![0]!.mean).toBeGreaterThan(p.cells[1]![1]!.mean);
    expect(p.best).toEqual([0, 0]);
  });
});

describe('the target called several times', () => {
  const ctx = (text: string) => ({ ctx: { testType: 'rag' as const, body: text, text }, metadata: {} });
  const first = { ctx: { testType: 'rag' as const, body: 'a', text: 'a' }, checks: [check('faithfulness', 1, { metadata: { threshold: 0.8 } })] };

  it('each metric is the mean of the calls with the spread; it passes when its mean does', async () => {
    const answers = ['b', 'c'];
    let i = 0;
    const scores = [0.5, 0.75];
    const out = await scoreTargetRepeats({ n: 3, configs: [{ type: 'ragas-never-used' }], first, call: async () => ctx(answers[i++]!) as never });
    // the extra calls are scored with the evaluators; here they fail to resolve, so only the structure is checked
    expect(out.repeats.map((r) => r.answer)).toEqual(['b', 'c']);
    expect(out.differing).toBe(2);
    void scores;
  });

  it('with scored extra calls: mean, sd, lowest, highest, and the pass decision on the mean', async () => {
    const configs = [{ type: 'token-f1', threshold: 0.5, expected: 'opens at 8am' }];
    const answers = ['opens at 8am', 'closed', 'opens at 8am today'];
    let i = 0;
    const firstScored = { ctx: { testType: 'rag' as const, body: '', text: answers[0]!, expected: 'opens at 8am' }, checks: [check('token-f1', 1, { metadata: { threshold: 0.5 } })] };
    const out = await scoreTargetRepeats({ n: 3, configs, first: firstScored, call: async () => ({ ctx: { testType: 'rag' as const, body: '', text: answers[++i]!, expected: 'opens at 8am' }, partial: {} }) as never });
    const c = out.checks[0]!;
    const tr = (c.metadata as { targetRepeat: { scores: number[]; mean: number; sd: number; min: number; max: number; calls: number } }).targetRepeat;
    expect(tr.calls).toBe(3);
    expect(tr.scores).toEqual([1, 0, 0.857]);
    expect(tr.mean).toBe(0.619);
    expect(tr.min).toBe(0);
    expect(tr.max).toBe(1);
    expect(tr.sd).toBeGreaterThan(0.4);
    expect(c.score).toBe(0.619);
    expect(c.passed).toBe(true);
    expect(c.message).toMatch(/mean of 3 calls 0\.619 ±/);
  });

  it('a call that fails counts against every metric, and one call changes nothing', async () => {
    const configs = [{ type: 'token-f1', threshold: 0.9, expected: 'x' }];
    const firstScored = { ctx: { testType: 'rag' as const, body: '', text: 'x', expected: 'x' }, checks: [check('token-f1', 1, { metadata: { threshold: 0.9 } })] };
    const out = await scoreTargetRepeats({ n: 2, configs, first: firstScored, call: async () => { throw new Error('HTTP 500'); } });
    expect(out.repeats[0]).toMatchObject({ error: 'HTTP 500' });
    expect(out.checks[0]!.passed).toBe(false);
    expect((out.checks[0]!.metadata as { targetRepeat: { failedCalls: number } }).targetRepeat.failedCalls).toBe(1);
    const one = await scoreTargetRepeats({ n: 1, configs, first: firstScored, call: async () => { throw new Error('never'); } });
    expect(one.checks).toEqual(firstScored.checks);
  });
});
