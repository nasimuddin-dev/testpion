import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceStore,
  MemorySecretStore,
  createEngineContext,
  ensureSample,
  evaluationTests,
  evaluationVariants,
  evalCaseDiff,
  evalCaseKey,
  evalReport,
  evalWhy,
  failureOf,
  runResults,
  findSavedEvaluation,
  recordRun,
  runTests,
  shortId,
  variantsSummary,
  EVALUATIONS_LIBRARY,
  type RunSummary,
  type SavedEvaluation,
  type TestResult,
} from '../../packages/core/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'tp-evr-'));
const store = WorkspaceStore.create(join(dir, 'ws'), 'EVR');
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const pause = (ms = 8) => new Promise((r) => setTimeout(r, ms));

/** Run an evaluation draft and record it the way the app and the CLI do: results.jsonl, summary.json and a row in the history. */
async function record(d: SavedEvaluation, name = d.name) {
  const c = createEngineContext({ store, secrets: new MemorySecretStore(), settings: { pricing: [] } as never });
  try {
    const runId = shortId('run-');
    const out = store.runDir(runId);
    mkdirSync(out, { recursive: true });
    const summary = await runTests({ name, runId, tests: evaluationTests({ ...d, name }, { store }), services: c.services, concurrency: 2, resultsFile: join(out, 'results.jsonl') });
    await recordRun(store, summary, out);
    await pause();
    return summary;
  } finally {
    await c.dispose();
  }
}

/** Save the sample with a pass line, so its runs find it by name. */
function sampleWith(over: Partial<SavedEvaluation>): SavedEvaluation & { id: string } {
  const s = ensureSample(store).evaluation;
  const lib = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY);
  store.saveLibrary(EVALUATIONS_LIBRARY, { folders: lib.folders, items: lib.items.map((i) => (i.id === s.id ? { ...i, data: { ...i.data, ...over } } : i)) });
  return { ...s, ...over };
}

describe('the report card (AU-14)', () => {
  it('says "10 of 10 passed" for a clean run, with the offline demo model named and no earlier run', async () => {
    const s = sampleWith({ passLine: 80 });
    await record(s);
    const r = await evalReport(store, { run: 'last' });
    expect(r.headline).toBe('10 of 10 passed');
    expect(r.passRate).toBe(1);
    expect(r.failures).toEqual([]);
    expect(r.offline).toBe(true);
    expect(r.byCheck).toEqual([{ name: expect.any(String), type: 'contains', passed: 10, total: 10, aiReviewer: false }]);
    expect(r.passLine).toMatchObject({ percent: 80, met: true });
    expect(r.previous).toBeUndefined();
    expect(r.trend).toHaveLength(1);
    expect(r.text).toContain('10 of 10 passed (100%).');
    expect(r.text).toContain('Every check passed.');
    expect(r.text).toContain('Pass line 80%: met.');
    expect(r.text).toContain('Offline demo model');
  });

  it('says what the evaluation costs over time: this run, the run before, this month (A-8)', async () => {
    const r = await evalReport(store, { run: 'last' });
    expect(r.cost.usd).toBe(r.costUsd);
    expect(r.cost.monthRuns).toBeGreaterThanOrEqual(1);
    expect(r.cost.monthUsd).toBeGreaterThanOrEqual(r.cost.usd);
    // the offline demo model costs nothing: no cost sentence, and no "this month" without a price
    expect(r.text).not.toContain('this month');
  });

  it('lists the failed cases with the reply and what was expected, and compares with the run before', async () => {
    // two cases now expect the wrong answer
    const lines = sampleWith({}).dataset.split('\n');
    lines[0] = JSON.stringify({ input: 'Cancel my appointment', expected: 'refill' });
    lines[2] = JSON.stringify({ input: 'I need a refill', expected: 'booking' });
    await record({ ...sampleWith({ passLine: 80 }), dataset: lines.join('\n') });
    const r = await evalReport(store, { run: 'last' });
    expect(r.headline).toBe('8 of 10 passed');
    expect(r.failures).toHaveLength(2);
    expect(r.failures[0]).toMatchObject({ status: 'failed', expected: 'refill' });
    expect(r.failures[0]!.got).toContain('cancellation');
    expect(r.failures[0]!.failedChecks[0]).toMatchObject({ type: 'contains', aiReviewer: false });
    expect(r.passLine).toMatchObject({ percent: 80, met: true });
    expect(r.vsLast).toMatchObject({ passedDelta: -2, gotWorse: 2, gotBetter: 0 });
    expect(r.vsLast!.text).toBe('Against the last run: −2 passed, 0 got better, 2 got worse');
    // the cases that flipped, the ones that got worse first (A-3)
    expect(r.flipped).toHaveLength(2);
    expect(r.flipped![0]).toMatchObject({ from: 'passed', to: 'failed' });
    expect(r.flipped!.map((f) => f.key)).toEqual(r.failures.map((f) => f.key));
    expect(r.text).toContain('Got worse: ');
    expect(r.previous?.passed).toBe(10);
    expect(r.trend.map((t) => t.passed)).toEqual([10, 8]);
    expect(r.text).toContain('Failed: ');
    expect(r.text).toContain('Against the last run: −2 passed');
  });

  it('a run is found by its evaluation name, and a different last run can be chosen', async () => {
    const byName = await evalReport(store, { run: 'Sample: support intents' });
    expect(byName.headline).toBe('8 of 10 passed');
    const first = byName.trend[0]!.runId;
    const against = await evalReport(store, { run: 'last', against: first });
    expect(against.previous?.runId).toBe(first);
  });

  it('a pass line that is not reached says so', async () => {
    const lines = sampleWith({}).dataset.split('\n').map((l) => JSON.stringify({ ...JSON.parse(l), expected: 'nonsense' }));
    await record({ ...sampleWith({ passLine: 90 }), dataset: lines.join('\n') });
    const r = await evalReport(store, { run: 'last' });
    expect(r.headline).toBe('0 of 10 passed');
    expect(r.passLine).toMatchObject({ met: false });
    expect(r.text).toContain('Pass line 90%: not met.');
    expect(r.failures).toHaveLength(10);
  });
});

describe('one case against the run before (AU-22)', () => {
  it('the same answer for a case that now fails says the case got worse, and nothing changed in the text', async () => {
    // the run before (8 of 10) failed cases 1 and 3; the last (0 of 10) fails every one
    const r = await evalReport(store, { run: 'last' });
    const key = r.failures[1]!.key;
    const d = await evalCaseDiff(store, { run: 'last', case: key });
    expect(d.key).toBe(key);
    expect(d.same).toBe(true);
    expect(d.change).toBe('got worse');
    expect(d.text).toContain('same as in the last run');
    expect(d.against?.id).toBe(r.previous?.runId);
    await expect(evalCaseDiff(store, { run: 'last', case: 'definitely-not-a-case' })).rejects.toThrow(/no case/i);
  });

  it('a changed answer comes with the structured difference', async () => {
    // a second model answers "other" to everything, so its answers differ from the demo model's
    ensureSample(store);
    store.saveProviders([...store.getProviders().filter((p) => p.id !== 'demo-b'), { id: 'demo-b', name: 'Demo B', kind: 'mock', baseUrl: 'mock://', defaultModel: 'demo', headers: [{ key: 'x-mock-rules', value: JSON.stringify([{ match: '.', response: '{"intent":"other"}' }]) }] }]);
    const s = sampleWith({ passLine: undefined });
    await record(s);
    await record({ ...s, provider: 'demo-b' });
    const rep = await evalReport(store, { run: 'last' });
    const d = await evalCaseDiff(store, { run: 'last', case: rep.failures[0]!.key });
    expect(d.same).toBe(false);
    expect(d.change).toBe('got worse');
    expect(d.diff?.body.format).toBe('json');
    expect(d.diff?.body.changes[0]).toMatchObject({ path: '$.intent', kind: 'changed' });
    expect(d.text).toContain('changed since the last run');
    expect(d.before?.answer).not.toBe(d.now.answer);
  });

  it('the first run of an evaluation has nothing to compare with and says what to do', async () => {
    const id = (await record({ ...sampleWith({}), name: 'Lonely evaluation' })).runId;
    let key = '';
    for await (const r of runResults(store, id)) {
      key = evalCaseKey(r.id);
      break;
    }
    const d = await evalCaseDiff(store, { run: 'Lonely evaluation', case: key });
    expect(d.against).toBeUndefined();
    expect(d.text).toBe('There is no earlier run of this evaluation to compare with. Run it again to see what changed.');
  });
});

describe('why did this fail (AU-15)', () => {
  it('builds the context the task is given from the stored case; a check of fixed rules has no stored reason', async () => {
    const s = sampleWith({ passLine: undefined });
    const lines = s.dataset.split('\n');
    lines[0] = JSON.stringify({ input: 'Cancel my appointment', expected: 'refill' });
    await record({ ...s, dataset: lines.join('\n') });
    const rep = await evalReport(store, { run: 'last' });
    const f = rep.failures[0]!;
    const why = await evalWhy(store, { run: 'last', case: f.key });
    expect(why.stored).toBeUndefined();
    expect(why.context).toMatchObject({ case: f.key, expected: 'refill' });
    expect(String(why.context.prompt)).toContain('Cancel my appointment');
    expect(String(why.context.reply)).toContain('cancellation');
    expect((why.context.failedChecks as unknown[]).length).toBe(1);
    // by result id too
    expect((await evalWhy(store, { run: 'last', case: f.resultId })).key).toBe(f.key);
  });

  it('a case that passed has nothing to explain, and an unknown case says where to look', async () => {
    const id = (await evalReport(store, { run: 'last' })).run.id;
    let passed = '';
    for await (const r of runResults(store, id)) if (r.status === 'passed') passed = r.id;
    await expect(evalWhy(store, { run: 'last', case: passed })).rejects.toThrow(/nothing to explain/);
    await expect(evalWhy(store, { run: 'last', case: 'definitely-not-a-case' })).rejects.toThrow(/no case/i);
  });

  it('an AI reviewer’s own reason is the answer: no model is needed', async () => {
    const t = (over: Partial<TestResult>): TestResult => ({ id: 'hand:c1', name: 'c1', type: 'llm', status: 'failed', startedAt: new Date().toISOString(), durationMs: 5, attempts: 1, checks: [], input: 'Is the sky green?', output: 'Yes, it is.', ...over }) as TestResult;
    const result = t({
      checks: [{ type: 'llm-judge', name: 'polite and right', passed: false, source: 'ai-judge', score: 0.2, message: 'judge score 0.2 (threshold 0.7)', explanation: 'The reply agrees with a false claim.' }],
    });
    const f = failureOf(result);
    expect(f.reason).toBe('The reply agrees with a false claim.');
    expect(f.failedChecks[0]).toMatchObject({ aiReviewer: true, reason: 'The reply agrees with a false claim.' });
    const out = store.runDir('run-hand');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'results.jsonl'), `${JSON.stringify(result)}\n`);
    const summary = { runId: 'run-hand', name: 'Hand', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 5, total: 1, passed: 0, failed: 1, skipped: 0, errors: 0, latency: { count: 0, min: 0, max: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0 }, tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, costUsd: 0, cancelled: false, scores: {}, reproducibility: {} } as unknown as RunSummary;
    await recordRun(store, summary, out);
    const why = await evalWhy(store, { run: 'run-hand', case: 'c1' });
    expect(why.stored).toEqual({ source: 'AI reviewer', reason: 'The reply agrees with a false claim.' });
    const rep = await evalReport(store, { run: 'run-hand' });
    expect(rep.byCheck[0]).toMatchObject({ name: 'polite and right', aiReviewer: true, passed: 0, total: 1 });
    expect(rep.failures[0]!.reason).toBe('The reply agrees with a false claim.');
  });
});

describe('compare mode (AU-16)', () => {
  it('the evaluation is the first variant and each variant changes only what it names', () => {
    const base: SavedEvaluation = { ...sampleWith({}), name: 'Intent', variants: [{ label: 'Shorter', prompt: 'Customer: {{input}}' }, { label: 'Haiku', provider: 'demo-b', model: 'haiku' }] };
    const v = evaluationVariants(base);
    expect(v.map((x) => [x.letter, x.label, x.runName])).toEqual([
      ['A', 'Current', 'Intent · Current'],
      ['B', 'Shorter', 'Intent · Shorter'],
      ['C', 'Haiku', 'Intent · Haiku'],
    ]);
    expect(v[1]!.draft.prompt).toBe('Customer: {{input}}');
    expect(v[1]!.draft.provider).toBe(base.provider);
    expect(v[2]!.draft).toMatchObject({ provider: 'demo-b', model: 'haiku', prompt: base.prompt });
    expect(v[0]!.draft.variants).toBeUndefined();
  });

  it('two variants with the same name are refused', () => {
    expect(() => evaluationVariants({ ...sampleWith({}), variants: [{ label: 'Current' }] })).toThrow(/called "Current"/);
    expect(() => evaluationVariants({ ...sampleWith({}), variants: [{ label: 'X' }, { label: 'x' }] })).toThrow(/called "x"/);
  });

  it('compares the latest run of each variant: a row per measure, the winner, and the sentence', async () => {
    const base: SavedEvaluation = { ...sampleWith({ passLine: undefined }), name: 'Intent v', variants: [{ label: 'Other model', provider: 'demo-b', model: 'demo' }] };
    const waiting = await variantsSummary(store, { evaluation: base });
    expect(waiting.ready).toBe(false);
    expect(waiting.waiting).toEqual(['A: Current', 'B: Other model']);
    expect(waiting.conclusion).toContain('Waiting for A: Current, B: Other model');
    for (const v of evaluationVariants(base)) await record(v.draft);
    const s = await variantsSummary(store, { evaluation: base });
    expect(s.ready).toBe(true);
    expect(s.columns.map((c) => `${c.letter} ${c.passed}/${c.total}`)).toEqual(['A 10/10', 'B 3/10']);
    expect(s.rows[0]).toMatchObject({ metric: 'passed', label: 'Passed', values: ['10 of 10', '3 of 10'], winner: 'A', winnerText: 'A (+7)' });
    expect(s.rows[1]).toMatchObject({ metric: 'cost', values: ['free', 'free'], winnerText: 'free' });
    expect(s.cases).toEqual({ gotWorse: 7, gotBetter: 0 });
    expect(s.conclusion).toContain('B passes 7 cases fewer');
    expect(s.conclusion).toContain('7 cases got worse and 0 got better: look at them.');
    expect(s.runs).toHaveLength(2);
    // the runs can be named: the same comparison
    const named = await variantsSummary(store, { evaluation: base, runs: s.runs });
    expect(named.columns.map((c) => c.passed)).toEqual([10, 3]);
    // an evaluation with no variants asks for one
    const none = await variantsSummary(store, { evaluation: { ...base, variants: [] } });
    expect(none.conclusion === '' || none.conclusion.includes('Waiting') || none.conclusion.includes('Add a variant')).toBe(true);
  });

  it('the evaluation as saved is found by name', () => {
    expect(findSavedEvaluation(store, 'Sample: support intents').name).toBe('Sample: support intents');
  });
});
