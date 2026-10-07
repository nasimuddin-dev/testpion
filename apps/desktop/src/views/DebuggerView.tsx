import {
  Bug,
  ChevronDown,
  Copy,
  Download,
  FolderOpen,
  Globe,
  Lock,
  LockOpen,
  Smartphone,
  Pause,
  Play,
  Binary,
  Save,
  Scale,
  Square,
  X,
  Filter,
  Terminal,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { asError, call, on } from '../api';
import { confirmAction, promptText, useApp } from '../store';
import { Button, cx, Empty, Input, Menu, PageHeader, Select, Split, Tabs, type MenuItem } from '../components/ui';
import { formatBytes, formatMs } from '@testpion/shared';
import { finishSave, downloadContent, pickTextFile, type SaveResult } from '../lib/files';
import {
  CertificateDialog,
  ConnectionsView,
  LanDialog,
  pickBinaryFile,
} from '../components/DebuggerTools';
import { incomingAsExchange, toRequest, type Exchange, type Stats } from '../components/debugger/model';
import { ExchangePanes } from '../components/debugger/ExchangePanes';
import { useExchangeList, type ListFilter } from '../components/debugger/useExchangeList';
import { BreakpointDialog, CompareExchangesDialog, loadRules, RuleDialog, RulesPanel, type HeldBreakpoint, type Rule, type RulesState } from '../components/DebuggerRules';
import { DebuggerGrid, GridTotals, IncomingList, TrafficSide, useIncoming } from '../components/debugger/DebuggerGrid';
import { Dock } from '../components/debugger/Dock';
import { ToolRail, type DockPanel } from '../components/debugger/ToolRail';

interface Status {
  running: boolean;
  url?: string;
  port?: number;
  exchanges: number;
  systemProxy: boolean;
  autosave: boolean;
  decrypt: boolean;
  noDecrypt: string[];
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

const fail = (e: unknown) => useApp.getState().toast(asError(e).message, 'error');
const toast = (m: string) => useApp.getState().toast(m, 'success');

/** An exchange as a REST request, for Open in a tab and Resend. */
export function DebuggerView() {
  const [status, setStatus] = useState<Status>();
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<Exchange>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** The grid's rows in the order it shows them. */
  const order = useRef<Exchange[]>([]);
  const onOrder = useCallback((r: Exchange[]) => void (order.current = r), []);
  const [dock, setDock] = useState<DockPanel | undefined>(() => {
    try {
      return (localStorage.getItem('testpion.debugger.dock') as DockPanel | null) ?? 'summary';
    } catch {
      return 'summary';
    }
  });
  const [side, setSide] = useState<'outgoing' | 'incoming'>('outgoing');
  const [incomingSel, setIncomingSel] = useState<string>();
  const [ruleDraft, setRuleDraft] = useState<Partial<Rule>>();
  const [httpsBanner, setHttpsBanner] = useState(true);
  const incoming = useIncoming();
  const [filter, setFilter] = useState<ListFilter>({ application: '', type: '', text: '', deep: false, host: '', method: '', status: '' as '' | 'ok' | 'redirect' | 'client-error' | 'server-error' | 'error', bookmarked: false });
  const [tab, setTab] = useState<'traffic' | 'stats' | 'rules' | 'connections'>('traffic');
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
  const [dialog, setDialog] = useState<'certificate' | 'lan'>();
  const filterBox = useRef<HTMLInputElement>(null);

  const list = useExchangeList(filter);
  const rows = list.rows;
  const seen = list.seen;
  const loadStatus = useCallback(() => call<Status>('debug.status').then(setStatus, fail), []);
  /** After an action: the list's changes and the status (the capture's count, the system proxy, …). */
  const load = useCallback(async () => {
    await Promise.all([list.sync(), loadStatus()]);
  }, [list.sync, loadStatus]);
  useEffect(() => {
    void loadStatus();
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = on('debug.exchange', () => {
      clearTimeout(t);
      t = setTimeout(() => void loadStatus(), 500);
    });
    return () => (off(), clearTimeout(t));
  }, [loadStatus]);
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
  const selectedRow = selected ? list.byId.get(selected) : undefined;
  useEffect(() => {
    if (!selected) return setDetail(undefined);
    void call<Exchange>('debug.exchange', { id: selected }).then(setDetail, () => setDetail(undefined));
  }, [selected, selectedRow]);
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
      // an empty box is the usual port, not a random one: programs set up for 8899 keep working
      const p = Number(port) || 8899;
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
    setSelectedIds((cur) => cur.filter((id) => !ids.includes(id)));
    void load();
  };
  const clear = async () => {
    if (await confirmAction({ title: 'Clear the session', message: 'Forget every captured exchange?', confirmLabel: 'Clear', danger: true })) {
      setSelected(undefined);
      setSelectedIds([]);
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
      setSelectedIds([]);
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
  const importSaz = async () => {
    const f = await pickBinaryFile('.saz');
    if (!f) return;
    try {
      const r = await call<Status & { loaded: number }>('debug.openSession', { base64: f.base64, append: rows.length > 0 });
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
    if (ev.key === 'F5' || ev.key === 'F6') {
      ev.preventDefault();
      return openDock(ev.key === 'F5' ? 'timeline' : 'structure');
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') return (ev.preventDefault(), filterBox.current?.focus());
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'e') return (ev.preventDefault(), void clear());
    if (!rows.length || (ev.target as HTMLElement).tagName === 'INPUT') return;
    // in the order the grid shows (it may be sorted by another column)
    const shown = order.current.length === rows.length ? order.current : rows;
    const i = shown.findIndex((r) => r.id === selected);
    const go = (id: string) => (setSelected(id), setSelectedIds([id]));
    if (ev.key === 'ArrowDown') return (ev.preventDefault(), go(shown[Math.min(shown.length - 1, i + 1)]!.id));
    if (ev.key === 'ArrowUp') return (ev.preventDefault(), go(shown[Math.max(0, i - 1)]!.id));
    if (ev.key === 'Enter' && i >= 0) return (ev.preventDefault(), openInTab(shown[i]!));
    if (ev.key === 'Delete' && i >= 0) return (ev.preventDefault(), void remove(selectedIds.length > 1 ? selectedIds : [shown[i]!.id]));
  };

  const openDock = (p: DockPanel | undefined) => {
    setDock(p);
    try {
      if (p) localStorage.setItem('testpion.debugger.dock', p);
      else localStorage.removeItem('testpion.debugger.dock');
    } catch {
      /* remembered for this session only */
    }
  };
  const picked = useMemo(() => (selectedIds.length > 1 ? rows.filter((r) => selectedIds.includes(r.id)) : detail ? [detail] : []), [rows, selectedIds, detail]);
  const quickRule = (kind: Rule['kind'], name: string, match: Rule['match'], extra?: Partial<Rule>) =>
    void call<RulesState>('debug.saveRule', { rule: { kind, name, enabled: true, match, ...extra } }).then(
      (r) => (setRules(r), toast(`Rule added: ${name}`), openDock(kind === 'ignore' || kind === 'only' ? 'filter' : kind === 'reply' ? 'auto-reply' : kind === 'highlight' ? 'highlight' : 'modify')),
      fail,
    );
  const sel = detail;
  const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => toast(`Copied ${what}`));

  const captureItems: MenuItem[] = [
    ...(capture?.browsers ?? []).map<MenuItem>((b) => ({
      label: `Open ${b.label} through the proxy`,
      icon: <Globe size={14} />,
      onSelect: () => void call<{ browser: string }>('debug.openBrowser', { browser: b.name }).then((r) => toast(`${r.browser} started with a profile of its own`), fail),
    })),
    { label: 'A phone or another computer…', icon: <Smartphone size={14} />, onSelect: () => setDialog('lan') },
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
    { label: 'Import a Fiddler session (.saz)…', icon: <Upload size={14} />, onSelect: () => void importSaz() },
    { label: 'Export as HAR…', icon: <Download size={14} />, disabled: !rows.length, onSelect: () => void exportHar() },
    { label: 'Clear the session', icon: <Trash2 size={14} />, danger: true, disabled: !status?.exchanges, shortcut: 'Ctrl+E', onSelect: () => void clear() },
  ];

  return (
    <div className="h-full flex flex-col min-h-0">
      <PageHeader
        icon={<Bug size={18} />}
        title="HTTP Debugger"
        subtitle={
          status?.running ? (
            <span className="inline-flex items-center gap-1.5">
              Proxy address <code className="font-mono text-fg">{status.url}</code>
              <button type="button" className="text-muted hover:text-fg" title="Copy the proxy address" aria-label="Copy the proxy address" onClick={() => copy(status.url ?? '', 'the proxy address')}>
                <Copy size={12} />
              </button>
              {status.systemProxy ? ' · the system proxy points here' : ' · programs sent through it show below'}
            </span>
          ) : (
            'Start the proxy, then point a program at it: its traffic is listed here as it happens.'
          )
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
              width={330}
              items={[
                {
                  label: status?.decrypt ? 'Stop decrypting HTTPS' : 'Decrypt HTTPS',
                  icon: status?.decrypt ? <LockOpen size={14} /> : <Lock size={14} />,
                  onSelect: () =>
                    void call<Status>('debug.decrypt', { on: !status?.decrypt }).then(
                      (st) => (setStatus(st), toast(st.decrypt ? 'HTTPS is decrypted for programs that trust the TestPion root' : 'HTTPS is a tunnel again')),
                      fail,
                    ),
                },
                { label: 'Root certificate…', icon: <Lock size={14} />, onSelect: () => setDialog('certificate') },
                {
                  label: `Keep hosts encrypted…${status?.noDecrypt.length ? ` (${status.noDecrypt.length})` : ''}`,
                  onSelect: async () => {
                    const v = await promptText('Hosts kept encrypted', {
                      message: 'Globs, separated by commas: these hosts stay opaque tunnels (programs that pin their certificates, banking, …).',
                      value: (status?.noDecrypt ?? []).join(', '),
                      placeholder: '*.bank.example, login.example.com',
                    });
                    if (v !== null) void call<Status>('debug.decrypt', { noDecrypt: v.split(',') }).then(setStatus, fail);
                  },
                },
              ]}
              trigger={
                <Button icon={status?.decrypt ? <Lock size={13} /> : <LockOpen size={13} />} title="HTTPS decryption with the TestPion root certificate">
                  HTTPS {status?.decrypt ? 'decrypted' : 'tunnel'} <ChevronDown size={12} />
                </Button>
              }
            />
            <Button icon={<Binary size={13} />} onClick={() => (setTab('traffic'), openDock('convert'))} title="Decode URL, Base64, hex, JWT, timestamps">
              Decode
            </Button>
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
          { id: 'connections', label: 'Connections' },
          { id: 'rules', label: 'Rules', badge: rules?.activeCount || undefined },
        ]}
      />
      {tab === 'stats' ? (
        <StatsPanel stats={stats} onPick={(id) => (setTab('traffic'), setSelected(id))} />
      ) : tab === 'connections' ? (
        <ConnectionsView rows={rows} onPick={(id) => (setTab('traffic'), setSelected(id))} />
      ) : tab === 'rules' ? (
        <RulesPanel state={rules} onChange={setRules} host={sel?.host} />
      ) : (
        <div className="flex-1 min-h-0 flex">
          <ToolRail
            active={dock}
            onPanel={(p) => openDock(dock === p ? undefined : p)}
            onSubmit={() => (sel ? openInTab(sel) : useApp.getState().openIntent('rest', {}))}
            exportItems={sessionItems}
          />
          <div className="flex-1 min-w-0">
            <Split id="debugger-dock" initial={74} collapsedSecond={!dock}>
              <div className="h-full flex flex-col min-h-0 outline-none" tabIndex={0} onKeyDown={onKey} aria-label="Captured exchanges">
                {status?.running && !status.decrypt && httpsBanner && (
                  <div className="flex items-center gap-2 px-3 py-1 border-b border-line text-xs bg-accent-soft" data-https-banner>
                    <Lock size={12} className="text-accent" />
                    <span>
                      <b>HTTPS inspection is off</b> — HTTPS shows as a tunnel by host; decrypt it to see the requests inside (programs must trust the TestPion root certificate).
                    </span>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => void call<Status>('debug.decrypt', { on: true }).then((st) => (setStatus(st), toast('HTTPS is decrypted for programs that trust the TestPion root')), fail)}
                    >
                      Decrypt HTTPS
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDialog('certificate')}>
                      Install certificate…
                    </Button>
                    <button type="button" className="ml-auto text-muted hover:text-fg" aria-label="Hide this message" onClick={() => setHttpsBanner(false)}>
                      <X size={12} />
                    </button>
                  </div>
                )}
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
                <div className="flex gap-2 p-2 border-b border-line items-center flex-wrap" data-filter-bar>
                  <Select aria-label="Application" value={filter.application} onChange={(e) => setFilter({ ...filter, application: e.target.value })}>
                    <option value="">All Applications</option>
                    {seen.apps.map((h) => (
                      <option key={h}>{h}</option>
                    ))}
                  </Select>
                  <Select aria-label="Host" value={filter.host} onChange={(e) => setFilter({ ...filter, host: e.target.value })}>
                    <option value="">All Domains</option>
                    {seen.hosts.map((h) => (
                      <option key={h}>{h}</option>
                    ))}
                  </Select>
                  <Select aria-label="Type" value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}>
                    <option value="">All Types</option>
                    {seen.types.map((h) => (
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
                  <button
                    type="button"
                    className="ml-auto flex items-center gap-1 text-xs text-muted hover:text-fg"
                    onClick={() => openDock('filter')}
                    title="Filter Out and Capture Only rules on"
                    data-filter-rule-count
                  >
                    <Filter size={12} /> {(rules?.rules ?? []).filter((r) => r.enabled && (r.kind === 'ignore' || r.kind === 'only')).length}
                  </button>
                  <Input
                    ref={filterBox}
                    className="w-56"
                    placeholder={filter.deep ? 'Find in URLs, headers and bodies' : 'Filter requests'}
                    aria-label="Filter exchanges"
                    value={filter.text}
                    onChange={(e) => setFilter({ ...filter, text: e.target.value })}
                  />
                  <label className="flex items-center gap-1 text-xs text-muted whitespace-nowrap" title="Search headers and bodies too">
                    <input type="checkbox" checked={filter.deep} onChange={(e) => setFilter({ ...filter, deep: e.target.checked })} /> In bodies
                  </label>
                </div>
                <div className="flex-1 min-h-0">
                  <Split id="debugger" direction="vertical" initial={58}>
                    <div className="h-full flex flex-col min-h-0">
                      {side === 'incoming' ? (
                        <IncomingList list={incoming.list} onClear={incoming.clear} selected={incomingSel} onSelect={setIncomingSel} />
                      ) : !rows.length ? (
                        <Empty icon={<Bug size={26} />} title={status?.running ? 'Waiting for traffic' : 'Not capturing'}>
                          {status?.running ? (
                            <>
                              Point a program at <span className="mono">{status.url}</span>: <b>Capture</b> opens a browser or a terminal through it, or sets the system proxy; for a shell{' '}
                              <span className="mono">HTTP_PROXY={status.url}</span>, for Chrome <span className="mono">--proxy-server={status.url}</span>. HTTPS shows as a tunnel by host until you turn on
                              <b> Decrypt HTTPS</b>.
                            </>
                          ) : (
                            'Start capturing, then run the program you want to watch; or open a saved session from the Session menu.'
                          )}
                        </Empty>
                      ) : (
                        <DebuggerGrid
                          rows={rows}
                          selected={selected}
                          selectedIds={selectedIds}
                          onOrder={onOrder}
                          onSelect={(id, ids) => {
                            if (compareA && compareA.id !== id) {
                              setComparePair({ a: compareA.id, b: id });
                              setCompareA(undefined);
                              return;
                            }
                            setSelected(id);
                            setSelectedIds(ids);
                          }}
                          actions={{
                            onOpen: openInTab,
                            onResend: (e) => void resend(e),
                            onBookmark: async (e) => (await call('debug.bookmark', { id: e.id, on: !e.bookmarked }), void load()),
                            onCompare: setCompareA,
                            onDelete: (ids) => void remove(ids),
                            onClear: () => void clear(),
                            onQuickRule: quickRule,
                            onNewRule: setRuleDraft,
                            onConnections: () => setTab('connections'),
                            onRulesPanel: (k) => openDock(k === 'ignore' || k === 'only' ? 'filter' : k === 'highlight' ? 'highlight' : k === 'reply' ? 'auto-reply' : 'modify'),
                          }}
                        />
                      )}
                      <TrafficSide side={side} onSide={setSide} incoming={incoming.list.length} />
                    </div>
                    <div className="h-full flex flex-col min-h-0">
                      {side === 'incoming' ? (
                        (() => {
                          const r = incoming.list.find((x) => x.id === incomingSel);
                          if (!r) return <Empty title="Select a request">What your program sent to the mock server and what it answered, side by side.</Empty>;
                          const e = incomingAsExchange(r);
                          return <ExchangePanes e={e} onOpen={() => openInTab(e)} onAsk={() => ask(e)} />;
                        })()
                      ) : !sel ? (
                        <Empty title="Select an exchange">Its request and response show side by side: headers, content, raw text and JSON. Double-click a row to open it as a request.</Empty>
                      ) : (
                        <ExchangePanes
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
                </div>
                {rows.length > 0 && <GridTotals rows={rows} selectedIds={selectedIds} total={list.all.length} />}
              </div>
              {dock ? (
                <Dock
                  panel={dock}
                  onPanel={openDock}
                  onClose={() => openDock(undefined)}
                  rules={rules}
                  onRules={setRules}
                  onNewRule={setRuleDraft}
                  onEditRule={setRuleDraft}
                  rows={rows}
                  picked={picked}
                  current={sel}
                  onPick={(id) => (setSelected(id), setSelectedIds([id]))}
                />
              ) : (
                <div />
              )}
            </Split>
          </div>
        </div>
      )}
      {openBreakpoint && <BreakpointDialog bp={openBreakpoint} onDone={() => setOpenBreakpoint(undefined)} />}
      {dialog === 'certificate' && <CertificateDialog onClose={() => setDialog(undefined)} />}
      {ruleDraft && (
        <RuleDialog
          rule={ruleDraft}
          onClose={() => setRuleDraft(undefined)}
          onSave={async (r) => {
            try {
              setRules(await call<RulesState>('debug.saveRule', { rule: r }));
              setRuleDraft(undefined);
              toast('Rule saved');
            } catch (e) {
              fail(e);
            }
          }}
        />
      )}
      {dialog === 'lan' && (
        <LanDialog
          onClose={() => setDialog(undefined)}
          onRestartOnLan={async () => {
            try {
              setStatus(await call<Status>('debug.start', { port: status?.port, lan: true }));
            } catch (e) {
              fail(e);
            }
          }}
        />
      )}
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
