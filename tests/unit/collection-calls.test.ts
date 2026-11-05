import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, callFolderPath, collectionFolders, duplicateCollection, interleave, placeCollectionCalls } from '../../packages/core/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'tp-calls-'));
const stores: WorkspaceStore[] = [];
afterAll(() => {
  for (const s of stores) s.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('any kind of request in any folder', () => {
  it('interleaves the calls of a folder with its requests: after their sibling, a chain kept, the rest at the end by name', () => {
    const nodes = [{ id: 'r1' }, { id: 'f1' }, { id: 'r2' }];
    const calls = [
      { id: 'g1', name: 'Zed', after: 'r1' },
      { id: 'g2', name: 'Next', after: 'g1' },
      { id: 'g3', name: 'Beta' },
      { id: 'g4', name: 'Alpha', after: 'gone' },
      { id: 'g5', name: 'Loop', after: 'g6' },
      { id: 'g6', name: 'Loop 2', after: 'g5' },
    ];
    const order = interleave(nodes, calls).map((x) => ('node' in x ? x.node.id : x.call.id));
    expect(order).toEqual(['r1', 'g1', 'g2', 'f1', 'r2', 'g4', 'g3', 'g5', 'g6']);
  });

  it('a text folder of an older version becomes the collection folder of that path, made when missing, once', () => {
    const store = WorkspaceStore.create(join(dir, 'ws'), 'Calls');
    stores.push(store);
    store.saveCollection({ schemaVersion: '1.0', id: 'shop', name: 'Shop', version: 0, variables: [], updatedAt: '', items: [{ kind: 'folder', id: 'pay', name: 'Payments', items: [] }] } as never);
    store.saveLibrary('grpc', {
      folders: [],
      items: [
        { id: 'g-refund', name: 'Refund', folder: 'payments / Refunds', collectionId: 'shop', data: {} },
        { id: 'g-pay', name: 'Pay', folder: 'Payments', collectionId: 'shop', data: {} },
        { id: 'g-top', name: 'Health', collectionId: 'shop', data: {} },
        { id: 'g-lost', name: 'Lost', folder: 'X', collectionId: 'no-such-collection', data: {} },
      ],
    });
    store.saveLibrary('websocket', { folders: [], items: [{ id: 'w-feed', name: 'Feed', folder: 'Live', collectionId: 'shop', data: {} }] });
    expect(placeCollectionCalls(store)).toBe(3);
    const c = store.getCollection('shop');
    const folders = collectionFolders(c);
    const byPath = new Map([...folders.values()].map((f) => [f.path.join(' / '), f.folder.id]));
    expect([...byPath.keys()].sort()).toEqual(['Live', 'Payments', 'Payments / Refunds']);
    const grpc = new Map(store.getLibrary('grpc').items.map((i) => [i.id, i]));
    expect(grpc.get('g-pay')!.folderId).toBe('pay');
    expect(grpc.get('g-refund')!.folderId).toBe(byPath.get('Payments / Refunds'));
    // the text stays for an older app; an item without a text, or in a collection that is not there, is left alone
    expect(grpc.get('g-refund')!.folder).toBe('payments / Refunds');
    expect(grpc.get('g-top')!.folderId).toBeUndefined();
    expect(grpc.get('g-lost')!.folderId).toBeUndefined();
    expect(store.getLibrary('websocket').items[0]!.folderId).toBe(byPath.get('Live'));
    // a second time: nothing to do
    expect(placeCollectionCalls(store)).toBe(0);
    expect(callFolderPath(c, grpc.get('g-refund')!)).toBe('Payments / Refunds');
    expect(callFolderPath(c, { folder: 'Old text' })).toBe('Old text');
    // a copy of the collection: the copied calls sit in the copied folders, after the copied siblings
    store.saveLibrary('grpc', { folders: [], items: store.getLibrary('grpc').items.map((i) => (i.id === 'g-pay' ? { ...i, after: 'g-refund' } : i)) });
    let n = 0;
    const copy = duplicateCollection(store, 'shop', () => `new-${++n}`);
    const copyFolders = collectionFolders(store.getCollection(copy.id));
    const copied = store.getLibrary('grpc').items.filter((i) => i.collectionId === copy.id);
    const pay = copied.find((i) => i.name === 'Pay')!;
    const refund = copied.find((i) => i.name === 'Refund')!;
    expect(copyFolders.get(pay.folderId!)?.path).toEqual(['Payments']);
    expect(copyFolders.get(refund.folderId!)?.path).toEqual(['Payments', 'Refunds']);
    expect(pay.after).toBe(refund.id);
  });
});
