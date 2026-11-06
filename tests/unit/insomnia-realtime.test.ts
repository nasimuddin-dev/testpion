import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, collectionFolders, importIntoWorkspace } from '../../packages/core/src/index.js';

// Insomnia 4 exports hold gRPC requests (with .proto files) and WebSocket requests next to HTTP ones: an import
// brings them in as the collection's gRPC calls and connections.
const dir = mkdtempSync(join(tmpdir(), 'tp-insomnia-rt-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

const PROTO = 'syntax = "proto3"; package demo; message Hi { string name = 1; } service Greeter { rpc Say(Hi) returns (Hi); }';
const exported = {
  _type: 'export',
  __export_format: 4,
  resources: [
    { _id: 'wrk_1', _type: 'workspace', name: 'Shop' },
    { _id: 'fld_1', _type: 'request_group', parentId: 'wrk_1', name: 'Realtime' },
    { _id: 'req_1', _type: 'request', parentId: 'wrk_1', name: 'Health', method: 'GET', url: '{{ _.base }}/health' },
    { _id: 'pf_1', _type: 'proto_file', parentId: 'wrk_1', name: 'greeter.proto', protoText: PROTO },
    { _id: 'greq_1', _type: 'grpc_request', parentId: 'fld_1', name: 'Say hi', url: 'grpcs://{{ _.grpcHost }}', protoFileId: 'pf_1', protoMethodName: '/demo.Greeter/Say', body: { text: '{"name":"ada"}' }, metadata: [{ name: 'x-key', value: '{{ _.key }}' }] },
    { _id: 'ws-req_1', _type: 'websocket_request', parentId: 'fld_1', name: 'Echo', url: 'wss://echo.example', headers: [{ name: 'Authorization', value: 'Bearer {{ _.token }}', disabled: true }] },
    { _id: 'ws-payload_1', _type: 'websocket_payload', parentId: 'ws-req_1', value: '{"type":"ping"}' },
  ],
};

describe('Insomnia import: gRPC and WebSocket requests', () => {
  it('become the imported collection’s gRPC calls and connections', () => {
    const store = WorkspaceStore.create(join(dir, 'w'), 'W');
    const r = importIntoWorkspace(store, JSON.stringify(exported));
    expect(r.format).toBe('insomnia');
    expect(r.savedItems).toEqual({ grpc: 1, websocket: 1 });
    const id = r.collection!.id;
    const [call] = store.getLibrary('grpc').items;
    // their Insomnia folder is a folder of the collection (the folder text has placed them and is gone)
    const realtime = [...collectionFolders(store.getCollection(id))].find(([, f]) => f.path.join('/') === 'Realtime')![0];
    expect([call!.folderId, call!.folder]).toEqual([realtime, undefined]);
    expect(call).toMatchObject({ name: 'Say hi', collectionId: id, data: { target: '{{grpcHost}}', method: 'demo.Greeter/Say', message: '{"name":"ada"}', tls: true, metadata: [{ key: 'x-key', value: '{{key}}', enabled: true }], protoFiles: [{ name: 'greeter.proto', text: PROTO }] } });
    const [conn] = store.getLibrary('websocket').items;
    expect(conn).toMatchObject({ name: 'Echo', folderId: realtime, collectionId: id, data: { url: 'wss://echo.example', mode: 'websocket', message: '{"type":"ping"}', headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: false }] } });
    store.close();
  });
});
