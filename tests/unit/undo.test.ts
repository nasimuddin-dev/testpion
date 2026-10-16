import { afterEach, describe, expect, it, vi } from 'vitest';

// Undo toasts instead of confirmations (lib/undo.ts, lib/undo-delete.ts): an undo runs once, only while offered, the
// latest one is Ctrl/Cmd+Z's; deleted items go back in their place; Recently deleted's newest entry of the item comes back.
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
const calls: Array<[string, unknown]> = [];
let trash: Array<{ id: string; kind: string; itemId: string }> = [];
vi.mock('../../apps/desktop/src/api', () => ({
  call: async (method: string, params: unknown) => {
    calls.push([method, params]);
    if (method === 'trash.list') return trash;
    if (method === 'trash.restore') return { id: 'api', name: 'My API' };
    return undefined;
  },
  asError: (e: unknown) => ({ message: String(e), suggestions: [] }),
  on: () => () => undefined,
  modKey: 'Ctrl',
  isMac: false,
}));

const { offerUndo, undoLatest, hasUndo } = await import('../../apps/desktop/src/lib/undo');
const { putBack, restoreDeleted } = await import('../../apps/desktop/src/lib/undo-delete');
const { restoreFolder } = await import('../../apps/desktop/src/components/FolderList');

afterEach(() => {
  vi.useRealTimers();
  calls.length = 0;
});

describe('undo offers', () => {
  it('runs once, whichever way it is used, and the latest offer is the one Ctrl+Z takes', () => {
    const a = vi.fn();
    const b = vi.fn();
    const done = vi.fn();
    const runA = offerUndo(a);
    offerUndo(b, 8000, done);
    expect(undoLatest()).toBe(true); // b: the latest
    expect(b).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(undoLatest()).toBe(false); // nothing left for the key (a was replaced as "latest")
    runA();
    runA();
    expect(a).toHaveBeenCalledTimes(1); // its own button still works, once
  });

  it('is gone after 8 s', () => {
    vi.useFakeTimers();
    const f = vi.fn();
    const run = offerUndo(f);
    expect(hasUndo()).toBe(true);
    vi.advanceTimersByTime(8001);
    expect(hasUndo()).toBe(false);
    expect(undoLatest()).toBe(false);
    run(); // a click on a toast still on screen is honoured once
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('putting things back', () => {
  it('an item goes back in its place, never twice', () => {
    const list = [{ id: 'a' }, { id: 'c' }];
    expect(putBack(list, { id: 'b' }, 1).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(putBack(list, { id: 'b' }, 99).map((x) => x.id)).toEqual(['a', 'c', 'b']);
    expect(putBack([{ id: 'b' }], { id: 'b' }, 0)).toHaveLength(1);
  });

  it('a folder goes back in its place', () => {
    expect(restoreFolder(['a', 'c'], 'b', 1)).toEqual(['a', 'b', 'c']);
    expect(restoreFolder(['a'], 'b', -1)).toEqual(['a', 'b']);
    expect(restoreFolder(['a', 'b'], 'b', 0)).toEqual(['a', 'b']);
  });

  it('Recently deleted: the newest entry of that item comes back, a dataset by its file name', async () => {
    trash = [
      { id: 'collection/2--api.json', kind: 'collection', itemId: 'api' },
      { id: 'collection/1--api.json', kind: 'collection', itemId: 'api' },
      { id: 'dataset/3--users.csv', kind: 'dataset', itemId: 'users.csv' },
    ];
    await restoreDeleted('collection', 'api');
    expect(calls.at(-1)).toEqual(['trash.restore', { id: 'collection/2--api.json' }]);
    await restoreDeleted('dataset', 'sub/users.csv');
    expect(calls.at(-1)).toEqual(['trash.restore', { id: 'dataset/3--users.csv' }]);
    await expect(restoreDeleted('environment', 'staging')).rejects.toThrow(/no longer in Recently deleted/);
  });
});
