import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';

// A collection exported in TestPion's format carries its gRPC calls and connections (`savedItems`), and
// importing the file puts them back in the imported collection, so sharing a collection shares all of it.
const home = mkdtempSync(join(tmpdir(), 'tp-share-'));
const be = new Backend({ appDir: home, emit: () => undefined });
afterAll(async () => {
  await be.dispose();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

describe('sharing a collection with its gRPC calls and connections', () => {
  it('exports them in TestPion format, notes them for Postman, and restores them on import', async () => {
    await be.invoke('col.save', { schemaVersion: '1.0', id: 'shop', name: 'Shop', version: 0, variables: [], updatedAt: '', items: [{ kind: 'http', id: 'r1', name: 'Health', request: { method: 'GET', url: 'http://x/health' } }] });
    await be.invoke('lib.save', { kind: 'grpc', library: { folders: [], items: [{ id: 'g1', name: 'Say hi', folder: 'greeter', collectionId: 'shop', data: { target: 'x:1', method: 'a.B/C' } }, { id: 'g2', name: 'Other', collectionId: 'elsewhere', data: { target: 'x:1', method: 'a.B/D' } }] } });
    await be.invoke('lib.save', { kind: 'websocket', library: { folders: [], items: [{ id: 'w1', name: 'Echo', collectionId: 'shop', data: { url: 'ws://x' } }] } });

    // no save dialog in this host: the file comes back to be downloaded (base64), as every other save does
    const native = (await be.invoke('col.export', { id: 'shop', format: 'testpion' })) as { download: { content: string; encoding: string } };
    const exported = JSON.parse(Buffer.from(native.download.content, 'base64').toString('utf8')) as Record<string, any>;
    expect(exported.savedItems.grpc.map((i: any) => i.id)).toEqual(['g1']);
    expect(exported.savedItems.websocket.map((i: any) => i.id)).toEqual(['w1']);
    const postman = (await be.invoke('col.export', { id: 'shop', format: 'postman' })) as { notes: string[] };
    expect(postman.notes.join(' ')).toMatch(/2 gRPC call\(s\) or connection\(s\) aren't in the Postman file/);

    // import the file into the same workspace: the ids clash, so the copies get new ones (nothing replaced)
    const file = { ...exported, id: 'shop-copy', name: 'Shop copy' };
    const r = (await be.invoke('col.import', { text: JSON.stringify(file) })) as { collection: string; savedItems: Record<string, number> };
    expect(r).toMatchObject({ collection: 'Shop copy', savedItems: { grpc: 1, websocket: 1 } });
    const copy = (be.ws.listCollections() as Array<Record<string, unknown>>).find((c) => c.name === 'Shop copy')!;
    expect(copy.savedItems).toBeUndefined();
    const grpc = be.ws.getLibrary('grpc').items;
    expect(grpc.filter((i) => i.collectionId === copy.id)).toEqual([expect.objectContaining({ name: 'Say hi', folder: 'greeter', data: { target: 'x:1', method: 'a.B/C' } })]);
    expect(grpc.find((i) => i.collectionId === copy.id)!.id).not.toBe('g1');
    expect(grpc.find((i) => i.id === 'g1')!.collectionId).toBe('shop');
    expect(be.ws.getLibrary('websocket').items.filter((i) => i.collectionId === copy.id)).toHaveLength(1);
  });
});

describe('duplicating a collection', () => {
  it('copies folders, requests, gRPC calls and connections with new ids', async () => {
    await be.invoke('col.save', { schemaVersion: '1.0', id: 'dup', name: 'Dup', version: 0, variables: [], updatedAt: '', items: [{ kind: 'folder', id: 'f1', name: 'F', items: [{ kind: 'http', id: 'r9', name: 'R', request: { method: 'GET', url: 'http://x' } }] }] });
    const lib = be.ws.getLibrary('grpc');
    await be.invoke('lib.save', { kind: 'grpc', library: { folders: lib.folders, items: [...lib.items, { id: 'gd', name: 'Call', collectionId: 'dup', data: { target: 'x:1', method: 'a.B/C' } }] } });
    const copy = (await be.invoke('col.duplicate', { id: 'dup' })) as { id: string; name: string; items: Array<{ id: string; items: Array<{ id: string }> }> };
    expect(copy.name).toBe('Dup copy');
    expect(copy.id).not.toBe('dup');
    expect(copy.items[0]!.id).not.toBe('f1');
    expect(copy.items[0]!.items[0]!.id).not.toBe('r9');
    const calls = be.ws.getLibrary('grpc').items.filter((i) => i.name === 'Call');
    expect(calls.map((i) => i.collectionId).sort()).toEqual([copy.id, 'dup'].sort());
    expect(((await be.invoke('col.duplicate', { id: 'dup' })) as { name: string }).name).toBe('Dup copy 2');
  });
});
