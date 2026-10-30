/**
 * The trajectory of an agent case (A-1): what the agent did, step by step — the question, each model call, each tool call with its
 * arguments and result, the final answer — and the checks about tools pinned to the step that decided them: green at the call that
 * satisfied "should call", red where a forbidden call happened, "never called" at the end when nothing did. Pure over one stored
 * result (`metadata.agent`, its checks), so the app, `testpion eval trajectory` and the MCP tool `eval_trajectory` read the same story.
 */
import { ApsError } from '../errors.js';
import type { CheckResult, TestResult } from '../model/types.js';
import { resolveRunRef } from '../runner/eval-matrix-runs.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { findEvalResult } from './report.js';

export interface TrajectoryPin {
  /** The check, as the run names it. */
  check: string;
  type: string;
  /** `ok`: met here; `bad`: broken here; `never`: nothing happened where nothing should (a met "never called"). */
  state: 'ok' | 'bad' | 'never';
  text: string;
}

export interface TrajectoryItem {
  id: string;
  kind: 'input' | 'model' | 'tool' | 'answer';
  /** The model call this belongs to (1, 2 …). */
  step?: number;
  title: string;
  detail?: string;
  /** A tool call that returned an error. */
  error?: boolean;
  tool?: { name: string; arguments: Record<string, unknown>; result: string; source: string; durationMs: number };
  pins: TrajectoryPin[];
}

export interface Trajectory {
  resultId: string;
  name: string;
  status: TestResult['status'];
  steps: number;
  modelCalls: number;
  /** `max-steps`: the agent was still calling tools when the step limit stopped it. */
  stoppedReason?: string;
  items: TrajectoryItem[];
  /** The checks about tools that did not land on a step (never called, a sequence, a count that held), at the end. */
  endPins: TrajectoryPin[];
  /** One sentence: how the agent got there. */
  text: string;
}

interface AgentCall {
  step: number;
  id?: string;
  name: string;
  source?: string;
  arguments: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  durationMs?: number;
}
interface AgentMeta {
  steps?: number;
  modelCalls?: number;
  stoppedReason?: string;
  rounds?: Array<{ step: number; text: string; calls: number }>;
  toolCalls?: AgentCall[];
}

/** The checks about tools: the ones a trajectory can pin. */
export const TOOL_CHECKS: ReadonlySet<string> = new Set(['tool-called', 'tool-not-called', 'allowed-tools', 'max-tool-calls', 'tool-sequence', 'tool-args-valid']);

const names = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);
const subset = (have: Record<string, unknown>, want: Record<string, unknown> | undefined): boolean => !want || Object.entries(want).every(([k, v]) => JSON.stringify(have?.[k]) === JSON.stringify(v));
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const times = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The pins of one tool check: where on the calls (an index into them) or at the end (-1). */
function pinsOf(c: CheckResult, calls: AgentCall[]): Array<{ at: number; pin: TrajectoryPin }> {
  const base = { check: c.name || c.type, type: c.type };
  const out: Array<{ at: number; pin: TrajectoryPin }> = [];
  const meta = (c.metadata ?? {}) as { tools?: unknown };
  switch (c.type) {
    case 'tool-called': {
      const e = (c.expected ?? {}) as { tool?: string; arguments?: Record<string, unknown> };
      const hits = calls.map((x, i) => (x.name === e.tool && subset(x.arguments, e.arguments) ? i : -1)).filter((i) => i >= 0);
      if (c.passed && hits.length) out.push({ at: hits[0]!, pin: { ...base, state: 'ok', text: `should call ${e.tool}: called here` } });
      else {
        const sameName = calls.map((x, i) => (x.name === e.tool ? i : -1)).filter((i) => i >= 0);
        if (sameName.length) for (const i of sameName) out.push({ at: i, pin: { ...base, state: 'bad', text: `should call ${e.tool}${e.arguments ? ` with ${short(JSON.stringify(e.arguments), 60)}` : ''}: the arguments differ` } });
        else out.push({ at: -1, pin: { ...base, state: 'bad', text: `should call ${e.tool}: never called` } });
      }
      break;
    }
    case 'tool-not-called': {
      const forbidden = new Set(names(meta.tools));
      const bad = calls.map((x, i) => (forbidden.has(x.name) ? i : -1)).filter((i) => i >= 0);
      if (bad.length) for (const i of bad) out.push({ at: i, pin: { ...base, state: 'bad', text: `should not call ${calls[i]!.name}: called here` } });
      else out.push({ at: -1, pin: { ...base, state: 'never', text: `${[...forbidden].join(', ') || 'the forbidden tools'}: never called (as it should be)` } });
      break;
    }
    case 'allowed-tools': {
      const allowed = new Set(names(c.expected));
      const bad = calls.map((x, i) => (!allowed.has(x.name) ? i : -1)).filter((i) => i >= 0);
      if (bad.length) for (const i of bad) out.push({ at: i, pin: { ...base, state: 'bad', text: `${calls[i]!.name} is outside the allow-list (${[...allowed].join(', ') || 'none'})` } });
      else out.push({ at: -1, pin: { ...base, state: 'ok', text: 'only allowed tools were used' } });
      break;
    }
    case 'max-tool-calls': {
      const max = Number((c.expected as { max?: number } | undefined)?.max ?? NaN);
      if (!c.passed && Number.isFinite(max) && calls.length > max) for (let i = max; i < calls.length; i++) out.push({ at: i, pin: { ...base, state: 'bad', text: `over the limit of ${times(max, 'tool call')}` } });
      else out.push({ at: -1, pin: { ...base, state: c.passed ? 'ok' : 'bad', text: c.message } });
      break;
    }
    case 'tool-args-valid': {
      const bad = c.passed ? [] : calls.map((x, i) => (c.message.includes(`${x.name}:`) ? i : -1)).filter((i) => i >= 0);
      if (bad.length) for (const i of bad) out.push({ at: i, pin: { ...base, state: 'bad', text: "the arguments do not match the tool's schema" } });
      else out.push({ at: -1, pin: { ...base, state: c.passed ? 'ok' : 'bad', text: c.message } });
      break;
    }
    default:
      out.push({ at: -1, pin: { ...base, state: c.passed ? 'ok' : 'bad', text: c.message } });
  }
  return out;
}

/** The trajectory of a stored agent result, or undefined when the result is not an agent case (it has no stored steps). */
export function trajectoryOf(r: TestResult): Trajectory | undefined {
  const agent = (r.metadata as { agent?: AgentMeta } | undefined)?.agent;
  if (!agent) return undefined;
  const calls = agent.toolCalls ?? [];
  // an older run stored no model rounds: the steps are rebuilt from the calls (the model's words are not there)
  const rounds = agent.rounds ?? [...new Set(calls.map((c) => c.step))].map((step) => ({ step, text: '', calls: calls.filter((c) => c.step === step).length }));
  const items: TrajectoryItem[] = [];
  const toolItems: TrajectoryItem[] = [];
  if (r.input) items.push({ id: 'input', kind: 'input', title: 'The question', detail: r.input, pins: [] });
  for (const round of rounds) {
    const here = calls.filter((c) => c.step === round.step);
    items.push({
      id: `model-${round.step}`,
      kind: 'model',
      step: round.step,
      title: here.length ? `Model call ${round.step}: asks for ${here.map((c) => c.name).join(', ')}` : `Model call ${round.step}: answers`,
      ...(round.text ? { detail: round.text } : {}),
      pins: [],
    });
    for (const c of here) {
      const it: TrajectoryItem = {
        id: `tool-${calls.indexOf(c)}`,
        kind: 'tool',
        step: round.step,
        title: `${c.name}(${short(JSON.stringify(c.arguments ?? {}), 80)})`,
        detail: c.result,
        ...(c.isError ? { error: true } : {}),
        tool: { name: c.name, arguments: c.arguments ?? {}, result: c.result ?? '', source: c.source ?? 'unknown', durationMs: c.durationMs ?? 0 },
        pins: [],
      };
      items.push(it);
      toolItems[calls.indexOf(c)] = it;
    }
  }
  items.push({ id: 'answer', kind: 'answer', title: agent.stoppedReason === 'max-steps' ? 'Stopped at the step limit' : 'The final answer', ...(r.output ? { detail: r.output } : {}), pins: [] });
  const endPins: TrajectoryPin[] = [];
  for (const c of r.checks ?? []) {
    if (!TOOL_CHECKS.has(c.type)) continue;
    for (const { at, pin } of pinsOf(c, calls)) (at >= 0 && toolItems[at] ? toolItems[at]!.pins : endPins).push(pin);
  }
  const used = calls.map((c) => c.name);
  const modelCalls = agent.modelCalls ?? rounds.length;
  const text = `${used.length ? `${times(used.length, 'tool call')} (${used.join(' → ')})` : 'No tool was called'} in ${times(modelCalls, 'model call')}${agent.stoppedReason === 'max-steps' ? '; stopped at the step limit' : ''}.`;
  return {
    resultId: r.id,
    name: r.name,
    status: r.status,
    steps: agent.steps ?? rounds.length,
    modelCalls,
    ...(agent.stoppedReason ? { stoppedReason: agent.stoppedReason } : {}),
    items,
    endPins,
    text,
  };
}

/** The trajectory of one case of a run: the run (its id, "last" or an evaluation name) and the case (its result id, key or name). */
export async function evalTrajectory(store: WorkspaceStore, o: { run: string; case: string }): Promise<Trajectory> {
  const ref = resolveRunRef(store, o.run);
  const r = await findEvalResult(store, ref.runId, o.case);
  const t = trajectoryOf(r);
  if (!t) throw new ApsError('ValidationError', `Case ${o.case} is not an agent case: only an agent keeps the steps it took`, { suggestions: ['Take a case of an agent evaluation (testpion eval summary <run> --json lists the failed cases).'] });
  return t;
}
