import { dedupeKeys, type DuplicateKey, type ListKey } from './unique-keys';

/**
 * Which rows a fixed-row-height virtual list draws (VirtualList): the rows on screen plus `overscan` above and below,
 * clamped to the list, and `keepIndex` too when it is outside them (the row being dragged stays mounted, so its
 * `dragend` still reaches React when the list scrolls or changes during the drag).
 */
export function listWindow(o: { count: number; rowHeight: number; scrollTop: number; height: number; overscan: number; keepIndex?: number }): { start: number; end: number; indexes: number[] } {
  const rh = o.rowHeight > 0 ? o.rowHeight : 1;
  const start = Math.min(o.count, Math.max(0, Math.floor(o.scrollTop / rh) - o.overscan));
  const end = Math.max(start, Math.min(o.count, Math.ceil((o.scrollTop + o.height) / rh) + o.overscan));
  const indexes: number[] = [];
  for (let i = start; i < end; i++) indexes.push(i);
  const k = o.keepIndex;
  if (k !== undefined && Number.isInteger(k) && k >= 0 && k < o.count && (k < start || k >= end)) indexes.push(k);
  return { start, end, indexes };
}

/** The keys of the rows drawn (`keyOf`, else the index), unique among them: a repeat gets a suffix (unique-keys). */
export function windowKeys<T>(items: readonly T[], indexes: readonly number[], keyOf?: (item: T, index: number) => ListKey): { keys: ListKey[]; duplicates: DuplicateKey[] } {
  const raw = indexes.map((i) => (keyOf ? keyOf(items[i]!, i) : i));
  const r = dedupeKeys(raw);
  // positions in the list, not in the window
  return { keys: r.keys, duplicates: r.duplicates.map((d) => ({ ...d, first: indexes[d.first]!, second: indexes[d.second]! })) };
}
