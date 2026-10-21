/**
 * Desktop backend: every capability of the UI is exposed as an RPC method here.
 * It runs in the Electron main process (via IPC) or, for browser-based development,
 * behind a local HTTP bridge. All protocol execution happens in @testpion/core — the same
 * engine the CLI uses — so the UI thread never performs network or test execution.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  ApsError,
  ENGINE_VERSION,
  ChainSecretStore,
  EncryptedFileSecretStore,
  EnvSecretStore,
  Logger,
  McpSession,
  MemorySecretStore,
  Redactor,
  WebSocketSession,
  SocketIoSession,
  KafkaSession,
  MqttSession,
  WorkspaceManager,
  WorkspaceSearch,
  WorkspaceStore,
  batcher,
  runResults,
  pageRunResults,
  breakdownOfRun,
  type RunBreakdown,
  createEngineContext,
  expandDataset,
  fileSink,
  loadSuite,
  normalizeError,
  type Recorder,
  type GraphQLSubscription,
  CurrentValues,
  CookieJarStore,
  collectMockRoutes,
  type MockRoute,
  type MockServer,
  runTests,
  runCollection,
  collectionRealtimeTests,
  collectionRequests,
  shortId,
  streamTests,
  type GraphQLMockServer,
  recordRun,
  isSuiteFile,
  DEFAULT_BASE_URLS,
  type AppSettings,
  type HttpRequestSpec,
  type LoadTestConfig,
  type LogRecord,
  type McpServerConfig,
  type RunEvent,
  type RunOptions,
  type RunSummary,
  type RunOrigin,
  type DatasetRecord,
  type SecretCipher,
  type SecretStore,
  type TestCase,
  type TestResult,
  MonitorScheduler,
  listMonitors,
  lastMonitorResult,
  type WorkspaceInfo,
  setProxySettings,
  ensureProxyApplied,
  setTlsTrust,
  APP_CLAUDE_ID,
  runAiTask,
  aiRunDeps,
  type AiRunDeps,
  type AiTaskRequest,
  type AiTaskResult,
  APP_CLAUDE_SECRET,
  DEFAULT_CLAUDE_MODEL,
  appClaudeProvider,
  addTemplateAdditions,
  readJson,
  describeChanges,
  watchWorkspace,
  type WorkspaceWatch,
  samePath,
  type OutputDeps,
} from '@testpion/core';
import { appHandlers } from './handlers/app.js';
import { workspaceHandlers } from './handlers/workspace.js';
import { collectionsHandlers } from './handlers/collections.js';
import { requestsHandlers } from './handlers/requests.js';
import { mcpHandlers } from './handlers/mcp.js';
import { aiHandlers } from './handlers/ai.js';
import { aiTaskHandlers } from './handlers/ai-tasks.js';
import { aiTriageHandlers } from './handlers/ai-triage.js';
import { aiSpecHandlers } from './handlers/ai-spec.js';
import { aiSecurityHandlers } from './handlers/ai-security.js';
import { testingHandlers } from './handlers/testing.js';
import { monitorHandlers, runMonitorNow } from './handlers/monitors.js';
import { grpcHandlers } from './handlers/grpc.js';
import { agentHandlers } from './handlers/agents.js';
import { feedbackHandlers } from './handlers/feedback.js';
import { gitHandlers } from './handlers/git.js';
import { gitItemHandlers } from './handlers/git-items.js';
import { gitSetupHandlers } from './handlers/git-setup.js';
import { GitAutoFetch } from './git-autofetch.js';
import { debuggerHandlers, type DebuggerState } from './handlers/debugger.js';
import { debuggerRulesHandlers } from './handlers/debugger-rules.js';
import { externalSecretsHandlers, prefetchSecretsFor } from './handlers/external-secrets.js';
import { fuzzHandlers } from './handlers/fuzz.js';
import { flowDebugHandlers } from './handlers/flow-debug.js';
import { debuggerFlowHandlers } from './handlers/debugger-flow.js';
import { debuggerReverseHandlers } from './handlers/debugger-reverse.js';
import { terminalHandlers, createTerminals, type TerminalHost, type TerminalManager } from './handlers/terminal.js';
import { flowDeployHandlers, stopFlowWebhooks } from './handlers/flow-deploy.js';
import { flowScaleHandlers, cancelScaleRuns } from './handlers/flow-scale.js';
import { evalMatrixHandlers } from './handlers/eval-matrix.js';
import { ragHandlers } from './handlers/rag.js';
import { ragMetricHandlers } from './handlers/rag-metrics.js';
import { ragR4Handlers } from './handlers/rag-r4.js';
import { outputHandlers } from './handlers/output.js';
import { kindHandlers } from './handlers/kinds.js';
import { importHandlers } from './handlers/import.js';
import { bundleHandlers } from './handlers/bundle.js';
import { checkRpcParams, guardHandler } from './rpc-params.js';
import { forgetProductionSessions, guardProduction } from './production-guard.js';
import { VizPages } from './viz-pages.js';
import { OwnWrites, type OwnWriteBatch } from './own-writes.js';
import { consoleFromResult, consoleProtocol, pushConsole, type ConsoleEntry } from './console-log.js';
import { httpSend as httpSendImpl, codeSnippet as codeSnippetImpl, gqlSend as gqlSendImpl } from './send.js';
import { aiChat as aiChatImpl } from './ai-chat.js';
import { startLoad as startLoadImpl } from './load.js';
import { hasTemplate } from '@testpion/shared';
import { findNodeName, readRunData } from './run-data.js';

/** How long after start the monitor scheduler and the background git fetch begin (the window's first paint comes first). */
const SCHEDULERS_DELAY_MS = 3000;
/** What the window reads at start-up: nothing of it goes over the network, so it never waits for the HTTP stack to load. */
const LOCAL_READS = /^(app\.info|settings\.get|ws\.(current|list|examplesAdded)|col\.(list|tree|get)|env\.list|lib\.get|mcp\.servers|openapi\.specs|datasets\.list|stats\.\w+|debug\.status|git\.(status|changes|log)|monitor\.list|history\.list|runs\.list|traces\.list|terminal\.\w+)$/;
/** RPC methods that change what the workspace lists (collections, saved items, environments, monitors, MCP servers). */
const DATA_CHANGING = /^(col\.(save|delete|import\w*|move\w*|duplicate\w*)|lib\.save|env\.(save|delete|reorder|import\w*)|vars\.setInEnvironment|monitor\.(save|delete)|mcp\.(saveServers|connect|disconnect)|trash\.restore|debug\.saveToCollection|ws\.(open|import\w*|openExamples))$/;

export interface BackendHost {
  appDir: string;
  cipher?: SecretCipher;
  emit(channel: string, payload: unknown): void;
  openExternal?(url: string): void | Promise<void>;
  saveDialog?(opts: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | undefined>;
  openDialog?(opts: { directory?: boolean; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | undefined>;
  openPath?(path: string): void | Promise<unknown>;
  /** Show a saved file in the system's file manager (desktop only). */
  showItemInFolder?(path: string): void;
  /** The examples workspace shipped with the app (copied into the data folder on first launch). */
  examplesDir?: string;
  /** Don't run monitors on their schedule (tests, one-off tools). */
  noMonitors?: boolean;
  /** How to start this app as an MCP server (`<command> <args> --mcp-server -w …`); without it agents use the CLI. */
  mcpCommand?: { command: string; args: string[] };
  /** Real shells for the Terminal panel (desktop only: node-pty); its presence is `capabilities.shell` (terminal.ts). */
  terminal?: TerminalHost;
}

export type Handler = (params: any) => Promise<unknown> | unknown;
/** A domain's RPC methods by name (see handlers/). */
export type Handlers = Record<string, Handler>;

interface RunState {
  ctrl: AbortController;
  done: boolean;
}

export type { ConsoleEntry } from './console-log.js';

export type { AiChatParams, CollectionRunParams, EvalRunParams, GqlSendParams, HttpSendParams } from './params.js';
import type { AiChatParams, CollectionRunParams, EvalRunParams, GqlSendParams, HttpSendParams } from './params.js';

export class Backend {
  host: BackendHost;
  manager: WorkspaceManager;
  settings: AppSettings;
  store?: WorkspaceStore;
  currentValues?: CurrentValues;
  cookieStore?: CookieJarStore;
  search?: WorkspaceSearch;
  secrets: SecretStore;
  logger: Logger;
  logBuffer: LogRecord[] = [];
  /** Postman-style console: recent requests with their details and script output. */
  consoleBuffer: ConsoleEntry[] = [];
  /** What the output builders (output.save) read from the handlers that hold it: the Debugger session on screen, as HAR. */
  outputProviders: { har?: NonNullable<OutputDeps['har']>; scaleRows?: OutputDeps['scaleRows'] } = {};
  /** Redactors of connected MCP servers and WebSocket sessions, for their console entries. */
  mcpRedactors = new Map<string, Redactor>();
  wsConsole = new Map<string, { url: string; redactor: Redactor; counts: { sent: number; received: number; opened: number } }>();
  controllers = new Map<string, AbortController>();
  /** What this start added to the user's examples workspace (shown once by the UI, see ws.examplesAdded). */
  examplesAdded: string[] = [];
  runs = new Map<string, RunState>();
  mcpSessions = new Map<string, McpSession>();
  wsSessions = new Map<string, WebSocketSession>();
  /** Socket.IO sessions (the WebSocket view's Socket.IO mode). */
  sioSessions = new Map<string, SocketIoSession>();
  mqttSessions = new Map<string, MqttSession>();
  kafkaSessions = new Map<string, KafkaSession>();
  /** Running mock servers by collection id. */
  mocks = new Map<string, MockServer>();
  /** Rendered tp.visualizer pages by id (served on an isolated origin: tpviz:// or /__aps/viz/). */
  vizPages = new VizPages();
  /** The GraphQL mock started from the GraphQL view (one at a time). */
  gqlMock?: GraphQLMockServer;
  /** Running GraphQL subscriptions by id. */
  gqlSubs = new Map<string, GraphQLSubscription>();
  /** The traffic recorder (reverse proxy), when one is running. */
  recorder?: Recorder;
  /** The HTTP Debugger's proxy and session (handlers/debugger.ts). */
  debugger?: DebuggerState;
  /** Monitors running right now (by id), from the schedule or "Run now". */
  runningMonitors = new Set<string>();
  /** Runs monitors of the open workspace when they are due, while this backend runs. */
  monitorScheduler: MonitorScheduler;
  /** Fetches the open workspace's remote in the background and says when it has new commits (git-autofetch.ts). */
  gitAutoFetch = new GitAutoFetch(this);
  terminals: TerminalManager;
  readonly handlers: Handlers;

  /** Counts the `data.changed` events (anything saved, imported, deleted, changed on disk): caches key on it. */
  dataEpoch = 0;

  constructor(host: BackendHost) {
    // every data.changed passes here, whoever emits it: the caches of what was read from the workspace go stale
    const emit = host.emit.bind(host);
    this.host = Object.assign(Object.create(host) as BackendHost, {
      emit: (channel: string, payload: unknown) => {
        if (channel === 'data.changed') this.dataEpoch++;
        emit(channel, payload);
      },
    });
    this.manager = new WorkspaceManager(host.appDir);
    this.settings = this.manager.loadSettings();
    const stores: SecretStore[] = [];
    if (host.cipher) stores.push(new EncryptedFileSecretStore(join(host.appDir, 'secrets.json'), host.cipher));
    else stores.push(new MemorySecretStore());
    stores.push(new EnvSecretStore());
    this.secrets = new ChainSecretStore(stores);
    this.logger = new Logger(this.settings.logLevel, new Redactor(this.settings.redactFields));
    this.logger.addSink(fileSink(join(host.appDir, 'logs', 'app.log')));
    this.logger.addSink((rec) => {
      this.logBuffer.push(rec);
      if (this.logBuffer.length > 500) this.logBuffer.shift();
      this.host.emit('log', rec);
    });
    this.terminals = createTerminals(this);
    this.handlers = this.buildHandlers();
    this.applyProxy();
    if (this.manager.settingsProblem) this.logger.warn(`Settings were reset to defaults: ${this.manager.settingsProblem}`);
    this.bootstrapWorkspace();
    this.monitorScheduler = new MonitorScheduler({
      // read on every tick, so a workspace switch or an edited monitor applies right away
      list: () => (this.store ? listMonitors(this.store).filter((m) => !this.runningMonitors.has(m.id)) : []),
      last: (id) => lastMonitorResult(this.ws, id),
      run: (m) => runMonitorNow(this, m, 'schedule'),
      onResult: (monitor, result, previous) => this.host.emit('monitor.result', { monitor, result, previous }),
      resolve: (m, text) => {
        const ctx = this.context({ environment: m.environment });
        try {
          return ctx.vars.resolve(text);
        } finally {
          void ctx.dispose();
        }
      },
      onWebhook: (m, r) => (r.ok ? this.logger.info(`Monitor ${m.name}: webhook notified`) : this.logger.warn(`Monitor ${m.name}: webhook failed: ${r.error ?? `HTTP ${r.status}`}`)),
      onError: (m, e) => this.logger.error(`Monitor ${m.name} could not run: ${(e as Error).message}`),
    });
    // the schedulers and the examples update start once the window is up: nothing of them is needed in the first seconds
    if (!host.noMonitors) this.deferred.push(setTimeout(() => (this.monitorScheduler.start(), this.gitAutoFetch.start()), SCHEDULERS_DELAY_MS));
    this.deferred.push(setTimeout(() => this.updateExamples(), 0));
    for (const t of this.deferred) (t as { unref?(): void }).unref?.();
  }

  /** Work put off past startup (the schedulers, the examples update); `close` cancels what has not run. */
  private deferred: Array<ReturnType<typeof setTimeout>> = [];

  /** Apply the proxy and certificate settings (the proxy password comes from the secret store and is redacted from logs). */
  applyProxy(): void {
    const p = this.settings.proxy ?? { mode: 'env' as const };
    const password = p.mode === 'custom' && p.username ? this.secrets.get('proxy.password') : undefined;
    if (password) this.logger.redactor.addSecret(password);
    try {
      setProxySettings({ ...p, password });
    } catch (e) {
      this.logger.warn(`Proxy settings ignored: ${(e as Error).message}`);
      setProxySettings({ mode: 'env' });
    }
    try {
      setTlsTrust(this.settings.tls ?? {});
    } catch (e) {
      this.logger.warn(`Certificate settings ignored: ${(e as Error).message}`);
      setTlsTrust({});
    }
  }

  /** Copy the bundled examples workspace into the data folder (once); undefined when this host has none. */
  installExamples(): WorkspaceInfo | undefined {
    const dir = this.host.examplesDir;
    if (!dir || !existsSync(join(dir, 'workspace.json'))) return undefined;
    try {
      return this.manager.installTemplate(dir);
    } catch (e) {
      this.logger.warn(`Could not install the examples workspace: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * Examples that shipped with this version go into the user's copy: additions only, never a change
   * (addTemplateAdditions). Once per app version: the settings remember the version whose examples were offered.
   */
  private updateExamples(): void {
    const dir = this.host.examplesDir;
    if (!dir || !existsSync(join(dir, 'workspace.json'))) return;
    if (this.settings.examplesOfferedVersion === ENGINE_VERSION) return;
    try {
      const id = readJson<{ id: string }>(join(dir, 'workspace.json')).id;
      const mine = this.manager.list().find((w) => w.id === id);
      if (!mine) return;
      // the files it adds are the app's own (copyOwned: no "changed on disk" for them)
      const added = addTemplateAdditions(dir, mine.path);
      this.examplesAdded = added;
      if (added.length && this.store && samePath(this.store.root, mine.path)) this.host.emit('data.changed', { method: 'ws.import' });
      this.settings = this.manager.saveSettings({ ...this.settings, examplesOfferedVersion: ENGINE_VERSION });
      if (added.length) this.logger.info(`Added to the examples workspace: ${added.join(', ')}`);
    } catch (e) {
      this.logger.warn(`Could not add the new examples: ${(e as Error).message}`);
    }
  }

  /** Open the last workspace, or create a starter workspace on first launch. */
  private bootstrapWorkspace(): void {
    try {
      const last = this.settings.lastWorkspace && this.manager.resolve(this.settings.lastWorkspace);
      if (last) return this.openStore(last);
      const list = this.manager.list();
      if (list.length) return this.openStore(list[0]!.path);
      const s = this.manager.create('My Workspace');
      s.saveProviders([{ id: 'offline', name: 'Offline mock', kind: 'mock', baseUrl: DEFAULT_BASE_URLS.mock! }]);
      s.close();
      // first launch: start in the examples (public APIs, every protocol), next to an empty workspace
      const examples = this.installExamples();
      this.openStore(examples?.path ?? this.manager.resolve('My Workspace')!);
    } catch (e) {
      this.logger.error('Failed to open workspace', normalizeError(e));
    }
  }

  /** Watches the open workspace's folder (GIT-103): call it to stop. */
  private stopWatching?: WorkspaceWatch;
  /** The app's own writes to the workspace, as `data.changed` (own-writes.ts). */
  private readonly ownWrites = new OwnWrites(
    () => this.store?.root,
    (b) => this.host.emit('data.changed', { method: 'write', ...b }),
  );

  /**
   * Another program changed the workspace for the app (git switch, pull, discard): the folder as it is now is the
   * known state, so the watcher does not report those files as changed outside TestPion. The caller refreshes.
   */
  adoptDiskState(): void {
    this.stopWatching?.adopt();
  }

  /** Notice changes made outside the app (git pull, a branch switch, another editor) and refresh the UI. */
  private watchStore(root: string): void {
    this.stopWatching?.();
    this.stopWatching = watchWorkspace(
      root,
      (changes) => {
        if (!this.store || this.store.root !== root) return;
        if (changes.some((c) => c.kind === 'workspace')) this.store.reloadWorkspaceFile();
        this.logger.info(describeChanges(changes), { files: changes.map((c) => c.path).slice(0, 50) });
        // which collections changed (by file: the id is the file name, or whatever the file says): the window then
        // reads those, not every collection again; a change elsewhere in collections/ (a new file, a folder) reads all
        const kinds = [...new Set(changes.map((c) => c.kind))];
        const collectionIds = changes.filter((c) => c.kind === 'collections').map((c) => this.collectionIdOfPath(c.path));
        const complete = !collectionIds.some((id) => id === undefined);
        this.host.emit('data.changed', { method: 'disk', kinds, paths: changes.map((c) => c.path).slice(0, 50), ...(complete ? { collectionIds: collectionIds as string[] } : {}) });
        this.host.emit('workspace.changedOnDisk', { message: describeChanges(changes), kinds: [...new Set(changes.map((c) => c.kind))], files: changes.map((c) => c.path).slice(0, 50) });
      },
    );
  }

  /** The id of the collection in a changed `collections/<file>.json`; undefined when the file is not one collection. */
  private collectionIdOfPath(path: string): string | undefined {
    const m = /^collections\/([^/]+)\.json$/.exec(path);
    if (!m || !this.store) return undefined;
    try {
      const id = readJson<{ id?: string }>(join(this.store.root, path)).id;
      return typeof id === 'string' && id ? id : m[1];
    } catch {
      return m[1];
    }
  }

  openStore(path: string): void {
    // the new workspace opens first: when it is refused (not a TestPion folder) the open one stays as it was
    const next = WorkspaceStore.open(path);
    if (this.store && !samePath(this.store.root, next.root)) this.terminals?.dispose('workspace'); // the same folder by another name keeps them
    this.store?.close();
    for (const s of this.mcpSessions.values()) void s.close();
    this.mcpSessions.clear();
    forgetProductionSessions(this);
    for (const m of this.mocks.values()) void m.close();
    this.mocks.clear();
    void this.gqlMock?.close();
    this.gqlMock = undefined;
    void stopFlowWebhooks(this); // it served the old workspace's flows
    cancelScaleRuns(this); // data runs and matrices of the old workspace
    this.store = next;
    this.watchStore(this.store.root);
    this.currentValues = new CurrentValues(join(this.host.appDir, 'current-values', `${this.store.id}.json`), this.secrets, this.store.id);
    void this.cookieStore?.flush().catch(() => undefined);
    this.cookieStore = new CookieJarStore(this.secrets, this.store.id);
    this.search = new WorkspaceSearch(this.store);
    if (this.settings.lastWorkspace !== this.store.root) this.settings = this.manager.saveSettings({ ...this.settings, lastWorkspace: this.store.root });
    this.logger.info(`Opened workspace ${this.store.workspace.name}`, { migrations: this.store.migrationsApplied });
  }

  jar() {
    if (!this.cookieStore) throw new ApsError('ConfigurationError', 'No workspace is open');
    return this.cookieStore.jar;
  }

  /** A running mock server follows its collection: new or edited examples are served straight away. */
  refreshMock(collectionId: string): void {
    const m = this.mocks.get(collectionId);
    if (!m) return;
    try {
      m.update(this.ws.getCollection(collectionId));
    } catch {
      /* collection deleted: keep the last routes until the server is stopped */
    }
  }

  /** Status of a collection's mock server; when stopped, the routes it would serve. */
  mockInfo(collectionId: string) {
    const m = this.mocks.get(collectionId);
    const view = (routes: MockRoute[]) => routes.map((r) => ({ method: r.method, path: r.path, status: r.example.status, example: r.example.name, request: r.requestName, requestId: r.requestId }));
    if (m) return { running: true, url: m.url, port: m.port, routes: view(m.routes) };
    let routes: MockRoute[] = [];
    try {
      routes = collectMockRoutes(this.ws.getCollection(collectionId));
    } catch {
      /* unknown collection */
    }
    return { running: false, routes: view(routes) };
  }

  /** Console entry for an MCP or WebSocket action (console-log.ts). */
  consoleProtocol(kind: 'mcp' | 'websocket', redactor: Redactor, e: Parameters<typeof consoleProtocol>[3]): void {
    consoleProtocol(this, kind, redactor, e);
  }

  /** Where an MCP server runs, for the console: the URL or the command line, redacted. */
  mcpTarget(cfg: McpServerConfig, redactor: Redactor): string {
    if (cfg.transport === 'mock') return `mock ${cfg.mockFile}`;
    return cfg.transport === 'stdio' ? redactor.redactString([cfg.command, ...(cfg.args ?? [])].join(' ')) : redactor.redactUrl(cfg.url);
  }

  mcpRedactor(serverId: string): Redactor {
    return this.mcpRedactors.get(serverId) ?? this.logger.redactor;
  }

  /** Run an MCP read or prompt request and log it to the console. */
  async mcpLogged<T>(serverId: string, method: string, what: string, request: unknown, fn: () => Promise<T>): Promise<T> {
    const name = this.session(serverId).config.name;
    const redactor = this.mcpRedactor(serverId);
    const started = Date.now();
    try {
      const r = await fn();
      this.consoleProtocol('mcp', redactor, { name, method, url: `${name} › ${what}`, status: 'ok', durationMs: Date.now() - started, request, response: r });
      return r;
    } catch (e) {
      const err = normalizeError(e);
      this.consoleProtocol('mcp', redactor, { name, method, url: `${name} › ${what}`, status: err.kind, durationMs: Date.now() - started, request, error: err.message });
      throw e;
    }
  }

  /** Write to the application log (Logs panel and logs/app.log), e.g. from the Electron process. */
  appLog(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
    this.logger[level](message, data);
  }

  /**
   * Save a file for the user: with a native save dialog (desktop) the file is written where they
   * choose; without one (browser bridge, cloud) the content is returned for the UI to download.
   * Resolves to `{ path }`, `{ download }`, or `{}` when the dialog was cancelled.
   */
  async saveOrDownload(
    name: string,
    filters: Array<{ name: string; extensions: string[] }> | undefined,
    write: (dest: string) => void | Promise<void>,
    read: () => Buffer | Promise<Buffer>,
    opts: { defaultPath?: string; type?: string } = {},
  ): Promise<{ path?: string; download?: { name: string; content: string; encoding: 'base64'; type: string } }> {
    if (this.host.saveDialog) {
      const dest = await this.host.saveDialog({ defaultPath: opts.defaultPath ?? name, filters });
      if (!dest) return {};
      await write(dest);
      return { path: dest };
    }
    const data = await read();
    if (data.length > 100 * 1024 * 1024) throw new ApsError('ValidationError', 'The file is larger than 100 MB and can only be saved from the desktop app', { suggestions: ['Use the desktop app, or the CLI (testpion … -o <file>), for files this big.'] });
    return { download: { name, content: data.toString('base64'), encoding: 'base64', type: opts.type ?? 'application/octet-stream' } };
  }

  /** A visualization page (for the host's isolated origin), or undefined. */
  visualizationPage(id: string): string | undefined {
    return this.vizPages.page(id);
  }

  /** Security policy of visualization pages (viz-pages.ts). */
  static readonly VIZ_CSP = VizPages.CSP;

  consoleEntry(e: ConsoleEntry): void {
    pushConsole(this, e);
  }

  get ws(): WorkspaceStore {
    if (!this.store) throw new ApsError('ConfigurationError', 'No workspace is open');
    return this.store;
  }

  async invoke(method: string, params: unknown): Promise<unknown> {
    // own methods only: "constructor", "toString" … are not RPC methods
    const h = typeof method === 'string' && Object.hasOwn(this.handlers, method) ? this.handlers[method] : undefined;
    if (!h) throw new ApsError('ConfigurationError', `Unknown backend method ${String(method).slice(0, 80)}`);
    const t0 = performance.now();
    // the workspace files this call wrote (any handler, through fsutil): said in its data.changed, like the watcher would
    let written: OwnWriteBatch | undefined;
    const changed = () => {
      if (!written && !DATA_CHANGING.test(method)) return;
      // the Collections explorer (and anything else listing workspace items) refreshes on this
      // (a save names its collection: the window then reads that one, not every collection again)
      const one = method === 'col.save' ? { collectionId: (params as { id?: string } | undefined)?.id } : {};
      this.host.emit('data.changed', { method, ...one, ...(written ?? {}) });
    };
    try {
      params = checkRpcParams(method, params); // "<method>: missing <param>" before anything runs
      await prefetchSecretsFor(this, params); // the environment's secret manager references, before they're needed
      // the proxy settings apply from the first method that may go over the network (start-up's reads don't wait)
      if (!LOCAL_READS.test(method)) await ensureProxyApplied();
      const checked = params;
      const r = await this.ownWrites.run(
        () => guardProduction(this, method, checked, async () => h(checked ?? {})), // WF-06: production needs consent
        (b) => (written = b),
      );
      this.logger.trace(`rpc ${method}`, { ms: Math.round(performance.now() - t0) });
      changed();
      return r;
    } catch (e) {
      if (written) changed(); // what it wrote before it failed is on disk
      const err = normalizeError(e);
      if (err.kind !== 'CancelledError') this.logger.warn(`rpc ${method} failed: ${err.message}`);
      throw err;
    }
  }

  /** The Claude API key saved in Settings ▸ AI assistant (from the secret store), if any. */
  appClaudeKey(): string | undefined {
    return this.secrets.get(APP_CLAUDE_SECRET) || undefined;
  }

  claudeModel(): string {
    return this.settings.assistantProvider === APP_CLAUDE_ID && this.settings.assistantModel ? this.settings.assistantModel : DEFAULT_CLAUDE_MODEL;
  }

  /** Engine services for an environment; `allowProduction` overrides the consent of the call (production-guard.ts). */
  context(opts: { environment?: string; collectionId?: string; allowProduction?: boolean }) {
    const ctx = createEngineContext({
      extraProviders: this.appClaudeKey() ? [appClaudeProvider(this.claudeModel())] : [],
      store: this.ws,
      secrets: this.secrets,
      settings: this.settings,
      environment: opts.environment,
      collectionId: opts.collectionId,
      envAccess: this.settings.envVariables ?? [],
      logger: this.logger,
      openExternal: this.host.openExternal?.bind(this.host),
      cookieJar: this.cookieStore?.jar,
      allowProduction: opts.allowProduction,
      aiSurface: 'app',
    });
    // Postman-style current values: set by scripts, kept on this machine, override stored values
    const cv = this.currentValues;
    if (cv) {
      const envName = ctx.environment?.name;
      cv.apply(ctx.vars, { environment: envName, collectionId: opts.collectionId }, ctx.redactor);
      const secretEnvKeys = new Set(ctx.environment?.variables.filter((v) => v.secret).map((v) => v.key));
      ctx.services.persistVariable = (scope, key, value) => {
        const owner = scope === 'environment' ? envName : scope === 'collectionVariables' ? opts.collectionId : '';
        if (owner === undefined) return; // no environment / collection selected: keep it for this run only
        // a value that is (or holds) a known secret stays secret, whatever its key: tp.environment.set("copy", tp.environment.get("token"))
        const sensitive = ctx.redactor.isSensitiveKey(key) || (scope === 'environment' && secretEnvKeys.has(key)) || (typeof value === 'string' && value.length > 0 && ctx.redactor.redactString(value) !== value);
        void cv.set(scope, owner, key, value, sensitive).catch((e) => this.logger.warn(`Could not save current value ${key}: ${(e as Error).message}`));
      };
    }
    return ctx;
  }

  /** Resolve {{variables}} in a text with an environment (for messages typed in the WebSocket view and similar). */
  async resolveText(text: string, environment?: string): Promise<string> {
    if (!hasTemplate(text)) return text;
    const ctx = this.context({ environment });
    try {
      return ctx.vars.resolve(text);
    } finally {
      await ctx.dispose();
    }
  }

  /** Emit high-frequency events in batches so the renderer is not flooded (spec §22). */
  batched<T>(channel: string, intervalMs = 50) {
    return batcher<T>((items) => this.host.emit(channel, items), intervalMs);
  }

  /**
   * The RPC surface, one module per domain (handlers/*.ts). Every host (Electron IPC, the web bridge, a
   * future cloud server) calls the same methods by name. A name defined twice is a bug, not an override.
   */
  private buildHandlers(): Handlers {
    const all: Handlers = {};
    for (const group of [appHandlers, workspaceHandlers, collectionsHandlers, requestsHandlers, grpcHandlers, mcpHandlers, aiHandlers, aiTaskHandlers, aiTriageHandlers, aiSpecHandlers, aiSecurityHandlers, testingHandlers, monitorHandlers, agentHandlers, feedbackHandlers, gitHandlers, debuggerHandlers, debuggerRulesHandlers, externalSecretsHandlers, fuzzHandlers, flowDebugHandlers, debuggerFlowHandlers, debuggerReverseHandlers, flowDeployHandlers, terminalHandlers, flowScaleHandlers, evalMatrixHandlers, outputHandlers, kindHandlers, importHandlers, bundleHandlers, ragHandlers, ragMetricHandlers, ragR4Handlers, gitItemHandlers, gitSetupHandlers]) {
      for (const [name, fn] of Object.entries(group(this))) {
        if (name in all) throw new Error(`RPC method ${name} is defined twice`);
        // the parameters are checked first; a TypeError from inside becomes an InternalError naming the method
        all[name] = guardHandler(name, fn);
      }
    }
    return all;
  }

  session(serverId: string): McpSession {
    const s = this.mcpSessions.get(serverId);
    if (!s?.connected) throw new ApsError('ConfigurationError', 'MCP server is not connected', { suggestions: ['Click Connect first.'] });
    return s;
  }

  /* ------------------------------------------------------------------ HTTP */

  async httpSend(p: HttpSendParams) {
    return httpSendImpl(this, p);
  }

  /** Code snippet for a request, with variables and auth resolved. Secrets are masked unless revealSecrets. */
  async codeSnippet(p: { request: HttpRequestSpec; environment?: string; collectionId?: string; requestId?: string; language: string; revealSecrets?: boolean }) {
    return codeSnippetImpl(this, p);
  }

  async gqlSend(p: GqlSendParams) {
    return gqlSendImpl(this, p);
  }

  /* ------------------------------------------------------------------ AI */

  async aiChat(p: AiChatParams) {
    return aiChatImpl(this, p);
  }

  /** A reply to an MCP server's sampling request, drafted with the assistant's model. */
  async sampleWithAssistant(params: { systemPrompt?: string; maxTokens?: number; messages: Array<{ role: 'user' | 'assistant'; content: { type: string; text?: string } }> }, environment?: string) {
    const providerRef = this.settings.assistantProvider;
    if (!providerRef) throw new ApsError('ConfigurationError', 'The AI assistant is off', { suggestions: ['Open Settings ▸ AI assistant to choose a model, or write the reply yourself.'] });
    const ctx = this.context({ environment });
    const { provider, model } = ctx.services.providers.resolveModel({ provider: providerRef, name: this.settings.assistantModel });
    const r = await provider.chat({
      model,
      maxTokens: Math.min(params.maxTokens ?? 1000, 4000),
      messages: [
        ...(params.systemPrompt ? [{ role: 'system' as const, content: params.systemPrompt }] : []),
        ...params.messages.map((m) => ({ role: m.role, content: m.content.type === 'text' ? (m.content.text ?? '') : `[${m.content.type}]` })),
      ],
    });
    return { text: r.text, model: `${providerRef}/${model}` };
  }

  /**
   * The AI assistant and every AI action of the window: one task of the core runner (packages/core/src/ai/tasks) with
   * the view's context — routing, redaction, budgets, caps, verification, proposals and the usage ledger live there, so
   * the CLI, the MCP server and a cloud host behave the same. With `requestId` the first answer streams as
   * `assistant.deltas` and `ai.cancel` stops it.
   */
  async assistant(p: AiTaskRequest & { environment?: string; requestId?: string }): Promise<AiTaskResult> {
    return this.withAiDeps(p, (deps) => runAiTask(deps, p));
  }

  /**
   * The AI runner's dependencies for one call from the window: the engine context of its environment, a cancel handle
   * (`ai.cancel` with `requestId`) and streamed text on `assistant.deltas`. Every AI handler (tasks, triage, flaky
   * analysis) goes through it, so the app's Claude provider without its key is said the same way everywhere.
   */
  async withAiDeps<T>(p: { environment?: string; requestId?: string; provider?: string; dryRun?: boolean }, fn: (deps: AiRunDeps) => Promise<T>): Promise<T> {
    // the app's Claude provider without its key: say so (the window offers Settings ▸ AI assistant)
    const uses = [this.settings.assistantProvider, this.settings.ai?.small?.provider, this.settings.ai?.large?.provider];
    if (!p.provider && uses.includes(APP_CLAUDE_ID) && !this.appClaudeKey())
      throw new ApsError('ConfigurationError', 'No Claude API key is saved', { details: { setup: { assistant: true } }, suggestions: ['Open Settings ▸ AI assistant and save your Anthropic API key.'] });
    const ctx = this.context({ environment: p.environment });
    const id = p.requestId ?? shortId('as-');
    const ctrl = new AbortController();
    this.controllers.set(id, ctrl);
    const deltas = this.batched<unknown>('assistant.deltas', 40);
    try {
      const r = await fn(aiRunDeps({ ctx, settings: this.settings, store: this.ws, surface: 'app', signal: ctrl.signal, onDelta: p.requestId && !p.dryRun ? (d) => deltas.push({ id, delta: d }) : undefined }));
      deltas.flush();
      return r;
    } finally {
      this.controllers.delete(id);
      await ctx.dispose();
    }
  }

  /* ------------------------------------------------------------------ runs */

  results(runId: string): AsyncGenerator<TestResult> {
    return runResults(this.ws, runId);
  }

  pageResults(q: { runId: string; offset?: number; limit?: number; status?: string; query?: string }) {
    return pageRunResults(this.ws, q);
  }

  /** Latency histogram, slowest results, results per type and most failed checks of a finished run. */
  runBreakdown(runId: string): Promise<RunBreakdown> {
    return breakdownOfRun(this.ws, runId);
  }

  startRun(
    name: string,
    tests: AsyncIterable<TestCase>,
    opts: { environment?: string; collectionId?: string; concurrency?: number; retries?: number; bail?: boolean; keepVariableValues?: boolean; traceMode?: 'all' | 'failures' | 'none'; origin?: RunOrigin },
    exec: (o: RunOptions) => Promise<RunSummary> = runTests,
  ) {
    const runId = shortId('run-');
    const ctrl = new AbortController();
    this.runs.set(runId, { ctrl, done: false });
    const dir = this.ws.runDir(runId);
    mkdirSync(dir, { recursive: true });
    const store = this.ws;
    const ctx = this.context({ environment: opts.environment, collectionId: opts.collectionId });
    if (opts.keepVariableValues === false) ctx.services.persistVariable = undefined;
    const events = this.batched<RunEvent>('run.events', 100);
    const started = Date.now();
    void (async () => {
      let summary: RunSummary | undefined;
      try {
        summary = await exec({
          name,
          runId,
          tests,
          bail: opts.bail,
          concurrency: opts.concurrency ?? 4,
          retries: opts.retries ?? 0,
          services: ctx.services,
          signal: ctrl.signal,
          resultsFile: join(dir, 'results.jsonl'),
          traceMode: opts.traceMode ?? 'all',
          onTrace: (t) => void store.saveTrace(t, 'test', runId),
          // a run's traces go into the database in one transaction per batch, not one each
          traceBatch: (fn) => store.meta.batch(fn),
          environment: opts.environment,
          // test-end events carry results; forward only compact info — the UI pages full results from disk
          onEvent: (e) => {
            if (e.type === 'test-end') consoleFromResult(this, e.result, { name, runId, collectionId: opts.collectionId }, ctx.redactor);
            if (e.type === 'test-end') events.push({ ...e, result: { ...e.result, output: e.result.output?.slice(0, 500), input: e.result.input?.slice(0, 300), metadata: undefined } });
            else if (e.type !== 'test-start') events.push(e);
          },
        });
        if (opts.origin) summary.origin = opts.origin; // what it ran, to run it again (WF-08)
        await recordRun(store, summary, dir, { reports: ['json', 'junit', 'html', 'markdown'] });
        this.logger.info(`Run ${name} finished`, { runId, total: summary.total, passed: summary.passed, ms: Date.now() - started });
      } catch (e) {
        const err = normalizeError(e);
        this.logger.error(`Run ${name} failed: ${err.message}`);
        this.host.emit('run.error', { runId, error: err });
      } finally {
        events.flush();
        // a finished run is forgotten: kept, its controller held the run's services and scope alive (soak test)
        this.runs.delete(runId);
        await ctx.dispose();
        // the counts let the app say how it went (a desktop notification when it's in the background)
        this.host.emit('run.finished', { runId, name, total: summary?.total, passed: summary?.passed, failed: summary?.failed, errors: summary?.errors, durationMs: Date.now() - started, cancelled: ctrl.signal.aborted });
      }
    })();
    return { runId };
  }

  startTestRun(p: { paths: string[]; environment?: string; concurrency?: number; retries?: number; name?: string; grep?: string; tags?: string[]; ids?: string[] }) {
    const base = this.ws.path('tests');
    const suitePath = p.paths.length === 1 && isSuiteFile(p.paths[0]!) ? join(base, p.paths[0]!) : undefined;
    const store = this.ws;
    const tests = (async function* () {
      if (suitePath) {
        const suite = await loadSuite(suitePath);
        yield* streamTests(suite.tests, dirname(suitePath), { grep: p.grep, tags: p.tags, ids: p.ids });
      } else yield* streamTests(p.paths.length ? p.paths : ['.'], store.path('tests'), { grep: p.grep, tags: p.tags, ids: p.ids });
    })();
    return this.startRun(p.name ?? (p.paths.join(', ') || 'All tests'), tests, { ...p, origin: { kind: 'tests', paths: p.paths.length ? p.paths : ['.'], ...(p.ids?.length ? { ids: p.ids } : {}), grep: p.grep, tags: p.tags } });
  }

  readRunData(path: string, query?: string, environment?: string): Promise<DatasetRecord[]> {
    return readRunData(this, path, query, environment);
  }

  startCollectionRun(p: CollectionRunParams) {
    const collection = this.ws.getCollection(p.collectionId);
    // its gRPC calls and connections run too (after its requests)
    const realtime = collectionRealtimeTests(this.ws, collection, p.selection);
    const count = collectionRequests(collection, p.selection).length + realtime.length;
    if (!count) throw new ApsError('ValidationError', 'Nothing to run: the selection has no requests');
    const folder = p.selection?.length === 1 ? findNodeName(collection.items, p.selection[0]!) : undefined;
    const name = p.name ?? (folder ? `${collection.name} / ${folder}` : collection.name);
    return this.startRun(name, (async function* () {})(), { ...p, concurrency: 1, retries: 0, origin: { kind: 'collection', collectionId: p.collectionId, selection: p.selection, iterations: p.iterations, ...(p.rerun ? { rerun: true } : {}) } }, async (o) =>
      runCollection({
        ...o,
        collection,
        selection: p.selection,
        rerun: p.rerun,
        iterations: p.iterations,
        data: p.dataPath ? await this.readRunData(p.dataPath, p.dataQuery, p.environment) : undefined,
        delayMs: p.delayMs,
        realtime,
      }),
    );
  }

  startEvalRun(p: EvalRunParams) {
    const base = this.ws.path('datasets');
    let dataset: Record<string, unknown>;
    let inline: string | undefined;
    if (p.datasetText !== undefined) {
      // the editor's text is streamed from a temporary file (not in datasets/), removed once the run has read it
      const tmp = this.ws.path('runs', '.inline');
      mkdirSync(tmp, { recursive: true });
      inline = join(tmp, `${shortId('ds-')}.${p.datasetFormat ?? 'jsonl'}`);
      writeFileSync(inline, p.datasetText);
      dataset = { path: inline, format: p.datasetFormat === 'md' ? 'markdown' : p.datasetFormat, limit: p.limit };
    } else dataset = { path: p.datasetPath, limit: p.limit };
    const template = { ...p.template, dataset: { ...dataset, expectedField: p.expectedField ?? 'expected' } };
    const expanded = expandDataset(template, join(base, 'x'));
    const tests = inline
      ? (async function* () {
          try {
            yield* expanded;
          } finally {
            rmSync(inline!, { force: true });
          }
        })()
      : expanded;
    return this.startRun(p.name ?? String(p.template.name ?? 'Evaluation'), tests, { environment: p.environment, concurrency: p.concurrency, retries: p.retries, traceMode: 'all' });
  }

  async startLoad(p: { config: LoadTestConfig; environment?: string; collection?: { collectionId: string; selection?: string[]; warmUp?: boolean }; name?: string; savedId?: string; thresholds?: string[] }) {
    return startLoadImpl(this, p);
  }

  async dispose(): Promise<void> {
    for (const t of this.deferred) clearTimeout(t);
    this.terminals.dispose('quit');
    this.stopWatching?.();
    this.ownWrites.dispose();
    this.monitorScheduler.stop();
    this.gitAutoFetch.stop();
    for (const c of this.controllers.values()) c.abort();
    for (const r of this.runs.values()) r.ctrl.abort();
    for (const s of this.mcpSessions.values()) await s.close();
    for (const s of this.wsSessions.values()) s.close();
    for (const s of this.sioSessions.values()) s.close();
    for (const s of this.mqttSessions.values()) s.close();
    for (const s of this.kafkaSessions.values()) await s.closeAndWait();
    for (const m of this.mocks.values()) await m.close();
    await this.gqlMock?.close();
    await stopFlowWebhooks(this);
    await this.recorder?.close();
    await this.debugger?.proxy?.close();
    await this.debugger?.release?.();
    for (const s of this.gqlSubs.values()) s.stop();
    await this.cookieStore?.flush().catch(() => undefined);
    this.store?.close();
  }
}
