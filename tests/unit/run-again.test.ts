import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { monitorRequestStats, executeMonitor, readRunSummary, requestIdOfResult, resultSourceRefs, runAgainPlan, saveMonitor, WorkspaceStore, type RunSummary } from '../../packages/core/src/index.js';
import { tempDir, waitFor } from '../helpers.js';

// WF-08: a result names its source (the test file at its step, or the saved request), and a run (or some of its
// results) runs again the way it first ran.
const tmp = tempDir('tp-runagain-');
let server: Server;
let base = '';
const hits: string[] = [];
let be: Backend;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.statusCode = req.url?.includes('fail') ? 500 : 200;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = join(tmp.dir, 'ws');
  const s = WorkspaceStore.create(root, 'Again');
  s.saveCollection({
    schemaVersion: '1.0',
    id: 'c1',
    name: 'Again',
    version: 0,
    updatedAt: '',
    variables: [],
    items: [
      { kind: 'http', id: 'ok', name: 'Ok', request: { method: 'GET', url: `${base}/ok`, headers: [] }, assertions: [{ type: 'status', expected: 200 }] },
      { kind: 'http', id: 'bad', name: 'Bad', request: { method: 'GET', url: `${base}/fail`, headers: [] }, assertions: [{ type: 'status', expected: 200 }] },
    ],
  } as never);
  mkdirSync(join(root, 'tests', 'smoke'), { recursive: true });
  writeFileSync(
    join(root, 'tests', 'smoke', 'two.yaml'),
    `tests:\n  - id: one\n    name: one\n    type: http\n    method: GET\n    url: ${base}/t1\n  - id: two\n    name: two\n    type: http\n    method: GET\n    url: ${base}/t2\n`,
  );
  s.close();
  be = new Backend({ appDir: join(tmp.dir, 'app'), emit: () => undefined, noMonitors: true });
  be.openStore(root);
});
afterAll(async () => {
  await be.dispose();
  server.close();
  tmp.cleanup();
});

const finished = (runId: string) => waitFor(() => !!readRunSummary(be.ws, runId), 15_000, `run ${runId}`).then(() => readRunSummary(be.ws, runId)!);

describe('result → source', () => {
  it('collection results name their saved request; test results their file at the step', async () => {
    expect(requestIdOfResult('req-1@2#3')).toBe('req-1');
    const { runId } = (await be.invoke('col.run', { collectionId: 'c1' })) as { runId: string };
    const summary = await finished(runId);
    expect(summary.origin).toEqual({ kind: 'collection', collectionId: 'c1' });
    const page = (await be.invoke('runs.results', { runId })) as { items: Array<{ id: string; refs: unknown[] }> };
    expect(page.items.map((r) => r.refs)).toContainEqual([{ kind: 'request', collectionId: 'c1', requestId: 'bad' }]);
    const t = (await be.invoke('tests.run', { paths: ['smoke/two.yaml'] })) as { runId: string };
    await finished(t.runId);
    const tp = (await be.invoke('runs.results', { runId: t.runId })) as { items: Array<{ refs: unknown[] }> };
    expect(tp.items.map((r) => r.refs)).toContainEqual([{ kind: 'test', path: 'smoke/two.yaml', step: 'two' }]);
    expect(resultSourceRefs(be.ws, { id: 'x', file: join(tmp.dir, 'elsewhere.yaml') })).toEqual([]);
  });
});

describe('run again', () => {
  it('a collection run: whole, or only some results (by request)', async () => {
    const { runId } = (await be.invoke('col.run', { collectionId: 'c1' })) as { runId: string };
    await finished(runId);
    hits.length = 0;
    const again = (await be.invoke('runs.runAgain', { runId, resultIds: ['bad@1'] })) as { runId: string };
    const s = await finished(again.runId);
    expect(s.total).toBe(1);
    expect(hits).toEqual(['GET /fail']);
    expect(s.origin).toEqual({ kind: 'collection', collectionId: 'c1', selection: ['bad'] });
  });

  it('a test run: one step again, or "last" as it ran', async () => {
    const { runId } = (await be.invoke('tests.run', { paths: ['smoke/two.yaml'] })) as { runId: string };
    await finished(runId);
    hits.length = 0;
    const one = (await be.invoke('runs.runAgain', { runId, resultIds: ['two'] })) as { runId: string };
    expect((await finished(one.runId)).total).toBe(1);
    expect(hits).toEqual(['GET /t2']);
    const last = (await be.invoke('runs.runAgain', { runId: 'last' })) as { runId: string };
    expect((await finished(last.runId)).total).toBe(1); // the last run was the one-step run: as it ran
  });

  it('a run that does not say what it ran is refused with why', () => {
    const s = { runId: 'r', name: 'old' } as RunSummary;
    expect(() => runAgainPlan(s)).toThrow(/does not say what it ran/);
    expect(runAgainPlan({ ...s, files: ['/w/tests/a.yaml'] })).toMatchObject({ kind: 'tests', paths: ['/w/tests/a.yaml'] });
  });
});

describe('monitor rows', () => {
  it('name their saved request', async () => {
    const m = saveMonitor(be.ws, { id: 'mon-a', name: 'A', collectionId: 'c1', everyMinutes: 60, enabled: false });
    await executeMonitor({ store: be.ws, monitor: m, trigger: 'manual', context: (o) => be.context(o) });
    const stats = await monitorRequestStats(be.ws, 'mon-a');
    expect(stats.find((x) => x.name === 'Bad')?.ref).toEqual({ kind: 'request', collectionId: 'c1', requestId: 'bad' });
  });
});
