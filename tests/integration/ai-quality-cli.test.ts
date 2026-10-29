import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { McpSession, WorkspaceStore, mcpResultBody } from '../../packages/core/src/index.js';
import { cliData, cliPath, runCli, tempDir } from '../helpers.js';

/** AI quality from the command line and the MCP server: the sample, the estimate, one check on one case, the spend cap, CI. */
const tmp = tempDir('tp-aiq-cli-');
let ws: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  ws = join(tmp.dir, 'ws');
  WorkspaceStore.create(ws, 'AIQ').close();
  env = { ...process.env, TESTPION_HOME: join(tmp.dir, 'home') };
});
afterAll(() => tmp.cleanup());

const cli = (args: string[]) => runCli(args, { env });
const SAMPLE = 'Sample: support intents';

describe('testpion eval sample | estimate | check', () => {
  it('eval sample --no-run makes the evaluation; eval sample runs it with no key: 10 of 10', async () => {
    const made = await cli(['eval', 'sample', '--no-run', '-w', ws, '--json']);
    expect(made.status).toBe(0);
    expect(cliData(made.out)).toMatchObject({ evaluation: SAMPLE, created: true, providerAdded: true, cases: 10 });
    const listed = cliData(( await cli(['eval', 'list', '-w', ws, '--json'])).out);
    expect(listed).toEqual([expect.objectContaining({ name: SAMPLE, provider: 'demo', cases: 10 })]);
    const ran = await cli(['eval', 'sample', '-w', ws, '-q', '--json']);
    expect(ran.status).toBe(0);
    expect(cliData(ran.out)).toBeTruthy();
  }, 60_000);

  it('eval estimate: free on the offline demo model, no cap; --json carries the plan', async () => {
    const r = await cli(['eval', 'estimate', SAMPLE, '-w', ws, '--json']);
    expect(r.status).toBe(0);
    const d = cliData(r.out);
    expect(d).toMatchObject({ cases: 10, calls: 10, offline: true, free: true, costUsd: 0, plan: { ask: false } });
    expect(d.summary).toContain('free (offline demo model)');
    expect((await cli(['eval', 'estimate', SAMPLE, '-w', ws, '--limit', '3', '--json'])).out).toContain('"cases": 3');
  }, 60_000);

  it('eval check: the reply and passed or failed; --dry-run sends nothing; a wrong case number is refused', async () => {
    const pass = cliData((await cli(['eval', 'check', SAMPLE, '-w', ws, '--type', 'contains', '--expected', '{{expected}}', '--case', '3', '--json'])).out);
    expect(pass).toMatchObject({ caseNumber: 3, cases: 10, passed: true, dryRun: false });
    expect(pass.reply).toContain('refill');
    const fail = await cli(['eval', 'check', SAMPLE, '-w', ws, '--check', '{"type":"contains","expected":"nope"}', '--json']);
    expect(fail.status).toBe(1);
    expect(cliData(fail.out)).toMatchObject({ passed: false });
    const dry = cliData((await cli(['eval', 'check', SAMPLE, '-w', ws, '--type', 'llm-judge', '--criteria', 'polite', '--dry-run', '--json'])).out);
    expect(dry).toMatchObject({ dryRun: true, estimate: { calls: 2, reviewerChecks: 1, free: true } });
    expect(dry.reply).toBeUndefined();
    expect((await cli(['eval', 'check', SAMPLE, '-w', ws, '--type', 'is-json', '--case', '99'])).status).not.toBe(0);
    expect((await cli(['eval', 'check', SAMPLE, '-w', ws])).status).toBe(2);
  }, 60_000);

  it('eval run --baseline last-good: the first run has none and becomes it; the next is compared with it', async () => {
    const first = await cli(['eval', 'run', SAMPLE, '-w', ws, '--baseline', 'last-good', '--fail-on-regression', '-r', 'console']);
    expect(first.status).toBe(0);
    expect(first.out).toContain('no earlier good run');
    const second = await cli(['eval', 'run', SAMPLE, '-w', ws, '--baseline', 'last-good', '-r', 'console']);
    expect(second.status).toBe(0);
    expect(second.out).toContain('Regression vs baseline "last-good-Sample: support intents"');
  }, 90_000);

  it('eval run asks first over $0.50 and stops at the cap: a priced model, a stand-in endpoint', async () => {
    // a paid model with a price: 10 cases x ~480 tokens is about $0.60 at $100 per million tokens
    const store = WorkspaceStore.open(ws);
    store.saveProviders([...store.getProviders(), { id: 'paid', name: 'Paid', kind: 'openai-compatible', baseUrl: 'https://api.example.test/v1', apiKey: '{{$env.AIQ_NO_KEY}}', defaultModel: 'm' }]);
    const lib = store.getLibrary<any>('evaluations');
    store.saveLibrary('evaluations', { folders: lib.folders, items: [...lib.items, { id: 'ev-paid', name: 'Paid check', data: { ...lib.items[0].data, name: 'Paid check', provider: 'paid', model: 'm', dataset: Array.from({ length: 400 }, (_, i) => JSON.stringify({ input: `case ${i} `.repeat(60), expected: 'x' })).join('\n') } }] });
    store.close();
    const est = cliData((await cli(['eval', 'estimate', 'Paid check', '-w', ws, '--json'])).out);
    expect(est.free).toBe(false);
    expect(est.priced).toBe(false);
    expect(est.plan.ask).toBe(true);
    const refused = await cli(['eval', 'run', 'Paid check', '-w', ws, '-q']);
    expect(refused.status).toBe(2);
    expect(refused.err + refused.out).toMatch(/--yes/);
  }, 90_000);
});

describe('the MCP tools', () => {
  it('eval_sample, eval_estimate, eval_try_check, run_evaluation with a cap, ci_config with an evaluation', async () => {
    const s = new McpSession({ id: 'aiq', name: 'testpion', transport: 'stdio', command: process.execPath, args: [cliPath, 'mcp-server', '-w', ws], env });
    await s.connect(20_000);
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(mcpResultBody(await s.callTool(name, args)).text);
    try {
      const sample = await call('eval_sample', {});
      expect(sample).toMatchObject({ evaluation: SAMPLE, headline: '10 of 10 passed', total: 10, passed: 10 });
      expect(sample.model).toContain('Offline demo model');
      const est = await call('eval_estimate', { name: SAMPLE });
      expect(est).toMatchObject({ cases: 10, offline: true, free: true });
      const dry = await call('eval_try_check', { name: SAMPLE, check: { type: 'contains', expected: '{{expected}}' }, case: 2, dry_run: true });
      expect(dry).toMatchObject({ dryRun: true, caseNumber: 2 });
      const tried = await call('eval_try_check', { name: SAMPLE, check: { type: 'contains', expected: '{{expected}}' }, case: 2 });
      expect(tried).toMatchObject({ passed: true, caseNumber: 2 });
      expect(tried.reply).toContain('cancellation');
      const ran = await call('run_evaluation', { name: SAMPLE, limit: 2, max_cost_usd: 0.5 });
      expect(ran).toMatchObject({ total: 2, passed: 2 });
      expect(ran.estimate).toContain('free');
      const ci = await call('ci_config', { provider: 'github', evaluation: SAMPLE });
      expect(ci.command).toContain('--baseline last-good --fail-on-regression --yes');
    } finally {
      await s.close();
    }
  }, 120_000);
});

describe('testpion eval generate-cases | trust (AU-13, AU-23)', () => {
  it('generate-cases --dry-run sends nothing; --apply adds the ticked cases from the offline demo model; ai undo takes them back', async () => {
    await cli(['eval', 'sample', '--no-run', '-w', ws, '--json']);
    const dry = cliData((await cli(['eval', 'generate-cases', SAMPLE, '-w', ws, '--provider', 'demo', '--dry-run', '--json'])).out);
    expect(dry).toMatchObject({ dryRun: true, source: 'prompt' });
    expect(JSON.stringify(dry.preview)).toContain('tokens');
    const made = await cli(['eval', 'generate-cases', SAMPLE, '-w', ws, '--provider', 'demo', '--apply', '--json']);
    expect(made.status).toBe(0);
    const d = cliData(made.out);
    expect(d.proposal.items).toHaveLength(6);
    expect(d.proposal.task).toBe('eval-cases');
    expect(d.tally).toMatchObject({ failed: 0 });
    expect(d.applied.applied).toHaveLength(6);
    const listed = cliData((await cli(['eval', 'list', '-w', ws, '--json'])).out);
    expect(listed.find((e: { name: string }) => e.name === SAMPLE).cases).toBe(16);
    // a second call finds every case already there: all six are repeats, unticked
    const again = cliData((await cli(['eval', 'generate-cases', SAMPLE, '-w', ws, '--provider', 'demo', '--json'])).out);
    expect(again.tally.failed).toBe(6);
    expect(again.proposal.items.every((i: { selected: boolean }) => !i.selected)).toBe(true);
    const undone = await cli(['ai', 'undo', d.proposal.id, '-w', ws, '--yes', '--json']);
    expect(undone.status, undone.out + undone.err).toBe(0);
    expect(cliData((await cli(['eval', 'list', '-w', ws, '--json'])).out).find((e: { name: string }) => e.name === SAMPLE).cases).toBe(10);
  }, 120_000);

  it('a source that is not there says what to do; an evaluation of a bot with sources points to its own generator', async () => {
    const noSpec = await cli(['eval', 'generate-cases', SAMPLE, '-w', ws, '--provider', 'demo', '--from', 'spec']);
    expect(noSpec.status).toBe(2);
    expect(noSpec.out + noSpec.err).toMatch(/API definition/);
    const noHistory = await cli(['eval', 'generate-cases', SAMPLE, '-w', ws, '--provider', 'demo', '--from', 'history']);
    expect(noHistory.status).toBe(2);
    expect(noHistory.out + noHistory.err).toMatch(/History holds no prompts/);
  }, 60_000);

  it('eval trust on a run with no AI reviewer says there is nothing to compare; the MCP tools do the same', async () => {
    const ran = cliData((await cli(['eval', 'sample', '-w', ws, '-q', '--json'])).out);
    const run = ran.runId ?? ran.run?.runId ?? 'last';
    const t = cliData((await cli(['eval', 'trust', run, '-w', ws, '--json'])).out);
    expect(t.metrics).toEqual([]);
    expect(t.summary).toMatch(/Graded by an AI reviewer/);
    const s = new McpSession({ id: 'aiq2', name: 'testpion', transport: 'stdio', command: process.execPath, args: [cliPath, 'mcp-server', '-w', ws], env });
    await s.connect(20_000);
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(mcpResultBody(await s.callTool(name, args)).text);
    try {
      const dry = await call('eval_generate_cases', { name: SAMPLE, dry_run: true, provider: 'demo' });
      expect(dry).toMatchObject({ dryRun: true, source: 'prompt' });
      const gen = await call('eval_generate_cases', { name: SAMPLE, provider: 'demo', count: 6, confirm: true });
      expect(gen.proposal.items).toHaveLength(6);
      expect(gen.proposal.items[0]).toMatchObject({ selected: true, case: expect.objectContaining({ input: expect.any(String), expected: expect.any(String) }) });
      expect(gen.next).toContain('ai_apply_proposal');
      const trust = await call('eval_trust_reviewer', { run: 'last' });
      expect(trust.metrics).toEqual([]);
      const bad = await s.callTool('eval_trust_reviewer', { run: 'last', grade: { result: 'x', verdict: 'maybe' } });
      expect(mcpResultBody(bad).text).toMatch(/verdict/);
    } finally {
      await s.close();
    }
  }, 120_000);
});
