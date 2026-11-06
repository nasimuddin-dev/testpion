/**
 * Any kind of request in any folder of a collection (core storage/collection-calls.ts): the order of one folder's children
 * when gRPC calls and connections (kept in the library, placed by `folderId` and `after`) sit among its requests. Shared by
 * the app's tree and the engine.
 */

/**
 * The children of one folder (or of the collection's top level) in the order the tree shows them: the collection's own
 * nodes in their order, each call right after its `after` sibling (calls that follow one another keep their chain), and
 * the calls without a sibling that is still there at the end, by name.
 */
/** `after` of a call placed first in its folder, before the folder's requests. */
export const AT_START = '^';

export function interleave<N extends { id: string }, I extends { id: string; name: string; after?: string }>(nodes: readonly N[], calls: readonly I[]): Array<{ node: N } | { call: I }> {
  const ids = new Set<string>([...nodes.map((n) => n.id), ...calls.map((c) => c.id)]);
  const following = new Map<string, I[]>();
  const loose: I[] = [];
  for (const c of calls) {
    if (c.after && c.after !== c.id && (ids.has(c.after) || c.after === AT_START)) following.set(c.after, [...(following.get(c.after) ?? []), c]);
    else loose.push(c);
  }
  const out: Array<{ node: N } | { call: I }> = [];
  const seen = new Set<string>();
  const addCall = (c: I) => {
    if (seen.has(c.id)) return; // a cycle of `after`s: each once
    seen.add(c.id);
    out.push({ call: c });
    for (const next of following.get(c.id) ?? []) addCall(next);
  };
  for (const c of following.get(AT_START) ?? []) addCall(c);
  for (const n of nodes) {
    out.push({ node: n });
    for (const c of following.get(n.id) ?? []) addCall(c);
  }
  for (const c of [...loose].sort((a, b) => a.name.localeCompare(b.name))) addCall(c);
  // calls in a cycle of `after`s that nothing outside it reaches: still shown, at the end
  for (const c of calls) addCall(c);
  return out;
}

/** The ids of a folder's children in the order the tree shows them (`interleave`). */
export const shownOrder = <N extends { id: string }, I extends { id: string; name: string; after?: string }>(nodes: readonly N[], calls: readonly I[]): string[] =>
  interleave(nodes, calls).map((x) => ('node' in x ? x.node.id : x.call.id));

/** The sibling shown right before this one in its folder (none: it is the first, or it is not there). */
export function siblingBefore<N extends { id: string }, I extends { id: string; name: string; after?: string }>(nodes: readonly N[], calls: readonly I[], id: string): string | undefined {
  const order = shownOrder(nodes, calls);
  const at = order.indexOf(id);
  return at > 0 ? order[at - 1] : undefined;
}

/**
 * A request, a folder or a call is deleted or moved away: the calls that followed it now follow what it followed
 * (`predecessorId`, see `siblingBefore`; none: it was the first of its folder, and so are they now). Without this they
 * would name a sibling that is gone and fall to the end of their folder. Items that do not change are returned as they are.
 */
export function repointAfter<I extends { id: string; after?: string }>(items: readonly I[], removedId: string, predecessorId?: string): I[] {
  return items.map((i) => (i.after === removedId && i.id !== removedId ? { ...i, after: predecessorId ?? AT_START } : i));
}

/**
 * An item dropped just before a sibling of a folder (`moved`: a call, or with `node` a request or folder): where it goes,
 * and which calls follow something else now. `nodes` and `calls` are the folder's children, the moved item among them
 * when it is reordered inside its folder.
 *
 * `beforeNode`: the request or folder a moved request or folder is inserted before (none: at the end of the folder).
 * `after`: the new `after` of every call that changes: the moved call's own (always there), the calls that followed the moved item
 * (they follow what it followed), and the calls between the two requests around the drop, each pinned to the sibling
 * shown before it, so that none of them changes place or falls to the end.
 */
export function placeBefore<N extends { id: string }, I extends { id: string; name: string; after?: string }>(
  nodes: readonly N[],
  calls: readonly I[],
  moved: { id: string; node?: boolean },
  beforeId: string,
): { beforeNode?: string; after: Map<string, string> } {
  const after = new Map<string, string>();
  const wasHere = nodes.some((n) => n.id === moved.id) || calls.some((c) => c.id === moved.id);
  const restNodes = nodes.filter((n) => n.id !== moved.id);
  const rest = (wasHere ? repointAfter(calls, moved.id, siblingBefore(nodes, calls, moved.id)) : [...calls]).filter((c) => c.id !== moved.id);
  const shown = shownOrder(restNodes, rest);
  const at = shown.indexOf(beforeId);
  if (at < 0) return { after };
  const next = [...shown.slice(0, at), moved.id, ...shown.slice(at)];
  const isNode = new Set(restNodes.map((n) => n.id));
  if (moved.node) isNode.add(moved.id);
  // the calls around the drop: from the request before it to the request after it
  let from = at;
  while (from > 0 && !isNode.has(next[from - 1]!)) from--;
  let to = at + 1;
  while (to < next.length && !isNode.has(next[to]!)) to++;
  const now = new Map<string, string | undefined>(rest.map((c) => [c.id, c.after]));
  for (let k = from; k < to; k++) if (!isNode.has(next[k]!)) now.set(next[k]!, k > 0 ? next[k - 1]! : AT_START);
  const was = new Map(calls.map((c) => [c.id, c.after]));
  for (const [id, a] of now) if (a !== undefined && (a !== was.get(id) || id === moved.id)) after.set(id, a);
  return { beforeNode: moved.node ? next.slice(at + 1).find((id) => isNode.has(id)) : undefined, after };
}

/** A gRPC call or connection as the library keeps it, as far as its place goes. */
export interface PlacedCall {
  id: string;
  collectionId?: string;
  folderId?: string;
  after?: string;
}

/** The calls of a collection that sit in one of these folders (a folder and the folders inside it). */
export const callsInFolders = <I extends PlacedCall>(items: readonly I[], collectionId: string, folderIds: ReadonlySet<string>): I[] =>
  items.filter((i) => i.collectionId === collectionId && !!i.folderId && folderIds.has(i.folderId));

/**
 * Folders moved to another collection take their calls with them: the calls in `folderIds` now belong to `to`, in the
 * same folders (`renamed`: the folders and requests that got a new id on the way).
 */
export function moveCallsWithFolders<I extends PlacedCall>(items: readonly I[], o: { from: string; to: string; folderIds: ReadonlySet<string>; renamed?: ReadonlyMap<string, string> }): I[] {
  const now = (id?: string) => (id ? (o.renamed?.get(id) ?? id) : id);
  return items.map((i) => (i.collectionId === o.from && i.folderId && o.folderIds.has(i.folderId) ? { ...i, collectionId: o.to, folderId: now(i.folderId), ...(i.after ? { after: now(i.after) } : {}) } : i));
}

/**
 * Folders copied (Duplicate): a copy of every call inside them, in the copied folders, after the copied siblings.
 * `ids`: old id → new id of every copied folder and request; `newId` names the copied calls.
 */
export function copyCallsWithFolders<I extends PlacedCall>(items: readonly I[], o: { collectionId: string; ids: ReadonlyMap<string, string>; newId(): string; to?: string }): I[] {
  const mine = items.filter((i) => i.collectionId === o.collectionId && !!i.folderId && o.ids.has(i.folderId));
  if (!mine.length) return [...items];
  const all = new Map(o.ids);
  for (const i of mine) all.set(i.id, o.newId());
  const now = (id?: string) => (id ? (all.get(id) ?? id) : id);
  return [...items, ...mine.map((i) => ({ ...i, id: all.get(i.id)!, collectionId: o.to ?? o.collectionId, folderId: now(i.folderId), ...(i.after ? { after: now(i.after) } : {}) }))];
}
