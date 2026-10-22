import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestPionMcpServer, EnvSecretStore, WorkspaceManager, WorkspaceStore } from '../../packages/core/src/index.js';
import { runCli, tempDir } from '../helpers.js';

/**
 * The paging contract of the lists, over the CLI (`--limit`, `--cursor`, `--json`: data + the envelope's `page`) and over
 * MCP (`limit`, `cursor`, `truncated`, `nextCursor`): a list of 2,500 comes out in pages, every item exactly once.
 */
const N = 2500;
const tmp = tempDir('tp-paging-');
let ws: string;
let home: string;
let client: Client;
let store: WorkspaceStore;

const cli = (args: string[]) => runCli(args, { home });
const pad = (i: number) => String(i).padStart(5, '0');

beforeAll(async () => {
  home = join(tmp.dir, 'home');
  ws = join(tmp.dir, 'ws');
  store = WorkspaceStore.create(ws, 'Paging');
  const base = Date.parse('2026-10-01T00:00:00.000Z');
  for (let i = 0; i < N; i++)
    store.meta.addHistory({ id: `h${pad(i)}`, timestamp: new Date(base + i * 1000).toISOString(), kind: 'http', name: `req ${pad(i)}`, method: 'GET', url: `http://127.0.0.1/${pad(i)}`, status: 200, durationMs: 5, size: 4 } as never);
  // a run with 2,500 results, and three runs in which every one of 2,500 tests flips (flaky)
  const result = (i: number, status: string) => JSON.stringify({ id: `t${pad(i)}`, name: `test ${pad(i)}`, type: 'http', status, startedAt: '2026-10-01T00:00:00.000Z', durationMs: 5, attempts: 1, checks: [], latencyMs: 5 });
  const run = (id: string, at: string, status: (i: number) => string) => {
    mkdirSync(store.runDir(id), { recursive: true });
    writeFileSync(join(store.runDir(id), 'results.jsonl'), Array.from({ length: N }, (_, i) => result(i, status(i))).join('\n') + '\n');
    store.meta.addRun({ runId: id, name: id, startedAt: at, durationMs: 5, total: N, passed: 0, failed: 0, skipped: 0, errors: 0 } as never, store.runDir(id));
  };
  run('run-a', '2026-10-01T01:00:00.000Z', () => 'passed');
  run('run-b', '2026-10-01T02:00:00.000Z', () => 'failed');
  run('run-c', '2026-10-01T03:00:00.000Z', () => 'passed');
  mkdirSync(join(ws, 'datasets'), { recursive: true });
  writeFileSync(join(ws, 'datasets', 'big.jsonl'), Array.from({ length: N }, (_, i) => JSON.stringify({ n: pad(i) })).join('\n') + '\n');
  store.saveCollection({ id: 'big', name: 'Big', items: Array.from({ length: N }, (_, i) => ({ kind: 'http', id: `r${pad(i)}`, name: `request ${pad(i)}`, request: { method: 'GET', url: `http://127.0.0.1/${pad(i)}` } })) } as never);
  store.close();

  const mgr = new WorkspaceManager(home);
  store = mgr.open(ws);
  const server = createTestPionMcpServer({ store, secrets: new EnvSecretStore(), settings: mgr.loadSettings() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
}, 120_000);
afterAll(async () => {
  await client.close();
  store.close();
  tmp.cleanup();
});

interface Page {
  ids: string[];
  next?: string;
  truncated?: boolean;
}

/** Walks a list page by page until it ends; returns every id in order and the number of pages. */
async function walk(fetchPage: (cursor?: string) => Promise<Page>): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const p = await fetchPage(cursor);
    pages++;
    ids.push(...p.ids);
    // `truncated` and the cursor always agree
    if (p.truncated !== undefined) expect(p.truncated).toBe(!!p.next);
    cursor = p.next;
    expect(pages).toBeLessThan(100);
  } while (cursor);
  return { ids, pages };
}

const everyOnce = (r: { ids: string[]; pages: number }, expected: number, pages?: number) => {
  expect(r.ids).toHaveLength(expected);
  expect(new Set(r.ids).size).toBe(expected);
  if (pages) expect(r.pages).toBe(pages);
};

/** One CLI call with --json: the data, and the envelope's page. */
async function cliPage<T>(args: string[], cursor?: string): Promise<{ data: T; page?: { total: number; limit: number; truncated: boolean; nextCursor?: string }; warnings: string[]; status: number | null }> {
  const r = await cli([...args, ...(cursor ? ['--cursor', cursor] : []), '--json']);
  const env = JSON.parse(r.out) as { data: T; page?: { total: number; limit: number; truncated: boolean; nextCursor?: string }; warnings: string[] };
  return { ...env, status: r.status };
}

/** One MCP call: the structured result. */
async function mcp(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  return r;
}
const structured = (r: Awaited<ReturnType<typeof mcp>>) => r.structuredContent as Record<string, any>;

describe('CLI paging', () => {
  it('history list: pages of 500 by --cursor, every entry once; the data stays the plain list', async () => {
    const r = await walk(async (c) => {
      const p = await cliPage<Array<{ id: string }>>(['history', 'list', '-w', ws, '-n', '500'], c);
      expect(Array.isArray(p.data)).toBe(true);
      return { ids: p.data.map((h) => h.id), next: p.page?.nextCursor, truncated: p.page?.truncated };
    });
    everyOnce(r, N, 5);
  });

  it('a cut list says so (the hint line, the envelope page); the last page does not', async () => {
    const p = await cliPage<unknown[]>(['history', 'list', '-w', ws, '-n', '20']);
    expect(p.data).toHaveLength(20);
    // 20 of 2,500 is a cut list: it says so
    expect(p.page).toMatchObject({ total: N, limit: 20, truncated: true });
    const text = await cli(['history', 'list', '-w', ws, '-n', '3']);
    expect(text.out + text.err).toMatch(/3 of 2500 entries shown; more: --cursor o3/);
    const small = await cliPage<unknown[]>(['history', 'list', '-w', ws, '-n', '500', '--offset', '2400']);
    expect(small.data).toHaveLength(100);
    expect(small.page).toMatchObject({ truncated: false });
    expect(small.page?.nextCursor).toBeUndefined();
  });

  it('history flaky: pages of 500 (default 100), exit 1 while there are flaky tests', async () => {
    const first = await cliPage<unknown[]>(['history', 'flaky', '-w', ws]);
    expect(first.data).toHaveLength(100);
    expect(first.status).toBe(1);
    expect(first.page).toMatchObject({ total: N, limit: 100, truncated: true });
    expect(first.warnings.join(' ')).toMatch(/more: --cursor/);
    const r = await walk(async (c) => {
      const p = await cliPage<Array<{ id: string }>>(['history', 'flaky', '-w', ws, '-l', '1000'], c);
      return { ids: p.data.map((t) => t.id), next: p.page?.nextCursor, truncated: p.page?.truncated };
    });
    everyOnce(r, N, 5);
  });

  it('history results: the results of a run, pages of 500 and a filter', async () => {
    const r = await walk(async (c) => {
      const p = await cliPage<Array<{ id: string }>>(['history', 'results', 'run-a', '-w', ws, '-n', '1000'], c);
      return { ids: p.data.map((t) => t.id), next: p.page?.nextCursor, truncated: p.page?.truncated };
    });
    everyOnce(r, N, 5);
    const failed = await cliPage<Array<{ id: string; status: string }>>(['history', 'results', 'run-b', '-w', ws, '--status', 'failed', '-n', '5']);
    expect(failed.data.map((t) => t.status)).toEqual(Array(5).fill('failed'));
    expect(failed.page).toMatchObject({ total: N, truncated: true });
    const none = await cliPage<unknown[]>(['history', 'results', 'run-a', '-w', ws, '--status', 'failed']);
    expect(none.data).toEqual([]);
  });

  it('search --query-json: pages of 200 by --cursor', async () => {
    const r = await walk(async (c) => {
      const p = await cliPage<{ outcome: { rows: Array<{ id: string }>; truncated: boolean; nextCursor?: string } }>(['search', '-w', ws, '--query-json', '{"sources":["history"]}', '-n', '200'], c);
      expect(p.data.outcome.truncated).toBe(!!p.data.outcome.nextCursor);
      return { ids: p.data.outcome.rows.map((x) => x.id), next: p.data.outcome.nextCursor, truncated: p.page?.truncated };
    });
    everyOnce(r, N, 13);
  });

  it('search --ask without a model: the words as typed, paged by --offset', async () => {
    const a = await cliPage<{ mode: string; outcome: { rows: Array<{ id: string }>; nextOffset?: number } }>(['search', '-w', ws, '--ask', 'req', '--no-ai', '--in', 'history', '-n', '10']);
    expect(a.data.mode).toBe('text');
    expect(a.data.outcome.rows).toHaveLength(10);
    expect(a.data.outcome.nextOffset).toBe(10);
    const b = await cliPage<{ outcome: { rows: Array<{ id: string }> } }>(['search', '-w', ws, '--ask', 'req', '--no-ai', '--in', 'history', '-n', '10', '--offset', '10']);
    expect(b.data.outcome.rows.map((x) => x.id)).not.toEqual(a.data.outcome.rows.map((x) => x.id));
  });

  it('search (plain words) pages too', async () => {
    const p = await cliPage<unknown[]>(['search', 'big', '-w', ws, '-n', '1']);
    expect(p.data).toHaveLength(1);
    expect(p.page).toMatchObject({ truncated: true });
    const next = await cliPage<Array<{ id: string }>>(['search', 'big', '-w', ws, '-n', '1'], p.page!.nextCursor);
    expect(next.data).toHaveLength(1);
  });

  it('datasets show: pages of rows by --cursor', async () => {
    const r = await walk(async (c) => {
      const p = await cliPage<{ rows: Array<{ n: string }>; truncated: boolean; nextCursor?: string }>(['datasets', 'show', 'big.jsonl', '-w', ws, '-n', '1000'], c);
      return { ids: p.data.rows.map((x) => x.n), next: p.data.nextCursor, truncated: p.data.truncated };
    });
    everyOnce(r, N, 3);
  });

  it('requests of a collection: 100 unless asked, then pages', async () => {
    const first = await cliPage<unknown[]>(['requests', 'Big', '-w', ws]);
    expect(first.data).toHaveLength(100);
    expect(first.page).toMatchObject({ total: N, limit: 100, truncated: true });
    const r = await walk(async (c) => {
      const p = await cliPage<Array<{ id: string }>>(['requests', 'Big', '-w', ws, '-n', '1000'], c);
      return { ids: p.data.map((x) => x.id), next: p.page?.nextCursor, truncated: p.page?.truncated };
    });
    everyOnce(r, N, 5);
  });
});

describe('MCP paging', () => {
  it('history_list: pages of 500 by cursor (the tool pages itself, past any maximum of its own)', async () => {
    const r = await walk(async (c) => {
      const s = structured(await mcp('history_list', { limit: 500, ...(c ? { cursor: c } : {}) }));
      return { ids: (s.items as Array<{ id: string }>).map((h) => h.id), next: s.nextCursor, truncated: s.truncated };
    });
    everyOnce(r, N, 5);
  });

  it('flaky_tests: truncated and nextCursor, every test once', async () => {
    const r = await walk(async (c) => {
      const s = structured(await mcp('flaky_tests', { limit: 500, ...(c ? { cursor: c } : {}) }));
      return { ids: (s.items as Array<{ id: string }>).map((t) => t.id), next: s.nextCursor, truncated: s.truncated };
    });
    everyOnce(r, N, 5);
  });

  it('run_results: the results of a run, a page at a time', async () => {
    const r = await walk(async (c) => {
      const s = structured(await mcp('run_results', { run_id: 'run-a', limit: 500, ...(c ? { cursor: c } : {}) }));
      expect(s.total).toBe(N);
      return { ids: (s.items as Array<{ id: string }>).map((t) => t.id), next: s.nextCursor, truncated: s.truncated };
    });
    everyOnce(r, N, 5);
    const failed = structured(await mcp('run_results', { run_id: 'run-b', status: 'failed', limit: 3 }));
    expect(failed.items.map((t: { status: string }) => t.status)).toEqual(['failed', 'failed', 'failed']);
    expect(failed.truncated).toBe(true);
  });

  it('search_ask: a query and a question, paged by cursor and by offset', async () => {
    const r = await walk(async (c) => {
      const s = structured(await mcp('search_ask', { query: { sources: ['history'] }, limit: 200, ...(c ? { cursor: c } : {}) }));
      const o = s.outcome as { rows: Array<{ id: string }>; truncated: boolean; nextCursor?: string };
      return { ids: o.rows.map((x) => x.id), next: o.nextCursor, truncated: o.truncated };
    });
    everyOnce(r, N, 13);
    const a = structured(await mcp('search_ask', { question: 'req', noAi: true, sources: 'history', limit: 7 }));
    const b = structured(await mcp('search_ask', { question: 'req', noAi: true, sources: 'history', limit: 7, offset: 7 }));
    expect(a.outcome.rows).toHaveLength(7);
    expect(a.outcome.nextOffset).toBe(7);
    expect(b.outcome.rows.map((x: { id: string }) => x.id)).not.toEqual(a.outcome.rows.map((x: { id: string }) => x.id));
  });

  it('search_workspace: a page, then the next', async () => {
    const a = structured(await mcp('search_workspace', { query: 'big', limit: 1 }));
    expect(a.items).toHaveLength(1);
    expect(a.truncated).toBe(true);
    const b = structured(await mcp('search_workspace', { query: 'big', limit: 1, cursor: a.nextCursor }));
    expect(b.items).toHaveLength(1);
    expect(b.items[0].id).not.toBe(a.items[0].id);
  });

  it('read_dataset: rows by cursor', async () => {
    const r = await walk(async (c) => {
      const s = structured(await mcp('read_dataset', { name: 'big.jsonl', limit: 500, response_format: 'detailed', ...(c ? { cursor: c } : {}) }));
      return { ids: (s.rows as Array<{ n: string }>).map((x) => x.n), next: s.nextCursor, truncated: s.truncated };
    });
    everyOnce(r, N, 5);
  });

  it('list_requests of a collection of 2,500 requests: pages of 500', async () => {
    const r = await walk(async (c) => {
      const s = structured(await mcp('list_requests', { collection: 'Big', limit: 500, response_format: 'detailed', ...(c ? { cursor: c } : {}) }));
      return { ids: (s.items as Array<{ id: string }>).map((x) => x.id), next: s.nextCursor, truncated: s.truncated };
    });
    everyOnce(r, N, 5);
  });
});
