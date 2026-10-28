import { LABEL } from '../lib/vocabulary';
import { startAi } from '../components/ai/AiAction';
import { useAiEnabled } from '../lib/use-ai-enabled';
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
  Workflow,
  Circle,
  Users,
} from 'lucide-react';
import { openReverseProxyCapture } from '../lib/capture';
import { Database, Disc, FolderPlus, Plus, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../api';
import { persisted, promptText, toastError, useApp, attempt, confirmAction } from '../store';
import { createCaptureFlow } from '../components/debugger/capture-flow';
import { sessionActions, ActionButton } from '../components/debugger/session-actions';
import { BreakpointSplit, PauseButton, customBreakpointRule } from '../components/debugger/CaptureControls';
import { NetworkSpeedMenu } from '../components/debugger/NetworkSpeedMenu';
import { applyPreset, chipAria, chipText, chipTitle, presetOf } from '../components/debugger/quick-filter';
import { isMenuKey, openRowMenu } from '../components/debugger/row-menu-key';
import { certificateError } from '../components/debugger/ExchangeExtras';
import { confirmDelete, deleteWithUndo } from '../lib/undo-delete';
import { Badge, Button, cx, Empty, FilterInput, Menu, type MenuItem, PageHeader, SectionTitle, Select, Split, Tabs } from '../components/ui';
import { formatBytes, formatMs, outputFileName } from '@testpion/shared';
import { pickBinaryFile, pickTextFile } from '../lib/files';
import { OutputActions } from '../components/output/OutputFrame';
import { defaultFormat, saveOutput, type OutputSpec } from '../components/output/output-core';
import {
  CertificateDialog,
  ConnectionsView,
  LanDialog,
} from '../components/DebuggerTools';
import { incomingAsExchange, toRequest, type Exchange, type Stats } from '../components/debugger/model';
import { ExchangePanes } from '../components/debugger/ExchangePanes';
import { useExchangeList, type ListFilter } from '../components/debugger/useExchangeList';
import { BreakpointDialog, CompareExchangesDialog, RuleDialog, RulesPanel, type Rule, type RulesState } from '../components/DebuggerRules';
import { DebuggerGrid, GridTotals, IncomingList, TrafficSide, useIncoming, type GridActions } from '../components/debugger/DebuggerGrid';
import { useIntent, useStableCallbacks } from '../hooks';
import { reportUnopenable } from '../lib/open-ref';
import { shareDebuggerSession } from '../lib/git-share';
import { CreateFlowDialog } from '../components/debugger/CreateFlowDialog';
import { SaveToCollectionDialog } from '../components/debugger/SaveToCollectionDialog';
import { RagCaptureDialog } from '../components/rag/RagCaptureDialog';
import { Dock } from '../components/debugger/Dock';
import { ToolRail, type DockPanel } from '../components/debugger/ToolRail';
import { useLibraryTabs } from '../lib/library-tabs';
import { LibraryTabStrip } from '../components/LibraryTabStrip';
import { copyText } from '../lib/clipboard';
import { plural } from '../lib/format';
import { useDebuggerSession } from '../components/debugger/use-debugger-session';
import type { Status } from '../components/debugger/use-debugger-session';

interface CaptureOptions {
  /** `systemProxy`: the browser follows the system proxy (Safari), which is pointed here while it is captured. */
  browsers: Array<{ name: string; label: string; systemProxy?: boolean }>;
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

const toast = (m: string) => useApp.getState().toast(m, 'success');
/** The Debugger's session tabs hold no draft: a tab is the live capture or a saved session (by name). */
const debuggerTabDrafts = persisted<null>('debugger-tab', null);

/** An exchange as a REST request, for Open in a tab and Resend. */
const noFilter: ListFilter = { application: '', type: '', text: '', deep: false, host: '', method: '', status: '', bookmarked: false, hideTunnels: false, hide304: false, quick: [] };

export function DebuggerView() {
  const { status, setStatus, rules, setRules, held, openBreakpoint, setOpenBreakpoint, loadStatus } = useDebuggerSession();
  const aiOn = useAiEnabled();
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
  const [filter, setFilter] = useState<ListFilter>(noFilter);
  const filtersOn = JSON.stringify(filter) !== JSON.stringify(noFilter);
  const [tab, setTab] = useState<'traffic' | 'stats' | 'rules' | 'connections'>('traffic');
  const [port, setPort] = useState('8899');
  const [stats, setStats] = useState<Stats>();
  const [capture, setCapture] = useState<CaptureOptions>();
  const [sessions, setSessions] = useState<Session[]>([]);
  /** Compare: the first exchange picked; the next row clicked is the other one. */
  const [compareA, setCompareA] = useState<Exchange>();
  const [comparePair, setComparePair] = useState<{ a: string; b: string }>();
  const [dialog, setDialog] = useState<'certificate' | 'lan'>();
  /** Create a flow: from these exchanges, or from every one since a recording started. */
  const [flowFrom, setFlowFrom] = useState<{ ids?: string[]; since?: string }>();
  /** Save to collection (WF-12): these exchanges as saved requests. */
  const [saveFrom, setSaveFrom] = useState<{ ids?: string[]; since?: string }>();
  /** Create dataset from captured calls: the exchanges chosen. */
  const [datasetFrom, setDatasetFrom] = useState<{ ids: string[] }>();
  /** "Record a flow…" is on: since when, and how many exchanges so far. */
  const [recording, setRecording] = useState<{ since: string; count: number }>();
  const filterBox = useRef<HTMLInputElement>(null);

  // WF-19 sessions are tabs: the live capture (always there) and saved sessions opened beside it (a single click in the
  // Sessions menu previews one), kept per workspace; the backend shows the active tab's session (debug.view)
  const sessionTabs = useLibraryTabs<null>('debugger', debuggerTabDrafts, { keepFirst: true });
  const viewing = sessionTabs.active.savedId;
  const list = useExchangeList(filter);
  const rows = list.rows;
  useEffect(() => {
    setSelected(undefined);
    setSelectedIds([]);
    void call<Status>('debug.view', { session: viewing }).then(
      (s) => (setStatus(s), void list.sync()),
      (e) => {
        toastError(e); // gone (deleted, renamed): its tab closes, the live capture shows
        sessionTabs.close([sessionTabs.active.id], null);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewing]);
  const seen = list.seen;
  /** After an action: the list's changes and the status (the capture's count, the system proxy, …). */
  const load = useCallback(async () => {
    await Promise.all([list.sync(), loadStatus()]);
  }, [list.sync, loadStatus]);
  const selectedRow = selected ? list.byId.get(selected) : undefined;
  useEffect(() => {
    if (!selected) return setDetail(undefined);
    void call<Exchange>('debug.exchange', { id: selected }).then(setDetail, () => setDetail(undefined));
  }, [selected, selectedRow]);
  // the statistics are read at most twice a second while rows arrive (the first read is at once)
  const lastStats = useRef(0);
  useEffect(() => {
    if (tab !== 'stats') return;
    const t = setTimeout(
      () => {
        lastStats.current = Date.now();
        void call<Stats>('debug.stats').then(setStats, toastError);
      },
      Math.max(0, lastStats.current + 500 - Date.now()),
    );
    return () => clearTimeout(t);
  }, [tab, rows.length]);
  const loadCapture = useCallback(() => call<CaptureOptions>('debug.captureOptions').then(setCapture, () => undefined), []);
  const loadSessions = useCallback(() => call<Session[]>('debug.sessions').then(setSessions, () => setSessions([])), []);
  useEffect(() => {
    void loadCapture();
  }, [loadCapture, status?.running, status?.systemProxy]);

  const start = async (): Promise<boolean> => {
    try {
      // an empty box is the usual port, not a random one: programs set up for 8899 keep working
      const p = Number(port) || 8899;
      setStatus(await call<Status>('debug.start', { port: p }));
      return true;
    } catch (e) {
      toastError(e);
      return false;
    }
  };
  // what to capture is chosen first; the proxy starts on its own when it is not running yet
  const startThen = async (action: () => Promise<void> | void) => {
    if (!status?.running && !(await start())) return;
    await action();
  };
  const changePort = async () => {
    const v = await promptText('Proxy port', { message: 'The port the proxy listens on (programs are pointed at 127.0.0.1:<port>). 8899 unless another program uses it.', value: port, okLabel: 'Use this port' });
    if (v === undefined || v === null) return;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return void useApp.getState().toast('A port is a number from 1 to 65535', 'error');
    setPort(String(n));
  };
  const stop = async () => setStatus(await call<Status>('debug.stop'));
  // Record a flow: capture starts (when it is not on yet), the person uses their program, Stop opens the dialog with
  // every exchange since
  const startRecording = () =>
    startThen(async () => {
      await attempt(async () => {
        const r = await call<{ since: string }>('debug.record', { on: true });
        setRecording({ since: r.since, count: 0 });
        toast('Recording a flow: use your program through the proxy, then Stop recording');
      });
    });
  const stopRecording = async () => {
    try {
      const r = await call<{ since?: string; count: number }>('debug.record', { on: false });
      setRecording(undefined);
      if (!r.since || !r.count) return void useApp.getState().toast('Nothing was captured while recording', 'error');
      setFlowFrom({ since: r.since });
    } catch (e) {
      toastError(e);
    }
  };
  useEffect(() => {
    void call<{ recording: boolean; since?: string; count: number }>('debug.record').then((r) => setRecording(r.recording && r.since ? { since: r.since, count: r.count } : undefined), () => undefined);
  }, []);
  useEffect(() => {
    if (recording) void call<{ recording: boolean; since?: string; count: number }>('debug.record').then((r) => r.recording && r.since && setRecording({ since: r.since, count: r.count }), () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);
  useIntent('debugger', (p) => {
    if (p?.record && !recording) void startRecording();
    // a saved capture session (its History entry, a link): opened as the Sessions menu opens it (replace or add)
    if (typeof p?.session === 'string') void openSession({ name: p.session });
    // an exchange named elsewhere (a flow step, an agent's link): selected when the session still has it
    if (typeof p?.exchangeId === 'string') {
      const id = p.exchangeId;
      void call('debug.exchange', { id }).then(
        () => setSelected(id),
        () => reportUnopenable({ ok: false, ref: { kind: 'exchange', exchangeId: id }, reason: 'missing', message: 'it is no longer in the Debugger session (cleared, or captured in another session).' }),
      );
    }
  });
  const createFlowFrom = (ids: string[]) => (ids.length ? setFlowFrom({ ids }) : useApp.getState().toast('Select the exchanges to make a flow of (Ctrl+click, Shift+click)', 'error'));
  const saveToCollection = (ids: string[]) => (ids.length ? setSaveFrom({ ids }) : useApp.getState().toast('Select the exchanges to save (Ctrl+click, Shift+click)', 'error'));
  const createDataset = (ids: string[]) => (ids.length ? setDatasetFrom({ ids }) : useApp.getState().toast('Select the exchanges to make a dataset of (Ctrl+click, Shift+click)', 'error'));
  const selection = () => (selectedIds.length > 1 ? selectedIds : selected ? [selected] : []);
  const openInTab = (e: Exchange) => e.kind === 'tunnel' ? useApp.getState().toast('A tunnel is not a request: turn on HTTPS decryption to see the requests inside it', 'info') : useApp.getState().openIntent('rest', { request: toRequest(e), name: `${e.method} ${new URL(e.url).pathname}` });
  const resend = async (e: Exchange) => {
    try {
      await call('http.send', { request: toRequest(e), environment: useApp.getState().environment, id: `dbg-resend-${e.id}` });
      toast('Sent again (see the History view for the response)');
    } catch (err) {
      toastError(err);
    }
  };
  const keepEncrypted = async (e: Exchange) => {
    const host = e.host.replace(/:\d+$/, '');
    try {
      setStatus(await call<Status>('debug.decrypt', { noDecrypt: [...new Set([...(status?.noDecrypt ?? []), host])] }));
      toast(`${host} stays encrypted from now on (HTTPS menu ▸ Keep hosts encrypted lists them)`);
    } catch (err) {
      toastError(err);
    }
  };
  const ask = (e: Exchange) => {
    const { auth: _a, ...exchange } = e;
    startAi({ task: 'explain-exchange', title: `Explain ${e.method} ${e.host}`, context: { exchange } });
  };
  // captured exchanges cannot be put back (the registry's delete policy): both ask first, through the one helper
  const remove = (ids: string[]) =>
    confirmDelete({
      ...(ids.length === 1 ? { kind: 'exchange' as const, name: rows.find((r) => r.id === ids[0])?.url ?? ids[0]! } : { what: `the ${plural(ids.length, 'captured exchange')} selected` }),
      detail: 'Save the session first to keep them.',
      run: async () => {
        await call('debug.delete', { ids });
        if (selected && ids.includes(selected)) setSelected(undefined);
        setSelectedIds((cur) => cur.filter((id) => !ids.includes(id)));
        await load();
      },
    });
  const clear = () =>
    confirmDelete({
      what: 'every captured exchange of the session',
      title: 'Clear the session',
      message: 'Forget every captured exchange?',
      detail: 'Save the session first to keep them.',
      confirmLabel: 'Clear',
      done: 'Session cleared',
      run: async () => {
        setSelected(undefined);
        setSelectedIds([]);
        setStatus(await call<Status>('debug.clear'));
        await load();
      },
    });
  const saveSession = async () => {
    const name = await promptText('Save the session', {
      message: 'A name for this capture; it is saved as a HAR file in the workspace (debugger/, kept out of git: Share session puts a masked copy in git).',
      value: `session-${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '')}`,
      okLabel: 'Save',
    });
    if (!name) return;
    await attempt(async () => {
      const r = await call<{ name: string; exchanges: number }>('debug.saveSession', { name });
      toast(`Saved ${r.exchanges} exchanges as ${r.name}`);
    });
  };
  /** A saved session opens in its own tab (WF-19); the live capture goes on in its tab. `preview`: a single click. */
  const openSession = (s: Pick<Session, 'name'>, o: { preview?: boolean } = {}) => sessionTabs.open(s.name, null, o);
  /** The saved session on screen joins the live capture (its exchanges are added to it), which is then shown. */
  const addToLive = async (name: string) => {
    await attempt(async () => {
      const r = await call<Status & { loaded: number }>('debug.openSession', { name, append: true });
      sessionTabs.select(sessionTabs.tabs.find((t) => !t.savedId)?.id ?? 'main');
      setStatus(r);
      toast(`Added ${plural(r.loaded, 'exchange')} to the live capture`);
    });
  };
  const importHar = async () => {
    const f = await pickTextFile('.har,.json');
    if (!f) return;
    await attempt(async () => {
      const r = await call<Status & { loaded: number }>('debug.openSession', { text: f.text, append: rows.length > 0 });
      setStatus(r);
      toast(`Imported ${r.loaded} exchanges from ${f.name}`);
      void load();
    });
  };
  const importSaz = async () => {
    const f = await pickBinaryFile('.saz');
    if (!f) return;
    await attempt(async () => {
      const r = await call<Status & { loaded: number }>('debug.openSession', { base64: f.base64, append: rows.length > 0 });
      setStatus(r);
      toast(`Imported ${r.loaded} exchanges from ${f.name}`);
      void load();
    });
  };
  // Capture all traffic and See inside HTTPS: one flow (capture-flow.ts); `readHttps` is the only way decryption goes on
  const flow = useMemo(
    () => createCaptureFlow<Status>({ call, confirm: confirmAction, toast, fail: toastError, setStatus, platform: capture?.platform }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [capture?.platform],
  );
  const { systemProxy, readHttps } = flow;
  const captureAll = () => startThen(async () => void (await flow.captureAll()));

  // keyboard: ↑ ↓ select, Enter opens, Delete removes, Ctrl+F finds, Ctrl+E clears
  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === 'F5' || ev.key === 'F6') {
      ev.preventDefault();
      return openDock(ev.key === 'F5' ? 'timeline' : 'structure');
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') return (ev.preventDefault(), filterBox.current?.focus());
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'e') return (ev.preventDefault(), void clear());
    if (!rows.length || (ev.target as HTMLElement).tagName === 'INPUT') return;
    // Shift+F10 / the Menu key: the selected row's menu, as a right-click opens it
    if (isMenuKey(ev) && selected) return void (openRowMenu(ev.currentTarget as HTMLElement, selected) && ev.preventDefault());
    // in the order the grid shows (it may be sorted by another column)
    const shown = order.current.length === rows.length ? order.current : rows;
    const i = shown.findIndex((r) => r.id === selected);
    const go = (id: string) => (setSelected(id), setSelectedIds([id]));
    if (ev.key === 'ArrowDown') return (ev.preventDefault(), go(shown[Math.min(shown.length - 1, i + 1)]!.id));
    if (ev.key === 'ArrowUp') return (ev.preventDefault(), go(shown[Math.max(0, i - 1)]!.id));
    if (ev.key === 'Enter' && i >= 0) return (ev.preventDefault(), openInTab(shown[i]!));
    if (ev.key === 'Delete' && i >= 0) return (ev.preventDefault(), void remove(selectedIds.length > 1 ? selectedIds : [shown[i]!.id]));
  };

  // an unpinned dock is a tab at the edge: the rail's button for its panel shows it (rather than closing it)
  const [dockShown, setDockShown] = useState(true);
  const [dockReveal, setDockReveal] = useState(0);
  const openDock = (p: DockPanel | undefined) => {
    setDock(p);
    if (p) setDockReveal((n) => n + 1);
    try {
      if (p) localStorage.setItem('testpion.debugger.dock', p);
      else localStorage.removeItem('testpion.debugger.dock');
    } catch {
      /* remembered for this session only */
    }
  };
  const picked = useMemo(() => {
    if (selectedIds.length <= 1) return detail ? [detail] : [];
    const ids = new Set(selectedIds); // a Shift-click range over thousands of rows: one lookup per row, not a scan
    return rows.filter((r) => ids.has(r.id));
  }, [rows, selectedIds, detail]);
  const quickRule = (kind: Rule['kind'], name: string, match: Rule['match'], extra?: Partial<Rule>) =>
    void call<RulesState>('debug.saveRule', { rule: { kind, name, enabled: true, match, ...extra } }).then(
      (r) => (
        setRules(r),
        // Capture only / Filter out take effect on the rows already captured, at once (the rule handles what comes next)
        (kind === 'only' || kind === 'ignore') && setFilter((f) => ({ ...f, quick: [...f.quick, { id: `${Date.now()}-${f.quick.length}`, label: name, keep: kind === 'only', match }] })),
        toast(`Rule added: ${name}`),
        openDock(kind === 'ignore' || kind === 'only' ? 'filter' : kind === 'reply' ? 'auto-reply' : kind === 'highlight' ? 'highlight' : 'modify')
      ),
      toastError,
    );
  const sel = detail;
  // the grid is memoised: the same callbacks on every render, so a keystroke in the filter or the selected exchange
  // arriving doesn't re-render thousands of rows through new props
  const gridSelect = useStableCallbacks({
    onSelect: (id: string, ids: string[]) => {
      if (compareA && compareA.id !== id) {
        setComparePair({ a: compareA.id, b: id });
        setCompareA(undefined);
        return;
      }
      setSelected(id);
      setSelectedIds(ids);
    },
  });
  const gridActions = useStableCallbacks<GridActions>({
    onOpen: openInTab,
    onResend: (e) => void resend(e),
    onKeepEncrypted: (e) => void keepEncrypted(e),
    onReadHttps: () => void readHttps(),
    onBookmark: async (e) => (await call('debug.bookmark', { id: e.id, on: !e.bookmarked }), void load()),
    onNote: async (e, ids, remove) => {
      const note = remove ? '' : await promptText(ids.length > 1 ? `Note on ${ids.length} exchanges` : 'Note on this exchange', { message: 'A comment to find it again. It shows in the Comments column and is saved with the session.', value: e.note ?? '', placeholder: 'What to remember about this exchange', okLabel: 'Save' });
      if (note === null) return;
      await call('debug.annotate', { ids, note }).then(() => void load(), toastError);
    },
    onMark: (ids, mark) => void call('debug.annotate', { ids, mark }).then(() => void load(), toastError),
    onPreset: (e, preset) =>
      void call<RulesState>('debug.addPreset', { preset, host: e.host }).then((r) => (setRules(r), toast(`Rule added for ${e.host}`), openDock(preset === 'require-auth' ? 'auto-reply' : 'modify')), toastError),
    onCompare: setCompareA,
    onDelete: (ids) => void remove(ids),
    onCreateFlow: createFlowFrom,
    onSaveToCollection: saveToCollection,
    onCreateDataset: createDataset,
    onQuickRule: quickRule,
    onNewRule: setRuleDraft,
    onConnections: () => setTab('connections'),
    onRulesPanel: (k) => openDock(k === 'ignore' || k === 'only' ? 'filter' : k === 'highlight' ? 'highlight' : k === 'reply' ? 'auto-reply' : 'modify'),
  });
  // the detail panes are memoised too: a capture sync that leaves the selected exchange as it was renders nothing there
  const paneActions = useStableCallbacks({
    onOpen: () => sel && openInTab(sel),
    onResend: () => sel && void resend(sel),
    onKeepEncrypted: () => sel && void keepEncrypted(sel),
    onAsk: () => sel && ask(sel),
    onBookmark: async () => sel && (await call('debug.bookmark', { id: sel.id, on: !sel.bookmarked }), void load(), setDetail({ ...sel, bookmarked: !sel.bookmarked })),
    onDelete: () => sel && void remove([sel.id]),
    onCompare: () => setCompareA(sel),
    onRule: (preset: string) => {
      if (!sel) return;
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
        }).then((r) => (setRules(r), toast('Rule added: this response is served by TestPion from now on')), toastError);
      } else void call<RulesState>('debug.addPreset', { preset, host: sel.host }).then((r) => (setRules(r), toast(`Rule added for ${sel.host}`)), toastError);
    },
  });

  // The narrower ways to capture: one program (a browser or a terminal opened through the proxy), a phone, one API. Everything
  // on this computer is the primary button. Each starts the proxy when it is not running yet.
  const captureItems: MenuItem[] = [
    ...(capture?.browsers ?? []).map<MenuItem>((b) =>
      b.systemProxy
        ? {
            label: `A browser: ${b.label} (through the system proxy, restored on stop)`,
            icon: <Globe size={14} />,
            onSelect: () =>
              void startThen(() =>
                call<{ browser: string }>('debug.openBrowser', { browser: b.name }).then(
                  (r) => (toast(`${r.browser} opened; the system proxy points here until you stop, so other programs that follow it are captured too`), void loadStatus()),
                  toastError,
                ),
              ),
          }
        : {
            label: `A browser: ${b.label} (only that window)`,
            icon: <Globe size={14} />,
            onSelect: () => void startThen(() => call<{ browser: string }>('debug.openBrowser', { browser: b.name }).then((r) => toast(`${r.browser} started with a profile of its own; only its traffic is captured`), toastError)),
          },
    ),
    {
      label: 'A terminal: commands run in it (only those)',
      icon: <Terminal size={14} />,
      onSelect: () => void startThen(() => call<{ terminal: string }>('debug.openTerminal').then((r) => toast(`${r.terminal} opened with HTTP_PROXY set; only what runs in it is captured`), toastError)),
    },
    { label: 'A phone or another computer…', icon: <Smartphone size={14} />, onSelect: () => void startThen(() => setDialog('lan')) },
    // WF-12: a client that can't use a proxy points at a local address that forwards to the API (no certificate needed)
    { label: LABEL.captureReverseProxy, icon: <Disc size={14} />, onSelect: () => openReverseProxyCapture() },
    ...(status?.systemProxy ? [{ label: 'Stop capturing everything (restore the system proxy)', icon: <Globe size={14} />, separator: true, onSelect: () => void systemProxy(false) }] : []),
    ...(capture?.shells ?? []).map<MenuItem>((s) => ({ label: `Copy the lines for ${s.shell}`, icon: <Copy size={14} />, onSelect: () => void startThen(() => void copyText(s.lines, `the lines for ${s.shell}`)) })),
    { label: `Proxy port… (${port})`, icon: <Settings2 size={14} />, separator: true, disabled: !!status?.running, reason: 'Stop the proxy first', onSelect: () => void changePort() },
  ];
  // the session shown (the live capture, or the saved one open): the backend builds it from debug.har, secrets masked by default
  const outputSpec: OutputSpec = {
    id: 'debugger.session',
    what: 'debugger session',
    name: outputFileName({ name: viewing ? `debugger-${viewing}` : 'debugger-session', ext: '' }),
    formats: [
      { format: 'har', source: { kind: 'debugger' }, default: true },
      { format: 'json', source: { kind: 'debugger' } },
      { format: 'csv', source: { kind: 'debugger' } },
    ],
    empty: rows.length ? undefined : 'No exchanges captured',
  };
  // Save session and Clear the session: one definition each, rendered by the strip, the Session menu and nowhere else
  const acts = sessionActions({ canSave: rows.length > 0, canClear: !!status?.exchanges, save: () => void saveSession(), clear: () => void clear() });
  const transferItems: MenuItem[] = [
    { label: 'Import a HAR file…', icon: <Upload size={14} />, onSelect: () => void importHar() },
    { label: 'Import a Fiddler session (.saz)…', icon: <Upload size={14} />, onSelect: () => void importSaz() },
    { label: 'Export as HAR…', icon: <Download size={14} />, disabled: !rows.length, reason: 'Nothing captured yet', onSelect: () => void saveOutput(outputSpec, defaultFormat(outputSpec)) },
  ];
  const sessionItems: MenuItem[] = [
    acts.save,
    ...sessions.map<MenuItem>((s) => ({
      label: `Open ${s.name}${s.autosave ? ' (AutoSave)' : ''} · ${new Date(s.savedAt).toLocaleString()}`,
      icon: <FolderOpen size={14} />,
      onSelect: () => void openSession(s),
    })),
    // a saved session is git-ignored; sharing it puts a masked copy in debugger/shared/, which git tracks (release C of Everything under Git)
    ...sessions
      .filter((x) => !x.autosave)
      .map<MenuItem>((s) => ({ label: `Share ${s.name} with the team…`, icon: <Users size={14} />, title: 'Put a masked copy of this session in debugger/shared/, which git tracks', onSelect: () => void shareDebuggerSession(s.name) })),
    ...transferItems,
    acts.clear,
  ];

  return (
    <div className="h-full flex flex-col min-h-0">
      <PageHeader
        help="api-testing/http-debugger"
        icon={<Bug size={18} />}
        title="HTTP Debugger"
        subtitle={
          status?.running ? (
            <span className="inline-flex items-center gap-1.5">
              Proxy address <code className="font-mono text-fg">{status.url}</code>
              <button type="button" className="text-muted hover:text-fg" title="Copy the proxy address" aria-label="Copy the proxy address" onClick={() => void copyText(status.url ?? '', 'the proxy address')}>
                <Copy size={12} />
              </button>
              {status.systemProxy ? ' · the system proxy points here' : ' · programs sent through it show below'}
            </span>
          ) : (
            'Capture all traffic to see every program on this computer that follows the system proxy, or watch one program: a browser or a terminal opened through the proxy.'
          )
        }
        actions={
          <>
            {status?.running && (
              <Button icon={<Square size={13} />} onClick={() => void stop()}>
                Stop
              </Button>
            )}
            <NetworkSpeedMenu />
            {status?.running && <PauseButton paused={!!status.paused} onChange={(paused) => setStatus((s) => s && { ...s, paused })} />}
            {!status?.systemProxy && (
              <span data-capture-all className="inline-flex">
                <Button
                  variant={status?.running ? 'default' : 'primary'}
                  className={status?.running ? undefined : 'rounded-r-none'}
                  icon={<Globe size={13} />}
                  onClick={() => void captureAll()}
                  title="Start the proxy and point this computer's proxy setting at it: browsers and programs that follow the Windows, macOS or Linux proxy setting show up here. Stopping puts the setting back."
                >
                  Capture all traffic
                </Button>
                {!status?.running && (
                  <Menu
                    width={300}
                    items={[
                      {
                        label: 'Only a program I point at the proxy',
                        icon: <Play size={14} />,
                        title: 'Start the proxy alone: point a program at it yourself (HTTP_PROXY, --proxy-server). Nothing else on this computer is touched.',
                        onSelect: () => void start(),
                      },
                    ]}
                    trigger={
                      <Button variant="primary" className="rounded-l-none -ml-px px-1.5 border-l border-white/30" aria-label="Other ways to start" title="Other ways to start">
                        <ChevronDown size={13} />
                      </Button>
                    }
                  />
                )}
              </span>
            )}
            {recording ? (
              <>
                <span data-recording-badge>
                  <Badge tone="bad" title="Every exchange captured from now on becomes a step of the flow">
                    <Circle size={8} className="fill-current animate-pulse" /> Recording · {plural(recording.count, 'exchange')}
                  </Badge>
                </span>
                <Button variant="primary" icon={<Square size={13} />} onClick={() => void stopRecording()} title="Stop recording and create the flow from what was captured">
                  Stop recording
                </Button>
              </>
            ) : (
              <Menu
                width={300}
                items={[
                  { label: 'Create flow from selection…', icon: <Workflow size={14} />, disabled: !selection().length, reason: 'Select exchanges first', onSelect: () => createFlowFrom(selection()) },
                  { label: 'Save selection to collection…', icon: <FolderPlus size={14} />, disabled: !selection().length, reason: 'Select exchanges first', onSelect: () => saveToCollection(selection()) },
                  { label: 'Create RAG dataset from selection…', icon: <Database size={14} />, disabled: !selection().length, reason: 'Select exchanges first', onSelect: () => createDataset(selection()) },
                  { label: 'Record a flow…', icon: <Circle size={14} />, onSelect: () => void startRecording() },
                ]}
                trigger={
                  <Button icon={<Workflow size={13} />} title="Make a test flow of exchanges: the selected rows, or what you do next in your program">
                    Flow <ChevronDown size={12} />
                  </Button>
                }
              />
            )}
            <Menu
              width={360}
              items={captureItems}
              onOpenChange={(o) => o && void loadCapture()}
              trigger={
                <Button icon={<Globe size={13} />} title="What to capture: a browser, a terminal, a phone or one API (only that program)">
                  Capture <ChevronDown size={12} />
                </Button>
              }
            />
            <Menu
              width={330}
              items={[
                {
                  label: status?.decrypt ? 'Stop decrypting HTTPS' : 'See inside HTTPS…',
                  icon: status?.decrypt ? <LockOpen size={14} /> : <Lock size={14} />,
                  title: status?.decrypt ? undefined : 'Turn on HTTPS decryption: TestPion asks once to trust its certificate',
                  // turning it on is the one flow with the question about the certificate; turning it off is a plain switch
                  onSelect: () =>
                    status?.decrypt
                      ? void call<Status>('debug.decrypt', { on: false }).then((st) => (setStatus(st), toast('HTTPS is a tunnel again')), toastError)
                      : void readHttps(),
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
                    if (v !== null) void call<Status>('debug.decrypt', { noDecrypt: v.split(',') }).then(setStatus, toastError);
                  },
                },
              ]}
              trigger={
                <Button
                  icon={status?.decrypt ? <Lock size={13} className="text-ok" /> : <LockOpen size={13} className="text-muted" />}
                  title={status?.decrypt ? 'HTTPS is decrypted for programs that trust the TestPion root certificate' : 'HTTPS shows as tunnels by host; decrypt it to see the requests inside'}
                  aria-label={status?.decrypt ? 'HTTPS (decrypted)' : 'HTTPS (tunnels)'}
                >
                  HTTPS <ChevronDown size={12} />
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
      <LibraryTabStrip
        label="Open sessions"
        library="debugger"
        refOf={(t) => (t.savedId ? { kind: 'capture', name: t.savedId } : undefined)}
        tabs={sessionTabs.tabs}
        active={sessionTabs.active.id}
        titleOf={(t) => (t.savedId ? (t.savedId === 'autosave' ? 'AutoSave' : t.savedId) : 'Live capture')}
        fixed={(t) => !t.savedId}
        onSelect={sessionTabs.select}
        onClose={(ids) => sessionTabs.close(ids.filter((id) => sessionTabs.tabs.find((t) => t.id === id)?.savedId), null)}
        onKeep={sessionTabs.keep}
      />
      {viewing && (
        <div className="flex items-center gap-2 px-3 py-1 border-b border-line text-xs bg-panel" data-session-tab={viewing}>
          <FolderOpen size={12} className="text-muted" />
          <span className="text-muted">
            Saved session <b className="text-fg">{viewing}</b> (debugger/{viewing}.har): the live capture goes on in its own tab.
          </span>
          <Button size="sm" variant="ghost" className="ml-auto" icon={<Plus size={12} />} onClick={() => void addToLive(viewing)}>
            Add to the live capture
          </Button>
        </div>
      )}
      <Tabs label="Debugger"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'traffic', label: 'Traffic', badge: (viewing ? rows.length : status?.exchanges) || undefined },
          { id: 'stats', label: 'Statistics' },
          { id: 'connections', label: 'Connections' },
          { id: 'rules', label: 'Rules', badge: rules?.activeCount || undefined },
        ]}
      />
      {tab === 'stats' ? (
        <StatsPanel stats={stats} onPick={(id) => (setTab('traffic'), setSelected(id))} running={!!status?.running} onStart={() => void captureAll()} onRecord={() => void startRecording()} />
      ) : tab === 'connections' ? (
        <ConnectionsView rows={rows} onPick={(id) => (setTab('traffic'), setSelected(id))} />
      ) : tab === 'rules' ? (
        <RulesPanel state={rules} onChange={setRules} host={sel?.host} />
      ) : (
        <div className="flex-1 min-h-0 flex">
          <ToolRail
            active={dock}
            onPanel={(p) => (dock === p && dockShown ? openDock(undefined) : openDock(p))}
            onSubmit={() => (sel ? openInTab(sel) : useApp.getState().openIntent('rest', {}))}
            exportItems={transferItems}
          />
          <div className="flex-1 min-w-0">
            {/* the dock is a pinnable panel: pinned beside the grid, or a tab on the right edge that slides it over */}
            <div className="h-full flex min-h-0 min-w-0">
              <div className="h-full flex-1 min-w-0 flex flex-col min-h-0 outline-none" tabIndex={0} onKeyDown={onKey} aria-label="Captured exchanges">
                {status?.running && !status.decrypt && httpsBanner && rows.some((r) => r.kind === 'tunnel') && (
                  <div className="flex items-center gap-2 px-3 py-1 border-b border-line text-xs bg-accent-soft" data-https-banner>
                    <Lock size={12} className="text-accent" />
                    <span>
                      <b>HTTPS shows as tunnels</b> — see inside it to read the requests (TestPion asks once to trust its certificate).
                    </span>
                    <Button size="sm" variant="primary" onClick={() => void readHttps()}>
                      See inside HTTPS…
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDialog('certificate')}>
                      Install certificate…
                    </Button>
                    <button type="button" className="ml-auto text-muted hover:text-fg" aria-label="Hide this message" onClick={() => setHttpsBanner(false)}>
                      <X size={12} />
                    </button>
                  </div>
                )}
                {(!!rules?.activeCount || held.length > 0 || compareA || status?.paused) && (
                  <div className="flex items-center gap-3 px-2 py-1 border-b border-line text-xs bg-panel/60" data-rules-bar>
                    {!!rules?.activeCount && (
                      <button
                        type="button"
                        className="flex items-center gap-1 text-muted hover:text-fg"
                        onClick={() => setTab('rules')}
                        title="The rules of the active profile act on the traffic; click to see them"
                      >
                        <Scale size={12} /> {plural(rules.activeCount, 'rule')} active · {rules.active}
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
                    {held.length > 1 && (
                      <Button size="sm" variant="ghost" icon={<Play size={12} />} title="Let every held exchange go on as it was" data-resume-all onClick={() => void call('debug.resumeAll').then(() => undefined, toastError)}>
                        Resume all
                      </Button>
                    )}
                    {status?.paused && (
                      <span className="flex items-center gap-1 text-warn font-medium" data-listing-paused title="The proxy still forwards the traffic. New requests are not listed until you resume.">
                        <Pause size={12} /> Listing paused · new traffic is forwarded but not listed
                      </span>
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
                <div className="flex gap-1.5 p-2 border-b border-line items-center flex-wrap text-xs" data-filter-bar>
                  <FilterInput
                    ref={filterBox}
                    className="w-44"
                    placeholder={filter.deep ? 'Find in URLs, headers and bodies' : 'Filter requests'}
                    label="Filter exchanges"
                    value={filter.text}
                    onChange={(text) => setFilter({ ...filter, text })}
                  />
                  <label className="flex items-center gap-1 text-xs text-muted whitespace-nowrap" title="Search headers and bodies too">
                    <input type="checkbox" checked={filter.deep} onChange={(e) => setFilter({ ...filter, deep: e.target.checked })} /> In bodies
                  </label>
                  <Select className="h-7 min-h-7 py-0 text-xs" aria-label="Application" value={filter.application} onChange={(e) => setFilter({ ...filter, application: e.target.value })}>
                    <option value="">All applications</option>
                    {seen.apps.map((h) => (
                      <option key={h}>{h}</option>
                    ))}
                  </Select>
                  <Select className="h-7 min-h-7 py-0 text-xs" aria-label="Host" value={filter.host} onChange={(e) => setFilter({ ...filter, host: e.target.value })}>
                    <option value="">All domains</option>
                    {seen.hosts.map((h) => (
                      <option key={h}>{h}</option>
                    ))}
                  </Select>
                  <Select className="h-7 min-h-7 py-0 text-xs" aria-label="Type" value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}>
                    <option value="">All types</option>
                    {seen.types.map((h) => (
                      <option key={h}>{h}</option>
                    ))}
                  </Select>
                  <Select className="h-7 min-h-7 py-0 text-xs" aria-label="Method" value={filter.method} onChange={(e) => setFilter({ ...filter, method: e.target.value })}>
                    <option value="">Any method</option>
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT'].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </Select>
                  <Select className="h-7 min-h-7 py-0 text-xs" aria-label="Status" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value as typeof filter.status })}>
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
                  <label className="flex items-center gap-1 text-xs text-muted whitespace-nowrap" title="Leave out the HTTPS tunnels (CONNECT) that are not decrypted">
                    <input type="checkbox" checked={filter.hideTunnels} onChange={(e) => setFilter({ ...filter, hideTunnels: e.target.checked })} /> Hide tunnels
                  </label>
                  <label className="flex items-center gap-1 text-xs text-muted whitespace-nowrap" title="Leave out the 304 Not Modified answers">
                    <input type="checkbox" checked={!!filter.hide304} onChange={(e) => setFilter({ ...filter, hide304: e.target.checked })} /> Hide 304s
                  </label>
                  {filter.quick.map((q) => (
                    <button
                      key={q.id}
                      type="button"
                      className="flex items-center gap-1 h-6 px-2 rounded-full bg-chip text-chip-fg text-xs whitespace-nowrap hover:bg-hover hover:text-fg"
                      title={chipTitle(q)}
                      aria-label={chipAria(q)}
                      data-quick-filter
                      onClick={() => setFilter((f) => ({ ...f, quick: f.quick.filter((x) => x.id !== q.id) }))}
                    >
                      {chipText(q)} <X size={11} aria-hidden />
                    </button>
                  ))}
                  <Menu
                    width={260}
                    items={[
                      ...(rules?.filterPresets ?? []).map<MenuItem>((p) => ({ label: p.name, onSelect: () => setFilter((f) => applyPreset(f, p.filter)) })),
                      {
                        label: 'Save this filter…',
                        icon: <Save size={14} />,
                        onSelect: async () => {
                          const name = await promptText('Save filter preset', {
                            message: 'The current filter (text, host, method, status, bookmarked) under a name, for this workspace. The Capture only and Filter out chips are not saved: the rules are.',
                            placeholder: 'Name',
                          });
                          if (name) void call<RulesState['filterPresets']>('debug.saveFilterPreset', { name, filter: presetOf(filter) }).then((fp) => setRules((r) => r && { ...r, filterPresets: fp }), toastError);
                        },
                      },
                      // at once, with Undo in the message (the preset is saved again as it was)
                      ...(rules?.filterPresets ?? []).map<MenuItem>((p) => ({
                        label: `Forget ${p.name}`,
                        icon: <Trash2 size={14} />,
                        danger: true,
                        onSelect: () =>
                          void deleteWithUndo({
                            what: `the filter preset "${p.name}"`,
                            run: async () => {
                              const fp = await call<RulesState['filterPresets']>('debug.deleteFilterPreset', { name: p.name });
                              setRules((r) => r && { ...r, filterPresets: fp });
                            },
                            undo: async () => {
                              const fp = await call<RulesState['filterPresets']>('debug.saveFilterPreset', { name: p.name, filter: p.filter });
                              setRules((r) => r && { ...r, filterPresets: fp });
                            },
                          }),
                      })),
                    ]}
                    trigger={
                      <Button size="sm" title="Saved filters">
                        Presets <ChevronDown size={12} />
                      </Button>
                    }
                  />
                  <BreakpointSplit rules={rules} onRules={setRules} onCustom={() => setRuleDraft(customBreakpointRule())} />
                  {filtersOn && (
                    <Button size="sm" variant="ghost" icon={<X size={13} />} title="Show every exchange again: clear the text, the dropdowns, the checkboxes and the chips" data-clear-filters onClick={() => setFilter(noFilter)}>
                      Clear filters
                    </Button>
                  )}
                  <span className="ml-auto flex items-center gap-1.5 pl-2 border-l border-line" data-session-actions>
                    <ActionButton item={acts.save} label="Save session" />
                    <ActionButton item={acts.clear} label="Clear" />
                  </span>
                  <OutputActions spec={outputSpec}>
                    <button
                      type="button"
                      className="flex items-center gap-1 text-xs text-muted hover:text-fg"
                      onClick={() => openDock('filter')}
                      title="Filter-out and capture-only rules on"
                      data-filter-rule-count
                    >
                      <Filter size={12} /> {(rules?.rules ?? []).filter((r) => r.enabled && (r.kind === 'ignore' || r.kind === 'only')).length}
                    </button>
                  </OutputActions>
                </div>
                <div className="flex-1 min-h-0" data-output="debugger.session">
                  <Split id="debugger" direction="vertical" initial={58} collapsedSecond={side === 'incoming' ? !incomingSel : !sel}>
                    <div className="h-full flex flex-col min-h-0">
                      {side === 'incoming' ? (
                        <IncomingList list={incoming.list} onClear={incoming.clear} selected={incomingSel} onSelect={setIncomingSel} />
                      ) : !rows.length && !!status?.exchanges && filtersOn ? (
                        <Empty icon={<Filter size={26} />} title="No exchange matches the filters" actions={[{ label: 'Show all', onClick: () => setFilter(noFilter) }]}>
                          {plural(status.exchanges, 'exchange')} captured, hidden by the filters above.
                        </Empty>
                      ) : !rows.length ? (
                        <Empty
                          icon={<Bug size={26} />}
                          title={status?.running ? 'Waiting for traffic' : 'Not capturing'}
                          actions={[
                            ...(status?.systemProxy ? [] : [{ label: LABEL.captureAll, icon: <Globe size={14} />, onClick: () => void captureAll() }]),
                            { label: 'More ways to capture', icon: <Globe size={14} />, items: captureItems, primary: !!status?.systemProxy },
                            { label: 'Record a flow…', icon: <Circle size={14} />, onClick: () => void startRecording(), primary: false },
                          ]}
                        >
                          {status?.running ? (
                            <>
                              Open a browser or a terminal through the proxy, or point a program at{' '}
                              <button type="button" className="mono text-fg underline decoration-dotted" title="Copy the proxy address" onClick={() => void copyText(status.url ?? '', 'the proxy address')}>
                                {status.url}
                              </button>{' '}
                              yourself (<span className="mono">HTTP_PROXY</span>, <span className="mono">--proxy-server</span>). Requests appear here as they happen.
                            </>
                          ) : (
                            <>Watch every program on this computer that follows the system proxy, or just one: a browser or a terminal opened through the proxy. The Session menu opens a saved capture.</>
                          )}
                        </Empty>
                      ) : (
                        <DebuggerGrid
                          rows={rows}
                          selected={selected}
                          selectedIds={selectedIds}
                          onOrder={onOrder}
                          onSelect={gridSelect.onSelect}
                          actions={gridActions}
                          decrypt={!!status?.decrypt}
                        />
                      )}
                      <TrafficSide side={side} onSide={setSide} incoming={incoming.list.length} />
                      {(side === 'incoming' ? !incomingSel : !sel) && (
                        <div className="px-3 py-1.5 border-t border-line text-xs text-muted shrink-0" data-details-hint>
                          Select a row: its request and response open here side by side. Double-click opens it as a request.
                        </div>
                      )}
                    </div>
                    <div className="h-full flex flex-col min-h-0">
                      {side === 'incoming' ? (
                        (() => {
                          const r = incoming.list.find((x) => x.id === incomingSel);
                          if (!r) return <Empty title="Select a request">What your program sent to the mock server and what it answered, side by side.</Empty>;
                          const e = incomingAsExchange(r);
                          return <ExchangePanes e={e} onOpen={() => openInTab(e)} onAsk={aiOn ? () => ask(e) : undefined} />;
                        })()
                      ) : !sel ? (
                        <Empty title="Select an exchange">Its request and response show side by side: headers, content, raw text and JSON.</Empty>
                      ) : (
                        <ExchangePanes
                          e={sel}
                          onOpen={paneActions.onOpen}
                          onResend={paneActions.onResend}
                          onKeepEncrypted={status?.decrypt || certificateError(sel) ? paneActions.onKeepEncrypted : undefined}
                          onAsk={aiOn ? paneActions.onAsk : undefined}
                          onBookmark={paneActions.onBookmark}
                          onDelete={paneActions.onDelete}
                          onCompare={paneActions.onCompare}
                          onRule={paneActions.onRule}
                        />
                      )}
                    </div>
                  </Split>
                </div>
                {rows.length > 0 && <GridTotals rows={rows} selectedIds={selectedIds} total={list.all.length} />}
              </div>
              {dock && (
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
                  reveal={dockReveal}
                  onShownChange={setDockShown}
                />
              )}
            </div>
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
            await attempt(async () => {
              setRules(await call<RulesState>('debug.saveRule', { rule: r }));
              setRuleDraft(undefined);
              toast('Rule saved');
            });
          }}
        />
      )}
      {dialog === 'lan' && (
        <LanDialog
          onClose={() => setDialog(undefined)}
          onRestartOnLan={async () => {
            await attempt(async () => {
              setStatus(await call<Status>('debug.start', { port: status?.port, lan: true }));
            });
          }}
        />
      )}
      {flowFrom && <CreateFlowDialog ids={flowFrom.ids} since={flowFrom.since} onClose={() => setFlowFrom(undefined)} />}
      {datasetFrom && <RagCaptureDialog initial={{ from: 'exchanges', exchanges: datasetFrom.ids, label: `${plural(datasetFrom.ids.length, 'exchange')} of the Debugger` }} onClose={() => setDatasetFrom(undefined)} />}
      {saveFrom && <SaveToCollectionDialog ids={saveFrom.ids} since={saveFrom.since} onClose={() => setSaveFrom(undefined)} />}
      {comparePair && <CompareExchangesDialog a={comparePair.a} b={comparePair.b} onClose={() => setComparePair(undefined)} />}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = { '2xx': 'bg-ok', '3xx': 'bg-accent', '4xx': 'bg-warn', '5xx': 'bg-bad', error: 'bg-bad', pending: 'bg-muted' };

/** The session in numbers: the overview (requests over time, the status mix), by host, type and program, the largest and the slowest. */
function StatsPanel({ stats, onPick, running, onStart, onRecord }: { stats?: Stats; onPick(id: string): void; running: boolean; onStart(): void; onRecord(): void }) {
  if (!stats || !stats.total)
    return (
      <div className="flex-1 min-h-0 overflow-auto p-4">
        <Empty
          icon={<Bug size={26} />}
          title="Nothing captured yet"
          actions={[...(running ? [] : [{ label: LABEL.captureAll, onClick: onStart }]), { label: 'Record a flow…', onClick: onRecord, primary: running }]}
        >
          {running ? 'The proxy is on: send some traffic through it' : 'Send some traffic through the proxy'}; the session's numbers appear here.
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
        <SectionTitle size="sm" className="mb-1">Requests over time</SectionTitle>
        <div className="flex items-end gap-px h-20 border-b border-line" role="img" aria-label="Requests per time slice">
          {stats.timeline.map((b, i) => (
            <div key={i} className="flex-1 flex flex-col justify-end h-full" title={`${new Date(b.t).toLocaleTimeString()}: ${b.count} requests, ${b.errors} errors`}>
              <div className={cx('w-full rounded-t-sm', b.errors ? 'bg-bad/70' : 'bg-accent/70')} style={{ height: `${(b.count / peak) * 100}%` }} />
            </div>
          ))}
        </div>
      </section>
      <section>
        <SectionTitle size="sm" className="mb-1">Status mix</SectionTitle>
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
          <SectionTitle size="sm" className="mb-1">{title}</SectionTitle>
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
          <SectionTitle size="sm" className="mb-1">{title}</SectionTitle>
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
