import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { debuggerExchangeFromRecorded, recordedFromDebuggerExchange, REVERSE_PROXY_APPLICATION, startRecorder } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// The reverse proxy is a capture mode of the HTTP Debugger: what it forwards goes into the Debugger's one store and
// grid (source "reverse"), so Save to collection, Create flow, HAR export and History work the same; the Record
// dialog's own list and Save (a collection with the responses as examples) read from that store.
const tmp = tempDir('tp-reverse-');
const events: Array<{ name: string; data: any }> = [];
const be = new Backend({ appDir: join(tmp.dir, 'app'), emit: (name: string, data: unknown) => void events.push({ name, data }), noMonitors: true });
let api: Server;
let target = '';
beforeAll(async () => {
  api = createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: req.url, ok: true })));
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  target = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
});
afterAll(async () => {
  await be.invoke('record.stop').catch(() => undefined);
  await be.dispose();
  await new Promise<void>((r) => api.close(() => r()));
  tmp.cleanup();
});

describe('reverse proxy → the Debugger’s store', () => {
  it('the two forms of an exchange round-trip', () => {
    const rx = {
      id: 'rx-1',
      time: '2026-10-01T10:00:00.000Z',
      method: 'POST',
      path: '/v1/pets?x=1',
      requestHeaders: [['Content-Type', 'application/json']] as Array<[string, string]>,
      requestBody: '{"a":1}',
      status: 201,
      statusText: 'Created',
      responseHeaders: [['content-type', 'application/json']] as Array<[string, string]>,
      responseBody: '{}',
      durationMs: 12,
    };
    const dx = debuggerExchangeFromRecorded(rx, 'http://api.test/');
    expect(dx).toMatchObject({
      id: 'rx-1',
      source: 'reverse',
      application: REVERSE_PROXY_APPLICATION,
      url: 'http://api.test/v1/pets?x=1',
      host: 'api.test',
      status: 201,
      contentType: 'application/json',
      requestHeaders: { 'content-type': 'application/json' },
      requestBodyBytes: 7,
    });
    expect(recordedFromDebuggerExchange(dx, 'http://api.test')).toMatchObject({ id: 'rx-1', method: 'POST', path: '/v1/pets?x=1', status: 201, requestBody: '{"a":1}', responseBody: '{}' });
  });

  it('captures join the grid as reverse exchanges; the dialog’s Save and the grid’s Save to collection both work', async () => {
    const { url } = (await be.invoke('record.start', { target })) as { url: string };
    for (const p of ['/pets', '/pets/1']) await fetch(url + p).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 120)); // the grid hears in batches (50 ms)
    const all = be.debugger!.exchanges.filter((e) => e.source === 'reverse');
    expect(all.map((e) => new URL(e.url).pathname)).toEqual(['/pets', '/pets/1']);
    expect(events.some((e) => e.name === 'debug.exchange')).toBe(true); // the grid was told
    expect(events.filter((e) => e.name === 'record.exchange')).toHaveLength(2); // and the dialog
    expect(await be.invoke('record.status')).toMatchObject({ url, exchanges: 2 });

    const saved = (await be.invoke('record.save', { name: 'Recorded pets' })) as { collectionId: string; requests: number; historyId: string };
    expect(saved.requests).toBe(2);
    const col = be.ws.getCollection(saved.collectionId) as { items: Array<{ examples?: unknown[] }> };
    expect(JSON.stringify(col)).toContain('"examples"');
    // the grid's own path, by selection
    const viaGrid = (await be.invoke('debug.saveToCollection', { ids: all.map((e) => e.id), name: 'From the grid' })) as { collectionId: string; historyId: string };
    const hist = (await be.invoke('history.list', { kind: 'capture' })) as { items: Array<{ id: string; capture?: { sources: string[] } }> };
    for (const id of [saved.historyId, viaGrid.historyId]) expect(hist.items.find((h) => h.id === id)?.capture?.sources).toEqual(['reverse']);
    // HAR export of the session has them
    const har = (await be.invoke('debug.har', {})) as { log: { entries: Array<{ request: { url: string } }> } };
    expect(har.log.entries.map((e) => e.request.url)).toEqual(expect.arrayContaining([`${target}/pets`, `${target}/pets/1`]));

    await be.invoke('record.stop');
    expect(await be.invoke('record.status')).toBeNull();
    await expect(be.invoke('record.save', { name: 'again' })).resolves.toMatchObject({ requests: 2 }); // still in the session
    await be.invoke('record.clear');
    await expect(be.invoke('record.save', { name: 'none' })).rejects.toThrow(/Nothing recorded/);
    expect(be.debugger!.exchanges.filter((e) => e.source === 'reverse')).toHaveLength(2); // the grid keeps them
  });

  it('the CLI recorder still keeps its own list; the app’s keeps none (one store)', async () => {
    const kept = await startRecorder({ target });
    const none = await startRecorder({ target, keep: false });
    try {
      await fetch(kept.url + '/a').then((r) => r.text());
      await fetch(none.url + '/a').then((r) => r.text());
      expect(kept.exchanges).toHaveLength(1);
      expect(none.exchanges).toHaveLength(0);
    } finally {
      await kept.close();
      await none.close();
    }
  });
});
