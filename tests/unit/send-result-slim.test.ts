import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { serialize } from 'node:v8';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { slimSendResult } from '../../apps/desktop/backend/send-result.js';
import { WorkspaceStore } from '../../packages/core/src/index.js';
import { pushLiveEvents, rehydrateResponse } from '../../apps/desktop/src/lib/send-result.js';
import { tempDir } from '../helpers.js';

// S-7: the body crosses the channel once. v8.serialize is what Electron's structured clone sends.
const tmp = tempDir('tp-slim-');
let server: Server;
let base = '';
let be: Backend;
const big = JSON.stringify({ items: Array.from({ length: 18_000 }, (_, i) => ({ id: i, name: `item ${i}`, tags: ['a', 'b'], ok: true })) }); // ~1.4 MB, under the 2 MB preview

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\ndata: two\n\n');
      return void setTimeout(() => res.end('data: three\n\n'), 30);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/small' ? '{"ok":true}' : big);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = join(tmp.dir, 'ws');
  WorkspaceStore.create(root, 'Slim').close();
  be = new Backend({ appDir: join(tmp.dir, 'app'), emit: () => undefined, noMonitors: true });
  be.openStore(root);
});
afterAll(async () => {
  await be.dispose();
  server.close();
  tmp.cleanup();
});

describe('S-7 the send result carries the body once', () => {
  it('a 1.4 MB JSON response: the channel carries the text, not the text and the parsed tree', async () => {
    const full = (await be.httpSend({ request: { method: 'GET', url: `${base}/big`, headers: [] } } as never)) as { response: { json?: unknown; bodyPreview: string } };
    expect(full.response.json).toBeDefined();
    const before = serialize(full).length;
    const slim = (await be.invoke('http.send', { request: { method: 'GET', url: `${base}/big`, headers: [] } })) as { response: { json?: unknown; jsonInPreview?: boolean; bodyPreview: string } };
    const after = serialize(slim).length;
    console.log(`http.send result for a ${(big.length / 1e6).toFixed(1)} MB JSON body: ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB over the channel`);
    expect(slim.response.json).toBeUndefined();
    expect(slim.response.jsonInPreview).toBe(true);
    expect(after).toBeLessThan(before * 0.6);
    expect(after).toBeLessThan(big.length * 1.1 + 20_000); // the body once, plus the headers, timeline, trace ids
    // the window makes the tree again from the preview
    const back = rehydrateResponse(slim as never) as { response: { json: { items: unknown[] }; jsonInPreview?: boolean } };
    expect(back.response.json.items.length).toBe(18_000);
    expect(back.response.jsonInPreview).toBeUndefined();
  });

  it('a small JSON body, a truncated one and an error are left alone or still readable', async () => {
    const small = (await be.invoke('http.send', { request: { method: 'GET', url: `${base}/small`, headers: [] } })) as { response: { jsonInPreview?: boolean; bodyPreview: string } };
    expect(small.response.jsonInPreview).toBe(true);
    expect(JSON.parse(small.response.bodyPreview)).toEqual({ ok: true });
    // a body cut at the preview limit keeps no tree at all (nothing to move out)
    const cut = slimSendResult({ response: { json: undefined, truncated: true, bodyPreview: 'x' } });
    expect(cut.response).not.toHaveProperty('jsonInPreview');
    // an error result has no response
    expect(slimSendResult({ error: { message: 'x' } })).toEqual({ error: { message: 'x' } });
  });

  it('server-sent events are streamed once; the finished result carries their number and the window hands back what it kept', async () => {
    const streamed: unknown[] = [];
    const slim = (await be.invoke('http.send', { request: { method: 'GET', url: `${base}/sse`, headers: [{ key: 'Accept', value: 'text/event-stream', enabled: true }] }, stream: true })) as { response: { events?: unknown[]; eventsStreamed?: number } };
    expect(slim.response.events).toBeUndefined();
    expect(slim.response.eventsStreamed).toBe(3);
    let live = pushLiveEvents(undefined, [{ data: 'one' }, { data: 'two' }]);
    live = pushLiveEvents(live, [{ data: 'three' }]);
    streamed.push(...live.events);
    const back = rehydrateResponse(slim as never, live) as { response: { events: unknown[]; eventsStreamed?: number } };
    expect(back.response.events).toHaveLength(3);
    expect(back.response.eventsStreamed).toBeUndefined();
  });

  it('the live list keeps to the engine limits (it was unbounded)', () => {
    let live = pushLiveEvents(undefined, []);
    for (let i = 0; i < 12; i++) live = pushLiveEvents(live, Array.from({ length: 1000 }, () => ({ data: 'x' })));
    expect(live.events.length).toBe(10_000);
  });
});
