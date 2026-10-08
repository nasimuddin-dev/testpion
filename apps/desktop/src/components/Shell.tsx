import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  Bot,
  Boxes,
  CheckCircle2,
  Cpu,
  FlaskConical,
  FolderTree,
  Gauge,
  GitBranch,
  HelpCircle,
  History,
  House,
  Info,
  KeyRound,
  Network,
  Plug,
  Radio,
  Bookmark,
  Waypoints,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  X,
  AlarmClock,
  ArrowLeft,
  ArrowRight,
  ChevronDown as NavChevron,
  Menu as MenuIcon,
  MessageSquare,
  FolderGit2,
  Bug,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { call, modKey, on } from '../api';
import { useGit } from '../lib/git';
import wordmarkUrl from '../../build/wordmark-nav.png';
import markUrl from '../../build/icons/64x64.png';
import { ConsolePanel } from './ConsolePanel';
import { WorkspaceMenu } from './WorkspaceMenu';
import { EnvQuickLook } from './EnvQuickLook';
import { isRequestView, useApp, type ViewId, type DialogRequest, type DialogTone, type NavLocation } from '../store';
import { Badge, Button, cx, IconButton, Input, Kbd, Menu, Modal, Spinner, Tooltip, type MenuItem } from './ui';
import { Toaster as SonnerToaster } from 'sonner';

/**
 * The main navigation, grouped by what you are doing: send requests (per protocol), test and run
 * them, AI, then the workspace's data. Order is also the Ctrl/Cmd+Alt+1… shortcut order.
 */
export const NAV: Array<{ id: ViewId; label: string; icon: ReactNode; group: string; hint?: string }> = [
  { id: 'home', label: 'Home', icon: <House size={18} />, group: 'Start' },
  { id: 'rest', label: 'REST', icon: <Network size={18} />, group: 'Requests', hint: 'REST / HTTP requests' },
  { id: 'graphql', label: 'GraphQL', icon: <GitBranch size={18} />, group: 'Requests' },
  { id: 'grpc', label: 'gRPC', icon: <Waypoints size={18} />, group: 'Requests' },
  { id: 'websocket', label: 'WebSocket', icon: <Radio size={18} />, group: 'Requests', hint: 'WebSocket, Socket.IO, MQTT and Kafka' },
  { id: 'mcp', label: 'MCP', icon: <Plug size={18} />, group: 'Requests', hint: 'MCP servers (inspector)' },
  { id: 'debugger', label: 'Debugger', icon: <Bug size={18} />, group: 'Testing', hint: 'HTTP Debugger: the traffic of other programs through a local proxy' },
  { id: 'tests', label: 'Tests', icon: <ShieldCheck size={18} />, group: 'Testing', hint: 'Test files and runs' },
  { id: 'monitors', label: 'Monitors', icon: <AlarmClock size={18} />, group: 'Testing', hint: 'Scheduled runs' },
  { id: 'load', label: 'Load', icon: <Gauge size={18} />, group: 'Testing', hint: 'Load tests' },
  { id: 'ai', label: 'AI Lab', icon: <Sparkles size={18} />, group: 'AI', hint: 'Prompts and model comparison' },
  { id: 'evaluations', label: 'Evaluations', icon: <FlaskConical size={18} />, group: 'AI', hint: 'LLM, RAG and agent evaluations' },
  { id: 'environments', label: 'Environments', icon: <KeyRound size={18} />, group: 'Workspace', hint: 'Environments and variables' },
  { id: 'history', label: 'History', icon: <History size={18} />, group: 'Workspace' },
  { id: 'traces', label: 'Traces', icon: <Activity size={18} />, group: 'Workspace', hint: 'Traces of every request and run' },
  { id: 'git', label: 'Git', icon: <FolderGit2 size={18} />, group: 'Workspace', hint: 'Git: changes, commit, branches, pull and push' },
];

/** The rail: the request editors are reached through Collections (explorer, New menu), not listed one by one. */
const RAIL = NAV.filter((n) => n.group !== 'Requests');

export function Sidebar() {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const item = (id: ViewId, label: string, icon: ReactNode, shortcut?: string, hint?: string) => (
    <Tooltip content={shortcut ? `${hint ?? label}  ·  ${shortcut}` : (hint ?? label)} side="right">
      <button
        onClick={() => setView(id)}
        aria-current={view === id ? 'page' : undefined}
        aria-label={label}
        className={cx(
          // short windows: icons only (the tooltip names them), so the whole rail fits without scrolling
          'group relative w-full flex flex-col items-center gap-0.5 py-1 [@media(max-height:680px)]:py-0.5 rounded-xl text-[0.72rem] font-medium transition-colors duration-150',
          view === id ? 'text-fg' : 'text-muted hover:text-fg',
        )}
      >
        {view === id && <span aria-hidden className="absolute -left-1.5 top-2 h-6 w-[3px] rounded-r-full bg-[image:var(--brand-gradient)]" />}
        <span
          className={cx(
            'grid place-items-center h-8 w-12 rounded-lg transition-[background-color,color,transform] duration-150 group-active:scale-90 [&>svg]:h-[22px] [&>svg]:w-[22px] [@media(max-height:680px)]:[&>svg]:h-5 [@media(max-height:680px)]:[&>svg]:w-5',
            view === id ? 'bg-accent-soft text-accent shadow-sm ring-1 ring-accent/15' : 'group-hover:bg-hover',
          )}
        >
          {icon}
        </span>
        <span className="w-full truncate px-0.5 text-center leading-tight [@media(max-height:680px)]:hidden">{label}</span>
      </button>
    </Tooltip>
  );
  const explorerOpen = useApp((s) => s.explorerOpen);
  const inRequests = isRequestView(view);
  // Collections: every request editor (REST, GraphQL, gRPC, WebSocket, MCP) with the explorer as its sidebar;
  // clicking it again while there shows or hides the explorer (like VS Code's activity bar)
  const explorerToggle = (
    <Tooltip content={inRequests ? `${explorerOpen ? 'Hide' : 'Show'} the Collections sidebar  ·  ${modKey}+B` : 'Collections: requests of every kind (REST, GraphQL, gRPC, WebSocket, MCP)'} side="right">
      <button
        onClick={() => {
          const s = useApp.getState();
          if (inRequests) return s.toggleExplorer();
          s.setView(s.lastRequestView);
          s.toggleExplorer(true);
        }}
        aria-current={inRequests ? 'page' : undefined}
        aria-label="Collections"
        className={cx(
          'group relative w-full flex flex-col items-center gap-0.5 py-1 [@media(max-height:680px)]:py-0.5 rounded-xl text-[0.72rem] font-medium transition-colors duration-150',
          inRequests ? 'text-fg' : 'text-muted hover:text-fg',
        )}
      >
        {inRequests && <span aria-hidden className="absolute -left-1.5 top-2 h-6 w-[3px] rounded-r-full bg-[image:var(--brand-gradient)]" />}
        <span className={cx('grid place-items-center h-8 w-12 rounded-lg transition-[background-color,color,transform] duration-150 group-active:scale-90 [&>svg]:h-[22px] [&>svg]:w-[22px] [@media(max-height:680px)]:[&>svg]:h-5 [@media(max-height:680px)]:[&>svg]:w-5', inRequests ? 'bg-accent-soft text-accent shadow-sm ring-1 ring-accent/15' : 'group-hover:bg-hover')}>
          <FolderTree size={18} />
        </span>
        <span className="w-full truncate px-0.5 text-center leading-tight [@media(max-height:680px)]:hidden">Collections</span>
      </button>
    </Tooltip>
  );
  return (
    <nav aria-label="Main navigation" className="w-[84px] [@media(max-height:680px)]:w-[64px] shrink-0 border-r border-line bg-chrome flex flex-col items-stretch gap-0.5 px-1.5 py-2 overflow-y-auto overflow-x-hidden [scrollbar-width:none]">
      {RAIL.map((n, i) => (
        <div key={n.id}>
          {i > 0 && RAIL[i - 1]!.group !== n.group && <div className="mx-3 my-1 [@media(max-height:680px)]:my-0.5 border-t border-line/70" />}
          {item(n.id, n.label, n.icon, NAV.indexOf(n) < 9 ? `${modKey}+Alt+${NAV.indexOf(n) + 1}` : undefined, n.hint)}
          {n.id === 'home' && <div className="mt-0.5">{explorerToggle}</div>}
        </div>
      ))}
      <div className="mt-auto pt-2">{item('settings', 'Settings', <Settings size={18} />, `${modKey}+,`)}</div>
    </nav>
  );
}

/** The environment switcher: a colour dot on the left of every environment (red for production), the app's own menu. */
function EnvironmentPicker() {
  const ws = useApp((s) => s.workspace);
  const env = useApp((s) => s.environment);
  const envObj = ws?.environments.find((e) => e.name === env);
  const colorOf = (e?: { color?: string; isProduction?: boolean }) => (e ? (e.color ?? (e.isProduction ? 'var(--bad)' : 'var(--ok)')) : 'var(--line-strong)');
  const Dot = ({ color, ring }: { color: string; ring?: boolean }) => <span className={cx('inline-block w-2.5 h-2.5 rounded-full shrink-0', ring && 'ring-2 ring-bad/40')} style={{ background: color }} aria-hidden />;
  const items: MenuItem[] = [
    { label: 'No environment', icon: <Dot color="var(--line-strong)" />, onSelect: () => useApp.getState().setEnvironment(undefined) },
    ...(ws?.environments ?? []).map((e) => ({
      label: e.isProduction ? `${e.name}  (production)` : e.name,
      icon: <Dot color={colorOf(e)} ring={e.isProduction} />,
      onSelect: () => useApp.getState().setEnvironment(e.name),
    })),
    { label: 'Manage environments…', icon: <KeyRound size={14} />, separator: true, onSelect: () => useApp.getState().openIntent('environments', {}) },
  ];
  return (
    <Menu
      items={items}
      width={240}
      trigger={
        <button
          aria-label="Environment"
          title={envObj ? `Active environment: ${envObj.name}${envObj.isProduction ? ' (production)' : ''}` : 'No environment: choose one'}
          className={cx('flex items-center gap-2 h-8 pl-2.5 pr-2 rounded-full border bg-field shadow-sm text-sm max-w-56 transition-colors data-[state=open]:bg-hover', envObj?.isProduction ? 'border-bad/50' : 'border-line-strong hover:border-muted/50')}
        >
          <Dot color={colorOf(envObj)} />
          <span className="truncate">{env ?? 'No environment'}</span>
          <NavChevron size={13} className="text-muted shrink-0" />
        </button>
      }
    />
  );
}

/** Any CSS colour (oklch …) as #rrggbb, which Electron's title bar understands. */
function toHex(css: string): string {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const g = c.getContext('2d')!;
  g.fillStyle = css;
  g.fillRect(0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
  return '#' + [r, gr, b].map((v) => v!.toString(16).padStart(2, '0')).join('');
}

/** Where the app draws the title bar: keep the window buttons in the theme's colours (they follow light / dark). */
function useTitleBarColors(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const bridge = window.aps;
    if (!bridge?.titleBar || !bridge.titleBarColors) return;
    const sync = () => {
      if (!ref.current) return;
      const cs = getComputedStyle(ref.current);
      const muted = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || cs.color;
      bridge.titleBarColors!(toHex(cs.backgroundColor), toHex(muted), ref.current.getBoundingClientRect().height);
    };
    sync();
    // a zoom change (UI scale) resizes the page: the window buttons follow the bar's height
    let t: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => (clearTimeout(t), (t = setTimeout(sync, 150)));
    addEventListener('resize', onResize);
    const mo = new MutationObserver(() => requestAnimationFrame(sync));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', sync);
    return () => (mo.disconnect(), mq.removeEventListener('change', sync), removeEventListener('resize', onResize), clearTimeout(t));
  }, [ref]);
}

export function TopBar() {
  const set = useApp((s) => s.set);
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;
  const header = useRef<HTMLElement>(null);
  const drawn = !!window.aps?.titleBar;
  useTitleBarColors(header);
  return (
    <header
      ref={header}
      className="h-12 shrink-0 border-b border-line flex items-center gap-2 px-3 bg-chrome"
      // the drawn title bar: the window buttons sit over the right end (titlebar-area-width is what is left of it)
      style={{ WebkitAppRegion: 'drag', ...(drawn ? { paddingRight: 'calc(100vw - env(titlebar-area-width, calc(100vw - 138px)) + 8px)' } : {}) } as React.CSSProperties}
    >
      {drawn && (
        <IconButton
          label="Menu (File, Edit, View, Window, Help)"
          className="h-8 w-8 -ml-1"
          style={noDrag}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            window.aps?.appMenu?.(r.left, r.bottom + 4);
          }}
        >
          <MenuIcon size={17} />
        </IconButton>
      )}
      <div className="flex items-center gap-2 pr-1" style={noDrag}>
        {/* the TestPion wordmark; on the light theme it sits on a navy badge so the white "Pion" stays visible */}
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-[#0c1440] px-2 py-1 dark:bg-transparent dark:px-0 dark:py-0">
          <img src={markUrl} alt="" aria-hidden className="h-7 w-7 select-none" draggable={false} />
          <img src={wordmarkUrl} alt="TestPion" className="h-6 w-auto select-none" draggable={false} />
        </span>
      </div>
      <span className="h-5 w-px bg-line hidden md:block" />
      <div style={noDrag}>
        <WorkspaceMenu />
      </div>
      <div style={noDrag}>
        <NavButtons />
      </div>
      <button
        data-search-trigger
        onClick={() => set({ searchOpen: true })}
        style={noDrag}
        className="mx-auto flex items-center gap-2 h-8 w-[min(480px,38vw)] rounded-full border border-line bg-field px-3.5 text-sm text-muted shadow-sm transition-colors hover:border-line-strong hover:text-fg"
      >
        <Search size={15} />
        <span className="truncate">Search requests, tests, tools, traces…</span>
        <span className="ml-auto hidden sm:inline">
          <Kbd>{modKey}+Shift+F</Kbd>
        </span>
      </button>
      <div className="flex items-center gap-1.5" style={noDrag}>
        <EnvironmentPicker />
        <EnvQuickLook />
        <Button size="md" variant="ghost" onClick={() => set({ paletteOpen: true })} icon={<TerminalSquare size={15} />}>
          <span className="hidden lg:inline">Commands</span> <Kbd>{modKey}+K</Kbd>
        </Button>
        <IconButton label="AI assistant" onClick={() => set({ assistant: { task: 'free', title: 'Ask the assistant', context: {} } })}>
          <Bot size={17} />
        </IconButton>
        <IconButton label="Settings" onClick={() => useApp.getState().setView('settings')}>
          <Settings size={17} />
        </IconButton>
      </div>
    </header>
  );
}

/**
 * The HTTP Debugger in the status bar, wherever you are: shown while its proxy runs, in warning colour when rules
 * change what programs send or get, and when the system proxy points at it (so a forgotten capture is never invisible).
 */
function DebuggerSegment() {
  const [st, setSt] = useState<{ running: boolean; port?: number; changingRules: number; systemProxy: boolean }>();
  useEffect(() => {
    const load = () => void call<typeof st>('debug.status').then(setSt, () => undefined);
    load();
    const offState = on<typeof st>('debug.state', (s) => setSt(s));
    const offRules = on('debug.rules', load);
    return () => (offState(), offRules());
  }, []);
  if (!st?.running) return null;
  const warn = st.changingRules > 0 || st.systemProxy;
  return (
    <button
      className={cx('flex items-center gap-1 hover:text-fg', warn && 'text-warn')}
      title={`HTTP Debugger capturing on port ${st.port}${st.changingRules ? `; ${plural(st.changingRules, 'rule')} change traffic` : ''}${st.systemProxy ? '; the system proxy points here' : ''}. Click to open it.`}
      onClick={() => useApp.getState().setView('debugger')}
    >
      <Bug size={12} /> Debugger :{st.port}
      {st.changingRules > 0 && ` · ${plural(st.changingRules, 'rule')} active`}
      {st.systemProxy && ' · system proxy'}
    </button>
  );
}

export function StatusBar() {
  const ws = useApp((s) => s.workspace);
  const env = useApp((s) => s.environment);
  const activity = useApp((s) => s.activity);
  const info = useApp((s) => s.info);
  const mcp = useApp((s) => s.mcpConnected);
  const logsOpen = useApp((s) => s.logsOpen);
  const bottomTab = useApp((s) => s.bottomTab);
  const envObj = ws?.environments.find((e) => e.name === env);
  const acts = Object.values(activity);
  return (
    <footer className="h-7 shrink-0 border-t border-line bg-chrome flex items-center gap-4 px-3 text-[0.75rem] text-muted">
      <span className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full" style={{ background: envObj ? (envObj.color ?? (envObj.isProduction ? 'var(--bad)' : 'var(--ok)')) : 'var(--line-strong)' }} />
        {env ?? 'No environment'}
        {envObj?.isProduction && <Badge tone="bad">PRODUCTION</Badge>}
      </span>
      <span className="flex items-center gap-1" title="Connected MCP servers">
        <Plug size={12} /> {mcp} MCP connected
      </span>
      <GitSegment />
      <DebuggerSegment />
      <span className="flex items-center gap-1.5">
        {acts.length ? (
          <>
            <Spinner size={11} /> {acts[0]}
            {acts.length > 1 ? ` (+${acts.length - 1})` : ''}
          </>
        ) : (
          <>
            <Cpu size={12} /> Idle
          </>
        )}
      </span>
      <span className="ml-auto flex items-center gap-1" title={`Secrets are stored with ${info?.secretBackend}`}>
        <KeyRound size={12} /> {info?.secretBackend}
      </span>
      <span title="Metadata storage">{info?.metaBackend === 'sqlite' ? 'SQLite' : info?.metaBackend}</span>
      {(['console', 'logs'] as const).map((t) => (
        <button
          key={t}
          className={cx('flex items-center gap-1 hover:text-fg', logsOpen && bottomTab === t && 'text-fg')}
          title={t === 'console' ? 'Console: requests and script output (Ctrl+Alt+C)' : 'Application logs'}
          onClick={() => useApp.getState().set(logsOpen && bottomTab === t ? { logsOpen: false } : { logsOpen: true, bottomTab: t })}
        >
          {t === 'console' ? <TerminalSquare size={12} /> : <ScrollText size={12} />} {t === 'console' ? 'Console' : 'Logs'}
        </button>
      ))}
      <button className="flex items-center gap-1 hover:text-fg" title="Send feedback or report a problem: ideas, design, bugs" onClick={() => useApp.getState().set({ feedback: {} })}>
        <MessageSquare size={12} /> Feedback
      </button>
    </footer>
  );
}

/** The branch, commits to push / pull and the number of changes (GIT-204); opens the Git view. Hidden outside git. */
function GitSegment() {
  const { status } = useGit();
  if (!status?.repository) return null;
  const n = status.files.length;
  return (
    <button
      className="flex items-center gap-1 hover:text-fg"
      title={`Git: branch ${status.branch ?? '(detached)'}${status.ahead ? `, ${status.ahead} to push` : ''}${status.behind ? `, ${status.behind} to pull` : ''}${n ? `, ${plural(n, 'changed file')}` : ', no changes'}`}
      onClick={() => useApp.getState().setView('git')}
    >
      <GitBranch size={12} /> {status.branch ?? 'detached'}
      {status.ahead > 0 && <span>↑{status.ahead}</span>}
      {status.behind > 0 && <span>↓{status.behind}</span>}
      {n > 0 && <span className="text-warn">• {n}</span>}
      {status.conflicted && <span className="text-bad">conflicts</span>}
    </button>
  );
}

/** The bottom panel: Postman-style Console and the application logs. */
export function LogsPanel() {
  const tab = useApp((s) => s.bottomTab);
  return (
    <div className="h-60 border-t border-line bg-panel flex flex-col shrink-0">
      <div className="flex items-center gap-1 px-2 h-8 border-b border-line text-xs shrink-0">
        {(['console', 'logs'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={cx('px-2 h-6 rounded-md font-medium', tab === t ? 'bg-hover text-fg' : 'text-muted hover:text-fg')} onClick={() => useApp.getState().set({ bottomTab: t })}>
            {t === 'console' ? 'Console' : 'Logs'}
          </button>
        ))}
        <IconButton label="Close panel" className="ml-auto" onClick={() => useApp.getState().set({ logsOpen: false })}>
          <X size={13} />
        </IconButton>
      </div>
      {tab === 'console' ? <ConsolePanel /> : <AppLogs />}
    </div>
  );
}

function AppLogs() {
  const [logs] = useEventLog<{ time: string; level: string; scope: string; message: string; data?: unknown }>('log', 500, 'logs.recent');
  const [level, setLevel] = useState('ALL');
  const shown = logs.filter((l) => level === 'ALL' || l.level === level);
  return (
    <>
      <div className="flex items-center gap-2 px-3 h-7 border-b border-line text-xs shrink-0">
        <span className="text-muted">Application logs · secrets are always redacted</span>
        <select className="ml-auto bg-transparent" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Log level">
          {['ALL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'].map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </div>
      <div className="flex-1 overflow-auto mono text-[0.8rem] px-3 py-1">
        {shown.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap">
            <span className="text-muted">{l.time.slice(11, 23)}</span> <span className={cx(l.level === 'ERROR' && 'text-bad', l.level === 'WARN' && 'text-warn')}>{l.level.padEnd(5)}</span> {l.message}
            {l.data !== undefined && <span className="text-muted"> {JSON.stringify(l.data)}</span>}
          </div>
        ))}
      </div>
    </>
  );
}

export interface PaletteCommand {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  run(): void;
}

export function CommandPalette({ commands }: { commands: PaletteCommand[] }) {
  const set = useApp((s) => s.set);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const filtered = useMemo(() => {
    const t = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => t.every((w) => c.label.toLowerCase().includes(w) || c.hint?.toLowerCase().includes(w)));
  }, [q, commands]);
  useEffect(() => setIdx(0), [q]);
  const close = () => set({ paletteOpen: false });
  const run = (c?: PaletteCommand) => {
    if (!c) return;
    close();
    c.run();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-label="Command palette" className="w-[560px] max-w-[92vw] rounded-lg border border-line bg-bg shadow-2xl overflow-hidden">
        <input
          autoFocus
          className="w-full h-11 px-4 bg-transparent outline-none border-b border-line"
          placeholder="Type a command…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowDown') (e.preventDefault(), setIdx((i) => Math.min(filtered.length - 1, i + 1)));
            if (e.key === 'ArrowUp') (e.preventDefault(), setIdx((i) => Math.max(0, i - 1)));
            if (e.key === 'Enter') run(filtered[idx]);
          }}
        />
        <div role="listbox" className="max-h-[50vh] overflow-auto py-1">
          {filtered.map((c, i) => (
            <button
              key={c.id}
              role="option"
              aria-selected={i === idx}
              onMouseEnter={() => setIdx(i)}
              onClick={() => run(c)}
              className={cx('w-full text-left px-4 py-2 text-sm flex items-center gap-3', i === idx && 'bg-accent/10')}
            >
              <span aria-hidden className={cx('w-[18px] h-[18px] shrink-0 grid place-items-center [&_svg]:w-4 [&_svg]:h-4', i === idx ? 'text-accent' : 'text-muted')}>
                {c.icon}
              </span>
              {c.label}
              {c.hint && <span className="ml-auto text-xs text-muted">{c.hint}</span>}
            </button>
          ))}
          {!filtered.length && <div className="px-4 py-6 text-sm text-muted">No matching commands</div>}
        </div>
      </div>
    </div>
  );
}

interface SearchHit {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  ref: Record<string, string>;
}

export function SearchDialog() {
  const set = useApp((s) => s.set);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [idx, setIdx] = useState(0);
  const seq = useRef(0);
  // drop down from the top-bar search box (like a command center) instead of floating mid-screen
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number }>();
  useLayoutEffect(() => {
    const place = () => {
      const r = document.querySelector('[data-search-trigger]')?.getBoundingClientRect();
      if (!r || !r.width) return setAnchor(undefined);
      const width = Math.min(640, window.innerWidth * 0.92);
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.left + r.width / 2 - width / 2));
      setAnchor({ top: r.top, left, width });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);
  useEffect(() => {
    const n = ++seq.current;
    const t = setTimeout(async () => {
      const r = q.trim() ? await call<SearchHit[]>('ws.search', { query: q }) : [];
      if (n === seq.current) {
        setHits(r);
        setIdx(0);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [q]);
  const close = () => set({ searchOpen: false });
  const open = (h?: SearchHit) => {
    if (!h) return;
    close();
    const { openIntent } = useApp.getState();
    if (h.kind === 'request') openIntent('rest', { collectionId: h.ref.collectionId, requestId: h.ref.requestId });
    else if (h.kind === 'graphql') openIntent('graphql', { collectionId: h.ref.collectionId, requestId: h.ref.requestId });
    else if (h.kind === 'collection') openIntent('collections', { collectionId: h.ref.collectionId });
    else if (h.kind === 'test') openIntent('tests', { path: h.ref.testPath });
    else if (h.kind === 'environment-variable') openIntent('environments', { environmentId: h.ref.environmentId });
    else if (h.kind === 'mcp-server') openIntent('mcp', { serverId: h.ref.serverId });
    else if (h.kind === 'provider') openIntent('ai', { providerId: h.ref.providerId });
    else if (h.kind === 'history') openIntent('history', { historyId: h.ref.historyId });
    else if (h.kind === 'trace') openIntent('traces', { traceId: h.ref.traceId });
    else if (h.kind === 'run') openIntent('tests', { runId: h.ref.runId });
    else if (h.kind === 'saved') {
      const lib = h.ref.library;
      if (lib === 'monitors') openIntent('monitors', { monitorId: h.ref.itemId });
      else openIntent(lib === 'grpc' ? 'grpc' : lib === 'ai-prompts' ? 'ai' : lib === 'load-tests' ? 'load' : lib === 'evaluations' ? 'evaluations' : 'websocket', { savedId: h.ref.itemId });
    }
  };
  const icons: Record<string, ReactNode> = {
    request: <Network size={14} />,
    graphql: <GitBranch size={14} />,
    collection: <FolderTree size={14} />,
    test: <ShieldCheck size={14} />,
    'environment-variable': <KeyRound size={14} />,
    'mcp-server': <Plug size={14} />,
    provider: <Sparkles size={14} />,
    saved: <Bookmark size={14} />,
    history: <History size={14} />,
    trace: <Activity size={14} />,
    run: <Boxes size={14} />,
  };
  return (
    <div className={cx('fixed inset-0 z-50 bg-black/30', !anchor && 'flex items-start justify-center pt-[12vh]')} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        role="dialog"
        aria-label="Search"
        className={cx('rounded-xl border border-line bg-popover shadow-lg overflow-hidden', anchor ? 'absolute' : 'w-[640px] max-w-[92vw]')}
        style={anchor && { top: anchor.top, left: anchor.left, width: anchor.width }}
      >
        <div className="flex items-center gap-2 px-4 border-b border-line">
          <Search size={16} className="text-muted" />
          <input
            autoFocus
            className="w-full h-11 bg-transparent outline-none"
            placeholder="Search the workspace"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              if (e.key === 'ArrowDown') (e.preventDefault(), setIdx((i) => Math.min(hits.length - 1, i + 1)));
              if (e.key === 'ArrowUp') (e.preventDefault(), setIdx((i) => Math.max(0, i - 1)));
              if (e.key === 'Enter') open(hits[idx]);
            }}
          />
        </div>
        <div className="max-h-[55vh] overflow-auto py-1" role="listbox">
          {hits.map((h, i) => (
            <button key={`${h.kind}:${h.id}`} role="option" aria-selected={i === idx} onMouseEnter={() => setIdx(i)} onClick={() => open(h)} className={cx('w-full text-left px-4 py-2 flex items-center gap-3', i === idx && 'bg-accent/10')}>
              <span className="text-muted">{icons[h.kind]}</span>
              <span className="min-w-0">
                <div className="text-sm truncate">{h.title}</div>
                {h.subtitle && <div className="text-xs text-muted truncate">{h.subtitle}</div>}
              </span>
              <span className="ml-auto text-[0.7rem] text-muted">{h.kind}</span>
            </button>
          ))}
          {q && !hits.length && <div className="px-4 py-6 text-sm text-muted">No results</div>}
          {!q && <div className="px-4 py-6 text-sm text-muted">Searches requests, collections, tests, GraphQL operations, MCP servers, providers, environment variables, history, traces and runs.</div>}
        </div>
      </div>
    </div>
  );
}

export function Toaster() {
  const theme = useApp((s) => s.settings?.theme ?? 'system');
  return (
    <SonnerToaster
      position="bottom-right"
      offset={40}
      theme={theme}
      richColors
      closeButton
      toastOptions={{ className: 'font-sans', style: { fontSize: '0.9rem' } }}
    />
  );
}

/** Renders the pending `ask()` dialog, if any. */
export function DialogHost() {
  const d = useApp((s) => s.dialog);
  return d ? <DialogView key={d.title + d.message} d={d} /> : null;
}

/** Icon and colour per dialog tone: the one visual language for every message box in the app. */
const DIALOG_TONES: Record<DialogTone, { icon: ReactNode; className: string }> = {
  info: { icon: <Info size={18} />, className: 'bg-accent/12 text-accent ring-accent/20' },
  question: { icon: <HelpCircle size={18} />, className: 'bg-accent/12 text-accent ring-accent/20' },
  warning: { icon: <AlertTriangle size={18} />, className: 'bg-warn/12 text-warn ring-warn/25' },
  danger: { icon: <AlertOctagon size={18} />, className: 'bg-bad/12 text-bad ring-bad/25' },
  success: { icon: <CheckCircle2 size={18} />, className: 'bg-ok/12 text-ok ring-ok/25' },
};

/** The icon a dialog button gets from its label, so every button in the app carries one: Create → +, Delete → bin, Cancel → ×. */
import { iconForLabel } from './action-icons';
import { useEventLog } from '../lib/use-rpc';
import { plural } from '../lib/format';
export { iconForLabel };

function DialogView({ d }: { d: DialogRequest }) {
  const [value, setValue] = useState(d.input?.value ?? '');
  const primary = d.buttons.find((b) => b.variant === 'primary' || b.variant === 'danger');
  const tone = DIALOG_TONES[d.tone ?? (d.input ? 'question' : d.buttons.length > 1 ? 'question' : 'info')];
  return (
    <Modal
      title={d.title}
      onClose={() => d.resolve(d.cancelId, value)}
      width={d.input ? 460 : 520}
      footer={d.buttons.map((b) => (
        <Button key={b.id} variant={b.variant ?? 'default'} icon={b.icon ?? iconForLabel(b.label, b.variant)} autoFocus={!d.input && b === primary} disabled={!!d.input && b === primary && !value.trim()} onClick={() => d.resolve(b.id, value)}>
          {b.label}
        </Button>
      ))}
    >
      <div className="flex gap-3.5">
        <span className={cx('grid place-items-center h-9 w-9 shrink-0 rounded-full ring-1', tone.className)} aria-hidden>
          {d.icon ?? tone.icon}
        </span>
        <div className="min-w-0 flex-1 pt-1.5">
      {d.message && <p className="text-sm font-medium leading-relaxed">{d.message}</p>}
      {d.detail && <p className="text-sm text-muted whitespace-pre-line mt-2 max-h-72 overflow-auto leading-relaxed">{d.detail}</p>}
      {d.input && (
        <Input
          autoFocus
          className={cx('w-full', (d.message || d.detail) && 'mt-3')}
          value={value}
          placeholder={d.input.placeholder}
          aria-label={d.title}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && primary && value.trim()) d.resolve(primary.id, value);
          }}
        />
      )}
        </div>
      </div>
    </Modal>
  );
}

/** Blocking progress overlay (updates). */
export function ProgressHost() {
  const p = useApp((s) => s.progress);
  if (!p) return null;
  return (
    <div className="fixed inset-0 z-[70] bg-[var(--overlay)] backdrop-blur-[2px] grid place-items-center animate-in fade-in-0 duration-200" role="alertdialog" aria-label={p.title}>
      <div className="w-[460px] max-w-[94vw] rounded-2xl border border-line bg-popover shadow-lg px-5 py-4">
        <div className="flex gap-3.5">
          <span className={cx('grid place-items-center h-9 w-9 shrink-0 rounded-full ring-1', DIALOG_TONES.info.className)} aria-hidden>
            <Spinner size={17} />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="font-semibold text-[1.05rem]">{p.title}</div>
            <div className="text-sm text-muted mt-1">{p.message}</div>
            <div className="mt-3.5 h-2 rounded-full bg-panel2 relative overflow-hidden">
              {p.fraction === null ? <div className="absolute inset-0 indeterminate" /> : <div className="h-full rounded-full bg-[image:var(--brand-gradient)] transition-all" style={{ width: `${Math.round(p.fraction * 100)}%` }} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Where a place is, for tooltips and the recent-places list: "REST · request", "Environments · environment" … */
function placeLabel(l: NavLocation): string {
  const view = l.view === 'settings' ? 'Settings' : l.view === 'collections' ? 'Collection settings' : (NAV.find((n) => n.id === l.view)?.label ?? l.view);
  const p = l.payload ?? {};
  const what = p.requestId ? 'request' : p.savedId ? 'saved item' : p.monitorId ? 'monitor' : p.environmentId ? 'environment' : p.serverId ? 'server' : p.historyId ? 'history entry' : p.runId ? 'run' : p.path ? String(p.path) : p.collectionId ? 'collection' : '';
  return what ? `${view} · ${what}` : view;
}

/** Back / Forward like a browser (Alt+← / Alt+→ and the mouse's back / forward buttons), plus recent places. */
function NavButtons() {
  const nav = useApp((s) => s.nav);
  const prev = nav.back[nav.back.length - 1];
  const next = nav.forward[nav.forward.length - 1];
  const recent = [...nav.back].reverse().slice(0, 12);
  const jump = (steps: number) => {
    for (let i = 0; i < steps; i++) useApp.getState().goBack();
  };
  return (
    <div className="flex items-center gap-0.5">
      <IconButton label={prev ? `Back to ${placeLabel(prev)}  (Alt+←)` : 'Back'} disabled={!prev} onClick={() => useApp.getState().goBack()}>
        <ArrowLeft size={16} />
      </IconButton>
      <IconButton label={next ? `Forward to ${placeLabel(next)}  (Alt+→)` : 'Forward'} disabled={!next} onClick={() => useApp.getState().goForward()}>
        <ArrowRight size={16} />
      </IconButton>
      <Menu
        width={260}
        align="start"
        trigger={
          <IconButton label="Recent places" disabled={!recent.length} className="w-6">
            <NavChevron size={13} />
          </IconButton>
        }
        items={recent.map((l, i) => ({ label: placeLabel(l), icon: <History size={14} />, onSelect: () => jump(i + 1) }))}
      />
    </div>
  );
}
