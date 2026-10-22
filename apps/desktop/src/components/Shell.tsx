import { askAssistant } from './ai/AiAction';
import { useAiEnabled } from '../lib/use-ai-enabled';
import { aiHidden } from '../lib/ai-visible';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  Bot,
  Boxes,
  CheckCircle2,
  Cpu,
  FolderTree,
  GitBranch,
  HelpCircle,
  History,
  Info,
  KeyRound,
  Network,
  Plug,
  Bookmark,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  X,
  ArrowLeft,
  ArrowRight,
  ChevronDown as NavChevron,
  Menu as MenuIcon,
  MessageSquare,
  Bug,
} from 'lucide-react';
import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { call, on } from '../api';
import { useGitBar } from '../lib/git';
import wordmarkUrl from '../../build/wordmark-nav.png';
import wordmarkLightUrl from '../../build/wordmark-nav-light.png';
import markUrl from '../../build/icons/64x64.png';
import { ConsolePanel } from './ConsolePanel';
import { refIcon } from './RefLink';
import { openRef } from '../lib/open-ref';
import { rankPalette } from '../lib/palette-rank';
import { outputFileName, toItemRef } from '@testpion/shared';
import { OutputActions, OutputBarStart } from './output/OutputFrame';
import type { OutputSpec } from './output/output-core';
// xterm and the terminals load with the Terminal tab, the first time it opens
const TerminalPanel = lazy(() => import('./TerminalPanel'));
import { WorkspaceMenu } from './WorkspaceMenu';
import { EnvQuickLook } from './EnvQuickLook';
import { useApp, type DialogRequest, type DialogTone, type NavLocation } from '../store';
import { Button, cx, IconButton, Input, Kbd, Menu, Modal, Spinner } from './ui';
import { Toaster as SonnerToaster } from 'sonner';

/** The navigation (components/nav.tsx) and the rail (components/Rail.tsx), here for the modules that import them from the shell. */
export { NAV } from './nav';
export { Sidebar } from './Rail';
import { NAV } from './nav';

/** The environment switcher: a colour dot on the left of every environment (red for production), the app's own menu. */
/** The active environment (WF-05: the shared EnvSelect, the same menu as the status bar's). */
function EnvironmentPicker() {
  return <EnvSelect variant="topbar" />;
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
  const bindings = useBindings();
  const aiOn = useAiEnabled();
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
        {/* the TestPion wordmark: a dark "Pion" on the light theme's white bar, the white one on the dark theme */}
        <span className="inline-flex items-center gap-1.5">
          <img src={markUrl} alt="" aria-hidden className="h-7 w-7 select-none" draggable={false} />
          <img src={wordmarkLightUrl} alt="TestPion" className="h-6 w-auto select-none dark:hidden" draggable={false} />
          <img src={wordmarkUrl} alt="" aria-hidden className="h-6 w-auto select-none hidden dark:block" draggable={false} />
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
          <Kbd>{keyLabel('search', bindings)}</Kbd>
        </span>
      </button>
      <div className="flex items-center gap-1.5" style={noDrag}>
        <EnvironmentPicker />
        <EnvQuickLook />
        <Button size="md" variant="ghost" onClick={() => set({ paletteOpen: true })} icon={<TerminalSquare size={15} />}>
          <span className="hidden lg:inline">Commands</span> <Kbd>{keyLabel('palette', bindings)}</Kbd>
        </Button>
        {aiOn && (
          <IconButton label="AI assistant" onClick={() => askAssistant()}>
            <Bot size={17} />
          </IconButton>
        )}
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
  const activity = useApp((s) => s.activity);
  const info = useApp((s) => s.info);
  const mcp = useApp((s) => s.mcpConnected);
  const logsOpen = useApp((s) => s.logsOpen);
  const bottomTab = useApp((s) => s.bottomTab);
  const acts = Object.values(activity);
  return (
    <footer className="h-7 shrink-0 border-t border-line bg-chrome flex items-center gap-4 px-3 text-[0.75rem] text-muted">
      <EnvSelect variant="status" />
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
      <StatusBarTools />
      {(['console', 'logs'] as const).map((t) => (
        <button
          key={t}
          className={cx('flex items-center gap-1 hover:text-fg', logsOpen && bottomTab === t && 'text-fg')}
          title={t === 'console' ? `Console: requests and script output (${keyLabel('toggle-console')})` : 'Application logs'}
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
  const status = useGitBar();
  if (!status) return null;
  const n = status.changedFiles;
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

const BOTTOM_TABS = { problems: 'Problems', console: 'Console', logs: 'Logs', terminal: 'Terminal' } as const;

/** The bottom panel: Postman-style Console, the application logs and the Terminal (loaded the first time it opens). */
export function LogsPanel() {
  const tab = useApp((s) => s.bottomTab);
  return (
    <div className="h-60 border-t border-line bg-panel flex flex-col shrink-0" data-bottom-panel={tab}>
      <div className="flex items-center gap-1 px-2 h-8 border-b border-line text-xs shrink-0">
        {(Object.keys(BOTTOM_TABS) as Array<keyof typeof BOTTOM_TABS>).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} data-bottom-tab={t} className={cx('px-2 h-6 rounded-md font-medium', tab === t ? 'bg-hover text-fg' : 'text-muted hover:text-fg')} onClick={() => useApp.getState().set({ bottomTab: t })}>
            {BOTTOM_TABS[t]}
          </button>
        ))}
        <IconButton label="Close panel" className="ml-auto" onClick={() => useApp.getState().set({ logsOpen: false })}>
          <X size={13} />
        </IconButton>
      </div>
      {tab === 'problems' ? (
        <ProblemsPanel />
      ) : tab === 'console' ? (
        <ConsolePanel />
      ) : tab === 'terminal' ? (
        <Suspense fallback={<div className="flex-1 grid place-items-center"><Spinner size={16} /></div>}>
          <TerminalPanel />
        </Suspense>
      ) : (
        <AppLogs />
      )}
    </div>
  );
}

function AppLogs() {
  const [logs] = useEventLog<{ time: string; level: string; scope: string; message: string; data?: unknown }>('log', 500, 'logs.recent');
  const [level, setLevel] = useState('ALL');
  const shown = logs.filter((l) => level === 'ALL' || l.level === level);
  // the application log the backend holds (redacted by default), whatever the level filter shows
  const spec = useMemo<OutputSpec>(
    () => ({
      id: 'logs',
      what: 'application log',
      name: outputFileName({ name: 'application-log', ext: '' }),
      formats: [
        { format: 'text', source: { kind: 'logs' }, default: true },
        { format: 'jsonl', source: { kind: 'logs' } },
      ],
      empty: logs.length ? undefined : 'The application log is empty',
    }),
    [logs.length],
  );
  return (
    <>
      <div className="flex items-center gap-2 px-3 h-7 border-b border-line text-xs shrink-0 min-w-0 overflow-clip whitespace-nowrap">
        <OutputBarStart>
          <span className="text-muted truncate min-w-0">Application logs · secrets are always redacted</span>
        </OutputBarStart>
        <OutputActions spec={spec}>
          <select className="bg-transparent" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Log level">
            {['ALL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'].map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </OutputActions>
      </div>
      <div className="flex-1 overflow-auto mono text-[0.8rem] px-3 py-1" data-output="logs">
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
  /** A line under the label (what a block does, where a saved request is). */
  detail?: string;
  /** A heading the command is listed under (Requests, Logic …); commands of a group come together. */
  group?: string;
  run(): void;
}

/**
 * The command palette, and every quick pick built on it (Insert snippet…, the flow designer's block picker): a
 * searchable list, Enter runs, Esc closes. `onClose` replaces closing the app's palette (a quick pick closes itself and
 * puts the focus back where it was); `anchor` opens it at a point (a port of the canvas) instead of the top middle.
 */
export function CommandPalette({
  commands,
  onClose,
  placeholder = 'Type a command…',
  label = 'Command palette',
  empty = 'No matching commands',
  anchor,
  id,
  initialQuery = '',
  resolve,
  onQueryChange,
}: {
  commands: PaletteCommand[];
  /** What is typed when it opens (Quick Open: '' for items, '>' for commands, '#' for environments). */
  initialQuery?: string;
  /** The rows for what is typed (Quick Open's modes, lib/quick-open.ts): they replace `commands`, filtered by `text`. */
  resolve?(q: string): { commands: PaletteCommand[]; text: string; placeholder?: string; empty?: string };
  onQueryChange?(q: string): void;
  onClose?(): void;
  placeholder?: string;
  label?: string;
  empty?: string;
  /** Where to open it (window coordinates): a small panel there, kept on screen. */
  anchor?: { x: number; y: number };
  /** data-palette on the panel (tests, styles). */
  id?: string;
}) {
  const set = useApp((s) => s.set);
  const [q, setQ] = useState(initialQuery);
  const [idx, setIdx] = useState(0);
  const view = useMemo(() => (resolve ? resolve(q) : { commands, text: q }), [resolve, commands, q]);
  useEffect(() => onQueryChange?.(q), [q, onQueryChange]);
  // what matches, best first: the label itself, then a label starting with it … (lib/palette-rank.ts)
  const filtered = useMemo(() => rankPalette(view.commands, view.text), [view]);
  // the focus goes back where it was when the palette closes (a canvas, an editor): its keys keep working
  // (read on the first render, before the input's autoFocus takes it; given back only when nothing else took it since)
  const opener = useRef(typeof document === 'undefined' ? null : document.activeElement);
  useEffect(() => {
    const before = opener.current;
    return () => {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost && (before instanceof HTMLElement || before instanceof SVGElement) && before !== document.body && before.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);
  const width = anchor ? 380 : 560;
  const place = anchor ? { left: Math.max(8, Math.min(anchor.x, window.innerWidth - width - 8)), top: Math.max(8, Math.min(anchor.y, window.innerHeight - 420)) } : undefined;
  useEffect(() => setIdx(0), [q]);
  const close = () => (onClose ? onClose() : set({ paletteOpen: false }));
  const run = (c?: PaletteCommand) => {
    if (!c) return;
    close();
    c.run();
  };
  return (
    <div className={cx('fixed inset-0 z-50', anchor ? '' : 'bg-black/30 flex items-start justify-center pt-[12vh]')} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        role="dialog"
        aria-label={label}
        data-palette={id}
        className={cx('max-w-[92vw] rounded-lg border border-line bg-bg shadow-2xl overflow-hidden', anchor ? 'fixed w-[380px]' : 'w-[560px]')}
        style={place}
      >
        <input
          autoFocus
          className="w-full h-11 px-4 bg-transparent outline-none border-b border-line"
          placeholder={(view as { placeholder?: string }).placeholder ?? placeholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), close());
            if (e.key === 'ArrowDown') (e.preventDefault(), setIdx((i) => Math.min(filtered.length - 1, i + 1)));
            if (e.key === 'ArrowUp') (e.preventDefault(), setIdx((i) => Math.max(0, i - 1)));
            if (e.key === 'Enter') run(filtered[idx]);
          }}
        />
        <div role="listbox" ref={listRef} className={cx('overflow-auto py-1', anchor ? 'max-h-[340px]' : 'max-h-[50vh]')}>
          {filtered.map((c, i) => (
            <Fragment key={c.id}>
              {c.group && c.group !== filtered[i - 1]?.group && <div className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{c.group}</div>}
              <button
                role="option"
                aria-selected={i === idx}
                data-command={c.id}
                {...hoverSelect(() => setIdx(i))}
                onClick={() => run(c)}
                className={cx('w-full text-left px-4 text-sm flex items-center gap-3', c.detail ? 'py-1.5' : 'py-2', i === idx && 'bg-accent-soft')}
              >
                <span aria-hidden className={cx('w-[18px] h-[18px] shrink-0 grid place-items-center [&_svg]:w-4 [&_svg]:h-4', i === idx ? 'text-accent' : 'text-muted')}>
                  {c.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate" data-command-label>
                    {c.label}
                  </span>
                  {c.detail && <span className="block truncate text-xs text-muted">{c.detail}</span>}
                </span>
                {c.hint && <span className="ml-auto text-xs text-muted shrink-0">{c.hint}</span>}
              </button>
            </Fragment>
          ))}
          {!filtered.length && ((view as { empty?: string }).empty ?? empty) && <div className="px-4 py-6 text-sm text-muted">{(view as { empty?: string }).empty ?? empty}</div>}
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
  // the last row, always: put the words to the AI as a question (Ask…, AI-12), the same row as in Quick Open
  const shown: SearchHit[] = q.trim() ? [...hits, ...(aiHidden() ? [] : [{ kind: 'ask' as const, id: 'ask', title: `Ask: “${q.trim()}”`, subtitle: 'History, runs, test results and traces, in your own words (AI)', ref: {} }])] : [];
  // every hit names its item with an ItemRef: it opens the one way everything opens (a hit of something deleted since says so)
  const open = (h?: SearchHit) => {
    if (!h) return;
    if (h.kind === 'ask') return startAskSearch({ question: q.trim() });
    close();
    void openRef(h.ref);
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
    ask: <Sparkles size={14} />,
  };
  // kinds without an icon of their own here (environments, API definitions, datasets …) take their kind's (RefLink)
  const iconOf = (h: SearchHit) => icons[h.kind] ?? ((r) => (r ? refIcon(r, 14) : null))(toItemRef(h.ref));
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
              if (e.key === 'ArrowDown') (e.preventDefault(), setIdx((i) => Math.min(shown.length - 1, i + 1)));
              if (e.key === 'ArrowUp') (e.preventDefault(), setIdx((i) => Math.max(0, i - 1)));
              if (e.key === 'Enter') open(shown[idx]);
            }}
          />
        </div>
        <div className="max-h-[55vh] overflow-auto py-1" role="listbox">
          {q && !hits.length && <div className="px-4 py-3 text-sm text-muted">No matching items</div>}
          {shown.map((h, i) => (
            <button key={`${h.kind}:${h.id}`} role="option" aria-selected={i === idx} {...hoverSelect(() => setIdx(i))} onClick={() => open(h)} className={cx('w-full text-left px-4 py-2 flex items-center gap-3', i === idx && 'bg-accent-soft')}>
              <span className="text-muted">{iconOf(h)}</span>
              <span className="min-w-0">
                <div className="text-sm truncate">{h.title}</div>
                {h.subtitle && <div className="text-xs text-muted truncate">{h.subtitle}</div>}
              </span>
              <span className="ml-auto text-[0.7rem] text-muted">{h.kind}</span>
            </button>
          ))}
          {!q && <div className="px-4 py-6 text-sm text-muted">Searches requests, collections, tests, GraphQL operations, MCP servers, providers, environments and their variables, API definitions, datasets, history, traces and runs.</div>}
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
import { ProblemsPanel } from './ProblemsPanel';
import { StatusBarTools } from './StatusBarTools';
import { EnvSelect } from './EnvSelect';
import { keyLabel, useBindings } from '../lib/keybindings';
import { hoverSelect } from '../lib/hover-select';
import { startAskSearch } from './ai/ask-search';
export { iconForLabel };

function DialogView({ d }: { d: DialogRequest }) {
  const [value, setValue] = useState(d.input?.value ?? '');
  const primary = d.buttons.find((b) => b.variant === 'primary' || b.variant === 'danger');
  const toneId = d.tone ?? (d.input ? 'question' : d.buttons.length > 1 ? 'question' : 'info');
  const tone = DIALOG_TONES[toneId];
  // Enter answers the primary button of a question; a danger dialog (Delete for good, a branch deleted) starts on
  // Cancel, so a key pressed a moment too early never destroys anything. The text field of an input dialog has the focus.
  const focused = d.input ? undefined : toneId === 'danger' ? (d.buttons.find((b) => b.id === d.cancelId) ?? primary) : primary;
  // the dialog's focus trap moves the focus to its first control (the ✕) once mounted, over `autoFocus`, so say it again after
  const focusRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focused) return;
    const id = requestAnimationFrame(() => focusRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [focused]);
  return (
    <Modal
      title={d.title}
      onClose={() => d.resolve(d.cancelId, value)}
      width={d.input ? 460 : 520}
      footer={d.buttons.map((b) => (
        <Button key={b.id} ref={b === focused ? focusRef : undefined} variant={b.variant ?? 'default'} icon={b.icon ?? iconForLabel(b.label, b.variant)} autoFocus={b === focused} disabled={!!d.input && b === primary && !value.trim()} onClick={() => d.resolve(b.id, value)}>
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
  // the item's name when the place was recorded (WF-10), else the view and what kind of item
  if (l.label) return l.label;
  const view = l.view === 'settings' ? 'Settings' : l.view === 'collections' ? 'Collection settings' : (NAV.find((n) => n.id === l.view)?.label ?? l.view);
  const p = l.payload ?? {};
  const what = p.requestId ? 'request' : p.savedId ? 'saved item' : p.monitorId ? 'monitor' : p.environmentId ? 'environment' : p.serverId ? 'server' : p.historyId ? 'history entry' : p.runId ? 'run' : p.path ? String(p.path) : p.collectionId ? 'collection' : '';
  return what ? `${view} · ${what}` : view;
}

/** Back / Forward like a browser (Alt+← / Alt+→ and the mouse's back / forward buttons), plus recent places. */
function NavButtons() {
  const bindings = useBindings();
  const nav = useApp((s) => s.nav);
  const prev = nav.back[nav.back.length - 1];
  const next = nav.forward[nav.forward.length - 1];
  const recent = [...nav.back].reverse().slice(0, 12);
  const jump = (steps: number) => {
    for (let i = 0; i < steps; i++) useApp.getState().goBack();
  };
  return (
    <div className="flex items-center gap-0.5">
      <IconButton label={prev ? `Back to ${placeLabel(prev)}  (${keyLabel('back', bindings)})` : 'Back'} disabled={!prev} onClick={() => useApp.getState().goBack()}>
        <ArrowLeft size={16} />
      </IconButton>
      <IconButton label={next ? `Forward to ${placeLabel(next)}  (${keyLabel('forward', bindings)})` : 'Forward'} disabled={!next} onClick={() => useApp.getState().goForward()}>
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
