import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { adoptLooseRequests, importIntoWorkspace, listTrash, purgeTrash, requireCollectionFor, restoreFromTrash, WorkspaceStore, type LibraryItem } from '../../packages/core/src/index.js';
import { copyExample, tempDir } from '../helpers.js';

// A saved request always belongs to a collection: gRPC calls and connections saved outside one by older versions
// are moved into collections named after their folders when the workspace opens.
const tmp = tempDir('tp-loose-');
const stores: WorkspaceStore[] = [];
afterAll(() => {
  for (const s of stores)
    try {
      s.close();
    } catch {
      /* closed by the test */
    }
  tmp.cleanup();
});
const collection = (id: string, name: string) => ({ schemaVersion: '1.0', id, name, version: 0, variables: [], updatedAt: '', items: [] }) as never;
const item = (id: string, extra: Partial<LibraryItem> = {}): LibraryItem => ({ id, name: id.toUpperCase(), data: { url: `ws://${id}` }, ...extra });
const fresh = (name: string) => {
  const s = WorkspaceStore.create(join(tmp.dir, name), name);
  stores.push(s);
  return s;
};
const byName = (s: WorkspaceStore, name: string) => s.listCollections().find((c) => c.name === name);

describe('adoptLooseRequests', () => {
  it('groups loose items by folder into collections named after it, reusing one with exactly that name', () => {
    const s = fresh('group');
    s.saveCollection(collection('pay', 'Payments'));
    s.saveCollection(collection('kept', 'Kept'));
    s.saveLibrary('grpc', {
      folders: ['Payments', 'Greeter', 'Unused'],
      items: [item('g1', { folder: 'Payments' }), item('g2', { folder: 'Greeter' }), item('g3'), item('g4', { collectionId: 'kept', folder: 'Inner' })],
    });
    s.saveLibrary('websocket', { folders: ['Payments'], items: [item('w1', { folder: 'Payments' }), item('w2')] });

    const r = adoptLooseRequests(s);
    expect(r.moved).toBe(5);
    expect(r.collections.map((c) => [c.name, c.created, c.items.map((i) => i.id).sort()])).toEqual(
      expect.arrayContaining([
        ['Payments', false, ['g1', 'w1']],
        ['Greeter', true, ['g2']],
        ['gRPC calls', true, ['g3']],
        ['Connections', true, ['w2']],
      ]),
    );
    const grpc = s.getLibrary('grpc');
    const at = (id: string) => grpc.items.find((i) => i.id === id)!;
    expect(at('g1')).toMatchObject({ collectionId: 'pay' });
    expect(at('g1').folder).toBeUndefined();
    expect(at('g2').collectionId).toBe(byName(s, 'Greeter')!.id);
    expect(at('g3').collectionId).toBe(byName(s, 'gRPC calls')!.id);
    // an item already in a collection keeps its collection and folder
    expect(at('g4')).toMatchObject({ collectionId: 'kept', folder: 'Inner' });
    // the folders that became collections are gone; an unrelated empty folder stays
    expect(grpc.folders).toEqual(['Inner', 'Unused']);
    expect(s.getLibrary('websocket').items.find((i) => i.id === 'w2')!.collectionId).toBe(byName(s, 'Connections')!.id);
    expect(s.getLibrary('websocket').folders).toEqual([]);
  });

  it('is idempotent and runs on open (listed with the migrations)', () => {
    const root = join(tmp.dir, 'open');
    const s = fresh('open');
    s.saveLibrary('websocket', { folders: [], items: [item('w1', { folder: 'Chat' })] });
    s.close();
    const opened = WorkspaceStore.open(root);
    stores.push(opened);
    expect(opened.adoptedRequests?.moved).toBe(1);
    expect(opened.migrationsApplied.join()).toMatch(/1 gRPC call \/ connection moved into collections \(Chat, new\)/);
    const before = JSON.stringify([opened.listCollections().map((c) => c.id), opened.getLibrary('websocket')]);
    expect(adoptLooseRequests(opened)).toEqual({ moved: 0, collections: [] });
    expect(JSON.stringify([opened.listCollections().map((c) => c.id), opened.getLibrary('websocket')])).toBe(before);
    const again = WorkspaceStore.open(root);
    stores.push(again);
    expect(again.adoptedRequests).toBeUndefined();
    expect(again.listCollections().filter((c) => c.name === 'Chat')).toHaveLength(1);
  });

  const ids = (s: WorkspaceStore, kind: string) =>
    s
      .getLibrary(kind)
      .items.map((i) => i.id)
      .sort();

  it('a deleted collection takes its items with it: out of the library, back on restore, gone when purged', () => {
    const s = fresh('trash');
    s.saveCollection(collection('old', 'Old'));
    s.saveCollection(collection('other', 'Other'));
    s.saveLibrary('grpc', { folders: [], items: [item('g1', { collectionId: 'old', folderId: 'f', after: 'r1' }), item('g2', { collectionId: 'other' }), item('g3', { collectionId: 'purged-long-ago' })] });
    s.saveLibrary('websocket', { folders: [], items: [item('w1', { collectionId: 'old' })] });
    s.deleteCollection('old');
    // nothing of the deleted collection is left in the committed files
    expect(ids(s, 'grpc')).toEqual(['g2', 'g3']);
    expect(ids(s, 'websocket')).toEqual([]);
    const entry = listTrash(s).find((t) => t.itemId === 'old')!;
    // (its size counts the calls it carries)
    expect(entry.size).toBe(2);
    // the one whose collection is gone for good is adopted
    const r = adoptLooseRequests(s);
    expect(r.collections.map((c) => [c.name, c.items.map((i) => i.id)])).toEqual([['gRPC calls', ['g3']]]);

    restoreFromTrash(s, entry.id);
    expect(s.getCollection('old').name).toBe('Old');
    expect((s.getCollection('old') as unknown as Record<string, unknown>).trashedCalls).toBeUndefined();
    expect(s.getLibrary('grpc').items.find((i) => i.id === 'g1')).toMatchObject({ collectionId: 'old', folderId: 'f', after: 'r1' });
    expect(s.getLibrary('websocket').items.find((i) => i.id === 'w1')).toMatchObject({ collectionId: 'old' });

    s.deleteCollection('old');
    purgeTrash(s, listTrash(s).find((t) => t.itemId === 'old')!.id);
    expect(ids(s, 'grpc')).toEqual(['g2', 'g3']);
    expect(ids(s, 'websocket')).toEqual([]);

    // emptying the whole trash: the same
    s.deleteCollection('other');
    purgeTrash(s);
    expect(ids(s, 'grpc')).toEqual(['g3']);
  });

  it('on another computer (no trash entry) a deleted collection leaves nothing to adopt', () => {
    const a = fresh('deleted-here');
    a.saveCollection(collection('api', 'API'));
    a.saveLibrary('grpc', { folders: [], items: [item('g1', { collectionId: 'api' })] });
    a.deleteCollection('api');
    // what git carries to the other computer: the collections folder and the libraries, never the trash
    const b = fresh('deleted-there');
    b.saveLibrary('grpc', a.getLibrary('grpc'));
    expect(adoptLooseRequests(b)).toEqual({ moved: 0, collections: [] });
    expect(b.listCollections()).toEqual([]);
  });

  it('a restored collection keeps its id when only its name is taken again, and gets a new one when its id is: its items follow', () => {
    const s = fresh('restore');
    s.saveCollection(collection('api', 'API'));
    s.saveLibrary('websocket', { folders: [], items: [item('w1', { collectionId: 'api' })] });
    s.deleteCollection('api');
    s.saveCollection(collection('api-2', 'API'));
    const named = restoreFromTrash(s, listTrash(s)[0]!.id);
    expect(named).toMatchObject({ id: 'api', name: 'API (restored)' });
    expect(s.getLibrary('websocket').items[0]!.collectionId).toBe('api');

    // the id is taken again: a new id, and the calls (one of them under an id the library uses again) go with it
    s.deleteCollection('api');
    s.saveCollection(collection('api', 'Another'));
    s.saveLibrary('websocket', { folders: [], items: [item('w1', { collectionId: 'api' })] });
    const r = restoreFromTrash(s, listTrash(s)[0]!.id);
    expect(r.id).not.toBe('api');
    const lib = s.getLibrary('websocket').items;
    expect(lib).toHaveLength(2);
    expect(lib.find((i) => i.id === 'w1')!.collectionId).toBe('api');
    expect(lib.find((i) => i.id !== 'w1')!.collectionId).toBe(r.id);
  });

  it('a call that a stale copy of the library wrote back is not doubled when its collection is restored', () => {
    const s = fresh('stale');
    s.saveCollection(collection('api', 'API'));
    s.saveLibrary('websocket', { folders: [], items: [item('w1', { collectionId: 'api' })] });
    const stale = s.getLibrary('websocket');
    s.deleteCollection('api');
    s.saveLibrary('websocket', { folders: stale.folders, items: stale.items });
    restoreFromTrash(s, listTrash(s)[0]!.id);
    expect(s.getLibrary('websocket').items.map((i) => [i.id, i.collectionId])).toEqual([['w1', 'api']]);
  });

  it('two deleted collections with one id each keep their own items: purging one leaves the other whole', () => {
    const s = fresh('same-id');
    s.saveCollection(collection('api', 'First'));
    s.saveLibrary('grpc', { folders: [], items: [item('g-first', { collectionId: 'api' })] });
    s.deleteCollection('api');
    s.saveCollection(collection('api', 'Second'));
    s.saveLibrary('grpc', { folders: [], items: [item('g-second', { collectionId: 'api' })] });
    s.deleteCollection('api');
    purgeTrash(s, listTrash(s).find((t) => t.name === 'First')!.id);
    const r = restoreFromTrash(s, listTrash(s).find((t) => t.name === 'Second')!.id);
    expect(r).toMatchObject({ id: 'api', name: 'Second' });
    expect(s.getLibrary('grpc').items.map((i) => [i.id, i.collectionId])).toEqual([['g-second', 'api']]);
  });

  describe('a trash entry of an older version (its calls stayed in the library)', () => {
    const older = (name: string) => {
      const s = fresh(name);
      s.saveLibrary('grpc', { folders: [], items: [item('g1', { collectionId: 'old' }), item('g2', { collectionId: 'gone-for-good' })] });
      mkdirSync(s.path('trash', 'collections'), { recursive: true });
      const entry = `${Date.now()}--old.json`;
      writeFileSync(s.path('trash', 'collections', entry), JSON.stringify({ schemaVersion: '1.0', id: 'old', name: 'Old', variables: [], items: [] }));
      return { s, trashId: `collection/${entry}` };
    };

    it('its calls wait for it, come back with it, and never show up in a collection made or imported with its id', () => {
      const { s, trashId } = older('legacy-restore');
      const r = adoptLooseRequests(s);
      expect(r.collections.map((c) => c.items.map((i) => i.id))).toEqual([['g2']]);
      expect(s.getLibrary('grpc').items.find((i) => i.id === 'g1')!.collectionId).toBe('old');
      // an import of a collection with the id of the deleted one: a new id, the hidden call is not its own
      const imported = importIntoWorkspace(s, JSON.stringify({ schemaVersion: '1.0', id: 'old', name: 'Imported', variables: [], items: [] })).collection!;
      expect(imported.id).not.toBe('old');
      expect(s.getLibrary('grpc').items.filter((i) => i.collectionId === imported.id)).toEqual([]);
      expect(restoreFromTrash(s, trashId)).toMatchObject({ id: 'old', name: 'Old' });
      expect(s.getLibrary('grpc').items.find((i) => i.id === 'g1')!.collectionId).toBe('old');
    });

    it('purged, its calls are deleted with it', () => {
      const { s, trashId } = older('legacy-purge');
      purgeTrash(s, trashId);
      expect(ids(s, 'grpc')).toEqual(['g2']);
    });
  });

  it('two computers that open the same older workspace make the same collections and the same library', () => {
    const files = (s: WorkspaceStore) => [...readdirSync(s.path('collections')).sort().map((f) => [f, readFileSync(s.path('collections', f), 'utf8')]), JSON.stringify(s.getLibrary('grpc').items.map(({ updatedAt: _at, ...i }) => i))];
    const make = (name: string) => {
      const s = fresh(name);
      s.saveCollection(collection('chat', 'Taken id'));
      s.saveLibrary('grpc', { folders: ['Chat', 'Billing'], items: [item('g1', { folder: 'Chat' }), item('g2', { folder: 'Billing' }), item('g3')] });
      adoptLooseRequests(s);
      return s;
    };
    const [a, b] = [make('same-a'), make('same-b')];
    expect(files(a)).toEqual(files(b));
    // from the name; an id that is taken gets -2
    expect(a.listCollections().map((c) => `${c.id} = ${c.name}`).sort()).toEqual(['billing = Billing', 'chat = Taken id', 'chat-2 = Chat', 'grpc-calls = gRPC calls']);
  });

  it('the shipped public example has no loose items', () => {
    const root = copyExample('public-workspace', join(tmp.dir, 'public'));
    const s = WorkspaceStore.open(root);
    stores.push(s);
    expect(s.adoptedRequests).toBeUndefined();
  });
});

describe('saving needs a collection', () => {
  it('requireCollectionFor names the collections', () => {
    const s = fresh('require');
    s.saveCollection(collection('a', 'Alpha'));
    expect(() => requireCollectionFor(s, 'grpc', [{ name: 'Say hi' }])).toThrow(/Choose a collection to save the gRPC call "Say hi"/);
    try {
      requireCollectionFor(s, 'websocket', [{ name: 'Echo' }]);
    } catch (e) {
      expect((e as { suggestions?: string[] }).suggestions?.[0]).toMatch(/Collections: .*Alpha/);
    }
    // other kinds (AI prompts, monitors …) don't belong to collections
    expect(() => requireCollectionFor(s, 'ai-prompts', [{ name: 'x' }])).not.toThrow();
    expect(() => requireCollectionFor(s, 'grpc', [{ name: 'x', collectionId: 'a' }])).not.toThrow();
  });

  it('lib.save refuses a new gRPC call or connection without a collection', async () => {
    const home = join(tmp.dir, 'home');
    const be = new Backend({ appDir: home, emit: () => undefined });
    try {
      await expect(be.invoke('lib.save', { kind: 'websocket', library: { folders: [], items: [item('w1')] } })).rejects.toThrow(/Choose a collection/);
      await be.invoke('col.save', collection('c1', 'One'));
      await be.invoke('lib.save', { kind: 'websocket', library: { folders: [], items: [item('w1', { collectionId: 'c1' })] } });
      // nor can one be taken out of its collection
      await expect(be.invoke('lib.save', { kind: 'websocket', library: { folders: [], items: [item('w1')] } })).rejects.toThrow(/Choose a collection/);
      // other kinds save as before
      await be.invoke('lib.save', { kind: 'ai-prompts', library: { folders: [], items: [item('p1')] } });
    } finally {
      await be.dispose();
    }
  });
});
