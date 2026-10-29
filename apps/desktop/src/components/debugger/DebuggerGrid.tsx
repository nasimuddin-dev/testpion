import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Columns3, Copy, Layers, MessageSquare, Palette, Database, Download, ExternalLink, Filter, FolderPlus, Highlighter, Lock, Network, Play, Reply, Shuffle, Star, Trash2, Workflow, Wrench } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { formatBytes } from '@testpion/shared';
import { call } from '../../api';
import { useApp, toastError } from '../../store';
import { confirmDelete } from '../../lib/undo-delete';
import { Badge, cx, Empty, Menu, Tabs, VirtualList, type MenuItem } from '../ui';
import { HIGHLIGHT_CLASS, type Rule, type RuleKind } from '../DebuggerRules';
import { SortedRows } from './sorted-rows';
import { curlOf, kb, speedOf, toRequest, versionOf, type Exchange, type IncomingRequest } from './model';
import { saveAsTest, saveAsTestMenuItem } from '../../lib/save-test';
import { saveExchangeBody } from '../output/debugger-specs';
import { setDragRefs } from '../../lib/drag-ref';
import { useEventLog } from '../../lib/use-rpc';
import { usePersisted } from '../../lib/sticky';
import { copyText } from '../../lib/clipboard';
import { LABEL } from '../../lib/vocabulary';
import { plural } from '../../lib/format';
import { negatedLabel, quickRuleName, type QuickKind } from './quick-filter';
import { certificateError } from './ExchangeExtras';
import { REQUIRE_AUTH_PRESET, TRAFFIC_PRESETS, USER_AGENT_PRESETS } from './presets';
import { MARKS } from './marks';
import { COLUMNS, DEFAULT_HIDDEN, EXTRA_KEY, HIDDEN_KEY, MAX_HEADER_COLUMNS, OPTIONAL_COLUMNS, columnShown, headerColumn, headerKey, parseHidden, plainCell, type BuiltInColumnId, type Column, type ColumnId, type HeaderColumnDef } from './grid-columns';
import { GROUP_LABEL, groupKeyOf, groupRows, isGroup, type GridItem, type GroupBy } from './grouping';
import { HeaderColumnDialog } from './HeaderColumnDialog';
import { useSticky } from '../../lib/sticky';

/** The whole exchange: the grid's rows are lean (no headers, no bodies). */
const whole = (e: Exchange) => call<Exchange>('debug.exchange', { id: e.id });
/** A URL's path, for a name ("GET /patients"); the URL itself when it isn't one. */
const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};
const copyWhole = (e: Exchange, what: string, pick: (x: Exchange) => string) =>
  void whole(e).then(
    (x) => void copyText(pick(x), what),
    () => undefined,
  );
/** A body through the Save as dialog, named after the request (the shared output writer: bodies are kept as text; a binary one is counted, not kept). */
async function saveBody(e: Exchange, side: 'request' | 'response') {
  const x = await whole(e).catch(() => undefined);
  if (!x || (side === 'request' ? x.requestBody : x.responseBody) === undefined) return useApp.getState().toast(`The ${side} body was not kept (binary or larger than the capture keeps)`, 'error');
  await saveExchangeBody(x, side);
}
/** The exchange as code in a language (the backend writes it: secrets masked), put on the clipboard. */
const copyCode = (e: Exchange, language: string, what: string) =>
  void call<{ text: string }>('debug.snippet', { id: e.id, language }).then(
    (r) => void copyText(r.text, what),
    (err) => toastError(err),
  );
const headerLines = (h?: Record<string, string>) =>
  Object.entries(h ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

// drawn in thousands of rows: made once, so a re-rendered row reuses them
const BOOKMARK_ICON = <Star size={10} className="fill-current text-warn" />;
const TLS_ICON = <Lock size={10} className="inline mr-1 text-ok" aria-label="decrypted HTTPS" />;

const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const statusClass = (e: Exchange) => (e.error || (e.status ?? 0) >= 400 ? 'text-bad' : (e.status ?? 0) >= 300 ? 'text-warn' : e.status ? 'text-ok' : 'text-muted');

/** What a quick rule from a row matches on: the row's program, URL start, host, method or server address. */
export type QuickMatch = { label: string; match: Rule['match'] };
function quickMatches(e: Exchange): QuickMatch[] {
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
    ...(e.serverAddress ? [{ label: `IP address = ${e.serverAddress}`, match: { where: { column: 'ip' as const, op: 'equals' as const, value: e.serverAddress } } }] : []),
  ];
}

export interface GridActions {
  onOpen(e: Exchange): void;
  onResend(e: Exchange): void;
  /** Send these exchanges again: `times` sends at once (Resend 10 times), or undefined to open the Resend… dialog. */
  onReplay(ids: string[], times?: number): void;
  /** Stop decrypting this exchange's host (a program that does not trust the TestPion certificate); it stays a tunnel. */
  onKeepEncrypted(e: Exchange): void;
  onBookmark(e: Exchange): void;
  /** Ask for a note on these exchanges (the current one is the prompt's start); an empty answer removes it. */
  onNote(e: Exchange, ids: string[], remove?: boolean): void;
  /** A colour mark on these exchanges ('' removes it). */
  onMark(ids: string[], mark: string): void;
  /** Add a ready-made rule (Disable caching, a user agent …) for the domain of this exchange. */
  onPreset(e: Exchange, preset: string): void;
  onCompare(e: Exchange): void;
  onDelete(ids: string[]): void;
  /** A test flow of these exchanges (the Create flow dialog). */
  onCreateFlow(ids: string[]): void;
  /** These exchanges as saved requests (the Save to collection dialog, WF-12). */
  onSaveToCollection(ids: string[]): void;
  /** These exchanges as a RAG dataset (the Create dataset from captured calls dialog). */
  onCreateDataset(ids: string[]): void;
  /** Turn on HTTPS decryption (the one flow, with its question about the certificate). */
  onReadHttps(): void;
  /** Add a rule straight away (a quick rule from the row's values). */
  onQuickRule(kind: RuleKind, name: string, match: Rule['match'], extra?: Partial<Rule>): void;
  /** Open the rule editor, filled in. */
  onNewRule(rule: Partial<Rule>): void;
  onConnections(): void;
  /** The dock's panel for rules of this kind. */
  onRulesPanel(kind: RuleKind): void;
}

/**
 * The traffic grid, the HTTP Debugger Pro way: #, Offset, Duration, Method, Version, URL, Status, Type, Size (KB),
 * Speed (KB/s), Application, Domain, IP Address (and PID); sorted by any column, columns chosen, several rows
 * selected with Ctrl / Shift, a right-click menu that turns a row's values into rules. Highlights colour the text
 * (per theme), bold it, or fill the whole row.
 */
export const DebuggerGrid = memo(function DebuggerGrid({
  rows,
  selected,
  selectedIds,
  onSelect,
  actions,
  onOrder,
  decrypt,
}: {
  rows: Exchange[];
  selected?: string;
  selectedIds: string[];
  onSelect(id: string, ids: string[]): void;
  actions: GridActions;
  /** The rows in the order shown (the arrow keys follow it). */
  onOrder?(rows: Exchange[]): void;
  /** HTTPS decryption is on (then a tunnel is a host that failed: it can be kept encrypted). */
  decrypt: boolean;
}) {
  const [sort, setSort] = useState<{ col: ColumnId; desc: boolean }>({ col: 'seq', desc: false });
  const [hidden, setHidden] = usePersisted<ColumnId[]>(HIDDEN_KEY, DEFAULT_HIDDEN, { parse: parseHidden });
  const [extra, setExtra] = usePersisted<ColumnId[]>(EXTRA_KEY, [], { parse: parseHidden });
  // headers turned into columns (FG-12), kept per workspace; the backend puts their values on the list's rows
  const [headerCols, setHeaderCols] = useSticky<HeaderColumnDef[]>('debugger.headerColumns', [], { persist: true });
  const [headerDialog, setHeaderDialog] = useState(false);
  const [groupBy, setGroupBy] = usePersisted<GroupBy>('testpion.debugger.groupBy', 'none', { parse: (raw) => (['none', 'domain', 'application', 'connection'].includes(JSON.parse(raw) as string) ? (JSON.parse(raw) as GroupBy) : 'none') });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; e: Exchange }>();
  useEffect(() => {
    void call('debug.columns', { columns: headerCols }).catch(() => undefined);
  }, [headerCols]);
  const all = useMemo(() => [...COLUMNS, ...headerCols.map(headerColumn)], [headerCols]);
  const cols = all.filter((c) => (c.id.startsWith('h:') ? true : columnShown(c.id, hidden, extra)));
  const minWidth = cols.reduce((n, c) => n + c.width, 0);
  // the sorted rows are kept between syncs: the rows that came in or changed are inserted by binary search (sorted-rows.ts)
  const sorter = useRef(new SortedRows());
  const sorted = useMemo(() => {
    const c = all.find((x) => x.id === sort.col) ?? COLUMNS[0]!;
    if (sort.col === 'seq' && !sort.desc) return rows;
    return sorter.current.sort(rows, c.id, sort.desc, c.sort);
  }, [rows, sort, all]);
  // grouped: a header line before each group's rows, in the same virtual list (a collapsed group is its header alone)
  const grouped = useMemo(() => groupRows(sorted, groupBy, collapsed), [sorted, groupBy, collapsed]);
  const order = grouped.order;
  useEffect(() => onOrder?.(order), [order, onOrder]);
  // a row selected inside a collapsed group (arrow keys, a link) opens its group
  useEffect(() => {
    if (groupBy === 'none' || !selected || !collapsed.size) return;
    const e = rows.find((r) => r.id === selected);
    const k = e && groupKeyOf(e, groupBy);
    if (k !== undefined && collapsed.has(k)) setCollapsed((c) => new Set([...c].filter((x) => x !== k)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  const toggleGroup = (key: string) => setCollapsed((c) => (c.has(key) ? new Set([...c].filter((x) => x !== key)) : new Set([...c, key])));
  const toggleColumn = (id: ColumnId) => {
    if (OPTIONAL_COLUMNS.includes(id)) return setExtra(extra.includes(id) ? extra.filter((x) => x !== id) : [...extra, id]);
    setHidden(hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id]);
  };
  const click = (ev: ReactMouseEvent, e: Exchange) => {
    if (ev.ctrlKey || ev.metaKey) {
      const ids = selectedIds.includes(e.id) ? selectedIds.filter((x) => x !== e.id) : [...selectedIds, e.id];
      return onSelect(e.id, ids);
    }
    if (ev.shiftKey && selected) {
      const a = order.findIndex((x) => x.id === selected);
      const b = order.findIndex((x) => x.id === e.id);
      if (a >= 0 && b >= 0)
        return onSelect(
          e.id,
          order.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id),
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
            {e.note && <MessageSquare size={10} className="text-accent" aria-label="has a note" />}
            {e.bookmarked && BOOKMARK_ICON}
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
            {e.source === 'reverse' && (
              <span className="mr-1" data-source="reverse" title="Captured by the reverse proxy (Capture traffic for one API)">
                <Badge>reverse</Badge>
              </span>
            )}
            {e.tls && TLS_ICON}
            {e.kind === 'tunnel' ? `${e.host}  (HTTPS tunnel)` : e.url}
            {e.grpc && <span className="ml-1 text-2xs font-bold kind-grpc">gRPC</span>}
            {e.graphql && (
              <span className="ml-1 text-2xs font-bold text-accent" title="A GraphQL call: the operation it runs" data-graphql-label>
                {e.graphql}
              </span>
            )}
            {e.ai && (
              <span className="ml-1 text-2xs font-bold text-accent" title="An AI call: the provider and model, or an MCP message" data-ai-label>
                {e.ai}
              </span>
            )}
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
      case 'user':
        // the account, without the domain (DOMAIN\user): the full name on hover
        return <span title={e.user}>{e.user?.split('\\').pop() ?? ''}</span>;
      case 'pid':
        return e.pid ?? '';
      case 'graphql':
        return <span title={e.graphql}>{e.graphql ?? ''}</span>;
      case 'ai':
        return <span title={e.ai}>{e.ai ?? ''}</span>;
      case 'comment':
        return <span title={e.note}>{e.note ?? ''}</span>;
      case 'caching':
      case 'encoding':
      case 'port':
      case 'protocol':
      case 'tls':
        return plainCell(c.id as BuiltInColumnId, e);
      default:
        // a header column (FG-12)
        return e.headerValues?.[c.id.slice(2)] ?? '';
    }
  };
  const rowMenu = (e: Exchange): MenuItem[] => {
    const ids = selectedIds.includes(e.id) ? selectedIds : [e.id];
    const qm = quickMatches(e);
    const rulesOf = (kind: RuleKind, verb: string, extra?: Partial<Rule>): MenuItem[] => [
      // the server's address is known only after the request went out: not for Capture only / Filter out
      ...qm
        .filter((q) => !(q.match.where?.column === 'ip' && (kind === 'only' || kind === 'ignore')))
        .map<MenuItem>((q) => {
          // the operator says what the click does: = keeps these rows, != hides them (both at once, and as a rule for what comes)
          // (the menu line says what the click does to the view; the rule is NAMED from what it matches: `Filter out Domain = x`)
          const label = kind === 'ignore' ? negatedLabel(q.label) : q.label;
          return { label, onSelect: () => actions.onQuickRule(kind, quickRuleName(kind as QuickKind, q.label), q.match, extra) };
        }),
      { label: `New ${verb.toLowerCase()} rule…`, separator: true, onSelect: () => actions.onNewRule({ kind, enabled: true, match: { host: e.host }, ...extra }) },
      { label: 'See all rules', onSelect: () => actions.onRulesPanel(kind) },
    ];
    return [
      {
        label: 'Copy',
        icon: <Copy size={14} />,
        onSelect: () => undefined,
        items: [
          { label: 'URL', onSelect: () => void copyText(e.url, 'the URL') },
          { label: 'As cURL', onSelect: () => copyWhole(e, 'as cURL', curlOf) },
          { label: 'As PowerShell', onSelect: () => copyCode(e, 'powershell', 'as PowerShell') },
          { label: 'As fetch (JavaScript)', onSelect: () => copyCode(e, 'fetch', 'as fetch') },
          { label: 'As HTTPie', onSelect: () => copyCode(e, 'httpie', 'as HTTPie') },
          { label: 'Request headers', onSelect: () => copyWhole(e, 'the request headers', (x) => headerLines(x.requestHeaders)) },
          { label: 'Response headers', onSelect: () => copyWhole(e, 'the response headers', (x) => headerLines(x.responseHeaders)) },
        ],
      },
      {
        label: 'Save content',
        icon: <Download size={14} />,
        onSelect: () => undefined,
        items: [
          { label: 'Request body…', disabled: !e.requestBodyBytes, reason: 'This exchange has no request body', onSelect: () => void saveBody(e, 'request') },
          { label: 'Response body…', disabled: !e.responseBodyBytes, reason: 'This exchange has no response body', onSelect: () => void saveBody(e, 'response') },
        ],
      },
      { label: e.bookmarked ? 'Remove the bookmark' : 'Bookmark', icon: <Star size={14} />, onSelect: () => actions.onBookmark(e) },
      { label: e.note ? 'Edit the note…' : 'Add a note…', icon: <MessageSquare size={14} />, title: 'A comment on this exchange. It shows in the Comments column and is saved with the session.', onSelect: () => { setHidden((h) => h.filter((x) => x !== 'comment')); actions.onNote(e, ids); } },
      { label: 'Remove the note', icon: <MessageSquare size={14} />, disabled: !e.note, reason: 'This exchange has no note', onSelect: () => actions.onNote(e, ids, true) },
      {
        label: 'Mark',
        icon: <Palette size={14} />,
        title: 'Colour the row, to find it again',
        onSelect: () => undefined,
        items: [
          ...MARKS.map<MenuItem>((m) => ({ label: `${e.mark === m.id ? '✓ ' : '  '}${m.label}`, onSelect: () => actions.onMark(ids, m.id) })),
          { label: 'Remove the mark', separator: true, disabled: !e.mark, reason: 'This exchange has no mark', onSelect: () => actions.onMark(ids, '') },
        ],
      },
      { label: LABEL.openAsRequest, icon: <ExternalLink size={14} />, disabled: e.kind === 'tunnel', reason: 'A tunnel is not a request: turn on HTTPS decryption to see the requests inside it', onSelect: () => actions.onOpen(e) },
      {
        label: 'Resend',
        icon: <Play size={14} />,
        disabled: e.kind === 'tunnel',
        reason: 'A tunnel is not a request: turn on HTTPS decryption to see the requests inside it',
        onSelect: () => undefined,
        items: [
          { label: 'Once', onSelect: () => actions.onResend(e) },
          { label: 'Resend 10 times', title: 'Ten sends, one after another; the result is a table of statuses and times', onSelect: () => actions.onReplay([e.id], 10) },
          {
            label: ids.length > 1 ? `Resend the ${ids.length} selected, in order` : 'Resend the selected, in order',
            disabled: ids.length < 2,
            reason: 'Select several rows first (Ctrl+click or Shift+click)',
            onSelect: () => actions.onReplay(ids, ids.length),
          },
          { label: 'Resend…', separator: true, title: 'How many times, how many at once, the wait between and whether to stop at the first failure', onSelect: () => actions.onReplay(ids) },
        ],
      },
      // keeping a host encrypted means something only while decryption is on (or this tunnel failed on the certificate); otherwise the tunnel's item is the way in
      ...(e.kind === 'tunnel'
        ? [
            decrypt || certificateError(e)
              ? { label: 'Keep this host encrypted', icon: <Lock size={14} />, title: 'Stop decrypting this host (a program that does not trust the TestPion certificate, or pins its own)', onSelect: () => actions.onKeepEncrypted(e) }
              : { label: 'See inside HTTPS…', icon: <Lock size={14} />, title: 'Turn on HTTPS decryption: TestPion asks once to trust its certificate', onSelect: actions.onReadHttps },
          ]
        : []),
      { label: 'Compare with…', onSelect: () => actions.onCompare(e) },
      { label: ids.length > 1 ? `Create flow from ${ids.length} selected…` : 'Create flow from selection…', icon: <Workflow size={14} />, onSelect: () => actions.onCreateFlow(ids) },
      { label: ids.length > 1 ? `Save ${ids.length} selected to collection…` : 'Save to collection…', icon: <FolderPlus size={14} />, onSelect: () => actions.onSaveToCollection(ids) },
      { label: ids.length > 1 ? `Create RAG dataset from ${ids.length} selected…` : 'Create RAG dataset from selection…', icon: <Database size={14} />, onSelect: () => actions.onCreateDataset(ids) },
      // the whole exchange (rows are lean), as the request it was: the one Save as test
      saveAsTestMenuItem(() => void whole(e).then((x) => saveAsTest({ source: { kind: 'http', request: toRequest(x), status: x.status }, name: `${x.method} ${pathOf(x.url)}` }), toastError)),
      { label: 'Capture only', icon: <Filter size={14} />, separator: true, onSelect: () => undefined, items: rulesOf('only', 'Capture only') },
      { label: 'Filter out', icon: <Filter size={14} />, onSelect: () => undefined, items: rulesOf('ignore', 'Filter out') },
      {
        label: 'Highlight',
        icon: <Highlighter size={14} />,
        onSelect: () => undefined,
        items: rulesOf('highlight', 'Highlight', { color: 'blue', style: { dark: '#60a5fa', light: '#1d4ed8', bold: true } }),
      },
      {
        label: 'Change this traffic',
        icon: <Wrench size={14} />,
        title: 'Answer it yourself, change its headers or send it somewhere else',
        onSelect: () => undefined,
        items: [
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
                label: 'Reply with a file…',
                title: 'Answer this URL with a file of the workspace (read at every request)',
                onSelect: () => actions.onNewRule({ kind: 'reply', enabled: true, match: { host: e.host, url: e.url.split('?')[0] + '*' }, reply: { status: 200, file: '' } }),
              },
              {
                label: 'New auto-reply rule…',
                separator: true,
                onSelect: () => actions.onNewRule({ kind: 'reply', enabled: true, match: { host: e.host, url: e.url.split('?')[0] + '*' }, reply: { status: 200 } }),
              },
            ],
          },
          ...TRAFFIC_PRESETS.map<MenuItem>((p) => ({ label: p.label, icon: <Wrench size={14} />, title: `${p.title}. Adds a rule for ${e.host}.`, onSelect: () => actions.onPreset(e, p.id) })),
          {
            label: 'User agent',
            icon: <Wrench size={14} />,
            title: `Send another User-Agent to ${e.host}`,
            onSelect: () => undefined,
            items: USER_AGENT_PRESETS.map<MenuItem>((u) => ({ label: u.label, onSelect: () => actions.onPreset(e, u.id) })),
          },
          { label: REQUIRE_AUTH_PRESET.label, icon: <Wrench size={14} />, title: REQUIRE_AUTH_PRESET.title, onSelect: () => actions.onPreset(e, REQUIRE_AUTH_PRESET.id) },
          {
            label: 'Modify headers…',
            separator: true,
            icon: <Wrench size={14} />,
            onSelect: () => actions.onNewRule({ kind: 'modify', enabled: true, match: { host: e.host }, requestHeaders: [{ op: 'set', name: 'X-Debug', value: 'testpion' }] }),
          },
          {
            label: 'Redirect connections…',
            icon: <Shuffle size={14} />,
            onSelect: () => actions.onNewRule({ kind: 'redirect', enabled: true, match: { host: e.host }, redirect: { host: 'localhost:3000', scheme: 'http' } }),
          },
          {
            label: 'Remap this host…',
            icon: <Shuffle size={14} />,
            title: `Reach ${e.host} at another address, keeping the Host header`,
            onSelect: () => actions.onNewRule({ kind: 'remap', enabled: true, match: { host: e.host.replace(/:\d+$/, '') }, remap: { to: 'localhost:3000', preserveHost: true } }),
          },
          {
            label: 'Inject a failure…',
            icon: <Wrench size={14} />,
            title: `Drop, cut or never answer the requests to ${e.host}`,
            onSelect: () => actions.onNewRule({ kind: 'fault', enabled: true, match: { host: e.host }, fault: { action: 'drop' } }),
          },
        ],
      },
      ...(e.httpVersion === '2' ? [{ label: 'HTTP/2 connection tree', icon: <Network size={14} />, onSelect: actions.onConnections }] : []),
      { label: ids.length > 1 ? `Delete ${ids.length} selected` : 'Delete', icon: <Trash2 size={14} />, shortcut: 'Del', danger: true, separator: true, onSelect: () => actions.onDelete(ids) },
    ];
  };
  const index = selected ? grouped.items.findIndex((x) => !isGroup(x) && x.id === selected) : -1;
  return (
    <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden" data-debugger-grid>
      <div className="h-full flex flex-col" style={{ minWidth }}>
        <div className="flex items-center h-7 text-xs text-muted bg-panel border-b border-line shrink-0 select-none" role="row">
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
          {/* the two menus stay at the right edge while the grid scrolls sideways (with the dock open the grid is narrower than its columns) */}
          <div className="sticky right-0 h-full flex items-center shrink-0 ml-auto bg-panel border-l border-line">
          <Menu
            width={260}
            items={[
              ...COLUMNS.map<MenuItem>((c) => ({ label: `${columnShown(c.id, hidden, extra) ? '✓ ' : '  '}${c.label}`, onSelect: () => toggleColumn(c.id) })),
              ...headerCols.map<MenuItem>((h, i) => ({ label: `✓ ${h.name} (${h.side})`, title: 'A header column: click to remove it', separator: i === 0, onSelect: () => setHeaderCols(headerCols.filter((x) => headerKey(x) !== headerKey(h))) })),
              { label: 'Add column from a header…', separator: !headerCols.length, disabled: headerCols.length >= MAX_HEADER_COLUMNS, reason: `At most ${MAX_HEADER_COLUMNS} header columns: remove one first`, onSelect: () => setHeaderDialog(true) },
            ]}
            trigger={
              <button type="button" className="h-full px-2 hover:text-fg" aria-label="Columns" title="Show or hide columns, or add one from a header">
                <Columns3 size={12} />
              </button>
            }
          />
          <Menu
            width={220}
            items={[
              ...(Object.keys(GROUP_LABEL) as GroupBy[]).map<MenuItem>((g) => ({ label: `${groupBy === g ? '✓ ' : '  '}${GROUP_LABEL[g]}`, onSelect: () => (setGroupBy(g), setCollapsed(new Set())) })),
              { label: 'Collapse all groups', separator: true, disabled: groupBy === 'none', reason: 'Group the rows first', onSelect: () => setCollapsed(new Set(rows.map((r) => groupKeyOf(r, groupBy)).filter((k): k is string => k !== undefined))) },
              { label: 'Expand all groups', disabled: groupBy === 'none', reason: 'Group the rows first', onSelect: () => setCollapsed(new Set()) },
            ]}
            trigger={
              <button type="button" className={cx('h-full px-2 hover:text-fg', groupBy !== 'none' && 'text-accent')} aria-label="Group by" title={groupBy === 'none' ? 'Group the rows by domain, application or connection' : `Grouped by ${GROUP_LABEL[groupBy].toLowerCase()}`} data-group-by={groupBy}>
                <Layers size={12} />
              </button>
            }
          />
          </div>
        </div>
        <VirtualList
          className="flex-1"
          items={grouped.items}
          rowHeight={24}
          scrollToIndex={index >= 0 ? index : undefined}
          render={(item) => {
            if (isGroup(item)) return <GroupLine g={item} onToggle={toggleGroup} />;
            const e = item;
            const style = e.highlightStyle;
            const rowColour = style?.row ? (theme() === 'light' ? (style.light ?? style.dark) : (style.dark ?? style.light)) : undefined;
            const isSel = selectedIds.includes(e.id) || e.id === selected;
            return (
              <div
                role="row"
                aria-selected={e.id === selected}
                data-exchange={e.id}
                // dragged onto a flow canvas: this exchange, or the whole selection when it is part of it
                draggable
                onDragStart={(ev) => setDragRefs(ev, (isSel && selectedIds.length > 1 ? selectedIds : [e.id]).map((exchangeId) => ({ kind: 'exchange' as const, exchangeId })), `${e.method} ${e.url}`)}
                className={cx(
                  'flex items-center h-[24px] text-xs cursor-default border-b border-line/40 tabular-nums',
                  isSel ? 'bg-accent-soft' : 'hover:bg-hover',
                  e.mark ? HIGHLIGHT_CLASS[e.mark] : !style && e.highlight ? HIGHLIGHT_CLASS[e.highlight] : '',
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
      {headerDialog && <HeaderColumnDialog existing={headerCols} onAdd={(c) => setHeaderCols([...headerCols, c])} onClose={() => setHeaderDialog(false)} />}
      {menu && (
        <div className="fixed" style={{ left: menu.x, top: menu.y }}>
          <Menu open onOpenChange={(o) => !o && setMenu(undefined)} align="start" width={280} items={rowMenu(menu.e)} trigger={<span className="block w-px h-px" aria-hidden />} />
        </div>
      )}
    </div>
  );
});

/** A group's header line (FG-17): a row of the same virtual list, with how many requests, how many failed and how big. */
function GroupLine({ g, onToggle }: { g: Extract<GridItem, { group: true }>; onToggle(key: string): void }) {
  return (
    <div role="row" aria-expanded={!g.collapsed} data-group={g.key} className="flex items-center h-[24px] text-xs font-semibold bg-panel border-b border-line cursor-pointer hover:bg-hover select-none" onClick={() => onToggle(g.key)} title={g.collapsed ? 'Show this group' : 'Hide this group'}>
      {/* stays in view while the grid scrolls sideways */}
      <span className="sticky left-0 flex items-center gap-2 px-2 max-w-full">
        {g.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span className="truncate">{g.label}</span>
        <span className="text-muted font-normal tabular-nums whitespace-nowrap">
          {plural(g.count, 'request')}
          {g.errors ? <span className="text-bad"> · {g.errors} failed</span> : null} · {formatBytes(g.bytes)}
        </span>
      </span>
    </div>
  );
}

/** The footer: how many requests are listed (or selected), their size and their time. */
export const GridTotals = memo(function GridTotals({ rows, selectedIds, total }: { rows: Exchange[]; selectedIds: string[]; total?: number }) {
  // one selected row (a click, ↑ ↓) totals the whole list: only a multi-selection changes the sums
  const several = selectedIds.length > 1 ? selectedIds : undefined;
  const { pick, bytes, secs } = useMemo(() => {
    const ids = several && new Set(several);
    const pick = ids ? rows.filter((r) => ids.has(r.id)) : rows;
    let bytes = 0;
    let ms = 0;
    for (const r of pick) {
      bytes += r.responseBodyBytes + r.requestBodyBytes;
      ms += r.durationMs ?? 0;
    }
    return { pick, bytes, secs: ms / 1000 };
  }, [rows, several]);
  return (
    <div className="px-2 py-1 border-t border-line text-xs text-muted flex gap-4 shrink-0 tabular-nums" data-grid-totals>
      <span>
        {selectedIds.length > 1 ? `${pick.length} selected · ` : ''}
        {rows.length === total || total === undefined ? `${rows.length} requests` : `${rows.length} of ${total} requests`}
      </span>
      <span>{formatBytes(bytes)}</span>
      <span>{secs.toFixed(3)} sec</span>
      <span className="ml-auto hidden @lg:inline">↑ ↓ select · Ctrl/Shift+click several · Enter opens · Delete removes · Ctrl+F finds · Ctrl+E clears</span>
    </div>
  );
});

/** Outgoing (programs through the proxy) or Incoming (requests TestPion's mock servers received). */
export function TrafficSide({ side, onSide, incoming }: { side: 'outgoing' | 'incoming'; onSide(s: 'outgoing' | 'incoming'): void; incoming: number }) {
  return (
    <Tabs label="Traffic direction"
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
  const [list, setList] = useEventLog<IncomingRequest>('debug.incoming', 2000, 'debug.incoming');
  // as the outgoing side's Clear: it asks first (the requests cannot be put back), through the one helper
  return { list, clear: () => void confirmDelete({ what: 'every incoming request listed', title: 'Clear incoming requests', message: 'Forget every request the mock servers received?', confirmLabel: 'Clear', done: 'Incoming requests cleared', run: async () => (await call('debug.clearIncoming'), setList([])) }) };
}

export function IncomingList({ list, onClear, selected, onSelect }: { list: IncomingRequest[]; onClear(): void; selected?: string; onSelect(id: string): void }) {
  if (!list.length)
    return (
      <Empty title="No incoming requests">
        Requests your programs send to TestPion&apos;s mock servers show here (start one from a collection&apos;s <b>Mock</b> tab), with the example that answered.
      </Empty>
    );
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-incoming>
      <div className="flex items-center h-7 text-xs text-muted bg-panel border-b border-line shrink-0">
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
          <div
            role="row"
            aria-selected={r.id === selected}
            data-incoming-row={r.id}
            className={cx('flex items-center h-[24px] text-xs border-b border-line/40 tabular-nums cursor-default', r.id === selected ? 'bg-accent-soft' : 'hover:bg-hover')}
            onClick={() => onSelect(r.id)}
          >
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
