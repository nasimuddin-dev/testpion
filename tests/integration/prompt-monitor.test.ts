/**
 * A prompt (or agent) evaluation as a monitor: the saved evaluation runs on a schedule on the offline demo model, a failing case fails
 * the monitor, and `baseline: previous` also fails it when the pass rate fell more than `maxDrop` against the monitor's run before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { MemorySecretStore, WorkspaceStore, createEngineContext, defaultSettings, ensureSample, executeMonitor, saveMonitor, EVALUATIONS_LIBRARY, SAMPLE_NAME, type Monitor, type SavedEvaluation } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

const t = tempDir('tp-prompt-monitor-');
let store: WorkspaceStore;

const run = (m: Monitor) => executeMonitor({ store, monitor: m, trigger: 'manual', context: (o) => createEngineContext({ store, secrets: new MemorySecretStore(), settings: defaultSettings(), environment: o.environment }) });
const base = (over: Partial<Monitor> = {}): Monitor => ({ id: 'mon-prompt', name: 'Intents nightly', evaluation: SAMPLE_NAME, everyMinutes: 60, enabled: true, ...over });
const edit = (change: (d: SavedEvaluation) => SavedEvaluation) => {
  const lib = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY);
  store.saveLibrary(EVALUATIONS_LIBRARY, { folders: lib.folders, items: lib.items.map((i) => (i.name === SAMPLE_NAME ? { ...i, data: change(i.data) } : i)) });
};

beforeAll(() => {
  store = WorkspaceStore.create(join(t.dir, 'ws'), 'Prompt monitor');
  ensureSample(store);
});
afterAll(() => {
  store.close();
  t.cleanup();
});

describe('a monitor that runs a prompt evaluation', () => {
  it('is validated: bot-only settings are refused, the baseline is the previous run', () => {
    expect(() => saveMonitor(store, base({ gates: { faithfulness: 0.8 } }))).toThrow(/for a bot with sources/);
    expect(() => saveMonitor(store, base({ judgeSample: 0.5 }))).toThrow(/judgeSample is for a bot with sources/);
    expect(() => saveMonitor(store, base({ baseline: 'best' }))).toThrow(/previous run only/);
    expect(() => saveMonitor(store, base({ maxDrop: 2 }))).toThrow(/more than 0 and at most 1/);
    expect(() => saveMonitor(store, base({ limit: 0 }))).toThrow(/number of cases/);
    expect(() => saveMonitor(store, base({ baseline: 'previous', maxDrop: 0.1, limit: 5 }))).not.toThrow();
  });

  it('passes when every case passes, then fails with the reason when the pass rate falls', async () => {
    saveMonitor(store, base({ baseline: 'previous', maxDrop: 0.1 }));
    const first = await run(base({ baseline: 'previous', maxDrop: 0.1 }));
    expect(first).toMatchObject({ status: 'passed', total: 10, passed: 10 });
    // the wording is changed so that some answers no longer carry the expected word: the pass rate falls
    edit((d) => ({ ...d, evaluators: [{ type: 'contains', expected: '{{expected}}x', ignoreCase: true }] }));
    const second = await run(base({ baseline: 'previous', maxDrop: 0.1 }));
    expect(second.status).toBe('failed');
    expect(second.passed).toBeLessThan(10);
    expect(second.reason).toMatch(/pass rate \d+% fell \d+ points against run-/);
    // a monitor's run is recorded like any other, under the monitor's name
    expect(store.meta.listRuns({ limit: 20 }).items.filter((r) => r.name.includes('Intents nightly')).length).toBeGreaterThanOrEqual(2);
  }, 120_000);
});

describe('testpion monitor add --evaluation', () => {
  it('saves a monitor of a prompt evaluation and refuses bot-only options', async () => {
    const { runCli, cliData } = await import('../helpers.js');
    const env = { ...process.env, TESTPION_HOME: join(t.dir, 'home') };
    const ws = store.root;
    const add = await runCli(['monitor', 'add', 'Intents cli', '--evaluation', SAMPLE_NAME, '--every', '1h', '--baseline', 'previous', '--max-drop', '0.2', '--limit', '3', '-w', ws, '--json'], { env });
    expect(add.status).toBe(0);
    expect(cliData<{ evaluation?: string; baseline?: string; maxDrop?: number; limit?: number }>(add.out)).toMatchObject({ evaluation: SAMPLE_NAME, baseline: 'previous', maxDrop: 0.2, limit: 3 });
    const refused = await runCli(['monitor', 'add', 'Bad cli', '--evaluation', SAMPLE_NAME, '--every', '1h', '--judge-sample', '0.5', '-w', ws], { env });
    expect(refused.status).not.toBe(0);
    expect(refused.err + refused.out).toMatch(/for a bot with sources/);
  }, 120_000);
});

describe('testpion eval lint', () => {
  it('says what is off about the cases, exits 1 for it, and is quiet for healthy cases', async () => {
    const { runCli, cliData } = await import('../helpers.js');
    const env = { ...process.env, TESTPION_HOME: join(t.dir, 'home') };
    const ws = store.root;
    const healthy = await runCli(['eval', 'lint', SAMPLE_NAME, '-w', ws, '--json'], { env });
    expect(healthy.status).toBe(0);
    expect(cliData<{ notes: unknown[]; cases: number }>(healthy.out)).toMatchObject({ cases: 10, notes: [] });
    edit((d) => ({ ...d, dataset: [...d.dataset.split('\n'), d.dataset.split('\n')[0]!].join('\n') }));
    const off = await runCli(['eval', 'lint', SAMPLE_NAME, '-w', ws, '--json'], { env });
    expect(off.status).toBe(1);
    expect(cliData<{ notes: Array<{ kind: string; cases: number[] }> }>(off.out).notes).toMatchObject([{ kind: 'duplicates', cases: [11] }]);
    const listed = await runCli(['eval', 'list', '-w', ws, '--json'], { env });
    expect(JSON.stringify(cliData(listed.out))).toContain('repeats an input already in the list');
  }, 120_000);
});
