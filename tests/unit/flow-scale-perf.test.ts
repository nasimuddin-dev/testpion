import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readScaleRows, readScaleRunSteps, runFlowData, runFlowMatrix, saveScaleRun, scaleRunId, ScaleRowsWriter } from '../../packages/core/src/index.js';
import { flowTimeline, timelineSvg } from '../../packages/shared/src/index.js';
import { fakeServices, tempDir } from '../helpers.js';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const heapMb = () => {
  gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
};

// The Scale stage at scale: a 10,000-row data run keeps its memory bounded (rows go to disk as they finish, pages are
// read back by offset), a 1,000-step timeline is computed and drawn quickly, a 20-environment matrix runs.
let server: Server;
let base = '';
const tmp = tempDir('tp-flow-scale-perf-');

beforeAll(async () => {
  server = createServer((req, res) => {
    const fail = (req.url ?? '').includes('code=500');
    res.writeHead(fail ? 500 : 200, { 'content-type': 'application/json' });
    res.end('{"ok":true,"id":"x1"}');
  });
  server.keepAliveTimeout = 5000;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  tmp.cleanup();
});

describe('scale', () => {
  it('a 10,000-row data run: bounded memory, pages read by offset', async () => {
    const csv = join(tmp.dir, 'rows.csv');
    const lines = ['name,code'];
    for (let i = 0; i < 10_000; i++) lines.push(`user-${i},${i % 1000 === 7 ? 500 : 200}`);
    writeFileSync(csv, lines.join('\n'));
    const f = join(tmp.dir, 'flow.yaml');
    writeFileSync(
      f,
      `tests:\n  - { id: one, name: One, url: "${base}/u?name={{name}}&code={{code}}", extract: { id: "$.id" }, assertions: [{ type: status, expected: 200 }] }\n  - { id: two, name: Two, url: "${base}/u/{{id}}", dependsOn: [one] }\n`,
    );
    const store = { path: (...p: string[]) => join(tmp.dir, 'ws', ...p) };
    const id = scaleRunId('data');
    const w = new ScaleRowsWriter(store, id);
    const heap0 = heapMb();
    let mid = 0;
    const t0 = performance.now();
    let n = 0;
    const r = await runFlowData({
      file: f,
      data: { path: csv },
      services: fakeServices(),
      concurrency: 16,
      onRow: (row, steps) => {
        w.write(row, steps);
        if (++n === 5000) mid = heapMb();
      },
    });
    w.close();
    const ms = performance.now() - t0;
    saveScaleRun(store, { id, kind: 'data', ...r, file: 'flow.yaml' });
    expect(r).toMatchObject({ total: 10_000, failed: 10, passed: 9990 });
    expect(r.failedRows).toHaveLength(10);
    const t1 = performance.now();
    const page = readScaleRows(store, id, { offset: 9800, limit: 200 });
    const failed = readScaleRows(store, id, { status: 'failed' });
    const pageMs = performance.now() - t1;
    expect(page.rows.map((x) => x.index)).toEqual(Array.from({ length: 200 }, (_, i) => 9800 + i));
    expect(failed.rows.map((x) => x.index)).toEqual([7, 1007, 2007, 3007, 4007, 5007, 6007, 7007, 8007, 9007]);
    expect(readScaleRunSteps(store, id, 1007)?.map((s) => s.id)).toEqual(['one', 'two']);
    const after = heapMb();
    console.log(
      `10k-row data run: ${Math.round(ms)} ms (${Math.round(10_000 / (ms / 1000))} rows/s); live heap ${heap0.toFixed(1)} MB before, ${mid.toFixed(1)} MB at row 5,000, ${after.toFixed(1)} MB after; two pages ${pageMs.toFixed(1)} ms`,
    );
    // the rows are on disk, not in memory: the live heap mid-run and after stays flat (no per-row growth)
    expect(mid - heap0).toBeLessThan(40);
    expect(after - heap0).toBeLessThan(40);

    expect(pageMs).toBeLessThan(500);
  }, 180_000);

  it('a 1,000-step timeline is computed and drawn quickly', () => {
    const steps = Array.from({ length: 1000 }, (_, i) => ({
      id: `s${i}`,
      name: `Step ${i}`,
      startedAt: 1_700_000_000_000 + Math.floor(i / 4) * 10 + (i % 4),
      durationMs: 8 + (i % 7),
      status: i % 50 === 0 ? 'failed' : 'passed',
      dependsOn: i >= 4 ? [`s${i - 4}`] : [],
      finally: i === 999,
    }));
    const t0 = performance.now();
    const t = flowTimeline(steps);
    const svg = timelineSvg(t);
    const ms = performance.now() - t0;
    console.log(`1,000-step timeline: ${ms.toFixed(1)} ms, ${t.lanes} lanes, critical path ${t.criticalPath.length} steps, SVG ${(svg.length / 1024).toFixed(0)} KB`);
    expect(t.bars).toHaveLength(1000);
    expect(t.lanes).toBeGreaterThanOrEqual(4);
    expect(t.criticalPath.at(-1)).toBe('s999');
    expect(ms).toBeLessThan(1000);
  });

  it('a 20-environment matrix', async () => {
    const f = join(tmp.dir, 'm.yaml');
    writeFileSync(f, `tests:\n  - { id: a, name: A, url: "${base}/a?e={{e}}" }\n`);
    const envs = Array.from({ length: 20 }, (_, i) => `env${i}`);
    const m = await runFlowMatrix({ file: f, environments: envs, contextFor: (e) => ({ services: fakeServices({ vars: { e } }), dispose: () => undefined }) });
    expect(m.columns).toHaveLength(20);
    expect(m.passed).toBe(20);
    await expect(runFlowMatrix({ file: f, environments: Array.from({ length: 21 }, (_, i) => `e${i}`), contextFor: () => ({ services: fakeServices(), dispose: () => undefined }) })).rejects.toThrow(
      /at most 20/,
    );
  });
});
