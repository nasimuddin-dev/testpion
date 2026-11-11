/**
 * Does each model pick the right tool of an MCP server? (planning/ai-research-2026-11-11.md N-2.) A server can pass every
 * API test and still fail with a real model client, because the model chooses by the names and descriptions, and what one
 * model understands another does not. A case is a request a user would type and the tool it needs (or `none`: no tool
 * fits). Every model is offered the server's tool list and asked the request once; NO tool is ever called: only the
 * model's choice is read. The result says, per model, how often it chose right and which tools it confuses.
 */
import { ApsError } from '../errors.js';
import type { ChatMessage, LlmProvider, ToolDefinition } from '../ai/types.js';
import type { TokenUsage } from '../model/types.js';
import type { ProviderRegistry } from '../ai/index.js';
import { forEachConcurrent } from '../util/concurrency.js';

export interface SelectionCase {
  /** What the user types. */
  ask: string;
  /** The tool the request needs; 'none' when the model should call no tool. */
  tool: string;
}

export interface SelectionMiss {
  ask: string;
  expected: string;
  /** The tool the model called first; 'none' when it called no tool. */
  picked: string;
}

export interface SelectionModelResult {
  /** provider/model as given. */
  model: string;
  cases: number;
  correct: number;
  /** correct / the cases that were answered (0..1). */
  accuracy: number;
  /** The cases whose call failed (the model was not reachable, a refusal of the provider …): not counted in the accuracy. */
  errors: number;
  firstError?: string;
  misses: SelectionMiss[];
  /** Pairs chosen wrongly more than once, most frequent first: the descriptions to tell apart. */
  confusions: Array<{ expected: string; picked: string; count: number }>;
  usage: TokenUsage;
  costUsd?: number;
  ms: number;
}

export interface SelectionRun {
  tools: number;
  cases: number;
  models: SelectionModelResult[];
  /** Cases every model got wrong: the description is probably at fault, not a model. */
  missedByAll: SelectionMiss[];
  text: string;
}

export interface SelectionOptions {
  tools: ToolDefinition[];
  /** The server's instructions: a client puts them in the system prompt. */
  instructions?: string;
  cases: SelectionCase[];
  /** provider/model, or a provider alone (its default model). */
  models: string[];
  concurrency?: number;
  signal?: AbortSignal;
  /** The price of a call, when the host knows it. */
  cost?: (provider: LlmProvider, model: string, usage: TokenUsage) => number | undefined;
}

const SYSTEM = 'You are an assistant with tools. When a tool can do what the user asks, call it. When no tool fits, answer in words without calling a tool.';

/** The cases of a file: one JSON object a line with ask (or question, input) and tool (or expected_tool); also a JSON array. */
export function parseSelectionCases(text: string): SelectionCase[] {
  const t = text.trim();
  if (!t) return [];
  let rows: unknown[];
  try {
    rows = t.startsWith('[') ? (JSON.parse(t) as unknown[]) : t.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown);
  } catch (e) {
    throw new ApsError('ValidationError', `The cases are not JSON lines: ${(e as Error).message}`, { suggestions: ['One case a line: {"ask": "What the user types", "tool": "the_tool_it_needs"} ("tool": "none" when no tool fits).'] });
  }
  const out: SelectionCase[] = [];
  for (const r of rows) {
    const o = (r ?? {}) as Record<string, unknown>;
    const ask = String(o.ask ?? o.question ?? o.input ?? '').trim();
    const tool = String(o.tool ?? o.expected_tool ?? o.expected ?? '').trim();
    if (ask && tool) out.push({ ask, tool });
  }
  return out;
}

export const selectionCasesText = (cases: SelectionCase[]): string => cases.map((c) => JSON.stringify({ ask: c.ask, tool: c.tool })).join('\n') + '\n';

/** What a model-written list of cases is worth: cases for tools that do not exist or that give the tool's name away are dropped, with why. */
export function vetSelectionCases(cases: SelectionCase[], tools: Array<{ name: string }>): { cases: SelectionCase[]; dropped: Array<SelectionCase & { why: string }>; uncovered: string[] } {
  const names = new Set(tools.map((t) => t.name));
  const kept: SelectionCase[] = [];
  const dropped: Array<SelectionCase & { why: string }> = [];
  const seen = new Set<string>();
  const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const c of cases) {
    const key = loose(c.ask);
    if (c.tool !== 'none' && !names.has(c.tool)) dropped.push({ ...c, why: 'the server has no such tool' });
    else if (c.tool !== 'none' && (c.ask.includes(c.tool) || (loose(c.tool).includes(' ') && key.includes(loose(c.tool))))) dropped.push({ ...c, why: "the request names the tool, so it tests nothing" });
    else if (seen.has(key)) dropped.push({ ...c, why: 'the same request twice' });
    else {
      seen.add(key);
      kept.push(c);
    }
  }
  const covered = new Set(kept.map((c) => c.tool));
  return { cases: kept, dropped, uncovered: [...names].filter((n) => !covered.has(n)) };
}

/** Asks every model every case with the tool list offered, and reads which tool it chose. Nothing is called. */
export async function runToolSelection(providers: ProviderRegistry, o: SelectionOptions): Promise<SelectionRun> {
  if (!o.tools.length) throw new ApsError('ValidationError', 'The server lists no tools, so there is nothing to choose from');
  if (!o.cases.length) throw new ApsError('ValidationError', 'There are no cases', { suggestions: ['Write them with --selection-cases (an AI task), or give a file: one {"ask", "tool"} a line.'] });
  if (!o.models.length) throw new ApsError('ValidationError', 'Name at least one model', { suggestions: ['--models provider/model,provider/model (the providers of this workspace; the mock can always be named).'] });
  const names = new Set(o.tools.map((t) => t.name));
  const unknown = [...new Set(o.cases.map((c) => c.tool))].filter((t) => t !== 'none' && !names.has(t));
  if (unknown.length) throw new ApsError('ValidationError', `The cases expect tools the server does not list: ${unknown.slice(0, 5).join(', ')}`, { suggestions: ['The server changed since the cases were written: fix the cases, or write them again.'] });
  const system = o.instructions?.trim() ? `${SYSTEM}\n\n${o.instructions.trim()}` : SYSTEM;

  const models: SelectionModelResult[] = [];
  for (const ref of o.models) {
    const slash = ref.indexOf('/');
    const { provider, model } = providers.resolveModel(slash > 0 ? { provider: ref.slice(0, slash), name: ref.slice(slash + 1) } : { provider: ref, name: '' });
    const t0 = Date.now();
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const misses: SelectionMiss[] = [];
    let correct = 0;
    let errors = 0;
    let firstError: string | undefined;
    await forEachConcurrent(o.cases, o.concurrency ?? 4, async (c) => {
      if (o.signal?.aborted) return;
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: c.ask },
      ];
      try {
        const r = await provider.chat({ model, messages, tools: o.tools, temperature: 0, maxTokens: 400, signal: o.signal });
        usage.inputTokens += r.usage.inputTokens ?? 0;
        usage.outputTokens += r.usage.outputTokens ?? 0;
        usage.totalTokens = (usage.totalTokens ?? 0) + (r.usage.totalTokens ?? (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0));
        const picked = r.toolCalls[0]?.name ?? 'none';
        if (picked === c.tool) correct++;
        else misses.push({ ask: c.ask, expected: c.tool, picked });
      } catch (e) {
        errors++;
        firstError ??= (e as Error).message.slice(0, 300);
      }
    });
    const answered = o.cases.length - errors;
    const pairs = new Map<string, { expected: string; picked: string; count: number }>();
    for (const m of misses) {
      const k = `${m.expected}\u0000${m.picked}`;
      pairs.set(k, { expected: m.expected, picked: m.picked, count: (pairs.get(k)?.count ?? 0) + 1 });
    }
    // misses in the order of the cases, whatever the order the answers came in
    const order = new Map(o.cases.map((c, i) => [c.ask, i]));
    misses.sort((a, b) => (order.get(a.ask) ?? 0) - (order.get(b.ask) ?? 0));
    const costUsd = o.cost?.(provider, model, usage);
    models.push({
      model: ref,
      cases: o.cases.length,
      correct,
      accuracy: answered ? Math.round((correct / answered) * 1000) / 1000 : 0,
      errors,
      ...(firstError ? { firstError } : {}),
      misses,
      confusions: [...pairs.values()].filter((p) => p.count > 1).sort((a, b) => b.count - a.count),
      usage,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ms: Date.now() - t0,
    });
  }

  const answeredAll = models.filter((m) => m.errors < m.cases);
  const missedByAll = answeredAll.length > 1 ? (answeredAll[0]!.misses.filter((m) => answeredAll.every((x) => x.misses.some((y) => y.ask === m.ask)))) : [];
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const text = `${o.cases.length} request${o.cases.length === 1 ? '' : 's'} over ${o.tools.length} tool${o.tools.length === 1 ? '' : 's'}: ${models.map((m) => `${m.model} chose right ${pct(m.accuracy)}${m.errors ? ` (${m.errors} not answered)` : ''}`).join(', ')}.${missedByAll.length ? ` ${missedByAll.length} request${missedByAll.length === 1 ? ' was' : 's were'} missed by every model: look at those descriptions first.` : ''}`;
  return { tools: o.tools.length, cases: o.cases.length, models, missedByAll, text };
}
