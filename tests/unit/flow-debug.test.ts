import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createDebugger,
  flowRunPlan,
  flowRunResults,
  flowRuns,
  loadTestsFromFile,
  McpManager,
  normalizeTest,
  pinFlowStep,
  ProviderRegistry,
  readFlowState,
  recordRun,
  Redactor,
  REDACTED,
  runTests,
  setFlowBreakpoints,
  unpinFlowStep,
  VariableScope,
  VARIABLE_VALUE_LIMIT,
  WorkspaceStore,
  type ExecServices,
  type PauseAnswer,
  type TestResult,
} from '../../packages/core/src/index.js';
import { runCli, tempDir } from '../helpers.js';

// The flow debugger's engine: pauses before steps (continue / step over / stop, variables edited at the pause), runs
// of part of a flow (onlyIds + a seed from an earlier run), the variables recorded after each step (bounded and
// redacted), the run history of a file, replays, and pins (used only when a run is given them: never by the CLI).
let server: Server;
let base = '';
const hits: string[] = [];
const tmp = tempDir('tp-flow-debug-');

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const url = req.url ?? '';
    if (url.startsWith('/big')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ big: 'x'.repeat(VARIABLE_VALUE_LIMIT + 500), token: 'tok-secret-123456' }));
      return;
    }
    res.writeHead(url.startsWith('/fail') ? 500 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ n: hits.length, url }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  tmp.cleanup();
});

function services(): ExecServices {
  const vars = new VariableScope();
  const redactor = new Redactor();
  return { vars, providers: new ProviderRegistry([], vars, redactor), mcp: new McpManager(() => undefined), mcpServers: [], redactor, pricing: [], defaultTimeoutMs: 10_000 };
}

const flow = () => [
  { id: 'a', name: 'A', url: `${base}/a`, extract: { n: '$.n' } },
  { id: 'b', name: 'B', url: `${base}/b?n={{n}}`, dependsOn: ['a'] },
  { id: 'c', name: 'C', url: `${base}/c?who={{who}}`, dependsOn: ['b'] },
];

async function run(tests: Array<Record<string, unknown>>, extra: Partial<Parameters<typeof runTests>[0]> = {}, svc = services()) {
  const results = new Map<string, TestResult>();
  const summary = await runTests({
    name: 'debug',
    tests: tests.map((t, i) => normalizeTest(t, undefined, i)),
    services: svc,
    concurrency: 4,
    onEvent: (e) => void (e.type === 'test-end' && results.set(e.result.id, e.result)),
    ...extra,
  });
  return { summary, results, status: Object.fromEntries([...results].map(([k, r]) => [k, r.status])), svc };
}

describe('pauseBefore', () => {
  it('pauses at a breakpoint; continue goes on with the variables edited at the pause', async () => {
    const paused: string[] = [];
    let seen: Record<string, unknown> = {};
    const dbg = createDebugger({
      breakpoints: ['b'],
      onPause: (p) => {
        paused.push(p.stepId);
        seen = p.vars;
        setTimeout(() => dbg.resume('continue', { who: 'Ada' }), 20);
      },
    });
    const start = hits.length;
    const r = await run(flow(), { pauseBefore: dbg.pauseBefore });
    expect(paused).toEqual(['b']);
    expect(typeof seen.n).toBe('number');
    expect(r.status).toEqual({ a: 'passed', b: 'passed', c: 'passed' });
    expect(hits.slice(start)[2]).toBe('/c?who=Ada');
    // the edit is in the variables recorded after the steps that follow
    expect(r.results.get('c')!.variables).toMatchObject({ who: 'Ada' });
  });

  it('step over pauses before the next step too', async () => {
    const paused: string[] = [];
    const dbg = createDebugger({
      breakpoints: ['a'],
      onPause: (p) => {
        paused.push(p.stepId);
        setTimeout(() => dbg.resume(p.stepId === 'a' ? 'step' : 'continue'), 10);
      },
    });
    const r = await run(flow(), { pauseBefore: dbg.pauseBefore });
    expect(paused).toEqual(['a', 'b']);
    expect(r.summary.passed).toBe(3);
  });

  it('stop ends the run before the step: it is cancelled and nothing after it runs', async () => {
    const start = hits.length;
    const pauseBefore = async (id: string): Promise<PauseAnswer | void> => (id === 'b' ? { action: 'stop' } : undefined);
    const r = await run(flow(), { pauseBefore });
    expect(r.summary.cancelled).toBe(true);
    expect(r.status.a).toBe('passed');
    expect(r.status.b).toBeUndefined();
    expect(hits.slice(start)).toEqual(['/a']);
  });

  it('a paused step does not time out, and the run goes one step at a time', async () => {
    let inFlight = 0;
    let most = 0;
    const tests = ['x', 'y', 'z'].map((id) => ({ id, name: id, type: 'script', script: 'tp.variables.set("v", 1)' }));
    const pauseBefore = async (id: string) => {
      inFlight++;
      most = Math.max(most, inFlight);
      // longer than the steps' timeout: the pause is before the step starts
      if (id === 'y') await new Promise((r) => setTimeout(r, 300));
      inFlight--;
    };
    const r = await run(tests, { pauseBefore, timeoutMs: 100, concurrency: 8 });
    expect(r.summary.passed).toBe(3);
    expect(most).toBe(1);
  });

  it('stopping the run ends a pause', async () => {
    const ctrl = new AbortController();
    const dbg = createDebugger({ breakpoints: ['b'], signal: ctrl.signal, onPause: () => setTimeout(() => ctrl.abort(), 10) });
    const r = await run(flow(), { pauseBefore: dbg.pauseBefore, signal: ctrl.signal });
    expect(r.summary.cancelled).toBe(true);
    expect(r.results.has('b')).toBe(false);
    expect(r.results.get('c')?.status ?? 'skipped').toBe('skipped');
  });
});

describe('onlyIds and seed', () => {
  it('runs only the given steps; the others count as done and the seed gives their variables and responses', async () => {
    const start = hits.length;
    const tests = [...flow(), { id: 'd', name: 'D', type: 'log', message: 'n={{n}}', if: 'status == 201', dependsOn: ['b'] }];
    const r = await run(tests, { onlyIds: ['c', 'd'], seed: { vars: { n: 41, who: 'Bob' }, responses: { b: { status: 201 } } } });
    expect(r.status).toEqual({ c: 'passed', d: 'passed' });
    expect(hits.slice(start)).toEqual(['/c?who=Bob']);
    expect(r.results.get('d')!.output).toContain('n=41');
  });

  it('a seeded branch not taken keeps the steps after it skipped', async () => {
    const tests = [
      { id: 'cond', name: 'Cond', type: 'condition', if: 'true' },
      { id: 'yes', name: 'Yes', type: 'log', message: 'y', dependsOn: ['cond'], when: true },
      { id: 'no', name: 'No', type: 'log', message: 'n', dependsOn: ['cond'], when: false },
    ];
    const r = await run(tests, { onlyIds: ['yes', 'no'], seed: { conditions: { cond: true } } });
    expect(r.status).toEqual({ yes: 'passed', no: 'skipped' });
  });
});

describe('variables recorded after each step', () => {
  it('are bounded at 4 KB and secrets are redacted', async () => {
    const svc = services();
    svc.vars.setScope('environment', [{ key: 'apiKey', value: 'k-very-secret-1', secret: true }]);
    const tests = [
      { id: 'big', name: 'Big', url: `${base}/big`, extract: { big: '$.big', token: '$.token' } },
      { id: 'set', name: 'Set', type: 'script', script: 'tp.variables.set("apiKey", "changed-value-9"); tp.variables.set("small", 3)', dependsOn: ['big'] },
    ];
    const r = await run(tests, {}, svc);
    const v = r.results.get('big')!.variables!;
    expect(typeof v.big).toBe('string');
    expect((v.big as string).length).toBeLessThan(VARIABLE_VALUE_LIMIT + 50);
    expect(v.big).toMatch(/… \[500 more chars\]$/);
    expect(v.token).toBe(REDACTED);
    const after = r.results.get('set')!.variables!;
    expect(after.small).toBe(3);
    expect(after.apiKey).toBe(REDACTED);
    expect(JSON.stringify(after)).not.toContain('tok-secret-123456');
  });

  it('are left out when the run has none', async () => {
    const r = await run([{ id: 'only', name: 'Only', type: 'log', message: 'hi' }]);
    expect(r.results.get('only')!.variables).toBeUndefined();
  });
});

describe('run history, replay and pins of a flow file', () => {
  const root = join(tmp.dir, 'ws');
  let store: WorkspaceStore;
  const file = 'debug-flow.yaml';
  const abs = () => join(root, 'tests', file);
  const write = (failing: boolean) =>
    writeFileSync(
      abs(),
      [
        'name: Debug flow',
        'tests:',
        `  - { id: login, name: Login, url: "${base}/login", extract: { n: "$.n" } }`,
        `  - { id: order, name: Order, url: "${base}/${failing ? 'fail' : 'ok'}?n={{n}}", dependsOn: [login], assertions: [{ type: status, expected: 200 }] }`,
        `  - { id: check, name: Check, url: "${base}/check?n={{n}}", dependsOn: [order] }`,
        '',
      ].join('\n'),
    );
  const runFile = async (extra: Partial<Parameters<typeof runTests>[0]> = {}) => {
    const runId = `run-${Math.random().toString(36).slice(2, 10)}`;
    const dir = store.runDir(runId);
    const summary = await runTests({ name: file, runId, tests: loadTestsFromFile(abs()), services: services(), resultsFile: join(dir, 'results.jsonl'), ...extra });
    await recordRun(store, summary, dir);
    return { runId, summary };
  };

  beforeAll(() => {
    store = WorkspaceStore.create(root, 'Debug');
  });
  afterAll(() => store.close());

  it('lists the runs of the file, newest first, with the first failing step; a run has the variables after each step', async () => {
    write(true);
    const first = await runFile();
    await new Promise((r) => setTimeout(r, 15));
    write(false);
    const second = await runFile();
    expect(second.summary.files?.length).toBe(1);
    const h = await flowRuns(store, file);
    expect(h.runs.map((r) => r.runId)).toEqual([second.runId, first.runId]);
    expect(h.runs[1]).toMatchObject({ status: 'failed', firstFailed: 'order', steps: 3, failed: 1, skipped: 1 });
    expect(h.runs[0]).toMatchObject({ status: 'passed', passed: 3 });
    const detail = await flowRunResults(store, file, first.runId);
    expect(detail.results.map((r) => r.id)).toEqual(['login', 'order', 'check']);
    expect(typeof detail.results[0]!.variables?.n).toBe('number');
  });

  it('replays a failed run from its first failing step with its variables', async () => {
    const failed = (await flowRuns(store, file)).runs.find((r) => r.status === 'failed')!;
    const seededN = (await flowRunResults(store, file, failed.runId)).results[0]!.variables!.n;
    const plan = await flowRunPlan(store, file, { seedRunId: failed.runId });
    expect(plan.from).toBe('order');
    expect(plan.onlyIds).toEqual(['order', 'check']);
    expect(plan.seed?.vars).toEqual({ n: seededN });
    const start = hits.length;
    const r = await runFile({ onlyIds: plan.onlyIds, seed: plan.seed });
    expect(r.summary.passed).toBe(2);
    // login did not run; the order used the failed run's value
    expect(hits.slice(start)).toEqual([`/ok?n=${seededN}`, `/check?n=${seededN}`]);
  });

  it('plans run from here (latest run) and run to here (what the step waits for)', async () => {
    const from = await flowRunPlan(store, file, { from: 'check' });
    expect(from.onlyIds).toEqual(['check']);
    expect(Object.keys(from.seed?.responses ?? {})).toEqual(expect.arrayContaining(['login', 'order']));
    const to = await flowRunPlan(store, file, { to: 'order' });
    expect(to.onlyIds).toEqual(['login', 'order']);
    expect(to.seed).toBeUndefined();
    await expect(flowRunPlan(store, file, { from: 'nope' })).rejects.toThrow(/no step "nope"/);
  });

  it('keeps breakpoints and pins in .local (not the YAML); a pin answers the step only when a run is given it', async () => {
    const before = readFileSync(abs(), 'utf8');
    setFlowBreakpoints(store, file, ['order']);
    const s = pinFlowStep(store, file, 'login', { status: 200, headers: [['content-type', 'application/json']], body: { n: 777 }, fromRunId: 'run-x' });
    expect(s.pins.login).toMatchObject({ status: 200, body: { n: 777 }, fromRunId: 'run-x' });
    expect(readFlowState(store, file)).toMatchObject({ breakpoints: ['order'] });
    expect(readFileSync(abs(), 'utf8')).toBe(before);
    expect(existsSync(join(root, '.local', 'flows'))).toBe(true);
    // the plan of a partial run never carries pins
    expect(JSON.stringify(await flowRunPlan(store, file, { from: 'order' }))).not.toContain('777');

    // with the pins (the designer): login is answered by its pin, not called
    let start = hits.length;
    const pinned = await runFile({ pins: readFlowState(store, file).pins });
    expect(hits.slice(start)).toEqual(['/ok?n=777', '/check?n=777']);
    const results = (await flowRunResults(store, file, pinned.runId)).results;
    expect(results[0]!.metadata).toMatchObject({ pinned: true });

    // without them (the CLI, CI, monitors, MCP): the API is called
    start = hits.length;
    const cli = await runCli(['test', abs(), '-w', root, '--reporter', 'console', '-q'], { home: join(tmp.dir, 'home') });
    expect(cli.status).toBe(0);
    expect(hits.slice(start)[0]).toBe('/login');

    unpinFlowStep(store, file, 'login');
    expect(readFlowState(store, file).pins).toEqual({});
  });

  it('cuts a pinned body at 1 MB', () => {
    const s = pinFlowStep(store, file, 'check', { status: 200, text: 'y'.repeat(1024 * 1024 + 10) });
    expect(s.pins.check!.truncated).toBe(true);
    expect(s.pins.check!.text!.length).toBe(1024 * 1024);
  });
});
