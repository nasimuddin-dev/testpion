import { ChevronDown, ChevronRight, Plus, Star } from 'lucide-react';
import { memo, type DragEvent, type RefObject } from 'react';
import { savedItemRef } from '@testpion/shared';
import type { Collection, CollectionFolder, CollectionNode } from '../types';
import type { NodeMenuCtx } from '../lib/node-menu';
import { categoryCounts, type RequestCategory } from '../lib/collection-filter';
import { examplesOpenKey, folderOpenKey, scopedNodeId, type ExtraGroup, type TreeRow } from '../lib/tree-rows';
import { CLOSED_ICON, CountPill, FOLDER_ICON, KIND_COLOR, OPEN_ICON, TreeBadge } from './TreeParts';
import { TreeRowShell } from './TreeRowShell';
import { Button, cx } from './ui';

/*
 * The rows of the Collections tree (CollectionTree draws them through a VirtualList): a collection, a protocol
 * category, a folder, a request, a saved example, a folder of saved gRPC calls or connections and such an item. Every
 * row is the one row (TreeRowShell) with the one menu (lib/node-menu.ts). Each is memoized: a tab switch, a keystroke
 * in the filter or a drag re-renders only the rows whose own props changed (active, renaming, drop target, git mark …).
 * Everything a row calls comes through `ctx`, a ref the tree keeps current, so handlers are never stale.
 */

/** How each category of request looks in the tree. */
export const CATEGORY_META: Record<RequestCategory, { label: string; badge: string; cls: string }> = {
  rest: { label: 'REST', badge: 'HTTP', cls: 'text-ok' },
  soap: { label: 'SOAP', badge: 'SOAP', cls: KIND_COLOR.soap },
  graphql: { label: 'GraphQL', badge: 'GQL', cls: KIND_COLOR.graphql },
  grpc: { label: 'gRPC', badge: 'gRPC', cls: KIND_COLOR.grpc },
  websocket: { label: 'WebSocket & MQTT', badge: 'WS', cls: KIND_COLOR.websocket },
};

/** Drag data of a saved gRPC call or connection in the tree: `{ kind, id, from? }`. */
export const SAVED_ITEM_MIME = 'application/x-testpion-saved-item';

export type DropMode = 'before' | 'into';
type DropProps = { onDragOver(e: DragEvent): void; onDragLeave(): void; onDrop(e: DragEvent): void };

/** What the rows need from the tree, through one ref that is always current. */
export interface RowContext {
  onOpen(c: Collection, n: CollectionNode, o?: { preview?: boolean }): void;
  toggle(id: string, shown: boolean): void;
  /** A request or folder starts being dragged (the tree remembers it for its drop targets) / the drag ended. */
  dragStart(c: Collection, n: CollectionNode): void;
  dragEnd(): void;
  dropProps(c: Collection, id: string, mode: DropMode, place: { beforeId?: string; folderId?: string }): DropProps;
  /** A collection as a drop target: nodes (to its top level) and saved items from another collection. */
  collectionDrop(c: Collection): DropProps;
  savedDragEnd(): void;
  finishRename(c: Collection, id: string, name?: string): void;
  requestMenu(c: Collection, n: Exclude<CollectionNode, CollectionFolder>): NodeMenuCtx;
  folderMenu(c: Collection, n: CollectionFolder): NodeMenuCtx;
  collectionMenu(c: Collection): NodeMenuCtx;
  categoryMenu(c: Collection, cat: RequestCategory, key: string): NodeMenuCtx;
  extraFolderMenu(r: Extract<TreeRow, { t: 'xfolder' }>): NodeMenuCtx;
  newRequest(c: Collection): void;
  newRequestLabel?: string;
}
type Ctx = RefObject<RowContext>;

/** A row's left padding: 12 px per level after the tree's own 8 (`more`: a request's, past where a folder's chevron is). */
const indent = (depth: number, more = 0) => ({ paddingLeft: 8 + depth * 12 + more });

/**
 * One request of the tree. Its saved examples are rows of their own (under it, while open).
 */
export const RequestRow = memo(function RequestRow({
  c,
  n,
  depth,
  active,
  renaming,
  examplesOpen,
  dropMode,
  ctx,
}: {
  c: Collection;
  n: Exclude<CollectionNode, CollectionFolder>;
  depth: number;
  active: boolean;
  renaming: boolean;
  examplesOpen: boolean;
  dropMode?: DropMode;
  ctx: Ctx;
}) {
  const x = () => ctx.current;
  const method = n.kind === 'http' ? n.request.method : 'GQL';
  const examples = n.kind === 'http' ? (n.examples ?? []) : [];
  // one id for this row in the whole tree: two collections may hold nodes with the same id
  const sid = scopedNodeId(c.id, n.id);
  const exKey = examplesOpenKey(c.id, n.id);
  const dropOf = () => x().dropProps(c, sid, 'before', { beforeId: n.id });
  const badge = <TreeBadge label={method} className={n.kind === 'http' ? `method-${method}` : KIND_COLOR.graphql} />;
  return (
    <TreeRowShell
      kind="request"
      nodeId={sid}
      label={n.name}
      depth={depth}
      active={active}
      ctx={() => x().requestMenu(c, n)}
      // every click on a request opens its own tab (Enter is a click on the button, so it opens too)
      onClick={() => x().onOpen(c, n)}
      rename={renaming ? { value: n.name, label: 'Request name', done: (name) => x().finishRename(c, n.id, name) } : undefined}
      drag={[{ kind: 'request', collectionId: c.id, requestId: n.id }]}
      onDragStart={() => x().dragStart(c, n)}
      onDragEnd={() => x().dragEnd()}
      drop={{ onDragOver: (e) => dropOf().onDragOver(e), onDragLeave: () => dropOf().onDragLeave(), onDrop: (e) => dropOf().onDrop(e), over: dropMode }}
      style={indent(depth, 16)}
      className={cx(examples.length > 0 && 'relative')}
      git={{ kind: 'request', collectionId: c.id, requestId: n.id }}
    >
      {examples.length > 0 && (
        // in the row's left padding (the row is positioned), where a folder's chevron would be
        <span
          role="button"
          tabIndex={-1}
          className="absolute inset-y-0 flex items-center w-3.5 text-muted hover:text-fg"
          style={{ left: 9 + depth * 12 }}
          aria-label={examplesOpen ? 'Hide examples' : `Show ${examples.length} examples`}
          aria-expanded={examplesOpen}
          onClick={(e) => {
            e.stopPropagation();
            x().toggle(exKey, examplesOpen);
          }}
        >
          {examplesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      )}
      {badge}
      <span className="truncate">{n.name}</span>
      {n.favorite && <Star size={11} className="shrink-0 text-warn fill-current" aria-label="Favorite" data-favorite />}
    </TreeRowShell>
  );
});

/** A folder of a collection: its chevron, its name, a dot when it has scripts or variables, and how many requests it holds. */
export const FolderRow = memo(function FolderRow({ c, n, depth, open, renaming, dropMode, ctx }: { c: Collection; n: CollectionFolder; depth: number; open: boolean; renaming: boolean; dropMode?: DropMode; ctx: Ctx }) {
  const x = () => ctx.current;
  const sid = scopedNodeId(c.id, n.id);
  const dropOf = () => x().dropProps(c, sid, 'into', { folderId: n.id });
  const counts = categoryCounts(n.items);
  return (
    <TreeRowShell
      kind="folder"
      nodeId={sid}
      label={n.name}
      depth={depth}
      expanded={open}
      ctx={() => x().folderMenu(c, n)}
      onClick={() => x().toggle(folderOpenKey(c.id, n.id), open)}
      rename={renaming ? { value: n.name, label: 'Folder name', done: (name) => x().finishRename(c, n.id, name) } : undefined}
      drag={[{ kind: 'folder', collectionId: c.id, folderId: n.id }]}
      onDragStart={() => x().dragStart(c, n)}
      onDragEnd={() => x().dragEnd()}
      drop={{ onDragOver: (e) => dropOf().onDragOver(e), onDragLeave: () => dropOf().onDragLeave(), onDrop: (e) => dropOf().onDrop(e), over: dropMode }}
      style={indent(depth)}
      git={{ kind: 'folder', collectionId: c.id, folderId: n.id }}
    >
      {open ? OPEN_ICON : CLOSED_ICON}
      {FOLDER_ICON}
      <span className="truncate">{n.name}</span>
      {(n.preRequestScript || n.testScript || n.variables?.length || (n as { logic?: true }).logic) && <span className="w-1.5 h-1.5 rounded-full bg-accent/70 shrink-0" title="Has folder scripts or variables" />}
      <span className="ml-auto pl-1">
        <CountPill n={counts.rest + counts.soap + counts.graphql} />
      </span>
    </TreeRowShell>
  );
});

/** A protocol category of a collection (REST, SOAP, GraphQL, gRPC, WebSocket & MQTT): create here, fold, run the collection. */
export const CategoryRow = memo(function CategoryRow({ c, cat, count, open, id, dropMode, ctx }: { c: Collection; cat: RequestCategory; count: number; open: boolean; id: string; dropMode?: DropMode; ctx: Ctx }) {
  const x = () => ctx.current;
  const droppable = cat === 'rest' || cat === 'soap' || cat === 'graphql';
  const dropOf = () => x().dropProps(c, `${c.id}:${cat}`, 'into', {});
  return (
    <TreeRowShell
      kind="category"
      nodeId={id}
      label={CATEGORY_META[cat].label}
      depth={1}
      expanded={open}
      ctx={() => x().categoryMenu(c, cat, id)}
      onClick={() => x().toggle(id, open)}
      drop={droppable ? { onDragOver: (e) => dropOf().onDragOver(e), onDragLeave: () => dropOf().onDragLeave(), onDrop: (e) => dropOf().onDrop(e), over: dropMode } : undefined}
      style={{ paddingLeft: 20 }}
    >
      {open ? OPEN_ICON : CLOSED_ICON}
      <TreeBadge label={CATEGORY_META[cat].badge} className={CATEGORY_META[cat].cls} />
      <span className="truncate font-medium">{CATEGORY_META[cat].label}</span>
      <CountPill n={count} />
    </TreeRowShell>
  );
});

/** A collection: its name, how many of its sent requests fail now, and its id when another collection has its name. */
export const CollectionRow = memo(function CollectionRow({ c, open, renaming, dropMode, failing, sent, duplicate, ctx }: { c: Collection; open: boolean; renaming: boolean; dropMode?: DropMode; failing?: number; sent?: number; duplicate: boolean; ctx: Ctx }) {
  const x = () => ctx.current;
  const dropOf = () => x().collectionDrop(c);
  return (
    <TreeRowShell
      kind="collection"
      nodeId={c.id}
      label={c.name}
      depth={0}
      expanded={open}
      menu={!c.problem}
      ctx={() => x().collectionMenu(c)}
      onClick={() => x().toggle(c.id, open)}
      rename={renaming ? { value: c.name, label: 'Collection name', done: (name) => x().finishRename(c, c.id, name) } : undefined}
      drop={{ onDragOver: (e) => dropOf().onDragOver(e), onDragLeave: () => dropOf().onDragLeave(), onDrop: (e) => dropOf().onDrop(e), over: dropMode }}
      className="pl-1.5 font-medium"
      git={{ kind: 'collection', collectionId: c.id }}
    >
      {open ? OPEN_ICON : CLOSED_ICON}
      <span className={cx('truncate', c.problem && 'text-bad')} title={c.problem}>
        {c.name}
      </span>
      {failing ? (
        <span className="shrink-0 text-[0.65rem] font-semibold px-1 rounded bg-bad/15 text-bad" title={`${failing} of ${sent} sent requests: the latest response failed`}>
          {failing}
        </span>
      ) : null}
      {/* two collections with one name (an import done twice): their ids tell them apart */}
      {duplicate && (
        <span className="text-[0.7rem] text-muted font-normal mono truncate shrink-0 max-w-[40%]" title="Another collection has this name; this is its id">
          {c.id}
        </span>
      )}
    </TreeRowShell>
  );
});

/** A folder of saved gRPC calls / connections: the same row (and menu) as a collection's folders. */
export const ExtraFolderRow = memo(function ExtraFolderRow({ r, ctx }: { r: Extract<TreeRow, { t: 'xfolder' }>; ctx: Ctx }) {
  const x = () => ctx.current;
  return (
    <TreeRowShell
      kind={r.g.cat === 'websocket' ? 'folder:ws-connection' : 'folder:grpc-call'}
      nodeId={r.key}
      label={r.folder}
      depth={r.depth}
      expanded={r.open}
      ctx={() => x().extraFolderMenu(r)}
      onClick={() => x().toggle(r.key, r.open)}
      style={indent(r.depth)}
      git={{ folder: r.g.cat === 'websocket' ? 'ws-connection' : 'grpc-call', name: r.folder }}
    >
      {r.open ? OPEN_ICON : CLOSED_ICON}
      {FOLDER_ICON}
      <span className="truncate">{r.folder}</span>
      <span className="ml-auto pl-1">
        <CountPill n={r.count} />
      </span>
    </TreeRowShell>
  );
});

/** A saved gRPC call or connection, shown under its collection. */
export const ExtraItemRow = memo(function ExtraItemRow({ g, i, depth, from, id, active, renaming, ctx }: { g: ExtraGroup; i: ExtraGroup['items'][number]; depth: number; from?: string; id: string; active: boolean; renaming: boolean; ctx: Ctx }) {
  const x = () => ctx.current;
  const kind = g.cat === 'grpc' ? 'grpc-call' : 'ws-connection';
  const rn = () => g.rename?.(i.id);
  return (
    <TreeRowShell
      kind={kind}
      nodeId={id}
      label={i.name}
      depth={depth}
      active={active}
      menu={!!g.menu}
      ctx={() => g.menu?.(i.id) ?? { on: {} }}
      onClick={() => g.onOpen(i.id)}
      onOpen={() => g.onOpen(i.id)}
      rename={renaming ? { value: i.name, done: (name) => rn()?.done(name) } : undefined}
      drag={[{ kind: 'saved', library: g.cat, itemId: i.id }]}
      // a saved item dragged onto another collection moves there (CollectionTree's collectionDrop reads this)
      onDragStart={(e) => e.dataTransfer.setData(SAVED_ITEM_MIME, JSON.stringify({ kind: g.cat, id: i.id, from }))}
      onDragEnd={() => x().savedDragEnd()}
      style={indent(depth, 16)}
      git={savedItemRef(g.cat, i.id)}
    >
      <TreeBadge label={i.badge ?? CATEGORY_META[g.cat].badge} className={CATEGORY_META[g.cat].cls} />
      <span className="truncate">{i.name}</span>
    </TreeRowShell>
  );
});

/** A saved example of a request: opens the request (its Examples tab). */
export function ExampleRow({ r, ctx }: { r: Extract<TreeRow, { t: 'example' }>; ctx: Ctx }) {
  return (
    <button
      data-node-id={r.key}
      className="w-full flex items-center gap-2 h-8 text-xs rounded-md mx-1 pr-2 hover:bg-hover text-left text-muted hover:text-fg"
      style={{ paddingLeft: 8 + r.depth * 12 + 28 }}
      title="Saved example: opens the request (see its Examples tab)"
      onClick={() => ctx.current.onOpen(r.c, r.n)}
    >
      <span className={cx('mono font-bold w-9 shrink-0', r.ex.status < 300 ? 'text-ok' : r.ex.status < 400 ? 'text-warn' : 'text-bad')}>{r.ex.status}</span>
      <span className="truncate">{r.ex.name}</span>
    </button>
  );
}

/** A collection with nothing in it yet: a first request, one click away. */
export function EmptyRow({ r, ctx }: { r: Extract<TreeRow, { t: 'empty' }>; ctx: Ctx }) {
  return (
    <div className="pl-7 pr-3 h-8 flex items-center gap-2" data-node-id={r.key}>
      <p className="text-xs text-muted truncate">No requests yet.</p>
      <Button size="sm" icon={<Plus size={12} />} onClick={() => ctx.current.newRequest(r.c)}>
        {ctx.current.newRequestLabel ?? 'New HTTP request'}
      </Button>
    </div>
  );
}
