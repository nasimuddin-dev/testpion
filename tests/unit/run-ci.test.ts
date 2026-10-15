import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { ciCommand, ciTargetOfRun, createTestPionMcpServer, MemorySecretStore, readRunSummary, WorkspaceManager, WorkspaceStore, type RunSummary } from '../../packages/core/src/index.js';
import { runCli, tempDir, waitFor, cliData } from '../helpers.js';

// WF-09 Run → CI: a finished run as a pipeline target (its files with their filter, or its collection with the
// folders and requests it picked, and its environment) and as the command that runs it from a terminal.
const tmp = tempDir('tp-runci-');
let server: Server;
let base = '';
let be: Backend;
const root = join(tmp.dir, 'ws');

beforeAll(async () => {
  server = createServer((_req, res) => res.end('{}'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const s = WorkspaceStore.create(root, 'Ci');
  s.saveEnvironment({ id: 'dev', name: 'Dev', variables: [{ key: 'base', value: base }] } as never);
  s.saveCollection({
    schemaVersion: '1.0',
    id: 'c1',
    name: 'Shop',
    version: 0,
    updatedAt: '',
    variables: [],
    items: [
      { kind: 'http', id: 'r1', name: 'One', request: { method: 'GET', url: '{{base}}/1', headers: [] } },
      { kind: 'http', id: 'r2', name: 'Two', request: { method: 'GET', url: '{{base}}/2', headers: [] } },
    ],
  } as never);
  mkdirSync(join(root, 'tests', 'smoke'), { recursive: true });
  writeFileSync(join(root, 'tests', 'smoke', 'two.yaml'), 'tests:\n  - id: one\n    name: one\n    type: http\n    method: GET\n    url: "{{base}}/t1"\n    tags: [fast]\n');
  s.close();
  be = new Backend({ appDir: join(tmp.dir, 'app'), emit: () => undefined, noMonitors: true });
  be.openStore(root);
});
afterAll(async () => {
  await be.dispose();
  server.close();
  tmp.cleanup();
});

// finished and in the run history ('last' reads the history)
const finished = (runId: string) => waitFor(() => !!readRunSummary(be.ws, runId) && be.ws.meta.listRuns({ limit: 5 }).items.some((r) => r.id === runId), 15_000, `run ${runId}`);

describe('a run as a CI target', () => {
  it('test files keep their name / tag filter; a collection its picked requests; old runs their files under tests/', () => {
    const s = { runId: 'r', name: 'x', environment: 'Dev' } as RunSummary;
    expect(ciTargetOfRun(be.ws, { ...s, origin: { kind: 'tests', paths: ['smoke'], grep: 'one', tags: ['fast'] } })).toEqual({
      target: { tests: ['smoke'], grep: 'one', tags: ['fast'] },
      environment: 'Dev',
    });
    expect(ciTargetOfRun(be.ws, { ...s, origin: { kind: 'collection', collectionId: 'c1', selection: ['r2'], iterations: 3 } })).toEqual({
      target: { collection: 'c1', folders: ['r2'] },
      environment: 'Dev',
      note: 'The run had 3 iterations; the pipeline runs the collection once.',
    });
    expect(ciTargetOfRun(be.ws, { ...s, files: [join(root, 'tests', 'smoke', 'two.yaml')] }).target).toEqual({ tests: ['smoke/two.yaml'] });
    expect(ciCommand({ provider: 'github', tests: ['smoke'], grep: 'one|two', tags: ['fast', 'smoke'], environment: 'Dev' })).toBe(
      'testpion test tests/smoke -w . -e Dev -g "one|two" -t "fast,smoke" -r console junit html -o test-results',
    );
  });

  it('runs.ci: the dialog preselection and the local command of a finished run ("last" too)', async () => {
    const t = (await be.invoke('tests.run', { paths: ['smoke/two.yaml'], environment: 'Dev', tags: ['fast'] })) as { runId: string };
    await finished(t.runId);
    const r = (await be.invoke('runs.ci', { runId: 'last' })) as { request: Record<string, unknown>; command: string };
    expect(r.request).toEqual({ tests: ['smoke/two.yaml'], tags: ['fast'], environment: 'Dev' });
    expect(r.command).toBe(
      `testpion test ${root.replace(/\\/g, '/')}/tests/smoke/two.yaml -w ${root.replace(/\\/g, '/')} -e Dev -t fast -r console junit html -o test-results`.replace(
        / (\S*[^\w./@:\s-]\S*)/g,
        (m, p: string) => ` "${p}"`,
      ),
    );
    const c = (await be.invoke('col.run', { collectionId: 'c1', selection: ['r2'], environment: 'Dev' })) as { runId: string };
    await finished(c.runId);
    expect(((await be.invoke('runs.ci', { runId: c.runId })) as { request: unknown }).request).toEqual({ collection: 'c1', folders: ['r2'], environment: 'Dev' });
    await expect(be.invoke('runs.ci', { runId: 'nope' })).rejects.toThrow(/No finished run nope/);
  });

  it('ci_config runId and `testpion ci --run` write the same pipeline', async () => {
    const store = WorkspaceStore.open(root);
    const srv = createTestPionMcpServer({ store, secrets: new MemorySecretStore(), settings: new WorkspaceManager(join(tmp.dir, 'home')).loadSettings() });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await srv.connect(a);
    await client.connect(b);
    try {
      const r = (await client.callTool({ name: 'ci_config', arguments: { provider: 'github', runId: 'last' } })) as { content: Array<{ text: string }> };
      const mcp = JSON.parse(r.content[0]!.text) as { command: string; content: string };
      expect(mcp.command).toMatch(/run-collection c1 -w \. -e Dev --folder r2/);
      const cli = await runCli(['ci', 'github', '-w', root, '--run', 'last', '--json']);
      expect(cli.status, cli.err).toBe(0);
      expect(cliData(cli.out).content).toBe(mcp.content);
    } finally {
      await client.close();
      store.close();
    }
  }, 60_000);
});
