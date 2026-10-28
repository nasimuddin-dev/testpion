import { passesQuick, type QuickFilter } from './quick-filter';
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
  /** Hide the CONNECT tunnels (HTTPS that is not decrypted): the usual first filter of a capture. */
  hideTunnels: boolean;
  /** "Capture only" / "Filter out" chosen in a row's menu, applied at once to the rows already captured. */
  quick: QuickFilter[];
}

interface Changes {
  epoch: number;
  rev: number;
  reset: boolean;
  rows: Exchange[];
  firstSeq?: number;
  total: number;
}

/** How often at most a search in bodies runs again for rows that arrived while capturing. */
const DEEP_SEARCH_EVERY_MS = 2000;

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
  if (!needle && !host && !method && !type && !f.application && !f.status && !f.bookmarked && !f.hideTunnels && !f.quick.length) return all;
  return all.filter((e) => {
    if (host && !e.host.toLowerCase().includes(host)) return false;
    if (method && e.method !== method) return false;
    if (f.bookmarked && !e.bookmarked) return false;
    if (f.hideTunnels && e.kind === 'tunnel') return false;
    if (f.quick.length && !passesQuick(e, f.quick)) return false;
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
  const store = useRef({ epoch: -1, rev: 0, byId: new Map<string, Exchange>(), list: [] as Exchange[], busy: false, again: false });
  const [all, setAll] = useState<Exchange[]>([]);
  const sync = useCallback(async () => {
    const s = store.current;
    if (s.busy) return void (s.again = true);
    s.busy = true;
    try {
      do {
        s.again = false;
        const d = await call<Changes>('debug.changes', { epoch: s.epoch, since: s.rev });
        s.epoch = d.epoch;
        s.rev = d.rev;
        // the list stays in seq order: a changed row takes its place, a new one goes at the end (seq is monotonic, so
        // the 5,000 rows are not sorted again on every sync); only a row that arrives out of order sorts it once
        if (d.reset) (s.byId.clear(), (s.list = []));
        const list = d.rows.length ? s.list.slice() : s.list;
        let unordered = false;
        for (const r of d.rows) {
          if (s.byId.has(r.id)) {
            let i = list.length - 1;
            while (i >= 0 && list[i]!.id !== r.id) i--;
            if (i >= 0) list[i] = r;
            else list.push(r);
          } else {
            if (list.length && (r.seq ?? 0) < (list[list.length - 1]!.seq ?? 0)) unordered = true;
            list.push(r);
          }
          s.byId.set(r.id, r);
        }
        if (unordered) list.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
        // the oldest rows left the session (its cap): they are the front of the list
        let drop = 0;
        if (d.firstSeq !== undefined) while (drop < list.length && (list[drop]!.seq ?? 0) < d.firstSeq) s.byId.delete(list[drop++]!.id);
        s.list = drop ? list.slice(drop) : list;
        if (!d.total && s.byId.size) (s.byId.clear(), (s.list = []), (drop = 1));
        if (d.reset || d.rows.length || drop) setAll(s.list);
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
  // a new text is searched a moment after typing stops; rows that arrive during a capture are searched too, but at most
  // once every two seconds (the backend scans every body of the session for it)
  const deepAt = useRef(0);
  useEffect(() => {
    if (!deepText) return setDeepIds(undefined);
    const wait = Math.max(250, DEEP_SEARCH_EVERY_MS - (Date.now() - deepAt.current));
    const t = setTimeout(() => {
      deepAt.current = Date.now();
      void call<string[]>('debug.exchanges', { text: deepText, deep: true, idsOnly: true }).then(
        (ids) => setDeepIds(new Set(ids)),
        () => setDeepIds(new Set()),
      );
    }, wait);
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
