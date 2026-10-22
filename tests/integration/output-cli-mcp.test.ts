import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpSession, Redactor, WorkspaceStore, collectBuilt, mcpResultBody, prepareSource, storeOutputDeps } from '../../packages/core/src/index.js';
import { cliData, cliPath, runCli, tempDir } from '../helpers.js';

/**
 * `testpion output`, `--out` / `--format` on the commands that print results, and MCP `save_output` write the bytes the
 * window's down arrow writes (core's builders): the same History, the same run list, whichever way it is asked for.
 */
const tmp = tempDir('tp-output-cli-');
let ws: string;
let home: string;
let server: Server;
let base: string;

const cli = (args: string[]) => runCli(args, { home });
const builder = async (surface: string, format: string, source: Parameters<typeof prepareSource>[1]['source']) => {
  const store = WorkspaceStore.open(ws);
  try {
    const r = await prepareSource(storeOutputDeps(store, new Redactor()), { surface, format, source }, new AbortController().signal);
    return (await collectBuilt(r.built, 1e8)).bytes;
  } finally {
    store.close();
  }
};

beforeAll(async () => {
  home = join(tmp.dir, 'home');
  ws = join(tmp.dir, 'ws');
  const store = WorkspaceStore.create(ws, 'Out');
  const h = (id: string, ts: string, status: number) =>
    store.meta.addHistory({
      id,
      timestamp: ts,
      kind: 'http',
      name: `req ${id}`,
      method: 'GET',
      url: `http://127.0.0.1/${id}?api_key=sk-LEAK-0123456789abcdef`,
      status,
      durationMs: 10,
      size: 4,
    } as never);
  h('h1', '2026-10-18T10:00:00.000Z', 200);
  h('h2', '2026-10-18T11:00:00.000Z', 500);
  store.meta.addRun(
    { runId: 'run-a', name: 'Smoke', startedAt: '2026-10-18T09:00:00.000Z', durationMs: 5, total: 3, passed: 2, failed: 1, skipped: 0, errors: 0 } as never,
    store.path('runs', 'run-a'),
  );
  store.close();
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"b":[1,2],"a":{"x":true}}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  tmp.cleanup();
});

describe('testpion output', () => {
  it('lists what it can save, with formats and parameters', async () => {
    const r = await cli(['output', '--list', '--json']);
    const list = cliData(r.out) as Array<{ surface: string; formats: string[]; params: Array<{ option: string; mcp: string }> }>;
    expect(list.map((x) => x.surface)).toEqual(expect.arrayContaining(['run.results', 'history', 'traces', 'monitor.runs', 'runs.overview', 'git.diff', 'eval.matrix', 'workspace.report']));
    expect(list.find((x) => x.surface === 'flow.grid')!.params.map((p) => p.option)).toEqual(['--data-run', '--status']);
  });

  it('writes History as the same bytes the window saves, format from the file name or --format', async () => {
    const out = join(tmp.dir, 'out', 'h.csv');
    const r = await cli(['output', 'history', '-w', ws, '--out', out, '--json']);
    expect(r.status, r.err).toBe(0);
    const saved = cliData(r.out) as { format: string; path: string; bytes: number };
    expect(saved).toMatchObject({ format: 'csv', path: out });
    const bytes = readFileSync(out);
    expect(bytes.equals(await builder('history', 'csv', { kind: 'history' }))).toBe(true);
    expect(bytes.toString('utf8')).not.toContain('sk-LEAK');
    expect(saved.bytes).toBe(bytes.length);
    const har = join(tmp.dir, 'out', 'h.json');
    await cli(['output', 'history', '-w', ws, '--format', 'har', '--out', har]);
    expect(JSON.parse(readFileSync(har, 'utf8')).log.version).toBe('1.2');
  });

  it('history list --out, runs and the other commands with --out go through the same writer', async () => {
    const a = join(tmp.dir, 'out', 'list.json');
    const r = await cli(['history', 'list', '-w', ws, '--failed', '--out', a]);
    expect(r.status, r.err).toBe(0);
    expect(JSON.parse(readFileSync(a, 'utf8')).map((x: { name: string }) => x.name)).toEqual(['req h2']);
    const b = join(tmp.dir, 'out', 'runs.csv');
    expect((await cli(['output', 'runs.overview', '-w', ws, '--out', b])).status).toBe(0);
    expect(readFileSync(b, 'utf8').split('\r\n')[1]).toMatch(/^run-a,Smoke,/);
  });

  it('refuses what is wrong with a hint and leaves no file', async () => {
    const f = join(tmp.dir, 'out', 'nope.csv');
    const missing = await cli(['output', 'run.results', '-w', ws, '--out', f]);
    expect(missing.status).toBe(2);
    expect(missing.err).toMatch(/run.results needs run/);
    expect((await cli(['output', 'console', '-w', ws, '--out', f])).err).toMatch(/cannot be saved with this command/);
    expect((await cli(['output', 'history', '-w', ws, '--format', 'zip', '--out', f])).err).toMatch(/cannot be saved as zip/);
    expect((await cli(['output', 'history', '-w', ws, '--json'])).status).toBe(2);
    expect(existsSync(f)).toBe(false);
  });

  it('send --out writes the response body: raw, laid out or minified', async () => {
    const raw = join(tmp.dir, 'out', 'body.json');
    const r = await cli(['send', `${base}/x`, '-w', ws, '--out', raw]);
    expect(r.status, r.err).toBe(0);
    expect(readFileSync(raw, 'utf8')).toBe('{"b":[1,2],"a":{"x":true}}');
    const pretty = join(tmp.dir, 'out', 'body-pretty.json');
    await cli(['send', `${base}/x`, '-w', ws, '--out', pretty, '--format', 'json']);
    expect(readFileSync(pretty, 'utf8')).toBe(JSON.stringify({ b: [1, 2], a: { x: true } }, null, 2) + '\n');
    const bad = await cli(['send', `${base}/x`, '-w', ws, '--out', join(tmp.dir, 'out', 'b.csv'), '--format', 'csv']);
    expect(bad.status).toBe(2);
    expect(bad.err).toMatch(/testpion output response.body --history-id/);
  });
});

describe('MCP save_output', () => {
  it('returns the same bytes inline, writes a new file inside the workspace, and refuses to overwrite or reach a definition', async () => {
    const s = new McpSession({ id: 'out', name: 'testpion', transport: 'stdio', command: process.execPath, args: [cliPath, 'mcp-server', '-w', ws], env: { TESTPION_HOME: home, TESTPION_MCP_CONFIRM_CODES: '0' } });
    await s.connect(20_000);
    try {
      const call = async (a: Record<string, unknown>) => mcpResultBody(await s.callTool('save_output', a));
      const inline = await call({ surface: 'history', format: 'csv' });
      expect(JSON.parse(inline.text).text).toBe((await builder('history', 'csv', { kind: 'history' })).toString('utf8'));
      // a write asks first: without confirm nothing is written and the answer says what would be
      const asked = JSON.parse((await call({ surface: 'history', format: 'json', save_to: 'exports/h.json' })).text);
      expect(asked).toMatchObject({ confirmationRequired: true, changed: false });
      expect(existsSync(join(ws, 'exports', 'h.json'))).toBe(false);
      const saved = JSON.parse((await call({ surface: 'history', format: 'json', save_to: 'exports/h.json', confirm: true })).text);
      expect(saved).toMatchObject({ saved: 'exports/h.json' });
      expect(readFileSync(join(ws, 'exports', 'h.json'), 'utf8')).toBe((await builder('history', 'json', { kind: 'history' })).toString('utf8'));
      const refused = async (save_to: string) => JSON.stringify(await s.callTool('save_output', { surface: 'history', format: 'json', save_to, confirm: true }));
      expect(await refused('exports/h.json')).toMatch(/already exists/);
      // an allow-list: only exports/ and .local/exports/, whatever the file is called
      mkdirSync(join(ws, 'collections'), { recursive: true });
      for (const bad of ['collections/x.json', '.husky/pre-commit', '.vscode/tasks.json', 'Makefile', 'package.json', 'metrics/evil.yaml', 'mcp-servers.json', '.gitattributes', 'exports/.hidden/x.json', 'exports/x.sh'])
        expect(await refused(bad), bad).toMatch(/not allowed/);
      expect(existsSync(join(ws, 'collections', 'x.json'))).toBe(false);
      expect(existsSync(join(ws, '.husky'))).toBe(false);
      const local = JSON.parse((await call({ surface: 'history', format: 'json', save_to: '.local/exports/h.json', confirm: true })).text);
      expect(local).toMatchObject({ saved: '.local/exports/h.json' });
    } finally {
      await s.close();
    }
  });
});
