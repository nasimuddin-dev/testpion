import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { refTools } from '../../packages/core/src/mcp-server/ref-tools.js';
import { itemInfo, readRunSummary } from '../../packages/core/src/index.js';
import { tempDir, waitFor } from '../helpers.js';

// WF-20 the Info panel: an item's file, the variables it uses (with where each comes from) and the runs that included it.
const tmp = tempDir('tp-iteminfo-');
let server: Server;
let base = '';
let be: Backend;

beforeAll(async () => {
  server = createServer((_req, res) => res.end('{}'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = join(tmp.dir, 'ws');
  be = new Backend({ appDir: join(tmp.dir, 'app'), emit: () => undefined, noMonitors: true });
  const { WorkspaceStore } = await import('../../packages/core/src/index.js');
  const s = WorkspaceStore.create(root, 'Info');
  s.saveEnvironment({
    id: 'dev',
    name: 'Dev',
    variables: [
      { key: 'base', value: base },
      { key: 'token', value: 't0p', secret: false },
    ],
  } as never);
  s.saveCollection({
    schemaVersion: '1.0',
    id: 'c1',
    name: 'Shop',
    version: 0,
    updatedAt: '',
    variables: [{ key: 'path', value: '/ping', enabled: true }],
    items: [
      {
        kind: 'http',
        id: 'r1',
        name: 'Ping',
        request: { method: 'GET', url: '{{base}}{{path}}', headers: [{ key: 'x-missing', value: '{{nowhere}}' }] },
        // a visualizer template in a script: its {{…}} are not variables of the request
        testScript: 'const t = `{{#each items}}<b>{{id}}</b>{{/each}}`;',
      },
    ],
  } as never);
  mkdirSync(join(root, 'tests', 'smoke'), { recursive: true });
  writeFileSync(join(root, 'tests', 'smoke', 'a.yaml'), 'tests:\n  - id: a\n    name: a\n    type: http\n    method: GET\n    url: "{{base}}/a"\n');
  s.close();
  be.openStore(root);
});
afterAll(async () => {
  await be.dispose();
  server.close();
  tmp.cleanup();
});

const finished = (runId: string) => waitFor(() => !!readRunSummary(be.ws, runId) && be.ws.meta.listRuns({ limit: 10 }).items.some((r) => r.id === runId), 15_000, `run ${runId}`);

describe('item info', () => {
  it('a request: its collection file, its variables with their source, the collection runs that included it', async () => {
    const run = (await be.invoke('col.run', { collectionId: 'c1', environment: 'Dev' })) as { runId: string };
    await finished(run.runId);
    const i = (await be.invoke('ref.info', { ref: { kind: 'request', collectionId: 'c1', requestId: 'r1' }, environment: 'Dev' })) as {
      file: string;
      runs: Array<{ runId: string }>;
      variables: Array<{ name: string; scope?: string }>;
    };
    expect(i.file).toMatch(/^collections\//);
    expect(i.runs.map((r) => r.runId)).toContain(run.runId);
    expect(i.variables).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'base', scope: 'environment' }), expect.objectContaining({ name: 'path', scope: 'collection' })]));
    expect(i.variables.find((v) => v.name === 'nowhere')?.scope).toBeUndefined();
    expect(i.variables.map((v) => v.name)).not.toEqual(expect.arrayContaining(['id']));
    expect(i.variables.some((v) => /^[#/]/.test(v.name))).toBe(false);
  });

  it('a test file: a run of its folder included it; MCP item_info says the same', async () => {
    const run = (await be.invoke('tests.run', { paths: ['smoke'], environment: 'Dev' })) as { runId: string };
    await finished(run.runId);
    const i = itemInfo(be.ws, { kind: 'test', path: 'smoke/a.yaml' });
    expect(i.file).toBe('tests/smoke/a.yaml');
    expect(i.runs[0]?.runId).toBe(run.runId);
    expect(itemInfo(be.ws, { kind: 'test', path: 'other.yaml' }).runs).toEqual([]);
    const tool = refTools({ store: be.ws }).find((t) => t.name === 'item_info')!;
    const r = (await tool.run({ ref: 'test:smoke/a.yaml' })) as { variables: string[]; runs: unknown[] };
    expect(r.variables).toEqual(['base']);
    expect(r.runs.length).toBeGreaterThan(0);
  });
});
