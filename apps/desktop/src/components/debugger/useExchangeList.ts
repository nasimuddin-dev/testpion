import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, on } from '../../api';
import type { Exchange } from './model';

/** The grid's filter: everything but a search in headers and bodies is applied in the window. */
export interface ListFilter {
  application: string;
  type: string;
  text: string;
  deep: boolean;
  host: string;
  method: string;
  status: '' | 'ok' | 'redirect' | 'client-error' | 'server-error' | 'error';
  bookmarked: boolean;
}

interface Changes {
  epoch: number;
  rev: number;
  reset: boolean;
  rows: Exchange[];
  firstSeq?: number;
  total: number;
}

const statusOk = (e: Exchange, st: ListFilter['status']) => {
  const s = e.status ?? 0;
  return st === 'ok' ? s >= 200 && s < 300 : st === 'redirect' ? s >= 300 && s < 400 : st === 'client-error' ? s >= 400 && s < 500 : st === 'server-error' ? s >= 500 : !!e.error;
};

/** The rows a filter keeps (the same rules as debug.exchanges); a deep search passes the ids the backend found. */
export function filterRows(all: Exchange[], f: ListFilter, deepIds?: Set<string>): Exchange[] {
  const needle = f.text.trim().toLowerCase();
  const host = f.host.toLowerCase();
  const method = f.method.toUpperCase();
  const type = f.type.toLowerCase();
  if (!needle && !host && !method && !type && !f.application && !f.status && !f.bookmarked) return all;
  return all.filter((e) => {
    if (host && !e.host.toLowerCase().includes(host)) return false;
    if (method && e.method !== method) return false;
    if (f.bookmarked && !e.bookmarked) return false;
    if (f.application && (e.application ?? '') !== f.application) return false;
    if (type && (e.contentType ?? '').split(';')[0]!.trim().toLowerCase() !== type) return false;
    if (f.status && !statusOk(e, f.status)) return false;
    if (needle) {
      if (f.deep) return !!deepIds?.has(e.id);
      return `${e.method} ${e.url} ${e.application ?? ''} ${e.contentType ?? ''} ${e.status ?? ''}`.toLowerCase().includes(needle);
    }
    return true;
  });
}

/**
 * The Debugger's list, kept in sync by changes: the first call brings every row, then each `debug.exchange` signal
 * asks only for the rows added or changed since (a capture of thousands of requests does not resend the list on
 * every new one). Rows are lean: headers as sizes, no bodies; the selected exchange is read whole on its own.
 */
export function useExchangeList(filter: ListFilter) {
  const store = useRef({ epoch: -1, rev: 0, byId: new Map<string, Exchange>(), busy: false, again: false });
  const [all, setAll] = useState<Exchange[]>([]);
  const sync = useCallback(async () => {
    const s = store.current;
    if (s.busy) return void (s.again = true);
    s.busy = true;
    try {
      do {
        s.again = false;
        const d = await call<Changes>('debug.changes', { epoch: s.epoch, since: s.rev });
        if (d.reset) s.byId.clear();
        for (const r of d.rows) s.byId.set(r.id, r);
        let dropped = false;
        if (d.firstSeq !== undefined)
          for (const [id, r] of s.byId)
            if ((r.seq ?? 0) < d.firstSeq) {
              s.byId.delete(id);
              dropped = true;
            }
        if (!d.total && s.byId.size) (s.byId.clear(), (dropped = true));
        s.epoch = d.epoch;
        s.rev = d.rev;
        if (d.reset || d.rows.length || dropped) setAll([...s.byId.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)));
      } while (s.again);
    } finally {
      s.busy = false;
    }
  }, []);
  useEffect(() => {
    void sync();
    // rows arrive as programs send; a burst of signals is one request for the changes
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = on('debug.exchange', () => {
      clearTimeout(t);
      t = setTimeout(() => void sync(), 100);
    });
    return () => (off(), clearTimeout(t));
  }, [sync]);
  // a search in headers and bodies runs in the backend (the rows here have no bodies); the rest filters here
  const [deepIds, setDeepIds] = useState<Set<string>>();
  const deepText = filter.deep ? filter.text.trim() : '';
  useEffect(() => {
    if (!deepText) return setDeepIds(undefined);
    const t = setTimeout(
      () =>
        void call<string[]>('debug.exchanges', { text: deepText, deep: true, idsOnly: true }).then(
          (ids) => setDeepIds(new Set(ids)),
          () => setDeepIds(new Set()),
        ),
      250,
    );
    return () => clearTimeout(t);
  }, [deepText, all]);
  const rows = useMemo(() => filterRows(all, filter, deepIds), [all, filter, deepIds]);
  /** The programs, domains and types in the session, for the drop-downs. */
  const seen = useMemo(() => {
    const set = (f: (e: Exchange) => string | undefined) => [...new Set(all.map(f).filter((x): x is string => !!x))].sort();
    return { apps: set((e) => e.application), hosts: set((e) => e.host), types: set((e) => e.contentType?.split(';')[0]?.trim()) };
  }, [all]);
  return { all, rows, seen, sync, byId: store.current.byId };
}
