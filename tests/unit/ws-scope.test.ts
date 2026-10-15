import { beforeAll, describe, expect, it } from 'vitest';

// the window's storage, as the renderer sees it
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  keys() {
    return [...this.m.keys()];
  }
}
const storage = new MemoryStorage();

let scope: typeof import('../../apps/desktop/src/lib/ws-scope');
let drafts: typeof import('../../apps/desktop/src/lib/draft-store');
let docs: typeof import('../../apps/desktop/src/lib/docs');

beforeAll(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  // tabs saved before state was kept per workspace: one set for the whole window
  storage.setItem('aps.draft.rest', JSON.stringify({ tabs: [{ id: 't1', name: 'Old tab' }], active: 't1' }));
  storage.setItem('aps.docs', JSON.stringify({ docs: { graphql: ['main', 'd1'] }, active: { graphql: 'd1' } }));
  scope = await import('../../apps/desktop/src/lib/ws-scope');
  drafts = await import('../../apps/desktop/src/lib/draft-store');
  docs = await import('../../apps/desktop/src/lib/docs');
});

describe('window state is kept per workspace', () => {
  it('reads nothing and writes nothing while no workspace is open', () => {
    expect(drafts.loadDraft('rest')).toBeUndefined();
    drafts.saveDraft('rest', { tabs: [] });
    drafts.flushDrafts();
    expect(storage.keys().filter((k) => k.startsWith('aps.draft.ws:'))).toEqual([]);
    expect(docs.useDocs.getState().docs).toEqual({});
  });

  it('moves the pre-workspace tabs and documents into the first workspace opened', () => {
    scope.setDraftScope('mvh');
    expect(drafts.loadDraft<{ active: string }>('rest')?.active).toBe('t1');
    expect(storage.getItem('aps.draft.rest')).toBeNull();
    expect(docs.useDocs.getState().docs.graphql).toEqual(['main', 'd1']);
    expect(storage.getItem('aps.docs')).toBeNull();
  });

  it('switching workspace shows that workspace’s own tabs, never the other’s', () => {
    drafts.saveDraft('rest', { tabs: [{ id: 'm1', name: 'MVH request' }], active: 'm1' }); // still pending
    scope.setDraftScope('examples');
    expect(drafts.loadDraft('rest')).toBeUndefined();
    expect(docs.useDocs.getState().docs).toEqual({});
    drafts.saveDraft('rest', { tabs: [{ id: 'e1', name: 'Examples request' }], active: 'e1' });
    docs.useDocs.getState().newDoc('grpc');

    scope.setDraftScope('mvh');
    // what was pending when the workspace changed was written under the workspace it was typed in
    expect(drafts.loadDraft<{ active: string }>('rest')?.active).toBe('m1');
    expect(docs.useDocs.getState().docs.grpc).toBeUndefined();

    scope.setDraftScope('examples');
    expect(drafts.loadDraft<{ active: string }>('rest')?.active).toBe('e1');
    expect(docs.useDocs.getState().docs.grpc).toEqual(['main']);
  });

  it('dropping a draft only drops it in the open workspace', () => {
    drafts.dropDraft('rest');
    expect(drafts.loadDraft('rest')).toBeUndefined();
    scope.setDraftScope('mvh');
    expect(drafts.loadDraft<{ active: string }>('rest')?.active).toBe('m1');
  });
});
