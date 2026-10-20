import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitMarksOf } from '@testpion/shared';
import { gitChangesByItem, describeGitChanges, gitStatus, runGit } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

/**
 * The git-everything performance budget (planning/git-everything.md §4j, B-26b): a workspace of 9,000 items — requests in
 * collections, saved items in libraries, MCP servers — with a few hundred changed. Reading the changes by item (what the Git
 * view and `git status --by-item` show) must take under one second, and making the change marks from them under 100 ms. The
 * budget is the owner's; the median of three runs is held to it so one slow moment does not fail a build.
 */
const BUDGET_STATUS_MS = 1000;
const BUDGET_MARKS_MS = 100;

const t = tempDir('tp-git-perf-');
const ws = t.dir;
const git = (...args: string[]) => runGit(ws, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args]);

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const request = (c: number, i: number, url = `{{baseUrl}}/c${c}/r${i}`) => ({
  kind: 'http',
  id: `c${c}-r${i}`,
  name: `Request ${c}.${i}`,
  request: { method: 'GET', url, headers: [{ key: 'Accept', value: 'application/json', enabled: true }], params: [] },
  assertions: [{ type: 'status', operator: 'equals', value: 200 }],
});
const collection = (c: number, urlOf: (i: number) => string | undefined) => ({
  schemaVersion: '1.0',
  id: `c${c}`,
  name: `Collection ${c}`,
  variables: [],
  items: [{ kind: 'folder', id: `c${c}-f`, name: 'Requests', items: Array.from({ length: 200 }, (_, i) => request(c, i, urlOf(i))) }],
});

beforeAll(async () => {
  mkdirSync(join(ws, 'collections'), { recursive: true });
  mkdirSync(join(ws, 'library'), { recursive: true });
  writeFileSync(join(ws, 'workspace.json'), json({ schemaVersion: '1.0', id: 'ws', name: 'Perf', variables: [] }));
  // 30 collections x 200 requests = 6,000; 2,500 saved prompts; 500 MCP servers = 9,000 items
  for (let c = 0; c < 30; c++) writeFileSync(join(ws, 'collections', `c${c}.json`), json(collection(c, () => undefined)));
  writeFileSync(
    join(ws, 'library', 'ai-prompts.json'),
    json({ schemaVersion: '1.0', folders: [], items: Array.from({ length: 2500 }, (_, i) => ({ id: `p${i}`, name: `Prompt ${i}`, data: { prompt: `Say ${i}`, model: 'demo' } })) }),
  );
  writeFileSync(
    join(ws, 'mcp-servers.json'),
    json({ schemaVersion: '1.0', servers: Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, name: `Server ${i}`, transport: 'http', url: `https://s${i}.example.com/v1` })) }),
  );
  await runGit(ws, ['init', '-q', '-b', 'main']);
  await git('add', '-A', '.');
  await git('commit', '-q', '-m', 'nine thousand items');
  // ~300 changes: 100 requests in 10 collections, 150 prompts, 50 servers
  for (let c = 0; c < 10; c++) writeFileSync(join(ws, 'collections', `c${c}.json`), json(collection(c, (i) => (i % 2 === 0 && i < 20 ? `{{baseUrl}}/changed/${i}` : undefined))));
  const prompts = JSON.parse(
    JSON.stringify({
      schemaVersion: '1.0',
      folders: [],
      items: Array.from({ length: 2500 }, (_, i) => ({ id: `p${i}`, name: `Prompt ${i}`, data: { prompt: i < 150 ? `Say it again ${i}` : `Say ${i}`, model: 'demo' } })),
    }),
  );
  writeFileSync(join(ws, 'library', 'ai-prompts.json'), json(prompts));
  writeFileSync(
    join(ws, 'mcp-servers.json'),
    json({ schemaVersion: '1.0', servers: Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, name: `Server ${i}`, transport: 'http', url: `https://s${i}.example.com/${i < 50 ? 'v2' : 'v1'}` })) }),
  );
});
afterAll(() => t.cleanup());

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
async function time<T>(fn: () => Promise<T> | T, runs = 3): Promise<{ ms: number; value: T }> {
  const times: number[] = [];
  let value!: T;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    value = await fn();
    times.push(performance.now() - t0);
  }
  return { ms: median(times), value };
}

describe(`git by item at 9,000 items (status < ${BUDGET_STATUS_MS} ms, marks < ${BUDGET_MARKS_MS} ms)`, () => {
  it('reads the changes of 12 changed files item by item within the budget', async () => {
    const { ms, value } = await time(() => gitChangesByItem(ws));
    // 100 requests, 150 prompts, 50 servers
    expect(value.items.length).toBe(300);
    console.log(`git status by item: ${ms.toFixed(0)} ms for ${value.items.length} changed items of 9,000`);
    expect(ms, `status by item took ${ms.toFixed(0)} ms`).toBeLessThan(BUDGET_STATUS_MS);
  });

  it('makes the change marks from them within the budget', async () => {
    const st = await gitStatus(ws);
    const changes = await describeGitChanges(ws, st.files);
    const { ms, value } = await time(() => gitMarksOf(changes), 5);
    expect(value.size).toBeGreaterThan(300);
    console.log(`change marks: ${ms.toFixed(1)} ms for ${changes.length} changes (${value.size} marks)`);
    expect(ms, `marks took ${ms.toFixed(1)} ms`).toBeLessThan(BUDGET_MARKS_MS);
  });
});
