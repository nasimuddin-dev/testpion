import { beforeAll, describe, expect, it, vi } from 'vitest';

// the toaster draws into a page; here a toast is only a call
vi.mock('sonner', () => ({ toast: Object.assign(() => undefined, { error: () => undefined, success: () => undefined, warning: () => undefined }), Toaster: () => null }));

// WF-10: places name their item (Back / Forward, Recent places), items opened any way are recent, and a closed tab that
// showed a saved item can be reopened — per workspace.
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
}

let scope: typeof import('../../apps/desktop/src/lib/ws-scope');
let store: typeof import('../../apps/desktop/src/store');
let refs: typeof import('../../apps/desktop/src/lib/open-ref');
let closed: typeof import('../../apps/desktop/src/lib/closed-tabs');
let recent: typeof import('../../apps/desktop/src/lib/recent-items');
let collections: typeof import('../../apps/desktop/src/lib/collections-store');

const TREE = [
  {
    id: 'c1',
    name: 'Veterinary API',
    items: [{ kind: 'folder', id: 'f1', name: 'Patients', items: [{ kind: 'http', id: 'r1', name: 'List patients', request: { method: 'GET', url: '/p', headers: [] } }] }],
  },
];

beforeAll(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  // the backend, as the window reaches it: only the collection outline is asked for here
  (globalThis as { window?: unknown }).window = {
    aps: { kind: 'electron', platform: 'win32', invoke: async (m: string) => (m === 'col.tree' ? TREE : []), on: () => () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  (globalThis as { document?: unknown }).document = { addEventListener: () => undefined, removeEventListener: () => undefined, documentElement: { style: {}, classList: { toggle: () => undefined } } };
  scope = await import('../../apps/desktop/src/lib/ws-scope');
  store = await import('../../apps/desktop/src/store');
  refs = await import('../../apps/desktop/src/lib/open-ref');
  closed = await import('../../apps/desktop/src/lib/closed-tabs');
  recent = await import('../../apps/desktop/src/lib/recent-items');
  collections = await import('../../apps/desktop/src/lib/collections-store');
  scope.setDraftScope('vet');
  await collections.refreshCollections();
});

describe('places name their item', () => {
  it('a request with its method and collection; other kinds with what they are', () => {
    expect(refs.placeName({ kind: 'request', collectionId: 'c1', requestId: 'r1' })).toBe('GET List patients · Veterinary API');
    expect(refs.placeName({ kind: 'collection', collectionId: 'c1' })).toBe('Veterinary API · Collection');
    expect(refs.placeName({ kind: 'test', path: 'smoke/a.yaml' })).toBe('a.yaml · Test file');
    expect(refs.refOfPlace('rest', { collectionId: 'c1', requestId: 'r1' })).toEqual({ kind: 'request', collectionId: 'c1', requestId: 'r1' });
    expect(refs.refOfPlace('grpc', { savedId: 's1' })).toEqual({ kind: 'saved', library: 'grpc', itemId: 's1' });
    expect(refs.refOfEditorItem('rest', 'r1')).toMatchObject({ kind: 'request', collectionId: 'c1', requestId: 'r1' });
    expect(refs.refOfEditorItem('mcp', 'srv')).toEqual({ kind: 'mcp-server', serverId: 'srv' });
  });

  it('Back remembers the name; an explorer open joins the recent items', () => {
    const s = store.useApp.getState();
    s.openIntent('rest', { collectionId: 'c1', requestId: 'r1' });
    s.setView('home');
    const back = store.useApp.getState().nav.back;
    expect(back[back.length - 1]?.label).toBe('GET List patients · Veterinary API');
    expect(recent.recentItems()[0]).toMatchObject({ ref: { kind: 'request', requestId: 'r1' }, label: 'List patients' });
    expect(recent.useRecentItems.getState().items[0]?.label).toBe('List patients');
    // opened again from a link (with its protocol hint): still one item
    recent.rememberItem({ kind: 'request', collectionId: 'c1', requestId: 'r1', protocol: 'http' }, 'List patients');
    expect(recent.recentItems().filter((r) => r.ref.kind === 'request')).toHaveLength(1);
  });
});

describe('reopen closed tab', () => {
  it('keeps saved items only, newest last, and per workspace', () => {
    closed.noteClosedTabs([undefined, { ref: { kind: 'monitor', monitorId: 'm1' }, label: 'Nightly' }]);
    closed.noteClosedTabs([{ ref: { kind: 'request', collectionId: 'c1', requestId: 'r1' }, label: 'List patients' }]);
    closed.noteClosedTabs([{ ref: { kind: 'monitor', monitorId: 'm1' }, label: 'Nightly' }]); // again: moves to the end
    expect(closed.useClosedTabs.getState()).toMatchObject({ count: 2, last: { label: 'Nightly' } });
    scope.setDraftScope('examples');
    expect(closed.useClosedTabs.getState().count).toBe(0);
    scope.setDraftScope('vet');
    expect(closed.useClosedTabs.getState().count).toBe(2);
  });
});

describe('reveal in sidebar (WF-11)', () => {
  it('names the row to show and goes to a view with the explorer', () => {
    store.useApp.getState().setView('home');
    refs.revealInSidebar({ kind: 'folder', collectionId: 'c1', folderId: 'f1' });
    const s = store.useApp.getState();
    expect(s.reveal?.id).toBe('f1');
    expect(store.isRequestView(s.view)).toBe(true);
    expect(s.explorerOpen).toBe(true);
    refs.revealInSidebar({ kind: 'saved', library: 'grpc', itemId: 'g1' });
    expect(store.useApp.getState().reveal?.id).toBe('g1');
    refs.revealInSidebar();
    expect(store.useApp.getState().reveal?.id).toBeUndefined();
  });
});
