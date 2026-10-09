import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyFlowEdit,
  evaluateExpression,
  flowStepOf,
  lintTestFile,
  loadTestsFromFile,
  McpManager,
  normalizeTest,
  ProviderRegistry,
  Redactor,
  runFlow,
  runTests,
  VariableScope,
  WorkspaceManager,
  EnvSecretStore,
  type ExecServices,
  type TestCase,
  type TestResult,
} from '../../packages/core/src/index.js';
import { flowGraph, toDot } from '../../packages/shared/src/index.js';
import { copyExample } from '../helpers.js';

// The flow blocks: if / condition with true and false branches, repeat / forEach, script steps, sub-flows, log steps
// and a file's output: — each a runner feature (the same in the app, the CLI, CI and MCP) and a flow designer block.
let server: Server;
let base = '';
const hits: string[] = [];
const dir = mkdtempSync(join(tmpdir(), 'tp-flow-blocks-'));

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const admin = (req.url ?? '').startsWith('/admin');
    res.writeHead(req.url?.startsWith('/missing') ? 404 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ role: admin ? 'admin' : 'user', n: hits.length, url: req.url }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function services(): ExecServices {
  const vars = new VariableScope();
  const redactor = new Redactor();
  return { vars, providers: new ProviderRegistry([], vars, redactor), mcp: new McpManager(() => undefined), mcpServers: [], redactor, pricing: [], defaultTimeoutMs: 10_000 };
}

async function run(tests: Array<Record<string, unknown>>, svc = services(), signal?: AbortSignal) {
  const results = new Map<string, TestResult>();
  const summary = await runTests({
    name: 'blocks',
    tests: tests.map((t, i) => normalizeTest(t, undefined, i)),
    services: svc,
    concurrency: 1,
    signal,
    onEvent: (e) => void (e.type === 'test-end' && results.set(e.result.id, e.result)),
  });
  const status = Object.fromEntries([...results].map(([k, r]) => [k, r.status]));
  return { summary, results, status, svc };
}

const write = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

async function runFile(path: string, svc = services()) {
  const results = new Map<string, TestResult>();
  const summary = await runTests({ name: 'file', tests: loadTestsFromFile(path), services: svc, concurrency: 1, onEvent: (e) => void (e.type === 'test-end' && results.set(e.result.id, e.result)) });
  return { summary, results, status: Object.fromEntries([...results].map(([k, r]) => [k, r.status])), svc };
}

describe('loader and lint', () => {
  it('reads the blocks and refuses what is not one', () => {
    expect(normalizeTest({ name: 'Ok?', type: 'condition', if: 'status == 200' })).toMatchObject({ type: 'condition', if: 'status == 200' });
    expect(normalizeTest({ name: 's', type: 'script', script: 'tp.variables.set("a", 1)' })).toMatchObject({ type: 'script', script: 'tp.variables.set("a", 1)' });
    expect((normalizeTest({ name: 's', type: 'script', script: 'x' }) as TestCase).testScript).toBeUndefined();
    expect(normalizeTest({ name: 'f', type: 'flow', file: 'child.yaml', inputs: { a: '{{b}}' } })).toMatchObject({ type: 'flow', flowFile: 'child.yaml', inputs: { a: '{{b}}' } });
    expect(normalizeTest({ name: 'l', type: 'log', message: 'hi {{x}}' })).toMatchObject({ type: 'log', message: 'hi {{x}}' });
    expect(normalizeTest({ name: 'r', url: 'http://x', repeat: 3 })).toMatchObject({ repeat: 3 });
    expect(normalizeTest({ name: 'r', url: 'http://x', forEach: [{ a: 1 }] })).toMatchObject({ forEach: [{ a: 1 }] });
    expect(normalizeTest({ name: 'r', url: 'http://x', forEach: { dataset: 'd.csv' } })).toMatchObject({ forEach: { dataset: 'd.csv' } });
    expect(normalizeTest({ name: 'w', url: 'http://x', when: 'false', if: '{{a}} > 1' })).toMatchObject({ when: false, if: '{{a}} > 1' });
    expect(() => normalizeTest({ name: 'c', type: 'condition' })).toThrow(/needs if:/);
    expect(() => normalizeTest({ name: 's', type: 'script' })).toThrow(/needs script:/);
    expect(() => normalizeTest({ name: 'f', type: 'flow' })).toThrow(/needs file:/);
    expect(() => normalizeTest({ name: 'l', type: 'log' })).toThrow(/needs message:/);
    expect(() => normalizeTest({ name: 'r', url: 'http://x', repeat: 10_001 })).toThrow(/at most 10000/);
    expect(() => normalizeTest({ name: 'r', url: 'http://x', repeat: 2, forEach: [1] })).toThrow(/not both/);
    expect(() => normalizeTest({ name: 'r', url: 'http://x', when: 'maybe' })).toThrow(/when: is true or false/);
    // existing tests load as before
    expect(normalizeTest({ name: 'plain', url: 'http://x' })).not.toHaveProperty('if');
  });

  it('lint: the blocks are known, a bad key is said at the key, when: without a condition is a warning, output: must be a map', () => {
    const ok = [
      'name: Flow',
      'output:',
      '  role: "{{role}}"',
      'tests:',
      '  - { id: get, name: Get, url: http://x/me, extract: { role: $.role } }',
      '  - { id: ok, name: Ok?, type: condition, if: "status == 200", dependsOn: [get] }',
      '  - { id: yes, name: Yes, type: log, message: "role {{role}}", dependsOn: [ok], when: true }',
      '  - { id: no, name: No, type: script, script: "tp.variables.set(\'x\', 1)", dependsOn: [ok], when: false }',
      '  - { id: sub, name: Sub, type: flow, file: child.yaml, inputs: { a: 1 }, repeat: 2 }',
      '  - { id: each, name: Each, url: "http://x/{{$index}}", forEach: [{ a: 1 }, { a: 2 }], if: "{{role}} == \'admin\'" }',
      '',
    ].join('\n');
    expect(lintTestFile(ok)).toEqual([]);
    const bad = ['name: Flow', 'output: nope', 'tests:', '  - name: A', '    url: http://x', '    repeat: lots', '  - name: B', '    url: http://x', '    when: true', ''].join('\n');
    const problems = lintTestFile(bad);
    expect(problems.map((p) => [p.severity, p.line, p.message.slice(0, 40)])).toEqual([
      ['error', 2, 'output: is a map of what the flow return'],
      ['error', 6, 'repeat: is a whole number of times (e.g.'],
      ['warning', 9, 'when: picks a branch of a condition step'],
    ]);
  });
});

describe('if and conditions', () => {
  it('runs the taken branch, skips the other with the reason, and a step after both branches runs', async () => {
    const { status, results } = await run([
      { id: 'get', name: 'Get', url: `${base}/admin`, extract: { role: '$.role' } },
      { id: 'ok', name: 'Admin?', type: 'condition', if: "status == 200 && $.role == 'admin' && {{role}} == 'admin'", dependsOn: ['get'] },
      { id: 'yes', name: 'Say yes', type: 'log', message: 'role is {{role}}', dependsOn: ['ok'], when: true },
      { id: 'no', name: 'Fallback', url: `${base}/fallback`, dependsOn: ['ok'], when: false },
      { id: 'after-no', name: 'After the fallback', type: 'log', message: 'x', dependsOn: ['no'] },
      { id: 'merge', name: 'Merge', type: 'log', message: 'done', dependsOn: ['yes', 'no'] },
    ]);
    expect(status).toEqual({ get: 'passed', ok: 'passed', yes: 'passed', no: 'skipped', 'after-no': 'skipped', merge: 'passed' });
    expect(results.get('ok')!.metadata).toMatchObject({ condition: true });
    expect(results.get('yes')!.output).toBe('role is admin');
    expect(results.get('no')!.metadata!.reason).toMatch(/branch not taken: ok came out true/);
    expect(results.get('after-no')!.metadata!.reason).toMatch(/its branch was not taken/);
    expect(hits).not.toContain('/fallback');
  });

  it('a false condition takes the false branch', async () => {
    const { status } = await run([
      { id: 'get', name: 'Get', url: `${base}/user` },
      { id: 'ok', name: 'Admin?', type: 'condition', if: "$.role == 'admin'", dependsOn: ['get'] },
      { id: 'yes', name: 'Yes', type: 'log', message: 'y', dependsOn: ['ok'], when: true },
      { id: 'no', name: 'No', type: 'log', message: 'n', dependsOn: ['ok'], when: false },
    ]);
    expect(status).toEqual({ get: 'passed', ok: 'passed', yes: 'skipped', no: 'passed' });
  });

  it('if: on a step skips it (and what depends only on it) when false; a failed step still skips the steps after it', async () => {
    const svc = services();
    svc.vars.set('count', 0, 'runtime');
    const { status, results } = await run(
      [
        { id: 'a', name: 'A', url: `${base}/missing`, assertions: [{ type: 'status', expected: 200 }] },
        { id: 'b', name: 'B', type: 'log', message: 'b', dependsOn: ['a'] },
        { id: 'c', name: 'C', type: 'log', message: 'c', if: '{{count}} > 0 || status == 200' },
        { id: 'd', name: 'D', type: 'log', message: 'd', dependsOn: ['c'] },
        { id: 'e', name: 'E', type: 'log', message: 'e', if: 'status == 404 && vars.count === 0' },
      ],
      svc,
    );
    expect(status).toEqual({ a: 'failed', b: 'skipped', c: 'skipped', d: 'skipped', e: 'passed' });
    expect(results.get('b')!.metadata!.reason).toMatch(/dependency did not pass/);
    expect(results.get('c')!.metadata!.reason).toMatch(/^if: .* is false$/);
  });

  it('an expression that cannot be evaluated is an error, not a pass', async () => {
    const { status, results } = await run([
      { id: 'x', name: 'X', type: 'condition', if: 'status ==' },
      { id: 'y', name: 'Y', type: 'log', message: 'y', if: 'nope(' },
    ]);
    expect(status).toEqual({ x: 'error', y: 'error' });
    expect(results.get('x')!.error!.message).toMatch(/could not be evaluated/);
  });
});

describe('the expression evaluator', () => {
  it('compares over the response and variables', async () => {
    expect(await evaluateExpression("status == 200 && $.role == 'admin' && headers['x-a'] == '1'", { status: 200, body: { role: 'admin' }, headers: { 'x-a': '1' } })).toEqual({ value: true });
    expect(await evaluateExpression('vars.n > 2', { vars: { n: 3 } })).toEqual({ value: true });
  });

  it('has no require, process, network, timers or host functions, and a time limit', async () => {
    for (const name of ['require', 'process', 'fetch', 'XMLHttpRequest', 'WebSocket', 'globalThis.__host_uuid', 'tp', 'pm', 'setTimeout', 'Buffer'])
      expect((await evaluateExpression(`typeof ${name}`, {})).value).toBe('undefined');
    const r = await evaluateExpression('(() => { while (true) {} })()', {});
    expect(r.error).toMatch(/longer than \d+ ms/);
    const t0 = Date.now();
    await evaluateExpression('(() => { for (;;) {} })()', {});
    expect(Date.now() - t0).toBeLessThan(2000);
    // a promise loop is stopped too, and the runtime still works afterwards
    expect((await evaluateExpression('(Promise.resolve().then(function f() { for (;;) {} }), 1)', {})).value).toBe(1);
    expect((await evaluateExpression('1 + 1', {})).value).toBe(2);
  });
});

describe('repeat and forEach', () => {
  it('runs once per row with the fields, $index and $item as variables; the last iteration extracts', async () => {
    hits.length = 0;
    const { status, results, svc } = await run([
      { id: 'each', name: 'Each', url: `${base}/health?i={{$index}}&name={{name}}`, forEach: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], extract: { lastUrl: '$.url' } },
      { id: 'rep', name: 'Rep', type: 'log', message: 'n={{$index}}', repeat: 2 },
    ]);
    expect(status).toEqual({ each: 'passed', rep: 'passed' });
    expect(hits).toEqual(['/health?i=0&name=a', '/health?i=1&name=b', '/health?i=2&name=c']);
    expect(results.get('each')!.metadata).toMatchObject({ iterations: 3 });
    expect((results.get('each')!.metadata!.iterationResults as unknown[]).length).toBe(3);
    expect(results.get('each')!.checks.at(-1)).toMatchObject({ name: 'iterations', passed: true, message: '3 of 3 iterations passed' });
    expect(svc.vars.get('lastUrl')).toBe('/health?i=2&name=c');
    expect(results.get('rep')!.output).toBe('n=1');
  });

  it('a failing iteration fails the step and says which; a dataset feeds the rows; no rows is skipped', async () => {
    const csv = write('users.csv', 'name,path\nok,health\nbad,missing\n');
    const file = write(
      'loop.yaml',
      [
        'name: Loop',
        'tests:',
        '  - id: each',
        '    name: Each user',
        `    url: "${base}/{{path}}?u={{name}}"`,
        '    forEach: { dataset: users.csv }',
        '    assertions: [{ type: status, expected: 200 }]',
        '  - { id: none, name: None, type: log, message: x, forEach: [] }',
        '',
      ].join('\n'),
    );
    expect(csv).toContain('users.csv');
    const { status, results } = await runFile(file);
    expect(status).toEqual({ each: 'failed', none: 'skipped' });
    const r = results.get('each')!;
    expect(r.checks.some((c) => c.name.startsWith('[#1] ') && !c.passed)).toBe(true);
    expect(r.checks.at(-1)!.message).toBe('1 of 2 iterations passed');
    expect((r.metadata!.iterationResults as Array<{ status: string }>).map((i) => i.status)).toEqual(['passed', 'failed']);
  });

  it('the run’s cancel stops between iterations', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 150);
    const t0 = Date.now();
    const { results, summary } = await run([{ id: 'slow', name: 'Slow', type: 'delay', ms: 40, repeat: 200 }], services(), ctrl.signal);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(summary.cancelled).toBe(true);
    expect(results.get('slow')?.status).not.toBe('passed');
  });
});

describe('script steps', () => {
  it('sets variables the next step uses, with tp.* (and pm.* as today), and its tp.test results are checks', async () => {
    const { status, results } = await run([
      { id: 'calc', name: 'Calc', type: 'script', script: "tp.variables.set('total', 2 + 3); pm.environment.set('who', 'me'); tp.test('adds', () => tp.expect(5).to.equal(5));" },
      { id: 'say', name: 'Say', type: 'log', message: 'total {{total}} by {{who}}', dependsOn: ['calc'] },
      { id: 'boom', name: 'Boom', type: 'script', script: 'throw new Error("no")' },
    ]);
    expect(status).toEqual({ calc: 'passed', say: 'passed', boom: 'error' });
    expect(results.get('say')!.output).toBe('total 5 by me');
    expect(results.get('calc')!.checks).toEqual([expect.objectContaining({ name: 'adds', passed: true })]);
    expect(results.get('boom')!.error!.message).toMatch(/Script failed: Error: no/);
  });
});

describe('sub-flows', () => {
  it('runs another file with inputs; its output (or what it extracted) comes back as variables', async () => {
    write(
      'child.yaml',
      ['name: Child', 'output:', '  greeting: "{{greeting}}"', 'tests:', "  - { name: Greet, type: script, script: \"tp.variables.set('greeting', 'hi ' + tp.variables.get('who'))\" }", ''].join('\n'),
    );
    write('child-plain.yaml', ['name: Plain', 'tests:', `  - { name: Get, url: "${base}/admin", extract: { role: $.role } }`, ''].join('\n'));
    const parent = write(
      'parent.yaml',
      [
        'name: Parent',
        'tests:',
        '  - { id: sub, name: Sub, type: flow, file: child.yaml, inputs: { who: "{{me}}" }, extract: { copy: $.greeting } }',
        '  - { id: plain, name: Plain, type: flow, file: child-plain.yaml }',
        '  - { id: say, name: Say, type: log, message: "{{greeting}} / {{copy}} / {{role}}", dependsOn: [sub, plain] }',
        '',
      ].join('\n'),
    );
    const svc = services();
    svc.vars.set('me', 'Ada', 'environment');
    const { status, results } = await runFile(parent, svc);
    expect(status).toEqual({ sub: 'passed', plain: 'passed', say: 'passed' });
    expect(results.get('say')!.output).toBe('hi Ada / hi Ada / admin');
    expect(results.get('sub')!.metadata).toMatchObject({ flow: expect.stringContaining('child.yaml'), passed: 1 });
  });

  it('a failing sub-flow step fails the step', async () => {
    write('child-bad.yaml', ['name: Bad', 'tests:', `  - { name: Missing, url: "${base}/missing", assertions: [{ type: status, expected: 200 }] }`, ''].join('\n'));
    const { status, results } = await runFile(write('parent-bad.yaml', 'name: P\ntests:\n  - { id: sub, name: Sub, type: flow, file: child-bad.yaml }\n'));
    expect(status).toEqual({ sub: 'failed' });
    expect(results.get('sub')!.checks[0]!.message).toMatch(/1 of 1 steps did not pass: Missing \(failed/);
  });

  it('refuses a cycle (A → B → A) and more than five levels, with a clear error', async () => {
    write('cycle-a.yaml', 'name: A\ntests:\n  - { id: to-b, name: To B, type: flow, file: cycle-b.yaml }\n');
    write('cycle-b.yaml', 'name: B\ntests:\n  - { id: to-a, name: To A, type: flow, file: cycle-a.yaml }\n');
    const { results } = await runFile(join(dir, 'cycle-a.yaml'));
    const r = results.get('to-b')!;
    expect(r.status).toBe('failed');
    expect(r.checks[0]!.message).toMatch(/Sub-flow cycle: .*cycle-a\.yaml → .*cycle-b\.yaml → .*cycle-a\.yaml/);
    const self = await runFile(write('self.yaml', 'name: S\ntests:\n  - { id: me, name: Me, type: flow, file: self.yaml }\n'));
    expect(self.results.get('me')!.error!.message).toMatch(/Sub-flow cycle/);
    for (let i = 1; i <= 7; i++)
      write(`deep-${i}.yaml`, i < 7 ? `name: D${i}\ntests:\n  - { id: d${i}, name: D${i}, type: flow, file: deep-${i + 1}.yaml }\n` : 'name: D7\ntests:\n  - { name: End, type: log, message: end }\n');
    const deep = await runFile(join(dir, 'deep-1.yaml'));
    expect(JSON.stringify([...deep.results.values()])).toMatch(/Sub-flows nest at most 5 deep/);
    // five levels are fine
    const ok = await runFile(join(dir, 'deep-3.yaml'));
    expect(ok.status).toEqual({ d3: 'passed' });
  });
});

describe('output: of an exposed flow', () => {
  it('is in the MCP result', async () => {
    const wdir = mkdtempSync(join(tmpdir(), 'tp-flow-out-'));
    try {
      const ws = copyExample('public-workspace', join(wdir, 'ws'));
      writeFileSync(
        join(ws, 'tests', 'out-flow.yaml'),
        [
          'name: Out',
          'expose: { tool: out_flow, inputs: [{ name: who, default: Bob }] }',
          'output:',
          '  message: "hello {{who}}"',
          '  total: "{{total}}"',
          'tests:',
          '  - { name: Calc, type: script, script: "tp.variables.set(\'total\', 7)" }',
          '',
        ].join('\n'),
      );
      const mgr = new WorkspaceManager(join(wdir, 'home'));
      const store = mgr.open(ws);
      try {
        const r = await runFlow(
          { store, secrets: new EnvSecretStore(), settings: mgr.loadSettings(), redactor: new Redactor(), checkEnvironment: () => undefined },
          { tool: 'out_flow', file: 'out-flow.yaml', kind: 'file', inputs: [{ name: 'who', default: 'Bob' }] },
          { who: 'Ada' },
        );
        expect(r.passed).toBe(1);
        expect(r.output).toEqual({ message: 'hello Ada', total: 7 });
      } finally {
        store.close();
      }
    } finally {
      rmSync(wdir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe('the canvas: graph and edits', () => {
  const text = [
    '# a flow with a branch',
    'name: Flow',
    'tests:',
    '  - { id: get, name: Get, url: http://x/me }',
    '  - { id: ok, name: Ok?, type: condition, if: status == 200, dependsOn: [get] }',
    '  - { id: yes, name: Yes, type: log, message: y }',
    '  - { id: no, name: No, type: log, message: n, repeat: 3 }',
    '',
  ].join('\r\n');

  it('connect from a condition sets when (true or false port); disconnect takes it away', () => {
    let t = applyFlowEdit(text, { op: 'connect', from: 'ok', to: 'yes', when: true }).text;
    t = applyFlowEdit(t, { op: 'connect', from: 'ok', to: 'no', when: false }).text;
    expect(t).toContain('\r\n');
    expect(t).toContain('# a flow with a branch');
    expect(t).toMatch(/id: yes, name: Yes, type: log, message: y, dependsOn: \[ ok \], when: true/);
    expect(t).toMatch(/when: false/);
    expect(() => applyFlowEdit(t, { op: 'connect', from: 'get', to: 'yes', when: true })).toThrow(/is not one/);
    const back = applyFlowEdit(t, { op: 'disconnect', from: 'ok', to: 'yes' }).text;
    expect(back).not.toMatch(/name: Yes[^\n]*when/);
    expect(back).toMatch(/name: No[^\n]*when: false/);
    const removed = applyFlowEdit(t, { op: 'removeStep', id: 'ok' }).text;
    expect(removed).not.toContain('when:');
  });

  it('setOutput writes output: before the tests (null removes it), keeping comments and CRLF', () => {
    const t = applyFlowEdit(text, { op: 'setOutput', output: { role: '{{role}}' } }).text;
    expect(t).toContain('name: Flow\r\noutput:\r\n  role: "{{role}}"\r\ntests:');
    const back = applyFlowEdit(t, { op: 'setOutput', output: null }).text;
    expect(back).not.toContain('output:');
    expect(back).toContain('# a flow with a branch\r\nname: Flow\r\ntests:');
  });

  it('the graph labels a condition’s edges true/false and shows loops, conditions and sub-flows', () => {
    const tests = [
      normalizeTest({ id: 'ok', name: 'Ok?', type: 'condition', if: 'status == 200' }),
      normalizeTest({ id: 'yes', name: 'Yes', type: 'log', message: 'y', dependsOn: ['ok'], when: true }),
      normalizeTest({ id: 'no', name: 'No', url: 'http://x', dependsOn: ['ok'], when: false, forEach: [1, 2, 3] }),
      normalizeTest({ id: 'sub', name: 'Sub', type: 'flow', file: 'child.yaml', if: '{{a}} > 1' }),
    ];
    const steps = tests.map(flowStepOf);
    expect(steps[0]).toMatchObject({ type: 'condition', if: 'status == 200' });
    expect(steps[2]).toMatchObject({ when: false, loop: '× 3' });
    expect(steps[3]).toMatchObject({ flow: 'child.yaml', if: '{{a}} > 1' });
    expect(flowGraph(steps).edges).toEqual([
      { from: 'ok', to: 'yes', when: true },
      { from: 'ok', to: 'no', when: false },
    ]);
    const dot = toDot(steps);
    expect(dot).toContain('"ok" -> "yes" [label="true"]');
    expect(dot).toContain('shape=diamond');
    expect(dot).toContain('× 3');
  });
});
