import { AlarmClock, BarChart3, Bot, Keyboard, Columns2, CopyX, Disc, GitCompare, ScanSearch, TerminalSquare, Variable, Download, FileDown, FlaskConical, FolderOpen, FolderPlus, FolderTree, Gauge, GitBranch, History, KeyRound, Layers, ListChecks, ListX, Network, Play, Plug, Radio, RefreshCw, ScrollText, Search, Settings, Sparkles, SquareTerminal, Upload, Waypoints, Workflow, X, type LucideIcon } from 'lucide-react';
import { createElement, lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType, type LazyExoticComponent } from 'react';
import { call, on } from './api';
import { useApp, type ViewId } from './store';
import { watchSecretRefs } from './lib/secret-refs';
import { AssistantPanel } from './components/AssistantPanel';
import { VarPopoverHost } from './components/VarPopoverHost';
import { CommandPalette, DialogHost, LogsPanel, ProgressHost, SearchDialog, Sidebar, StatusBar, Toaster, TopBar, NAV, type PaletteCommand } from './components/Shell';
import { checkForUpdates, scheduleUpdateCheck } from './updates';
import { ViewBoundary } from './components/ViewBoundary';
import { isRequestView } from './store';
import { Explorer } from './components/Explorer';
import { EditorTabStrip, NoOpenTabs, useEditorTabsStore } from './components/EditorTabs';
import { DOC_VIEWS, DocContext, isDocView, useDocs } from './lib/docs';
import { watchRunNotifications } from './lib/run-notifications';
import { remindExpiringCertificates, watchMonitorAlerts } from './lib/monitor-alerts';
import { runMenuCommand, type MenuCommand } from './menu-commands';
import { setResponseLayout } from './components/ResponseSplit';
import { loadMonaco } from './components/CodeEditor';
import { Spinner, TooltipProvider } from './components/ui';
import { McpClientRequests } from './components/McpClientRequests';

/**
 * Each tool is a separate product surface. Loading it only when selected keeps
 * startup fast and, importantly, defers Monaco and protocol-specific code until
 * it is useful. Named exports keep view modules simple.
 */
const ShortcutsDialog = lazy(async () => ({ default: (await import('./components/ShortcutsDialog')).ShortcutsDialog }));
const CiDialog = lazy(async () => ({ default: (await import('./components/CiDialog')).CiDialog }));
const RecordDialog = lazy(async () => ({ default: (await import('./components/RecordDialog')).RecordDialog }));
const FeedbackDialog = lazy(async () => ({ default: (await import('./components/FeedbackDialog')).FeedbackDialog }));
const VariableUsagesDialog = lazy(async () => ({ default: (await import('./components/VariableUsagesDialog')).VariableUsagesDialog }));
const OpenApiDiffDialog = lazy(async () => ({ default: (await import('./components/OpenApiDiffDialog')).OpenApiDiffDialog }));
const ApiCoverageDialog = lazy(async () => ({ default: (await import('./components/ApiCoverageDialog')).ApiCoverageDialog }));
const view = (load: () => Promise<any>, name: string) => lazy(async () => ({ default: (await load())[name] as ComponentType }));
const VIEWS: Record<ViewId, LazyExoticComponent<ComponentType>> = {
  home: view(() => import('./views/HomeView'), 'HomeView'),
  rest: view(() => import('./views/RestView'), 'RestView'),
  graphql: view(() => import('./views/GraphQLView'), 'GraphQLView'),
  websocket: view(() => import('./views/WebSocketView'), 'WebSocketView'),
  apidef: view(() => import('./views/ApiDefinitionView'), 'ApiDefinitionView'),
  grpc: view(() => import('./views/GrpcView'), 'GrpcView'),
  mcp: view(() => import('./views/McpView'), 'McpView'),
  ai: view(() => import('./views/AiLabView'), 'AiLabView'),
  evaluations: view(() => import('./views/EvaluationsView'), 'EvaluationsView'),
  tests: view(() => import('./views/TestsView'), 'TestsView'),
  load: view(() => import('./views/LoadView'), 'LoadView'),
  traces: view(() => import('./views/TracesView'), 'TracesView'),
  monitors: view(() => import('./views/MonitorsView'), 'MonitorsView'),
  collections: view(() => import('./views/CollectionsView'), 'CollectionsView'),
  history: view(() => import('./views/HistoryView'), 'HistoryView'),
  environments: view(() => import('./views/EnvironmentsView'), 'EnvironmentsView'),
  git: view(() => import('./views/GitView'), 'GitView'),
  debugger: view(() => import('./views/DebuggerView'), 'DebuggerView'),
  settings: view(() => import('./views/SettingsView'), 'SettingsView'),
};

// Keeping a few recently used screens mounted preserves short-lived work (such
// as a stream or an unsaved request), without letting every editor and listener
// in a long session consume memory and CPU indefinitely.
const MAX_CACHED_VIEWS = 4;

function useThemeEffect() {
  const settings = useApp((s) => s.settings);
  useEffect(() => {
    const apply = () => {
      const t = settings?.theme ?? 'system';
      const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      document.documentElement.dataset.reducedMotion = String(!!settings?.reducedMotion);
      document.documentElement.style.setProperty('--font-size', `${settings?.fontSize ?? 14}px`);
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings]);
}

/** Keys typed into a field are text, not shortcuts. */
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.closest('.monaco-editor'));

/** Icons of the command palette's commands (the same icons as the menus and navigation). */
const PALETTE_ICONS: Record<string, LucideIcon> = {
  'new-request': Network,
  'new-graphql': GitBranch,
  'new-mcp': Plug,
  'new-ai': Sparkles,
  'run-test': Play,
  'run-suite': ListChecks,
  'open-collection': FolderTree,
  'search-history': History,
  'open-settings': Settings,
  'export-results': FileDown,
  search: Search,
  'tab-close': X,
  'tab-close-others': ListX,
  'tab-close-all': CopyX,
  'toggle-console': SquareTerminal,
  'toggle-logs': ScrollText,
  assistant: Bot,
  load: Gauge,
  compare: Columns2,
  'ai-usage': BarChart3,
  'mcp-usage': BarChart3,
  eval: FlaskConical,
  update: RefreshCw,
  shortcuts: Keyboard,
  'm-new-http': Network,
  'm-new-grpc': Waypoints,
  'm-new-ws': Radio,
  'm-new-mcp': Plug,
  'm-new-col': FolderPlus,
  'm-new-env': KeyRound,
  'm-open-examples': Sparkles,
  'm-ci': Workflow,
  'm-record': Disc,
  'm-var-usages': Variable,
  'm-openapi-diff': GitCompare,
  'm-api-coverage': ScanSearch,
  'm-new-monitor': AlarmClock,
  'm-new-workspace': Layers,
  'm-open-ws': FolderOpen,
  'm-import': Upload,
  'm-exp-col': FolderTree,
  'm-exp-env': KeyRound,
  'm-exp-ws': Download,
};

/** The examples workspace gained requests, collections or servers in this version: tell the user once, with Open. */
async function announceNewExamples() {
  const added = await call<string[]>('ws.examplesAdded').catch(() => [] as string[]);
  if (!added.length) return;
  const named = added.filter((a) => /^(collection|MCP server)/.test(a));
  const list = (named.length ? named : added).slice(0, 3).join(', ');
  const more = added.length - Math.min(3, (named.length ? named : added).length);
  useApp.getState().toast(`New in the TestPion Examples workspace: ${list}${more > 0 ? ` and ${more} more` : ''}`, 'success', { label: 'Open', onClick: () => void runMenuCommand('open-examples') });
}

export default function App() {
  const view = useApp((s) => s.view);
  const paletteOpen = useApp((s) => s.paletteOpen);
  const searchOpen = useApp((s) => s.searchOpen);
  const assistant = useApp((s) => s.assistant);
  const ci = useApp((s) => s.ci);
  const openapiDiff = useApp((s) => s.openapiDiff);
  const apiCoverage = useApp((s) => s.apiCoverage);
  const explorerOpen = useApp((s) => s.explorerOpen);
  const variableUsages = useApp((s) => s.variableUsages);
  const recordOpen = useApp((s) => s.recordOpen);
  const feedback = useApp((s) => s.feedback);
  const shortcutsOpen = useApp((s) => s.shortcutsOpen);
  const logsOpen = useApp((s) => s.logsOpen);
  const workspace = useApp((s) => s.workspace);
  const [ready, setReady] = useState(false);
  // keep visited views mounted so drafts, live sessions and streams survive navigation
  const [visited, setVisited] = useState<ViewId[]>([view]);
  useThemeEffect();

  useEffect(() => {
    void (async () => {
      try {
        const [info, settings] = await Promise.all([call('app.info'), call('settings.get')]);
        useApp.getState().set({ info, settings });
        await useApp.getState().refreshWorkspace();
        scheduleUpdateCheck();
        // warm the code editor in the background once the first screen is up
        setTimeout(() => void loadMonaco(), 1500);
        // examples that came with this version (added to the user's copy at start): say so once
        setTimeout(() => void announceNewExamples(), 2500);
        // certificates that expire within 7 days: a reminder once a day
        setTimeout(remindExpiringCertificates, 4000);
      } catch (error) {
        useApp.getState().toast(`Could not finish starting TestPion: ${error instanceof Error ? error.message : String(error)}`, 'error');
      } finally {
        // The shell remains usable if a workspace service is temporarily down.
        setReady(true);
      }
    })();
    const off = on('run.error', (p: { error: { message: string } }) => useApp.getState().toast(`Run failed: ${p.error.message}`, 'error'));
    const offMonitors = watchMonitorAlerts();
    const offRuns = watchRunNotifications();
    const offSecrets = watchSecretRefs();
    const offUpdate = on('update.checkManual', () => void checkForUpdates({ manual: true }));
    // files changed outside the app (git pull, a branch switch, another editor): show the new state and say so
    const offDisk = on<{ message: string; kinds: string[] }>('workspace.changedOnDisk', (p) => {
      const s = useApp.getState();
      void s.refreshWorkspace();
      if (p.kinds.includes('environments') || p.kinds.includes('workspace')) s.set({ envsVersion: (s.envsVersion ?? 0) + 1 });
      s.toast(`${p.message}: TestPion shows the new version.`);
    });
    // application menu (File ▸ New, Import, Export, Save …)
    const offMenu = on<{ command: MenuCommand }>('menu.command', ({ command }) => void runMenuCommand(command));
    // File menu: request tab commands (handled by the REST view)
    const offTabs = on<{ command: string }>('tabs.command', ({ command }) => useApp.getState().openIntent('rest', command === 'new' ? { newTab: true } : { tabCommand: command }));
    return () => {
      off();
      offUpdate();
      offDisk();
      offTabs();
      offMenu();
      offMonitors();
      offRuns();
      offSecrets();
    };
  }, []);

  // editors with an open tab stay mounted (their tabs, drafts and live connections), REST always
  const openEditors = useEditorTabsStore((s) => s.openViews);
  const docs = useDocs((s) => s.docs);
  const activeDocs = useDocs((s) => s.active);
  const docViews = DOC_VIEWS.filter((v) => (docs[v] ?? []).length);
  const mounted = useMemo(() => [...new Set<ViewId>([...visited, 'rest', ...openEditors, ...docViews])], [visited, openEditors, docViews.join()]);
  // a multi-document editor always has a document to show (e.g. started on it from the last session)
  useEffect(() => {
    if (isDocView(view)) useDocs.getState().ensure(view);
  }, [view]);
  // the last tab of an editor (HTTP, GraphQL, gRPC, WebSocket, MCP) closed while other tabs are open: show the nearest
  // one, like closing a tab anywhere else; "No open requests" is only for when nothing is open. Only right after a
  // close (the count went from some to none in the same view): opening a tab passes through "none" for a moment too.
  const restTabs = useEditorTabsStore((s) => (s.byView.rest ?? []).length);
  const ownTabs = isDocView(view) ? (docs[view] ?? []).length : view === 'rest' ? restTabs : -1;
  const lastCount = useRef<{ view: ViewId; count: number }>(undefined);
  useEffect(() => {
    const before = lastCount.current;
    lastCount.current = { view, count: ownTabs };
    if (!before || before.view !== view || before.count <= 0 || ownTabs !== 0) return;
    // tabs still listed whose document was just closed (a batch close: they leave the list a moment later) don't count
    const liveDocs = useDocs.getState().docs;
    const open = Object.entries(useEditorTabsStore.getState().byView)
      .filter(([group]) => group !== view && !group.startsWith(`${view}:`))
      .flatMap(([, tabs]) => tabs)
      .filter((t) => !isDocView(t.view) || (liveDocs[t.view] ?? []).includes(t.key.slice(t.view.length + 1)));
    const next = open[open.length - 1];
    if (!next) return;
    useApp.getState().setView(next.view);
    next.onSelect?.();
  }, [view, ownTabs]);
  // a document view whose selected tab is gone (closed elsewhere, a stale session): select its first tab instead of showing nothing
  useEffect(() => {
    const list = docs[view] ?? [];
    if (isDocView(view) && list.length && !list.includes(activeDocs[view] ?? '')) useDocs.getState().select(view, list[0]!);
  }, [view, docs, activeDocs]);
  useEffect(() => {
    setVisited((cached) => {
      const next = [...cached.filter((id) => id !== view), view];
      return next.length > MAX_CACHED_VIEWS ? next.slice(-MAX_CACHED_VIEWS) : next;
    });
  }, [view]);
  // re-mount views when the workspace changes
  useEffect(() => setVisited([useApp.getState().view]), [workspace?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const { set } = useApp.getState();
      // Back / Forward like a browser
      if (e.altKey && !mod && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        if (e.key === 'ArrowLeft') useApp.getState().goBack();
        else useApp.getState().goForward();
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        const st = useApp.getState();
        if (isRequestView(st.view)) st.toggleExplorer();
        else (st.setView(st.lastRequestView), st.toggleExplorer(true));
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        // the AI assistant, with what is on screen (again: close it)
        e.preventDefault();
        const open = useApp.getState().assistant;
        set({ assistant: open?.task === 'free' ? undefined : { task: 'free', title: 'Ask the assistant', context: {} } });
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        set({ paletteOpen: true, searchOpen: false });
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        set({ searchOpen: true, paletteOpen: false });
      } else if (mod && e.key === ',') {
        e.preventDefault();
        useApp.getState().setView('settings');
      } else if (mod && e.altKey && e.key.toLowerCase() === 'c') {
        // Postman's shortcut for the console
        e.preventDefault();
        const st = useApp.getState();
        set(st.logsOpen && st.bottomTab === 'console' ? { logsOpen: false } : { logsOpen: true, bottomTab: 'console' });
      } else if (e.key === '?' && !mod && !isTyping(e.target)) {
        e.preventDefault();
        set({ shortcutsOpen: true });
      } else if (mod && e.altKey && /^[1-9]$/.test(e.key)) {
        const n = NAV[Number(e.key) - 1];
        if (n) useApp.getState().setView(n.id);
      }
    };
    window.addEventListener('keydown', onKey);
    // the mouse's back / forward (thumb) buttons
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) (e.preventDefault(), useApp.getState().goBack());
      else if (e.button === 4) (e.preventDefault(), useApp.getState().goForward());
    };
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouse);
    };
  }, []);

  const commands = useMemo<PaletteCommand[]>(() => {
    const s = useApp.getState();
    const cmds: PaletteCommand[] = [
      { id: 'new-request', label: 'New Request', hint: 'REST', run: () => s.openIntent('rest', { newTab: true }) },
      { id: 'new-graphql', label: 'New GraphQL Query', hint: 'GraphQL', run: () => s.openIntent('graphql', { reset: true }) },
      { id: 'new-mcp', label: 'New MCP Test', hint: 'MCP', run: () => s.setView('mcp') },
      { id: 'new-ai', label: 'New AI Test', hint: 'AI Lab', run: () => s.openIntent('ai', { reset: true }) },
      { id: 'run-test', label: 'Run Test', hint: 'Tests', run: () => s.openIntent('tests', { runCurrent: true }) },
      { id: 'run-suite', label: 'Run Suite', hint: 'Tests', run: () => s.openIntent('tests', { runAll: true }) },
      { id: 'open-collection', label: 'Open Collection', hint: 'Collections', run: () => s.setView('collections') },
      { id: 'search-history', label: 'Search History', hint: 'History', run: () => s.setView('history') },
      { id: 'open-settings', label: 'Open Settings', hint: `${'Ctrl'}+,`, run: () => s.setView('settings') },
      { id: 'export-results', label: 'Export Results', hint: 'Tests', run: () => s.openIntent('tests', { exportLatest: true }) },
      { id: 'search', label: 'Search Workspace', hint: 'Ctrl+Shift+F', run: () => s.set({ searchOpen: true }) },
      { id: 'tab-close', label: 'Close Tab', hint: 'Ctrl+W', run: () => s.openIntent('rest', { tabCommand: 'close' }) },
      { id: 'tab-close-others', label: 'Close Other Tabs', hint: 'Requests', run: () => s.openIntent('rest', { tabCommand: 'closeOthers' }) },
      { id: 'tab-close-all', label: 'Close All Tabs', hint: 'Ctrl+Shift+W', run: () => s.openIntent('rest', { tabCommand: 'closeAll' }) },
      { id: 'toggle-console', label: 'Show Console', hint: 'Ctrl+Alt+C', run: () => s.set({ logsOpen: true, bottomTab: 'console' }) },
      { id: 'toggle-logs', label: 'Show Application Logs', run: () => s.set({ logsOpen: true, bottomTab: 'logs' }) },
      { id: 'assistant', label: 'Ask AI Assistant', run: () => s.set({ assistant: { task: 'free', title: 'Ask the assistant', context: {} } }) },
      { id: 'feedback', label: 'Send Feedback or Report a Problem…', hint: 'Help', run: () => s.set({ feedback: {} }) },
      { id: 'agents', label: 'Connect an AI Agent (Claude, Cursor, VS Code, Codex) over MCP…', hint: 'Settings', run: () => s.openIntent('settings', { tab: 'agents' }) },
      { id: 'load', label: 'New Load Test', run: () => s.setView('load') },
      { id: 'compare', label: 'Compare Models', hint: 'AI Lab', run: () => s.openIntent('ai', { tab: 'compare' }) },
      { id: 'ai-usage', label: 'AI Usage: tokens and cost per model', hint: 'AI Lab', run: () => s.openIntent('ai', { tab: 'usage' }) },
      { id: 'mcp-usage', label: 'MCP Tool Usage: calls, failures and time per tool', hint: 'MCP', run: () => s.openIntent('mcp', { tab: 'usage' }) },
      { id: 'eval', label: 'New Evaluation Run', hint: 'Evaluations', run: () => s.setView('evaluations') },
      { id: 'shortcuts', label: 'Keyboard Shortcuts', hint: '?', run: () => s.set({ shortcutsOpen: true }) },
      { id: 'git-ready', label: 'Make Workspace Ready for Git', hint: 'Workspace', run: () => void runMenuCommand('git-ready') },
      { id: 'git-clone', label: 'Clone Workspace from Git…', hint: 'Workspace', run: () => void runMenuCommand('git-clone') },
      { id: 'git-view', label: 'Git: Changes, Commit, Pull and Push', hint: 'Workspace', run: () => useApp.getState().setView('git') },
      { id: 'layout-side', label: 'Response Layout: Side by Side', hint: 'View', run: () => setResponseLayout('side') },
      { id: 'layout-below', label: 'Response Layout: Response Below', hint: 'View', run: () => setResponseLayout('below') },
      { id: 'layout-auto', label: 'Response Layout: Auto', hint: 'View', run: () => setResponseLayout('auto') },
      { id: 'update', label: 'Check for Updates', hint: 'Help', run: () => void checkForUpdates({ manual: true }) },
      { id: 'm-new-http', label: 'New HTTP Request', hint: 'File', run: () => void runMenuCommand('new-http') },
      { id: 'm-new-grpc', label: 'New gRPC Request', hint: 'File', run: () => void runMenuCommand('new-grpc') },
      { id: 'm-new-ws', label: 'New WebSocket Connection', hint: 'File', run: () => void runMenuCommand('new-websocket') },
      { id: 'm-new-mcp', label: 'Add MCP Server', hint: 'File', run: () => void runMenuCommand('new-mcp-server') },
      { id: 'm-new-col', label: 'New Collection', hint: 'File', run: () => void runMenuCommand('new-collection') },
      { id: 'm-new-env', label: 'New Environment', hint: 'File', run: () => void runMenuCommand('new-environment') },
      { id: 'm-open-examples', label: 'Open Examples Workspace', hint: 'Help', run: () => void runMenuCommand('open-examples') },
      { id: 'm-ci', label: 'Run in CI (GitHub Actions, GitLab, Azure, Jenkins)…', hint: 'Tests', run: () => useApp.getState().set({ ci: {} }) },
      { id: 'm-record', label: 'Record traffic (reverse proxy) into a collection…', hint: 'Collections', run: () => useApp.getState().set({ recordOpen: true }) },
      { id: 'm-var-usages', label: 'Find variable usages / rename a variable everywhere…', hint: 'Environments', run: () => useApp.getState().set({ variableUsages: true }) },
      { id: 'm-openapi-diff', label: 'Compare OpenAPI versions (breaking changes)…', hint: 'Tests', run: () => useApp.getState().set({ openapiDiff: true }) },
      { id: 'm-api-coverage', label: 'API coverage (OpenAPI operations tested)…', hint: 'Tests', run: () => useApp.getState().set({ apiCoverage: {} }) },
      { id: 'm-new-monitor', label: 'New Monitor', hint: 'File', run: () => void runMenuCommand('new-monitor') },
      { id: 'm-new-workspace', label: 'New Workspace', hint: 'File', run: () => void runMenuCommand('new-workspace') },
      { id: 'm-open-ws', label: 'Open Workspace Folder', hint: 'File', run: () => void runMenuCommand('open-workspace') },
      { id: 'm-import', label: 'Import (Postman, Insomnia, Bruno, OpenAPI, HAR, cURL …)', hint: 'File', run: () => void runMenuCommand('import') },
      { id: 'm-exp-col', label: 'Export Collection (Postman)', hint: 'File', run: () => void runMenuCommand('export-collection') },
      { id: 'm-exp-env', label: 'Export Current Environment', hint: 'File', run: () => void runMenuCommand('export-environment') },
      { id: 'm-exp-ws', label: 'Export Workspace', hint: 'File', run: () => void runMenuCommand('export-workspace') },
    ];
    // every command has an icon: its own, or a generic one for a command added without
    for (const c of cmds) c.icon = createElement(PALETTE_ICONS[c.id] ?? TerminalSquare, { size: 16 });
    // "Go to" commands use the navigation's own icons
    for (const n of NAV) cmds.push({ id: `go-${n.id}`, label: `Go to ${n.label}`, icon: n.icon, run: () => s.setView(n.id) });
    for (const e of workspace?.environments ?? [])
      cmds.push({ id: `env-${e.id}`, label: `Switch Environment: ${e.name}`, icon: <span className="block w-2.5 h-2.5 rounded-full" style={{ background: e.color ?? 'var(--ok)' }} />, run: () => s.setEnvironment(e.name) });
    return cmds;
  }, [workspace]);

  if (!ready)
    return (
      <div className="h-full grid place-items-center">
        <Spinner size={22} />
      </div>
    );

  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={150}>
    <div className="h-full flex flex-col">
      <TopBar />
      <div className="flex-1 flex min-h-0">
        <Sidebar />
        {explorerOpen && isRequestView(view) && (
          <ViewBoundary view="explorer">
            <Explorer />
          </ViewBoundary>
        )}
        <main className="flex-1 min-w-0 flex flex-col">
          {isRequestView(view) && view !== 'collections' && <EditorTabStrip />}
          <div className="flex-1 min-h-0 relative">
            {/* a multi-document view with every tab closed: the same "No open requests" as the HTTP view */}
            {isDocView(view) && !(docs[view] ?? []).length && (
              <div className="absolute inset-0 flex flex-col">
                <NoOpenTabs />
              </div>
            )}
            {mounted.flatMap((id) => {
              const V = VIEWS[id];
              // multi-document editors: one instance per open document (tab), each with its own draft and connection
              if (isDocView(id))
                return (docs[id] ?? []).map((docId) => {
                  const shown = id === view && docId === activeDocs[id];
                  return (
                    <div key={`${workspace?.id}-${id}-${docId}`} className="absolute inset-0 flex flex-col" style={{ display: shown ? 'flex' : 'none' }}>
                      <DocContext.Provider value={{ docId, active: shown }}>
                        <ViewBoundary view={id}>
                          <Suspense fallback={<div className="h-full grid place-items-center"><Spinner size={20} /></div>}>
                            <V />
                          </Suspense>
                        </ViewBoundary>
                      </DocContext.Provider>
                    </div>
                  );
                });
              return [(
                <div key={`${workspace?.id}-${id}`} className="absolute inset-0 flex flex-col" style={{ display: id === view ? 'flex' : 'none' }}>
                  <ViewBoundary view={id}>
                    <Suspense fallback={<div className="h-full grid place-items-center"><Spinner size={20} /></div>}>
                      <V />
                    </Suspense>
                  </ViewBoundary>
                </div>
              )];
            })}
          </div>
          {logsOpen && <LogsPanel />}
        </main>
        {assistant && <AssistantPanel key={JSON.stringify(assistant).slice(0, 200)} />}
      </div>
      <StatusBar />
      {paletteOpen && <CommandPalette commands={commands} />}
      {searchOpen && <SearchDialog />}
      {shortcutsOpen && (
        <Suspense fallback={null}>
          <ShortcutsDialog />
        </Suspense>
      )}
      {ci && (
        <Suspense fallback={null}>
          <CiDialog />
        </Suspense>
      )}
      <McpClientRequests />
      {feedback && (
        <Suspense fallback={null}>
          <FeedbackDialog request={feedback} onClose={() => useApp.getState().set({ feedback: undefined })} />
        </Suspense>
      )}
      {recordOpen && (
        <Suspense fallback={null}>
          <RecordDialog onClose={() => useApp.getState().set({ recordOpen: false })} />
        </Suspense>
      )}
      {variableUsages && (
        <Suspense fallback={null}>
          <VariableUsagesDialog
            names={[...new Set((workspace?.environments ?? []).flatMap((e) => (e as { variables?: Array<{ key: string }> }).variables?.map((v) => v.key) ?? []))]}
            initial={typeof variableUsages === 'string' ? variableUsages : undefined}
            onClose={() => useApp.getState().set({ variableUsages: undefined })}
          />
        </Suspense>
      )}
      {openapiDiff && (
        <Suspense fallback={null}>
          <OpenApiDiffDialog onClose={() => useApp.getState().set({ openapiDiff: false })} />
        </Suspense>
      )}
      {apiCoverage && (
        <Suspense fallback={null}>
          <ApiCoverageDialog runId={apiCoverage.runId} spec={apiCoverage.spec} onClose={() => useApp.getState().set({ apiCoverage: undefined })} />
        </Suspense>
      )}
      <Toaster />
      <DialogHost />
      <VarPopoverHost />
      <ProgressHost />
    </div>
    </TooltipProvider>
  );
}
