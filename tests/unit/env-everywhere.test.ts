import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createTestPionMcpServer, MemorySecretStore, readRunSummary, saveMonitor, WorkspaceManager, WorkspaceStore } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// WF-05: every run reports the environment it ran against, the same way (an agent reads it like the app's EnvBadge).
const tmp = tempDir('tp-enveverywhere-');
let server: Server;
let base = '';
const root = join(tmp.dir, 'ws');

beforeAll(async () => {
  server = createServer((_req, res) => res.end('{}'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const s = WorkspaceStore.create(root, 'Envs');
  s.saveEnvironment({ id: 'dev', name: 'Dev', variables: [{ key: 'base', value: base }] } as never);
  s.saveCollection({
    schemaVersion: '1.0',
    id: 'c1',
    name: 'Shop',
    version: 0,
    updatedAt: '',
    variables: [],
    items: [{ kind: 'http', id: 'r1', name: 'Ping', request: { method: 'GET', url: '{{base}}/ping', headers: [] } }],
  } as never);
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests', 'one.yaml'), 'tests:\n  - id: one\n    name: one\n    type: http\n    method: GET\n    url: "{{base}}/t"\n');
  saveMonitor(s, { name: 'Ping', collectionId: 'c1', environment: 'Dev', everyMinutes: 60, enabled: false } as never);
  s.close();
});
afterAll(() => {
  server.close();
  tmp.cleanup();
});

describe('every run names its environment', () => {
  it('run_tests, run_collection, run_monitor and load_test report `environment` (null when none)', async () => {
    const store = WorkspaceStore.open(root);
    const srv = createTestPionMcpServer({ store, secrets: new MemorySecretStore(), settings: new WorkspaceManager(join(tmp.dir, 'home')).loadSettings() });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await srv.connect(a);
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(r.isError, `${name}: ${r.content[0]?.text}`).toBeFalsy();
      return JSON.parse(r.content[0]!.text) as { environment?: string | null; runId?: string };
    };
    try {
      const tests = await call('run_tests', { environment: 'Dev' });
      expect(tests.environment).toBe('Dev');
      // the recorded run says it too (the app's run header reads it)
      expect(readRunSummary(store, tests.runId!)?.environment).toBe('Dev');
      expect((await call('run_collection', { collection: 'Shop', environment: 'Dev' })).environment).toBe('Dev');
      expect((await call('run_monitor', { monitor: 'Ping' })).environment).toBe('Dev');
      expect((await call('load_test', { url: `${base}/load`, virtualUsers: 1, durationSec: 1 })).environment).toBeNull();
    } finally {
      await client.close();
      store.close();
    }
  }, 30_000);
});
