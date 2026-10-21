import type { GraphQLRequestSpec, HttpRequestSpec, McpServerConfig } from '../model/types.js';
import { executeHttp, type HttpExecOptions } from './http/client.js';
import { executeGraphQL, introspect } from './graphql/graphql.js';
import { McpSession } from './mcp/client.js';
import { WebSocketSession } from './websocket/websocket.js';
import { ApsError } from '../errors.js';

/**
 * Protocol adapter contract (spec §47). Adapters are independent modules; the engine only
 * talks to them through this interface so new protocols (gRPC, SSE, MQTT, Kafka…) can be
 * added without touching the execution engine.
 */
export interface ProtocolAdapter<Req = unknown, Res = unknown, Conn = unknown> {
  readonly id: string;
  readonly name: string;
  /** Connection-oriented protocols return a connection handle; stateless ones return undefined. */
  connect?(config: unknown): Promise<Conn>;
  execute(request: Req, ctx: { connection?: Conn } & HttpExecOptions): Promise<Res>;
  disconnect?(connection: Conn): Promise<void>;
}

const adapters = new Map<string, ProtocolAdapter>();

export function registerProtocol(adapter: ProtocolAdapter<any, any, any>): void {
  if (adapters.has(adapter.id)) throw new ApsError('ConfigurationError', `Protocol adapter "${adapter.id}" is already registered`);
  adapters.set(adapter.id, adapter);
}

export function getProtocol(id: string): ProtocolAdapter {
  const a = adapters.get(id);
  if (!a) throw new ApsError('ConfigurationError', `No protocol adapter "${id}". Available: ${[...adapters.keys()].join(', ')}`);
  return a;
}

registerProtocol({
  id: 'http',
  name: 'HTTP / REST',
  execute: (req: HttpRequestSpec, ctx) => executeHttp(req, ctx),
} satisfies ProtocolAdapter<HttpRequestSpec>);

registerProtocol({
  id: 'graphql',
  name: 'GraphQL',
  execute: (req: GraphQLRequestSpec & { introspect?: boolean }, ctx) => (req.introspect ? introspect(req, ctx) : executeGraphQL(req, ctx)),
} satisfies ProtocolAdapter<GraphQLRequestSpec & { introspect?: boolean }>);

registerProtocol({
  id: 'mcp',
  name: 'Model Context Protocol',
  async connect(config: McpServerConfig) {
    const s = new McpSession(config);
    await s.connect();
    return s;
  },
  async execute(req: { method: 'tools/call' | 'resources/read' | 'prompts/get' | 'discover'; name?: string; uri?: string; arguments?: Record<string, unknown> }, ctx) {
    const s = ctx.connection;
    if (!s) throw new ApsError('ProtocolError', 'MCP adapter requires a connection');
    if (req.method === 'tools/call') return s.callTool(req.name!, req.arguments ?? {}, { signal: ctx.signal });
    if (req.method === 'resources/read') return s.readResource(req.uri!, { signal: ctx.signal });
    if (req.method === 'prompts/get') return s.getPrompt(req.name!, (req.arguments ?? {}) as Record<string, string>, { signal: ctx.signal });
    return s.discover();
  },
  disconnect: (s: McpSession) => s.close(),
} satisfies ProtocolAdapter<any, unknown, McpSession>);

registerProtocol({
  id: 'websocket',
  name: 'WebSocket',
  async connect(config: { url: string; protocols?: string[] }) {
    const s = new WebSocketSession(config.url, { protocols: config.protocols });
    await s.connect();
    return s;
  },
  async execute(req: { send: string }, ctx) {
    ctx.connection!.send(req.send);
    return { sent: true };
  },
  disconnect: async (s: WebSocketSession) => s.close(),
} satisfies ProtocolAdapter<{ send: string }, { sent: boolean }, WebSocketSession>);
