/**
 * Node ids of collections (folders and requests) are unique in a workspace: the window keys tree rows, open tabs, the
 * active request and menus by them, and two collections that share an id draw rows on top of each other. Everything
 * that brings nodes into a workspace from outside (an import, a copy to another collection, an examples update) gives
 * fresh ids to the ones that are already taken, through `ensureUniqueIds`.
 *
 * Runs anywhere (the engine, the CLI, the window): no Node, no DOM. The caller says how to make a new id.
 */

/** The part of a collection node this needs: an id, a kind and (a folder) its items. */
export interface IdNode {
  id: string;
  kind: string;
  items?: IdNode[];
}

/** Makes a new id: `prefix` is `fld-` for a folder and `req-` for anything else. */
export type NewNodeId = (prefix: 'fld-' | 'req-') => string;

/** Every node id of a tree of folders and requests, depth first. */
export function collectNodeIds(items: readonly IdNode[] | undefined, into: string[] = []): string[] {
  for (const n of items ?? []) {
    if (typeof n?.id === 'string') into.push(n.id);
    if (Array.isArray(n?.items)) collectNodeIds(n.items, into);
  }
  return into;
}

/** Node ids that appear more than once across these collections (each id once, in first-seen order). */
export function duplicateNodeIds(collections: ReadonlyArray<{ items?: readonly IdNode[] }>): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const c of collections) for (const id of collectNodeIds(c.items)) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

/**
 * The collection (or a list of nodes) with fresh ids for every node whose id is in `takenIds` or appears earlier in
 * the same tree. Nothing else changes, and nodes whose id is free keep it (so references to them still work). Pure:
 * the input is not changed; when no id collides, the same object comes back. `renamed` maps each old id to its new
 * one (for a node that was renamed; a second copy inside the same tree maps the first time only).
 */
export function ensureUniqueIds<C extends { items: IdNode[] }>(collection: C, takenIds: Iterable<string>, newId: NewNodeId): { collection: C; renamed: Map<string, string> } {
  const taken = new Set(takenIds);
  const renamed = new Map<string, string>();
  const fresh = (prefix: 'fld-' | 'req-') => {
    let id = newId(prefix);
    // a generator that repeats itself (or a test's counter) never produces a collision either
    for (let i = 2; taken.has(id); i++) id = `${newId(prefix)}-${i}`;
    return id;
  };
  let changed = false;
  const walk = (nodes: IdNode[]): IdNode[] =>
    nodes.map((n) => {
      let next = n;
      if (typeof n.id !== 'string' || !n.id || taken.has(n.id)) {
        const id = fresh(n.kind === 'folder' ? 'fld-' : 'req-');
        if (typeof n.id === 'string' && n.id && !renamed.has(n.id)) renamed.set(n.id, id);
        next = { ...n, id };
        changed = true;
      }
      taken.add(next.id);
      if (Array.isArray(n.items)) {
        const items = walk(n.items);
        if (items.some((x, i) => x !== n.items![i])) next = { ...next, items };
      }
      return next;
    });
  const items = walk(collection.items ?? []);
  return { collection: changed ? ({ ...collection, items } as C) : collection, renamed };
}
