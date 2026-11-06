import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { Backend } from '../../apps/desktop/backend/backend.js';

// The status bar's "what runs now": one list of the mock servers, recorder, capture and open connections the app keeps
// for the workspace, each stopped through the handler its own view uses.
const home = mkdtempSync(join(tmpdir(), 'tp-running-'));
const be = new Backend({ appDir: home, emit: () => undefined });
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
afterAll(async () => {
  wss.close();
  await be.dispose();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

type Item = { kind: string; id: string; label: string; detail?: string };

describe('what runs now', () => {
  it('lists a mock server and an open WebSocket, and stops each', async () => {
    expect(await be.invoke('app.running', {})).toEqual([]);
    await be.invoke('col.save', { schemaVersion: '1.0', id: 'shop', name: 'Shop', version: 0, variables: [], updatedAt: '', items: [] });
    await be.invoke('mock.start', { collectionId: 'shop', port: 0 });
    if (!wss.address()) await new Promise((r) => wss.once('listening', r));
    const { id } = (await be.invoke('wsock.connect', { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` })) as { id: string };
    const running = (await be.invoke('app.running', {})) as Item[];
    expect(running.map((i) => [i.kind, i.label])).toEqual([
      ['mock', 'Mock server of Shop'],
      ['websocket', 'WebSocket'],
    ]);
    expect(running[0]!.detail).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+/);
    const afterMock = (await be.invoke('app.stopRunning', { kind: 'mock', id: 'shop' })) as Item[];
    expect(afterMock.map((i) => i.kind)).toEqual(['websocket']);
    expect(be.mocks.size).toBe(0);
    expect(await be.invoke('app.stopRunning', { kind: 'websocket', id })).toEqual([]);
    await expect(be.invoke('app.stopRunning', { kind: 'nothing', id: 'x' })).rejects.toThrow(/Nothing of the kind "nothing"/);
  });
});
