import { ENGINE_VERSION } from '../../version.js';
import { readFileSync } from 'node:fs';
import { createMcpMockServer, loadMcpMock } from '../../mcp-server/mcp-mock.js';
import { assertProcessesAllowed, assertUrlAllowed } from '../../net/policy.js';
import { ensureProxyApplied } from '../../net/proxy.js';
import type { CookieJar } from '../../cookies/cookie-jar.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mcpClient, mcpClientHttp, mcpClientSse, mcpClientStdio, mcpInMemory, mcpTypes } from '../../mcp-server/sdk.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { CreateMessageRequest, CreateMessageResult, ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from '../../model/types.js';
import { ApsError } from '../../errors.js';
import type { Redactor } from '../../util/redact.js';
import { shortId } from '../../util/ids.js';

/** One protocol-level event in an MCP session (spec §12.4). */
export interface McpTraceEvent {
  id: string;
  timestamp: number;
  direction: 'outgoing' | 'incoming' | 'local';
  /** JSON-RPC method, or `response` for replies. */
  method: string;
  kind: 'request' | 'response' | 'notification' | 'error' | 'lifecycle' | 'stderr';
  rpcId?: string | number;
  request?: unknown;
  response?: unknown;
  error?: unknown;
  /** For responses: time since the matching request. */
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export type McpEventListener = (e: McpTraceEvent) => void;

/**
 * Transport decorator that observes every JSON-RPC message without changing behaviour.
 * Keeps transport handling isolated from the MCP domain model.
 */
class TracingTransport implements Transport {
  private pending = new Map<string | number, { method: string; t: number; params: unknown }>();
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport['onmessage'];

  constructor(
    private inner: Transport,
    private emit: McpEventListener,
    private redactor?: Redactor,
  ) {
    inner.onclose = () => {
      this.emit({ id: shortId(), timestamp: Date.now(), direction: 'local', method: 'connection/closed', kind: 'lifecycle' });
      this.onclose?.();
    };
    inner.onerror = (err) => {
      this.emit({ id: shortId(), timestamp: Date.now(), direction: 'local', method: 'transport/error', kind: 'error', error: err.message });
      this.onerror?.(err);
    };
    inner.onmessage = (msg, extra) => {
      this.observe('incoming', msg);
      this.onmessage?.(msg, extra);
    };
  }

  get sessionId(): string | undefined {
    return (this.inner as { sessionId?: string }).sessionId;
  }

  async start(): Promise<void> {
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: Parameters<Transport['send']>[1]): Promise<void> {
    this.observe('outgoing', message);
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  setProtocolVersion(v: string): void {
    (this.inner as { setProtocolVersion?: (v: string) => void }).setProtocolVersion?.(v);
  }

  private clean(v: unknown): unknown {
    return this.redactor ? this.redactor.redact(v) : v;
  }

  private observe(direction: 'outgoing' | 'incoming', msg: JSONRPCMessage): void {
    const m = msg as { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };
    const now = Date.now();
    if (m.method && m.id !== undefined) {
      this.pending.set(`${direction}:${m.id}`, { method: m.method, t: now, params: m.params });
      this.emit({ id: shortId(), timestamp: now, direction, method: m.method, kind: 'request', rpcId: m.id, request: this.clean(m.params) });
    } else if (m.method) {
      this.emit({ id: shortId(), timestamp: now, direction, method: m.method, kind: 'notification', request: this.clean(m.params) });
    } else if (m.id !== undefined) {
      const reqDir = direction === 'incoming' ? 'outgoing' : 'incoming';
      const p = this.pending.get(`${reqDir}:${m.id}`);
      this.pending.delete(`${reqDir}:${m.id}`);
      this.emit({
        id: shortId(),
        timestamp: now,
        direction,
        method: p?.method ?? 'response',
        kind: m.error ? 'error' : 'response',
        rpcId: m.id,
        request: p ? this.clean(p.params) : undefined,
        response: m.result !== undefined ? this.clean(m.result) : undefined,
        error: m.error ? this.clean(m.error) : undefined,
        durationMs: p ? now - p.t : undefined,
      });
    }
  }
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpDiscovery {
  serverInfo?: { name: string; version: string; title?: string };
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  instructions?: string;
  tools: McpToolInfo[];
  resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
  resourceTemplates: Array<{ uriTemplate: string; name: string; description?: string; mimeType?: string }>;
  prompts: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>;
}

export interface McpCallResult {
  isError: boolean;
  content: unknown[];
  structuredContent?: unknown;
  durationMs: number;
  raw: unknown;
}

/**
 * Answers to requests the server sends to the client: its roots (folders it may work in), sampling
 * (the server asks for an LLM completion) and elicitation (the server asks the user for input).
 */
export interface McpClientHandlers {
  roots?: () => Array<{ uri: string; name?: string }>;
  sampling?: (params: CreateMessageRequest['params']) => Promise<CreateMessageResult>;
  elicitation?: (params: ElicitRequest['params']) => Promise<ElicitResult>;
}
export type McpClientFeature = 'roots' | 'sampling' | 'elicitation';

/** A live connection to one MCP server. */
export class McpSession {
  private handlers: McpClientHandlers;
  private client: Client;
  private transport?: TracingTransport;
  private listeners: McpEventListener[] = [];
  readonly events: McpTraceEvent[] = [];
  private maxEvents = 5000;
  connected = false;

  constructor(
    readonly config: McpServerConfig,
    private redactor?: Redactor,
    /**
     * `cookieJar`: HTTP transports send its cookies and store the ones the server sets.
     * `handlers` / `features`: the client capabilities to declare (roots, sampling, elicitation) and how
     * to answer; handlers can be swapped later with setHandlers (features are fixed at connect).
     */
    private opts: { cookieJar?: CookieJar; handlers?: McpClientHandlers; features?: McpClientFeature[] } = {},
  ) {
    this.handlers = opts.handlers ?? {};
    const features = new Set<McpClientFeature>(opts.features ?? (Object.keys(this.handlers) as McpClientFeature[]));
    const capabilities: Record<string, object> = {};
    if (features.has('roots')) capabilities.roots = { listChanged: false };
    if (features.has('sampling')) capabilities.sampling = {};
    if (features.has('elicitation')) capabilities.elicitation = {};
    this.client = new (mcpClient().Client)({ name: 'testpion', version: ENGINE_VERSION }, { capabilities });
    if (features.has('roots')) this.client.setRequestHandler(mcpTypes().ListRootsRequestSchema, async () => ({ roots: this.handlers.roots?.() ?? [] }));
    if (features.has('sampling'))
      this.client.setRequestHandler(mcpTypes().CreateMessageRequestSchema, async (req) => {
        if (!this.handlers.sampling) throw new Error('Sampling is not answered here: set a sampling reply for this test');
        return this.handlers.sampling(req.params);
      });
    if (features.has('elicitation'))
      this.client.setRequestHandler(mcpTypes().ElicitRequestSchema, async (req) => (this.handlers.elicitation ? this.handlers.elicitation(req.params) : { action: 'decline' }));
  }

  /** Change how server requests (roots, sampling, elicitation) are answered. */
  setHandlers(h: McpClientHandlers): void {
    this.handlers = h;
  }

  private updateListeners: Array<(uri: string) => void> = [];
  /** Called when a subscribed resource changes (notifications/resources/updated). */
  onResourceUpdated(l: (uri: string) => void): () => void {
    this.updateListeners.push(l);
    return () => (this.updateListeners = this.updateListeners.filter((x) => x !== l));
  }

  /** Subscribe to changes of a resource (the server must support resources.subscribe). */
  async subscribeResource(uri: string): Promise<void> {
    if (!(this.client.getServerCapabilities()?.resources as { subscribe?: boolean } | undefined)?.subscribe)
      throw new ApsError('ProtocolError', 'This server does not support resource subscriptions', { suggestions: ['Read the resource again to see changes.'] });
    await this.client.subscribeResource({ uri });
  }
  async unsubscribeResource(uri: string): Promise<void> {
    await this.client.unsubscribeResource({ uri });
  }

  /**
   * Suggestions for an argument of a prompt or a resource template (completion/complete). Empty when the
   * server has no completions.
   */
  async complete(ref: { type: 'ref/prompt'; name: string } | { type: 'ref/resource'; uri: string }, argument: { name: string; value: string }, context?: Record<string, string>): Promise<{ values: string[]; hasMore?: boolean; total?: number }> {
    if (!this.client.getServerCapabilities()?.completions) return { values: [] };
    const r = await this.client.complete({ ref, argument, ...(context ? { context: { arguments: context } } : {}) });
    return { values: r.completion.values.slice(0, 100), hasMore: r.completion.hasMore, total: r.completion.total };
  }

  onEvent(l: McpEventListener): () => void {
    this.listeners.push(l);
    return () => (this.listeners = this.listeners.filter((x) => x !== l));
  }

  private emit = (e: McpTraceEvent) => {
    this.events.push(e);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    for (const l of this.listeners) l(e);
  };

  private createTransport(): Transport {
    const c = this.config;
    const headersOf = (kv?: Array<{ key: string; value: string; enabled?: boolean }>) => {
      const h: Record<string, string> = {};
      for (const x of kv ?? []) if (x.enabled !== false && x.key) h[x.key] = x.value;
      return h;
    };
    // HTTP transports share the workspace cookie jar, like HTTP requests do
    const jar = this.opts.cookieJar;
    // every HTTP request to the server is checked against the network policy and shares the cookie jar
    const jarFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      await assertUrlAllowed(url);
      // global fetch goes through undici's global dispatcher: the app's proxy settings, applied with undici's first load
      await ensureProxyApplied();
      const headers = new Headers(init?.headers);
      if (jar && !headers.has('cookie')) {
        const cookie = jar.headerFor(url);
        if (cookie) headers.set('cookie', cookie);
      }
      const res = await fetch(url, { ...init, headers });
      const setCookies = res.headers.getSetCookie?.() ?? [];
      if (jar && setCookies.length) jar.storeFromResponse(url, setCookies);
      return res;
    };
    switch (c.transport) {
      case 'stdio': {
        assertProcessesAllowed(`MCP server "${c.name}"`);
        const t = new (mcpClientStdio().StdioClientTransport)({
          command: c.command,
          args: c.args ?? [],
          env: { ...mcpClientStdio().getDefaultEnvironment(), ...(c.env ?? {}) },
          cwd: c.cwd || undefined,
          stderr: 'pipe',
        });
        t.stderr?.on('data', (buf: Buffer) => {
          const text = buf.toString('utf8');
          this.emit({ id: shortId(), timestamp: Date.now(), direction: 'incoming', method: 'stderr', kind: 'stderr', response: this.redactor?.redactString(text) ?? text });
        });
        return t;
      }
      case 'mock': {
        // in-process: the mock server and this client are joined by an in-memory channel
        const def = loadMcpMock(readFileSync(c.mockFile, 'utf8'));
        const [client, server] = mcpInMemory().InMemoryTransport.createLinkedPair();
        void createMcpMockServer(def).connect(server);
        return client;
      }
      case 'streamable-http':
        return new (mcpClientHttp().StreamableHTTPClientTransport)(new URL(c.url), { requestInit: { headers: headersOf(c.headers) }, fetch: jarFetch });
      case 'sse':
        return new (mcpClientSse().SSEClientTransport)(new URL(c.url), { requestInit: { headers: headersOf(c.headers) }, fetch: jarFetch, eventSourceInit: { fetch: jarFetch } });
    }
  }

  async connect(timeoutMs = 30_000): Promise<void> {
    const t0 = Date.now();
    this.emit({
      id: shortId(),
      timestamp: t0,
      direction: 'local',
      method: 'connection/open',
      kind: 'lifecycle',
      metadata: this.redactor?.redact({ ...this.config }) ?? { ...this.config },
    });
    this.transport = new TracingTransport(this.createTransport(), this.emit, this.redactor);
    this.client.setNotificationHandler(mcpTypes().LoggingMessageNotificationSchema, () => {
      /* recorded by the tracing transport */
    });
    this.client.setNotificationHandler(mcpTypes().ResourceUpdatedNotificationSchema, (n) => {
      for (const l of this.updateListeners) l(n.params.uri);
    });
    try {
      await this.client.connect(this.transport, { timeout: timeoutMs });
    } catch (e) {
      this.emit({ id: shortId(), timestamp: Date.now(), direction: 'local', method: 'connection/failed', kind: 'error', error: (e as Error).message });
      throw new ApsError('ProtocolError', `Could not connect to MCP server "${this.config.name}": ${(e as Error).message}`, {
        why:
          this.config.transport === 'stdio'
            ? 'The server process failed to start or did not complete the MCP initialize handshake.'
            : 'The server did not accept the MCP initialize request.',
        suggestions:
          this.config.transport === 'stdio'
            ? ['Check the command and arguments (on Windows, use `npx.cmd` or the full path to node).', 'Look at the stderr events in the trace for startup errors.', 'Make sure the server writes only JSON-RPC to stdout.']
            : ['Check the URL and transport type (Streamable HTTP vs legacy SSE).', 'Check authentication headers.'],
        cause: e,
      });
    }
    this.connected = true;
    this.emit({
      id: shortId(),
      timestamp: Date.now(),
      direction: 'local',
      method: 'connection/ready',
      kind: 'lifecycle',
      durationMs: Date.now() - t0,
      metadata: { serverInfo: this.client.getServerVersion(), capabilities: this.client.getServerCapabilities(), sessionId: this.transport.sessionId },
    });
  }

  get capabilities(): Record<string, unknown> | undefined {
    return this.client.getServerCapabilities() as Record<string, unknown> | undefined;
  }

  async discover(): Promise<McpDiscovery> {
    const caps = this.client.getServerCapabilities() ?? {};
    const out: McpDiscovery = {
      serverInfo: this.client.getServerVersion() as McpDiscovery['serverInfo'],
      capabilities: caps as Record<string, unknown>,
      instructions: this.client.getInstructions(),
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    };
    if (caps.tools) out.tools = await this.listTools();
    if (caps.resources) {
      out.resources = await this.paginate((cursor) => this.client.listResources(cursor ? { cursor } : undefined), 'resources');
      out.resourceTemplates = await this.paginate<McpDiscovery['resourceTemplates'][number]>((cursor) => this.client.listResourceTemplates(cursor ? { cursor } : undefined), 'resourceTemplates').catch(() => []);
    }
    if (caps.prompts) out.prompts = await this.paginate((cursor) => this.client.listPrompts(cursor ? { cursor } : undefined), 'prompts');
    return out;
  }

  async listTools(): Promise<McpToolInfo[]> {
    return this.paginate((cursor) => this.client.listTools(cursor ? { cursor } : undefined), 'tools');
  }

  private async paginate<T>(fn: (cursor?: string) => Promise<Record<string, unknown>>, key: string): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const r = await fn(cursor);
      all.push(...((r[key] as T[]) ?? []));
      cursor = r.nextCursor as string | undefined;
      if (!cursor) break;
    }
    return all;
  }

  async callTool(name: string, args: Record<string, unknown> = {}, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<McpCallResult> {
    const t0 = performance.now();
    const r = (await this.client.callTool({ name, arguments: args }, undefined, { signal: opts.signal, timeout: opts.timeoutMs ?? 60_000 })) as {
      isError?: boolean;
      content?: unknown[];
      structuredContent?: unknown;
    };
    return {
      isError: !!r.isError,
      content: r.content ?? [],
      structuredContent: r.structuredContent,
      durationMs: Math.round(performance.now() - t0),
      raw: r,
    };
  }

  async readResource(uri: string, opts: { signal?: AbortSignal } = {}): Promise<{ contents: unknown[]; durationMs: number }> {
    const t0 = performance.now();
    const r = await this.client.readResource({ uri }, { signal: opts.signal });
    return { contents: r.contents, durationMs: Math.round(performance.now() - t0) };
  }

  async getPrompt(name: string, args: Record<string, string> = {}, opts: { signal?: AbortSignal } = {}): Promise<{ messages: unknown[]; description?: string; durationMs: number }> {
    const t0 = performance.now();
    const r = await this.client.getPrompt({ name, arguments: args }, { signal: opts.signal });
    return { messages: r.messages, description: r.description, durationMs: Math.round(performance.now() - t0) };
  }

  async ping(): Promise<number> {
    const t0 = performance.now();
    await this.client.ping();
    return Math.round(performance.now() - t0);
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    try {
      await this.client.close();
    } catch {
      /* ignore */
    }
  }
}

/** Pools MCP sessions by server id so a test run connects once per server. */
export class McpManager {
  private sessions = new Map<string, Promise<McpSession>>();

  constructor(
    private resolveConfig: (ref: string | McpServerConfig) => McpServerConfig | undefined,
    private redactor?: Redactor,
    private onEvent?: (serverId: string, e: McpTraceEvent) => void,
  ) {}

  /** `features`: client capabilities the session must declare (sessions are pooled per server and feature set). */
  async get(ref: string | McpServerConfig, features: McpClientFeature[] = []): Promise<McpSession> {
    const cfg = this.resolveConfig(ref);
    if (!cfg) throw new ApsError('ConfigurationError', `Unknown MCP server "${typeof ref === 'string' ? ref : ref.name}"`, {
      suggestions: ['Define the server in the MCP view (or mcp-servers.json in the workspace).'],
    });
    const key = features.length ? `${cfg.id}|${[...features].sort().join(',')}` : cfg.id;
    let p = this.sessions.get(key);
    if (!p) {
      p = (async () => {
        const s = new McpSession(cfg, this.redactor, { features });
        if (this.onEvent) s.onEvent((e) => this.onEvent!(cfg.id, e));
        await s.connect();
        return s;
      })();
      this.sessions.set(key, p);
      p.catch(() => this.sessions.delete(key));
    }
    return p;
  }

  async close(id?: string): Promise<void> {
    const entries = id ? [[id, this.sessions.get(id)] as const] : [...this.sessions.entries()];
    for (const [key, p] of entries) {
      this.sessions.delete(key);
      await p?.then((s) => s.close()).catch(() => undefined);
    }
  }
}

/** Flatten an MCP tool result into a value suitable for assertions. */
export function mcpResultBody(r: { structuredContent?: unknown; content: unknown[] }): { body: unknown; text: string } {
  const texts = (r.content as Array<{ type: string; text?: string }>).filter((c) => c.type === 'text').map((c) => c.text ?? '');
  const text = texts.join('\n');
  if (r.structuredContent !== undefined) return { body: r.structuredContent, text };
  if (texts.length === 1) {
    try {
      return { body: JSON.parse(texts[0]!), text };
    } catch {
      /* not json */
    }
  }
  return { body: text || r.content, text };
}
