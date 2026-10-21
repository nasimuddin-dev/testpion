/** How the MCP tools of a workspace's servers have been called from the app: calls, failures and timing per tool. */
import type { WorkspaceStore } from './workspace.js';
import { percentile } from '../util/stats.js';

interface McpToolUsage {
  /** Server name (as when the call was made). */
  server: string;
  serverId?: string;
  tool: string;
  calls: number;
  /** Calls that returned isError or failed. */
  failed: number;
  medianMs?: number;
  p95Ms?: number;
  lastAt: string;
}

/** Per tool, most called first, from the latest `limit` MCP calls in the history (optionally of one server). */
export function mcpToolUsage(store: WorkspaceStore, opts: { serverId?: string; limit?: number } = {}): McpToolUsage[] {
  const rows = store.meta.listHistory({ kind: 'mcp', limit: Math.min(Math.max(opts.limit ?? 2000, 1), 20_000) }).items;
  const by = new Map<string, McpToolUsage & { ms: number[] }>();
  for (const h of rows) {
    const req = (h.request ?? {}) as { serverId?: string; tool?: string };
    if (opts.serverId && req.serverId !== opts.serverId) continue;
    const [server = '', tool = req.tool ?? h.name] = h.name.includes(' · ') ? h.name.split(' · ', 2) : ['', h.name];
    const key = `${req.serverId ?? server}\u0000${req.tool ?? tool}`;
    let u = by.get(key);
    if (!u) by.set(key, (u = { server, serverId: req.serverId, tool: req.tool ?? tool, calls: 0, failed: 0, lastAt: h.timestamp, ms: [] }));
    u.calls++;
    if (h.status !== 'ok') u.failed++;
    if (typeof h.durationMs === 'number') u.ms.push(h.durationMs);
    if (h.timestamp > u.lastAt) u.lastAt = h.timestamp;
  }
  const pct = (sorted: number[], p: number) => {
    const v = percentile(sorted, p);
    return v === undefined ? undefined : Math.round(v);
  };
  return [...by.values()]
    .map(({ ms, ...u }) => {
      const s = ms.sort((a, b) => a - b);
      return { ...u, medianMs: pct(s, 0.5), p95Ms: pct(s, 0.95) };
    })
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}
