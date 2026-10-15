import { ITEM_KIND_LABEL, LIBRARY_LABEL, itemRefUrl, parseItemRefUrl, toItemRef, type ItemRef, type RefResolution, type RequestProtocol } from '@testpion/shared';
import type { Collection, CollectionNode } from '../types';
import { asError, call, on } from '../api';
import { isRequestView, setPlaceNamer, useApp, type ViewId } from '../store';
import { collectionTreeLoaded, currentCollectionTree } from './collections-store';
import { requestCategory } from './collection-filter';
import { copyText } from './clipboard';
import { historyEditorTarget, refTarget, type RefTarget, type TargetOptions } from './ref-target';
import { forgetItem, rememberItem } from './recent-items';

export type { ItemRef } from '@testpion/shared';

/**
 * "Open this thing", the one way (WF-02): every link, search hit, attention item, git change, history entry, run result,
 * toast and deep link that names an item hands its ItemRef to `openRef`. It checks the item is still there (from what
 * the window already holds when it can, else one indexed `ref.resolve` call), picks the view (ref-target.ts) and opens
 * it there. A ref to something gone (deleted, renamed, from another workspace) says so, with the nearest thing still
 * there as the toast's action, never an empty editor. `<RefLink>` is the inline link that names one.
 */

/* ---------------------------------------------------------------- the collections, indexed by id */

interface NodeInfo {
  name: string;
  folder: boolean;
  protocol?: RequestProtocol;
  /** A request's method (GET, POST …; GQL for GraphQL). */
  method?: string;
  /** Folder names from the collection down. */
  path: string[];
}
// rebuilt only for a list or collection that changed (both are replaced, never mutated, on a change)
const listIndex = new WeakMap<Collection[], Map<string, Collection>>();
const nodeIndex = new WeakMap<Collection, Map<string, NodeInfo>>();

function collectionById(id: string): Collection | undefined {
  const list = currentCollectionTree();
  let m = listIndex.get(list);
  if (!m) listIndex.set(list, (m = new Map(list.map((c) => [c.id, c]))));
  return m.get(id);
}

function nodesOf(c: Collection): Map<string, NodeInfo> {
  let m = nodeIndex.get(c);
  if (m) return m;
  m = new Map();
  const walk = (nodes: CollectionNode[], path: string[]) => {
    for (const n of nodes ?? []) {
      if (n.kind === 'folder') {
        m!.set(n.id, { name: n.name, folder: true, path });
        walk(n.items, [...path, n.name]);
      } else {
        const cat = requestCategory(n);
        m!.set(n.id, { name: n.name, folder: false, protocol: cat === 'graphql' ? 'graphql' : cat === 'soap' ? 'soap' : 'http', method: cat === 'graphql' ? 'GQL' : (n as { request?: { method?: string } }).request?.method, path });
      }
    }
  };
  walk(c.items, []);
  nodeIndex.set(c, m);
  return m;
}

/** A request or folder of a loaded collection, by id: O(1) after the first look at that collection. */
export function lookupNode(collectionId: string, nodeId: string): (NodeInfo & { collection: Collection }) | undefined {
  const c = collectionById(collectionId);
  const n = c && nodesOf(c).get(nodeId);
  return n && { ...n, collection: c! };
}

/**
 * An item's name for Back / Forward and Recent places: a request with its method and collection ("GET List patients ·
 * Veterinary API"), a folder with its collection, else the name and what kind of item it is ("Nightly · Monitor").
 */
export function placeName(ref: ItemRef, label = refLabel(ref)): string {
  if (ref.kind === 'request' || ref.kind === 'folder') {
    const n = lookupNode(ref.collectionId, ref.kind === 'request' ? ref.requestId : ref.folderId);
    return [n?.method, label].filter(Boolean).join(' ') + (n ? ` · ${n.collection.name}` : '');
  }
  if (ref.kind === 'collection') return `${label} · Collection`;
  return label === ITEM_KIND_LABEL[ref.kind] ? label : `${label} · ${ITEM_KIND_LABEL[ref.kind]}`;
}

/** The saved request with this id, in whichever loaded collection holds it (a tab knows only the request's id). */
export function requestRefById(requestId: string): ItemRef | undefined {
  for (const c of currentCollectionTree()) {
    const n = nodesOf(c).get(requestId);
    if (n && !n.folder) return { kind: 'request', collectionId: c.id, requestId, protocol: n.protocol };
  }
  return undefined;
}

/** The item an editor's tab shows (EditorTab `item`: a request, saved call or connection, MCP server, API definition, dataset), as a ref. */
export function refOfEditorItem(view: ViewId, item: string | undefined): ItemRef | undefined {
  if (!item) return undefined;
  switch (view) {
    case 'rest':
    case 'graphql':
      return requestRefById(item);
    case 'grpc':
    case 'websocket':
      return { kind: 'saved', library: view, itemId: item };
    case 'mcp':
      return { kind: 'mcp-server', serverId: item };
    case 'apidef':
      return { kind: 'spec', path: item };
    case 'dataset':
      return { kind: 'dataset', name: item };
    default:
      return undefined;
  }
}

/* ---------------------------------------------------------------- names */

/** A ref's name as the window knows it now (no call): the request's or collection's name, the file's, else its kind. */
export function refLabel(value: ItemRef): string {
  const ref = toItemRef(value);
  if (!ref) return 'Unknown item';
  switch (ref.kind) {
    case 'request':
      return lookupNode(ref.collectionId, ref.requestId)?.name ?? 'Request';
    case 'folder':
      return lookupNode(ref.collectionId, ref.folderId)?.name ?? 'Folder';
    case 'collection':
    case 'mock':
      return `${collectionById(ref.collectionId)?.name ?? 'Collection'}${ref.kind === 'mock' ? ' mock' : ''}`;
    case 'environment':
      return (
        (ref.environmentId && useApp.getState().workspace?.environments.find((e) => e.id === ref.environmentId)?.name) ||
        (ref.scope === 'globals' ? 'Globals' : ref.scope === 'workspace' ? 'Workspace variables' : 'Environments')
      );
    case 'variable':
      return ref.key;
    case 'saved':
      return LIBRARY_LABEL[ref.library] ?? ITEM_KIND_LABEL.saved;
    case 'test':
    case 'flow':
    case 'spec':
    case 'git-file':
      return ref.path.replace(/^.*\//, '');
    case 'dataset':
      return ref.name;
    case 'run':
      return `Run ${ref.runId}`;
    case 'certificate':
      return ref.host;
    case 'test-case':
      return ref.testId;
    case 'doc':
      return ref.url.replace(/^https:\/\//, '');
    default:
      return ITEM_KIND_LABEL[ref.kind];
  }
}

/* ---------------------------------------------------------------- resolving */

const okRef = (ref: ItemRef, label: string): RefResolution => ({ ok: true, ref, label });

/** What the window can tell without a call; undefined when only the backend knows (or to confirm something looks gone). */
function resolveLocally(ref: ItemRef): RefResolution | undefined {
  switch (ref.kind) {
    case 'request':
    case 'folder': {
      if (!collectionTreeLoaded()) return undefined;
      const n = lookupNode(ref.collectionId, ref.kind === 'request' ? ref.requestId : ref.folderId);
      // not in the outline: maybe saved a moment ago, maybe gone; the backend says which
      if (!n || n.folder !== (ref.kind === 'folder')) return undefined;
      return okRef(ref.kind === 'request' ? { ...ref, protocol: n.protocol } : ref, n.name);
    }
    case 'collection':
    case 'mock': {
      const c = collectionTreeLoaded() ? collectionById(ref.collectionId) : undefined;
      return c ? okRef(ref, c.name) : undefined;
    }
    case 'environment': {
      if (!ref.environmentId) return okRef(ref, refLabel(ref));
      const e = useApp.getState().workspace?.environments.find((x) => x.id === ref.environmentId);
      return e ? okRef(ref, e.name) : undefined;
    }
    // nothing to look up: they open where they are (the Debugger checks its own session)
    case 'doc':
    case 'certificate':
    case 'git-file':
    case 'test-case':
    case 'exchange':
      return okRef(ref, refLabel(ref));
    default:
      return undefined;
  }
}

/** Whether a ref still points at something, its name, and the ref with what was looked up filled in (a request's protocol). */
export async function resolveRef(value: unknown): Promise<RefResolution> {
  const ref = toItemRef(value);
  if (!ref) return { ok: false, ref: value as ItemRef, reason: 'invalid', message: 'That is not a link to something in TestPion.' };
  return resolveLocally(ref) ?? call<RefResolution>('ref.resolve', { ref }).catch((e) => ({ ok: false as const, ref, reason: 'unavailable' as const, message: asError(e).message }));
}

/* ---------------------------------------------------------------- opening */

export interface OpenRefOptions extends TargetOptions {
  /** A history entry: send it again from its editor, with what was sent (not the History view). */
  edit?: boolean;
  /** Show the Collections explorer too (it expands to the request that opens). */
  reveal?: boolean;
}

function go(t: RefTarget): void {
  const s = useApp.getState();
  if ('view' in t) s.openIntent(t.view, t.payload);
  else if ('dialog' in t) s.set({ variableUsages: t.key });
  else void call('app.openExternal', { url: t.external }).catch(() => window.open(t.external, '_blank', 'noopener'));
}

/** Say a ref can't be opened, and offer the nearest thing that is still there. */
export function reportUnopenable(r: Extract<RefResolution, { ok: false }>, label?: string): void {
  const s = useApp.getState();
  // the name the window still knows; a generic one ("Request") reads "that request"
  const ref = toItemRef(r.ref);
  const known = ref ? refLabel(ref) : undefined;
  const name =
    label ?? (ref && known && known !== ITEM_KIND_LABEL[ref.kind] && !/^(Request|Folder|Collection)( mock)?$/.test(known) ? known : `that ${ref ? ITEM_KIND_LABEL[ref.kind].toLowerCase() : 'item'}`);
  const next = r.next;
  const action = next
    ? {
        label: next.label,
        onClick: () => {
          if (next.ref) void openRef(next.ref);
          else if (next.view === 'search') s.set({ searchOpen: true });
          else if (next.view) useApp.getState().setView(next.view as ViewId);
        },
      }
    : undefined;
  s.toast(r.reason === 'invalid' ? r.message : `Can't open ${name}: ${r.message}`, 'warning', action);
}

/**
 * For a view whose intent named something it could not load (an older link, a search hit of a request deleted since):
 * say why, with what to open instead, never a silently empty editor.
 */
export async function reportIfGone(value: ItemRef): Promise<void> {
  const r = await call<RefResolution>('ref.resolve', { ref: value }).catch((e) => ({ ok: false as const, ref: value, reason: 'unavailable' as const, message: asError(e).message }));
  if (!r.ok) reportUnopenable(r);
  else useApp.getState().toast(`Could not open ${r.label}: it could not be read. Try again, or open it from the explorer.`, 'warning');
}

/**
 * Open what a ref names in its view. Resolves to whether it opened; when it can't (the item is gone, the link is broken)
 * the person is told why, with the nearest thing still there to open instead.
 */
export async function openRef(value: ItemRef | unknown, opts: OpenRefOptions = {}): Promise<boolean> {
  const r = await resolveRef(value);
  if (!r.ok) {
    if (r.reason !== 'unavailable' && r.reason !== 'invalid') forgetItem(r.ref);
    reportUnopenable(r);
    return false;
  }
  if (r.ref.kind === 'history' && opts.edit) return reopenHistory(r.ref.historyId);
  const t = refTarget(r.ref, opts);
  if (!t) {
    reportUnopenable({ ok: false, ref: r.ref, reason: 'invalid', message: `${refLabel(r.ref)} is a kind of item this version of TestPion can't open.` });
    return false;
  }
  if (opts.reveal) useApp.getState().toggleExplorer(true);
  go(t);
  // Quick Open's and Home's recent items, and the name Back / Recent places show (WF-01 / WF-10)
  rememberItem(r.ref, r.label);
  if ('view' in t) useApp.getState().labelPlace(t.view, placeName(r.ref, r.label));
  return true;
}

/** A history entry in its editor, as it was sent (a GraphQL query with its variables, an MCP tool call, a prompt …). */
async function reopenHistory(historyId: string): Promise<boolean> {
  const e = await call<{ kind: string; name: string; request?: unknown } | null>('history.get', { id: historyId }).catch(() => null);
  if (!e) {
    reportUnopenable({
      ok: false,
      ref: { kind: 'history', historyId },
      reason: 'missing',
      message: 'That history entry is gone (cleared, or from another workspace).',
      next: { label: 'Open History', view: 'history' },
    });
    return false;
  }
  return openHistoryEntry(e, historyId);
}

/** Open a history entry the caller already has in its editor; one without a request to send opens in History. */
export function openHistoryEntry(e: { kind: string; name?: string; request?: unknown }, historyId?: string): boolean {
  const t = historyEditorTarget(e);
  if (t) {
    go(t);
    return true;
  }
  useApp
    .getState()
    .toast(`${e.name ?? 'This entry'} has no request kept to send again`, 'warning', historyId ? { ref: { kind: 'history', historyId }, label: 'Show in History' } : undefined);
  return false;
}

/** Copy the testpion:// link of a ref (it opens the item in the app, from anywhere: a chat, a ticket, `testpion open`). */
export function copyRefLink(ref: ItemRef): Promise<void> {
  return copyText(itemRefUrl(ref), 'Link');
}

/**
 * testpion://open links: the ones that started the app (queued by the desktop shell), then each one that arrives while
 * it runs. Returns the unsubscribe.
 */
export function watchOpenLinks(): () => void {
  const open = (url: string) => {
    const ref = parseItemRefUrl(url);
    if (ref) void openRef(ref);
    else useApp.getState().toast(`Not a TestPion link: ${url.slice(0, 120)}`, 'warning');
  };
  void call<string[]>('app.takeOpenLinks').then(
    (urls) => urls.forEach(open),
    () => undefined,
  );
  return on<{ url: string }>('app.openLink', ({ url }) => open(url));
}

/* ---------------------------------------------------------------- places (Back / Forward, Recent places) */

/** The item a recorded place shows, from its intent payload (an explorer click records a place without a ref). */
export function refOfPlace(view: ViewId, p: Record<string, unknown> | undefined): ItemRef | undefined {
  if (!p) return undefined;
  const s = (k: string) => (typeof p[k] === 'string' && p[k] ? (p[k] as string) : undefined);
  const collectionId = s('collectionId');
  const requestId = s('requestId');
  if (collectionId && requestId) return { kind: 'request', collectionId, requestId };
  if (s('monitorId')) return { kind: 'monitor', monitorId: s('monitorId')! };
  if (s('environmentId')) return { kind: 'environment', environmentId: s('environmentId') };
  if (s('runId')) return { kind: 'run', runId: s('runId')! };
  if (s('historyId')) return { kind: 'history', historyId: s('historyId')! };
  if (s('serverId') && view === 'mcp') return { kind: 'mcp-server', serverId: s('serverId')! };
  if (s('savedId') && (view === 'grpc' || view === 'websocket')) return { kind: 'saved', library: view, itemId: s('savedId')! };
  if (s('path') && view === 'tests') return { kind: 'test', path: s('path')! };
  if (s('path') && view === 'apidef') return { kind: 'spec', path: s('path')! };
  if (collectionId) return { kind: 'collection', collectionId };
  return undefined;
}

// every recorded place gets its item's name (openRef refines it with the name it resolved), and an item the window
// can name joins the recent items however it was opened (an explorer click, a tab, Back)
setPlaceNamer((l) => {
  const ref = refOfPlace(l.view, l.payload);
  if (!ref) return undefined;
  const label = refLabel(ref);
  if (label !== ITEM_KIND_LABEL[ref.kind] && !/^(Request|Folder|Collection)$/.test(label)) rememberItem(ref, label);
  return placeName(ref, label);
});

/**
 * Reveal in sidebar (WF-11): show an item's row in the Collections explorer — its collection and folders open, the row
 * scrolled into view — without opening it. No ref: the item open on screen. Tabs, breadcrumbs and tab menus use it.
 */
export function revealInSidebar(ref?: ItemRef): void {
  const r = ref && toItemRef(ref);
  const id = !r
    ? undefined
    : r.kind === 'request'
      ? r.requestId
      : r.kind === 'folder'
        ? r.folderId
        : r.kind === 'collection'
          ? r.collectionId
          : r.kind === 'saved'
            ? r.itemId
            : r.kind === 'mcp-server'
              ? r.serverId
              : undefined;
  const s = useApp.getState();
  // the explorer is the request editors' sidebar: from another view, go to the editor used last
  if (!isRequestView(s.view)) s.setView(s.lastRequestView);
  s.toggleExplorer(true);
  s.set({ reveal: { id, nonce: Date.now() } });
}
