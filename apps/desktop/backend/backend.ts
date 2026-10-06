/**
 * Desktop backend: every capability of the UI is exposed as an RPC method here.
 * It runs in the Electron main process (via IPC) or, for browser-based development,
 * behind a local HTTP bridge. All protocol execution happens in @testpion/core — the same
 * engine the CLI uses — so the UI thread never performs network or test execution.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  ApsError,
  ChainSecretStore,
  EncryptedFileSecretStore,
  EnvSecretStore,
  Logger,
  McpSession,
  MemorySecretStore,
  Redactor,
  Tracer,
  WebSocketSession,
  SocketIoSession,
  reflectServer,
  parseGrpcTarget,
  MqttSession,
  WorkspaceManager,
  WorkspaceSearch,
  WorkspaceStore,
  batcher,
  runResults,
  pageRunResults,
  breakdownOfRun,
  type RunBreakdown,
  isEventStream,
  createEngineContext,
  estimateCost,
  executeHttp,
  executeGraphQL,
  expandDataset,
  fileSink,
  inheritedAuthFor,
  loadSuite,
  normalizeError,
  runChecks,
  runLoadTest,
  buildUrl,
  evaluateThresholds,
  recordLoadRun,
  loadRunRecord,
  type LoadRunRecord,
  type Recorder,
  type GraphQLSubscription,
  collectionLoadTarget,
  runScript,
  scriptScopes,
  applyScriptOutput,
  CurrentValues,
  CookieJarStore,
  responseCookies,
  collectMockRoutes,
  type MockRoute,
  type MockServer,
  applyCookieJarOps,
  folderChain,
  folderVariables,
  scriptRequestSender,
  runTests,
  runCollection,
  collectionRealtimeTests,
  collectionRequests,
  readDataset,
  shortId,
  streamTests,
  prepareHttpRequest,
  type GraphQLMockServer,
  renderVisualizer,
  generateCode,
  type SnippetRequest,
  tryParseJson,
  validateSchema,
  writeReports,
  renderPrompt,
  isSuiteFile,
  DEFAULT_BASE_URLS,
  type AppSettings,
  type CheckConfig,
  type CheckContext,
  type CollectionNode,
  type GraphQLRequestSpec,
  type HttpRequestSpec,
  type LoadTestConfig,
  type LogRecord,
  type McpServerConfig,
  type ResponseFormat,
  type RunEvent,
  type RunOptions,
  type RunSummary,
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
  setTlsTrust,
  APP_CLAUDE_ID,
  APP_CLAUDE_SECRET,
  DEFAULT_CLAUDE_MODEL,
  appClaudeProvider,
  recordCertificate,
  timingSummary,
  timingSpans,
  addTemplateAdditions,
  readJson,
  describeChanges,
  watchWorkspace,
} from '@testpion/core';
import { appHandlers } from './handlers/app.js';
import { workspaceHandlers } from './handlers/workspace.js';
import { collectionsHandlers } from './handlers/collections.js';
import { requestsHandlers } from './handlers/requests.js';
import { mcpHandlers } from './handlers/mcp.js';
import { aiHandlers } from './handlers/ai.js';
import { testingHandlers } from './handlers/testing.js';
import { monitorHandlers, runMonitorNow } from './handlers/monitors.js';
import { grpcHandlers } from './handlers/grpc.js';
import { agentHandlers } from './handlers/agents.js';
import { feedbackHandlers } from './handlers/feedback.js';
import { gitHandlers } from './handlers/git.js';
import { debuggerHandlers, type DebuggerState } from './handlers/debugger.js';
import { assistantInstruction } from './assistant-tasks.js';

/** RPC methods that change what the workspace lists (collections, saved items, environments, monitors, MCP servers). */
const DATA_CHANGING = /^(col\.(save|delete|import\w*|move\w*|duplicate\w*)|lib\.save|env\.(save|delete|reorder|import\w*)|vars\.setInEnvironment|monitor\.(save|delete)|mcp\.(saveServers|connect|disconnect)|trash\.restore|ws\.(open|import\w*|openExamples))$/;

export interface BackendHost {
  appDir: string;
  cipher?: SecretCipher;
  emit(channel: string, payload: unknown): void;
  openExternal?(url: string): void | Promise<void>;
  saveDialog?(opts: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | undefined>;
  openDialog?(opts: { directory?: boolean; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | undefined>;
  openPath?(path: string): void | Promise<unknown>;
  /** The examples workspace shipped with the app (copied into the data folder on first launch). */
  examplesDir?: string;
  /** Don't run monitors on their schedule (tests, one-off tools). */
  noMonitors?: boolean;
  /** How to start this app as an MCP server (`<command> <args> --mcp-server -w …`); without it agents use the CLI. */
  mcpCommand?: { command: string; args: string[] };
}

export type Handler = (params: any) => Promise<unknown> | unknown;
/** A domain's RPC methods by name (see handlers/). */
export type Handlers = Record<string, Handler>;

interface RunState {
  ctrl: AbortController;
  done: boolean;
}

const CONSOLE_MAX = 500;
const CONSOLE_BODY_CHARS = 16_000;

/** One line of the Postman-style console. Values are redacted before they are stored. */
export interface ConsoleEntry {
  id: string;
  time: string;
  source: 'request' | 'run';
  /** Protocol; absent means HTTP. */
  kind?: 'graphql' | 'mcp' | 'websocket';
  run?: string;
  name: string;
  method: string;
  url: string;
  status?: number | string;
  durationMs?: number;
  size?: number;
  request?: { headers: Array<[string, string]>; body?: string };
  response?: { headers: Array<[string, string]>; body?: string };
  logs: Array<{ phase: 'pre-request' | 'test'; message: string }>;
  error?: string;
  failedChecks?: number;
}

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
  /** Running mock servers by collection id. */
  mocks = new Map<string, MockServer>();
  /** Rendered pm.visualizer pages by id (served on an isolated origin: tpviz:// or /__aps/viz/). */
  private vizPages = new Map<string, string>();
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
  readonly handlers: Handlers;

  constructor(host: BackendHost) {
    this.host = host;
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
    if (!host.noMonitors) this.monitorScheduler.start();
  }

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

  /** Examples that shipped with this version go into the user's copy: additions only, never a change (addTemplateAdditions). */
  private updateExamples(): void {
    const dir = this.host.examplesDir;
    if (!dir || !existsSync(join(dir, 'workspace.json'))) return;
    try {
      const id = readJson<{ id: string }>(join(dir, 'workspace.json')).id;
      const mine = this.manager.list().find((w) => w.id === id);
      if (!mine) return;
      const added = addTemplateAdditions(dir, mine.path);
      this.examplesAdded = added;
      if (added.length) this.logger.info(`Added to the examples workspace: ${added.join(', ')}`);
    } catch (e) {
      this.logger.warn(`Could not add the new examples: ${(e as Error).message}`);
    }
  }

  /** Open the last workspace, or create a starter workspace on first launch. */
  private bootstrapWorkspace(): void {
    this.updateExamples();
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

  /** Stops watching the open workspace's folder (GIT-103). */
  private stopWatching?: () => void;
  /** When the app last changed workspace data itself (an RPC that saves): the watcher's events then are its own. */
  /** When TestPion itself last wrote the workspace (its own changes are not news); git operations set it too. */
  lastOwnChange = 0;

  /** Notice changes made outside the app (git pull, a branch switch, another editor) and refresh the UI. */
  private watchStore(root: string): void {
    this.stopWatching?.();
    this.stopWatching = watchWorkspace(
      root,
      (changes) => {
        if (!this.store || this.store.root !== root) return;
        if (changes.some((c) => c.kind === 'workspace')) this.store.reloadWorkspaceFile();
        this.logger.info(describeChanges(changes), { files: changes.map((c) => c.path).slice(0, 50) });
        this.host.emit('data.changed', { method: 'disk' });
        this.host.emit('workspace.changedOnDisk', { message: describeChanges(changes), kinds: [...new Set(changes.map((c) => c.kind))], files: changes.map((c) => c.path).slice(0, 50) });
      },
      { isOwnChange: () => Date.now() - this.lastOwnChange < 1500 },
    );
  }

  openStore(path: string): void {
    this.store?.close();
    for (const s of this.mcpSessions.values()) void s.close();
    this.mcpSessions.clear();
    for (const m of this.mocks.values()) void m.close();
    this.mocks.clear();
    void this.gqlMock?.close();
    this.gqlMock = undefined;
    this.store = WorkspaceStore.open(path);
    this.watchStore(this.store.root);
    this.currentValues = new CurrentValues(join(this.host.appDir, 'current-values', `${this.store.id}.json`), this.secrets, this.store.id);
    void this.cookieStore?.flush().catch(() => undefined);
    this.cookieStore = new CookieJarStore(this.secrets, this.store.id);
    this.search = new WorkspaceSearch(this.store);
    this.settings = this.manager.saveSettings({ ...this.settings, lastWorkspace: this.store.root });
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

  /** Console entry for an MCP or WebSocket action; bodies are redacted and clipped. */
  consoleProtocol(
    kind: 'mcp' | 'websocket',
    redactor: Redactor,
    e: { name: string; method: string; url: string; status?: string; durationMs?: number; request?: unknown; response?: unknown; error?: string; failedChecks?: number; logs?: string[] },
  ): void {
    const body = (v: unknown) => {
      if (v === undefined) return undefined;
      const t = typeof v === 'string' ? redactor.redactString(v) : JSON.stringify(redactor.redact(v), null, 2);
      return t.length > CONSOLE_BODY_CHARS ? `${t.slice(0, CONSOLE_BODY_CHARS)}… [${t.length - CONSOLE_BODY_CHARS} more characters]` : t;
    };
    this.consoleEntry({
      id: shortId('c-'),
      time: new Date().toISOString(),
      source: 'request',
      kind,
      name: e.name,
      method: e.method,
      url: e.url,
      status: e.status,
      durationMs: e.durationMs,
      request: e.request !== undefined ? { headers: [], body: body(e.request) } : undefined,
      response: e.response !== undefined ? { headers: [], body: body(e.response) } : undefined,
      logs: (e.logs ?? []).map((message) => ({ phase: 'test' as const, message: redactor.redactString(message) })),
      error: e.error && redactor.redactString(e.error),
      failedChecks: e.failedChecks,
    });
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
    write: (dest: string) => void,
    read: () => Buffer,
  ): Promise<{ path?: string; download?: { name: string; content: string; encoding: 'base64'; type: string } }> {
    if (this.host.saveDialog) {
      const dest = await this.host.saveDialog({ defaultPath: name, filters });
      if (!dest) return {};
      write(dest);
      return { path: dest };
    }
    const data = read();
    if (data.length > 100 * 1024 * 1024) throw new ApsError('ValidationError', 'The file is larger than 100 MB and can only be saved from the desktop app');
    return { download: { name, content: data.toString('base64'), encoding: 'base64', type: 'application/octet-stream' } };
  }

  /**
   * Keep a rendered visualization for its isolated page: the template's HTML plus `pm.getData()`
   * (Postman's API for visualizer scripts; also `tp.getData()`). Returns a random id that acts as the
   * page's access key.
   */
  private publishVisualization(html: string, data: unknown): string {
    const id = randomBytes(16).toString('hex');
    const json = JSON.stringify(data ?? {}).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const page = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1f2230;margin:16px}table{border-collapse:collapse}th,td{border:1px solid #d9dbe3;padding:4px 10px;text-align:left}th{background:#f3f4f8}</style><script>(function(){var d=${json};var api={getData:function(cb){cb(null,d)}};window.pm=api;window.tp=api;})();</script></head><body>${html}</body></html>`;
    this.vizPages.set(id, page);
    while (this.vizPages.size > 30) this.vizPages.delete(this.vizPages.keys().next().value!);
    return id;
  }

  /** A visualization page (for the host's isolated origin), or undefined. */
  visualizationPage(id: string): string | undefined {
    return /^[0-9a-f]{32}$/.test(id) ? this.vizPages.get(id) : undefined;
  }

  /**
   * Security policy of visualization pages: scripts inline or from well-known CDNs (Chart.js …), no
   * network access (nothing can leave), images and fonts only inline. The page is also sandboxed.
   */
  static readonly VIZ_CSP =
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

  private consoleEntry(e: ConsoleEntry): void {
    this.consoleBuffer.push(e);
    if (this.consoleBuffer.length > CONSOLE_MAX) this.consoleBuffer.splice(0, this.consoleBuffer.length - CONSOLE_MAX);
    this.host.emit('console', e);
  }

  /** Requests made by runs (test runner, Collection Runner) appear in the console too, without bodies. */
  private consoleFromResult(r: TestResult, runName: string, redactor: Redactor): void {
    if (r.type !== 'http' && r.type !== 'graphql') return;
    const m = (r.metadata ?? {}) as {
      url?: string;
      method?: string;
      size?: number;
      preRequestLogs?: string[];
      scriptLogs?: string[];
      sentRequests?: Array<{ method: string; url: string; status?: number; error?: string; durationMs?: number }>;
    };
    const status = r.checks.find((c) => c.type === 'status')?.actual;
    this.consoleEntry({
      id: r.id,
      time: new Date().toISOString(),
      source: 'run',
      run: runName,
      name: r.name,
      method: m.method ?? (r.type === 'graphql' ? 'POST' : 'GET'),
      url: m.url ?? r.input ?? '',
      status: typeof status === 'number' ? status : r.error ? r.error.kind : r.status,
      durationMs: r.latencyMs,
      size: m.size,
      logs: [
        ...(m.preRequestLogs ?? []).map((message) => ({ phase: 'pre-request' as const, message: redactor.redactString(message) })),
        ...(m.scriptLogs ?? []).map((message) => ({ phase: 'test' as const, message: redactor.redactString(message) })),
        ...(m.sentRequests ?? []).map((s) => ({ phase: 'test' as const, message: `pm.sendRequest ${s.method} ${s.url} → ${s.error ? `error: ${s.error}` : `${s.status} (${s.durationMs} ms)`}` })),
      ],
      error: r.error?.message,
      failedChecks: r.checks.filter((c) => !c.passed).length,
    });
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
    try {
      const own = DATA_CHANGING.test(method);
      if (own) this.lastOwnChange = Date.now();
      const r = await h(params ?? {});
      if (own) this.lastOwnChange = Date.now();
      this.logger.trace(`rpc ${method}`, { ms: Math.round(performance.now() - t0) });
      // the Collections explorer (and anything else listing workspace items) refreshes on this
      if (DATA_CHANGING.test(method)) this.host.emit('data.changed', { method });
      return r;
    } catch (e) {
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

  context(opts: { environment?: string; collectionId?: string }) {
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
        const sensitive = ctx.redactor.isSensitiveKey(key) || (scope === 'environment' && secretEnvKeys.has(key));
        void cv.set(scope, owner, key, value, sensitive).catch((e) => this.logger.warn(`Could not save current value ${key}: ${(e as Error).message}`));
      };
    }
    return ctx;
  }

  /** Resolve {{variables}} in a text with an environment (for messages typed in the WebSocket view and similar). */
  async resolveText(text: string, environment?: string): Promise<string> {
    if (!text.includes('{{')) return text;
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
    for (const group of [appHandlers, workspaceHandlers, collectionsHandlers, requestsHandlers, grpcHandlers, mcpHandlers, aiHandlers, testingHandlers, monitorHandlers, agentHandlers, feedbackHandlers, gitHandlers, debuggerHandlers]) {
      for (const [name, fn] of Object.entries(group(this))) {
        if (name in all) throw new Error(`RPC method ${name} is defined twice`);
        all[name] = fn;
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
    const id = p.id ?? shortId('req-');
    const ctrl = new AbortController();
    this.controllers.set(id, ctrl);
    const ctx = this.context({ environment: p.environment, collectionId: p.collectionId });
    const tracer = new Tracer(p.name ?? `${p.request.method} ${p.request.url}`, ctx.redactor);
    const root = tracer.start(p.name ?? 'request', 'http');
    const chunks = this.batched<unknown>('http.chunks', 80);
    const sseEvents = this.batched<unknown>('http.sse', 100);
    let scriptLogs: string[] = [];
    let preLogCount: number | undefined;
    const scriptSender = scriptRequestSender({ redactor: ctx.redactor, cookieJar: ctx.services.cookieJar, signal: ctrl.signal, timeoutMs: this.settings.defaultTimeoutMs });
    const sentLogs = (o: { sentRequests?: Array<{ method: string; url: string; status?: number; error?: string; durationMs?: number }> }) =>
      (o.sentRequests ?? []).map((r) => `pm.sendRequest ${r.method} ${ctx.redactor.redactUrl(r.url)} → ${r.error ? `error: ${r.error}` : `${r.status} (${r.durationMs} ms)`}`);
    const logsOf = () => scriptLogs.map((message, i) => ({ phase: i < (preLogCount ?? scriptLogs.length) ? ('pre-request' as const) : ('test' as const), message: ctx.redactor.redactString(message) }));
    try {
      let request = p.request;
      if ((!request.auth || request.auth.type === 'inherit') && ctx.collection)
        request = { ...request, auth: p.requestId ? inheritedAuthFor(ctx.collection, p.requestId) : ctx.collection.auth };
      // collection-level, folder-level (outer to inner), then request-level pre-request scripts
      const folders = ctx.collection && p.requestId ? folderChain(ctx.collection, p.requestId) : [];
      const fv = folderVariables(folders);
      if (Object.keys(fv).length) ctx.vars.setScope('request', fv);
      for (const script of [ctx.collection?.preRequestScript, ...folders.map((f) => f.preRequestScript), p.preRequestScript]) {
        if (!script?.trim()) continue;
        const bodyText = request.body && 'content' in request.body ? request.body.content : undefined;
        const out = await runScript(script, {
          ...scriptScopes(ctx.vars),
          request: { method: request.method, url: request.url, headers: request.headers ?? [], body: bodyText },
          jar: ctx.services.cookieJar?.list(),
          info: { requestName: p.name, requestId: p.requestId, environmentName: ctx.environment?.name },
        }, { sendRequest: scriptSender, requirePackage: (n) => this.ws.readScriptPackage(n) });
        scriptLogs.push(...out.logs, ...sentLogs(out));
        applyScriptOutput(out, [ctx.vars], { redactor: ctx.redactor, persist: ctx.services.persistVariable });
        if (ctx.services.cookieJar) applyCookieJarOps(ctx.services.cookieJar, out.jarOps);
        if (out.error) throw new ApsError('ScriptError', `Pre-request script failed: ${out.error}`);
        if (out.request) {
          request = { ...request, method: out.request.method, url: out.request.url, headers: out.request.headers };
          if (out.request.body !== undefined && request.body && 'content' in request.body) request = { ...request, body: { ...request.body, content: out.request.body } };
        }
      }
      preLogCount = scriptLogs.length;
      const spec = ctx.vars.resolveDeep(request);
      spec.settings = { timeoutMs: this.settings.defaultTimeoutMs, ...spec.settings };
      const timeout = setTimeout(() => ctrl.abort(new ApsError('TimeoutError', `Request timed out after ${spec.settings!.timeoutMs} ms`)), spec.settings.timeoutMs);
      let result;
      const sentAt = Date.now();
      try {
        result = await executeHttp(spec, {
          signal: ctrl.signal,
          payloadDir: this.ws.path('payloads'),
          maxPreviewBytes: this.settings.maxPreviewBytes,
          redactor: ctx.redactor,
          openExternal: this.host.openExternal?.bind(this.host),
          cookieJar: ctx.services.cookieJar,
          onChunk: /event-stream|stream/i.test(JSON.stringify(spec.headers ?? '')) || p.stream ? (c) => chunks.push({ id, chunk: c }) : undefined,
          // an event stream may stay open for as long as the user wants: the timeout covers only its start
          onResponseStart: (_status, headers) => {
            if (isEventStream(headers.get('content-type'))) clearTimeout(timeout);
          },
          onSseEvent: (event) => sseEvents.push({ id, event: { ...event, data: ctx.redactor.redactString(event.data) } }),
        });
      } finally {
        clearTimeout(timeout);
        chunks.flush();
        sseEvents.flush();
      }
      const { response, prepared } = result;
      root.setAttributes({ status: response.status, url: prepared.url, size: response.size });
      // DNS, TCP, TLS, waiting and download as child spans (the Traces waterfall, OTLP export)
      timingSpans(root, response.timeline, sentAt);
      root.span.input = { method: prepared.method, headers: prepared.headers, body: prepared.bodyPreview };
      // the body is kept (redacted, up to 48 KB) for the trace's Payload tab; the full body is in the payload file
      const tracedBody = response.bodyPreview.length > 48_000 ? `${response.bodyPreview.slice(0, 48_000)}…` : response.bodyPreview;
      root.end({ status: response.status >= 400 ? 'error' : 'ok', output: { status: response.status, headers: response.headers, body: tracedBody } });

      const cctx: CheckContext = {
        testType: 'http',
        status: response.status,
        headers: response.headers,
        body: response.json ?? response.bodyPreview,
        text: response.bodyPreview,
        latencyMs: response.durationMs,
        request: { method: prepared.method, url: prepared.url },
        readFile: ctx.services.readFile,
      };
      const checks = await runChecks(ctx.vars.resolveDeep(p.assertions ?? []), cctx);
      // pm.visualizer.set in any test script (collection, folders, request); the last call wins
      let visual: { template: string; data: unknown } | null | undefined;
      for (const script of [ctx.collection?.testScript, ...folders.map((f) => f.testScript), p.testScript]) {
        if (!script?.trim()) continue;
        const out = await runScript(script, {
          ...scriptScopes(ctx.vars),
          request: { method: spec.method, url: spec.url, headers: spec.headers ?? [] },
          response: { status: response.status, headers: response.headers, body: response.bodyPreview, time: response.durationMs },
          cookies: responseCookies(response.cookies, ctx.services.cookieJar, response.url),
          jar: ctx.services.cookieJar?.list(),
          info: { requestName: p.name, requestId: p.requestId, environmentName: ctx.environment?.name },
        }, { sendRequest: scriptSender, requirePackage: (n) => this.ws.readScriptPackage(n) });
        scriptLogs.push(...out.logs, ...sentLogs(out));
        if (out.visualizer !== undefined) visual = out.visualizer;
        applyScriptOutput(out, [ctx.vars], { redactor: ctx.redactor, persist: ctx.services.persistVariable });
        if (ctx.services.cookieJar) applyCookieJarOps(ctx.services.cookieJar, out.jarOps);
        for (const t of out.tests) checks.push({ type: 'script', name: t.name, passed: t.passed, source: 'deterministic', message: t.message ?? (t.passed ? 'passed' : 'failed') });
        if (out.error) checks.push({ type: 'script', name: 'test script', passed: false, source: 'deterministic', message: out.error });
      }
      const trace = tracer.finish();
      this.ws.saveTrace(trace, 'http');
      const historyId = shortId('h-');
      this.ws.meta.addHistory({
        id: historyId,
        timestamp: new Date().toISOString(),
        kind: 'http',
        name: p.name ?? `${prepared.method} ${prepared.url}`,
        method: prepared.method,
        url: prepared.url,
        status: response.status,
        durationMs: response.durationMs,
        size: response.size,
        request: ctx.redactor.redact(p.request),
        payloadPath: response.payloadPath,
        traceId: trace.traceId,
        collectionId: p.collectionId,
        requestId: p.requestId,
        responseMeta: { headers: ctx.redactor.redact(response.headers), contentType: response.contentType, truncated: response.truncated, timing: timingSummary(response), ...(checks.length ? { checksOk: checks.every((c) => c.passed) } : {}) },
      });
      recordCertificate(this.ws, prepared.url, response.connection?.certificate);
      const clip = (t: string | undefined) => (t && t.length > CONSOLE_BODY_CHARS ? t.slice(0, CONSOLE_BODY_CHARS) + `… [${t.length - CONSOLE_BODY_CHARS} more characters]` : t);
      // values typed into sensitive headers are secrets too (e.g. echoed back in a response body)
      for (const h of spec.headers ?? [])
        if (h.enabled !== false && ctx.redactor.isSensitiveKey(h.key) && h.value.length >= 6) {
          ctx.redactor.addSecret(h.value);
          const token = h.value.replace(/^\w+\s+/, '');
          if (token !== h.value && token.length >= 6) ctx.redactor.addSecret(token);
        }
      // so are sensitive fields of the request body (servers often echo them back)
      const collect = (v: unknown, key = '', depth = 0): void => {
        if (depth > 20 || v == null) return;
        if (typeof v === 'string') {
          if (key && ctx.redactor.isSensitiveKey(key) && v.length >= 4) ctx.redactor.addSecret(v);
        } else if (Array.isArray(v)) v.forEach((x) => collect(x, key, depth + 1));
        else if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) collect(x, k, depth + 1);
      };
      if (spec.body && 'content' in spec.body)
        try {
          collect(JSON.parse(spec.body.content));
        } catch {
          /* not JSON */
        }
      else if (spec.body && 'fields' in spec.body) for (const f of spec.body.fields) collect(f.value, f.key);
      const safeBody = (t: string | undefined) => {
        if (!t) return t;
        try {
          return JSON.stringify(ctx.redactor.redact(JSON.parse(t)), null, 2);
        } catch {
          return ctx.redactor.redactString(t);
        }
      };
      this.consoleEntry({
        id,
        time: new Date().toISOString(),
        source: 'request',
        name: p.name ?? `${prepared.method} ${prepared.url}`,
        method: prepared.method,
        url: prepared.url,
        status: response.status,
        durationMs: response.durationMs,
        size: response.size,
        request: { headers: prepared.headers, body: clip(safeBody(prepared.bodyPreview)) },
        response: { headers: ctx.redactor.redact(response.headers), body: clip(safeBody(response.bodyPreview)) },
        logs: logsOf(),
        failedChecks: checks.filter((c) => !c.passed).length,
      });
      const rendered = visual ? renderVisualizer(visual.template, visual.data) : undefined;
      // scripts (charts) run only on the isolated visualization origin; the id is its access key
      const visualizer = rendered && { ...rendered, vizId: rendered.html !== undefined ? this.publishVisualization(rendered.html, visual!.data) : undefined };
      return { id, response, prepared, checks, scriptLogs, visualizer, unresolved: [...ctx.vars.unresolved], blockedEnv: [...ctx.vars.blockedEnv], traceId: trace.traceId, historyId };
    } catch (e) {
      const err = normalizeError(ctrl.signal.reason instanceof ApsError ? ctrl.signal.reason : e);
      root.fail(e);
      const trace = tracer.finish('error');
      this.ws.saveTrace(trace, 'http');
      this.ws.meta.addHistory({ id: shortId('h-'), timestamp: new Date().toISOString(), kind: 'http', name: p.name ?? `${p.request.method} ${p.request.url}`, method: p.request.method, url: ctx.redactor.redactUrl(ctx.vars.resolve(p.request.url)), status: err.kind, request: ctx.redactor.redact(p.request), traceId: trace.traceId });
      this.consoleEntry({
        id,
        time: new Date().toISOString(),
        source: 'request',
        name: p.name ?? `${p.request.method} ${p.request.url}`,
        method: p.request.method,
        url: ctx.redactor.redactUrl(ctx.vars.resolve(p.request.url)),
        status: err.kind,
        logs: logsOf(),
        error: err.message,
      });
      return { id, error: err, scriptLogs, unresolved: [...ctx.vars.unresolved], blockedEnv: [...ctx.vars.blockedEnv], traceId: trace.traceId };
    } finally {
      this.controllers.delete(id);
    }
  }

  /** Code snippet for a request, with variables and auth resolved. Secrets are masked unless revealSecrets. */
  async codeSnippet(p: { request: HttpRequestSpec; environment?: string; collectionId?: string; requestId?: string; language: string; revealSecrets?: boolean }) {
    const ctx = this.context({ environment: p.environment, collectionId: p.collectionId });
    let request = p.request;
    if ((!request.auth || request.auth.type === 'inherit') && ctx.collection)
      request = { ...request, auth: p.requestId ? inheritedAuthFor(ctx.collection, p.requestId) : ctx.collection.auth };
    const spec = ctx.vars.resolveDeep(request);
    // OAuth would trigger a token request just to show code; show a placeholder header instead
    const auth = spec.auth?.type === 'oauth2' ? undefined : spec.auth;
    const prepared = await prepareHttpRequest({ ...spec, auth }, { redactor: ctx.redactor });
    const headers = [...prepared.headers.entries()].filter(([k]) => k !== 'user-agent') as Array<[string, string]>;
    if (spec.auth?.type === 'oauth2') headers.push(['Authorization', 'Bearer <access token from OAuth 2.0>']);
    // Digest is answered after the server's 401 challenge; AWS signatures below are valid for about 15 minutes
    if (spec.auth?.type === 'digest') headers.push(['Authorization', 'Digest <answer to the server challenge>']);
    const body = spec.body;
    const snippet: SnippetRequest = {
      method: prepared.method,
      url: prepared.url.toString(),
      headers,
      body: body && body.type !== 'multipart' && body.type !== 'binary' && body.type !== 'none' ? prepared.bodyPreview : body?.type === 'binary' ? `@${body.filePath}` : undefined,
      form: body?.type === 'multipart' ? body.fields.filter((f) => f.enabled !== false && f.key).map((f) => ({ key: f.key, value: f.value, file: f.kind === 'file' })) : undefined,
    };
    // "url": the resolved URL only (Copy URL); otherwise code in the chosen language
    const code = p.language === 'url' ? snippet.url : generateCode(snippet, p.language);
    if (p.revealSecrets) return code;
    // mask secret values and sensitive headers
    let masked = ctx.redactor.redactString(code);
    for (const [k, v] of headers) if (ctx.redactor.isSensitiveKey(k) && v.length >= 4) masked = masked.split(v).join('<secret>');
    return masked.split('[REDACTED]').join('<secret>');
  }

  async gqlSend(p: GqlSendParams) {
    const id = p.id ?? shortId('gql-');
    const ctrl = new AbortController();
    this.controllers.set(id, ctrl);
    const ctx = this.context({ environment: p.environment, collectionId: p.collectionId });
    const tracer = new Tracer(p.operationName ?? 'GraphQL', ctx.redactor);
    const span = tracer.start('graphql', 'graphql', { input: { query: p.request.query, variables: p.request.variables } });
    const scriptSender = scriptRequestSender({ redactor: ctx.redactor, cookieJar: ctx.services.cookieJar, signal: ctrl.signal, timeoutMs: this.settings.defaultTimeoutMs });
    const scriptLogs: Array<{ phase: 'pre-request' | 'test'; message: string }> = [];
    const folders = ctx.collection && p.requestId ? folderChain(ctx.collection, p.requestId) : [];
    const info = { requestName: p.name ?? p.operationName, requestId: p.requestId, environmentName: ctx.environment?.name };
    try {
      // collection, folder (outer to inner) and request pre-request scripts, as for REST requests
      let request = p.request;
      const fv = folderVariables(folders);
      if (Object.keys(fv).length) ctx.vars.setScope('request', fv);
      for (const script of [ctx.collection?.preRequestScript, ...folders.map((f) => f.preRequestScript), p.preRequestScript]) {
        if (!script?.trim()) continue;
        const out = await runScript(script, {
          ...scriptScopes(ctx.vars),
          request: { method: 'POST', url: request.endpoint, headers: request.headers ?? [], body: JSON.stringify({ query: request.query, variables: request.variables }) },
          jar: ctx.services.cookieJar?.list(),
          info,
        }, { sendRequest: scriptSender, requirePackage: (n) => this.ws.readScriptPackage(n) });
        scriptLogs.push(...out.logs.map((message) => ({ phase: 'pre-request' as const, message: ctx.redactor.redactString(message) })));
        applyScriptOutput(out, [ctx.vars], { redactor: ctx.redactor, persist: ctx.services.persistVariable });
        if (ctx.services.cookieJar) applyCookieJarOps(ctx.services.cookieJar, out.jarOps);
        if (out.error) throw new ApsError('ScriptError', `Pre-request script failed: ${out.error}`);
        if (out.request) request = { ...request, endpoint: out.request.url, headers: out.request.headers };
      }
      const spec = ctx.vars.resolveDeep(request);
      const sentAt = Date.now();
      const r = await executeGraphQL(spec, { signal: ctrl.signal, redactor: ctx.redactor, maxPreviewBytes: this.settings.maxPreviewBytes, payloadDir: this.ws.path('payloads'), cookieJar: ctx.services.cookieJar });
      timingSpans(span, r.response.timeline, sentAt);
      span.end({ status: r.errors?.length ? 'error' : 'ok', output: r.response.json });
      const checks = await runChecks(ctx.vars.resolveDeep(p.assertions ?? []), {
        testType: 'graphql',
        status: r.response.status,
        headers: r.response.headers,
        body: r.response.json ?? r.response.bodyPreview,
        text: r.response.bodyPreview,
        latencyMs: r.response.durationMs,
        graphqlErrors: r.errors,
      });
      for (const script of [ctx.collection?.testScript, ...folders.map((f) => f.testScript), p.testScript]) {
        if (!script?.trim()) continue;
        const out = await runScript(script, {
          ...scriptScopes(ctx.vars),
          request: { method: 'POST', url: r.prepared.url, headers: spec.headers ?? [] },
          response: { status: r.response.status, headers: r.response.headers, body: r.response.bodyPreview, time: r.response.durationMs },
          jar: ctx.services.cookieJar?.list(),
          info,
        }, { sendRequest: scriptSender, requirePackage: (n) => this.ws.readScriptPackage(n) });
        scriptLogs.push(...out.logs.map((message) => ({ phase: 'test' as const, message: ctx.redactor.redactString(message) })));
        applyScriptOutput(out, [ctx.vars], { redactor: ctx.redactor, persist: ctx.services.persistVariable });
        if (ctx.services.cookieJar) applyCookieJarOps(ctx.services.cookieJar, out.jarOps);
        for (const t of out.tests) checks.push({ type: 'script', name: t.name, passed: t.passed, source: 'deterministic', message: t.message ?? (t.passed ? 'passed' : 'failed') });
        if (out.error) checks.push({ type: 'script', name: 'test script', passed: false, source: 'deterministic', message: out.error });
      }
      const trace = tracer.finish();
      this.ws.saveTrace(trace, 'graphql');
      recordCertificate(this.ws, r.prepared.url, r.response.connection?.certificate);
      this.ws.meta.addHistory({ id: shortId('h-'), timestamp: new Date().toISOString(), kind: 'graphql', name: p.name ?? p.operationName ?? 'GraphQL query', method: 'POST', url: r.prepared.url, status: r.response.status, durationMs: r.response.durationMs, size: r.response.size, request: ctx.redactor.redact(p.request), responseMeta: { timing: timingSummary(r.response), ...(checks.length ? { checksOk: checks.every((c) => c.passed) } : {}) }, traceId: trace.traceId, collectionId: p.collectionId, requestId: p.requestId });
      const clip = (t: string) => (t.length > CONSOLE_BODY_CHARS ? `${t.slice(0, CONSOLE_BODY_CHARS)}… [${t.length - CONSOLE_BODY_CHARS} more characters]` : t);
      this.consoleEntry({
        id,
        time: new Date().toISOString(),
        source: 'request',
        kind: 'graphql',
        name: p.operationName ?? 'GraphQL query',
        method: 'POST',
        url: r.prepared.url,
        status: r.response.status,
        durationMs: r.response.durationMs,
        size: r.response.size,
        request: { headers: r.prepared.headers, body: clip(JSON.stringify(ctx.redactor.redact({ query: spec.query, variables: spec.variables, operationName: spec.operationName }), null, 2)) },
        response: { headers: ctx.redactor.redact(r.response.headers), body: clip(r.response.json !== undefined ? JSON.stringify(ctx.redactor.redact(r.response.json), null, 2) : ctx.redactor.redactString(r.response.bodyPreview)) },
        logs: scriptLogs,
        failedChecks: checks.filter((c) => !c.passed).length + (r.errors?.length ? 1 : 0),
      });
      return { id, ...r, checks, traceId: trace.traceId, scriptLogs };
    } catch (e) {
      span.fail(e);
      this.ws.saveTrace(tracer.finish('error'), 'graphql');
      const err = normalizeError(e);
      this.consoleEntry({ id, time: new Date().toISOString(), source: 'request', kind: 'graphql', name: p.operationName ?? 'GraphQL query', method: 'POST', url: ctx.redactor.redactUrl(ctx.vars.resolve(p.request.endpoint)), status: err.kind, logs: scriptLogs, error: err.message });
      return { id, error: err, scriptLogs };
    } finally {
      this.controllers.delete(id);
    }
  }

  /* ------------------------------------------------------------------ AI */

  async aiChat(p: AiChatParams) {
    const id = p.requestId ?? shortId('ai-');
    const ctrl = new AbortController();
    this.controllers.set(id, ctrl);
    const ctx = this.context({ environment: p.environment });
    const tracer = new Tracer(`AI ${p.model}`, ctx.redactor);
    const deltas = this.batched<unknown>('ai.deltas', 40);
    try {
      const { provider, model } = ctx.services.providers.resolveModel({ provider: p.provider, name: p.model || undefined });
      const input = p.input ?? {};
      const prompt = renderPrompt(p.prompt, ctx.vars, input);
      const system = p.system ? renderPrompt(p.system, ctx.vars, input) : undefined;
      const messages = [...(system ? [{ role: 'system' as const, content: system }] : []), { role: 'user' as const, content: prompt }];
      const span = tracer.start(`llm ${model}`, 'llm', { attributes: { provider: provider.config.name, model, temperature: p.temperature, topP: p.topP, maxTokens: p.maxTokens }, input: messages });
      const r = await provider.chat({
        model,
        messages,
        temperature: p.temperature,
        topP: p.topP,
        maxTokens: p.maxTokens,
        seed: p.seed,
        responseFormat: p.responseFormat,
        stream: p.stream !== false,
        signal: ctrl.signal,
        onDelta: (d) => deltas.push({ id, delta: d }),
      });
      deltas.flush();
      const cost = estimateCost(this.settings.pricing, provider.config, r.model || model, r.usage);
      span.setAttributes({ inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, ttftMs: r.timing.firstTokenMs, costUsd: cost.cost });
      span.end({ output: r.text });
      const parsed = tryParseJson(r.text);
      const schemaCheck = p.responseFormat?.schema ? validateSchema(p.responseFormat.schema, parsed.ok ? parsed.value : undefined) : undefined;
      const checks = p.evaluators?.length
        ? await runChecks(ctx.vars.resolveDeep(p.evaluators), {
            testType: 'llm',
            body: parsed.ok ? parsed.value : r.text,
            text: r.text,
            latencyMs: r.timing.totalMs,
            tokens: r.usage,
            costUsd: cost.cost,
            input,
            expected: p.expected,
            services: { providers: ctx.services.providers },
          })
        : [];
      const trace = tracer.finish();
      this.ws.saveTrace(trace, 'llm');
      this.ws.meta.addHistory({ id: shortId('h-'), timestamp: new Date().toISOString(), kind: 'llm', name: `${provider.config.name} · ${r.model || model}`, status: 'ok', durationMs: r.timing.totalMs, request: { provider: p.provider, model, prompt: p.prompt, system: p.system, input }, responseMeta: { usage: r.usage, costUsd: cost.cost, firstTokenMs: r.timing.firstTokenMs }, traceId: trace.traceId });
      return {
        id,
        provider: provider.config.name,
        model: r.model || model,
        text: r.text,
        json: parsed.ok ? parsed.value : undefined,
        isJson: parsed.ok,
        schemaValid: schemaCheck?.valid,
        schemaErrors: schemaCheck?.errors,
        toolCalls: r.toolCalls,
        usage: r.usage,
        usageEstimated: r.usageEstimated,
        costUsd: cost.cost,
        priceVersion: cost.priceVersion,
        timing: r.timing,
        finishReason: r.finishReason,
        checks,
        renderedPrompt: prompt,
        traceId: trace.traceId,
      };
    } finally {
      this.controllers.delete(id);
    }
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
   * The AI assistant: one task (explain an error, suggest checks, …) or a free question, with the context of the view.
   * `history` holds the earlier turns of the conversation, so a follow-up knows what was said; with `requestId` the
   * answer streams as `assistant.deltas` events and `ai.cancel` stops it.
   */
  async assistant(p: { task: string; context: unknown; question?: string; environment?: string; history?: Array<{ role: 'user' | 'assistant'; content: string }>; requestId?: string }) {
    const providerRef = this.settings.assistantProvider;
    if (!providerRef)
      throw new ApsError('ConfigurationError', 'The AI assistant is off', { suggestions: ['Open Settings ▸ AI assistant and save your Claude (Anthropic) API key, or choose a provider of this workspace (a local model works offline).'] });
    if (providerRef === APP_CLAUDE_ID && !this.appClaudeKey())
      throw new ApsError('ConfigurationError', 'No Claude API key is saved', { suggestions: ['Open Settings ▸ AI assistant and save your Anthropic API key.'] });
    const ctx = this.context({ environment: p.environment });
    const { provider, model } = ctx.services.providers.resolveModel({ provider: providerRef, name: this.settings.assistantModel });
    // what each task asks for (assistant-tasks.ts)
    // request generation may use the names (never the values) of the variables in scope
    const extra = p.task === 'generate-request' ? { variables: Object.keys(ctx.vars.toObject()).filter((k) => !k.startsWith('$')).slice(0, 200) } : {};
    const context = JSON.stringify(ctx.redactor.redact({ ...(p.context as object), ...extra }), null, 2).slice(0, 24_000);
    const hasContext = !!p.context && typeof p.context === 'object' && Object.keys(p.context as object).length > 0;
    // the conversation so far: the first turn carries the context, follow-ups only the question (the context stays in the first turn)
    const history = (p.history ?? []).slice(-12).map((m) => ({ role: m.role, content: ctx.redactor.redactString(m.content).slice(0, 8000) }));
    const first = history.length === 0;
    const turn = first ? `${p.question ? `Question: ${p.question}\n\n` : ''}${hasContext || !p.question ? `Context:\n${context}` : ''}`.trim() : (p.question ?? '');
    if (!first) history[0] = { role: 'user', content: `${history[0]!.content}\n\nContext:\n${context}` };
    const id = p.requestId ?? shortId('as-');
    const ctrl = new AbortController();
    this.controllers.set(id, ctrl);
    const deltas = this.batched<unknown>('assistant.deltas', 40);
    try {
      const r = await provider.chat({
        model,
        temperature: 0.2,
        maxTokens: 2000,
        signal: ctrl.signal,
        stream: !!p.requestId,
        onDelta: p.requestId ? (d) => deltas.push({ id, delta: d }) : undefined,
        messages: [
          {
            role: 'system',
            content: `You are the AI assistant inside TestPion, a developer tool for testing REST, GraphQL, MCP and LLM systems. ${assistantInstruction(p.task)} Format answers in Markdown (short headings, lists, fenced code blocks with a language). Values shown as *** were hidden by TestPion; never ask for them.${first ? '' : ' This is a follow-up in the conversation: answer the question itself, in prose with code blocks where useful (the output-only rule above applied to the first answer); when you change code you gave before, give the whole new version in one code block.'}`,
          },
          ...history,
          { role: 'user', content: turn },
        ],
      });
      deltas.flush();
      return { text: r.text, provider: provider.config.name, model: r.model || model, aiGenerated: true, usage: r.usage };
    } finally {
      this.controllers.delete(id);
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
    opts: { environment?: string; collectionId?: string; concurrency?: number; retries?: number; bail?: boolean; keepVariableValues?: boolean; traceMode?: 'all' | 'failures' | 'none' },
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
          environment: opts.environment,
          // test-end events carry results; forward only compact info — the UI pages full results from disk
          onEvent: (e) => {
            if (e.type === 'test-end') this.consoleFromResult(e.result, name, ctx.redactor);
            if (e.type === 'test-end') events.push({ ...e, result: { ...e.result, output: e.result.output?.slice(0, 500), input: e.result.input?.slice(0, 300), metadata: undefined } });
            else if (e.type !== 'test-start') events.push(e);
          },
        });
        writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
        await writeReports(dir, summary, () => this.results(runId));
        store.meta.addRun(summary, dir);
        this.logger.info(`Run ${name} finished`, { runId, total: summary.total, passed: summary.passed, ms: Date.now() - started });
      } catch (e) {
        const err = normalizeError(e);
        this.logger.error(`Run ${name} failed: ${err.message}`);
        this.host.emit('run.error', { runId, error: err });
      } finally {
        events.flush();
        this.runs.get(runId)!.done = true;
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
    return this.startRun(p.name ?? (p.paths.join(', ') || 'All tests'), tests, p);
  }

  async readRunData(path: string, query?: string): Promise<DatasetRecord[]> {
    const rows: DatasetRecord[] = [];
    for await (const r of readDataset({ path, query, limit: 100_000 })) rows.push(r);
    return rows;
  }

  startCollectionRun(p: CollectionRunParams) {
    const collection = this.ws.getCollection(p.collectionId);
    // its gRPC calls and connections run too (after its requests)
    const realtime = collectionRealtimeTests(this.ws, collection, p.selection);
    const count = collectionRequests(collection, p.selection).length + realtime.length;
    if (!count) throw new ApsError('ValidationError', 'Nothing to run: the selection has no requests');
    const folder = p.selection?.length === 1 ? findNodeName(collection.items, p.selection[0]!) : undefined;
    const name = p.name ?? (folder ? `${collection.name} / ${folder}` : collection.name);
    return this.startRun(name, (async function* () {})(), { ...p, concurrency: 1, retries: 0 }, async (o) =>
      runCollection({
        ...o,
        collection,
        selection: p.selection,
        iterations: p.iterations,
        data: p.dataPath ? await this.readRunData(p.dataPath, p.dataQuery) : undefined,
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
    const id = shortId('load-');
    const ctrl = new AbortController();
    this.controllers.set(id, ctrl);
    const ctx = this.context({ environment: p.environment, collectionId: p.collection?.collectionId });
    // a collection: its requests in order (after an optional warm-up run with scripts), variables resolved once
    let target = p.config.target;
    let info: { requests: string[]; unresolved: string[]; warmUp?: { passed: number; failed: number } } | undefined;
    // gRPC: without proto files, the server describes itself (reflection)
    if (target.kind === 'grpc') {
      try {
        const r = ctx.vars.resolveDeep(target.request);
        if (!r.protoFiles?.length && !r.descriptorSet) r.descriptorSet = (await reflectServer(parseGrpcTarget(r.target, r.tls), { metadata: r.metadata })).descriptorSet;
        target = { kind: 'grpc', request: r };
      } catch (e) {
        this.controllers.delete(id);
        void ctx.dispose();
        throw e;
      }
    }
    if (p.collection) {
      const col = this.ws.getCollection(p.collection.collectionId);
      if (!col) throw new ApsError('ConfigurationError', 'Collection not found');
      try {
        const t = await collectionLoadTarget({ collection: col, selection: p.collection.selection, services: ctx.services, warmUp: p.collection.warmUp, signal: ctrl.signal });
        target = t.target;
        info = { requests: t.target.requests.map((r) => r.name), unresolved: t.unresolved, warmUp: t.warmUp && { passed: t.warmUp.passed, failed: t.warmUp.failed + t.warmUp.errors } };
      } catch (e) {
        this.controllers.delete(id);
        void ctx.dispose();
        throw e;
      }
    }
    const cfg: LoadTestConfig = {
      ...p.config,
      target: p.collection ? target : ctx.vars.resolveDeep(target),
      environmentIsProduction: ctx.environment?.isProduction,
      allowRemoteHosts: p.config.allowRemoteHosts || this.settings.loadTesting.allowRemoteHosts,
      maxVirtualUsers: this.settings.loadTesting.maxVirtualUsers,
    };
    // validate safeguards synchronously so the UI gets an immediate error
    const { checkLoadSafeguards } = await import('@testpion/core');
    checkLoadSafeguards(cfg, cfg.target.kind === 'http' ? buildUrl(cfg.target.request.url, cfg.target.request.params).toString() : undefined);
    // what was tested, for the history (URLs with secrets masked)
    const t = cfg.target;
    const targetText =
      t.kind === 'http'
        ? `${t.request.method} ${ctx.redactor.redactUrl(buildUrl(t.request.url, t.request.params).toString())}`
        : t.kind === 'grpc'
          ? `gRPC ${t.request.target} ${t.request.method}`
          : t.kind === 'llm'
            ? `LLM ${t.model.provider}${t.model.name ? `/${t.model.name}` : ''}`
            : `collection ${this.ws.getCollection(p.collection!.collectionId).name}${info ? ` (${info.requests.length} requests)` : ''}`;
    const startedAt = new Date().toISOString();
    const ws = this.ws;
    void runLoadTest(cfg, { providers: ctx.services.providers, pricing: this.settings.pricing, redactor: ctx.redactor, signal: ctrl.signal, onSnapshot: (s) => this.host.emit('load.snapshot', { id, snapshot: s }) })
      .then((snap) => {
        // every finished load test is kept in the workspace history (runs/load/history.jsonl)
        if (!snap.requests) return;
        let thresholds: LoadRunRecord['thresholds'];
        try {
          thresholds = p.thresholds?.length ? evaluateThresholds(p.thresholds, snap).map((r) => ({ expr: r.expr, passed: r.passed, actual: r.actual })) : undefined;
        } catch {
          thresholds = undefined;
        }
        recordLoadRun(ws, loadRunRecord(snap, { id, startedAt, savedId: p.savedId, name: p.name || targetText, target: targetText, environment: p.environment, virtualUsers: cfg.virtualUsers, durationSec: cfg.durationSec, stopped: ctrl.signal.aborted || undefined, thresholds }));
        this.host.emit('load.recorded', { id });
      })
      .catch((e) => this.host.emit('load.error', { id, error: normalizeError(e) }))
      .finally(() => {
        this.controllers.delete(id);
        void ctx.dispose();
      });
    this.logger.info('Load test started', { id, vus: cfg.virtualUsers, duration: cfg.durationSec });
    return { id, ...info };
  }

  async dispose(): Promise<void> {
    this.stopWatching?.();
    this.monitorScheduler.stop();
    for (const c of this.controllers.values()) c.abort();
    for (const r of this.runs.values()) r.ctrl.abort();
    for (const s of this.mcpSessions.values()) await s.close();
    for (const s of this.wsSessions.values()) s.close();
    for (const s of this.sioSessions.values()) s.close();
    for (const s of this.mqttSessions.values()) s.close();
    for (const m of this.mocks.values()) await m.close();
    await this.gqlMock?.close();
    await this.recorder?.close();
    await this.debugger?.proxy?.close();
    await this.debugger?.release?.();
    for (const s of this.gqlSubs.values()) s.stop();
    await this.cookieStore?.flush().catch(() => undefined);
    this.store?.close();
  }
}

export interface CollectionRunParams {
  collectionId: string;
  /** Folder and/or request ids; empty runs the whole collection. */
  selection?: string[];
  environment?: string;
  iterations?: number;
  /** CSV / JSON file with one row per iteration. */
  dataPath?: string;
  /** SQL for a SQLite data file (read-only). */
  dataQuery?: string;
  delayMs?: number;
  bail?: boolean;
  /** Save variables set by scripts as current values (Postman's "Keep variable values"). Default true. */
  keepVariableValues?: boolean;
  name?: string;
}

function findNodeName(nodes: CollectionNode[], id: string): string | undefined {
  for (const n of nodes) {
    if (n.id === id) return n.name;
    if (n.kind === 'folder') {
      const r = findNodeName(n.items, id);
      if (r) return r;
    }
  }
  return undefined;
}

export interface HttpSendParams {
  id?: string;
  name?: string;
  request: HttpRequestSpec;
  environment?: string;
  collectionId?: string;
  requestId?: string;
  preRequestScript?: string;
  testScript?: string;
  assertions?: CheckConfig[];
  stream?: boolean;
}

export interface GqlSendParams {
  id?: string;
  request: GraphQLRequestSpec;
  environment?: string;
  collectionId?: string;
  /** The saved request, for folder scripts and pm.info. */
  requestId?: string;
  name?: string;
  operationName?: string;
  assertions?: CheckConfig[];
  preRequestScript?: string;
  testScript?: string;
}

export interface AiChatParams {
  requestId?: string;
  provider: string;
  model: string;
  system?: string;
  prompt: string;
  input?: Record<string, unknown>;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  seed?: number;
  responseFormat?: ResponseFormat;
  stream?: boolean;
  environment?: string;
  evaluators?: CheckConfig[];
  expected?: unknown;
}

export interface EvalRunParams {
  name?: string;
  template: Record<string, unknown>;
  datasetText?: string;
  datasetFormat?: 'jsonl' | 'json' | 'csv' | 'md';
  datasetPath?: string;
  expectedField?: string;
  limit?: number;
  concurrency?: number;
  retries?: number;
  environment?: string;
}
