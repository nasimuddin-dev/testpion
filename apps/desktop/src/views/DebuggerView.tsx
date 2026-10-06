import { Bot, Bug, ChevronDown, Copy, Download, ExternalLink, FolderOpen, Globe, Pause, Play, Save, Scale, Square, Star, Terminal, Trash2, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { asError, call, on } from '../api';
import { confirmAction, promptText, useApp } from '../store';
import { Badge, Button, cx, Empty, Input, Menu, PageHeader, Select, Split, statusTone, Tabs, VirtualList, type MenuItem } from '../components/ui';
import { formatBytes, formatMs, type DecodedJwt } from '@testpion/shared';
import { finishSave, downloadContent, pickTextFile, type SaveResult } from '../lib/files';
import { JsonTree } from '../components/JsonView';
import { JwtView } from '../components/JwtView';
import type { HttpRequestSpec } from '../types';
import { BreakpointDialog, CompareExchangesDialog, HIGHLIGHT_CLASS, loadRules, RulesPanel, type HeldBreakpoint, type RulesState } from '../components/DebuggerRules';

interface Exchange {
  id: string;
  startedAt: string;
  kind: 'http' | 'tunnel';
  method: string;
  url: string;
  host: string;
  clientPort: number;
  application?: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  requestBodyBytes: number;
  requestBodyTruncated?: boolean;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBodyBytes: number;
  responseBodyTruncated?: boolean;
  contentType?: string;
  waitMs?: number;
  durationMs?: number;
  error?: string;
  bookmarked?: boolean;
  /** Rules (DBG-3): the row's colour, the rules that acted, where a redirect sent it, a reply rule answered, a breakpoint edited it. */
  highlight?: string;
  rules?: string[];
  redirectedTo?: string;
  repliedByRule?: boolean;
  edited?: boolean;
  /** The Auth inspector's reading (debug.exchange only). */
  auth?: { scheme: string; user?: string; jwt?: DecodedJwt; cookies: string[]; setCookies: string[]; note?: string };
}

interface Status {
  running: boolean;
  url?: string;
  port?: number;
  exchanges: number;
  systemProxy: boolean;
  autosave: boolean;
}

interface CaptureOptions {
  browsers: Array<{ name: string; label: string }>;
  shells: Array<{ shell: string; lines: string }>;
  systemProxy: boolean;
  platform: string;
}

interface Session {
  name: string;
  path: string;
  bytes: number;
  savedAt: string;
  autosave: boolean;
}

interface Stats {
  total: number;
  bytes: number;
  errors: number;
  firstAt?: string;
  lastAt?: string;
  timeline: Array<{ t: string; count: number; errors: number }>;
  statuses: Record<string, number>;
  hosts: Array<{ name: string; count: number; bytes: number; ms: number }>;
  contentTypes: Array<{ name: string; count: number; bytes: number }>;
  applications: Array<{ name: string; count: number; bytes: number }>;
  largest: Array<{ id: string; method: string; url: string; bytes: number }>;
  slowest: Array<{ id: string; method: string; url: string; ms?: number }>;
}

const fail = (e: unknown) => useApp.getState().toast(asError(e).message, 'error');
const toast = (m: string) => useApp.getState().toast(m, 'success');

/** An exchange as a REST request, for Open in a tab and Resend. */
function toRequest(e: Exchange): HttpRequestSpec {
  const headers = Object.entries(e.requestHeaders)
    .filter(([k]) => !/^(host|content-length|connection|proxy-.*|accept-encoding)$/i.test(k))
    .map(([key, value]) => ({ key, value, enabled: true }));
  const ct = e.requestHeaders['content-type'] ?? '';
  const body = e.requestBody ? ({ type: /json/i.test(ct) ? 'json' : /xml/i.test(ct) ? 'xml' : 'text', content: e.requestBody } as HttpRequestSpec['body']) : undefined;
  return { method: e.method, url: e.url, headers, body };
}

const curlOf = (e: Exchange) =>
  `curl -X ${e.method} '${e.url}'${Object.entries(e.requestHeaders)
    .filter(([k]) => !/^(host|content-length|proxy-.*)$/i.test(k))
    .map(([k, v]) => ` \\\n  -H '${k}: ${v.replace(/'/g, "'\\''")}'`)
    .join('')}${e.requestBody ? ` \\\n  --data '${e.requestBody.replace(/'/g, "'\\''")}'` : ''}`;

/** The exchange as it went over the wire (headers as received; bodies as kept), the Raw inspector. */
function rawOf(e: Exchange): { request: string; response: string } {
  let path = e.url;
  try {
    const u = new URL(e.url);
    path = e.kind === 'tunnel' ? u.host : `${u.pathname}${u.search}`;
  } catch {
    /* as is */
  }
  const lines = (h?: Record<string, string>) =>
    Object.entries(h ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
  const request = `${e.method} ${path} HTTP/1.1\r\n${lines(e.requestHeaders)}\r\n\r\n${e.requestBody ?? (e.requestBodyBytes ? `(${formatBytes(e.requestBodyBytes)} not kept)` : '')}`;
  const response = e.error
    ? `(no response: ${e.error})`
    : e.status
      ? `HTTP/1.1 ${e.status} ${e.statusText ?? ''}\r\n${lines(e.responseHeaders)}\r\n\r\n${e.responseBody ?? (e.responseBodyBytes ? `(${formatBytes(e.responseBodyBytes)} of ${e.contentType ?? 'binary'} not kept)` : '')}`
      : '(no response yet)';
  return { request, response };
}

/** A hex dump of the first 64 KB of a text, 16 bytes a line, the Hex inspector. */
function hexDump(text: string): string {
  const all = new TextEncoder().encode(text);
  const bytes = all.subarray(0, 64 * 1024);
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    out.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return out.join('\n') + (bytes.length < all.length ? '\n… (the first 64 KB)' : '');
}

/**
 * The HTTP Debugger (planning/http-debugger.md): other programs send through TestPion's proxy; every exchange is
 * listed as it happens, with the program that sent it, and opens whole: headers, bodies, raw, hex, auth, timing.
 * From a row: open it as a request, resend it, copy it as cURL, bookmark it, delete it, ask the assistant about it.
 * Capture helpers start a browser or a terminal through the proxy, or switch the system proxy. Sessions are HAR files
 * in the workspace's debugger/ folder (AutoSave every minute while capturing). Statistics and an overview of the session.
 */
export function DebuggerView() {
  const [status, setStatus] = useState<Status>();
  const [rows, setRows] = useState<Exchange[]>([]);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<Exchange>();
  const [filter, setFilter] = useState({ text: '', deep: false, host: '', method: '', status: '' as '' | 'ok' | 'redirect' | 'client-error' | 'server-error' | 'error', bookmarked: false });
  const [tab, setTab] = useState<'traffic' | 'stats' | 'rules'>('traffic');
  const [port, setPort] = useState('8899');
  const [stats, setStats] = useState<Stats>();
  const [capture, setCapture] = useState<CaptureOptions>();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [rules, setRules] = useState<RulesState>();
  const [held, setHeld] = useState<HeldBreakpoint[]>([]);
  const [openBreakpoint, setOpenBreakpoint] = useState<HeldBreakpoint>();
  /** Compare: the first exchange picked; the next row clicked is the other one. */
  const [compareA, setCompareA] = useState<Exchange>();
  const [comparePair, setComparePair] = useState<{ a: string; b: string }>();
  const filterBox = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [st, list] = await Promise.all([
        call<Status>('debug.status'),
        call<Exchange[]>('debug.exchanges', {
          text: filter.text || undefined,
          deep: filter.deep || undefined,
          host: filter.host || undefined,
          method: filter.method || undefined,
          status: filter.status || undefined,
          bookmarked: filter.bookmarked || undefined,
        }),
      ]);
      setStatus(st);
      setRows(list);
    } catch (e) {
      fail(e);
    }
  }, [filter]);
  useEffect(() => {
    void load();
  }, [load]);
  // rows arrive as programs send; a batch of updates is one refresh
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = on('debug.exchange', () => {
      clearTimeout(t);
      t = setTimeout(() => void load(), 150);
    });
    return () => (off(), clearTimeout(t));
  }, [load]);
  // the rules (DBG-3): the active profile's count for the bar, and exchanges held at a breakpoint
  useEffect(() => {
    void loadRules().then((r) => r && setRules(r));
    void call<HeldBreakpoint[]>('debug.breakpoints').then(setHeld, () => undefined);
    const offRules = on('debug.rules', () => void loadRules().then((r) => r && setRules(r)));
    const offBp = on<{ id: string; released?: boolean; phase?: 'request' | 'response'; exchange?: HeldBreakpoint['exchange'] }>('debug.breakpoint', (b) => {
      if (b.released) {
        setHeld((h) => h.filter((x) => x.id !== b.id));
        setOpenBreakpoint((o) => (o?.id === b.id ? undefined : o));
      } else if (b.exchange) {
        const bp: HeldBreakpoint = { id: b.id, phase: b.phase ?? 'request', since: new Date().toISOString(), exchange: b.exchange };
        setHeld((h) => [...h, bp]);
        setOpenBreakpoint((o) => o ?? bp);
      }
    });
    return () => (offRules(), offBp());
  }, []);
  useEffect(() => {
    if (!selected) return setDetail(undefined);
    void call<Exchange>('debug.exchange', { id: selected }).then(setDetail, () => setDetail(undefined));
  }, [selected, rows.length]);
  useEffect(() => {
    if (tab === 'stats') void call<Stats>('debug.stats').then(setStats, fail);
  }, [tab, rows.length]);
  const loadCapture = useCallback(() => call<CaptureOptions>('debug.captureOptions').then(setCapture, () => undefined), []);
  const loadSessions = useCallback(() => call<Session[]>('debug.sessions').then(setSessions, () => setSessions([])), []);
  useEffect(() => {
    void loadCapture();
  }, [loadCapture, status?.running, status?.systemProxy]);

  const start = async () => {
    try {
      const p = Number(port) || undefined;
      setStatus(await call<Status>('debug.start', { port: p }));
    } catch (e) {
      fail(e);
    }
  };
  const stop = async () => setStatus(await call<Status>('debug.stop'));
  const openInTab = (e: Exchange) => useApp.getState().openIntent('rest', { request: toRequest(e), name: `${e.method} ${new URL(e.url).pathname}` });
  const resend = async (e: Exchange) => {
    try {
      await call('http.send', { request: toRequest(e), environment: useApp.getState().environment, id: `dbg-resend-${e.id}` });
      toast('Sent again (see the History view for the response)');
    } catch (err) {
      fail(err);
    }
  };
  const ask = (e: Exchange) => {
    const { auth: _a, ...exchange } = e;
    useApp.getState().set({ assistant: { task: 'explain-exchange', title: `Explain ${e.method} ${e.host}`, context: { exchange } } });
  };
  const remove = async (ids: string[]) => {
    await call('debug.delete', { ids });
    if (selected && ids.includes(selected)) setSelected(undefined);
    void load();
  };
  const clear = async () => {
    if (await confirmAction({ title: 'Clear the session', message: 'Forget every captured exchange?', confirmLabel: 'Clear', danger: true })) {
      setSelected(undefined);
      setStatus(await call<Status>('debug.clear'));
      void load();
    }
  };
  const exportHar = async () => {
    const har = await call<unknown>('debug.har');
    const text = JSON.stringify(har, null, 2);
    const name = `debugger-${new Date().toISOString().slice(0, 10)}.har`;
    const r = await call<SaveResult>('app.saveText', { name, text }).catch(() => null);
    if (r) finishSave(r, 'HAR file');
    else downloadContent(name, text, { type: 'application/json' });
  };
  const saveSession = async () => {
    const name = await promptText('Save the session', {
      message: 'A name for this capture; it is saved as a HAR file in the workspace (debugger/, never committed).',
      value: `session-${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '')}`,
      okLabel: 'Save',
    });
    if (!name) return;
    try {
      const r = await call<{ name: string; exchanges: number }>('debug.saveSession', { name });
      toast(`Saved ${r.exchanges} exchanges as ${r.name}`);
    } catch (e) {
      fail(e);
    }
  };
  const openSession = async (s: Session) => {
    const replace = rows.length
      ? await confirmAction({ title: `Open ${s.name}`, message: 'Replace the current session with it, or add its exchanges to it?', confirmLabel: 'Replace', cancelLabel: 'Add' })
      : true;
    try {
      const r = await call<Status & { loaded: number }>('debug.openSession', { name: s.name, append: !replace });
      setStatus(r);
      setSelected(undefined);
      toast(`Opened ${r.loaded} exchanges`);
      void load();
    } catch (e) {
      fail(e);
    }
  };
  const importHar = async () => {
    const f = await pickTextFile('.har,.json');
    if (!f) return;
    try {
      const r = await call<Status & { loaded: number }>('debug.openSession', { text: f.text, append: rows.length > 0 });
      setStatus(r);
      toast(`Imported ${r.loaded} exchanges from ${f.name}`);
      void load();
    } catch (e) {
      fail(e);
    }
  };
  const systemProxy = async (onOff: boolean) => {
    try {
      setStatus(await call<Status>('debug.systemProxy', { on: onOff }));
      toast(onOff ? 'System proxy set: programs that honour it send through TestPion' : 'System proxy restored');
    } catch (e) {
      fail(e);
    }
  };

  // keyboard: ↑ ↓ select, Enter opens, Delete removes, Ctrl+F finds, Ctrl+E clears
  const onKey = (ev: React.KeyboardEvent) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') return (ev.preventDefault(), filterBox.current?.focus());
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'e') return (ev.preventDefault(), void clear());
    if (!rows.length || (ev.target as HTMLElement).tagName === 'INPUT') return;
    const i = rows.findIndex((r) => r.id === selected);
    if (ev.key === 'ArrowDown') return (ev.preventDefault(), setSelected(rows[Math.min(rows.length - 1, i + 1)]!.id));
    if (ev.key === 'ArrowUp') return (ev.preventDefault(), setSelected(rows[Math.max(0, i - 1)]!.id));
    if (ev.key === 'Enter' && i >= 0) return (ev.preventDefault(), openInTab(rows[i]!));
    if (ev.key === 'Delete' && i >= 0) return (ev.preventDefault(), void remove([rows[i]!.id]));
  };

  const hosts = useMemo(() => [...new Set(rows.map((r) => r.host))].sort(), [rows]);
  const sel = detail;
  const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => toast(`Copied ${what}`));

  const captureItems: MenuItem[] = [
    ...(capture?.browsers ?? []).map<MenuItem>((b) => ({
      label: `Open ${b.label} through the proxy`,
      icon: <Globe size={14} />,
      onSelect: () => void call<{ browser: string }>('debug.openBrowser', { browser: b.name }).then((r) => toast(`${r.browser} started with a profile of its own`), fail),
    })),
    {
      label: 'Open a terminal through the proxy',
      icon: <Terminal size={14} />,
      onSelect: () => void call<{ terminal: string }>('debug.openTerminal').then((r) => toast(`${r.terminal} opened with HTTP_PROXY set`), fail),
    },
    status?.systemProxy
      ? { label: 'Restore the system proxy', icon: <Globe size={14} />, onSelect: () => void systemProxy(false) }
      : { label: 'Set the system proxy to TestPion', icon: <Globe size={14} />, onSelect: () => void systemProxy(true) },
    ...(capture?.shells ?? []).map<MenuItem>((s) => ({ label: `Copy for ${s.shell}`, icon: <Copy size={14} />, onSelect: () => copy(s.lines, `the lines for ${s.shell}`) })),
  ];
  const sessionItems: MenuItem[] = [
    { label: 'Save session…', icon: <Save size={14} />, disabled: !rows.length, onSelect: () => void saveSession() },
    ...sessions.map<MenuItem>((s) => ({
      label: `Open ${s.name}${s.autosave ? ' (AutoSave)' : ''} · ${new Date(s.savedAt).toLocaleString()}`,
      icon: <FolderOpen size={14} />,
      onSelect: () => void openSession(s),
    })),
    { label: 'Import a HAR file…', icon: <Upload size={14} />, onSelect: () => void importHar() },
    { label: 'Export as HAR…', icon: <Download size={14} />, disabled: !rows.length, onSelect: () => void exportHar() },
    { label: 'Clear the session', icon: <Trash2 size={14} />, danger: true, disabled: !status?.exchanges, shortcut: 'Ctrl+E', onSelect: () => void clear() },
  ];

  return (
    <div className="h-full flex flex-col min-h-0">
      <PageHeader
        icon={<Bug size={18} />}
        title="HTTP Debugger"
        subtitle={
          status?.running
            ? `Listening on ${status.url}${status.systemProxy ? ' · the system proxy points here' : ''} · HTTP_PROXY=${status.url}, a browser's proxy setting, or --proxy-server=${status.url}`
            : 'Start the proxy, then point a program at it: its traffic is listed here as it happens.'
        }
        actions={
          <>
            {!status?.running && <Input className="w-24" aria-label="Port" value={port} onChange={(e) => setPort(e.target.value)} placeholder="Port" />}
            {status?.running ? (
              <Button icon={<Square size={13} />} onClick={() => void stop()}>
                Stop
              </Button>
            ) : (
              <Button variant="primary" icon={<Play size={13} />} onClick={() => void start()}>
                Start capturing
              </Button>
            )}
            <Menu
              width={300}
              items={captureItems}
              onOpenChange={(o) => o && void loadCapture()}
              trigger={
                <Button icon={<Globe size={13} />} disabled={!status?.running} title="A browser or a terminal that sends through the proxy, the system proxy, the lines for a shell">
                  Capture <ChevronDown size={12} />
                </Button>
              }
            />
            <Menu
              width={320}
              items={sessionItems}
              onOpenChange={(o) => o && void loadSessions()}
              trigger={
                <Button icon={<Save size={13} />} title="Save, open, import and export sessions (HAR)">
                  Session <ChevronDown size={12} />
                </Button>
              }
            />
          </>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'traffic', label: 'Traffic', badge: status?.exchanges || undefined },
          { id: 'stats', label: 'Statistics' },
          { id: 'rules', label: 'Rules', badge: rules?.activeCount || undefined },
        ]}
      />
      {tab === 'stats' ? (
        <StatsPanel stats={stats} onPick={(id) => (setTab('traffic'), setSelected(id))} />
      ) : tab === 'rules' ? (
        <RulesPanel state={rules} onChange={setRules} host={sel?.host} />
      ) : (
        <Split id="debugger" initial={55}>
          <div className="h-full flex flex-col min-h-0 outline-none" tabIndex={0} onKeyDown={onKey} aria-label="Captured exchanges">
            {(!!rules?.activeCount || held.length > 0 || compareA) && (
              <div className="flex items-center gap-3 px-2 py-1 border-b border-line text-xs bg-panel/60" data-rules-bar>
                {!!rules?.activeCount && (
                  <button
                    type="button"
                    className="flex items-center gap-1 text-muted hover:text-fg"
                    onClick={() => setTab('rules')}
                    title="The rules of the active profile act on the traffic; click to see them"
                  >
                    <Scale size={12} /> {rules.activeCount} rule{rules.activeCount === 1 ? '' : 's'} active · {rules.active}
                  </button>
                )}
                {held.length > 0 && (
                  <button
                    type="button"
                    className="flex items-center gap-1 text-warn font-medium"
                    onClick={() => setOpenBreakpoint(held[0])}
                    title="An exchange is paused at a breakpoint, waiting for you"
                  >
                    <Pause size={12} /> {held.length} held at a breakpoint · open
                  </button>
                )}
                {compareA && (
                  <span className="flex items-center gap-1 text-accent">
                    Comparing with {compareA.method} {compareA.host}: click the other exchange{' '}
                    <button type="button" className="underline" onClick={() => setCompareA(undefined)}>
                      cancel
                    </button>
                  </span>
                )}
              </div>
            )}
            <div className="flex gap-2 p-2 border-b border-line items-center flex-wrap">
              <Input
                ref={filterBox}
                className="flex-1 min-w-40"
                placeholder={filter.deep ? 'Find in URLs, headers and bodies' : 'Filter (URL, method, program, type)'}
                aria-label="Filter exchanges"
                value={filter.text}
                onChange={(e) => setFilter({ ...filter, text: e.target.value })}
              />
              <label className="flex items-center gap-1 text-xs text-muted whitespace-nowrap" title="Search headers and bodies too">
                <input type="checkbox" checked={filter.deep} onChange={(e) => setFilter({ ...filter, deep: e.target.checked })} /> In bodies
              </label>
              <Select aria-label="Host" value={filter.host} onChange={(e) => setFilter({ ...filter, host: e.target.value })}>
                <option value="">All hosts</option>
                {hosts.map((h) => (
                  <option key={h}>{h}</option>
                ))}
              </Select>
              <Select aria-label="Method" value={filter.method} onChange={(e) => setFilter({ ...filter, method: e.target.value })}>
                <option value="">Any method</option>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </Select>
              <Select aria-label="Status" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value as typeof filter.status })}>
                <option value="">Any status</option>
                <option value="ok">2xx</option>
                <option value="redirect">3xx</option>
                <option value="client-error">4xx</option>
                <option value="server-error">5xx</option>
                <option value="error">Errors</option>
              </Select>
              <label className="flex items-center gap-1 text-xs text-muted whitespace-nowrap">
                <input type="checkbox" checked={filter.bookmarked} onChange={(e) => setFilter({ ...filter, bookmarked: e.target.checked })} /> Bookmarked
              </label>
              <Menu
                width={260}
                items={[
                  ...(rules?.filterPresets ?? []).map<MenuItem>((p) => ({ label: p.name, onSelect: () => setFilter({ ...filter, ...(p.filter as Partial<typeof filter>) }) })),
                  {
                    label: 'Save this filter…',
                    icon: <Save size={14} />,
                    onSelect: async () => {
                      const name = await promptText('Save filter preset', {
                        message: 'The current filter (text, host, method, status, bookmarked) under a name, for this workspace.',
                        placeholder: 'Name',
                      });
                      if (name) void call<RulesState['filterPresets']>('debug.saveFilterPreset', { name, filter }).then((fp) => setRules((r) => r && { ...r, filterPresets: fp }), fail);
                    },
                  },
                  ...(rules?.filterPresets ?? []).map<MenuItem>((p) => ({
                    label: `Forget ${p.name}`,
                    icon: <Trash2 size={14} />,
                    danger: true,
                    onSelect: () => void call<RulesState['filterPresets']>('debug.deleteFilterPreset', { name: p.name }).then((fp) => setRules((r) => r && { ...r, filterPresets: fp }), fail),
                  })),
                ]}
                trigger={
                  <Button size="sm" title="Saved filters">
                    Presets <ChevronDown size={12} />
                  </Button>
                }
              />
            </div>
            {!rows.length ? (
              <Empty icon={<Bug size={26} />} title={status?.running ? 'Waiting for traffic' : 'Not capturing'}>
                {status?.running ? (
                  <>
                    Point a program at <span className="mono">{status.url}</span>: <b>Capture</b> opens a browser or a terminal through it, or sets the system proxy; for a shell{' '}
                    <span className="mono">HTTP_PROXY={status.url}</span>, for Chrome <span className="mono">--proxy-server={status.url}</span>. HTTPS shows as a tunnel by host until the root
                    certificate (coming) decrypts it.
                  </>
                ) : (
                  'Start capturing, then run the program you want to watch; or open a saved session from the Session menu.'
                )}
              </Empty>
            ) : (
              <VirtualList
                className="flex-1"
                items={rows}
                rowHeight={30}
                render={(r) => (
                  <div
                    role="row"
                    aria-selected={r.id === selected}
                    className={cx(
                      'flex items-center gap-2 h-[30px] px-2 text-xs cursor-pointer border-b border-line/60',
                      r.id === selected ? 'bg-accent-soft' : 'hover:bg-hover',
                      r.highlight ? HIGHLIGHT_CLASS[r.highlight] : '',
                      r.error || (r.status ?? 0) >= 400 ? 'text-bad' : '',
                    )}
                    onClick={() => {
                      if (compareA && compareA.id !== r.id) {
                        setComparePair({ a: compareA.id, b: r.id });
                        setCompareA(undefined);
                      } else setSelected(r.id);
                    }}
                    onDoubleClick={() => openInTab(r)}
                    title={r.url}
                  >
                    <span className="w-4 shrink-0 text-warn">{r.bookmarked && <Star size={11} className="fill-current" />}</span>
                    <span className={cx('mono w-14 shrink-0 font-bold', `method-${r.method}`)}>{r.method}</span>
                    <span className="w-10 shrink-0">
                      <Badge tone={r.error ? 'bad' : statusTone(r.status)}>{r.error ? 'ERR' : (r.status ?? '…')}</Badge>
                    </span>
                    <span className="w-28 shrink-0 truncate text-muted" title={r.application ?? 'unknown program'}>
                      {r.application ?? `:${r.clientPort}`}
                    </span>
                    <span className="flex-1 min-w-0 truncate">{r.kind === 'tunnel' ? `${r.host}  (HTTPS tunnel)` : r.url}</span>
                    <span className="w-28 shrink-0 truncate text-muted">{r.contentType?.split(';')[0]}</span>
                    <span className="w-16 shrink-0 text-right tabular-nums text-muted">{formatBytes(r.responseBodyBytes)}</span>
                    <span className="w-16 shrink-0 text-right tabular-nums text-muted">{r.durationMs !== undefined ? formatMs(r.durationMs) : '…'}</span>
                  </div>
                )}
              />
            )}
            {rows.length > 0 && (
              <div className="px-2 py-1 border-t border-line text-[11px] text-muted flex gap-3 shrink-0">
                <span>{rows.length === status?.exchanges ? `${rows.length} exchanges` : `${rows.length} of ${status?.exchanges ?? rows.length}`}</span>
                <span className="ml-auto hidden @lg:inline">↑ ↓ select · Enter opens · Delete removes · Ctrl+F finds · Ctrl+E clears</span>
              </div>
            )}
          </div>
          <div className="h-full flex flex-col min-h-0">
            {!sel ? (
              <Empty title="Select an exchange">Its request, response, raw bytes, credentials and timing show here. Double-click a row to open it as a request.</Empty>
            ) : (
              <ExchangeDetail
                e={sel}
                onOpen={() => openInTab(sel)}
                onResend={() => void resend(sel)}
                onAsk={() => ask(sel)}
                onBookmark={async () => (await call('debug.bookmark', { id: sel.id, on: !sel.bookmarked }), void load(), setDetail({ ...sel, bookmarked: !sel.bookmarked }))}
                onDelete={() => void remove([sel.id])}
                onCompare={() => setCompareA(sel)}
                onRule={(preset) => {
                  if (preset === 'reply-with-this') {
                    void call<RulesState>('debug.saveRule', {
                      rule: {
                        kind: 'reply',
                        name: `Reply ${sel.status ?? 200} for ${sel.host}`,
                        enabled: true,
                        match: { host: sel.host, url: sel.url.split('?')[0] + '*' },
                        reply: {
                          status: sel.status ?? 200,
                          headers: Object.fromEntries(Object.entries(sel.responseHeaders ?? {}).filter(([k]) => /^content-type$/i.test(k))),
                          body: sel.responseBody ?? '',
                        },
                      },
                    }).then((r) => (setRules(r), toast('Rule added: this response is served by TestPion from now on')), fail);
                  } else void call<RulesState>('debug.addPreset', { preset, host: sel.host }).then((r) => (setRules(r), toast(`Rule added for ${sel.host}`)), fail);
                }}
              />
            )}
          </div>
        </Split>
      )}
      {openBreakpoint && <BreakpointDialog bp={openBreakpoint} onDone={() => setOpenBreakpoint(undefined)} />}
      {comparePair && <CompareExchangesDialog a={comparePair.a} b={comparePair.b} onClose={() => setComparePair(undefined)} />}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = { '2xx': 'bg-ok', '3xx': 'bg-accent', '4xx': 'bg-warn', '5xx': 'bg-bad', error: 'bg-bad', pending: 'bg-muted' };

/** The session in numbers: the overview (requests over time, the status mix), by host, type and program, the largest and the slowest. */
function StatsPanel({ stats, onPick }: { stats?: Stats; onPick(id: string): void }) {
  if (!stats || !stats.total)
    return (
      <div className="flex-1 min-h-0 overflow-auto p-4">
        <Empty icon={<Bug size={26} />} title="Nothing captured yet">
          Start the proxy and send some traffic through it; the session's numbers appear here.
        </Empty>
      </div>
    );
  const peak = Math.max(1, ...stats.timeline.map((b) => b.count));
  const statusTotal = Object.values(stats.statuses).reduce((a, b) => a + b, 0) || 1;
  return (
    <div className="flex-1 min-h-0 overflow-auto p-4 grid gap-4 content-start max-w-5xl">
      <div className="text-sm text-muted">
        {stats.total} exchanges · {formatBytes(stats.bytes)} received · {stats.errors} errors
        {stats.firstAt && stats.lastAt ? ` · ${new Date(stats.firstAt).toLocaleTimeString()} – ${new Date(stats.lastAt).toLocaleTimeString()}` : ''}
      </div>
      <section>
        <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">Requests over time</div>
        <div className="flex items-end gap-px h-20 border-b border-line" role="img" aria-label="Requests per time slice">
          {stats.timeline.map((b, i) => (
            <div key={i} className="flex-1 flex flex-col justify-end h-full" title={`${new Date(b.t).toLocaleTimeString()}: ${b.count} requests, ${b.errors} errors`}>
              <div className={cx('w-full rounded-t-sm', b.errors ? 'bg-bad/70' : 'bg-accent/70')} style={{ height: `${(b.count / peak) * 100}%` }} />
            </div>
          ))}
        </div>
      </section>
      <section>
        <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">Status mix</div>
        <div className="flex h-3 rounded overflow-hidden border border-line" role="img" aria-label="Status mix">
          {Object.entries(stats.statuses).map(([k, n]) => (
            <div key={k} className={cx(STATUS_TONE[k] ?? 'bg-muted')} style={{ width: `${(n / statusTotal) * 100}%` }} title={`${k}: ${n}`} />
          ))}
        </div>
        <div className="flex gap-3 mt-1 text-xs text-muted flex-wrap">
          {Object.entries(stats.statuses).map(([k, n]) => (
            <span key={k} className="flex items-center gap-1">
              <span className={cx('inline-block w-2 h-2 rounded-sm', STATUS_TONE[k] ?? 'bg-muted')} /> {k} {n}
            </span>
          ))}
        </div>
      </section>
      {(
        [
          ['Top hosts', stats.hosts],
          ['Top content types', stats.contentTypes],
          ['Applications', stats.applications],
        ] as Array<[string, Array<{ name: string; count: number; bytes: number }>]>
      ).map(([title, list]) => (
        <section key={title}>
          <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">{title}</div>
          <table className="text-sm w-full">
            <tbody>
              {list.map((x) => (
                <tr key={x.name} className="border-t border-line">
                  <td className="py-1 pr-3 truncate max-w-md">{x.name}</td>
                  <td className="py-1 pr-3 text-right tabular-nums text-muted">{x.count}</td>
                  <td className="py-1 text-right tabular-nums">{formatBytes(x.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      {(
        [
          ['Largest responses', stats.largest.map((x) => ({ ...x, value: formatBytes(x.bytes) }))],
          ['Slowest', stats.slowest.map((x) => ({ ...x, value: formatMs(x.ms) }))],
        ] as Array<[string, Array<{ id: string; method: string; url: string; value: string }>]>
      ).map(([title, list]) => (
        <section key={title}>
          <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">{title}</div>
          <table className="text-sm w-full">
            <tbody>
              {list.map((x) => (
                <tr key={x.id} className="border-t border-line cursor-pointer hover:bg-hover" onClick={() => onPick(x.id)}>
                  <td className="py-1 pr-3 mono text-xs">{x.method}</td>
                  <td className="py-1 pr-3 truncate max-w-xl">{x.url}</td>
                  <td className="py-1 text-right tabular-nums">{x.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

function ExchangeDetail({
  e,
  onOpen,
  onResend,
  onAsk,
  onBookmark,
  onDelete,
  onCompare,
  onRule,
}: {
  e: Exchange;
  onOpen(): void;
  onResend(): void;
  onAsk(): void;
  onBookmark(): void;
  onDelete(): void;
  onCompare(): void;
  onRule(preset: string): void;
}) {
  const [tab, setTab] = useState<'response' | 'request' | 'headers' | 'raw' | 'hex' | 'auth' | 'timing'>('response');
  const json = (text?: string) => {
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  };
  const resJson = json(e.responseBody);
  const reqJson = json(e.requestBody);
  const raw = useMemo(() => rawOf(e), [e]);
  const headers = (h?: Record<string, string>) => (
    <table className="text-xs w-full">
      <tbody>
        {Object.entries(h ?? {}).map(([k, v]) => (
          <tr key={k} className="border-t border-line/60">
            <td className="py-1 pr-3 font-medium whitespace-nowrap align-top">{k}</td>
            <td className="py-1 mono break-all">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => toast(`Copied ${what}`));
  return (
    <>
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line text-sm shrink-0 whitespace-nowrap overflow-hidden">
        <Badge tone={e.error ? 'bad' : statusTone(e.status)}>{e.error ? 'error' : `${e.status ?? '…'} ${e.statusText ?? ''}`}</Badge>
        <span className="mono text-xs truncate" title={e.url}>
          {e.method} {e.url}
        </span>
        <span className="ml-auto flex items-center gap-1 shrink-0">
          <Button size="sm" variant="ghost" icon={<ExternalLink size={12} />} onClick={onOpen} title="Open as a request in a tab, to change and send">
            Open
          </Button>
          <Button size="sm" variant="ghost" icon={<Play size={12} />} onClick={onResend} title="Send it again as it was">
            Resend
          </Button>
          <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => copy(curlOf(e), 'as cURL')}>
            cURL
          </Button>
          <Button size="sm" variant="ghost" icon={<Bot size={12} />} onClick={onAsk} title="Ask the AI assistant what this exchange does, why it failed, what to check (sent redacted)">
            Ask AI
          </Button>
          <Button size="sm" variant="ghost" icon={<Scale size={12} />} onClick={onCompare} title="Compare with another exchange: click it next">
            Compare
          </Button>
          <Menu
            width={280}
            items={[
              { label: `Reply with this response from now on`, icon: <Play size={14} />, onSelect: () => onRule('reply-with-this') },
              { label: `Ignore ${e.host}`, onSelect: () => onRule('ignore') },
              { label: `Highlight ${e.host}`, onSelect: () => onRule('highlight') },
              { label: `Offline: reply 503 for ${e.host}`, onSelect: () => onRule('offline') },
              { label: `Slow down ${e.host} by 2 s`, onSelect: () => onRule('slow') },
              { label: `Allow CORS for ${e.host}`, onSelect: () => onRule('cors') },
              { label: `Pause every request to ${e.host}`, icon: <Pause size={14} />, onSelect: () => onRule('break-request') },
            ]}
            trigger={
              <Button size="sm" variant="ghost" title="Add a rule for this exchange's host">
                Rule <ChevronDown size={12} />
              </Button>
            }
          />
          <Button
            size="sm"
            variant="ghost"
            icon={<Star size={12} className={e.bookmarked ? 'fill-current text-warn' : ''} />}
            onClick={onBookmark}
            title={e.bookmarked ? 'Remove the bookmark' : 'Bookmark'}
          >
            {e.bookmarked ? 'Bookmarked' : 'Bookmark'}
          </Button>
          <Button size="sm" variant="ghost" icon={<X size={12} />} onClick={onDelete} title="Remove from the session">
            Delete
          </Button>
        </span>
      </div>
      {e.error && <div className="px-3 py-2 text-sm text-bad border-b border-line">{e.error}</div>}
      {(e.rules?.length || e.redirectedTo || e.repliedByRule || e.edited) && (
        <div className="px-3 py-1.5 text-xs border-b border-line flex gap-2 flex-wrap items-center text-muted">
          <Scale size={12} />
          {e.repliedByRule && <Badge tone="warn">answered by a rule</Badge>}
          {e.redirectedTo && (
            <Badge tone="warn" title={e.redirectedTo}>
              redirected to {e.redirectedTo.replace(/^https?:\/\//, '').split('/')[0]}
            </Badge>
          )}
          {e.edited && <Badge tone="warn">edited at a breakpoint</Badge>}
          {e.rules?.map((r) => (
            <Badge key={r}>{r}</Badge>
          ))}
        </div>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'response', label: 'Response', badge: e.responseBodyBytes ? formatBytes(e.responseBodyBytes) : undefined },
          { id: 'request', label: 'Request', badge: e.requestBodyBytes ? formatBytes(e.requestBodyBytes) : undefined },
          { id: 'headers', label: 'Headers', badge: Object.keys(e.requestHeaders).length + Object.keys(e.responseHeaders ?? {}).length },
          { id: 'raw', label: 'Raw' },
          { id: 'hex', label: 'Hex' },
          { id: 'auth', label: 'Auth', badge: e.auth && e.auth.scheme !== 'none' ? e.auth.scheme.split(' ')[0] : undefined },
          { id: 'timing', label: 'Timing' },
        ]}
      />
      <div className="flex-1 min-h-0 overflow-auto">
        {tab === 'response' &&
          (e.kind === 'tunnel' ? (
            <div className="p-3 text-sm text-muted">
              An HTTPS tunnel: {formatBytes(e.requestBodyBytes)} sent, {formatBytes(e.responseBodyBytes)} received, encrypted end to end. Decrypting with a TestPion root certificate is on the way.
            </div>
          ) : resJson !== undefined ? (
            <JsonTree data={resJson} />
          ) : (
            <pre className="p-3 text-xs mono whitespace-pre-wrap break-all">
              {e.responseBody ?? (e.responseBodyBytes ? `(${formatBytes(e.responseBodyBytes)} of ${e.contentType ?? 'binary'}, not kept)` : '(empty)')}
            </pre>
          ))}
        {tab === 'request' &&
          (reqJson !== undefined ? (
            <JsonTree data={reqJson} />
          ) : (
            <pre className="p-3 text-xs mono whitespace-pre-wrap break-all">{e.requestBody ?? (e.requestBodyBytes ? `(${formatBytes(e.requestBodyBytes)}, not kept)` : '(no body)')}</pre>
          ))}
        {tab === 'headers' && (
          <div className="p-3 grid gap-3">
            <div>
              <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">Request</div>
              {headers(e.requestHeaders)}
            </div>
            <div>
              <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">Response</div>
              {headers(e.responseHeaders)}
            </div>
          </div>
        )}
        {tab === 'raw' && (
          <div className="p-3 grid gap-3">
            {(
              [
                ['Request', raw.request],
                ['Response', raw.response],
              ] as Array<[string, string]>
            ).map(([title, text]) => (
              <div key={title}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-semibold text-muted uppercase tracking-wide">{title}</span>
                  <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => copy(text, `the raw ${title.toLowerCase()}`)}>
                    Copy
                  </Button>
                </div>
                <pre className="text-xs mono whitespace-pre-wrap break-all rounded border border-line p-2 bg-panel">{text}</pre>
              </div>
            ))}
          </div>
        )}
        {tab === 'hex' && (
          <div className="p-3 grid gap-3">
            {(
              [
                ['Request body', e.requestBody],
                ['Response body', e.responseBody],
              ] as Array<[string, string | undefined]>
            ).map(([title, text]) => (
              <div key={title}>
                <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">{title}</div>
                <pre className="text-xs mono whitespace-pre rounded border border-line p-2 bg-panel overflow-auto">{text ? hexDump(text) : '(no body kept)'}</pre>
              </div>
            ))}
            <p className="text-xs text-muted">Binary bodies are counted, not kept; text bodies are shown as their UTF-8 bytes.</p>
          </div>
        )}
        {tab === 'auth' &&
          (!e.auth ? (
            <div className="p-3 text-sm text-muted">No credentials in this exchange: no Authorization header, no cookies.</div>
          ) : (
            <div className="p-3 grid gap-3 text-sm">
              <div>
                <span className="text-muted">Scheme</span> <Badge tone={e.auth.scheme === 'none' ? 'default' : 'accent'}>{e.auth.scheme}</Badge>
                {e.auth.user && (
                  <>
                    {' '}
                    <span className="text-muted">user</span> <span className="mono">{e.auth.user}</span>
                  </>
                )}
              </div>
              {e.auth.note && <p className="text-xs text-warn">{e.auth.note}</p>}
              {e.auth.jwt && (
                <div className="h-80 min-h-0 rounded border border-line">
                  <JwtView tokens={[e.auth.jwt]} />
                </div>
              )}
              {e.auth.cookies.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">Cookies sent</div>
                  <div className="flex gap-1 flex-wrap">
                    {e.auth.cookies.map((c) => (
                      <Badge key={c}>{c}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {e.auth.setCookies.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">Cookies set by the response</div>
                  <div className="flex gap-1 flex-wrap">
                    {e.auth.setCookies.map((c) => (
                      <Badge key={c}>{c}</Badge>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-xs text-muted">Values are never shown here: a captured token must not leave the session by a screenshot.</p>
            </div>
          ))}
        {tab === 'timing' && (
          <div className="p-3 text-sm grid gap-1">
            <div>
              Started <span className="mono text-xs">{e.startedAt}</span>
            </div>
            <div>Waiting for the server: {formatMs(e.waitMs)}</div>
            <div>Receiving: {e.durationMs !== undefined && e.waitMs !== undefined ? formatMs(e.durationMs - e.waitMs) : '…'}</div>
            <div>Total: {formatMs(e.durationMs)}</div>
            <div className="text-muted">
              From {e.application ?? 'an unknown program'} (client port {e.clientPort}) · {e.requestBodyBytes ? `${formatBytes(e.requestBodyBytes)} sent` : 'no body sent'} ·{' '}
              {formatBytes(e.responseBodyBytes)} received
              {e.responseBodyTruncated ? ' (the body shown is the first part)' : ''}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
