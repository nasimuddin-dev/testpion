import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { McpSession, WorkspaceStore, mcpResultBody, EVALUATIONS_LIBRARY, type SavedEvaluation } from '../../packages/core/src/index.js';
import { cliData, cliPath, runCli, tempDir } from '../helpers.js';

/** The report card, why a case failed, a case against the run before and compare mode: the same words from the CLI and the MCP tools. */
const tmp = tempDir('tp-evr-cli-');
let ws: string;
let env: NodeJS.ProcessEnv;
const SAMPLE = 'Sample: support intents';

beforeAll(async () => {
  ws = join(tmp.dir, 'ws');
  WorkspaceStore.create(ws, 'EVR').close();
  env = { ...process.env, TESTPION_HOME: join(tmp.dir, 'home') };
  // the sample, run clean once
  expect((await runCli(['eval', 'sample', '-w', ws, '-q'], { env })).status).toBe(0);
  // then edited: two cases expect the wrong answer, a pass line, and a variant on a second offline model that answers "other" to everything
  const store = WorkspaceStore.open(ws);
  try {
    store.saveProviders([...store.getProviders(), { id: 'demo-b', name: 'Demo B', kind: 'mock', baseUrl: 'mock://', defaultModel: 'demo', headers: [{ key: 'x-mock-rules', value: JSON.stringify([{ match: '.', response: '{"intent":"other"}' }]) }] }]);
    const lib = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY);
    const lines = lib.items[0]!.data.dataset.split('\n');
    lines[0] = JSON.stringify({ input: 'Cancel my appointment', expected: 'refill' });
    lines[2] = JSON.stringify({ input: 'I need a refill', expected: 'booking' });
    store.saveLibrary(EVALUATIONS_LIBRARY, { folders: lib.folders, items: lib.items.map((i) => ({ ...i, data: { ...i.data, dataset: lines.join('\n'), passLine: 80, variants: [{ label: 'Other model', provider: 'demo-b', model: 'demo' }] } })) });
  } finally {
    store.close();
  }
}, 120_000);
afterAll(() => tmp.cleanup());

const cli = (args: string[]) => runCli(args, { env });

describe('testpion eval summary | why | diff', () => {
  it('runs the edited evaluation (8 of 10), then eval summary says it in words and in JSON', async () => {
    const run = await cli(['eval', 'run', SAMPLE, '-w', ws, '-q', '-r', 'console']);
    expect(run.status).toBe(1);
    const words = await cli(['eval', 'summary', 'last', '-w', ws]);
    expect(words.status).toBe(0);
    expect(words.out).toContain('8 of 10 passed');
    expect(words.out).toContain('Pass line 80%: met');
    expect(words.out).toContain('Against the last run: −2 passed');
    expect(words.out).toContain('Offline demo model');
    const d = cliData((await cli(['eval', 'summary', SAMPLE, '-w', ws, '--json'])).out);
    expect(d).toMatchObject({ headline: '8 of 10 passed', passed: 8, total: 10, offline: true, vsLast: { passedDelta: -2, gotWorse: 2, gotBetter: 0 }, passLine: { percent: 80, met: true } });
    expect(d.failures).toHaveLength(2);
    expect(d.failures[0]).toMatchObject({ expected: 'refill', status: 'failed' });
    expect(d.text).toContain('8 of 10 passed (80%).');
    expect(d.trend.map((t: { passed: number }) => t.passed)).toEqual([10, 8]);
  }, 120_000);

  it('eval why: no stored reason on a check of fixed rules, so --no-ai says so; --dry-run shows what would be sent', async () => {
    const d = cliData((await cli(['eval', 'summary', 'last', '-w', ws, '--json'])).out);
    const key = d.failures[0].key as string;
    const none = await cli(['eval', 'why', 'last', key, '-w', ws, '--no-ai', '--json']);
    expect(none.status).toBe(0);
    expect(cliData(none.out)).toMatchObject({ case: key, calledModel: false, expected: 'refill' });
    const dry = await cli(['eval', 'why', 'last', key, '-w', ws, '--dry-run', '--json']);
    // an AI model must be set up to preview what is sent: without one the command says what to configure instead of calling anything
    if (dry.status === 0) {
      const p = cliData(dry.out);
      expect(p).toMatchObject({ calledModel: false, dryRun: true });
      expect(JSON.stringify(p.preview)).toContain('Cancel my appointment');
    } else expect(dry.out + dry.err).toMatch(/AI|model|provider/i);
    // a passed case has nothing to explain
    const passedKey = 'does-not-exist';
    expect((await cli(['eval', 'why', 'last', passedKey, '-w', ws, '--no-ai'])).status).not.toBe(0);
  }, 120_000);

  it('eval diff: the case got worse with the same answer, against the run before; the first run has nothing before it', async () => {
    const d = cliData((await cli(['eval', 'summary', 'last', '-w', ws, '--json'])).out);
    const key = d.failures[0].key as string;
    const diff = cliData((await cli(['eval', 'diff', 'last', key, '-w', ws, '--json'])).out);
    expect(diff).toMatchObject({ key, same: true, change: 'got worse' });
    expect(diff.text).toContain('same as in the last run');
    const words = await cli(['eval', 'diff', 'last', key, '-w', ws]);
    expect(words.out).toContain('got worse');
  }, 120_000);
});

describe('testpion eval run --variants | variants', () => {
  it('runs the evaluation and its variant, prints the comparison, and eval variants --json has the rows and the sentence', async () => {
    const run = await cli(['eval', 'run', SAMPLE, '-w', ws, '--variants']);
    expect(run.status).toBe(0);
    expect(run.out).toContain('Variant A: Current');
    expect(run.out).toContain('Variant B: Other model');
    expect(run.out).toContain('Passed');
    const s = cliData((await cli(['eval', 'variants', SAMPLE, '-w', ws, '--json'])).out);
    expect(s).toMatchObject({ ready: true, evaluation: SAMPLE });
    expect(s.columns.map((c: { passed: number }) => c.passed)).toEqual([8, 3]);
    expect(s.rows[0]).toMatchObject({ metric: 'passed', winner: 'A' });
    expect(s.conclusion).toContain('B passes 5 cases fewer');
    // the comparison is read from the runs it made, named "<evaluation> · <variant>"
    const summary = cliData((await cli(['eval', 'summary', `${SAMPLE} · Other model`, '-w', ws, '--json'])).out);
    expect(summary.headline).toBe('3 of 10 passed');
  }, 180_000);

  it('an evaluation with no variants says how to add them', async () => {
    const store = WorkspaceStore.open(ws);
    try {
      const lib = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY);
      store.saveLibrary(EVALUATIONS_LIBRARY, { folders: lib.folders, items: [...lib.items, { id: 'ev-plain', name: 'Plain', data: { ...lib.items[0]!.data, variants: undefined }, updatedAt: new Date().toISOString() }] });
    } finally {
      store.close();
    }
    const r = await cli(['eval', 'run', 'Plain', '-w', ws, '--variants']);
    expect(r.status).toBe(2);
    expect(r.out + r.err).toContain('has no variants');
  }, 60_000);
});

describe('the MCP tools', () => {
  it('eval_summary, eval_case_diff, eval_explain_failure (stored_only), eval_variants and run_evaluation with variants', async () => {
    const s = new McpSession({ id: 'evr', name: 'testpion', transport: 'stdio', command: process.execPath, args: [cliPath, 'mcp-server', '-w', ws], env });
    await s.connect(20_000);
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(mcpResultBody(await s.callTool(name, args)).text);
    try {
      const sum = await call('eval_summary', { run: SAMPLE });
      expect(sum).toMatchObject({ headline: '8 of 10 passed', passLine: { met: true } });
      const key = sum.failures[0].key as string;
      const diff = await call('eval_case_diff', { run: SAMPLE, case: key });
      expect(diff).toMatchObject({ key, change: 'got worse', same: true });
      const why = await call('eval_explain_failure', { run: SAMPLE, case: key, stored_only: true });
      expect(why).toMatchObject({ calledModel: false, case: key });
      expect(why.note).toContain('No AI reviewer');
      const ran = await call('run_evaluation', { name: SAMPLE, variants: true });
      expect(ran.runs).toHaveLength(2);
      expect(ran.comparison.columns.map((c: { passed: number }) => c.passed)).toEqual([8, 3]);
      const v = await call('eval_variants', { name: SAMPLE });
      expect(v.conclusion).toContain('B passes 5 cases fewer');
    } finally {
      await s.close();
    }
  }, 180_000);
});
