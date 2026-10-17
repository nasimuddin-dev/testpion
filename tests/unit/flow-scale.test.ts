import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import {
  flowDataSource,
  flowRunStatus,
  listScaleRuns,
  readFlowDataHeader,
  readScaleRun,
  readScaleRunSteps,
  runFlowData,
  runFlowMatrix,
  runLoadTest,
  saveScaleRun,
  scaleRunId,
  readScaleRows,
  ScaleRowsWriter,
  type DataRowResult,
} from '../../packages/core/src/index.js';
import { flowTimeline, timelineHtml, timelineSvg } from '../../packages/shared/src/index.js';
import { fakeServices, tempDir } from '../helpers.js';

// The flow designer's Scale stage: data-driven runs (a row per run, bail, cancel, concurrency), the environment
// matrix, a flow as a load-test scenario and the run timeline (critical path through parallel and finally steps).
let server: Server;
let base = '';
let inflight = 0;
let maxInflight = 0;
let requests = 0;
/** A test's own view of each request as it arrives (to act on the server's signal, not on the clock). */
let onRequest: ((url: URL) => void) | undefined;
const tmp = tempDir('tp-flow-scale-');

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    inflight++;
    requests++;

    maxInflight = Math.max(maxInflight, inflight);
    onRequest?.(url);
    const ms = Number(url.searchParams.get('ms') ?? 0);
    if (ms) await new Promise((r) => setTimeout(r, ms));
    inflight--;
    const code = Number(url.searchParams.get('code') ?? 200);
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ path: url.pathname, user: url.searchParams.get('user'), index: url.searchParams.get('i'), id: `id-${url.searchParams.get('user') ?? 'x'}`, env: url.searchParams.get('env') }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  tmp.cleanup();
});

const flowFile = (name: string, yaml: string) => {
  const f = join(tmp.dir, name);
  writeFileSync(f, yaml);
  return f;
};

const twoSteps = () =>
  flowFile(
    'users.yaml',
    [
      'name: Users',
      'tests:',
      '  - { id: create, name: Create, url: "{{baseUrl}}/users?user={{name}}&i={{$index}}&code={{code}}&ms={{ms}}", extract: { userId: "$.id" }, assertions: [{ type: status, expected: 200 }] }',
      '  - { id: read, name: Read, url: "{{baseUrl}}/users/{{userId}}?user={{$row.name}}", dependsOn: [create], assertions: [{ type: status, expected: 200 }] }',
      '',
    ].join('\n'),
  );

const rows = (n: number, failAt: number[] = [], ms = 0) => Array.from({ length: n }, (_, i) => ({ name: `u${i}`, code: failAt.includes(i) ? 500 : 200, ms }));

describe('data-driven flow runs', () => {
  it('runs the flow once per row with the fields, $row and $index as variables', async () => {
    const got: DataRowResult[] = [];
    const detail: number[] = [];
    const r = await runFlowData({
      file: twoSteps(),
      data: { records: rows(3, [1]) },
      services: fakeServices({ vars: { baseUrl: base } }),
      onRow: (x, steps) => {
        got.push(x);
        if (steps) detail.push(x.index);
      },
    });
    expect(r).toMatchObject({ total: 3, passed: 2, failed: 1, bailed: false, columns: ['name', 'code', 'ms'] });
    got.sort((a, b) => a.index - b.index);
    expect(got.map((x) => x.status)).toEqual(['passed', 'failed', 'passed']);
    expect(got[1]).toMatchObject({ index: 1, failedStep: 'create', failedStepName: 'Create', values: { name: 'u1', code: 500 } });
    expect(r.failedRows.map((x) => x.index)).toEqual([1]);
    expect(got[1]!.steps.map((s) => `${s.id}=${s.status}`)).toEqual(['create=failed', 'read=skipped']);
    expect(got[2]!.steps.map((s) => s.status)).toEqual(['passed', 'passed']);
    expect(detail.sort()).toEqual([0, 1, 2]);
  });

  it('runs rows concurrently up to the limit, and in order at 1', async () => {
    maxInflight = 0;
    await runFlowData({ file: twoSteps(), data: { records: rows(6, [], 60) }, services: fakeServices({ vars: { baseUrl: base } }), concurrency: 3 });
    expect(maxInflight).toBe(3);
    maxInflight = 0;
    const r = await runFlowData({ file: twoSteps(), data: { records: rows(3, [], 20) }, services: fakeServices({ vars: { baseUrl: base } }) });
    expect(maxInflight).toBe(1);
    expect(r.passed).toBe(3);
  });

  it('bail stops at the first failing row', async () => {
    const r = await runFlowData({ file: twoSteps(), data: { records: rows(10, [2]) }, services: fakeServices({ vars: { baseUrl: base } }), bail: true });
    expect(r.bailed).toBe(true);
    expect(r.total).toBe(3);
    expect(r.failedRows.map((x) => x.index)).toEqual([2]);
  });

  it('cancel stops the run: the rows running are cancelled, no more start', async () => {
    // cancelled on the server's signal, not after a fixed time: the moment both rows' first requests are held there
    // (each row waits for its response, so no request of the run is on the way when it is cancelled)
    const ctrl = new AbortController();
    let mine = 0; // this run's requests (ms=301 marks them)
    onRequest = (url) => {
      if (url.searchParams.get('ms') === '301' && ++mine === 2) ctrl.abort();
    };
    try {
      const r = await runFlowData({ file: twoSteps(), data: { records: rows(20, [], 301) }, services: fakeServices({ vars: { baseUrl: base } }), concurrency: 2, signal: ctrl.signal });
      expect(r.stopped).toBe(true);
      // exactly the two rows that were running, both cancelled; none of the other 18 started
      expect(r).toMatchObject({ total: 2, cancelled: 2, passed: 0, failed: 0 });
      expect(mine).toBe(2);
      // nothing starts after the run returned: a monotonic count, read once the run settled and again later (past
      // the 301 ms the server holds a request)
      await new Promise((res) => setTimeout(res, 400));
      expect(mine).toBe(2);
    } finally {
      onRequest = undefined;
    }
  });

  it('a row read while the run is cancelled never starts (and is not counted)', async () => {
    // the cancel lands exactly while the third row is being read from the data (its getter cancels): deterministic
    const ctrl = new AbortController();
    const records = rows(5, [], 1);
    const third = records[2]!;
    Object.defineProperty(records, 2, {
      get: () => {
        ctrl.abort();
        return third;
      },
    });
    const created: string[] = []; // this run's first steps (ms=1 marks them)
    onRequest = (url) => void (url.searchParams.get('ms') === '1' && created.push(url.searchParams.get('user')!));
    try {
      const finished: number[] = [];
      const r = await runFlowData({ file: twoSteps(), data: { records }, services: fakeServices({ vars: { baseUrl: base } }), concurrency: 1, signal: ctrl.signal, onRow: (x) => finished.push(x.index) });
      expect(r).toMatchObject({ stopped: true, total: 2, passed: 2, cancelled: 0 });
      expect(finished).toEqual([0, 1]);
      expect(created).toEqual(['u0', 'u1']); // nothing of row 2
    } finally {
      onRequest = undefined;
    }
  });

  it("reads the file's data: header (a CSV next to it), and limits", async () => {
    writeFileSync(join(tmp.dir, 'people.csv'), 'name,code,ms\nann,200,0\nbob,200,0\ncy,200,0\n');
    const f = flowFile('with-data.yaml', `name: With data\ndata: people.csv\ntests:\n  - { id: one, name: One, url: "${base}/p?user={{name}}" }\n`);
    const spec = readFlowDataHeader(f);
    expect(spec).toBe('people.csv');
    const src = flowDataSource(spec!, { file: f, limit: 2 });
    const names: unknown[] = [];
    const r = await runFlowData({ file: f, data: src, services: fakeServices(), onRow: (x) => names.push(x.values.name) });
    expect(r.total).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.source).toMatch(/people\.csv/);
    expect(names).toEqual(['ann', 'bob']);
    expect(() => flowDataSource('nope.csv', { file: f })).toThrow(/No such data file/);
  });

  it('empty, broken and odd data give a clear result', async () => {
    const f = flowFile('plain.yaml', `tests:\n  - { id: one, name: One, url: "${base}/p" }\n`);
    writeFileSync(join(tmp.dir, 'empty.csv'), 'name\n');
    const empty = await runFlowData({ file: f, data: { path: join(tmp.dir, 'empty.csv') }, services: fakeServices() });
    expect(empty).toMatchObject({ total: 0, passed: 0, failed: 0 });
    writeFileSync(join(tmp.dir, 'broken.jsonl'), '{"a":1}\n{not json\n');
    const broken = await runFlowData({ file: f, data: { path: join(tmp.dir, 'broken.jsonl') }, services: fakeServices() });
    expect(broken.total).toBe(1);
    expect(broken.dataError).toMatch(/Invalid JSON on line 2/);
    writeFileSync(join(tmp.dir, 'all-broken.jsonl'), '{nope\n');
    await expect(runFlowData({ file: f, data: { path: join(tmp.dir, 'all-broken.jsonl') }, services: fakeServices() })).rejects.toThrow(/Could not read the data .*Invalid JSON on line 1/);
    // rows that are not objects are a `value`; a server that is down fails the row with the reason
    const odd = await runFlowData({ file: f, data: { records: [5 as unknown as Record<string, unknown>] }, services: fakeServices() });
    expect(odd.passed).toBe(1);
    const down = flowFile('down.yaml', 'tests:\n  - { id: one, name: One, url: "http://127.0.0.1:9/never" }\n');
    const r = await runFlowData({ file: down, data: { records: [{ a: 1 }] }, services: fakeServices() });
    expect(r.failedRows[0]).toMatchObject({ failedStep: 'one' });
    expect(r.failedRows[0]!.error).toBeTruthy();
  });

  it('masks secret columns in the row values', async () => {
    const f = flowFile('secret.yaml', `tests:\n  - { id: one, name: One, url: "${base}/p" }\n`);
    let row: DataRowResult | undefined;
    await runFlowData({ file: f, data: { records: [{ user: 'a', password: 'hunter2' }] }, services: fakeServices(), onRow: (x) => (row = x) });
    expect(row!.values.password).not.toBe('hunter2');
  });

  it('keeps the runs and the kept rows’ steps in the workspace', async () => {
    const store = { path: (...p: string[]) => join(tmp.dir, 'ws', ...p) };
    const id = scaleRunId('data');
    const w = new ScaleRowsWriter(store, id);
    const r = await runFlowData({ file: twoSteps(), data: { records: rows(5, [1, 3]) }, services: fakeServices({ vars: { baseUrl: base } }), concurrency: 3, onRow: (x, s) => w.write(x, s) });
    // pages while the run goes come from the writer
    expect(w.page({ status: 'failed' }).rows.map((x) => x.index)).toEqual([1, 3]);
    w.close();
    saveScaleRun(store, { id, kind: 'data', ...r, file: 'users.yaml' });
    expect(listScaleRuns(store, { file: 'users.yaml' })[0]).toMatchObject({ id, kind: 'data', status: 'failed', total: 5, failed: 2 });
    expect(readScaleRun(store, id)).toMatchObject({ kind: 'data', total: 5 });
    const p = readScaleRows(store, id, { offset: 1, limit: 2 });
    expect(p).toMatchObject({ total: 5, matched: 5, counts: { passed: 3, failed: 2, cancelled: 0 } });
    expect(p.rows.map((x) => x.index)).toEqual([1, 2]);
    expect(readScaleRows(store, id, { status: 'failed' }).rows.map((x) => x.values.name)).toEqual(['u1', 'u3']);
    expect(readScaleRunSteps(store, id, 3)?.map((s) => s.id)).toEqual(['create', 'read']);
    // without its index file (a run that crashed) the rows are found by reading rows.jsonl
    const dir = store.path('runs', 'scale', id);
    rmSync(join(dir, 'rows.idx.json'));
    writeFileSync(join(dir, 'rows.jsonl'), readFileSync(join(dir, 'rows.jsonl'), 'utf8') + '{"cut');
    expect(readScaleRows(store, id, { status: 'failed' }).rows.map((x) => x.index)).toEqual([1, 3]);
    expect(readScaleRunSteps(store, id, 1)?.map((s) => s.id)).toEqual(['create', 'read']);
    expect(() => readScaleRun(store, '../x')).toThrow(/Not a data run/);
  });
});

describe('a run where nothing ran', () => {
  // every step waits for a step in another file: the runner skips them all
  const orphan = () => flowFile('orphan.yaml', `tests:\n  - { id: a, name: A, url: "${base}/a", dependsOn: [elsewhere] }\n  - { id: b, name: B, url: "${base}/b", dependsOn: [a] }\n`);

  it('a data run whose rows skip every step is skipped, never passed (rows, counts, the kept run)', async () => {
    const store = { path: (...p: string[]) => join(tmp.dir, 'ws-skip', ...p) };
    const got: DataRowResult[] = [];
    const r = await runFlowData({ file: orphan(), data: { records: rows(3) }, services: fakeServices({ vars: { baseUrl: base } }), onRow: (x) => got.push(x) });
    expect(got.map((x) => x.status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(r).toMatchObject({ total: 3, passed: 0, failed: 0, skipped: 3 });
    const id = scaleRunId('data');
    expect(saveScaleRun(store, { id, kind: 'data', ...r, file: 'orphan.yaml' })).toMatchObject({ status: 'skipped', skipped: 3, passed: 0 });
    expect(listScaleRuns(store, { file: 'orphan.yaml' })[0]!.status).toBe('skipped');
  });

  it('an environment matrix where nothing ran is skipped; its rows and the status rule agree', async () => {
    const m = await runFlowMatrix({ file: orphan(), environments: ['dev', 'staging'], contextFor: () => ({ services: fakeServices({ vars: { baseUrl: base } }), dispose: () => undefined }) });
    expect(m.columns.map((c) => c.status)).toEqual(['skipped', 'skipped']);
    expect(m).toMatchObject({ passed: 0, failed: 0, skipped: 2 });
    const store = { path: (...p: string[]) => join(tmp.dir, 'ws-skip', ...p) };
    expect(saveScaleRun(store, { id: scaleRunId('matrix'), kind: 'matrix', ...m, file: 'orphan.yaml' }).status).toBe('skipped');
    expect(flowRunStatus([{ status: 'skipped' }, { status: 'skipped' }])).toBe('skipped');
    expect(flowRunStatus([{ status: 'skipped' }, { status: 'passed' }])).toBe('passed');
    expect(flowRunStatus([{ status: 'passed' }, { status: 'error' }])).toBe('failed');
    expect(flowRunStatus([{ status: 'passed' }], true)).toBe('cancelled');
  });
});

describe('environment matrix', () => {
  it('runs the flow in each environment and marks what differs', async () => {
    const f = flowFile(
      'matrix.yaml',
      [
        'output:',
        '  env: "{{seen}}"',
        '  same: "fixed"',
        'tests:',
        '  - { id: ping, name: Ping, url: "{{baseUrl}}/ping?env={{envName}}&code={{code}}", extract: { seen: "$.env" }, assertions: [{ type: status, expected: 200 }] }',
        '  - { id: pong, name: Pong, url: "{{baseUrl}}/pong", dependsOn: [ping] }',
        '',
      ].join('\n'),
    );
    const vars: Record<string, Record<string, string>> = { dev: { baseUrl: base, envName: 'dev', code: '200' }, staging: { baseUrl: base, envName: 'staging', code: '503' } };
    let disposed = 0;
    const m = await runFlowMatrix({ file: f, environments: ['dev', 'staging'], contextFor: (e) => ({ services: fakeServices({ vars: vars[e] }), dispose: () => void disposed++ }) });
    expect(disposed).toBe(2);
    expect(m.environments).toEqual(['dev', 'staging']);
    expect(m.columns.map((c) => `${c.environment}=${c.status}`)).toEqual(['dev=passed', 'staging=failed']);
    expect(m.columns[1]).toMatchObject({ failedStep: 'ping', cells: { ping: { status: 'failed' }, pong: { status: 'skipped' } } });
    expect(m.differingSteps).toEqual(['ping', 'pong']);
    expect(m.outputs.find((o) => o.key === 'same')).toMatchObject({ differs: false, values: ['fixed', 'fixed'] });
    expect(m.outputs.find((o) => o.key === 'env')).toMatchObject({ differs: true });
  });

  it('an environment that cannot be set up is a failed column, not a failed matrix', async () => {
    const f = flowFile('m2.yaml', `tests:\n  - { id: a, name: A, url: "${base}/a" }\n`);
    const m = await runFlowMatrix({
      file: f,
      environments: ['ok', 'broken'],
      contextFor: (e) => {
        if (e === 'broken') throw new Error('no such environment');
        return { services: fakeServices(), dispose: () => undefined };
      },
    });
    expect(m.columns.map((c) => c.status)).toEqual(['passed', 'failed']);
    expect(m.columns[1]!.error).toMatch(/no such environment/);
  });
});

describe('a flow as a load-test scenario', () => {
  it('each virtual user runs the whole flow: numbers per step and per iteration', async () => {
    const f = flowFile(
      'load.yaml',
      [
        'tests:',
        '  - { id: login, name: Login, url: "{{baseUrl}}/login?user=lu", extract: { userId: "$.id" } }',
        '  - { id: get, name: Get, url: "{{baseUrl}}/users/{{userId}}", dependsOn: [login] }',
        '',
      ].join('\n'),
    );
    const s = await runLoadTest({ target: { kind: 'flow', file: f }, virtualUsers: 2, durationSec: 1 }, { services: fakeServices({ vars: { baseUrl: base } }), testsDir: tmp.dir });
    expect(s.iterations).toBeGreaterThan(2);
    expect(s.iteration).toMatchObject({ failed: 0 });
    expect(s.iteration!.count).toBe(s.iterations);
    expect(s.perRequest!.map((p) => p.name)).toEqual(['Login', 'Get']);
    expect(s.perRequest![0]!.requests).toBeGreaterThanOrEqual(s.iterations!);
    expect(s.errors).toBe(0);
    expect(s.statusCodes['200']).toBe(s.requests);
  });

  it('the safeguards look at every host of the flow', async () => {
    const f = flowFile('remote.yaml', 'tests:\n  - { id: a, name: A, url: "https://api.example.com/a" }\n');
    await expect(runLoadTest({ target: { kind: 'flow', file: f }, virtualUsers: 1, durationSec: 1 }, { services: fakeServices(), testsDir: tmp.dir })).rejects.toThrow(/remote host "api.example.com"/);
    const g = flowFile('unset.yaml', 'tests:\n  - { id: a, name: A, url: "{{nowhere}}/a" }\n');
    await expect(runLoadTest({ target: { kind: 'flow', file: g }, virtualUsers: 1, durationSec: 1 }, { services: fakeServices(), testsDir: tmp.dir })).rejects.toThrow(/not set/);
    await expect(runLoadTest({ target: { kind: 'flow', file: '../outside.yaml' }, virtualUsers: 1, durationSec: 1 }, { services: fakeServices(), testsDir: tmp.dir })).rejects.toThrow(/inside tests/);
  });
});

describe('run timeline', () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
  it('finds the critical path through parallel steps and a finally step', () => {
    // login (0-100) → a (100-400) and b (100-200) in parallel → c after both (400-450); cleanup (finally) after all
    const t = flowTimeline([
      { id: 'login', name: 'Login', startedAt: at(0), durationMs: 100, status: 'passed' },
      { id: 'a', name: 'A', startedAt: at(100), durationMs: 300, status: 'passed', dependsOn: ['login'] },
      { id: 'b', name: 'B', startedAt: at(105), durationMs: 95, status: 'passed', dependsOn: ['login'] },
      { id: 'c', name: 'C', startedAt: at(410), durationMs: 40, status: 'failed', dependsOn: ['a', 'b'] },
      { id: 'cleanup', name: 'Cleanup', startedAt: at(460), durationMs: 30, status: 'passed', finally: true },
      { id: 'never', name: 'Never', startedAt: at(450), durationMs: 0, status: 'skipped', dependsOn: ['c'] },
    ]);
    expect(t.totalMs).toBe(490);
    expect(t.criticalPath).toEqual(['login', 'a', 'c', 'cleanup']);
    expect(t.lanes).toBe(2);
    const by = Object.fromEntries(t.bars.map((b) => [b.id, b]));
    expect(by.b!.lane).not.toBe(by.a!.lane);
    expect(by.c).toMatchObject({ blockedBy: 'a', waitMs: 10, critical: true });
    expect(by.b).toMatchObject({ blockedBy: 'login', waitMs: 5, critical: false });
    expect(by.cleanup).toMatchObject({ blockedBy: 'c', waitMs: 10 });
    expect(t.criticalBusyMs).toBe(470);
    expect(t.slowest[0]).toMatchObject({ id: 'a', durationMs: 300 });
  });

  it('a step without dependencies that started late waited for a worker', () => {
    const t = flowTimeline([
      { id: 'x', name: 'X', startedAt: at(0), durationMs: 50, status: 'passed' },
      { id: 'y', name: 'Y', startedAt: at(50), durationMs: 50, status: 'passed' },
    ]);
    expect(t.criticalPath).toEqual(['x', 'y']);
    expect(t.bars[1]).toMatchObject({ blockedBy: 'x', waitMs: 0, lane: 0 });
    expect(flowTimeline([])).toMatchObject({ totalMs: 0, bars: [], criticalPath: [] });
  });

  it('renders an SVG with a bar per step and a self-contained HTML page', () => {
    const t = flowTimeline([
      { id: 'a', name: 'A <script>', startedAt: at(0), durationMs: 20, status: 'passed' },
      { id: 'b', name: 'B', startedAt: at(20), durationMs: 20, status: 'failed', dependsOn: ['a'] },
    ]);
    const svg = timelineSvg(t);
    expect(svg.match(/data-step-id=/g)).toHaveLength(2);
    expect(svg).toContain('data-critical="true"');
    expect(svg).not.toContain('<script>');
    const html = timelineHtml(t, { title: 'Run timeline: x.yaml', file: 'x.yaml', runId: 'run-1' });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).not.toMatch(/<script|https?:\/\/(?!www\.w3\.org)/);
    expect(html).toContain('Critical path');
  });
});
