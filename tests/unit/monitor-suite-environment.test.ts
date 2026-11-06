import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createTestPionMcpServer, listMonitors, MemorySecretStore, monitorRunEnvironment, saveMonitor, WorkspaceManager, WorkspaceStore } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// A monitor on a suite that names no environment runs in the suite's `environment:`. What run_monitor checks before
// the run (an unknown environment, production without --allow-production) is that environment, not "none".
const tmp = tempDir('tp-monitor-suite-env-');
afterAll(() => tmp.cleanup());

describe('a monitor on a suite runs in, and is checked against, the suite environment', () => {
  it('monitorRunEnvironment reads the suite; run_monitor refuses its production environment', async () => {
    const root = join(tmp.dir, 'ws');
    const s = WorkspaceStore.create(root, 'Suites');
    s.saveEnvironment({ id: 'live', name: 'Live', isProduction: true, variables: [{ key: 'base', value: 'http://127.0.0.1:9' }] } as never);
    s.writeTestFile('smoke.yaml', 'tests:\n  - { id: a, name: A, url: "{{base}}/a" }\n');
    s.writeTestFile('live.suite.yaml', 'environment: Live\ntests: [smoke.yaml]\n');
    saveMonitor(s, { name: 'Live suite', testFile: 'live.suite.yaml', everyMinutes: 60, enabled: false } as never);
    saveMonitor(s, { name: 'Plain file', testFile: 'smoke.yaml', everyMinutes: 60, enabled: false } as never);
    const [suite, plain] = ['Live suite', 'Plain file'].map((n) => listMonitors(s).find((m) => m.name === n)!);
    expect(await monitorRunEnvironment(s, suite!)).toBe('Live');
    expect(await monitorRunEnvironment(s, plain!)).toBeUndefined();
    expect(await monitorRunEnvironment(s, { ...suite!, environment: 'Other' })).toBe('Other');

    const srv = createTestPionMcpServer({ store: s, secrets: new MemorySecretStore(), settings: new WorkspaceManager(join(tmp.dir, 'home')).loadSettings() });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await srv.connect(a);
    await client.connect(b);
    try {
      const r = (await client.callTool({ name: 'run_monitor', arguments: { monitor: 'Live suite' } })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/"Live" is a production environment/);
    } finally {
      await client.close();
      s.close();
    }
  });
});
