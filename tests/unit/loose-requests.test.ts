import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { adoptLooseRequests, listTrash, purgeTrash, requireCollectionFor, restoreFromTrash, WorkspaceStore, type LibraryItem } from '../../packages/core/src/index.js';
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

  it('leaves the items of a collection in the trash alone; they come back with it, and are purged with it', () => {
    const s = fresh('trash');
    s.saveCollection(collection('old', 'Old'));
    s.saveCollection(collection('other', 'Other'));
    s.saveLibrary('grpc', { folders: [], items: [item('g1', { collectionId: 'old' }), item('g2', { collectionId: 'other' }), item('g3', { collectionId: 'purged-long-ago' })] });
    s.deleteCollection('old');
    const r = adoptLooseRequests(s);
    // the one whose collection is gone for good is adopted; the one in the trash waits for its collection
    expect(r.collections.map((c) => [c.name, c.items.map((i) => i.id)])).toEqual([['gRPC calls', ['g3']]]);
    expect(s.getLibrary('grpc').items.find((i) => i.id === 'g1')!.collectionId).toBe('old');

    const entry = listTrash(s).find((t) => t.itemId === 'old')!;
    restoreFromTrash(s, entry.id);
    expect(s.getCollection('old').name).toBe('Old');
    expect(s.getLibrary('grpc').items.find((i) => i.id === 'g1')!.collectionId).toBe('old');

    s.deleteCollection('old');
    purgeTrash(s, listTrash(s).find((t) => t.itemId === 'old')!.id);
    expect(
      s
        .getLibrary('grpc')
        .items.map((i) => i.id)
        .sort(),
    ).toEqual(['g2', 'g3']);

    // emptying the whole trash deletes them too
    s.deleteCollection('other');
    purgeTrash(s);
    expect(s.getLibrary('grpc').items.map((i) => i.id)).toEqual(['g3']);
  });

  it('a restored collection that gets a new id takes its items with it', () => {
    const s = fresh('restore');
    s.saveCollection(collection('api', 'API'));
    s.saveLibrary('websocket', { folders: [], items: [item('w1', { collectionId: 'api' })] });
    s.deleteCollection('api');
    s.saveCollection(collection('api-2', 'API'));
    const r = restoreFromTrash(s, listTrash(s)[0]!.id);
    expect(r.id).not.toBe('api');
    expect(s.getLibrary('websocket').items[0]!.collectionId).toBe(r.id);
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
