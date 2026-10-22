/** One JSON-RPC message of an MCP session, as the backend's `mcp.events` sends them (spec §12.4). */
export interface McpEvent {
  id: string;
  timestamp: number;
  direction: 'outgoing' | 'incoming' | 'local';
  method: string;
  kind: string;
  rpcId?: string | number;
  request?: unknown;
  response?: unknown;
  error?: unknown;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

/** The most events kept per server (the oldest leave first). */
export const MAX_MCP_EVENTS = 5000;

/**
 * Merge event lists by id — the connect snapshot and the live stream overlap. Once per batch and server: the kept list is
 * in time order, so events that arrive in order are appended; only one that is out of order sorts the list. A batch
 * that brings nothing new answers the list it was given (no render).
 */
export function mergeEvents(a: McpEvent[], b: McpEvent[]): McpEvent[] {
  if (!b.length) return a;
  const seen = new Set(a.map((e) => e.id));
  const out = [...a];
  let unordered = false;
  for (const e of b) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    if (out.length && e.timestamp < out[out.length - 1]!.timestamp) unordered = true;
    out.push(e);
  }
  if (out.length === a.length) return a;
  if (unordered) out.sort((x, y) => x.timestamp - y.timestamp);
  return out.length > MAX_MCP_EVENTS ? out.slice(-MAX_MCP_EVENTS) : out;
}

/** A batch of events grouped by server: one merge per server, not one per event. */
export function mergeEventBatch(ev: Record<string, McpEvent[]>, items: Array<{ serverId: string; event: McpEvent }>): Record<string, McpEvent[]> {
  const byServer = new Map<string, McpEvent[]>();
  for (const it of items) (byServer.get(it.serverId) ?? byServer.set(it.serverId, []).get(it.serverId)!).push(it.event);
  const next = { ...ev };
  for (const [serverId, events] of byServer) next[serverId] = mergeEvents(next[serverId] ?? [], events);
  return next;
}
