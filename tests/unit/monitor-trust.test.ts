import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { monitorApproved } from '../../apps/desktop/backend/monitor-trust.js';
import { listMonitors } from '../../packages/core/src/index.js';

// Monitors are shared through git (library/monitors.json). One that arrives with a pull or a clone must not run on its
// schedule on this computer until the person here allowed it: saving it in the app, or "Allow on this computer".
const home = mkdtempSync(join(tmpdir(), 'tp-monitor-trust-'));
const be = new Backend({ appDir: home, emit: () => undefined });
afterAll(async () => {
  await be.dispose();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

type Row = { id: string; name: string; needsApproval?: boolean; everyMinutes: number };
const rows = async () => (await be.invoke('monitor.list', {})) as Row[];
const row = async (id: string) => (await rows()).find((m) => m.id === id)!;
/** The file changed as a pull changes it: not through the monitor handlers. */
const pulled = async (change: (items: Array<{ id: string; name: string; data: Record<string, unknown> }>) => Array<{ id: string; name: string; data: Record<string, unknown> }>) => {
  const lib = (await be.invoke('lib.get', { kind: 'monitors' })) as { folders: string[]; items: Array<{ id: string; name: string; data: Record<string, unknown> }> };
  await be.invoke('lib.save', { kind: 'monitors', library: { folders: lib.folders, items: change(lib.items) } });
};

describe('a monitor runs on its schedule only where it was allowed', () => {
  it('one that arrived with a pull waits; allowed here, it runs; a pulled change to what it does waits again', async () => {
    await be.invoke('col.save', { schemaVersion: '1.0', id: 'api', name: 'API', version: 0, variables: [], updatedAt: '', items: [{ kind: 'http', id: 'r', name: 'Health', request: { method: 'GET', url: 'http://127.0.0.1:9/' } }] });
    await pulled((items) => [...items, { id: 'mon-pulled', name: 'Pulled', data: { collectionId: 'api', everyMinutes: 1, enabled: true, webhook: 'https://example.invalid/{{apiKey}}' } }]);
    expect((await row('mon-pulled')).needsApproval).toBe(true);
    const monitor = () => listMonitors(be.ws).find((m) => m.id === 'mon-pulled')!;
    expect(monitorApproved(be, monitor())).toBe(false);

    await be.invoke('monitor.approve', { id: 'mon-pulled' });
    expect((await row('mon-pulled')).needsApproval).toBeUndefined();
    expect(monitorApproved(be, monitor())).toBe(true);

    // a pause and a resume here keep the answer
    await be.invoke('monitor.pause', { id: 'mon-pulled', minutes: 30 });
    await be.invoke('monitor.resume', { id: 'mon-pulled' });
    expect(monitorApproved(be, monitor())).toBe(true);

    // the webhook changed by a pull: what was allowed is not what is there now
    await pulled((items) => items.map((i) => (i.id === 'mon-pulled' ? { ...i, data: { ...i.data, webhook: 'https://elsewhere.invalid/' } } : i)));
    expect((await row('mon-pulled')).needsApproval).toBe(true);
    expect(monitorApproved(be, monitor())).toBe(false);
  });

  it('one saved in the app is allowed, and what a row shows is not saved with it', async () => {
    const saved = (await be.invoke('monitor.save', { monitor: { name: 'Mine', collectionId: 'api', everyMinutes: 5, enabled: true } })) as Row;
    expect(saved.needsApproval).toBeUndefined();
    const mine = await row(saved.id);
    await be.invoke('monitor.save', { monitor: { ...mine, everyMinutes: 10 } });
    expect((await row(saved.id)).needsApproval).toBeUndefined();
    const lib = (await be.invoke('lib.get', { kind: 'monitors' })) as { items: Array<{ id: string; data: Record<string, unknown> }> };
    const data = lib.items.find((i) => i.id === saved.id)!.data;
    expect(data.everyMinutes).toBe(10);
    for (const k of ['schedule', 'recent', 'lastResult', 'needsApproval', 'paused', 'due']) expect(data).not.toHaveProperty(k);
  });
});
