import { useCallback, useEffect, useRef, useState } from 'react';

/** A page from the backend: the rows asked for, how many match in all, and whatever else the page carries. */
export interface RowsPage<T> {
  rows: T[];
  total: number;
}

/**
 * Rows the backend pages (a matrix of 5,000 cases, a data run of 100,000 rows) shown in a virtual list: only the
 * pages on screen are held (`keep` pages, oldest dropped first), a page is asked for once while it loads, and a change
 * of `key` (another filter, sort, set of runs) drops them all; an answer for an older key is ignored. `rowAt(i)` gives
 * row i, or undefined while its page loads (the list shows a placeholder). `meta` is the latest page as it came (its
 * aggregates), `error` the latest failure.
 */
export function usePagedRows<T, P extends RowsPage<T>>(fetchPage: (offset: number, limit: number) => Promise<P>, key: string, o: { pageSize?: number; keep?: number } = {}) {
  const size = o.pageSize ?? 200;
  const keep = o.keep ?? 12;
  const pages = useRef(new Map<number, T[]>());
  const loading = useRef(new Set<number>());
  const gen = useRef(0);
  const [meta, setMeta] = useState<P>();
  const [error, setError] = useState<string>();
  const [, setTick] = useState(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const load = useCallback(
    (n: number) => {
      if (loading.current.has(n) || pages.current.has(n)) return;
      loading.current.add(n);
      const g = gen.current;
      fetchRef.current(n * size, size).then(
        (p) => {
          if (g !== gen.current) return; // a page of the key before
          loading.current.delete(n);
          // the newest page last: the oldest is dropped first
          pages.current.delete(n);
          pages.current.set(n, p.rows);
          while (pages.current.size > keep) pages.current.delete(pages.current.keys().next().value!);
          setMeta(p);
          setError(undefined);
          setTick((t) => t + 1);
        },
        (e: unknown) => {
          if (g !== gen.current) return;
          loading.current.delete(n);
          setError(e instanceof Error ? e.message : String(e));
        },
      );
    },
    [size, keep],
  );

  /** Drop every page and read the first again (the key changed, or the data did). */
  const reload = useCallback(() => {
    gen.current++;
    pages.current.clear();
    loading.current.clear();
    load(0);
  }, [load]);

  useEffect(reload, [key, reload]);

  const rowAt = useCallback(
    (i: number): T | undefined => {
      const n = Math.floor(i / size);
      const p = pages.current.get(n);
      if (!p) {
        // asked for while rendering: the request goes out after the render
        queueMicrotask(() => load(n));
        return undefined;
      }
      return p[i % size];
    },
    [size, load],
  );

  /**
   * Read page `n` again, keeping the others (the growing last page of a run that is still going): a full page that is
   * held stays as it is unless `force`; a page already on its way is not asked for twice.
   */
  const refreshPage = useCallback(
    (n: number, o: { force?: boolean } = {}) => {
      const held = pages.current.get(n);
      if (held && (o.force || held.length < size)) pages.current.delete(n);
      load(n);
    },
    [size, load],
  );

  /** The rows of page `n` when it is held (e.g. the first page's columns), without asking for it. */
  const peek = useCallback((n: number): T[] | undefined => pages.current.get(n), []);

  return { meta, total: meta?.total ?? 0, rowAt, reload, refreshPage, peek, pageSize: size, error };
}
