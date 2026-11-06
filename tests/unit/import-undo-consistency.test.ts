import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceStore, collectionFolders, importIntoWorkspace, listTrash, restoreFromTrash, undoImportReceipt } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// What Undo of an import takes back is exactly what the import wrote, and what it sends to Recently deleted comes back whole.
const tmp = tempDir('tp-import-undo-');
const stores: WorkspaceStore[] = [];
afterAll(() => {
  for (const s of stores) s.close();
  tmp.cleanup();
});
const workspace = (name: string) => {
  const s = WorkspaceStore.create(join(tmp.dir, name), name);
  stores.push(s);
  return s;
};

// an exported TestPion collection with a gRPC call in a folder and a connection that names its folder as text
const collectionFile = (id = 'shop') =>
  JSON.stringify({
    schemaVersion: '1.0',
    id,
    name: 'Shop',
    variables: [],
    items: [{ kind: 'folder', id: 'pay', name: 'Payments', items: [] }],
    savedItems: {
      grpc: [{ id: 'g-pay', name: 'Pay', folderId: 'pay', data: { target: 'x:1', method: 'a.B/C' } }],
      websocket: [{ id: 'w-feed', name: 'Feed', folder: 'Live', data: { url: 'ws://x' } }],
    },
  });

const spec = (version: string) => `openapi: 3.0.0\ninfo:\n  title: Petstore\n  version: "${version}"\npaths:\n  /pets:\n    get:\n      responses:\n        "200":\n          description: ok\n`;

describe('an imported collection with gRPC calls and connections', () => {
  it('places only its own calls, and Undo right after is not refused: the receipt has the version the collection ends with', () => {
    const store = workspace('place');
    // a call of another collection that still waits for its folder: this import leaves it alone
    store.saveCollection({ schemaVersion: '1.0', id: 'other', name: 'Other', version: 0, variables: [], updatedAt: '', items: [] } as never);
    store.saveLibrary('grpc', { folders: [], items: [{ id: 'g-other', name: 'Other call', folder: 'Elsewhere', collectionId: 'other', data: {} }] });

    const r = importIntoWorkspace(store, collectionFile());
    const c = store.getCollection(r.collection!.id);
    // the folder made for the connection is in the collection the caller gets, with the version that is on disk
    expect([...collectionFolders(r.collection!).values()].map((f) => f.path.join(' / ')).sort()).toEqual(['Live', 'Payments']);
    expect(r.collection!.version).toBe(c.version);
    expect(r.receipt!.collections).toEqual([{ id: c.id, name: 'Shop', version: c.version }]);
    const feed = store.getLibrary('websocket').items.find((i) => i.id === 'w-feed')!;
    expect(collectionFolders(c).get(feed.folderId!)?.path).toEqual(['Live']);
    expect(feed.folder).toBeUndefined();
    expect(store.getLibrary('grpc').items.find((i) => i.id === 'g-other')).toMatchObject({ folder: 'Elsewhere' });
    expect(store.getLibrary('grpc').items.find((i) => i.id === 'g-other')!.folderId).toBeUndefined();
    expect(collectionFolders(store.getCollection('other')).size).toBe(0);

    const undone = undoImportReceipt(store, r.receipt!.id);
    expect(undone.refused).toBeUndefined();
    expect(undone.trashed.map((t) => t.kind)).toEqual(['collection']);
  });

  it('Undo sends the calls to Recently deleted with the collection: restoring it brings them back', () => {
    const store = workspace('undo-calls');
    const r = importIntoWorkspace(store, collectionFile());
    expect(store.getLibrary('grpc').items.map((i) => i.id)).toEqual(['g-pay']);
    const undone = undoImportReceipt(store, r.receipt!.id);
    expect(store.listCollections()).toEqual([]);
    expect(store.getLibrary('grpc').items).toEqual([]);
    expect(store.getLibrary('websocket').items).toEqual([]);

    const back = restoreFromTrash(store, undone.trashed[0]!.trashId);
    expect(back).toMatchObject({ kind: 'collection', id: r.collection!.id, name: 'Shop' });
    expect(store.getLibrary('grpc').items.map((i) => [i.id, i.collectionId, i.folderId])).toEqual([['g-pay', back.id, 'pay']]);
    expect(store.getLibrary('websocket').items.map((i) => [i.id, i.collectionId])).toEqual([['w-feed', back.id]]);
  });

  it('a collection imported with the id of one in Recently deleted does not get that one`s calls, and each comes back with its own', () => {
    const store = workspace('same-id');
    const first = importIntoWorkspace(store, collectionFile()).collection!;
    store.deleteCollection(first.id);
    const second = importIntoWorkspace(store, JSON.stringify({ schemaVersion: '1.0', id: first.id, name: 'Shop again', variables: [], items: [] })).collection!;
    // the deleted collection's calls are in its trash entry, not in the library: nothing attaches to the new one
    expect(second.id).toBe(first.id);
    expect(store.getLibrary('grpc').items).toEqual([]);
    const back = restoreFromTrash(store, listTrash(store).find((t) => t.kind === 'collection')!.id);
    expect(back.id).not.toBe(first.id);
    expect(store.getLibrary('grpc').items.map((i) => i.collectionId)).toEqual([back.id]);
    expect(store.getLibrary('websocket').items.map((i) => i.collectionId)).toEqual([back.id]);
  });
});

describe('an imported API definition', () => {
  it('a document that was there already is not this import`s: Undo leaves it, and the first import`s contract checks keep their file', () => {
    const store = workspace('spec-reused');
    const first = importIntoWorkspace(store, spec('1'));
    const again = importIntoWorkspace(store, spec('1'));
    expect(first.receipt!.specs).toEqual(['specs/petstore.openapi.yaml']);
    expect(again.specPath).toBe('specs/petstore.openapi.yaml');
    expect(again.receipt!.specs).toEqual([]);

    const undone = undoImportReceipt(store, again.receipt!.id);
    expect(undone.trashed.map((t) => t.kind)).toEqual(['collection']);
    expect(readFileSync(store.path('specs', 'petstore.openapi.yaml'), 'utf8')).toBe(spec('1'));
    expect(JSON.stringify(store.getCollection(first.collection!.id))).toContain('specs/petstore.openapi.yaml');
    // the import that wrote it takes it back
    expect(
      undoImportReceipt(store, first.receipt!.id)
        .trashed.map((t) => t.kind)
        .sort(),
    ).toEqual(['collection', 'spec']);
    expect(existsSync(store.path('specs', 'petstore.openapi.yaml'))).toBe(false);
  });

  it('replace: Undo puts the replaced document back at its path', () => {
    const store = workspace('spec-replaced');
    importIntoWorkspace(store, spec('1'));
    const r = importIntoWorkspace(store, spec('2'), { specs: 'replace' });
    expect(r.receipt!.specsReplaced).toEqual([r.specReplaced]);
    expect(readFileSync(store.path('specs', 'petstore.openapi.yaml'), 'utf8')).toBe(spec('2'));

    undoImportReceipt(store, r.receipt!.id);
    expect(readFileSync(store.path('specs', 'petstore.openapi.yaml'), 'utf8')).toBe(spec('1'));
    // the import's own document is in Recently deleted, the replaced one no longer is
    expect(
      listTrash(store)
        .filter((t) => t.kind === 'spec')
        .map((t) => t.itemId),
    ).toEqual(['specs/petstore.openapi.yaml']);
    expect(existsSync(store.path('specs', 'petstore.openapi-restored.yaml'))).toBe(false);
  });
});

describe('an environment a re-import added variables to', () => {
  const env = (vars: Array<[string, string]>) => JSON.stringify({ name: 'Dev', values: vars.map(([key, value]) => ({ key, value, enabled: true })), _postman_variable_scope: 'environment' });

  it('Undo removes the added variables that are still as written, and keeps every edit made since', () => {
    const store = workspace('env');
    importIntoWorkspace(store, env([['a', '1']]));
    const r = importIntoWorkspace(
      store,
      env([
        ['a', '2'],
        ['b', '3'],
        ['c', '4'],
      ]),
      { update: true },
    );
    expect(r.receipt!.envUpdated![0]!.added).toEqual([
      { key: 'b', value: '3' },
      { key: 'c', value: '4' },
    ]);
    // since the import: a changed, c given another value, d added by hand
    const dev = () => store.listEnvironments().find((e) => e.name === 'Dev')!;
    store.saveEnvironment({
      ...dev(),
      variables: [...dev().variables.map((v) => (v.key === 'a' ? { ...v, value: 'edited' } : v.key === 'c' ? { ...v, value: 'mine' } : v)), { key: 'd', value: '5', enabled: true }],
    });

    const undone = undoImportReceipt(store, r.receipt!.id);
    expect(dev().variables.map((v) => [v.key, v.value])).toEqual([
      ['a', 'edited'],
      ['c', 'mine'],
      ['d', '5'],
    ]);
    expect(undone.removed.join(' | ')).toMatch(/1 added variable of environment "Dev"/);
    expect(undone.removed.join(' | ')).toMatch(/1 variable added to environment "Dev" stays/);
  });
});
