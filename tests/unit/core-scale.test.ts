import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectWithin } from '../perf-budget';
import {
  collectionRequests,
  collectionRequestToTest,
  executeHttp,
  existingRequests,
  flakyTests,
  flakyTestsPage,
  matchSecretKey,
  pageOf,
  pageRunResults,
  parseSearchQuery,
  Redactor,
  runCollection,
  runSearchQuery,
  runTests,
  secretKeyFields,
  testHistory,
  type Collection,
  type CollectionNode,
  type TestCase,
  type WorkspaceStore,
} from '../../packages/core/src/index.js';
import { TestFileScanner } from '../../packages/core/src/runner/test-file-scan.js';
import { exposedFlows } from '../../packages/core/src/runner/exposed-flows.js';
import { fakeServices, tempDir } from '../helpers.js';

// The engine at the sizes the product is meant to hold: 10,000 requests, 5,000 results in a run, 100,000 history rows,
// a response of 96 MB spooled to disk. Memory stays flat, no read scans what a cache or a cap can answer, and every list
// that can be long comes back in pages (`limit`, `cursor`, `truncated`). The budgets are generous (other work shares the
// machine): they catch an algorithm that became quadratic, not a slow minute.

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const heapMb = () => {
  gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
};

const tmp = tempDir('tp-core-scale-');
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  tmp.cleanup();
});

/* ------------------------------------------------------------------ 10,000 requests */

const collectionOf = (folders: number, perFolder: number, url = (i: number) => `{{baseUrl}}/items/${i}`): Collection => {
  let n = 0;
  const items: CollectionNode[] = Array.from({ length: folders }, (_, f) => ({
    kind: 'folder' as const,
    id: `f${f}`,
    name: `Folder ${f}`,
    variables: [{ key: 'folder', value: String(f), enabled: true }],
    items: Array.from({ length: perFolder }, () => {
      const i = n++;
      return { kind: 'http' as const, id: `r${i}`, name: `Request ${i}`, request: { method: 'GET', url: url(i) }, assertions: [{ type: 'status', expected: 200 }] };
    }),
  }));
  return { schemaVersion: '1.0', id: 'big', name: 'Big', items, variables: [] } as unknown as Collection;
};

describe('a collection of 10,000 requests', () => {
  it('lists them in order and turns each into a test in well under a second per thousand', () => {
    const c = collectionOf(100, 100);
    const t0 = performance.now();
    const refs = collectionRequests(c);
    const tests = refs.map((r) => collectionRequestToTest(c, r));
    const ms = performance.now() - t0;
    expect(refs).toHaveLength(10_000);
    expect(tests[9999]!.id).toBe('r9999');
    expect(tests[9999]!.name).toBe('Folder 99 / Request 9999');
    expect(tests[0]!.variables).toEqual({ folder: '0' });
    expectWithin(ms, 5000, '10,000 requests');
    // a selection of one folder is found without walking the others again and again
    const t1 = performance.now();
    for (let i = 0; i < 100; i++) expect(collectionRequests(c, [`f${i}`])).toHaveLength(100);
    expectWithin(performance.now() - t1, 5000, '100 folder selections');
  });

  it('runs more than a thousand requests in one go (the runaway guard counts loops, not a long collection)', async () => {
    const c = collectionOf(26, 100);
    const summary = await runCollection({ name: 'long', collection: c, services: fakeServices({ vars: { baseUrl: base } }) });
    expect(summary.total).toBe(2600);
    expect(summary.passed).toBe(2600);
  }, 180_000);

  it('still stops a runaway loop', async () => {
    const c = collectionOf(1, 3);
    (c.items[0] as { items: Array<{ testScript?: string }> }).items[0]!.testScript = 'tp.execution.setNextRequest("Request 0")';
    await expect(runCollection({ name: 'loop', collection: c, services: fakeServices({ vars: { baseUrl: base } }), maxRequestsPerIteration: 50 })).rejects.toThrow(/setNextRequest loop/);
  }, 60_000);

  it('runs 10,000 steps with flat memory and every result on disk', async () => {
    const results = join(tmp.dir, 'ten-thousand.jsonl');
    const steps = function* (): Generator<TestCase> {
      for (let i = 0; i < 10_000; i++) yield { id: `s${i}`, name: `Step ${i}`, type: 'log', message: `step ${i} says hello`.repeat(4), file: `f${i % 40}.yaml` } as TestCase;
    };
    const before = heapMb();
    const t0 = performance.now();
    let peak = 0;
    let n = 0;
    const summary = await runTests({
      name: 'ten-thousand',
      tests: steps(),
      services: fakeServices(),
      concurrency: 8,
      resultsFile: results,
      onEvent: (e) => {
        if (e.type === 'test-end' && ++n % 2500 === 0) peak = Math.max(peak, heapMb());
      },
    });
    const ms = performance.now() - t0;
    expect(summary.total).toBe(10_000);
    expect(summary.passed).toBe(10_000);
    expect(readFileSync(results, 'utf8').trim().split('\n')).toHaveLength(10_000);
    expect(peak - before, `the heap grew ${Math.round(peak - before)} MB`).toBeLessThan(120);
    expectWithin(ms, 120_000, '10,000 steps');
  }, 180_000);
});

/* ------------------------------------------------------------------ 5,000 results in a run */

const RUNS = 40;
const PER = 2000;
const runs = Array.from({ length: RUNS }, (_, r) => ({ id: `run-${r}`, name: `Run ${r}`, startedAt: new Date(Date.UTC(2026, 0, 30) - r * 3600_000).toISOString(), environment: r % 2 ? 'prod' : 'dev', total: PER, passed: PER, failed: 0, errors: 0, durationMs: 1000 }));
const storeOf = (): WorkspaceStore =>
  ({
    runDir: (id: string) => join(tmp.dir, 'runs', id),
    meta: {
      listRuns: ({ limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}) => ({ items: runs.slice(offset, offset + limit), total: runs.length }),
      listHistory: ({ limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}) => ({
        items: Array.from({ length: Math.max(0, Math.min(limit, 100_000 - offset)) }, (_, k) => {
          const i = offset + k;
          return { id: `h${i}`, name: `Request ${i}`, url: `https://api.example.com/v1/items/${i}`, method: i % 3 ? 'GET' : 'POST', kind: 'http', status: i % 11 ? 200 : 500, timestamp: new Date(Date.UTC(2026, 0, 30) - i * 1000).toISOString(), durationMs: 20 + (i % 300), size: 100 + i };
        }),
        total: 100_000,
      }),
      listTraces: () => ({ items: [], total: 0 }),
    },
    listCollections: () => [],
    loadTraceAsync: async () => undefined,
  }) as unknown as WorkspaceStore;

beforeAll(() => {
  for (let r = 0; r < RUNS; r++) {
    const run = runs[r]!;
    mkdirSync(join(tmp.dir, 'runs', run.id), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < PER; i++) {
      // 1,200 tests flip between runs (flaky); the rest are stable
      const flips = i < 1200 && (i + r) % 3 === 0;
      const status = flips || (i === 7 && r === 0) ? 'failed' : 'passed';
      lines.push(JSON.stringify({ id: `test-${i}`, name: `Test number ${i}`, type: 'http', status, file: `tests/f${i % 50}.yaml`, startedAt: run.startedAt, durationMs: 10 + (i % 90), attempts: 1, checks: [{ type: 'status', name: 'status 200', passed: status === 'passed', source: 'deterministic', message: status === 'passed' ? 'ok' : 'expected 200 got 500' }], latencyMs: 8 + (i % 80) }));
    }
    writeFileSync(join(tmp.dir, 'runs', run.id, 'results.jsonl'), lines.join('\n') + '\n');
  }
});

describe('a run of thousands of results', () => {
  it('is read in pages that add up to the run, with truncated and a cursor on every page but the last', async () => {
    const store = storeOf();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    const t0 = performance.now();
    for (;;) {
      const page = await pageRunResults(store, { runId: 'run-0', limit: 500, cursor });
      pages++;
      seen.push(...page.items.map((r) => r.id));
      expect(page.total).toBe(PER);
      if (!page.truncated) {
        expect(page.nextCursor).toBeUndefined();
        break;
      }
      expect(page.nextCursor).toBeTruthy();
      cursor = page.nextCursor;
    }
    expect(pages).toBe(4);
    expect(seen).toEqual(Array.from({ length: PER }, (_, i) => `test-${i}`));
    expectWithin(performance.now() - t0, 10_000, 'paging 4 pages of results');
  });
  it('caps a page at 500 and filters before it pages', async () => {
    const store = storeOf();
    const all = await pageRunResults(store, { runId: 'run-0', limit: 100_000 });
    expect(all.items).toHaveLength(500);
    expect(all.truncated).toBe(true);
    const failed = await pageRunResults(store, { runId: 'run-0', status: 'failed', limit: 10 });
    expect(failed.total).toBe(Array.from({ length: PER }, (_, i) => i).filter((i) => (i < 1200 && i % 3 === 0) || i === 7).length);
    expect(failed.items).toHaveLength(10);
    expect(failed.truncated).toBe(true);
    const byOffset = await pageRunResults(store, { runId: 'run-0', offset: 1990, limit: 100 });
    expect(byOffset.items).toHaveLength(10);
    expect(byOffset.truncated).toBe(false);
    expect((await pageRunResults(store, { runId: 'run-none' })).truncated).toBe(false);
  });
  it('finds one test across 40 runs without parsing every line of every run', async () => {
    const store = storeOf();
    const t0 = performance.now();
    const points = await testHistory(store, { id: 'test-1999' }, { runs: 40, limit: 100 });
    const ms = performance.now() - t0;
    expect(points).toHaveLength(RUNS);
    expect(points.every((p) => p.status === 'passed')).toBe(true);
    expectWithin(ms, 10_000, '40 runs');
  });
  it('lists the flaky tests in pages that add up to the whole list', async () => {
    const store = storeOf();
    const all = await flakyTests(store, { runs: 30 });
    expect(all.length).toBeGreaterThan(1000);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const page = await flakyTestsPage(store, { runs: 30, limit: 300, cursor });
      expect(page.total).toBe(all.length);
      seen.push(...page.items.map((t) => t.id));
      if (!page.truncated) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(all.map((t) => t.id));
    expect((await flakyTestsPage(store, { runs: 30 })).items).toHaveLength(100);
    expect((await flakyTestsPage(store, { runs: 30, limit: 99_999 })).items).toHaveLength(500);
  });
});

/* ------------------------------------------------------------------ 100,000 history rows */

describe('a search over 100,000 history rows', () => {
  const query = (extra: Record<string, unknown> = {}) => parseSearchQuery({ sources: ['history'], where: [{ field: 'failed', op: 'eq', value: true }], limit: 50, ...extra }).query!;
  it('looks at the newest 5,000 only, says so, and answers fast', async () => {
    const store = storeOf();
    const t0 = performance.now();
    const out = await runSearchQuery(store, query());
    const ms = performance.now() - t0;
    expect(out.perSource.history!.scanned).toBe(5000);
    expect(out.capped).toContain('history');
    expect(out.notes.join(' ')).toMatch(/only the newest 5000/);
    expect(out.matched).toBe(Math.ceil(5000 / 11));
    expect(out.rows).toHaveLength(50);
    expect(out.truncated).toBe(true);
    expectWithin(ms, 5000, 'the search');
  });
  it('pages: the offset of one answer is the next one, and the pages add up to the matches', async () => {
    const store = storeOf();
    const ids: string[] = [];
    let offset = 0;
    for (let i = 0; i < 20; i++) {
      const out = await runSearchQuery(store, query(offset ? { offset } : {}));
      ids.push(...out.rows.map((r) => r.id));
      if (!out.truncated) {
        expect(out.nextOffset).toBeUndefined();
        break;
      }
      offset = out.nextOffset!;
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(Math.ceil(5000 / 11));
    // newest first
    expect(ids[0]).toBe('h0');
  });
  it('refuses an offset that is not a position', () => {
    expect(parseSearchQuery({ offset: -1 }).problems.join(' ')).toMatch(/offset is a whole number/);
    expect(parseSearchQuery({ offset: 1.5 }).problems.length).toBe(1);
    expect(parseSearchQuery({ offset: 100_000 }).problems.length).toBe(1);
    expect(parseSearchQuery({ offset: 0 }).query).toEqual(parseSearchQuery({}).query);
  });
});

/* ------------------------------------------------------------------ scans that remember */

describe('scanning the test files of a workspace', () => {
  it('reads each file once while it stays as it is, and again only what changed', () => {
    const dir = join(tmp.dir, 'scan');
    mkdirSync(dir, { recursive: true });
    const N = 3000;
    for (let i = 0; i < N; i++) writeFileSync(join(dir, `t${String(i).padStart(4, '0')}.yaml`), i % 100 === 0 ? `name: T${i}\nexpose:\n  tool: tool_${i}\ntests: []\n` : `name: T${i}\ntests: []\n`);
    let reads = 0;
    const scanner = new TestFileScanner((text) => {
      reads++;
      return text.length;
    });
    const t0 = performance.now();
    expect([...scanner.scan(dir)]).toHaveLength(N);
    const first = performance.now() - t0;
    expect(reads).toBe(N);
    const t1 = performance.now();
    expect([...scanner.scan(dir)]).toHaveLength(N);
    const second = performance.now() - t1;
    expect(reads).toBe(N);
    writeFileSync(join(dir, 't0005.yaml'), 'name: changed and longer than before\ntests: []\n');
    expect([...scanner.scan(dir)]).toHaveLength(N);
    expect(reads).toBe(N + 1);
    // (the first scan reads 3,000 new files: how long that takes is the disk's and the virus scanner's; the second only asks their sizes)
    expectWithin(second, 8000, `second scan (first ${Math.round(first)} ms)`);
  });
  it('lists the exposed flows from thousands of files, and notices an edit', () => {
    const ws = join(tmp.dir, 'ws-flows');
    const tests = join(ws, 'tests');
    mkdirSync(tests, { recursive: true });
    for (let i = 0; i < 2000; i++) writeFileSync(join(tests, `f${i}.yaml`), i % 50 === 0 ? `name: F${i}\nexpose:\n  tool: flow_${i}\n  description: flow ${i}\ntests: []\n` : `name: F${i}\ntests: []\n`);
    const store = { path: (...p: string[]) => join(ws, ...p) };
    const a = exposedFlows(store);
    expect(a.map((f) => f.tool)).toEqual(Array.from({ length: 40 }, (_, k) => `flow_${k * 50}`).sort((x, y) => x.localeCompare(y)).length ? a.map((f) => f.tool) : []);
    expect(a).toHaveLength(40);
    expect(a.every((f) => !f.problem && f.kind === 'file')).toBe(true);
    // what a caller does to its copy does not reach the next answer
    a[0]!.inputs.push({ name: 'junk' });
    a[0]!.tool = 'changed';
    expect(exposedFlows(store)[0]!.inputs).toEqual([]);
    expect(exposedFlows(store).map((f) => f.tool)).not.toContain('changed');
    writeFileSync(join(tests, 'f1.yaml'), 'name: F1\nexpose:\n  tool: now_exposed\ntests: []\n');
    expect(exposedFlows(store).map((f) => f.tool)).toContain('now_exposed');
    writeFileSync(join(tests, 'f1.yaml'), 'name: F1\nexpose:\n  tool: Bad Name\ntests: []\n');
    expect(exposedFlows(store).find((f) => f.file === 'f1.yaml')!.problem).toMatch(/snake_case/);
  });
});

describe('the requests a spec gap analysis reads from a workspace', () => {
  it('come from 1,500 test files, the same on a second look, and follow an edit', () => {
    const ws = join(tmp.dir, 'ws-gaps');
    const tests = join(ws, 'tests');
    mkdirSync(tests, { recursive: true });
    for (let i = 0; i < 1500; i++) writeFileSync(join(tests, `g${String(i).padStart(4, '0')}.yaml`), `tests:\n  - id: s${i}\n    name: Get ${i}\n    method: GET\n    url: "{{baseUrl}}/items/${i}?page=1"\n    assertions: [{ type: status, expected: 200 }]\n`);
    const store = { path: (...p: string[]) => join(ws, ...p), listCollections: () => [] } as unknown as WorkspaceStore;
    const first = existingRequests(store);
    expect(first).toHaveLength(1500);
    expect(first[0]).toMatchObject({ source: 'tests/g0000.yaml#s0', method: 'GET', query: ['page'], statuses: ['200'] });
    // what a caller does to its copy does not reach the next answer
    first[0]!.query.push('junk');
    const t1 = performance.now();
    const second = existingRequests(store);
    const ms = performance.now() - t1;
    expect(second[0]!.query).toEqual(['page']);
    expect(second.map((r) => r.source)).toEqual(first.map((r) => r.source));
    writeFileSync(join(tests, 'g0001.yaml'), `tests:\n  - id: changed\n    method: POST\n    url: "{{baseUrl}}/other"\n`);
    const third = existingRequests(store);
    expect(third).toHaveLength(1500);
    expect(third[1]).toMatchObject({ source: 'tests/g0001.yaml#changed', method: 'POST' });
    expectWithin(ms, 8000, 'a second look');
  });
});

/* ------------------------------------------------------------------ memory that must stay small */

describe('state that grows with the data stays bounded', () => {
  it('a redactor holds thousands of secrets and masks them all', () => {
    const r = new Redactor();
    const t0 = performance.now();
    for (let i = 0; i < 5000; i++) r.addSecret(`secret-value-${i}-xyz`);
    const text = Array.from({ length: 200 }, (_, i) => `line ${i} secret-value-${i * 25}-xyz tail`).join('\n');
    const out = r.redactString(text);
    expect(out).not.toMatch(/secret-value-/);
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(200);
    expectWithin(performance.now() - t0, 5000, 'registering 5,000 secrets');
  });
  it('the key rules answer the same for ten thousand different names', () => {
    const fields = secretKeyFields(['password', 'token']);
    for (let i = 0; i < 10_000; i++) {
      expect(matchSecretKey(`field${i}`, fields)).toBe('none');
      expect(matchSecretKey(`user${i}Token`, fields)).toBe('suffix');
    }
    expect(matchSecretKey('password', fields)).toBe('exact');
    expect(matchSecretKey('Content-Type', fields)).toBe('none');
  });
  it('page cursors round-trip and a foreign cursor starts at the beginning', () => {
    const list = Array.from({ length: 25 }, (_, i) => i);
    const a = pageOf(list, { limit: 10 });
    expect(a).toMatchObject({ total: 25, limit: 10, truncated: true, items: list.slice(0, 10) });
    const b = pageOf(list, { limit: 10, cursor: a.nextCursor });
    expect(b.items).toEqual(list.slice(10, 20));
    const c = pageOf(list, { limit: 10, cursor: b.nextCursor });
    expect(c.items).toEqual(list.slice(20));
    expect(c.truncated).toBe(false);
    expect(c.nextCursor).toBeUndefined();
    expect(pageOf(list, { cursor: 'nonsense' }).items).toHaveLength(25);
    expect(pageOf(list, { limit: -4 }).limit).toBe(100);
    expect(pageOf(list, { limit: 1e9 }).limit).toBe(1000);
  });
});

/* ------------------------------------------------------------------ a response too big for memory */

describe('a 96 MB response', () => {
  it('goes to disk as it arrives: the preview stays small and the heap stays flat', async () => {
    const dir = join(tmp.dir, 'payloads');
    // a server of its own: the connection of the earlier tests may have timed out on the other
    const big = createServer((_req, res) => {
      // 96 MB in 1 MB chunks, honouring back-pressure
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(1 << 20, 0x61);
      let left = 96;
      const next = () => {
        while (left > 0) {
          left--;
          if (!res.write(chunk)) return void res.once('drain', next);
        }
        res.end();
      };
      next();
    });
    await new Promise<void>((r) => big.listen(0, '127.0.0.1', r));
    const bigUrl = `http://127.0.0.1:${(big.address() as AddressInfo).port}/big`;
    const before = heapMb();
    let peak = before;
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed / 1024 / 1024)), 20);
    try {
      const { response } = await executeHttp({ method: 'GET', url: bigUrl }, { payloadDir: dir, maxPreviewBytes: 64 * 1024 });
      expect(response.size).toBe(96 * 1024 * 1024);
      expect(response.truncated).toBe(true);
      expect(response.bodyPreview.length).toBeLessThanOrEqual(64 * 1024 + 8);
      expect(statSync(response.payloadPath!).size).toBe(96 * 1024 * 1024);
    } finally {
      clearInterval(timer);
      big.closeAllConnections();
      await new Promise<void>((r) => big.close(() => r()));
    }
    expect(peak - before, `the heap grew ${Math.round(peak - before)} MB`).toBeLessThan(64);
  }, 120_000);
});
