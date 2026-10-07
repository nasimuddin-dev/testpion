import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, collectionFileContent, makeGitReady, type Collection } from '@testpion/core';

// GIT-101: a collection file changes only when what people wrote changes, so it diffs and merges cleanly in git.
const root = mkdtempSync(join(tmpdir(), 'tp-gitfiles-'));
// best effort: on Windows git can still hold a file for a moment (the temp folder is cleaned up anyway)
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* left for the system's temp cleanup */
  }
});

const base: Collection = {
  schemaVersion: '1.0',
  id: 'shop',
  name: 'Shop',
  version: 0,
  variables: [],
  updatedAt: '',
  items: [{ kind: 'http', id: 'r1', name: 'List', request: { method: 'GET', url: 'https://x/items', headers: [] } }],
} as Collection;

describe('git-friendly collection files', () => {
  it('saving the same content twice leaves the file byte for byte the same', () => {
    const store = WorkspaceStore.create(join(root, 'ws1'), 'One');
    store.saveCollection(base);
    const file = join(root, 'ws1', 'collections', 'shop.json');
    const first = readFileSync(file, 'utf8');
    const saved = store.saveCollection(store.getCollection('shop'));
    expect(readFileSync(file, 'utf8')).toBe(first);
    // the app still sees how often and when it was saved (kept on this computer, not in the file)
    expect(saved.version).toBe(2);
    expect(store.getCollection('shop')).toMatchObject({ version: 2 });
    expect(store.getCollection('shop').updatedAt).not.toBe('');
    expect(first).not.toMatch(/"version"|"updatedAt"/);
    store.close();
  });

  it('writes keys in a fixed order, whatever order the object had', () => {
    const shuffled = { items: base.items, name: 'Shop', id: 'shop', zeta: 1, schemaVersion: '1.0', variables: [], alpha: 2 } as unknown as Collection;
    expect(Object.keys(collectionFileContent(shuffled))).toEqual(['schemaVersion', 'id', 'name', 'variables', 'items', 'alpha', 'zeta']);
  });

  it('an older file that still has version / updatedAt opens with them and loses them on its next save', () => {
    const store = WorkspaceStore.create(join(root, 'ws2'), 'Two');
    const file = join(root, 'ws2', 'collections', 'old.json');
    writeFileSync(file, JSON.stringify({ ...base, id: 'old', version: 7, updatedAt: '2026-01-01T00:00:00.000Z' }, null, 2));
    expect(store.getCollection('old')).toMatchObject({ version: 7, updatedAt: '2026-01-01T00:00:00.000Z' });
    const saved = store.saveCollection(store.getCollection('old'));
    expect(saved.version).toBe(8);
    expect(readFileSync(file, 'utf8')).not.toMatch(/"version"|"updatedAt"/);
    store.close();
  });

  it('a new workspace is git-ready; an older one is made ready once, keeping the user’s own ignore lines', () => {
    const store = WorkspaceStore.create(join(root, 'ws4'), 'Four');
    expect(readFileSync(join(root, 'ws4', '.gitignore'), 'utf8')).toMatch(/^runs\/$/m);
    expect(readFileSync(join(root, 'ws4', '.gitattributes'), 'utf8')).toMatch(/eol=lf/);
    expect(makeGitReady(store)).toMatchObject({ files: [], collections: [] });
    store.close();

    const old = join(root, 'ws5');
    const s5 = WorkspaceStore.create(old, 'Five');
    rmSync(join(old, '.gitattributes'));
    writeFileSync(join(old, '.gitignore'), 'my-notes/\n');
    writeFileSync(join(old, 'collections', 'legacy.json'), JSON.stringify({ ...base, id: 'legacy', version: 3, updatedAt: '2026-01-01T00:00:00.000Z' }));
    const r = makeGitReady(s5);
    expect(r.files.sort()).toEqual(['.gitattributes', '.gitignore']);
    expect(r.collections).toEqual(['collections/legacy.json']);
    expect(readFileSync(join(old, '.gitignore'), 'utf8')).toMatch(/^my-notes\/\n[\s\S]*^\.local\/$/m);
    expect(readFileSync(join(old, 'collections', 'legacy.json'), 'utf8')).not.toMatch(/"version"/);
    expect(s5.getCollection('legacy').version).toBe(4);
    // again: nothing to do
    expect(makeGitReady(s5)).toMatchObject({ files: [], collections: [] });
    s5.close();
  });

  it('editing workspace variables does not rewrite the date in workspace.json', () => {
    const store = WorkspaceStore.create(join(root, 'ws3'), 'Three');
    const file = join(root, 'ws3', 'workspace.json');
    const stamp = JSON.parse(readFileSync(file, 'utf8')).updatedAt;
    store.updateWorkspace({ variables: [{ key: 'a', value: '1', enabled: true }] });
    expect(JSON.parse(readFileSync(file, 'utf8')).updatedAt).toBe(stamp);
    store.close();
  });
});
