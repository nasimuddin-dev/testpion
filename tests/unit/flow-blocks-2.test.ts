import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  applyFlowEdit,
  flowStepOf,
  lintTestFile,
  McpManager,
  normalizeTest,
  ProviderRegistry,
  Redactor,
  runTests,
  untilOf,
  untilWaits,
  VariableScope,
  type ExecServices,
  type PauseAnswer,
  type TestResult,
} from '../../packages/core/src/index.js';
import { flowGraph, stepDetail, toDot, untilLabel } from '../../packages/shared/src/index.js';

// The third release's blocks: Wait until (polling with an interval, backoff and a timeout), Finally (clean-up that always
// runs), Parallel group (steps that may run together), Set variable (run / environment / collection / global) and
// Assert (checks only). Each is a runner feature (the same in the app, the CLI, CI and MCP) and a flow designer block.
let server: Server;
let base = '';
const polls = new Map<string, number>();
const pollTimes = new Map<string, number[]>();
const active = new Map<string, number>();
const maxActive = new Map<string, number>();
const order: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.startsWith('/jobs/')) {
      const id = url.pathname.slice(6);
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      pollTimes.set(id, [...(pollTimes.get(id) ?? []), Date.now()]);
      const after = Number(url.searchParams.get('after') ?? 2);
      return send(200, { id, status: n <= after ? 'running' : 'done', polls: n, ...(n > after ? { total: 42 } : {}) });
    }
    if (url.pathname === '/slow') {
      const g = url.searchParams.get('g') ?? '';
      active.set(g, (active.get(g) ?? 0) + 1);
      maxActive.set(g, Math.max(maxActive.get(g) ?? 0, active.get(g)!));
      order.push(`start:${url.searchParams.get('n')}`);
      setTimeout(
        () => {
          active.set(g, active.get(g)! - 1);
          order.push(`end:${url.searchParams.get('n')}`);
          send(200, { n: url.searchParams.get('n') });
        },
        Number(url.searchParams.get('ms') ?? 100),
      );
      return;
    }
    if (url.pathname === '/fail') return send(500, { error: 'boom' });
    order.push(`hit:${url.pathname}`);
    send(200, { ok: true, path: url.pathname, role: 'admin', count: 3 });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function services(extra: Partial<ExecServices> = {}): ExecServices {
  const vars = new VariableScope();
  const redactor = new Redactor();
  return { vars, providers: new ProviderRegistry([], vars, redactor), mcp: new McpManager(() => undefined), mcpServers: [], redactor, pricing: [], defaultTimeoutMs: 10_000, ...extra };
}

async function run(
  tests: Array<Record<string, unknown>>,
  o: { svc?: ExecServices; signal?: AbortSignal; concurrency?: number; pauseBefore?: (id: string) => PauseAnswer | void | Promise<PauseAnswer | void>; bail?: boolean } = {},
) {
  const svc = o.svc ?? services();
  const results = new Map<string, TestResult>();
  const ended: string[] = [];
  const summary = await runTests({
    name: 'blocks-2',
    tests: tests.map((t, i) => normalizeTest({ ...t }, '/w/tests/blocks.yaml', i)),
    services: svc,
    concurrency: o.concurrency ?? 1,
    signal: o.signal,
    bail: o.bail,
    pauseBefore: o.pauseBefore,
    onEvent: (e) => {
      if (e.type !== 'test-end') return;
      results.set(e.result.id, e.result);
      ended.push(e.result.id);
    },
  });
  const status = Object.fromEntries([...results].map(([k, r]) => [k, r.status]));
  return { summary, results, status, svc, ended };
}

describe('loader and lint', () => {
  it('reads until:, finally:, parallel:, set and assert steps', () => {
    expect(normalizeTest({ name: 'p', url: 'http://x', until: { if: "$.status == 'done'", every: '2s', timeout: '1m', backoff: 1.5 } })).toMatchObject({
      until: { if: "$.status == 'done'", everyMs: 2000, timeoutMs: 60_000, backoff: 1.5, maxEveryMs: 30_000 },
    });
    expect(normalizeTest({ name: 'p', url: 'http://x', until: 'status == 200' })).toMatchObject({ until: { if: 'status == 200', everyMs: 2000, timeoutMs: 60_000, backoff: 1 } });
    expect(normalizeTest({ name: 'w', type: 'wait', url: 'http://x', until: 'status == 200' })).toMatchObject({ type: 'http', until: { if: 'status == 200' } });
    expect(normalizeTest({ name: 'c', url: 'http://x', finally: true })).toMatchObject({ finally: true });
    expect(normalizeTest({ name: 'c', url: 'http://x', parallel: 'lookups' })).toMatchObject({ parallel: 'lookups' });
    expect(normalizeTest({ name: 's', type: 'set', set: { a: '{{b}}' }, scope: 'env' })).toMatchObject({ type: 'set', set: { a: '{{b}}' }, scope: 'environment' });
    expect(normalizeTest({ name: 's', type: 'set', set: { a: 1 } })).toMatchObject({ scope: 'run' });
    expect(normalizeTest({ name: 'a', type: 'assert', assertions: [{ type: 'status', expected: 200 }] })).toMatchObject({ type: 'assert', subject: 'response' });
    expect(normalizeTest({ name: 'a', type: 'assert', subject: 'variables', checks: [{ type: 'exists', path: '$.x' }] })).toMatchObject({ subject: 'variables' });
    expect(() => normalizeTest({ name: 'w', type: 'wait', url: 'http://x' })).toThrow(/wait step needs until:/);
    expect(() => normalizeTest({ name: 'p', url: 'http://x', until: { every: '1s' } })).toThrow(/needs if:/);
    expect(() => normalizeTest({ name: 'p', url: 'http://x', until: { if: 'x', every: 'soon' } })).toThrow(/is a duration/);
    expect(() => normalizeTest({ name: 'p', url: 'http://x', until: { if: 'x', timeout: '2h' } })).toThrow(/one hour/);
    expect(() => normalizeTest({ name: 'p', url: 'http://x', until: { if: 'x', backoff: 0.5 } })).toThrow(/backoff/);
    expect(() => normalizeTest({ name: 'p', url: 'http://x', until: 'x', repeat: 2 })).toThrow(/not both/);
    expect(() => normalizeTest({ name: 'p', type: 'log', message: 'm', until: 'x' })).toThrow(/polls a request/);
    expect(() => normalizeTest({ name: 'c', url: 'http://x', finally: 'yes' })).toThrow(/finally: is true/);
    expect(() => normalizeTest({ name: 'c', url: 'http://x', finally: true, parallel: 'g' })).toThrow(/leave out parallel/);
    expect(() => normalizeTest({ name: 's', type: 'set' })).toThrow(/needs set:/);
    expect(() => normalizeTest({ name: 's', type: 'set', set: { a: 1 }, scope: 'disk' })).toThrow(/scope: is run, environment, collection, global/);
    expect(() => normalizeTest({ name: 'a', type: 'assert' })).toThrow(/needs assertions:/);
    expect(() => normalizeTest({ name: 'a', type: 'assert', assertions: [{ type: 'status' }], subject: 'body' })).toThrow(/subject: is response/);
  });

  it('lint: the new keys are known, problems are said at the key, nothing may wait for a finally step', () => {
    const ok = [
      'name: Flow',
      'tests:',
      '  - { id: start, name: Start, type: http, method: POST, url: http://x/jobs }',
      '  - { id: poll, name: Poll, type: wait, url: http://x/jobs/1, until: { if: "$.status == \'done\'", every: 1s, timeout: 30s, backoff: 2, maxEvery: 5s }, dependsOn: [start] }',
      '  - { id: a, name: A, url: http://x/a, parallel: lookups, dependsOn: [poll] }',
      '  - { id: b, name: B, url: http://x/b, parallel: lookups, dependsOn: [poll] }',
      '  - { id: keep, name: Keep, type: set, set: { jobId: "{{id}}" }, scope: environment }',
      '  - { id: check, name: Check, type: assert, subject: variables, assertions: [{ type: exists, path: $.jobId }] }',
      '  - { id: clean, name: Clean up, url: http://x/jobs/1, method: DELETE, finally: true }',
      '',
    ].join('\n');
    expect(lintTestFile(ok)).toEqual([]);
    const bad = [
      'name: Flow',
      'tests:',
      '  - id: poll',
      '    url: http://x',
      '    until: { every: 1s }',
      '  - id: w',
      '    type: wait',
      '    url: http://x',
      '  - id: clean',
      '    url: http://x',
      '    finally: true',
      '  - id: after',
      '    url: http://x',
      '    dependsOn: [clean]',
      '  - id: s',
      '    type: set',
      '    set: { a: 1 }',
      '    scope: disk',
      '',
    ].join('\n');
    expect(lintTestFile(bad).map((p) => [p.severity, p.line, p.message.slice(0, 36)])).toEqual([
      ['error', 5, 'until: needs if: the expression to w'],
      ['error', 7, 'A wait step needs until: the express'],
      ['error', 14, '"clean" is a finally step: it runs a'],
      ['error', 15, 'scope: is run, environment, collecti'],
    ]);
  });
});

describe('Wait until', () => {
  it('runs the step again until the expression holds, with the tries in the result; what the last try extracts flows on', async () => {
    const { status, results, svc } = await run([
      { id: 'poll', name: 'Poll', url: `${base}/jobs/ok-1`, until: { if: "$.status == 'done'", every: 10 }, extract: { total: '$.total' }, assertions: [{ type: 'status', expected: 200 }] },
      { id: 'after', name: 'After', type: 'log', message: 'total {{total}}', dependsOn: ['poll'] },
    ]);
    expect(status).toEqual({ poll: 'passed', after: 'passed' });
    expect(results.get('poll')!.metadata).toMatchObject({ until: "$.status == 'done'", tries: 3 });
    expect(results.get('poll')!.checks.find((c) => c.type === 'until')).toMatchObject({ passed: true, message: expect.stringMatching(/after 3 tries/) });
    expect(svc.vars.get('total')).toBe(42);
    expect(results.get('after')!.output).toBe('total 42');
  });

  it('fails when the time is up: "condition not met within … (n attempts): last status …"', async () => {
    const t0 = Date.now();
    const { status, results } = await run([{ id: 'poll', name: 'Poll', url: `${base}/jobs/never?after=1000`, until: { if: "$.status == 'done'", every: 20, timeout: 150 } }]);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(status).toEqual({ poll: 'failed' });
    const check = results.get('poll')!.checks.find((c) => c.type === 'until')!;
    expect(check.passed).toBe(false);
    expect(check.message).toMatch(/^condition not met within 150 ms \(\d+ attempts\): last status 200$/);
    expect(results.get('poll')!.metadata).toMatchObject({ timedOut: true });
    expect((results.get('poll')!.metadata!.tries as number) >= 3).toBe(true);
  });

  it('a cancelled run stops the wait at once', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 150);
    const t0 = Date.now();
    const { summary } = await run([{ id: 'poll', name: 'Poll', url: `${base}/jobs/cancel?after=1000`, until: { if: "$.status == 'done'", every: '5s', timeout: '1m' } }], { signal: ctrl.signal });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(summary.cancelled).toBe(true);
    expect(polls.get('cancel')).toBe(1);
  });

  it('the wait grows by the backoff and stops at maxEvery', async () => {
    const u = untilOf({ until: { if: 'x', every: '100ms', backoff: 2, maxEvery: '300ms' } });
    expect(typeof u).toBe('object');
    expect(untilWaits(u as Exclude<typeof u, string | undefined>, 6)).toEqual([100, 200, 300, 300, 300]);
    await run([{ id: 'poll', name: 'Poll', url: `${base}/jobs/backoff?after=4`, until: { if: "$.status == 'done'", every: 20, backoff: 3, maxEvery: 60 } }]);
    const t = pollTimes.get('backoff')!;
    const gaps = t.slice(1).map((x, i) => x - t[i]!);
    expect(gaps.length).toBe(4);
    // 20, 60 (capped), 60, 60 — with a little slack for the requests themselves
    expect(gaps[0]!).toBeLessThan(55);
    for (const g of gaps.slice(1)) {
      expect(g).toBeGreaterThanOrEqual(50);
      expect(g).toBeLessThan(160);
    }
  });

  it('an expression that cannot be evaluated is an error', async () => {
    const { status, results } = await run([{ id: 'poll', name: 'Poll', url: `${base}/jobs/err`, until: 'status ==' }]);
    expect(status).toEqual({ poll: 'error' });
    expect(results.get('poll')!.error!.message).toMatch(/could not be evaluated/);
  });
});

describe('Finally', () => {
  it('runs after everything else, also after a failure; its result does not change the others', async () => {
    order.length = 0;
    const { status, ended, results } = await run([
      { id: 'clean', name: 'Clean up', url: `${base}/cleanup`, finally: true },
      { id: 'a', name: 'A', url: `${base}/fail`, assertions: [{ type: 'status', expected: 200 }] },
      { id: 'b', name: 'B', url: `${base}/b`, dependsOn: ['a'] },
      { id: 'c', name: 'C', url: `${base}/c` },
    ]);
    expect(status).toEqual({ clean: 'passed', a: 'failed', b: 'skipped', c: 'passed' });
    expect(ended.at(-1)).toBe('clean');
    expect(order.at(-1)).toBe('hit:/cleanup');
    expect(results.get('clean')!.metadata).toMatchObject({ finally: true });
  });

  it('runs when the run is stopped at a breakpoint or cancelled, and when it bails', async () => {
    const flow = [
      { id: 'a', name: 'A', url: `${base}/a` },
      { id: 'b', name: 'B', url: `${base}/b`, dependsOn: ['a'] },
      { id: 'clean', name: 'Clean up', url: `${base}/cleanup`, finally: true },
    ];
    const stopped = await run(flow, { pauseBefore: (id) => (id === 'b' ? { action: 'stop' } : undefined) });
    expect(stopped.summary.cancelled).toBe(true);
    expect(stopped.status).toMatchObject({ a: 'passed', clean: 'passed' });
    expect(stopped.status.b).toBeUndefined();

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 80);
    const cancelled = await run([{ id: 'slow', name: 'Slow', url: `${base}/slow?ms=2000&n=x` }, ...flow.slice(2)], { signal: ctrl.signal });
    expect(cancelled.summary.cancelled).toBe(true);
    expect(cancelled.status).toMatchObject({ clean: 'passed' });

    const bailed = await run(
      [{ id: 'bad', name: 'Bad', url: `${base}/fail`, assertions: [{ type: 'status', expected: 200 }] }, { id: 'next', name: 'Next', url: `${base}/n`, dependsOn: ['bad'] }, flow[2]!],
      { bail: true },
    );
    expect(bailed.status).toMatchObject({ bad: 'failed', clean: 'passed' });
  });

  it('a step that waits for a finally step is skipped with the reason (never left waiting)', async () => {
    const { status, results } = await run([
      { id: 'early', name: 'Early', type: 'log', message: 'x', dependsOn: ['clean'] },
      { id: 'clean', name: 'Clean', type: 'log', message: 'c', finally: true },
      { id: 'late', name: 'Late', type: 'log', message: 'y', dependsOn: ['clean'] },
    ]);
    expect(status).toEqual({ early: 'skipped', late: 'skipped', clean: 'passed' });
    expect(results.get('late')!.metadata!.reason).toMatch(/a finally step/);
  });
});

describe('Parallel group', () => {
  it('steps of a group run together even at concurrency 1; other steps one at a time; dependsOn still applies', async () => {
    order.length = 0;
    const t0 = Date.now();
    await run([
      { id: 'a', name: 'A', url: `${base}/slow?ms=150&n=a&g=p1`, parallel: 'g' },
      { id: 'b', name: 'B', url: `${base}/slow?ms=250&n=b&g=p1`, parallel: 'g' },
      { id: 'c', name: 'C', url: `${base}/slow?ms=50&n=c&g=p1`, parallel: 'g', dependsOn: ['a'] },
    ]);
    expect(maxActive.get('p1')).toBe(2);
    expect(Date.now() - t0).toBeLessThan(450);
    expect(order.indexOf('start:c')).toBeGreaterThan(order.indexOf('end:a'));
    expect(order.indexOf('start:b')).toBeLessThan(order.indexOf('end:a'));

    await run([
      { id: 'a', name: 'A', url: `${base}/slow?ms=60&n=a&g=p2` },
      { id: 'b', name: 'B', url: `${base}/slow?ms=60&n=b&g=p2` },
    ]);
    expect(maxActive.get('p2')).toBe(1);
  });

  it('a debugged run still goes one step at a time', async () => {
    await run(
      [
        { id: 'a', name: 'A', url: `${base}/slow?ms=60&n=a&g=p3`, parallel: 'g' },
        { id: 'b', name: 'B', url: `${base}/slow?ms=60&n=b&g=p3`, parallel: 'g' },
      ],
      { pauseBefore: () => undefined },
    );
    expect(maxActive.get('p3')).toBe(1);
  });
});

describe('Set variable', () => {
  it('writes to the run, the environment, the collection and the globals; scoped writes are kept like a script’s', async () => {
    const kept: Array<[string, string, unknown]> = [];
    const svc = services({ persistVariable: (scope, key, value) => void kept.push([scope, key, value]) });
    svc.vars.set('base', 'v1', 'environment');
    const { status, results } = await run(
      [
        { id: 'get', name: 'Get', url: `${base}/me`, extract: { role: '$.role', count: '$.count' } },
        { id: 'run', name: 'Run', type: 'set', set: { who: '{{role}}', n: '{{count}}', label: 'n={{count}}' }, dependsOn: ['get'] },
        { id: 'env', name: 'Env', type: 'set', set: { lastRole: '{{role}}' }, scope: 'environment', dependsOn: ['run'] },
        { id: 'col', name: 'Col', type: 'set', set: { c: 'x' }, scope: 'collection', dependsOn: ['env'] },
        { id: 'glob', name: 'Glob', type: 'set', set: { g: 'y' }, scope: 'global', dependsOn: ['col'] },
        { id: 'use', name: 'Use', type: 'log', message: '{{who}} {{n}} {{lastRole}} {{c}} {{g}}', dependsOn: ['glob'] },
      ],
      { svc },
    );
    expect(Object.values(status).every((s) => s === 'passed')).toBe(true);
    expect(svc.vars.scopeValues('runtime')).toMatchObject({ who: 'admin', n: 3, label: 'n=3' });
    expect(svc.vars.scopeValues('environment')).toMatchObject({ lastRole: 'admin' });
    expect(svc.vars.scopeValues('collection')).toMatchObject({ c: 'x' });
    expect(svc.vars.scopeValues('global')).toMatchObject({ g: 'y' });
    expect(kept).toEqual([
      ['environment', 'lastRole', 'admin'],
      ['collectionVariables', 'c', 'x'],
      ['globals', 'g', 'y'],
    ]);
    expect(results.get('use')!.output).toBe('admin 3 admin x y');
    expect(results.get('env')!.metadata).toMatchObject({ setVariables: ['lastRole'], scope: 'environment', persisted: true });
    expect(results.get('run')!.metadata).toMatchObject({ persisted: false });
  });

  it('without a place to keep them (the CLI) scoped values last for the run', async () => {
    const { results, svc } = await run([{ id: 'env', name: 'Env', type: 'set', set: { a: '1' }, scope: 'environment' }]);
    expect(svc.vars.scopeValues('environment')).toEqual({ a: '1' });
    expect(results.get('env')!.metadata).toMatchObject({ persisted: false });
    expect(results.get('env')!.input).toMatch(/this run only/);
  });

  it('a secret is never shown: a sensitive name, or a value that holds a secret, is redacted in the results', async () => {
    const svc = services({ persistVariable: () => undefined });
    svc.vars.setScope('environment', [{ key: 'apiKey', value: 's3cr3t-value-123', secret: true }]);
    svc.redactor.addSecret('s3cr3t-value-123');
    const { results } = await run(
      [
        { id: 'copy', name: 'Copy', type: 'set', set: { copied: '{{apiKey}}', authToken: 'tok-abcdef-987', plain: 'hello' }, scope: 'environment' },
        { id: 'log', name: 'Log', type: 'log', message: '{{authToken}} {{copied}} {{plain}}', dependsOn: ['copy'] },
      ],
      { svc },
    );
    const text = JSON.stringify(results.get('copy'));
    expect(text).not.toContain('s3cr3t-value-123');
    expect(text).not.toContain('tok-abcdef-987');
    expect(text).toContain('hello');
    expect(results.get('log')!.output).not.toContain('tok-abcdef-987');
  });
});

describe('Assert', () => {
  it('checks the previous step’s response without a request', async () => {
    order.length = 0;
    const { status, results } = await run([
      { id: 'get', name: 'Get', url: `${base}/me` },
      {
        id: 'ok',
        name: 'Ok',
        type: 'assert',
        dependsOn: ['get'],
        assertions: [
          { type: 'status', expected: 200 },
          { type: 'equals', path: '$.role', expected: 'admin' },
        ],
      },
      { id: 'no', name: 'No', type: 'assert', dependsOn: ['get'], assertions: [{ type: 'equals', path: '$.role', expected: 'user' }] },
    ]);
    expect(status).toEqual({ get: 'passed', ok: 'passed', no: 'failed' });
    expect(order.filter((x) => x.startsWith('hit:'))).toEqual(['hit:/me']);
    expect(results.get('ok')!.input).toMatch(/2 checks on the previous response \(200\)/);
  });

  it('checks the variables', async () => {
    const svc = services();
    svc.vars.set('count', 3, 'runtime');
    const { status } = await run(
      [
        {
          id: 'v',
          name: 'V',
          type: 'assert',
          subject: 'variables',
          assertions: [
            { type: 'equals', path: '$.count', expected: 3 },
            { type: 'not-exists', path: '$.missing' },
          ],
        },
        { id: 'w', name: 'W', type: 'assert', subject: 'variables', assertions: [{ type: 'equals', path: '$.count', expected: 4 }] },
      ],
      { svc },
    );
    expect(status).toEqual({ v: 'passed', w: 'failed' });
  });

  it('with no response before it, says so', async () => {
    const { status, results } = await run([{ id: 'x', name: 'X', type: 'assert', assertions: [{ type: 'status', expected: 200 }] }]);
    expect(status).toEqual({ x: 'error' });
    expect(results.get('x')!.error!.message).toMatch(/no step before this one has a response/);
  });
});

describe('the canvas: flow steps, frames, the Finally lane, edits', () => {
  const steps = [
    normalizeTest({ id: 'start', name: 'Start', url: 'http://x/jobs', method: 'POST' }),
    normalizeTest({ id: 'poll', name: 'Poll', url: 'http://x/jobs/1', until: "$.status == 'done'", dependsOn: ['start'] }),
    normalizeTest({ id: 'a', name: 'A', url: 'http://x/a', parallel: 'lookups', dependsOn: ['poll'] }),
    normalizeTest({ id: 'b', name: 'B', url: 'http://x/b', parallel: 'lookups', dependsOn: ['poll'] }),
    normalizeTest({ id: 'keep', name: 'Keep', type: 'set', set: { total: '$.total', who: 'x' }, scope: 'environment', dependsOn: ['a'] }),
    normalizeTest({ id: 'check', name: 'Check', type: 'assert', assertions: [{ type: 'status' }], dependsOn: ['b'] }),
    normalizeTest({ id: 'clean', name: 'Clean', url: 'http://x/jobs/1', method: 'DELETE', finally: true }),
  ].map(flowStepOf);

  it('flowStepOf carries the blocks; the details say what they do', () => {
    const by = Object.fromEntries(steps.map((s) => [s.id, s]));
    expect(by.poll).toMatchObject({ until: "$.status == 'done'" });
    expect(untilLabel({ ...by.poll!, tries: 3 })).toBe("until $.status == 'done' · 3 tries");
    expect(by.a).toMatchObject({ parallel: 'lookups' });
    expect(by.keep).toMatchObject({ set: ['total', 'who'], scope: 'environment', extract: ['total', 'who'] });
    expect(stepDetail(by.keep!)).toBe('set total, who → environment');
    expect(stepDetail(by.check!)).toBe('1 check on the response');
    expect(by.clean).toMatchObject({ finally: true });
  });

  it('the finally steps are the last column; a parallel group and the Finally lane get frames; DOT has clusters', () => {
    const g = flowGraph(steps);
    const layer = Object.fromEntries(g.nodes.map((n) => [n.id, n.layer]));
    expect(layer.clean).toBe(Math.max(...Object.values(layer)));
    expect(layer.clean).toBeGreaterThan(layer.keep!);
    expect(g.groups.map((x) => [x.kind, x.name, x.ids])).toEqual([
      ['parallel', 'lookups', ['a', 'b']],
      ['finally', 'finally', ['clean']],
    ]);
    const frame = g.groups[0]!;
    for (const n of g.nodes.filter((x) => ['a', 'b'].includes(x.id))) {
      expect(n.x).toBeGreaterThan(frame.x);
      expect(n.y).toBeGreaterThan(frame.y);
      expect(n.x + n.w).toBeLessThan(frame.x + frame.w);
    }
    // nothing outside the group sits inside its frame
    for (const n of g.nodes.filter((x) => !['a', 'b'].includes(x.id))) expect(n.x + n.w <= frame.x || n.x >= frame.x + frame.w || n.y + n.h <= frame.y || n.y >= frame.y + frame.h).toBe(true);
    const dot = toDot(steps);
    expect(dot).toContain('label="parallel · lookups"');
    expect(dot).toContain("until $.status == 'done'");
  });

  it('group: puts steps in a parallel group or the Finally lane, refuses what would wait for a finally step', () => {
    const text = ['name: F', 'tests:', '  - { id: a, name: A, url: http://x/a }', '  - { id: b, name: B, url: http://x/b }', '  - { id: c, name: C, url: http://x/c, dependsOn: [a] }', ''].join(
      '\r\n',
    );
    const grouped = applyFlowEdit(text, { op: 'group', ids: ['a', 'b'], parallel: 'g1' }).text;
    expect(grouped).toContain('\r\n');
    expect(grouped.match(/parallel: g1/g)?.length).toBe(2);
    expect(applyFlowEdit(grouped, { op: 'group', ids: 'b', parallel: null }).text.match(/parallel: g1/g)?.length).toBe(1);
    expect(() => applyFlowEdit(text, { op: 'group', ids: 'a', finally: true })).toThrow(/c waits for it/);
    const fin = applyFlowEdit(grouped, { op: 'group', ids: 'b', finally: true }).text;
    expect(fin).toMatch(/id: b[^\n]*finally: true/);
    expect(fin).not.toMatch(/id: b[^\n]*parallel/);
    expect(() => applyFlowEdit(fin, { op: 'connect', from: 'b', to: 'c' })).toThrow(/finally step/);
    // the blocks are added like any step (the loader checks them)
    const added = applyFlowEdit(text, { op: 'addStep', step: { name: 'Keep', type: 'set', set: { x: '{{y}}' }, scope: 'global' }, after: 'c' });
    expect(added.text).toMatch(/type: set/);
    expect(() => applyFlowEdit(text, { op: 'addStep', step: { name: 'Bad', type: 'set', set: { x: 1 }, scope: 'disk' } })).toThrow(/scope:/);
  });
});
