import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createTestPionMcpServer, MemorySecretStore, saveMonitor, WorkspaceManager, WorkspaceStore } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// pause_monitor: an agent pauses a monitor around a deploy (with why and for how long) and resumes it, as `testpion
// monitor pause` / `resume` do.
const tmp = tempDir('tp-pause-tool-');
afterAll(() => tmp.cleanup());

describe('pause_monitor', () => {
  it('pauses for a while with a reason, and resumes', async () => {
    const s = WorkspaceStore.create(join(tmp.dir, 'ws'), 'Pause');
    s.writeTestFile('smoke.yaml', 'tests:\n  - { id: a, name: A, url: "http://127.0.0.1:9/a" }\n');
    saveMonitor(s, { name: 'Checkout', testFile: 'smoke.yaml', everyMinutes: 15, enabled: true } as never);
    const srv = createTestPionMcpServer({ store: s, secrets: new MemorySecretStore(), settings: new WorkspaceManager(join(tmp.dir, 'home')).loadSettings() });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await srv.connect(a);
    await client.connect(b);
    const call = async (args: Record<string, unknown>) => {
      const r = (await client.callTool({ name: 'pause_monitor', arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(r.isError, r.content[0]?.text).toBeFalsy();
      return JSON.parse(r.content[0]!.text) as { schedule: string; pausedUntil?: string; pauseReason?: string };
    };
    try {
      const paused = await call({ monitor: 'Checkout', minutes: 30, reason: 'deploy' });
      expect(paused.schedule).toMatch(/^paused until .* \(deploy\)$/);
      expect(Math.abs(Date.parse(paused.pausedUntil!) - Date.now() - 30 * 60_000)).toBeLessThan(60_000);
      const resumed = await call({ monitor: 'Checkout', resume: true });
      expect(resumed.schedule).toBe('every 15 minutes');
      expect(resumed.pausedUntil).toBeUndefined();
    } finally {
      await client.close();
      s.close();
    }
  });
});
