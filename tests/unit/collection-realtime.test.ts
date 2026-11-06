import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { WebSocketServer } from 'ws';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { collectionRealtimeTests, parseProtos, savedConnectionToTest, savedGrpcCallToTest } from '../../packages/core/src/index.js';

// A collection shows the gRPC calls and connections saved into it (collectionId); a collection run runs them
// too, after its requests, so "Run collection" covers everything the collection holds.
const PROTO = `syntax = "proto3";\npackage demo;\nmessage Hi { string name = 1; }\nmessage Reply { string text = 1; }\nservice Greeter { rpc Say(Hi) returns (Reply); }\n`;
const home = mkdtempSync(join(tmpdir(), 'tp-col-rt-'));
const be = new Backend({ appDir: home, emit: () => undefined });
const closers: Array<() => unknown> = [];
afterAll(async () => {
  for (const c of closers) await c();
  await be.dispose();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

describe('collection runs include gRPC calls and connections', () => {
  it('converts saved items into tests', () => {
    const g = savedGrpcCallToTest({ id: 'g1', name: 'Say hi', folder: 'greeter', data: { target: 'localhost:1', method: 'demo.Greeter/Say', message: '{"name":"a"}', protoFiles: [{ name: 'demo.proto', text: PROTO }], descriptorSet: 'ignored' } }, 'Shop');
    expect(g).toMatchObject({ type: 'grpc', name: 'greeter / Say hi', location: ['Shop', 'greeter', 'Say hi'], message: { name: 'a' }, protos: [], descriptorSet: undefined, assertions: [{ type: 'status', expected: 0 }] });
    const sio = savedConnectionToTest({ id: 's', name: 'Chat', data: { url: 'http://x', mode: 'socketio', event: 'msg', message: '{"t":1}', ack: true } }, 'Shop');
    expect(sio.send).toEqual([{ event: 'msg', args: [{ t: 1 }], ack: true }]);
    const mqtt = savedConnectionToTest({ id: 'm', name: 'Broker', data: { url: 'mqtt://x', mode: 'mqtt', topic: 'a/b', message: 'hi', subscriptions: [{ topic: 'a/#' }], username: 'u' } }, 'Shop');
    expect(mqtt).toMatchObject({ send: [{ topic: 'a/b', payload: 'hi', qos: 0 }], subscribe: [{ topic: 'a/#' }], username: 'u', headers: undefined });
    const ws = savedConnectionToTest({ id: 'w', name: 'Echo', data: { url: 'ws://x', message: '  ', protocols: 'a, b' } }, 'Shop');
    expect(ws).toMatchObject({ mode: 'websocket', send: [], protocols: ['a', 'b'] });
  });

  it('any kind in any folder: a call runs at its place in its folder, named by the folder path, and a selected folder takes its calls', () => {
    const items = { grpc: [{ id: 'g-refund', name: 'Refund', collectionId: 'shop', folderId: 'refunds', after: 'r-list', data: { target: 'x:1', method: 'a.B/C' } }, { id: 'g-top', name: 'Health', collectionId: 'shop', data: { target: 'x:1', method: 'a.B/C' } }], websocket: [{ id: 'w-feed', name: 'Feed', collectionId: 'shop', folderId: 'pay', data: { url: 'ws://x' } }] } as Record<string, unknown[]>;
    const store = { getLibrary: (kind: string) => ({ folders: [], items: items[kind] ?? [] }) } as never;
    const col = { id: 'shop', name: 'Shop', items: [{ kind: 'folder', id: 'pay', name: 'Payments', items: [{ kind: 'folder', id: 'refunds', name: 'Refunds', items: [{ kind: 'http', id: 'r-list', name: 'List', request: { method: 'GET', url: '/' } }] }] }] } as never;
    const all = collectionRealtimeTests(store, col);
    expect(all.map((t) => [t.id, t.name])).toEqual([['g-refund', 'Payments / Refunds / Refund'], ['w-feed', 'Payments / Feed'], ['g-top', 'Health']]);
    expect(collectionRealtimeTests(store, col, ['pay']).map((t) => t.id)).toEqual(['g-refund', 'w-feed']);
    expect(collectionRealtimeTests(store, col, ['refunds']).map((t) => t.id)).toEqual(['g-refund']);
  });

  it('a call gets the headers and auth of its collection and folders: gRPC metadata, the handshake of a connection; its own win', () => {
    const items = {
      grpc: [{ id: 'g', name: 'Refund', collectionId: 'shop', folderId: 'pay', data: { target: 'x:1', method: 'a.B/C', metadata: [{ key: 'x-tenant', value: 'mine' }] } }],
      websocket: [
        { id: 'w', name: 'Feed', collectionId: 'shop', folderId: 'pay', data: { url: 'ws://x', headers: [] } },
        { id: 'm', name: 'Broker', collectionId: 'shop', folderId: 'pay', data: { url: 'mqtt://x', mode: 'mqtt', topic: 't' } },
        { id: 'top', name: 'Top', collectionId: 'shop', data: { url: 'ws://x' } },
      ],
    } as Record<string, unknown[]>;
    const store = { getLibrary: (kind: string) => ({ folders: [], items: items[kind] ?? [] }) } as never;
    const col = {
      id: 'shop',
      name: 'Shop',
      auth: { type: 'apiKey', key: 'x-api-key', value: '{{key}}', in: 'header' },
      headers: [{ key: 'x-tenant', value: 'acme' }],
      preRequestScript: "tp.variables.set('a', 1)",
      items: [{ kind: 'folder', id: 'pay', name: 'Payments', auth: { type: 'bearer', token: '{{token}}' }, headers: [{ key: 'x-area', value: 'pay' }], testScript: "tp.test('ok', () => {})", items: [] }],
    } as never;
    const byId = Object.fromEntries(collectionRealtimeTests(store, col).map((t) => [t.id, t as { metadata?: unknown; headers?: unknown; preRequestScript?: string; testScript?: string }]));
    // the folder's bearer wins over the collection's API key; the call's own x-tenant wins over the collection's
    expect(byId.g!.metadata).toEqual([{ key: 'x-tenant', value: 'mine' }, { key: 'x-area', value: 'pay' }, { key: 'Authorization', value: 'Bearer {{token}}', enabled: true }]);
    expect(byId.w!.headers).toEqual([{ key: 'x-tenant', value: 'acme' }, { key: 'x-area', value: 'pay' }, { key: 'Authorization', value: 'Bearer {{token}}', enabled: true }]);
    // the collection's and the folder's scripts run around it, as around a request inside
    expect(byId.w!.preRequestScript).toBe("tp.variables.set('a', 1)");
    expect(byId.w!.testScript).toBe("tp.test('ok', () => {})");
    expect(byId.top!.testScript).toBeUndefined();
    expect(byId.m!.headers).toBeUndefined(); // MQTT has no handshake headers
    expect(byId.top!.headers).toEqual([{ key: 'x-tenant', value: 'acme' }, { key: 'x-api-key', value: '{{key}}', enabled: true }]);
  });

  it('runs a collection: its request, then its gRPC call and its connection', async () => {
    // HTTP, gRPC and WebSocket servers
    const http = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise((r) => http.close(r)));
    const pkg = grpc.loadPackageDefinition(protoLoader.fromJSON(parseProtos([{ name: 'demo.proto', text: PROTO }]).toJSON(), { keepCase: true })) as any;
    const server = new grpc.Server();
    server.addService(pkg.demo.Greeter.service, { Say: (call: any, cb: any) => cb(null, { text: `hi ${call.request.name}` }) });
    const grpcPort = await new Promise<number>((ok, fail) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? fail(e) : ok(p))));
    closers.push(() => server.forceShutdown());
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (s) => s.on('message', (d) => s.send(`echo:${d}`)));
    closers.push(() => wss.close());

    const col = { schemaVersion: '1.0', id: 'shop', name: 'Shop', version: 0, variables: [], updatedAt: '', items: [{ kind: 'http', id: 'r1', name: 'Health', request: { method: 'GET', url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/health` }, assertions: [{ type: 'status', expected: 200 }] }] };
    await be.invoke('col.save', col);
    await be.invoke('lib.save', { kind: 'grpc', library: { folders: [], items: [{ id: 'g1', name: 'Say hi', collectionId: 'shop', data: { target: `127.0.0.1:${grpcPort}`, method: 'demo.Greeter/Say', message: '{"name":"ada"}', metadata: [], protoFiles: [{ name: 'demo.proto', text: PROTO }] } }, { id: 'g2', name: 'Elsewhere', collectionId: 'other', data: { target: 'x:1', method: 'a.B/C' } }] } });
    await be.invoke('lib.save', { kind: 'websocket', library: { folders: [], items: [{ id: 'w1', name: 'Echo', collectionId: 'shop', data: { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, message: 'ping', headers: [] } }] } });

    // the calls at the collection's top level, after its requests, by name (the order the tree shows)
    expect(collectionRealtimeTests(be.ws, col).map((t) => t.id)).toEqual(['w1', 'g1']);
    expect(collectionRealtimeTests(be.ws, col, ['w1']).map((t) => t.id)).toEqual(['w1']);

    const { runId } = (await be.invoke('col.run', { collectionId: 'shop' })) as { runId: string };
    let summary: { total: number; passed: number } | null = null;
    for (let i = 0; i < 100 && !summary; i++) {
      await new Promise((r) => setTimeout(r, 100));
      summary = (await be.invoke('runs.summary', { runId })) as typeof summary;
    }
    expect(summary).toMatchObject({ total: 3, passed: 3 });
    const results = (await be.invoke('runs.results', { runId })) as { items: Array<{ name: string; status: string; output?: unknown }> };
    expect(results.items.map((r) => [r.name, r.status])).toEqual([
      ['Health', 'passed'],
      ['Echo', 'passed'],
      ['Say hi', 'passed'],
    ]);
  }, 30_000);

  it('a call in a folder runs where the tree shows it, between the requests, with the variables of its folders', async () => {
    const http = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise((r) => http.close(r)));
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (s) => s.on('message', (d) => s.send(`echo:${d}`)));
    closers.push(() => wss.close());
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const request = (id: string, name: string) => ({ kind: 'http', id, name, request: { method: 'GET', url: `${url}/${id}` }, assertions: [{ type: 'status', expected: 200 }] });
    const col = {
      schemaVersion: '1.0',
      id: 'orders',
      name: 'Orders',
      version: 0,
      variables: [],
      updatedAt: '',
      items: [
        // the folder's variable is the connection's address: without it the call cannot connect
        { kind: 'folder', id: 'live', name: 'Live', variables: [{ key: 'feed', value: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` }], items: [request('login', 'Login'), request('logout', 'Logout')] },
        request('last', 'Last'),
      ],
    };
    await be.invoke('col.save', col);
    await be.invoke('lib.save', { kind: 'websocket', library: { folders: [], items: [{ id: 'feed', name: 'Feed', collectionId: 'orders', folderId: 'live', after: 'login', data: { url: '{{feed}}', message: 'ping', headers: [] } }] } });
    const [test] = collectionRealtimeTests(be.ws, col as never);
    expect(test).toMatchObject({ id: 'feed', name: 'Live / Feed', variables: { feed: expect.stringMatching(/^ws:/) }, runAfter: 'login' });
    const { runId } = (await be.invoke('col.run', { collectionId: 'orders' })) as { runId: string };
    let summary: { total: number; passed: number } | null = null;
    for (let i = 0; i < 100 && !summary; i++) {
      await new Promise((r) => setTimeout(r, 100));
      summary = (await be.invoke('runs.summary', { runId })) as typeof summary;
    }
    expect(summary).toMatchObject({ total: 4, passed: 4 });
    const results = (await be.invoke('runs.results', { runId })) as { items: Array<{ name: string; status: string }> };
    expect(results.items.map((r) => r.name)).toEqual(['Live / Login', 'Live / Feed', 'Live / Logout', 'Last']);
    // only the folder's second request selected: the call follows a request that is not in the run, so it runs first
    const picked = (await be.invoke('col.run', { collectionId: 'orders', selection: ['logout', 'feed'] })) as { runId: string };
    let done: { total: number } | null = null;
    for (let i = 0; i < 100 && !done; i++) {
      await new Promise((r) => setTimeout(r, 100));
      done = (await be.invoke('runs.summary', { runId: picked.runId })) as typeof done;
    }
    const some = (await be.invoke('runs.results', { runId: picked.runId })) as { items: Array<{ name: string }> };
    expect(some.items.map((r) => r.name)).toEqual(['Live / Feed', 'Live / Logout']);
  }, 30_000);
});
