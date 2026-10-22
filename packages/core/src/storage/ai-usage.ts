/**
 * The AI usage ledger (AIB-6): every call the AI features make — from the app, the CLI, the MCP server or CI — with the
 * task, the model, tokens in and out, the estimated cost and the time, kept in the workspace's metadata store (beside
 * the history; not shared through git). AI Lab prompts stay in the history (`llmUsage`); `aiUsageSummary` reads both.
 * The per-call and per-day caps of the AI settings are checked against it before anything is sent.
 */
import { formatUsd } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { AiSettings } from '../ai/ai-settings.js';
import { llmUsage } from './llm-usage.js';
import type { WorkspaceStore } from './workspace.js';

export type AiSurface = 'app' | 'cli' | 'mcp' | 'ci';

export interface AiCallRecord {
  id: string;
  /** ISO time the call started. */
  at: string;
  surface: AiSurface;
  /** The task id (`explain-error`, `design-flow`, `free` …). */
  task: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimated from the price table; absent without a price for the model. */
  costUsd?: number;
  ms: number;
  outcome: 'ok' | 'error' | 'cancelled' | 'accepted' | 'discarded';
  /** The proposal it made, if any. */
  proposalId?: string;
  /** Model calls the task made (repairs and continuations count). */
  calls?: number;
  /** The error kind of a failed call. */
  error?: string;
}

/** Calls kept per workspace; older ones are pruned. */
export const MAX_AI_CALLS = 20_000;

/** The start of the local day of `now` (ISO), the window of the per-day caps. */
const startOfDay = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

interface AiUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Calls without a known price (their cost is not in costUsd). */
  unpriced: number;
}

const totals = (rows: AiCallRecord[]): AiUsageTotals =>
  rows.reduce(
    (t, r) => ({
      calls: t.calls + 1,
      inputTokens: t.inputTokens + r.inputTokens,
      outputTokens: t.outputTokens + r.outputTokens,
      costUsd: Math.round((t.costUsd + (r.costUsd ?? 0)) * 1e6) / 1e6,
      unpriced: t.unpriced + (r.costUsd === undefined && r.inputTokens + r.outputTokens > 0 ? 1 : 0),
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpriced: 0 },
  );

export interface AiUsageSummary {
  today: AiUsageTotals;
  /** The last `days` days (default 30). */
  period: AiUsageTotals & { days: number; since: string };
  byTask: Array<AiUsageTotals & { task: string }>;
  byModel: Array<AiUsageTotals & { provider: string; model: string }>;
  bySurface: Array<AiUsageTotals & { surface: AiSurface }>;
  /** Per day, oldest first. */
  daily: Array<{ day: string; calls: number; tokens: number; costUsd: number }>;
  /** The latest calls, newest first. */
  recent: AiCallRecord[];
  /** The caps in force and what is left of them today. */
  caps: { maxTokensPerCall?: number; dailyTokens?: number; dailyBudgetUsd?: number; tokensLeftToday?: number; budgetLeftToday?: number };
  /** AI Lab prompts (from the history), per model. */
  aiLab: ReturnType<typeof llmUsage>;
}

function group<T extends Record<string, unknown>>(rows: AiCallRecord[], key: (r: AiCallRecord) => string, extra: (r: AiCallRecord) => T): Array<AiUsageTotals & T> {
  const by = new Map<string, AiCallRecord[]>();
  for (const r of rows) {
    const k = key(r);
    const list = by.get(k);
    if (list) list.push(r);
    else by.set(k, [r]);
  }
  return [...by.values()].map((list) => ({ ...extra(list[0]!), ...totals(list) })).sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)) as Array<AiUsageTotals & T>;
}

/** Usage of the AI features in a workspace: today, the last `days` days, per task, model and surface, and the caps. */
export function aiUsageSummary(store: WorkspaceStore, o: { days?: number; settings?: AiSettings; recent?: number; now?: Date } = {}): AiUsageSummary {
  const days = Math.min(Math.max(o.days ?? 30, 1), 365);
  const now = o.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = store.meta.listAiCalls({ since, limit: MAX_AI_CALLS });
  const dayStart = startOfDay(now);
  const today = totals(rows.filter((r) => r.at >= dayStart));
  const daily = new Map<string, { day: string; calls: number; tokens: number; costUsd: number }>();
  for (const r of rows) {
    const d = new Date(r.at);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const e = daily.get(day) ?? { day, calls: 0, tokens: 0, costUsd: 0 };
    e.calls++;
    e.tokens += r.inputTokens + r.outputTokens;
    e.costUsd = Math.round((e.costUsd + (r.costUsd ?? 0)) * 1e6) / 1e6;
    daily.set(day, e);
  }
  const s = o.settings ?? {};
  return {
    today,
    period: { ...totals(rows), days, since },
    byTask: group(
      rows,
      (r) => r.task,
      (r) => ({ task: r.task }),
    ),
    byModel: group(
      rows,
      (r) => `${r.provider}\u0000${r.model}`,
      (r) => ({ provider: r.provider, model: r.model }),
    ),
    bySurface: group(
      rows,
      (r) => r.surface,
      (r) => ({ surface: r.surface }),
    ),
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    recent: rows.slice(0, Math.min(Math.max(o.recent ?? 50, 0), 500)),
    caps: {
      maxTokensPerCall: s.maxTokensPerCall || undefined,
      dailyTokens: s.dailyTokens || undefined,
      dailyBudgetUsd: s.dailyBudgetUsd || undefined,
      ...(s.dailyTokens ? { tokensLeftToday: Math.max(0, s.dailyTokens - today.inputTokens - today.outputTokens) } : {}),
      ...(s.dailyBudgetUsd ? { budgetLeftToday: Math.max(0, Math.round((s.dailyBudgetUsd - today.costUsd) * 1e6) / 1e6) } : {}),
    },
    aiLab: llmUsage(store),
  };
}

/**
 * The caps of the AI settings, checked before a call is sent: the call's estimate (input tokens + the output limit)
 * against the per-call cap, and today's usage plus the estimate against the per-day token and cost caps. Refuses with a
 * clear message (nothing is sent).
 */
export function checkAiCaps(store: WorkspaceStore | undefined, s: AiSettings | undefined, est: { tokens: number; costUsd?: number }, now = new Date()): void {
  if (!s) return;
  const refuse = (message: string, why: string, limit: Record<string, unknown>) =>
    new ApsError('ConfigurationError', message, {
      why: `${why} Nothing was sent.`,
      details: { aiLimit: limit, setup: { assistant: true } },
      suggestions: [
        'Send less: a folder instead of a collection, or the Metadata only privacy level.',
        `Raise or remove the cap in Settings ▸ AI assistant ▸ Limits (CLI and CI: testpion settings set ai.${String(limit.cap)}=<number>; 0 means no cap).`,
      ],
    });
  if (s.maxTokensPerCall && est.tokens > s.maxTokensPerCall)
    throw refuse(
      `This AI call needs about ${est.tokens.toLocaleString('en-US')} tokens, over the cap of ${s.maxTokensPerCall.toLocaleString('en-US')} per call`,
      'The estimate (context and question, plus the most the answer may use) is over the per-call cap of the AI settings.',
      {
        cap: 'maxTokensPerCall',
        limit: s.maxTokensPerCall,
        estimate: est.tokens,
      },
    );
  if (!store || (!s.dailyTokens && !s.dailyBudgetUsd)) return;
  const today = totals(store.meta.listAiCalls({ since: startOfDay(now), limit: MAX_AI_CALLS }));
  const used = today.inputTokens + today.outputTokens;
  if (s.dailyTokens && used + est.tokens > s.dailyTokens)
    throw refuse(
      `The AI features have used ${used.toLocaleString('en-US')} of ${s.dailyTokens.toLocaleString('en-US')} tokens today; this call needs about ${est.tokens.toLocaleString('en-US')} more`,
      'The per-day token cap of this workspace would be passed.',
      {
        cap: 'dailyTokens',
        limit: s.dailyTokens,
        used,
        estimate: est.tokens,
      },
    );
  if (s.dailyBudgetUsd && today.costUsd + (est.costUsd ?? 0) > s.dailyBudgetUsd)
    throw refuse(
      `The AI features have spent about ${formatUsd(today.costUsd)} of the ${formatUsd(s.dailyBudgetUsd)} per-day budget`,
      'The per-day cost cap of this workspace would be passed (estimated from the price table).',
      {
        cap: 'dailyBudgetUsd',
        limit: s.dailyBudgetUsd,
        used: today.costUsd,
        estimate: est.costUsd,
      },
    );
}

/** A proposal was applied or discarded: its ledger row says so (the outcome of an AI call). */
export function noteProposalOutcome(store: WorkspaceStore, proposalId: string, createdAt: string, outcome: 'accepted' | 'discarded'): void {
  try {
    const row = store.meta.listAiCalls({ since: new Date(Date.parse(createdAt) - 60_000).toISOString(), limit: 2000 }).find((r) => r.proposalId === proposalId);
    if (row) store.meta.addAiCall({ ...row, outcome });
  } catch {
    /* the ledger must never fail an apply */
  }
}
