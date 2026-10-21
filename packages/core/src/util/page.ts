/**
 * One shape for a list that can be long, whatever carries it (an RPC from the window, an MCP tool, the CLI): `limit`
 * (how many), `cursor` (where the last page ended, opaque to the caller), `truncated` (more follow) and `total`.
 */
export interface ListPage<T> {
  items: T[];
  /** How many there are in all (before the page). */
  total: number;
  limit: number;
  /** More follow this page: ask again with `cursor: nextCursor`. */
  truncated: boolean;
  nextCursor?: string;
}

/** The page sizes a list allows: what it gives without a `limit`, and the most it ever gives. */
export interface PageBounds {
  limit: number;
  max: number;
}

export const DEFAULT_PAGE: PageBounds = { limit: 100, max: 1000 };

/** A cursor that names a position (the caller only hands it back). */
export const cursorOf = (offset: number): string => `o${Math.max(0, Math.floor(offset)).toString(36)}`;

/** The position a cursor names; 0 for none, and for one that is not ours. */
export function offsetOfCursor(cursor: string | number | undefined): number {
  if (typeof cursor === 'number') return Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
  const m = typeof cursor === 'string' ? /^o([0-9a-z]{1,10})$/.exec(cursor) : null;
  return m ? parseInt(m[1]!, 36) : 0;
}

/** The limit asked for, kept between 1 and the list's maximum. */
export function pageLimit(asked: number | undefined, b: PageBounds = DEFAULT_PAGE): number {
  return Number.isFinite(asked) && asked! >= 1 ? Math.min(Math.floor(asked!), b.max) : b.limit;
}

/** The page a surface (the CLI, an MCP tool) gives when it is not told: 200, and never more than 1,000. */
export const SURFACE_PAGE: PageBounds = { limit: 200, max: 1000 };

/** `limit`, `cursor` and `offset` as a surface gets them (text from a shell, numbers from JSON), as `pageOf` takes them. */
export function pageArgs(a: { limit?: unknown; cursor?: unknown; offset?: unknown }): { limit?: number; cursor?: string | number } {
  const n = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  const limit = n(a.limit);
  const offset = n(a.offset);
  const cursor = typeof a.cursor === 'string' && a.cursor ? a.cursor : offset !== undefined && Number.isFinite(offset) ? offset : undefined;
  return { ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) };
}

/** The page of a list that a source already cut (`total` of them in all; this slice starts at `offset`). */
export function pageOfSlice<T>(items: T[], total: number, o: { offset?: number; limit: number }): ListPage<T> {
  const offset = o.offset ?? 0;
  const truncated = offset + items.length < total;
  return { items, total, limit: o.limit, truncated, ...(truncated ? { nextCursor: cursorOf(offset + items.length) } : {}) };
}

/** A page of a list already in memory. */
export function pageOf<T>(all: readonly T[], o: { limit?: number; cursor?: string | number } = {}, b: PageBounds = DEFAULT_PAGE): ListPage<T> {
  const limit = pageLimit(o.limit, b);
  const offset = offsetOfCursor(o.cursor);
  const items = all.slice(offset, offset + limit);
  const truncated = offset + items.length < all.length;
  return { items, total: all.length, limit, truncated, ...(truncated ? { nextCursor: cursorOf(offset + items.length) } : {}) };
}
