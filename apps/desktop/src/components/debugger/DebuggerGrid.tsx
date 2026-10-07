import { ArrowDown, ArrowUp, Columns3, Copy, Download, ExternalLink, Filter, Highlighter, Lock, Network, Play, Reply, Shuffle, Star, Trash2, Wrench } from 'lucide-react';
import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { formatBytes } from '@testpion/shared';
import { call, on } from '../../api';
import { useApp } from '../../store';
import { Badge, cx, Empty, Menu, Tabs, VirtualList, type MenuItem } from '../ui';
import { HIGHLIGHT_CLASS, type Rule, type RuleKind } from '../DebuggerRules';
import { curlOf, kb, speedOf, versionOf, type Exchange, type IncomingRequest } from './model';
import { downloadContent } from '../../lib/files';

const toast = (m: string) => useApp.getState().toast(m, 'success');
const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => toast(`Copied ${what}`));
/** The whole exchange: the grid's rows are lean (no headers, no bodies). */
const whole = (e: Exchange) => call<Exchange>('debug.exchange', { id: e.id });
const copyWhole = (e: Exchange, what: string, pick: (x: Exchange) => string) =>
  void whole(e).then(
    (x) => copy(pick(x), what),
    () => undefined,
  );
/** A body to a file named after the request (bodies kept as text; a binary one is counted, not kept). */
const EXT: Array<[RegExp, string]> = [
  [/json/i, 'json'],
  [/xml/i, 'xml'],
  [/html/i, 'html'],
  [/javascript/i, 'js'],
  [/css/i, 'css'],
  [/csv/i, 'csv'],
  [/text/i, 'txt'],
];
async function saveBody(e: Exchange, side: 'request' | 'response') {
  const x = await whole(e).catch(() => undefined);
  const body = side === 'request' ? x?.requestBody : x?.responseBody;
  if (body === undefined) return useApp.getState().toast(`The ${side} body was not kept (binary or larger than the capture keeps)`, 'error');
  const type = (side === 'request' ? x?.requestHeaders['content-type'] : x?.contentType) ?? '';
  const ext = EXT.find(([re]) => re.test(type))?.[1] ?? 'bin';
  const base = (() => {
    try {
      return new URL(e.url).pathname.split('/').filter(Boolean).pop() || new URL(e.url).hostname;
    } catch {
      return 'body';
    }
  })().replace(/[^\w.-]+/g, '_');
  downloadContent(`${base}-${side}.${ext}`, body, { type: type || 'application/octet-stream' });
}
const headerLines = (h?: Record<string, string>) =>
  Object.entries(h ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

type ColumnId = 'seq' | 'offset' | 'duration' | 'method' | 'version' | 'url' | 'status' | 'type' | 'size' | 'speed' | 'application' | 'domain' | 'ip' | 'pid';
interface Column {
  id: ColumnId;
  label: string;
  width: number;
  /** Grows to fill the row (the URL). */
  grow?: boolean;
  align?: 'right';
  sort(e: Exchange): string | number;
}
const COLUMNS: Column[] = [
  { id: 'seq', label: '#', width: 48, align: 'right', sort: (e) => e.seq ?? 0 },
  { id: 'offset', label: 'Offset', width: 64, align: 'right', sort: (e) => e.offsetSec ?? 0 },
  { id: 'duration', label: 'Duration', width: 64, align: 'right', sort: (e) => e.durationMs ?? -1 },
  { id: 'method', label: 'Method', width: 64, sort: (e) => e.method },
  { id: 'version', label: 'Version', width: 72, sort: (e) => versionOf(e) },
  { id: 'url', label: 'URL', width: 280, grow: true, sort: (e) => e.url },
  { id: 'status', label: 'Status', width: 72, align: 'right', sort: (e) => e.status ?? (e.error ? 999 : -1) },
  { id: 'type', label: 'Type', width: 140, sort: (e) => e.contentType ?? '' },
  { id: 'size', label: 'Size', width: 64, align: 'right', sort: (e) => e.responseBodyBytes },
  { id: 'speed', label: 'Speed', width: 72, align: 'right', sort: (e) => Number(speedOf(e)) || 0 },
  { id: 'application', label: 'Application', width: 110, sort: (e) => e.application ?? '' },
  { id: 'domain', label: 'Domain', width: 150, sort: (e) => e.host },
  { id: 'ip', label: 'IP Address', width: 140, sort: (e) => e.serverAddress ?? '' },
  { id: 'pid', label: 'PID', width: 60, align: 'right', sort: (e) => e.pid ?? 0 },
];
const DEFAULT_HIDDEN: ColumnId[] = ['pid'];
const HIDDEN_KEY = 'testpion.debugger.hiddenColumns';
const readHidden = (): ColumnId[] => {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? 'null') as unknown;
    return Array.isArray(v) ? (v as ColumnId[]) : DEFAULT_HIDDEN;
  } catch {
    return DEFAULT_HIDDEN;
  }
};

const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const statusClass = (e: Exchange) => (e.error || (e.status ?? 0) >= 400 ? 'text-bad' : (e.status ?? 0) >= 300 ? 'text-warn' : e.status ? 'text-ok' : 'text-muted');

/** What a quick rule from a row matches on: the row's program, URL start, host, method or server address. */
export type QuickMatch = { label: string; match: Rule['match'] };
export function quickMatches(e: Exchange): QuickMatch[] {
  const urlStart = (() => {
    try {
      const u = new URL(e.url);
      return `${u.origin}${u.pathname}`;
    } catch {
      return e.url;
    }
  })();
  return [
    ...(e.application ? [{ label: `Application = ${e.application}`, match: { application: e.application } }] : []),
    { label: `URL starts with ${urlStart}`, match: { url: `${urlStart}*` } },
    { label: `Domain = ${e.host}`, match: { host: e.host } },
    { label: `Method = ${e.method}`, match: { method: e.method } },
    ...(e.serverAddress ? [{ label: `IP Address = ${e.serverAddress}`, match: { where: { column: 'ip' as const, op: 'equals' as const, value: e.serverAddress } } }] : []),
  ];
}

export interface GridActions {
  onOpen(e: Exchange): void;
  onResend(e: Exchange): void;
  onBookmark(e: Exchange): void;
  onCompare(e: Exchange): void;
  onDelete(ids: string[]): void;
  onClear(): void;
  /** Add a rule straight away (a quick rule from the row's values). */
  onQuickRule(kind: RuleKind, name: string, match: Rule['match'], extra?: Partial<Rule>): void;
  /** Open the rule editor, filled in. */
  onNewRule(rule: Partial<Rule>): void;
  onConnections(): void;
}

/**
 * The traffic grid, the HTTP Debugger Pro way: #, Offset, Duration, Method, Version, URL, Status, Type, Size (KB),
 * Speed (KB/s), Application, Domain, IP Address (and PID); sorted by any column, columns chosen, several rows
 * selected with Ctrl / Shift, a right-click menu that turns a row's values into rules. Highlights colour the text
 * (per theme), bold it, or fill the whole row.
 */
export function DebuggerGrid({
  rows,
  selected,
  selectedIds,
  onSelect,
  actions,
  onOrder,
}: {
  rows: Exchange[];
  selected?: string;
  selectedIds: string[];
  onSelect(id: string, ids: string[]): void;
  actions: GridActions;
  /** The rows in the order shown (the arrow keys follow it). */
  onOrder?(rows: Exchange[]): void;
}) {
  const [sort, setSort] = useState<{ col: ColumnId; desc: boolean }>({ col: 'seq', desc: false });
  const [hidden, setHidden] = useState<ColumnId[]>(readHidden);
  const [menu, setMenu] = useState<{ x: number; y: number; e: Exchange }>();
  const cols = COLUMNS.filter((c) => !hidden.includes(c.id));
  const minWidth = cols.reduce((n, c) => n + c.width, 0);
  const sorted = useMemo(() => {
    const c = COLUMNS.find((x) => x.id === sort.col)!;
    if (sort.col === 'seq' && !sort.desc) return rows;
    return [...rows].sort((a, b) => {
      const x = c.sort(a);
      const y = c.sort(b);
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort.desc ? -r : r;
    });
  }, [rows, sort]);
  useEffect(() => onOrder?.(sorted), [sorted, onOrder]);
  const toggleColumn = (id: ColumnId) => {
    const next = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id];
    setHidden(next);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
    } catch {
      /* the choice lasts this session */
    }
  };
  const click = (ev: ReactMouseEvent, e: Exchange) => {
    if (ev.ctrlKey || ev.metaKey) {
      const ids = selectedIds.includes(e.id) ? selectedIds.filter((x) => x !== e.id) : [...selectedIds, e.id];
      return onSelect(e.id, ids);
    }
    if (ev.shiftKey && selected) {
      const a = sorted.findIndex((x) => x.id === selected);
      const b = sorted.findIndex((x) => x.id === e.id);
      if (a >= 0 && b >= 0)
        return onSelect(
          e.id,
          sorted.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id),
        );
    }
    onSelect(e.id, [e.id]);
  };
  const cell = (c: Column, e: Exchange, style: Exchange['highlightStyle']) => {
    const colour = style && !style.row ? (theme() === 'light' ? (style.light ?? style.dark) : (style.dark ?? style.light)) : undefined;
    switch (c.id) {
      case 'seq':
        return (
          <span className="flex items-center justify-end gap-1">
            {e.bookmarked && <Star size={10} className="fill-current text-warn" />}
            {e.seq}
          </span>
        );
      case 'offset':
        return e.offsetSec?.toFixed(1);
      case 'duration':
        return e.durationMs !== undefined ? (e.durationMs / 1000).toFixed(3) : e.open ? '● live' : '…';
      case 'method':
        return <span className={cx('font-bold', `method-${e.method}`)}>{e.method}</span>;
      case 'version':
        return <span className={e.httpVersion === '2' ? 'text-accent' : ''}>{versionOf(e)}</span>;
      case 'url':
        return (
          <span className="truncate">
            {e.tls && <Lock size={10} className="inline mr-1 text-ok" aria-label="decrypted HTTPS" />}
            {e.kind === 'tunnel' ? `${e.host}  (HTTPS tunnel)` : e.url}
            {e.grpc && <span className="ml-1 text-[10px] font-bold text-[#e535ab]">gRPC</span>}
            {!!e.frameCount && (
              <span className="ml-1">
                <Badge>{e.frameCount} msg</Badge>
              </span>
            )}
            {!!e.eventCount && (
              <span className="ml-1">
                <Badge>{e.eventCount} evt</Badge>
              </span>
            )}
          </span>
        );
      case 'status':
        return e.grpc?.statusName && e.grpc.status !== 0 ? (
          <span className="text-bad font-semibold" title={`gRPC ${e.grpc.statusName}`}>
            {e.status} / {e.grpc.status}
          </span>
        ) : (
          <span className={cx('font-semibold', colour ? '' : statusClass(e))} style={colour ? { color: colour } : undefined}>
            {e.error ? 'ERR' : (e.status ?? '…')}
            {e.grpc && !e.error && e.status ? ' / gRPC' : ''}
          </span>
        );
      case 'type':
        return e.contentType?.split(';')[0];
      case 'size':
        return kb(e.responseBodyBytes);
      case 'speed': {
        const v = speedOf(e);
        return <span className={v && Number(v) < 1 ? 'text-bad' : ''}>{v}</span>;
      }
      case 'application':
        return e.application ?? `:${e.clientPort}`;
      case 'domain':
        return e.host;
      case 'ip':
        return e.serverAddress ?? '';
      case 'pid':
        return e.pid ?? '';
    }
  };
  const rowMenu = (e: Exchange): MenuItem[] => {
    const ids = selectedIds.includes(e.id) ? selectedIds : [e.id];
    const qm = quickMatches(e);
    const rulesOf = (kind: RuleKind, verb: string, extra?: Partial<Rule>): MenuItem[] => [
      // the server's address is known only after the request went out: not for Capture only / Filter out
      ...qm
        .filter((q) => !(q.match.where?.column === 'ip' && (kind === 'only' || kind === 'ignore')))
        .map<MenuItem>((q) => ({ label: q.label, onSelect: () => actions.onQuickRule(kind, `${verb} ${q.label}`, q.match, extra) })),
      { label: `New ${verb.toLowerCase()} rule…`, separator: true, onSelect: () => actions.onNewRule({ kind, enabled: true, match: { host: e.host }, ...extra }) },
    ];
    return [
      {
        label: 'Copy',
        icon: <Copy size={14} />,
        onSelect: () => undefined,
        items: [
          { label: 'URL', onSelect: () => copy(e.url, 'the URL') },
          { label: 'As cURL', onSelect: () => copyWhole(e, 'as cURL', curlOf) },
          { label: 'Request headers', onSelect: () => copyWhole(e, 'the request headers', (x) => headerLines(x.requestHeaders)) },
          { label: 'Response headers', onSelect: () => copyWhole(e, 'the response headers', (x) => headerLines(x.responseHeaders)) },
        ],
      },
      {
        label: 'Save content',
        icon: <Download size={14} />,
        onSelect: () => undefined,
        items: [
          { label: 'Request body…', disabled: !e.requestBodyBytes, onSelect: () => void saveBody(e, 'request') },
          { label: 'Response body…', disabled: !e.responseBodyBytes, onSelect: () => void saveBody(e, 'response') },
        ],
      },
      { label: e.bookmarked ? 'Remove the bookmark' : 'Bookmark', icon: <Star size={14} />, onSelect: () => actions.onBookmark(e) },
      { label: 'Edit & Submit', icon: <ExternalLink size={14} />, onSelect: () => actions.onOpen(e) },
      { label: 'Resend', icon: <Play size={14} />, onSelect: () => actions.onResend(e) },
      { label: 'Compare with…', onSelect: () => actions.onCompare(e) },
      { label: 'Capture only', icon: <Filter size={14} />, separator: true, onSelect: () => undefined, items: rulesOf('only', 'Capture only') },
      { label: 'Filter out', icon: <Filter size={14} />, onSelect: () => undefined, items: rulesOf('ignore', 'Filter out') },
      {
        label: 'Highlight',
        icon: <Highlighter size={14} />,
        onSelect: () => undefined,
        items: rulesOf('highlight', 'Highlight', { color: 'blue', style: { dark: '#60a5fa', light: '#1d4ed8', bold: true } }),
      },
      {
        label: 'Auto-reply',
        icon: <Reply size={14} />,
        onSelect: () => undefined,
        items: [
          {
            label: 'Reply with this response from now on',
            // the row is lean: the response's headers and body come with the whole exchange
            onSelect: () =>
              void whole(e).then(
                (x) =>
                  actions.onQuickRule(
                    'reply',
                    `Reply ${x.status ?? 200} for ${x.method} ${x.url.split('?')[0]}`,
                    { method: x.method, url: x.url.split('?')[0] + '*' },
                    {
                      reply: {
                        status: x.status ?? 200,
                        headers: Object.fromEntries(Object.entries(x.responseHeaders ?? {}).filter(([k]) => /^content-type$/i.test(k))),
                        body: x.responseBody ?? '',
                      },
                    },
                  ),
                () => undefined,
              ),
          },
          {
            label: 'New auto-reply rule…',
            separator: true,
            onSelect: () => actions.onNewRule({ kind: 'reply', enabled: true, match: { host: e.host, url: e.url.split('?')[0] + '*' }, reply: { status: 200 } }),
          },
        ],
      },
      {
        label: 'Modify headers…',
        icon: <Wrench size={14} />,
        onSelect: () => actions.onNewRule({ kind: 'modify', enabled: true, match: { host: e.host }, requestHeaders: [{ op: 'set', name: 'X-Debug', value: 'testpion' }] }),
      },
      {
        label: 'Redirect connections…',
        icon: <Shuffle size={14} />,
        onSelect: () => actions.onNewRule({ kind: 'redirect', enabled: true, match: { host: e.host }, redirect: { host: 'localhost:3000', scheme: 'http' } }),
      },
      ...(e.httpVersion === '2' ? [{ label: 'HTTP/2 connection tree', icon: <Network size={14} />, onSelect: actions.onConnections }] : []),
      { label: ids.length > 1 ? `Delete ${ids.length} selected` : 'Delete', icon: <Trash2 size={14} />, shortcut: 'Del', danger: true, separator: true, onSelect: () => actions.onDelete(ids) },
      { label: 'Clear', shortcut: 'Ctrl+E', danger: true, onSelect: actions.onClear },
    ];
  };
  const index = sorted.findIndex((x) => x.id === selected);
  return (
    <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden" data-debugger-grid>
      <div className="h-full flex flex-col" style={{ minWidth }}>
        <div className="flex items-center h-7 text-[11px] text-muted bg-panel border-b border-line shrink-0 select-none" role="row">
          {cols.map((c) => (
            <button
              key={c.id}
              type="button"
              role="columnheader"
              aria-sort={sort.col === c.id ? (sort.desc ? 'descending' : 'ascending') : 'none'}
              className={cx('h-full px-2 flex items-center gap-1 border-r border-line/60 hover:bg-hover hover:text-fg truncate', c.grow && 'flex-1', c.align === 'right' && 'justify-end')}
              style={{ width: c.width, minWidth: c.width }}
              onClick={() => setSort((s) => ({ col: c.id, desc: s.col === c.id ? !s.desc : false }))}
              title={`Sort by ${c.label}`}
            >
              {c.label}
              {sort.col === c.id && (sort.desc ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
            </button>
          ))}
          <Menu
            width={200}
            items={COLUMNS.map((c) => ({ label: `${hidden.includes(c.id) ? '  ' : '✓ '}${c.label}`, onSelect: () => toggleColumn(c.id) }))}
            trigger={
              <button type="button" className="h-full px-2 hover:text-fg" aria-label="Columns" title="Show or hide columns">
                <Columns3 size={12} />
              </button>
            }
          />
        </div>
        <VirtualList
          className="flex-1"
          items={sorted}
          rowHeight={24}
          scrollToIndex={index >= 0 ? index : undefined}
          render={(e) => {
            const style = e.highlightStyle;
            const rowColour = style?.row ? (theme() === 'light' ? (style.light ?? style.dark) : (style.dark ?? style.light)) : undefined;
            const isSel = selectedIds.includes(e.id) || e.id === selected;
            return (
              <div
                role="row"
                aria-selected={e.id === selected}
                data-exchange={e.id}
                className={cx(
                  'flex items-center h-[24px] text-xs cursor-default border-b border-line/40 tabular-nums',
                  isSel ? 'bg-accent-soft' : 'hover:bg-hover',
                  !style && e.highlight ? HIGHLIGHT_CLASS[e.highlight] : '',
                  style?.bold && 'font-semibold',
                )}
                style={rowColour ? { color: rowColour } : undefined}
                onClick={(ev) => click(ev, e)}
                onDoubleClick={() => actions.onOpen(e)}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  if (!selectedIds.includes(e.id)) onSelect(e.id, [e.id]);
                  setMenu({ x: ev.clientX, y: ev.clientY, e });
                }}
                title={e.url}
              >
                {cols.map((c) => (
                  <span
                    key={c.id}
                    className={cx(
                      'px-2 truncate',
                      c.grow && 'flex-1 min-w-0',
                      c.align === 'right' && 'text-right',
                      c.id !== 'url' && c.id !== 'method' && c.id !== 'status' && !rowColour && 'text-muted',
                    )}
                    style={{ width: c.width, minWidth: c.width }}
                  >
                    {cell(c, e, style)}
                  </span>
                ))}
              </div>
            );
          }}
        />
      </div>
      {menu && (
        <div className="fixed" style={{ left: menu.x, top: menu.y }}>
          <Menu open onOpenChange={(o) => !o && setMenu(undefined)} align="start" width={280} items={rowMenu(menu.e)} trigger={<span className="block w-px h-px" aria-hidden />} />
        </div>
      )}
    </div>
  );
}

/** The footer: how many requests are listed (or selected), their size and their time. */
export function GridTotals({ rows, selectedIds, total }: { rows: Exchange[]; selectedIds: string[]; total?: number }) {
  const pick = selectedIds.length > 1 ? rows.filter((r) => selectedIds.includes(r.id)) : rows;
  const bytes = pick.reduce((n, r) => n + r.responseBodyBytes + r.requestBodyBytes, 0);
  const secs = pick.reduce((n, r) => n + (r.durationMs ?? 0), 0) / 1000;
  return (
    <div className="px-2 py-1 border-t border-line text-[11px] text-muted flex gap-4 shrink-0 tabular-nums" data-grid-totals>
      <span>
        {selectedIds.length > 1 ? `${pick.length} selected · ` : ''}
        {rows.length === total || total === undefined ? `${rows.length} requests` : `${rows.length} of ${total} requests`}
      </span>
      <span>{formatBytes(bytes)}</span>
      <span>{secs.toFixed(3)} sec</span>
      <span className="ml-auto hidden @lg:inline">↑ ↓ select · Ctrl/Shift+click several · Enter opens · Delete removes · Ctrl+F finds · Ctrl+E clears</span>
    </div>
  );
}

/** Outgoing (programs through the proxy) or Incoming (requests TestPion's mock servers received). */
export function TrafficSide({ side, onSide, incoming }: { side: 'outgoing' | 'incoming'; onSide(s: 'outgoing' | 'incoming'): void; incoming: number }) {
  return (
    <Tabs
      value={side}
      onChange={onSide}
      tabs={[
        { id: 'outgoing', label: 'Outgoing requests' },
        { id: 'incoming', label: 'Incoming requests', badge: incoming || undefined },
      ]}
    />
  );
}

/** Requests the workspace's mock servers received, as they come. */
export function useIncoming() {
  const [list, setList] = useState<IncomingRequest[]>([]);
  useEffect(() => {
    void call<IncomingRequest[]>('debug.incoming').then(setList, () => undefined);
    return on<IncomingRequest>('debug.incoming', (r) => setList((l) => [...l.slice(-1999), r]));
  }, []);
  return { list, clear: () => void call('debug.clearIncoming').then(() => setList([])) };
}

export function IncomingList({ list, onClear }: { list: IncomingRequest[]; onClear(): void }) {
  if (!list.length)
    return (
      <Empty title="No incoming requests">
        Requests your programs send to TestPion&apos;s mock servers show here (start one from a collection&apos;s <b>Mock</b> tab), with the example that answered.
      </Empty>
    );
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-incoming>
      <div className="flex items-center h-7 text-[11px] text-muted bg-panel border-b border-line shrink-0">
        <span className="w-12 px-2 text-right">#</span>
        <span className="w-24 px-2">Time</span>
        <span className="w-16 px-2">Method</span>
        <span className="flex-1 px-2">Path</span>
        <span className="w-16 px-2 text-right">Status</span>
        <span className="w-48 px-2">Mock server</span>
        <span className="w-56 px-2">Answered by</span>
        <button type="button" className="px-2 hover:text-fg" onClick={onClear} title="Clear the incoming requests">
          <Trash2 size={12} />
        </button>
      </div>
      <VirtualList
        className="flex-1"
        items={list}
        rowHeight={24}
        render={(r, i) => (
          <div role="row" className="flex items-center h-[24px] text-xs border-b border-line/40 tabular-nums hover:bg-hover">
            <span className="w-12 px-2 text-right text-muted">{i + 1}</span>
            <span className="w-24 px-2 text-muted">{new Date(r.time).toLocaleTimeString(undefined, { hour12: false })}</span>
            <span className={cx('w-16 px-2 font-bold', `method-${r.method}`)}>{r.method}</span>
            <span className="flex-1 px-2 truncate mono">{r.path}</span>
            <span className={cx('w-16 px-2 text-right font-semibold', r.status >= 400 ? 'text-bad' : 'text-ok')}>{r.status}</span>
            <span className="w-48 px-2 truncate text-muted">{r.server ?? r.collectionId}</span>
            <span className="w-56 px-2 truncate text-muted">{r.forwarded ? 'forwarded to the real API' : r.example ? r.example : 'no matching example'}</span>
          </div>
        )}
      />
    </div>
  );
}
