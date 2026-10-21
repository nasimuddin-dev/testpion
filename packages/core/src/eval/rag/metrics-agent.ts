/**
 * Agent and tool-use metrics (planning/rag-testing.md §2.3 type 10), beyond Ragas' tool-call accuracy and F1 in
 * metrics-more.ts. Deterministic where the answer is a comparison of lists: `trajectory-match` (strict, in-order, any-order,
 * precision, recall) and `tool-correctness`. Judged where it takes a reading of the run: argument correctness, tool
 * selection, Ragas' agent goal accuracy (with and without a reference), task completion, step efficiency, plan adherence and
 * quality, and the two MCP metrics. They read the trace (agent-trace.ts): a target that calls MCP tools or returns its tool
 * calls maps them, a conversation run keeps them per turn.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { registerCheck, type CheckContext } from '../checks.js';
import { callsOf, hasToolCalls, traceOf, type TraceStep } from './agent-trace.js';
import { addUsage, assertJudgeUsable, guarded, judgeMeta, judgePanel, judgedCheck, na, needsField, noUsage, panelOf, referenceText, round3, meets, single, type Usage } from './judged-kit.js';
import type { JudgedMetric } from './judge-prompts.js';
import { ARGUMENT_CORRECTNESS, GOAL_INFER, goalCompare, MCP_TASK_COMPLETION, MCP_USE, PLAN_ADHERENCE, PLAN_QUALITY, STEP_EFFICIENCY, TASK_COMPLETION, toolSelection } from './prompts-agent.js';
import { num, result } from './metric-util.js';
import type { RagToolCall } from './record.js';
import { frozen } from './metrics-more.js';

const NEED_CALLS = 'map the tool calls in the RAG target (click the list of tool calls in the sample response), use an MCP target, or add a "tool_calls" column for offline scoring.';

const callsFromConfig = (v: unknown): RagToolCall[] | undefined =>
  Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? { name: x, arguments: {} } : { name: String((x as RagToolCall).name ?? ''), arguments: ((x as RagToolCall).arguments ?? {}) as Record<string, unknown> })).filter((c) => c.name) : undefined;

/** The expected calls: the check's `expected`, else the record's reference_tool_calls. */
const expectedCalls = (cfg: CheckConfig, ctx: CheckContext) => callsFromConfig(cfg.expected) ?? ctx.record?.referenceToolCalls;

/* ------------------------------------------------------------------ trajectory-match */

type Mode = 'strict' | 'in-order' | 'any-order' | 'precision' | 'recall';
const MODES: Mode[] = ['strict', 'in-order', 'any-order', 'precision', 'recall'];

/** The size of the multiset intersection of two key lists (each expected key matches one made key). */
function overlap(made: string[], expected: string[]): number {
  const left = [...made];
  let n = 0;
  for (const e of expected) {
    const at = left.indexOf(e);
    if (at >= 0) {
      left.splice(at, 1);
      n++;
    }
  }
  return n;
}

registerCheck('trajectory-match', (cfg, ctx) => {
  const ref = expectedCalls(cfg, ctx);
  if (!ref) return result(cfg, false, 'trajectory-match needs the expected tool calls: add a "reference_tool_calls" column (a list of { name, arguments }) or set "expected" on the check.', { explanation: 'No reference tool calls.' });
  const mode = (MODES.includes(cfg.mode as Mode) ? cfg.mode : 'in-order') as Mode;
  const withArgs = cfg.args === 'exact';
  const key = (c: RagToolCall) => (withArgs ? frozen(c) : c.name);
  const made = callsOf(ctx).map(key);
  const want = ref.map(key);
  const t = num(cfg.threshold, mode === 'precision' || mode === 'recall' ? 0.8 : 1);
  if (!made.length && !want.length) return result(cfg, true, 'trajectory-match 1: no tool call expected and none made', { score: 1, metadata: { threshold: t, mode } });
  let score: number;
  if (mode === 'strict') score = made.length === want.length && made.every((m, i) => m === want[i]) ? 1 : 0;
  else if (mode === 'in-order') {
    let i = 0;
    for (const m of made) if (i < want.length && m === want[i]) i++;
    score = i === want.length ? 1 : 0;
  } else if (mode === 'any-order') score = overlap(made, want) === want.length ? 1 : 0;
  else if (mode === 'precision') score = made.length ? overlap(made, want) / made.length : 0;
  else score = want.length ? overlap(made, want) / want.length : 0;
  score = round3(score);
  const exp = ref.map(frozen);
  return result(cfg, score >= t, `trajectory ${mode} ${score}: made ${made.join(' → ') || '(none)'}, expected ${want.join(' → ')}${withArgs ? ' (with arguments)' : ''} (threshold ${t})`, {
    source: 'deterministic',
    score,
    expected: exp,
    actual: callsOf(ctx).map(frozen),
    metadata: { mode, args: withArgs ? 'exact' : 'ignore', threshold: t, items: want.map((w) => ({ text: w, ok: made.includes(w), evidence: made.includes(w) ? 'called' : 'not called' })), itemLabels: ['called', 'missing'] },
  });
});

/* ------------------------------------------------------------------ tool-correctness (DeepEval) */

/** The longest common subsequence of two key lists (the calls that came in the expected order). */
function lcs(a: string[], b: string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = x === b[j - 1] ? prev + 1 : Math.max(row[j]!, row[j - 1]!);
      prev = tmp;
    }
  }
  return row[b.length]!;
}

registerCheck('tool-correctness', (cfg, ctx) => {
  const ref = expectedCalls(cfg, ctx);
  if (!ref) return result(cfg, false, 'tool-correctness needs the expected tool calls: add a "reference_tool_calls" column or set "expected" on the check.', { explanation: 'No reference tool calls.' });
  const calls = callsOf(ctx);
  const t = num(cfg.threshold, 0.8);
  const params = cfg.params === true;
  const key = (c: RagToolCall) => (params ? frozen(c) : c.name);
  const made = calls.map(key);
  const want = ref.map(key);
  if (!made.length && !want.length) return result(cfg, true, 'tool-correctness 1: no tool call expected and none made', { score: 1, metadata: { threshold: t } });
  let score: number;
  if (cfg.exactMatch === true) score = made.length === want.length && made.every((m, i) => m === want[i]) ? 1 : 0;
  else if (!made.length) score = 0;
  else score = (cfg.ordering === true ? lcs(made, want) : overlap(made, want)) / made.length;
  score = round3(score);
  return result(cfg, score >= t, `tool-correctness ${score}: ${made.length ? `${Math.round(score * made.length)} of ${made.length} tools called were expected` : 'no tool was called'}${cfg.ordering === true ? ' (in order)' : ''} (threshold ${t})`, {
    source: 'deterministic',
    score,
    expected: ref.map(frozen),
    actual: calls.map(frozen),
    metadata: { threshold: t, exactMatch: cfg.exactMatch === true, ordering: cfg.ordering === true, params, items: made.map((m) => ({ text: m, ok: want.includes(m), evidence: want.includes(m) ? 'expected' : 'not expected' })), itemLabels: ['expected', 'not expected'] },
  });
});

/* ------------------------------------------------------------------ judged metrics over the trace */

const traceInput = (steps: TraceStep[]) => steps;

/** A judged check over the trace of the run; `calls` demands tool calls in it, `extra` adds fields (available tools …). */
function traceCheck(spec: { id: string; threshold: number; metric: (cfg: CheckConfig) => JudgedMetric; needsCalls?: boolean; extra?: (cfg: CheckConfig, ctx: CheckContext) => Record<string, unknown> }) {
  return async (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> => {
    const steps = traceOf(ctx);
    if (!steps.length) return needsField(cfg, spec.id, 'the run to judge', 'run the evaluation against a RAG target (it provides the question and answer), or add the question and answer columns.');
    if (spec.needsCalls && !hasToolCalls(steps)) return needsField(cfg, spec.id, 'the tool calls', NEED_CALLS);
    return judgedCheck({ metric: spec.metric(cfg), id: spec.id, threshold: spec.threshold, input: (c, x) => ({ trace: traceInput(steps), ...(spec.extra?.(c, x) ?? {}) }), emptyWhy: 'the run has nothing to judge' })(cfg, ctx);
  };
}

registerCheck('argument-correctness', traceCheck({ id: 'argument-correctness', threshold: 0.8, metric: () => ARGUMENT_CORRECTNESS, needsCalls: true }));
registerCheck(
  'tool-selection',
  traceCheck({
    id: 'tool-selection',
    threshold: 0.8,
    needsCalls: true,
    metric: (cfg) => toolSelection(['selection', 'invocation', 'handling'].includes(String(cfg.aspect)) ? (cfg.aspect as 'selection' | 'invocation' | 'handling') : 'selection'),
  }),
);
registerCheck('task-completion', traceCheck({ id: 'task-completion', threshold: 0.6, metric: () => TASK_COMPLETION }));
registerCheck('step-efficiency', traceCheck({ id: 'step-efficiency', threshold: 0.6, metric: () => STEP_EFFICIENCY, needsCalls: true }));
registerCheck('plan-adherence', traceCheck({ id: 'plan-adherence', threshold: 0.6, metric: () => PLAN_ADHERENCE }));
registerCheck('plan-quality', traceCheck({ id: 'plan-quality', threshold: 0.6, metric: () => PLAN_QUALITY }));
const availableTools = (cfg: CheckConfig) => (Array.isArray(cfg.tools) ? cfg.tools.slice(0, 60).map((t) => (typeof t === 'string' ? { name: t } : { name: String((t as { name?: unknown }).name ?? ''), description: String((t as { description?: unknown }).description ?? '').slice(0, 300) })) : undefined);
registerCheck('mcp-use', traceCheck({ id: 'mcp-use', threshold: 0.6, metric: () => MCP_USE, needsCalls: true, extra: (cfg) => ({ ...(availableTools(cfg) ? { availableTools: availableTools(cfg) } : {}) }) }));
registerCheck('mcp-task-completion', traceCheck({ id: 'mcp-task-completion', threshold: 0.8, metric: () => MCP_TASK_COMPLETION, needsCalls: true }));

/* ------------------------------------------------------------------ goal accuracy (Ragas AgentGoalAccuracy) */

/** Two judge calls: what the user wanted and where the run ended, then whether the end state achieves the goal (or the expected outcome). */
registerCheck('goal-accuracy', async (cfg, ctx) => {
  const steps = traceOf(ctx);
  if (!steps.length) return needsField(cfg, 'goal-accuracy', 'the run to judge', 'run the evaluation against a RAG target, or add the question and answer columns.');
  const outcome = ctx.record?.expectedOutcome ?? referenceText(cfg, ctx);
  const wantRef = cfg.reference === true || (cfg.reference !== false && !!outcome);
  if (wantRef && !outcome) return needsField(cfg, 'goal-accuracy', 'the expected outcome', 'add an "expected_outcome" column (or "reference"), or set "reference: false" to judge against the goal the user had.');
  const compare = goalCompare(wantRef);
  return guarded(cfg, ctx, compare, async (host) => {
    const t = num(cfg.threshold, 1);
    const panel = panelOf(cfg, ctx, t);
    assertJudgeUsable(host, panel.judges?.[0] ?? panel.judge);
    // step 1 (one judge, once): the goal and the end state, in the judge's words
    const r1 = await judgePanel(host, GOAL_INFER, { trace: steps }, single(panel));
    const goal = r1.items.find((i) => /goal/i.test(i.text))?.evidence ?? '';
    const endState = r1.items.find((i) => /end/i.test(i.text))?.evidence ?? '';
    if (!endState.trim()) return na(cfg, compare, 'the judge could not tell where the run ended', { explanation: r1.reasoning });
    const input = wantRef ? { endState, expectedOutcome: outcome } : { goal, endState };
    const r2 = await judgePanel(host, compare, input, panel);
    if (r2.score === undefined) return na(cfg, compare, 'the judge returned no verdict', { explanation: r2.reasoning, metadata: judgeMeta(compare, r2, t) });
    const score = round3(r2.score);
    const usage: Usage = addUsage(addUsage(noUsage(), r1.usage), r2.usage);
    const passed = meets(score, t, 'higher') && !r2.panel?.swap?.tie;
    return result(cfg, passed, `goal-accuracy ${score}${wantRef ? ' against the expected outcome' : ''}: ${r2.items[0]?.evidence ?? ''} (threshold ${t})`, {
      source: 'ai-judge',
      score,
      explanation: r2.reasoning,
      metadata: judgeMeta(compare, { ...r2, usage }, t, { promptVersion: compare.version, mode: wantRef ? 'with-reference' : 'without-reference', goal, endState }),
    });
  });
});
