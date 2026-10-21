import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Redactor, WorkspaceStore, collectBuilt, gitVersion, outputSourceFor, prepareSource, saveMonitor, storeOutputDeps, writeChunks } from '../../packages/core/src/index.js';
import { outputTools } from '../../packages/core/src/mcp-server/tools/output-tools.js';
import { OUTPUT_SURFACES } from '../../packages/shared/src/index.js';
import { tempDir } from '../helpers.js';

// The output builders in core (packages/core/src/output): what the window, `testpion output` and MCP `save_output` all
// write. A workspace alone gives the deps; the console, the Debugger session and a running data run are the app's.
const tmp = tempDir('tp-output-core-');
let store: WorkspaceStore;
const redactor = new Redactor();
const deps = () => storeOutputDeps(store, redactor);
const build = async (surface: string, format: string, source: Parameters<typeof prepareSource>[1]['source']) => {
  const r = await prepareSource(deps(), { surface, format, source }, new AbortController().signal);
  return (await collectBuilt(r.built, 10_000_000)).bytes.toString('utf8');
};

beforeAll(() => {
  store = WorkspaceStore.create(join(tmp.dir, 'ws'), 'Out');
  const h = (id: string, ts: string, status: number | string, extra: Record<string, unknown> = {}) =>
    store.meta.addHistory({ id, timestamp: ts, kind: 'http', name: `req ${id}`, method: 'GET', url: `http://127.0.0.1/${id}`, status, durationMs: 12, size: 5, ...extra } as never);
  h('h1', '2026-10-18T10:00:00.000Z', 200);
  h('h2', '2026-10-18T11:00:00.000Z', 500, { url: 'http://127.0.0.1/x?api_key=sk-LEAK-0123456789abcdef' });
  store.meta.addRun(
    { runId: 'run-a', name: 'Smoke', startedAt: '2026-10-18T09:00:00.000Z', durationMs: 5, total: 3, passed: 2, failed: 1, skipped: 0, errors: 0 } as never,
    store.path('runs', 'run-a'),
  );
  store.saveTrace({ traceId: 'a'.repeat(32), name: 'GET /pets', startTime: Date.now(), endTime: Date.now() + 5, status: 'ok', spans: [] }, 'http');
  mkdirSync(store.path('tests'), { recursive: true });
  writeFileSync(store.path('tests', 'm.yaml'), 'name: m\nsteps: []\n');
  saveMonitor(store, { id: 'mon1', name: 'Smoke monitor', testFile: 'm.yaml', everyMinutes: 15, enabled: true });
  mkdirSync(store.path('runs', 'monitors'), { recursive: true });
  const r = (i: number, status: string) =>
    JSON.stringify({ monitorId: 'mon1', runId: `r${i}`, startedAt: `2026-10-18T0${i}:00:00.000Z`, durationMs: 100 * i, status, total: 2, passed: 2, failed: 0, errors: 0, p95Ms: 40 });
  writeFileSync(store.path('runs', 'monitors', 'mon1.jsonl'), [r(1, 'passed'), r(2, 'failed')].join('\n') + '\n');
});
afterAll(() => {
  store.close();
  tmp.cleanup();
});

describe('list sources', () => {
  it('History: CSV, JSON and HAR from the same entries, URLs masked, newest first', async () => {
    const csv = await build('history', 'csv', { kind: 'history' });
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('time,kind,name,method,url,status,durationMs,size');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('h2');
    expect(csv).not.toContain('sk-LEAK');
    const json = JSON.parse(await build('history', 'json', { kind: 'history', failed: true }));
    expect(json.map((x: { name: string }) => x.name)).toEqual(['req h2']);
    const har = JSON.parse(await build('history', 'har', { kind: 'history', query: 'h1' }));
    expect(har.log.entries.map((e: { request: { url: string } }) => e.request.url)).toEqual(['http://127.0.0.1/h1']);
  });

  it('Runs overview, traces (OTLP), a monitor’s runs', async () => {
    const runs = await build('runs.overview', 'csv', { kind: 'runs-overview' });
    expect(runs.split('\r\n')[1]).toMatch(/^run-a,Smoke,2026-10-18T09:00:00.000Z,5,3,2,1,0,0,/);
    const otlp = JSON.parse(await build('traces', 'json', { kind: 'traces' }));
    expect(otlp.resourceSpans).toBeDefined();
    const mon = JSON.parse(await build('monitor.runs', 'json', { kind: 'monitor-runs', monitor: 'Smoke monitor' }));
    expect(mon.map((x: { runId: string }) => x.runId)).toEqual(['r2', 'r1']);
    expect((await build('monitor.runs', 'csv', { kind: 'monitor-runs', monitor: 'mon1', limit: 1 })).split('\r\n')).toHaveLength(3);
    await expect(build('monitor.runs', 'csv', { kind: 'monitor-runs', monitor: 'nope' })).rejects.toThrow(/No monitor "nope"/);
  });

  it('the workspace report is one HTML page with no script, and traces can be filtered by kind', async () => {
    const html = await build('workspace.report', 'html', { kind: 'workspace-report', days: 7 });
    expect(html.trimStart().toLowerCase().startsWith('<!doctype html')).toBe(true);
    expect(html).not.toMatch(/<script/i);
    const none = JSON.parse(await build('traces', 'json', { kind: 'traces', traceKind: 'llm' }));
    expect(JSON.stringify(none.resourceSpans ?? [])).not.toContain('GET /pets');
  });

  it('the workspace changes as a patch and as Markdown', async () => {
    if (!(await gitVersion())) return;
    const root = store.root;
    const git = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'one');
    writeFileSync(store.path('tests', 'm.yaml'), 'name: changed\nsteps: []\n');
    const patch = await build('git.diff', 'diff', { kind: 'git-diff', path: 'tests/m.yaml' });
    expect(patch).toContain('-name: m');
    expect(patch).toContain('+name: changed');
    expect(await build('git.diff', 'md', { kind: 'git-diff' })).toBeTypeOf('string');
  });
});

describe('the policy is the registry’s', () => {
  it('a source is accepted only for a surface that names it, and every source kind of the registry is built', async () => {
    await expect(prepareSource(deps(), { surface: 'response.headers', format: 'json', source: { kind: 'history' } }, new AbortController().signal)).rejects.toThrow(/unknown source history/);
    await expect(prepareSource(deps(), { surface: 'history', format: 'zip', source: { kind: 'history' } }, new AbortController().signal)).rejects.toThrow(/cannot be saved as zip/);
    const kinds = new Set(OUTPUT_SURFACES.flatMap((s) => s.sources ?? []));
    expect([...kinds].sort()).toEqual([
      'console',
      'debugger',
      'flow-timeline',
      'git-diff',
      'grid',
      'history',
      'logs',
      'monitor-runs',
      'rag-calibration',
      'rag-matrix',
      'response',
      'run',
      'runs-overview',
      'traces',
      'workspace-report',
    ]);
  });

  it('the app’s console and Debugger session are the app’s: a workspace alone says so', async () => {
    await expect(build('console', 'text', { kind: 'console' })).rejects.toThrow(/only exists in the running TestPion app/);
    await expect(build('debugger.session', 'har', { kind: 'debugger' })).rejects.toThrow(/Debugger/);
  });

  it('masks a secret in a redacted surface unless it is masked at capture; the host’s console is built from its deps', async () => {
    const secret = new Redactor();
    const d = {
      ...storeOutputDeps(store, secret),
      consoleEntries: () => [{ time: 't', method: 'GET', url: 'http://x/?a=1', status: 200, logs: [{ phase: 'test', message: 'Bearer abc123def456ghi789jkl' }] }],
    };
    const r = await prepareSource(d, { surface: 'console', format: 'text', source: { kind: 'console' } }, new AbortController().signal);
    const text = (await collectBuilt(r.built, 1e6)).bytes.toString('utf8');
    expect(text).toContain('GET http://x/?a=1 200');
    expect(text).not.toContain('abc123def456ghi789jkl');
  });
});

describe('parameters', () => {
  it('say what is missing, and refuse what only the app holds', () => {
    expect(() => outputSourceFor(store, 'run.results', 'csv', {})).toThrow(/run.results needs run/);
    expect(() => outputSourceFor(store, 'console', 'text', {})).toThrow(/only the app holds its content/);
    expect(() => outputSourceFor(store, 'nope', 'text', {})).toThrow(/unknown surface/);
    expect(outputSourceFor(store, 'eval.matrix', 'csv', { runs: ['a', 'b'], baseline: 'c' })).toEqual({ kind: 'grid', grid: 'eval-matrix', params: { runs: ['a', 'b'], baseline: 'c' } });
    expect(() => outputSourceFor(store, 'response.body', 'raw', { historyId: 'h1' })).toThrow(/no saved response body/);
  });
});

describe('save_output (MCP)', () => {
  const tool = () => outputTools({ store, redactor })[0]!;
  const call = (a: Record<string, unknown>) => tool().run(a) as Promise<Record<string, any>>;

  it('returns the text inline and the same bytes as the builder', async () => {
    const r = await call({ surface: 'runs.overview', format: 'csv' });
    expect(r.text).toBe(await build('runs.overview', 'csv', { kind: 'runs-overview' }));
    expect(r.redacted).toBe(false);
  });

  it('cuts big output inline and says to use save_to; save_to writes a new file inside the workspace only', async () => {
    const big = await call({ surface: 'history', format: 'json', limit: 1 });
    expect(big.truncated).toBeUndefined();
    const r = await call({ surface: 'history', format: 'csv', save_to: 'exports/h.csv' });
    expect(r.saved).toBe('exports/h.csv');
    expect(readFileSync(join(store.root, 'exports', 'h.csv'), 'utf8')).toContain('time,kind,name');
    await expect(call({ surface: 'history', format: 'csv', save_to: 'exports/h.csv' })).rejects.toThrow(/already exists/);
    // an allow-list: exports/ and .local/exports/ only (a definition folder, a hidden tooling folder, a top-level file are all refused)
    await expect(call({ surface: 'history', format: 'csv', save_to: 'collections/x.csv' })).rejects.toThrow(/only go under exports/);
    await expect(call({ surface: 'history', format: 'csv', save_to: 'Collections/x.csv' })).rejects.toThrow(/not allowed/);
    for (const bad of ['.husky/pre-commit', '.vscode/tasks.json', 'Makefile', 'package.json', 'metrics/evil.yaml', '.gitattributes', 'exports/.hidden/x.csv', 'exports/x.', '.local/trust.json', '.local/x.csv', 'exports'])
      await expect(call({ surface: 'history', format: 'csv', save_to: bad }), bad).rejects.toThrow(/not allowed/);
    await expect(call({ surface: 'history', format: 'csv', save_to: '../out.csv' })).rejects.toThrow(/escapes the workspace/);
    await expect(call({ surface: 'history', format: 'csv', save_to: 'exports/run.bat' })).rejects.toThrow(/a bat file is a program/);
    expect((await call({ surface: 'history', format: 'csv', save_to: '.local/exports/h.csv' })).saved).toBe('.local/exports/h.csv');
    expect(existsSync(join(store.root, '.husky'))).toBe(false);
    expect(existsSync(join(store.root, 'Makefile'))).toBe(false);
    expect(existsSync(join(store.root, 'exports', 'run.bat'))).toBe(false);
  });

  it('refuses a surface or format it does not have, and has no way to include secrets', async () => {
    await expect(call({ surface: 'console' })).rejects.toThrow(/cannot be saved with save_output/);
    await expect(call({ surface: 'history', format: 'zip' })).rejects.toThrow(/cannot be saved as zip/);
    expect(Object.keys(tool().inputSchema.properties)).not.toContain('include_secrets');
  });

  it('a binary format comes back as base64', async () => {
    const dir = store.path('runs', 'run-a');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.html'), '<html>x</html>');
    writeFileSync(join(dir, 'results.jsonl'), '');
    const r = await call({ surface: 'run.results', format: 'zip', run: 'run-a' });
    expect(r.encoding).toBe('base64');
    expect(Buffer.from(r.base64, 'base64').subarray(0, 2).toString()).toBe('PK');
  });
});

describe('writeChunks', () => {
  it('writes through .part and leaves nothing behind when cancelled', async () => {
    const ac = new AbortController();
    async function* chunks() {
      yield 'a';
      ac.abort();
      yield 'b';
    }
    const dest = join(tmp.dir, 'w.txt');
    await expect(writeChunks(chunks(), dest, { signal: ac.signal })).rejects.toThrow(/cancelled/);
    expect(existsSync(dest) || existsSync(`${dest}.part`)).toBe(false);
    await writeChunks(chunks2(), dest);
    expect(readFileSync(dest, 'utf8')).toBe('ok');
  });
});
async function* chunks2() {
  yield 'o';
  yield Buffer.from('k');
}
