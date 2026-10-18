import { beforeEach, describe, expect, it } from 'vitest';
import { isTreeOpen, migrateOldTreeKeys, setSubtree, setTreeOpen, treeOpenOf } from '../../apps/desktop/src/lib/tree-state';
import { setDraftScope } from '../../apps/desktop/src/lib/ws-scope';

/** The window's storage, in memory (the store reads and writes it as the browser's localStorage). */
class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
}

let ls: MemoryStorage;
beforeEach(() => {
  ls = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
  setDraftScope(undefined);
});

describe('tree state (one store per workspace)', () => {
  it('moves the three old stores into the first workspace that opens, once', () => {
    ls.setItem('aps.tree.open', JSON.stringify({ 'col-1': true, 'col-1:f1': false }));
    ls.setItem('aps.explorer.sections.v2', JSON.stringify({ mcp: false, 'mcp:folder:Public': true }));
    ls.setItem('aps.folders.monitors', JSON.stringify({ Nightly: true, Smoke: false }));
    ls.setItem('aps.unrelated', '1');
    setDraftScope('ws-a');
    expect(treeOpenOf('collections')).toEqual({ 'col-1': true, 'col-1:f1': false });
    expect(treeOpenOf('explorer')).toEqual({ mcp: false, 'mcp:folder:Public': true });
    // a FolderList kept which folders were collapsed: now what is open
    expect(treeOpenOf('list:monitors')).toEqual({ Nightly: false, Smoke: true });
    expect(ls.getItem('aps.tree.open')).toBeNull();
    expect(ls.getItem('aps.folders.monitors')).toBeNull();
    expect(ls.getItem('aps.unrelated')).toBe('1');
    expect(JSON.parse(ls.getItem('ws:ws-a:aps.tree-state')!)).toHaveProperty('collections');
    // another workspace starts empty (the old stores moved into the first one)
    setDraftScope('ws-b');
    expect(treeOpenOf('collections')).toEqual({});
  });

  it('keeps each workspace’s state apart, across restarts', () => {
    setDraftScope('ws-a');
    setTreeOpen('collections', (o) => ({ ...o, 'col-1': false }));
    setDraftScope('ws-b');
    expect(isTreeOpen('collections', 'col-1')).toBe(true);
    setTreeOpen('collections', (o) => ({ ...o, 'col-1': true, x: false }));
    setDraftScope('ws-a');
    expect(isTreeOpen('collections', 'col-1')).toBe(false);
    expect(isTreeOpen('collections', 'x')).toBe(true);
  });

  it('setSubtree opens or closes a container and everything in it, in one change; trees keep their own objects', () => {
    setDraftScope('ws-a');
    const explorer = treeOpenOf('explorer');
    setSubtree('collections', ['col-1', 'col-1:f1', 'col-1:f2'], true);
    expect(treeOpenOf('collections')).toEqual({ 'col-1': true, 'col-1:f1': true, 'col-1:f2': true });
    expect(treeOpenOf('explorer')).toBe(explorer);
    const before = treeOpenOf('collections');
    setSubtree('collections', ['col-1', 'col-1:f1'], true);
    expect(treeOpenOf('collections')).toBe(before);
    setSubtree('collections', ['col-1', 'col-1:f1', 'col-1:f2'], false);
    expect(Object.values(treeOpenOf('collections'))).toEqual([false, false, false]);
  });

  it('reads a broken store as empty, and migrates nothing when there is nothing to migrate', () => {
    ls.setItem('ws:ws-c:aps.tree-state', '{not json');
    setDraftScope('ws-c');
    expect(treeOpenOf('collections')).toEqual({});
    expect(migrateOldTreeKeys(new MemoryStorage())).toEqual({});
  });

  it('drops writes while no workspace is open', () => {
    setTreeOpen('collections', () => ({ a: false }));
    expect(ls.length).toBe(0);
  });
});
