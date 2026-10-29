/**
 * Test cases with AI (AU-13) and trust the AI reviewer (AU-23), engine level: a scripted offline model writes cases from the
 * prompt, an API definition and History; every case is verified (variables filled, not a repeat, names something the source has);
 * accepting adds them to the saved evaluation with one undo. Then ten answers of a run are graded by "the person" and the AI
 * reviewer's agreement is said. No network and no key.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceStore,
  MemorySecretStore,
  aiRunDeps,
  applyProposal,
  createEngineContext,
  ensureSample,
  evaluationTests,
  findSavedEvaluation,
  generateEvalCases,
  promptVariables,
  recordsOfProposal,
  recordRun,
  runTests,
  trustReviewer,
  undoProposal,
  EVALUATIONS_LIBRARY,
  type SavedEvaluation,
} from '../../packages/core/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'tp-evcases-'));
const store = WorkspaceStore.create(join(dir, 'ws'), 'Cases');
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const settings = { pricing: [], ai: { small: { provider: 'scripted' }, large: { provider: 'scripted' } } } as never;
const ctx = () => createEngineContext({ store, secrets: new MemorySecretStore(), settings });
const mock = (id: string, rules: Array<{ match: string; response: string }>) => ({ id, name: id, kind: 'mock' as const, baseUrl: 'mock://local', defaultModel: 'm', headers: [{ key: 'x-mock-rules', value: JSON.stringify(rules) }] });
const setScript = (rules: Array<{ match: string; response: string }>) => store.saveProviders([...store.getProviders().filter((p) => p.id !== 'scripted'), mock('scripted', rules)]);
const cases = (list: Array<{ input: string; expected: string }>) => JSON.stringify({ cases: list.map((c) => ({ inputs: { input: c.input }, expected: c.expected, tags: ['t'], why: 'w' })) });
const generate = async (o: Parameters<typeof generateEvalCases>[2]) => {
  const c = ctx();
  try {
    return await generateEvalCases(aiRunDeps({ ctx: c, settings, store, surface: 'cli' }), store, o);
  } finally {
    await c.dispose();
  }
};

describe('cases from the prompt', () => {
  it('writes cases, verifies them, leaves a repeat of an existing case unticked and adds the ticked ones with one undo', async () => {
    const sample = ensureSample(store).evaluation;
    setScript([
      {
        match: '"existingCount"',
        response: cases([
          { input: 'Please cancel my visit for tomorrow morning', expected: 'cancellation' },
          { input: 'I need to cancel my Friday visit', expected: 'cancellation' }, // already a case of the sample
          { input: 'Can you renew my prescription?', expected: 'refill' },
          { input: 'Can you renew my prescription??', expected: 'refill' }, // a repeat of the one before
          { input: '', expected: 'other' }, // no input
        ]),
      },
    ]);
    const r = await generate({ source: 'prompt', draft: sample, evaluation: sample.id, count: 5 });
    const p = r.proposal!;
    // the near-repeat of the previous proposed case is left out and said so
    expect(p.items.map((i) => (i.data as { record: Record<string, string> }).record.input)).toEqual(['Please cancel my visit for tomorrow morning', 'I need to cancel my Friday visit', 'Can you renew my prescription?', '']);
    expect(p.notes?.some((n) => /repeat/i.test(n))).toBe(true);
    const badge = (i: number, v: string) => p.items[i]!.verification.find((b) => b.verifier === v)!;
    expect(badge(0, 'eval-case-shape').status).toBe('pass');
    expect(badge(0, 'eval-case-duplicate').status).toBe('pass');
    expect(badge(1, 'eval-case-duplicate').status).toBe('fail');
    expect(badge(3, 'eval-case-shape').status).toBe('fail');
    expect(p.items.map((i) => i.selected)).toEqual([true, false, true, false]);
    expect(r.tally).toEqual({ verified: 2, warned: 0, failed: 2 });
    // the cases of an unsaved draft: the ticked records
    expect(recordsOfProposal(p)).toEqual([expect.objectContaining({ input: 'Please cancel my visit for tomorrow morning', expected: 'cancellation' }), expect.objectContaining({ input: 'Can you renew my prescription?' })]);

    const before = findSavedEvaluation(store, sample.name).dataset;
    const applied = applyProposal(store, p.id);
    expect(applied.applied).toHaveLength(2);
    const after = findSavedEvaluation(store, sample.name);
    expect(after.dataset.split('\n')).toHaveLength(12);
    expect(after.datasetFormat).toBe('jsonl');
    expect(after.dataset).toContain('Please cancel my visit for tomorrow morning');
    undoProposal(store, p.id);
    expect(findSavedEvaluation(store, sample.name).dataset).toBe(before);
  });

  it('the offline demo model writes cases with no setup, and a dry run sends nothing', async () => {
    const sample = ensureSample(store).evaluation;
    const dry = await generate({ source: 'prompt', draft: sample, evaluation: sample.id, dryRun: true, provider: 'demo' });
    expect(dry.dryRun).toBe(true);
    expect(dry.proposal).toBeUndefined();
    expect(JSON.stringify(dry.preview)).toContain('tokens');
    const r = await generate({ source: 'prompt', draft: sample, evaluation: sample.id, provider: 'demo' });
    expect(r.proposal!.items).toHaveLength(6);
    expect(r.proposal!.items.every((i) => i.kind === 'eval-case')).toBe(true);
    expect(r.proposal!.items.filter((i) => i.selected).length).toBeGreaterThanOrEqual(5);
  });

  it('a draft with no saved evaluation cannot be applied by the engine, and says what to do', async () => {
    const sample = ensureSample(store).evaluation;
    const r = await generate({ source: 'prompt', draft: sample, provider: 'demo' });
    expect(() => applyProposal(store, r.proposal!.id)).toThrow(/Save the evaluation first|names no saved evaluation/);
  });

  it('a single variable takes the input a model wrote under another name; the variables are read from the prompt', () => {
    expect(promptVariables('Say {{ a }} and {{b}} and {{a}}')).toEqual(['a', 'b']);
  });
});

describe('cases from an API definition and from History', () => {
  it('an operation the definition does not have fails the grounded check', async () => {
    const sample = ensureSample(store).evaluation;
    mkdirSync(join(store.root, 'specs'), { recursive: true });
    writeFileSync(join(store.root, 'specs', 'shop.yaml'), 'openapi: 3.0.3\ninfo: { title: Shop, version: 1.0.0 }\npaths:\n  /orders:\n    post:\n      summary: Create an order\n      responses: { "201": { description: ok } }\n  /orders/{id}:\n    get:\n      summary: Get an order\n      responses: { "200": { description: ok } }\n');
    setScript([{ match: '"existingCount"', response: cases([{ input: 'How do I place a new order?', expected: 'POST /orders' }, { input: 'How do I delete my account?', expected: 'DELETE /accounts' }]) }]);
    const r = await generate({ source: 'spec', draft: sample, spec: 'specs/shop.yaml', count: 2 });
    const [a, b] = r.proposal!.items;
    expect(a!.verification.find((x) => x.verifier === 'eval-case-grounded')?.status).toBe('pass');
    expect(b!.verification.find((x) => x.verifier === 'eval-case-grounded')?.status).toBe('fail');
    expect(b!.selected).toBe(false);
  });

  it('History: a case that looks like a real call passes, an invented one warns; no calls says what to do', async () => {
    const sample = ensureSample(store).evaluation;
    await expect(generate({ source: 'history', draft: sample })).rejects.toThrow(/History holds no prompts/);
    store.meta.addHistory({ id: 'h1', timestamp: new Date().toISOString(), kind: 'llm', name: 'demo', status: 'ok', request: { prompt: 'x', input: { input: 'Where is my parcel from the pharmacy?' } } });
    setScript([{ match: '"existingCount"', response: cases([{ input: 'Where is my parcel from the pharmacy', expected: 'other' }, { input: 'Quantum chromodynamics lecture schedule', expected: 'other' }]) }]);
    const r = await generate({ source: 'history', draft: sample });
    const g = (i: number) => r.proposal!.items[i]!.verification.find((x) => x.verifier === 'eval-case-grounded')!.status;
    expect([g(0), g(1)]).toEqual(['pass', 'warn']);
  });
});

describe('trust the AI reviewer', () => {
  it('ten answers to grade with the reviewer hidden, then how often it agreed', async () => {
    const sample = ensureSample(store).evaluation;
    // a reviewer that fails every reply that says refill, whatever you think
    store.saveProviders([...store.getProviders().filter((p) => p.id !== 'judge'), mock('judge', [{ match: 'CRITERIA[\\s\\S]*refill', response: '{"score":0,"reasoning":"not polite"}' }, { match: 'CRITERIA', response: '{"score":1,"reasoning":"polite"}' }])]);
    const draft: SavedEvaluation = { ...sample, name: 'Reviewer check', evaluators: [{ type: 'llm-judge', criteria: 'The reply is polite.', threshold: 0.5, provider: 'judge' } as never] };
    const c = ctx();
    let runId = '';
    try {
      runId = await recorded(draft, c);
    } finally {
      await c.dispose();
    }
    const first = await trustReviewer(store, { run: runId });
    expect(first.metrics).toEqual(['llm-judge']);
    expect(first.cases).toHaveLength(10);
    expect(first.graded).toBe(0);
    expect(first.done).toBe(false);
    // the reviewer's verdict is not in what the person sees
    expect(JSON.stringify(first.cases)).not.toMatch(/"passed"|reasoning|polite"/);
    let s = first;
    for (const c of first.cases) s = await trustReviewer(store, { run: runId, label: { result: c.resultId, verdict: 'pass' } });
    expect(s.graded).toBe(10);
    expect(s.done).toBe(true);
    expect(s.agreement).toBeDefined();
    expect(s.agreement!.n).toBe(10);
    // the person passed all ten; the reviewer failed the answers that said refill
    expect(s.agreement!.tooStrict).toBe(s.cases.filter((x) => /refill/.test(x.reply ?? '')).length);
    expect(s.summary).toMatch(/agreed with you on \d+ of 10/);
    // clearing one verdict takes it back to grading
    const cleared = await trustReviewer(store, { run: runId, label: { result: first.cases[0]!.resultId, verdict: null } });
    expect(cleared.graded).toBe(9);
    expect(cleared.done).toBe(false);
    // a run without an AI reviewer says what to do
    const plain = await trustReviewerOfPlainRun();
    expect(plain.metrics).toEqual([]);
    expect(plain.summary).toMatch(/Graded by an AI reviewer/);
  });
});

async function trustReviewerOfPlainRun() {
  const sample = ensureSample(store).evaluation;
  const c = ctx();
  try {
    return await trustReviewer(store, { run: await recorded({ ...sample, name: 'Plain' }, c) });
  } finally {
    await c.dispose();
  }
}

/** Run an evaluation and keep the run the way the app does (results.jsonl and the summary). */
async function recorded(d: SavedEvaluation, c: ReturnType<typeof ctx>): Promise<string> {
  const runId = `run-${Math.random().toString(36).slice(2, 10)}`;
  const outDir = store.runDir(runId);
  const summary = await runTests({ name: d.name, runId, tests: evaluationTests(d, { store }), services: c.services, concurrency: 4, resultsFile: join(outDir, 'results.jsonl'), traceMode: 'none' });
  await recordRun(store, summary, outDir);
  return runId;
}

void EVALUATIONS_LIBRARY;
