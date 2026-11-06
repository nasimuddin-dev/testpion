/**
 * Several requests of one collection picked at once in the Collections tree (Ctrl/⌘+click toggles one, Shift+click picks
 * the range from the last one, Esc lets go), to run, move or delete together. A pure function of the rows on screen, so
 * the tree and its tests share it.
 */
export interface Picked {
  /** The collection they are in: picking in another collection starts over there. */
  collectionId: string;
  /** Their ids, in the order the tree shows them. */
  ids: string[];
  /** Where a Shift+click range starts: the last one toggled. */
  anchor: string;
}

/**
 * The pick after a Ctrl/⌘+click (`toggle`) or a Shift+click (`range`) on a request. `order`: the ids of the collection's
 * requests in the order the tree shows them (the open ones).
 */
export function pickRequest(current: Picked | undefined, collectionId: string, id: string, how: 'toggle' | 'range', order: readonly string[]): Picked | undefined {
  if (!current || current.collectionId !== collectionId) return { collectionId, ids: [id], anchor: id };
  // in the order shown; a picked one that is hidden now (a closed folder, a filter) stays picked, after them
  const inOrder = (ids: Set<string>) => [...order.filter((x) => ids.has(x)), ...[...ids].filter((x) => !order.includes(x))];
  if (how === 'toggle') {
    const ids = new Set(current.ids);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    return ids.size ? { collectionId, ids: inOrder(ids), anchor: id } : undefined;
  }
  const a = order.indexOf(current.anchor);
  const b = order.indexOf(id);
  if (a < 0 || b < 0) return { collectionId, ids: inOrder(new Set([...current.ids, id])), anchor: id };
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return { collectionId, ids: inOrder(new Set([...current.ids, ...order.slice(lo, hi + 1)])), anchor: current.anchor };
}
