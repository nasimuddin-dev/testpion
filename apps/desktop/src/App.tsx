import { GitItemHistory } from './components/GitItemHistory';
import { AlarmClock, BarChart3, Bot, Code2, Keyboard, Columns2, CopyX, Disc, GitCompare, ScanSearch, TerminalSquare, Variable, Download, FileDown, FlaskConical, FolderOpen, FolderPlus, FolderTree, Gauge, GitBranch, History, KeyRound, Layers, ListChecks, ListX, Network, Play, Plug, Radio, RefreshCw, RotateCcw, Rows3, ScrollText, Search, Settings, Sparkles, SquareTerminal, Upload, Waypoints, Workflow, X, type LucideIcon } from 'lucide-react';
import { ImportHost, openImport } from './components/ImportHost';
import { pickAndShareSession } from './lib/git-share';
import { askAssistant } from './components/ai/AiAction';
import { useAiEnabled } from './lib/use-ai-enabled';
import { RightPanel } from './components/RightPanel';
import { openReverseProxyCapture } from './lib/capture';
import { createElement, lazy, memo, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { lazyMemoView, type LazyView } from './lib/memo-view';
import { call, modKey, on } from './api';
import { touchesFiles, type DataChangedEvent } from './lib/data-changed';
import { useApp, type ViewId } from './store';
import { watchSecretRefs } from './lib/secret-refs';
import { watchOpenLinks } from './lib/open-ref';
import { focusedScriptEditor } from './lib/script-editor';
import { focusedPaletteCommands } from './lib/palette-context';
import { VarPopoverHost } from './components/VarPopoverHost';
import { ProductionFrame } from './components/ProductionFrame';
import './lib/production-guard'; // WF-06: every refused production send or run is asked about here, once
import { DialogHost, LogsPanel, ProgressHost, SearchDialog, Sidebar, StatusBar, Toaster, TopBar, NAV, type PaletteCommand } from './components/Shell';
import { checkForUpdates, scheduleUpdateCheck } from './updates';
import { ViewBoundary } from './components/ViewBoundary';
import { isRequestView } from './store';
import { Explorer } from './components/Explorer';
import { EditorTabStrip, NoOpenTabs, useEditorTabsStore } from './components/EditorTabs';
import { RestTabsFollower } from './views/rest/tabs-store';
import { DOC_VIEWS, DocScope, isDocView, useDocs } from './lib/docs';
import { watchRunNotifications } from './lib/run-notifications';
import { remindExpiringCertificates, watchMonitorAlerts } from './lib/monitor-alerts';
import { runMenuCommand, type MenuCommand } from './menu-commands';
import { setResponseLayout } from './components/ResponseSplit';
import { loadMonaco } from './components/CodeEditor';
import { Spinner, TooltipProvider } from './components/ui';
import { McpClientRequests } from './components/McpClientRequests';
import { focusTerminal, newTerminal, useShellCapable } from './lib/terminal';
import { railShortcut } from './lib/rail';
import { resetRail, useRail } from './lib/use-rail';
import { handleGlobalKey } from './lib/key-commands';
import { applyDensity } from './lib/density';
import { saveUiPrefs } from './lib/ui-prefs';
import { keyLabel, useBindings } from './lib/keybindings';
import { copyRunCommand, runInCi } from './lib/run-ci';
import { reopenClosedTab } from './lib/closed-tabs';
import { downloadFocusedOutput } from './components/output/output-core';
import { runAgain } from './lib/run-again';
import { QuickOpen } from './components/QuickOpen';
import { CookiesModal } from './components/CookiesModal';


/**
 * Each tool is a separate product surface. Loading it only when selected keeps
 * startup fast and, importantly, defers Monaco and protocol-specific code until
 * it is useful. Named exports keep view modules simple.
 */
/** Where a dialog (or another floating part) that failed says so: a line over the status bar, with Close. */
const DIALOG_FALLBACK = 'fixed bottom-9 left-1/2 -translate-x-1/2 z-[60] w-[min(720px,92vw)] rounded-lg border shadow-lg';
const ShortcutsDialog = lazy(async () => ({ default: (await import('./components/ShortcutsDialog')).ShortcutsDialog }));
const ExportBundleDialog = lazy(() => import('./components/ExportBundleDialog'));
const ImportBundleDialog = lazy(() => import('./components/ImportBundleDialog'));
const CiDialog = lazy(async () => ({ default: (await import('./components/CiDialog')).CiDialog }));
const AskSearchDialog = lazy(async () => ({ default: (await import('./components/ai/AskSearchDialog')).AskSearchDialog }));
const FlowGenerateDialog = lazy(async () => ({ default: (await import('./components/ai/FlowGenerateDialog')).FlowGenerateDialog }));
const TidyImportDialog = lazy(async () => ({ default: (await import('./components/ai/TidyImportDialog')).TidyImportDialog }));
const AiAnalysisDialog = lazy(async () => ({ default: (await import('./components/ai/AiAnalysisDialog')).AiAnalysisDialog }));
const DriftDialog = lazy(async () => ({ default: (await import('./components/ai/DriftDialog')).DriftDialog }));
const RecordDialog = lazy(async () => ({ default: (await import('./components/RecordDialog')).RecordDialog }));
const FeedbackDialog = lazy(async () => ({ default: (await import('./components/FeedbackDialog')).FeedbackDialog }));
const VariableUsagesDialog = lazy(async () => ({ default: (await import('./components/VariableUsagesDialog')).VariableUsagesDialog }));
const OpenApiDiffDialog = lazy(async () => ({ default: (await import('./components/OpenApiDiffDialog')).OpenApiDiffDialog }));
const ApiCoverageDialog = lazy(async () => ({ default: (await import('./components/ApiCoverageDialog')).ApiCoverageDialog }));
/** A view, loaded on first use or by `prefetch()`, memoised (lib/memo-view): the shell renders without rendering the views it keeps mounted. */
const view = (load: () => Promise<any>, name: string): LazyView => lazyMemoView(load, name);

/**
 * One mounted view (or one document of a multi-document editor): shown or kept out of sight, and told so through
 * DocScope (`active`), the one signal a view, its editors and its polls use to work only while on screen.
 */
const ViewHost = memo(function ViewHost({ id, docId, shown }: { id: ViewId; docId?: string; shown: boolean }) {
  const V = VIEWS[id];
  return (
    <div className="absolute inset-0 flex flex-col" style={{ display: shown ? 'flex' : 'none' }}>
      <DocScope docId={docId} active={shown}>
        <ViewBoundary view={id}>
          <Suspense fallback={<div className="h-full grid place-items-center"><Spinner size={20} /></div>}>
            <V />
          </Suspense>
        </ViewBoundary>
      </DocScope>
    </div>
  );
});

/** Views that show a code editor: the editor (Monaco) is warmed in idle time once one of them opened, not before. */
const EDITOR_VIEWS: ViewId[] = ['rest', 'graphql', 'grpc', 'websocket', 'mcp', 'apidef', 'dataset', 'collections', 'tests', 'ai', 'evaluations', 'load', 'monitors'];
const VIEWS: Record<ViewId, LazyView> = {
  home: view(() => import('./views/HomeView'), 'HomeView'),
  rest: view(() => import('./views/RestView'), 'RestView'),
  graphql: view(() => import('./views/GraphQLView'), 'GraphQLView'),
  websocket: view(() => import('./views/WebSocketView'), 'WebSocketView'),
  apidef: view(() => import('./views/ApiDefinitionView'), 'ApiDefinitionView'),
  dataset: view(() => import('./views/DatasetView'), 'DatasetView'),
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

// The rail's screens are fetched and parsed in idle time once the app is up, one per idle slot, so a first visit to
// History, Traces, the Debugger … shows at once instead of waiting for its chunk. (Startup itself loads none of them.)
const RAIL_VIEWS: ViewId[] = ['history', 'traces', 'debugger', 'tests', 'environments', 'git', 'monitors', 'load', 'ai', 'evaluations', 'settings'];
function prefetchRailViews() {
  const idle = (fn: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 200));
  const next = (i: number) => {
    if (i < RAIL_VIEWS.length) idle(() => void VIEWS[RAIL_VIEWS[i]!].prefetch().catch(() => undefined).finally(() => next(i + 1)));
  };
  setTimeout(() => next(0), 1500);
}
if (typeof window !== 'undefined') {
  if (document.readyState === 'complete') prefetchRailViews();
  else window.addEventListener('load', prefetchRailViews, { once: true });
}

function useThemeEffect() {
  const settings = useApp((s) => s.settings);
  useEffect(() => {
    const apply = () => {
      const t = settings?.theme ?? 'system';
      const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      document.documentElement.dataset.reducedMotion = String(!!settings?.reducedMotion);
      document.documentElement.style.setProperty('--font-size', `${settings?.fontSize ?? 14}px`);
      if (settings) applyDensity(settings.density);
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings]);
}


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
  'keyboard-settings': Keyboard,
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
  'm-exp-bundle': Download,
  'm-import-bundle': Upload,
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
  const cookiesOpen = useApp((s) => s.cookiesOpen);
  const searchOpen = useApp((s) => s.searchOpen);
  const ci = useApp((s) => s.ci);
  const flowGenerate = useApp((s) => s.flowGenerate);
  const askSearch = useApp((s) => s.askSearch);
  const aiAnalysis = useApp((s) => s.aiAnalysis);
  const tidyImport = useApp((s) => s.tidyImport);
  // Settings ▸ AI assistant ▸ Hide all AI actions: no AI command, panel or dialog
  const aiOn = useAiEnabled();
  const openapiDiff = useApp((s) => s.openapiDiff);
  const exportBundle = useApp((s) => s.exportBundle);
  const gitItem = useApp((s) => s.gitItem);
  const importBundle = useApp((s) => s.importBundle);
  const apiCoverage = useApp((s) => s.apiCoverage);
  const explorerOpen = useApp((s) => s.explorerOpen);
  const explorerInTests = useApp((s) => !!s.explorerInTests);
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
        // the three first reads go out together: nothing waits for the one before it
        const [info, settings] = await Promise.all([call('app.info'), call('settings.get'), useApp.getState().refreshWorkspace()]);
        useApp.getState().set({ info, settings });
        scheduleUpdateCheck();
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
    // testpion://open links (testpion open <ref>, an agent, a report): the item opens here
    const offLinks = watchOpenLinks();
    const offUpdate = on('update.checkManual', () => void checkForUpdates({ manual: true }));
    // files changed outside the app (git pull, a branch switch, another editor): show the new state and say so
    const offDisk = on<{ message: string; kinds: string[] }>('workspace.changedOnDisk', (p) => {
      const s = useApp.getState();
      void s.refreshWorkspace();
      if (p.kinds.includes('environments') || p.kinds.includes('workspace')) s.set({ envsVersion: (s.envsVersion ?? 0) + 1 });
      s.toast(`${p.message}: TestPion shows the new version.`);
    });
    // environments (and workspace.json) written by anyone through the app — this window, an agent over MCP, the
    // assistant, a generator: the environment picker and every dialog listing them read the workspace again (once per
    // burst; changes made outside the app come as workspace.changedOnDisk above)
    let reading = false;
    let again = false;
    const offData = on<DataChangedEvent>('data.changed', (e) => {
      if (!touchesFiles(e, ['environments'])) return;
      again = true;
      if (reading) return;
      reading = true;
      void (async () => {
        try {
          while (again) {
            again = false;
            await useApp.getState().refreshWorkspace().catch(() => undefined);
          }
        } finally {
          reading = false;
        }
      })();
    });
    // application menu (File ▸ New, Import, Export, Save …)
    const offMenu = on<{ command: MenuCommand }>('menu.command', ({ command }) => void runMenuCommand(command));
    // File menu: request tab commands (handled by the REST view)
    const offTabs = on<{ command: string }>('tabs.command', ({ command }) => useApp.getState().openIntent('rest', command === 'new' ? { newTab: true } : { tabCommand: command }));
    return () => {
      off();
      offUpdate();
      offDisk();
      offData();
      offTabs();
      offMenu();
      offMonitors();
      offRuns();
      offSecrets();
      offLinks();
    };
  }, []);

  // editors with an open tab stay mounted (their tabs, drafts and live connections). REST's tabs live in their own store
  // (views/rest/tabs-store.ts: the strip, Close all and outside edits reach them without the view), so the view loads the
  // first time it is shown and then stays (its responses and the requests being sent)
  const openEditors = useEditorTabsStore((s) => s.openViews);
  const docs = useDocs((s) => s.docs);
  const activeDocs = useDocs((s) => s.active);
  const docViews = DOC_VIEWS.filter((v) => (docs[v] ?? []).length);
  const [restShown, setRestShown] = useState(false);
  if (view === 'rest' && !restShown) setRestShown(true);
  const mounted = useMemo(() => [...new Set<ViewId>([...visited, ...(restShown ? ['rest' as const] : []), ...openEditors, ...docViews])], [visited, restShown, openEditors, docViews.join()]);
  // the code editor (Monaco, a long task to parse) is warmed in idle time once a view that shows one opened
  const warmed = useRef(false);
  useEffect(() => {
    if (!ready || warmed.current || !EDITOR_VIEWS.includes(view)) return;
    warmed.current = true;
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => void loadMonaco(), { timeout: 5000 });
    else setTimeout(() => void loadMonaco(), 1500);
  }, [ready, view]);
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
  useEffect(() => (setVisited([useApp.getState().view]), setRestShown(useApp.getState().view === 'rest')), [workspace?.id]);

  useEffect(() => {
    // every app-wide shortcut, with the person's bindings (Settings ▸ Keyboard; lib/key-commands.ts)
    const onKey = handleGlobalKey;
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

  const shellCapable = useShellCapable();
  const rail = useRail();
  const bindings = useBindings();
  const commands = useMemo<PaletteCommand[]>(() => {
    const s = useApp.getState();
    const cmds: PaletteCommand[] = [
      { id: 'new-graphql', label: 'New GraphQL Request', hint: 'GraphQL', run: () => s.openIntent('graphql', { reset: true }) },
      { id: 'new-ai', label: 'New AI Test', hint: 'AI Lab', run: () => s.openIntent('ai', { reset: true }) },
      { id: 'run-test', label: 'Run Test', hint: 'Tests', run: () => s.openIntent('tests', { runCurrent: true }) },
      { id: 'run-suite', label: 'Run Suite', hint: 'Tests', run: () => s.openIntent('tests', { runAll: true }) },
      { id: 'rerun-last', label: 'Rerun Last Run', hint: keyLabel('rerun-last', bindings), run: () => void runAgain('last') },
      { id: 'reopen-tab', label: 'Reopen Closed Tab', hint: keyLabel('reopen-tab', bindings), run: () => void reopenClosedTab() },
      // the format menu of the output nearest to the focus (Ctrl+Shift+S saves its default format at once)
      { id: 'download-output', label: 'Download Output…', hint: keyLabel('download-output', bindings), run: () => setTimeout(() => downloadFocusedOutput(true), 0) },
      { id: 'open-recent', label: 'Open Recent…', hint: keyLabel('quick-open', bindings), run: () => setTimeout(() => s.set({ paletteOpen: true, paletteQuery: '' }), 0) },
      { id: 'ci-last', label: 'Run Last Run in CI…', hint: 'Tests', run: () => void runInCi('last') },
      { id: 'cli-last', label: 'Copy CLI Command of Last Run', hint: 'Tests', run: () => void copyRunCommand('last') },
      { id: 'search-history', label: 'Open History', hint: 'History', run: () => s.setView('history') },
      { id: 'open-settings', label: 'Open Settings', hint: keyLabel('settings', bindings), run: () => s.setView('settings') },
      { id: 'export-results', label: 'Export Results', hint: 'Tests', run: () => s.openIntent('tests', { exportLatest: true }) },
      { id: 'search', label: 'Search Workspace', hint: keyLabel('search', bindings), run: () => s.set({ searchOpen: true }) },
      { id: 'tab-close', label: 'Close Tab', hint: 'Ctrl+W', run: () => s.openIntent('rest', { tabCommand: 'close' }) },
      { id: 'tab-close-others', label: 'Close Other Tabs', hint: 'Requests', run: () => s.openIntent('rest', { tabCommand: 'closeOthers' }) },
      { id: 'tab-close-all', label: 'Close All Tabs', hint: 'Ctrl+Shift+W', run: () => s.openIntent('rest', { tabCommand: 'closeAll' }) },
      { id: 'toggle-console', label: 'Show Console', hint: keyLabel('toggle-console', bindings), run: () => s.set({ logsOpen: true, bottomTab: 'console' }) },
      { id: 'toggle-logs', label: 'Show Application Logs', run: () => s.set({ logsOpen: true, bottomTab: 'logs' }) },
      ...(shellCapable
        ? [
            { id: 'terminal-new', label: 'Terminal: New', hint: keyLabel('new-terminal', bindings), run: newTerminal },
            { id: 'terminal-focus', label: 'Terminal: Focus', hint: keyLabel('terminal', bindings), run: focusTerminal },
          ]
        : []),
      ...(aiOn ? [{ id: 'assistant', label: 'Ask AI Assistant', hint: keyLabel('assistant', bindings), run: () => askAssistant() }] : []),
      { id: 'feedback', label: 'Send Feedback or Report a Problem…', hint: 'Help', run: () => s.set({ feedback: {} }) },
      { id: 'agents', label: 'Connect an AI Agent (Claude, Cursor, VS Code, Codex) over MCP…', hint: 'Settings', run: () => s.openIntent('settings', { tab: 'agents' }) },
      { id: 'load', label: 'New Load Test', run: () => s.setView('load') },
      { id: 'compare', label: 'Compare Models', hint: 'AI Lab', run: () => s.openIntent('ai', { tab: 'compare' }) },
      { id: 'ai-usage', label: 'AI Usage: tokens and cost per model', hint: 'AI Lab', run: () => s.openIntent('ai', { tab: 'usage' }) },
      { id: 'mcp-usage', label: 'MCP Tool Usage: calls, failures and time per tool', hint: 'MCP', run: () => s.openIntent('mcp', { tab: 'usage' }) },
      { id: 'eval', label: 'New Evaluation', hint: 'Evaluations', run: () => s.setView('evaluations') },
      { id: 'shortcuts', label: 'Keyboard Shortcuts', hint: keyLabel('shortcuts', bindings), run: () => s.set({ shortcutsOpen: true }) },
      { id: 'keyboard-settings', label: 'Keyboard Shortcuts: Change the Keys…', hint: 'Settings', run: () => s.openIntent('settings', { tab: 'keyboard' }) },
      { id: 'git-ready', label: 'Make Workspace Ready for Git', hint: 'Workspace', run: () => void runMenuCommand('git-ready') },
      { id: 'git-fix', label: 'Fix Git Setup', hint: 'Workspace', run: () => void runMenuCommand('git-fix') },
      { id: 'git-clone', label: 'Clone Workspace from Git…', hint: 'Workspace', run: () => void runMenuCommand('git-clone') },
      { id: 'git-view', label: 'Git: Changes, Commit, Pull and Push', hint: 'Workspace', run: () => useApp.getState().setView('git') },
      { id: 'git-codeowners', label: 'Create CODEOWNERS: Who Must Review Which Changes…', hint: 'Workspace', run: () => useApp.getState().openIntent('git', { codeowners: true }) },
      { id: 'share-session', label: 'Share a Debugger Session with the Team…', hint: 'Debugger', run: () => void pickAndShareSession() },
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
      { id: 'm-record', label: 'Capture: Reverse Proxy for One API…', hint: 'Debugger', run: () => openReverseProxyCapture() },
      { id: 'm-var-usages', label: 'Find variable usages / rename a variable everywhere…', hint: 'Environments', run: () => useApp.getState().set({ variableUsages: true }) },
      { id: 'm-openapi-diff', label: 'Compare OpenAPI versions (breaking changes)…', hint: 'Tests', run: () => useApp.getState().set({ openapiDiff: true }) },
      { id: 'm-api-coverage', label: 'API coverage (OpenAPI operations tested)…', hint: 'Tests', run: () => useApp.getState().set({ apiCoverage: {} }) },
      { id: 'm-new-monitor', label: 'New Monitor', hint: 'File', run: () => void runMenuCommand('new-monitor') },
      { id: 'm-new-workspace', label: 'New Workspace', hint: 'File', run: () => void runMenuCommand('new-workspace') },
      { id: 'm-open-ws', label: 'Open Workspace Folder', hint: 'File', run: () => void runMenuCommand('open-workspace') },
      { id: 'm-import', label: 'Import (Postman, Insomnia, Bruno, OpenAPI, HAR, cURL …)', hint: 'File', run: () => void runMenuCommand('import') },
      { id: 'm-exp-col', label: 'Export Collection (Postman)', hint: 'File', run: () => void runMenuCommand('export-collection') },
      { id: 'm-exp-env', label: 'Export Current Environment', hint: 'File', run: () => void runMenuCommand('export-environment') },
      { id: 'm-exp-ws', label: 'Export Workspace (older format)', hint: 'File', run: () => void runMenuCommand('export-workspace') },
      { id: 'm-exp-bundle', label: 'Export a TestPion Bundle…', hint: 'File', run: () => void runMenuCommand('export-bundle') },
      { id: 'm-import-bundle', label: 'Import a TestPion Bundle…', hint: 'File', run: () => void runMenuCommand('import-bundle') },
      { id: 'm-migrate', label: 'Migrate from Another Tool (Postman, Insomnia, Bruno …)…', hint: 'File', run: () => openImport({ migrate: true }) },
    ];
    // every command has an icon: its own, or a generic one for a command added without
    for (const c of cmds) c.icon = createElement(PALETTE_ICONS[c.id] ?? TerminalSquare, { size: 16 });
    // "Go to" commands use the navigation's own icons, with the rail's shortcut when the view is on the rail
    for (const n of NAV) cmds.push({ id: `go-${n.id}`, label: `Go to ${n.label}`, icon: n.icon, hint: railShortcut(rail.visible, n.id, modKey), run: () => s.setView(n.id) });
    cmds.push({ id: 'density', label: 'Density: Switch Compact / Comfortable', icon: createElement(Rows3, { size: 16 }), hint: 'View', run: () => void saveUiPrefs({ density: useApp.getState().settings?.density === 'compact' ? 'comfortable' : 'compact' }) });
    cmds.push({ id: 'rail-all', label: 'Rail: Show Every View', icon: createElement(Rows3, { size: 16 }), hint: 'View', run: () => void resetRail(true) });
    cmds.push({ id: 'rail-reset', label: 'Rail: Reset to the Default Views', icon: createElement(RotateCcw, { size: 16 }), hint: 'View', run: () => void resetRail() });
    for (const e of (workspace?.environments ?? []).filter((x) => !x.problem))
      cmds.push({ id: `env-${e.id}`, label: `Switch Environment: ${e.name}`, icon: <span className="block w-2.5 h-2.5 rounded-full" style={{ background: e.color ?? 'var(--ok)' }} />, run: () => s.setEnvironment(e.name) });
    return cmds;
  }, [workspace, shellCapable, rail, bindings, aiOn]);
  // what is on screen offers its own commands (Quick Open's @, and first among the > commands): a request's script
  // editor (Insert Snippet…, Ctrl+Shift+I there), the flow designer's canvas …
  const hereCommands = useMemo<PaletteCommand[]>(() => {
    const ed = paletteOpen ? focusedScriptEditor() : undefined;
    const here = paletteOpen ? focusedPaletteCommands() : [];
    return ed ? [{ id: 'insert-snippet', label: 'Insert Snippet…', hint: 'Ctrl+Shift+I', icon: <Code2 size={16} />, run: () => ed.insertSnippet() }, ...here] : here;
  }, [paletteOpen]);
  const paletteCommands = useMemo<PaletteCommand[]>(() => (hereCommands.length ? [...hereCommands, ...commands] : commands), [hereCommands, commands]);

  if (!ready)
    return (
      <div className="h-full grid place-items-center">
        <Spinner size={22} />
      </div>
    );

  // every part of the window outside the views has a boundary of its own: one that fails leaves the rest working
  const close = (patch: Partial<ReturnType<typeof useApp.getState>>) => () => useApp.getState().set(patch);
  const guard = (name: string, node: ReactNode, onDismiss?: () => void) => (
    <ViewBoundary view={name} variant="bar" label={name} onDismiss={onDismiss} className={DIALOG_FALLBACK}>
      {node}
    </ViewBoundary>
  );

  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={150}>
    <div className="h-full flex flex-col">
      <ImportHost />
      <RestTabsFollower />
      <ViewBoundary view="topbar" variant="bar" label="top bar" className="h-12 border-b">
        <TopBar />
      </ViewBoundary>
      <div className="flex-1 flex min-h-0">
        <ViewBoundary view="sidebar" variant="bar" label="sidebar" className="w-48 border-r flex-col items-start">
          <Sidebar />
        </ViewBoundary>
        {((explorerOpen && isRequestView(view)) || (view === 'tests' && explorerInTests)) && (
          <ViewBoundary view="explorer">
            <Explorer />
          </ViewBoundary>
        )}
        <main className="flex-1 min-w-0 flex flex-col">
          {isRequestView(view) && view !== 'collections' && (
            <ViewBoundary view="tabs" variant="bar" label="tab strip" className="border-b">
              <EditorTabStrip />
            </ViewBoundary>
          )}
          <div className="flex-1 min-h-0 relative">
            {/* a multi-document view with every tab closed: the same "No open requests" as the HTTP view */}
            {isDocView(view) && !(docs[view] ?? []).length && (
              <div className="absolute inset-0 flex flex-col">
                <NoOpenTabs />
              </div>
            )}
            {mounted.flatMap((id) =>
              // multi-document editors: one instance per open document (tab), each with its own draft and connection
              isDocView(id)
                ? (docs[id] ?? []).map((docId) => <ViewHost key={`${workspace?.id}-${id}-${docId}`} id={id} docId={docId} shown={id === view && docId === activeDocs[id]} />)
                : [<ViewHost key={`${workspace?.id}-${id}`} id={id} shown={id === view} />],
            )}
          </div>
          {logsOpen && (
            <ViewBoundary view="logs" variant="bar" label="bottom panel" className="border-t" onDismiss={close({ logsOpen: false })}>
              <LogsPanel />
            </ViewBoundary>
          )}
        </main>
        {/* WF-20: one pinnable host on the right — the Info panel and the AI assistant */}
        <ViewBoundary view="assistant" variant="bar" label="side panel" className="w-80 border-l flex-col items-start" onDismiss={close({ assistant: undefined })}>
          <RightPanel />
        </ViewBoundary>
      </div>
      <ViewBoundary view="statusbar" variant="bar" label="status bar" className="border-t">
        <StatusBar />
      </ViewBoundary>
      {paletteOpen && guard('command palette', <QuickOpen commands={paletteCommands} here={hereCommands} />, close({ paletteOpen: false, paletteQuery: undefined }))}
      {searchOpen && guard('search', <SearchDialog />, close({ searchOpen: false }))}
      {shortcutsOpen &&
        guard(
          'shortcuts',
          <Suspense fallback={null}>
            <ShortcutsDialog />
          </Suspense>,
          close({ shortcutsOpen: false }),
        )}
      {aiOn && flowGenerate &&
        guard(
          'flow generation',
          <Suspense fallback={null}>
            <FlowGenerateDialog request={flowGenerate} onClose={() => useApp.getState().set({ flowGenerate: undefined })} />
          </Suspense>,
          close({ flowGenerate: undefined }),
        )}
      {aiOn && tidyImport &&
        guard(
          'tidy import',
          <Suspense fallback={null}>
            <TidyImportDialog key={tidyImport.collectionId} request={tidyImport} onClose={() => useApp.getState().set({ tidyImport: undefined })} />
          </Suspense>,
          close({ tidyImport: undefined }),
        )}
      {aiOn && askSearch &&
        guard(
          'ask search',
          <Suspense fallback={null}>
            <AskSearchDialog request={askSearch} onClose={() => useApp.getState().set({ askSearch: undefined })} />
          </Suspense>,
          close({ askSearch: undefined }),
        )}
      {aiOn && aiAnalysis &&
        guard(
          'AI analysis',
          <Suspense fallback={null}>
            {aiAnalysis.kind === 'drift' ? (
              <DriftDialog key={`drift:${aiAnalysis.spec}`} request={aiAnalysis} onClose={() => useApp.getState().set({ aiAnalysis: undefined })} />
            ) : (
              <AiAnalysisDialog key={`${aiAnalysis.kind}:${aiAnalysis.kind === 'triage' ? aiAnalysis.runId : aiAnalysis.testId}`} request={aiAnalysis} onClose={() => useApp.getState().set({ aiAnalysis: undefined })} />
            )}
          </Suspense>,
          close({ aiAnalysis: undefined }),
        )}
      {ci &&
        guard(
          'CI dialog',
          <Suspense fallback={null}>
            <CiDialog />
          </Suspense>,
          close({ ci: undefined }),
        )}
      {gitItem &&
        guard('item history', <GitItemHistory itemRef={gitItem.ref} name={gitItem.name} tab={gitItem.tab} onClose={() => useApp.getState().set({ gitItem: undefined })} />, close({ gitItem: undefined }))}
      {exportBundle &&
        guard(
          'export dialog',
          <Suspense fallback={null}>
            <ExportBundleDialog request={exportBundle} onClose={() => useApp.getState().set({ exportBundle: undefined })} />
          </Suspense>,
          close({ exportBundle: undefined }),
        )}
      {importBundle &&
        guard(
          'import dialog',
          <Suspense fallback={null}>
            <ImportBundleDialog request={importBundle} onClose={() => useApp.getState().set({ importBundle: undefined })} />
          </Suspense>,
          close({ importBundle: undefined }),
        )}
      {guard('MCP requests', <McpClientRequests />)}
      {feedback &&
        guard(
          'feedback dialog',
          <Suspense fallback={null}>
            <FeedbackDialog request={feedback} onClose={() => useApp.getState().set({ feedback: undefined })} />
          </Suspense>,
          close({ feedback: undefined }),
        )}
      {recordOpen &&
        guard(
          'record dialog',
          <Suspense fallback={null}>
            <RecordDialog onClose={() => useApp.getState().set({ recordOpen: false })} />
          </Suspense>,
          close({ recordOpen: false }),
        )}
      {variableUsages &&
        guard(
          'variable usages',
          <Suspense fallback={null}>
            <VariableUsagesDialog
              names={[...new Set((workspace?.environments ?? []).flatMap((e) => (e as { variables?: Array<{ key: string }> }).variables?.map((v) => v.key) ?? []))]}
              initial={typeof variableUsages === 'string' ? variableUsages : undefined}
              onClose={() => useApp.getState().set({ variableUsages: undefined })}
            />
          </Suspense>,
          close({ variableUsages: undefined }),
        )}
      {openapiDiff &&
        guard(
          'OpenAPI comparison',
          <Suspense fallback={null}>
            <OpenApiDiffDialog onClose={() => useApp.getState().set({ openapiDiff: false })} />
          </Suspense>,
          close({ openapiDiff: false }),
        )}
      {apiCoverage &&
        guard(
          'API coverage',
          <Suspense fallback={null}>
            <ApiCoverageDialog runId={apiCoverage.runId} spec={apiCoverage.spec} onClose={() => useApp.getState().set({ apiCoverage: undefined })} />
          </Suspense>,
          close({ apiCoverage: undefined }),
        )}
      {guard('notifications', <Toaster />)}
      {guard('dialog', <DialogHost />)}
      {guard('variable popover', <VarPopoverHost />)}
      {guard('progress', <ProgressHost />)}
      {cookiesOpen && guard('cookies', <CookiesModal onClose={() => useApp.getState().set({ cookiesOpen: false })} />, close({ cookiesOpen: false }))}
      <ProductionFrame />
    </div>
    </TooltipProvider>
  );
}
