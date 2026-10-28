import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceStore,
  MemorySecretStore,
  createEngineContext,
  ensureSample,
  evaluationTests,
  estimateEvaluation,
  spendPlan,
  capRunOptions,
  tryEvalCheck,
  runTests,
  ciConfig,
  ciCommand,
  SAMPLE_NAME,
  sampleEvaluation,
  findSavedEvaluation,
  type SavedEvaluation,
  type RunEvent,
} from '../../packages/core/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'tp-aiq-'));
const store = WorkspaceStore.create(join(dir, 'ws'), 'AIQ');
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const ctx = () => createEngineContext({ store, secrets: new MemorySecretStore(), settings: { pricing: [] } as never });

describe('the sample (AU-4)', () => {
  it('adds the offline demo model and the evaluation, runs 10 of 10 with no key, and is put back when edited', async () => {
    const a = ensureSample(store);
    expect(a.created).toBe(true);
    expect(a.providerAdded).toBe(true);
    expect(a.evaluation.name).toBe(SAMPLE_NAME);
    expect(store.getProviders().find((p) => p.id === 'demo')?.kind).toBe('mock');
    const c = ctx();
    try {
      let passed = 0;
      const summary = await runTests({ name: a.evaluation.name, tests: evaluationTests(a.evaluation, { store }), services: c.services, concurrency: 4, onEvent: (e: RunEvent) => void (e.type === 'test-end' && e.result.status === 'passed' && passed++) });
      expect(summary.total).toBe(10);
      expect(summary.passed).toBe(10);
      expect(passed).toBe(10);
    } finally {
      await c.dispose();
    }
    const b = ensureSample(store);
    expect(b.created).toBe(false);
    expect(b.providerAdded).toBe(false);
    expect(b.evaluation.id).toBe(a.evaluation.id);
    expect(findSavedEvaluation(store, SAMPLE_NAME).dataset).toBe(sampleEvaluation().dataset);
  });
});

describe('the estimate and the spend cap (AU-5, AU-18)', () => {
  const draft = (over: Partial<SavedEvaluation> = {}): SavedEvaluation => ({ ...sampleEvaluation(), ...over });
  const services = (pricing: Array<{ provider: string; model: string; inputPerMillion: number; outputPerMillion: number; version: string }> = []) => {
    store.saveProviders([...store.getProviders().filter((p) => p.id !== 'paid'), { id: 'paid', name: 'Paid', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: '{{$env.PAID_KEY}}' }]);
    const c = createEngineContext({ store, secrets: new MemorySecretStore(), settings: { pricing } as never });
    return c;
  };

  it('the offline demo model is free and says so', async () => {
    const c = ctx();
    try {
      const e = estimateEvaluation(c.services, draft());
      expect(e).toMatchObject({ cases: 10, calls: 10, offline: true, free: true, costUsd: 0, priced: true });
      expect(e.summary).toContain('free (offline demo model)');
      expect(spendPlan(e)).toMatchObject({ ask: false, enforced: false });
    } finally {
      await c.dispose();
    }
  });

  it('a priced model: dollars from the price table, a $1.00 cap, asks over $0.50', async () => {
    const c = services([{ provider: '*', model: '*', inputPerMillion: 1000, outputPerMillion: 3000, version: 't' }]);
    try {
      const big = estimateEvaluation(c.services, draft({ provider: 'paid', model: 'm' }));
      expect(big.costUsd).toBeGreaterThan(0.5);
      expect(big.summary).toMatch(/about \$/);
      const plan = spendPlan(big);
      expect(plan).toMatchObject({ capUsd: 1, enforced: true, ask: true });
      expect(spendPlan(big, 0).capUsd).toBeUndefined();
      expect(spendPlan(big, 5).capUsd).toBe(5);
    } finally {
      await c.dispose();
    }
  });

  it('a model with no price says the cost is unknown and the cap cannot hold', async () => {
    const c = services([]);
    try {
      const e = estimateEvaluation(c.services, draft({ provider: 'paid', model: 'm' }));
      expect(e.priced).toBe(false);
      expect(e.costUsd).toBeUndefined();
      expect(e.summary).toContain('cost unknown');
      const p = spendPlan(e);
      expect(p.enforced).toBe(false);
      expect(p.reason).toContain('cannot stop the run');
    } finally {
      await c.dispose();
    }
  });

  it('an AI reviewer check doubles the calls', async () => {
    const c = ctx();
    try {
      const e = estimateEvaluation(c.services, draft({ evaluators: [{ type: 'llm-judge', criteria: 'polite' } as never] }));
      expect(e.calls).toBe(20);
      expect(e.reviewerChecks).toBe(1);
    } finally {
      await c.dispose();
    }
  });

  it('the cap stops a run once the results cost that much, and says how far it got', async () => {
    const c = ctx();
    try {
      // results of $0.40 each: the third pushes past $1.00 and the run stops
      const events: RunEvent[] = [];
      const base = { name: 'x', tests: [], services: c.services, onEvent: (e: RunEvent) => void events.push(e) } as never;
      const { options, guard } = capRunOptions(base, 1);
      expect(options.signal?.aborted).toBe(false);
      for (let i = 0; i < 3; i++) options.onEvent!({ type: 'test-end', runId: 'r', result: { costUsd: 0.4 } as never });
      expect(guard.stopped).toBe(true);
      expect(options.signal?.aborted).toBe(true);
      expect(guard.message(20)).toBe('Stopped at $1.00 after 3 of 20 cases. Raise the cap to continue.');
      expect(events).toHaveLength(3);
      // no cap: nothing is wrapped
      expect(capRunOptions(base, undefined).options).toBe(base);
    } finally {
      await c.dispose();
    }
  });
});

describe('trying a check on a case (AU-11)', () => {
  it('shows the reply and whether the check passed, free on the offline demo model', async () => {
    const d = ensureSample(store).evaluation;
    const c = ctx();
    try {
      const pass = await tryEvalCheck({ draft: d, check: { type: 'contains', expected: '{{expected}}', ignoreCase: true }, caseNumber: 3 }, { services: c.services, store });
      expect(pass.dryRun).toBe(false);
      expect(pass.cases).toBe(10);
      expect(pass.reply).toContain('refill');
      expect(pass.passed).toBe(true);
      const fail = await tryEvalCheck({ draft: d, check: { type: 'contains', expected: 'cancellation' }, caseNumber: 3 }, { services: c.services, store });
      expect(fail.passed).toBe(false);
      expect(fail.reason).toBeTruthy();
      const dry = await tryEvalCheck({ draft: d, check: { type: 'llm-judge', criteria: 'x' } as never, dryRun: true }, { services: c.services, store });
      expect(dry.dryRun).toBe(true);
      expect(dry.reply).toBeUndefined();
      expect(dry.estimate).toMatchObject({ calls: 2, reviewerChecks: 1, free: true });
      await expect(tryEvalCheck({ draft: d, check: { type: 'is-json' }, caseNumber: 99 }, { services: c.services, store })).rejects.toThrow(/no case 99/);
    } finally {
      await c.dispose();
    }
  });
});

describe('Run in CI from an evaluation (AU-17)', () => {
  it('the command compares with the last good run and fails on regressions; the model key is a CI secret', () => {
    ensureSample(store);
    store.saveProviders([...store.getProviders().filter((p) => p.id !== 'openai'), { id: 'openai', name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: '{{$secret.provider.openai.apiKey}}' }]);
    const cmd = ciCommand({ provider: 'github', evaluation: SAMPLE_NAME });
    expect(cmd).toContain('eval run "Sample: support intents"');
    expect(cmd).toContain('--baseline last-good --fail-on-regression --yes');
    const c = ciConfig(store, { provider: 'github', evaluation: SAMPLE_NAME });
    expect(c.content).toContain('Run evaluation Sample: support intents');
    expect(c.secrets.map((s) => s.name)).toContain('TESTPION_SECRET_PROVIDER_OPENAI_APIKEY');
    expect(() => ciConfig(store, { provider: 'github', evaluation: 'nope' })).toThrow(/No saved evaluation/);
    expect(() => ciConfig(store, { provider: 'github', evaluation: SAMPLE_NAME, tests: ['.'] })).toThrow(/Choose one/);
  });
});
