/** What the prompts run in the app's AI Lab used, per provider and model: calls, tokens, cost and time. */
import type { WorkspaceStore } from './workspace.js';

interface LlmUsage {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated from the price table; absent when no call of the model had a known price. */
  costUsd?: number;
  medianMs?: number;
  /** Median time to the first token (streamed calls). */
  medianFirstTokenMs?: number;
  lastAt: string;
}

/** Per provider · model, most tokens first, from the latest `limit` AI Lab runs in the history. */
export function llmUsage(store: WorkspaceStore, opts: { limit?: number } = {}): LlmUsage[] {
  const rows = store.meta.listHistory({ kind: 'llm', limit: Math.min(Math.max(opts.limit ?? 2000, 1), 20_000) }).items;
  const by = new Map<string, LlmUsage & { ms: number[]; ttft: number[]; priced: boolean }>();
  for (const h of rows) {
    const [provider = '', model = h.name] = h.name.includes(' · ') ? h.name.split(' · ', 2) : ['', h.name];
    const meta = (h.responseMeta ?? {}) as { usage?: { inputTokens?: number; outputTokens?: number }; costUsd?: number; firstTokenMs?: number };
    let u = by.get(h.name);
    if (!u) by.set(h.name, (u = { provider, model, calls: 0, inputTokens: 0, outputTokens: 0, lastAt: h.timestamp, ms: [], ttft: [], priced: false }));
    u.calls++;
    u.inputTokens += meta.usage?.inputTokens ?? 0;
    u.outputTokens += meta.usage?.outputTokens ?? 0;
    if (typeof meta.costUsd === 'number') {
      u.costUsd = (u.costUsd ?? 0) + meta.costUsd;
      u.priced = true;
    }
    if (typeof h.durationMs === 'number') u.ms.push(h.durationMs);
    if (typeof meta.firstTokenMs === 'number') u.ttft.push(meta.firstTokenMs);
    if (h.timestamp > u.lastAt) u.lastAt = h.timestamp;
  }
  const median = (v: number[]) => (v.length ? Math.round(v.sort((a, b) => a - b)[Math.floor((v.length - 1) / 2)]!) : undefined);
  return [...by.values()]
    .map(({ ms, ttft, priced, ...u }) => ({ ...u, costUsd: priced ? Math.round(u.costUsd! * 1e6) / 1e6 : undefined, medianMs: median(ms), medianFirstTokenMs: median(ttft) }))
    .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) || b.calls - a.calls);
}
