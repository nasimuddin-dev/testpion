import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, callsInFolders, collectionFolders, collectionRealtimeTests, collectionSavedItems, copyCallsWithFolders, importIntoWorkspace, moveCallsWithFolders, placeCollectionCalls } from '../../packages/core/src/index.js';

// A folder's gRPC calls and connections are kept outside the collection file (library/*.json, placed by folderId / after):
// whatever happens to the folder happens to them. And the one-time placement of an older workspace gives the same folder
// ids on every computer, so two people who open it have nothing to merge.

const dir = mkdtempSync(join(tmpdir(), 'tp-calls-folders-'));
const stores: WorkspaceStore[] = [];
afterAll(() => {
  for (const s of stores) s.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const items = [
  { id: 'g1', name: 'Pay', collectionId: 'shop', folderId: 'pay', after: 'r-list' },
  { id: 'g2', name: 'Refund', collectionId: 'shop', folderId: 'refunds', after: 'g1' },
  { id: 'g3', name: 'Top', collectionId: 'shop' },
  { id: 'g4', name: 'Other', collectionId: 'other', folderId: 'pay' },
];

describe('a folder and the calls in it', () => {
  it('finds the calls of a folder and of the folders inside it, in that collection only', () => {
    expect(callsInFolders(items, 'shop', new Set(['pay', 'refunds'])).map((i) => i.id)).toEqual(['g1', 'g2']);
    expect(callsInFolders(items, 'shop', new Set(['nope']))).toEqual([]);
  });

  it('moved to another collection, the calls go with the folder, into the folders as they are named there', () => {
    const moved = moveCallsWithFolders(items, { from: 'shop', to: 'billing', folderIds: new Set(['pay', 'refunds']), renamed: new Map([['pay', 'pay-2'], ['r-list', 'r-list-2']]) });
    expect(moved.map((i) => [i.id, i.collectionId, i.folderId, i.after])).toEqual([
      ['g1', 'billing', 'pay-2', 'r-list-2'],
      ['g2', 'billing', 'refunds', 'g1'],
      ['g3', 'shop', undefined, undefined],
      ['g4', 'other', 'pay', undefined],
    ]);
  });

  it('copied, the calls are copied into the copied folders, each after its copied sibling', () => {
    let n = 0;
    const copied = copyCallsWithFolders(items, { collectionId: 'shop', ids: new Map([['pay', 'pay-copy'], ['refunds', 'refunds-copy'], ['r-list', 'r-list-copy']]), newId: () => `new-${++n}` });
    expect(copied.slice(0, 4)).toEqual(items);
    expect(copied.slice(4).map((i) => [i.id, i.collectionId, i.folderId, i.after])).toEqual([
      ['new-1', 'shop', 'pay-copy', 'r-list-copy'],
      ['new-2', 'shop', 'refunds-copy', 'new-1'],
    ]);
    expect(copyCallsWithFolders(items, { collectionId: 'shop', ids: new Map([['empty', 'x']]), newId: () => 'never' })).toEqual(items);
  });
});

describe('placing the calls of an older workspace', () => {
  const older = (name: string) => {
    const store = WorkspaceStore.create(join(dir, name), 'Older');
    stores.push(store);
    store.saveCollection({ schemaVersion: '1.0', id: 'shop', name: 'Shop', version: 0, variables: [], updatedAt: '', items: [{ kind: 'http', id: 'fld-shop-live', name: 'A request with that id', request: { method: 'GET', url: 'https://x/', headers: [], params: [] } }] } as never);
    store.saveLibrary('grpc', { folders: [], items: [{ id: 'g', name: 'Refund', folder: 'Payments/Refunds', collectionId: 'shop', data: { target: 'x:1', method: 'a.B/C' } }] });
    store.saveLibrary('websocket', { folders: [], items: [{ id: 'w', name: 'Feed', folder: 'Live', collectionId: 'shop', data: { url: 'ws://x' } }] });
    return store;
  };

  it('makes the same folders with the same ids on two computers (nothing for git to merge), whatever ids are taken', () => {
    const [a, b] = [older('a'), older('b')];
    // before the app placed them, a run already finds a call's folder by its path of names (none yet: the top level)
    expect(collectionRealtimeTests(a, a.getCollection('shop'), ['nope'])).toEqual([]);
    expect(placeCollectionCalls(a)).toBe(2);
    expect(placeCollectionCalls(b)).toBe(2);
    const ids = (s: WorkspaceStore) => [...collectionFolders(s.getCollection('shop'))].map(([id, f]) => `${id} = ${f.path.join(' / ')}`);
    expect(ids(a)).toEqual(ids(b));
    // from the collection and the path; an id that is taken gets -2, the same on both
    expect(ids(a)).toEqual(['fld-shop-payments = Payments', 'fld-shop-payments-refunds = Payments / Refunds', 'fld-shop-live-2 = Live']);
    expect(a.getLibrary('grpc').items[0]!.folderId).toBe('fld-shop-payments-refunds');
    // a run of the folder takes the call inside it
    expect(collectionRealtimeTests(a, a.getCollection('shop'), ['fld-shop-payments']).map((t) => t.id)).toEqual(['g']);
  });

  it('a call that names its folder as text runs with that folder even before it is placed', () => {
    const store = older('c');
    store.saveCollection({ ...store.getCollection('shop'), items: [{ kind: 'folder', id: 'live', name: 'Live', items: [] }] } as never);
    expect(collectionRealtimeTests(store, store.getCollection('shop'), ['live']).map((t) => t.id)).toEqual(['w']);
  });
});

describe('a collection exported and imported with its calls', () => {
  it('keeps each call in its folder when the folders get new ids on the way in', () => {
    const store = WorkspaceStore.create(join(dir, 'import'), 'Import');
    stores.push(store);
    // an exported collection file: its calls carry the folder id they had and the folder's path of names
    const file = {
      schemaVersion: '1.0',
      id: 'shop',
      name: 'Shop',
      variables: [],
      items: [{ kind: 'folder', id: 'pay', name: 'Payments', items: [{ kind: 'folder', id: 'refunds', name: 'Refunds', items: [] }] }],
      savedItems: {
        grpc: [
          { id: 'g-here', name: 'Pay', folderId: 'pay', folder: 'Payments', data: { target: 'x:1', method: 'a.B/C' } },
          { id: 'g-gone', name: 'Refund', folderId: 'an-id-this-file-does-not-have', folder: 'Payments/Refunds', data: { target: 'x:1', method: 'a.B/C' } },
        ],
      },
    };
    const r = importIntoWorkspace(store, JSON.stringify(file));
    const c = store.getCollection(r.collection!.id);
    const folders = collectionFolders(c);
    const saved = collectionSavedItems(store, c.id)!.grpc!;
    const pathOf = (name: string) => folders.get(saved.find((i) => i.name === name)!.folderId!)?.path.join(' / ');
    expect(pathOf('Pay')).toBe('Payments');
    expect(pathOf('Refund')).toBe('Payments / Refunds');
  });
});
