/**
 * What each kind of custom metric computes (planning/rag-testing.md §4d): the check function a metric file compiles to. The
 * judge and checklist kinds are judge templates, the rule kind reuses the deterministic checks, the formula kind runs other
 * metrics and evaluates an expression over their scores, the embedding-set kind reuses the reference-set check, and the
 * script kind runs in the QuickJS sandbox (no network, no files, a second of CPU, 32 MB, 64 KB of result).
 */
import type { CustomMetricFile } from '@testpion/shared';
import type { CheckConfig, CheckResult } from '../../../model/types.js';
import { checkFn, runChecks, type CheckContext } from '../../checks.js';
import { runMetricScript } from '../../../scripts/sandbox.js';
import { na } from '../judged-kit.js';
import { runTemplate, type Template, type TemplateInput } from '../judge-templates.js';
import { metricToCheck, resolveMetric } from '../metric-registry.js';
import { num, result } from '../metric-util.js';
import { round3 } from '../measures.js';
import { evalFormula, parseFormula, type Value } from './formula.js';

export type CustomCheck = (cfg: CheckConfig, ctx: CheckContext) => Promise<CheckResult>;

const inputsOf = (f: CustomMetricFile): TemplateInput[] => {
  const given = (f.inputs ?? ['question', 'answer']).filter((i): i is TemplateInput => ['question', 'answer', 'reference', 'contexts', 'conversation'].includes(i));
  if (f.reference === 'guided' && !given.includes('reference')) given.push('reference');
  return given;
};

export const defaultThreshold = (f: CustomMetricFile): number => f.threshold ?? (f.kind === 'judge' ? (f.scale === undefined || f.scale === 'binary' ? 1 : 0.6) : f.kind === 'checklist' ? 0.8 : f.kind === 'dag' ? 0.5 : 1);

/** The judge a file names, in the form the judged checks read. */
const withJudge = (cfg: CheckConfig, f: CustomMetricFile): CheckConfig => (f.judge?.provider && !cfg.judge ? { ...cfg, judge: { provider: f.judge.provider, model: f.judge.model } } : cfg);

export function templateOf(f: CustomMetricFile): Template {
  const id = `custom/${f.id}`;
  if (f.kind === 'checklist') return { id, kind: 'checklist', items: (f.items ?? []).map((i) => (typeof i === 'string' ? { text: i } : i)), inputs: inputsOf(f) };
  const scale = f.scale;
  if (Array.isArray(scale)) return { id, kind: 'scale', criteria: f.criteria ?? '', min: scale[0], max: scale[1], anchors: f.anchors ? Object.fromEntries(Object.entries(f.anchors).filter(([k]) => /^-?\d+$/.test(k)).map(([k, v]) => [Number(k), v])) : undefined, inputs: inputsOf(f) };
  return { id, kind: 'binary', criteria: f.criteria ?? '', pass: f.anchors?.pass, fail: f.anchors?.fail, inputs: inputsOf(f) };
}

function judgeKind(f: CustomMetricFile): CustomCheck {
  return (cfg, ctx) => {
    const t = templateOf(f);
    return runTemplate(withJudge({ ...cfg, votes: cfg.votes ?? f.votes }, f), ctx, t, { threshold: num(cfg.threshold, defaultThreshold(f)), direction: f.direction });
  };
}

/** The tree is the built-in dag metric's: the same walk, the same judge calls, the same path in the result. */
function dagKind(f: CustomMetricFile): CustomCheck {
  return async (cfg, ctx) => {
    const fn = checkFn('dag')!;
    const r = await fn(withJudge({ ...cfg, type: 'dag', tree: f.tree, inputs: f.inputs ?? ['question', 'answer'], threshold: num(cfg.threshold, defaultThreshold(f)) }, f), ctx);
    return { ...r, type: cfg.type, name: cfg.name ?? r.name };
  };
}

function ruleKind(f: CustomMetricFile): CustomCheck {
  return async (cfg, ctx) => {
    const rules = f.rules ?? [];
    const results = await runChecks(
      rules.map((r) => ({ ...r }) as CheckConfig),
      ctx,
    );
    const weights = rules.map((r) => (typeof r.weight === 'number' && r.weight >= 0 ? r.weight : 1));
    const combine = f.combine ?? 'all';
    const passed = results.map((r) => r.passed);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const score = combine === 'any' ? (passed.some(Boolean) ? 1 : 0) : combine === 'weights' ? round3(passed.reduce((a, p, i) => a + (p ? weights[i]! : 0), 0) / total) : passed.every(Boolean) ? 1 : 0;
    const t = num(cfg.threshold, defaultThreshold(f));
    const items = results.map((r, i) => ({ text: `${rules[i]!.type}${rules[i]!.name ? ` (${String(rules[i]!.name)})` : ''}`, ok: r.passed, evidence: r.message.slice(0, 200) }));
    return result(cfg, f.direction === 'lower' ? score <= t : score >= t, `${passed.filter(Boolean).length} of ${passed.length} rules pass (${combine}): ${score} (threshold ${t})`, { source: 'deterministic', score, metadata: { items, itemLabels: ['passes', 'fails'], threshold: t, combine } });
  };
}

/** Formulas being computed for a sample: a formula that reaches itself again is refused (the file check refuses cycles too). */
const inProgress = new WeakMap<object, Set<string>>();

function formulaKind(f: CustomMetricFile): CustomCheck {
  const parsed = parseFormula(f.expression ?? '');
  return async (cfg, ctx) => {
    if (!parsed.ast) return result(cfg, false, `the formula is invalid: ${parsed.problems[0]}`);
    const running = inProgress.get(ctx) ?? new Set<string>();
    inProgress.set(ctx, running);
    const me = `custom/${f.id}`;
    if (running.has(me)) return result(cfg, false, `${me} reads itself through other formulas`);
    running.add(me);
    try {
      const values = new Map<string, Value>();
      const items: Array<{ text: string; ok: boolean; evidence: string }> = [];
      const sub = await Promise.all(
        parsed.refs.map(async (name) => {
          const r = resolveMetric(name);
          if (!r) return { name, res: undefined as CheckResult | undefined };
          // the metric runs exactly as it would on its own: its alias options, its own judge, the cache
          const [res] = await runChecks([metricToCheck(name)], ctx);
          return { name, res };
        }),
      );
      for (const { name, res } of sub) {
        const isNa = !res || typeof res.score !== 'number' || !!(res.metadata as { na?: string } | undefined)?.na;
        values.set(name, isNa ? null : res!.score!);
        items.push({ text: name, ok: !isNa, evidence: isNa ? (res ? 'no score: ' + res.message.slice(0, 160) : 'not a metric') : `score ${res!.score}` });
      }
      const v = evalFormula(parsed.ast, (n) => values.get(n) ?? null);
      const t = num(cfg.threshold, defaultThreshold(f));
      const judgeUsage = sub.reduce((a, s) => {
        const u = (s.res?.metadata as { judgeUsage?: { calls: number; inputTokens: number; outputTokens: number; costUsd: number; cached: boolean } } | undefined)?.judgeUsage;
        return u ? { calls: a.calls + u.calls, inputTokens: a.inputTokens + u.inputTokens, outputTokens: a.outputTokens + u.outputTokens, costUsd: a.costUsd + u.costUsd, cached: a.cached && u.cached } : a;
      }, { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, cached: true });
      if (v === null) {
        const missing = sub.filter((s) => values.get(s.name) === null).map((s) => s.name);
        return na(cfg, { id: me, version: `${f.id}-v${f.version ?? 1}` }, missing.length ? `${missing.join(', ')} had no score (use coalesce(x, fallback) to say what to use instead)` : 'the expression has no value', { metadata: { items, itemLabels: ['has a score', 'no score'], judgeUsage } });
      }
      const score = round3(v);
      return result(cfg, f.direction === 'lower' ? score <= t : score >= t, `${f.expression} = ${score} (threshold ${t})`, { source: judgeUsage.calls ? 'ai-judge' : 'deterministic', score, metadata: { items, itemLabels: ['has a score', 'no score'], threshold: t, ...(judgeUsage.calls || sub.some((s) => s.res?.metadata && (s.res.metadata as { judgeUsage?: unknown }).judgeUsage) ? { judgeUsage } : {}) } });
    } finally {
      running.delete(me);
    }
  };
}

function embeddingKind(f: CustomMetricFile): CustomCheck {
  return async (cfg, ctx) => {
    const fn = checkFn('reference-set-similarity')!;
    const r = await fn({ ...cfg, type: 'reference-set-similarity', good: f.good, negatives: f.negatives, aggregate: f.aggregate, negativeMax: f.negativeMax, embedder: cfg.embedder ?? f.embedder, threshold: num(cfg.threshold, defaultThreshold(f)) }, ctx);
    return { ...r, type: cfg.type };
  };
}

/** The sample a script sees. */
export function scriptSample(ctx: CheckContext) {
  return {
    question: ctx.question ?? '',
    answer: ctx.text ?? '',
    reference: typeof ctx.expected === 'string' ? ctx.expected : ctx.expected === undefined ? '' : JSON.stringify(ctx.expected),
    contexts: (ctx.contexts ?? []).map((d) => ({ id: d.id, text: d.text, ...(d.score !== undefined ? { score: d.score } : {}) })),
    referenceContexts: ctx.referenceContexts ?? [],
    referenceIds: ctx.referenceIds ?? [],
    toolCalls: ctx.toolCalls ?? [],
    latencyMs: ctx.latencyMs ?? null,
    record: ctx.record ?? {},
  };
}

function scriptKind(f: CustomMetricFile): CustomCheck {
  return async (cfg, ctx) => {
    const me = { id: `custom/${f.id}`, version: `${f.id}-v${f.version ?? 1}` };
    const out = await runMetricScript(f.script ?? '', scriptSample(ctx), { options: {} });
    if (out.error) return na(cfg, me, `script error: ${out.error.split('\n')[0]}`, { metadata: { logs: out.logs } });
    const v = out.value as { score?: unknown; reason?: unknown; items?: unknown } | number | null;
    const score = typeof v === 'number' ? v : v && typeof v === 'object' ? (v as { score?: unknown }).score : undefined;
    if (typeof score !== 'number' || !Number.isFinite(score)) return na(cfg, me, 'script error: the script did not return a number as its score (return { score: 0.8, reason: "…" })', { metadata: { logs: out.logs } });
    const reason = v && typeof v === 'object' && typeof (v as { reason?: unknown }).reason === 'string' ? (v as { reason: string }).reason.slice(0, 500) : '';
    const rawItems = v && typeof v === 'object' && Array.isArray((v as { items?: unknown }).items) ? ((v as { items: unknown[] }).items) : [];
    const items = rawItems.slice(0, 50).map((i) => {
      const o = (i ?? {}) as { text?: unknown; ok?: unknown; evidence?: unknown };
      return { text: String(o.text ?? '').slice(0, 300), ok: o.ok !== false, evidence: String(o.evidence ?? '').slice(0, 300) };
    });
    const t = num(cfg.threshold, defaultThreshold(f));
    const s = round3(score);
    return result(cfg, f.direction === 'lower' ? s <= t : s >= t, `${s}${reason ? `: ${reason}` : ''} (threshold ${t})`, { source: 'heuristic', score: s, explanation: reason, metadata: { items, itemLabels: ['ok', 'not ok'], threshold: t, logs: out.logs } });
  };
}

export function checkOf(f: CustomMetricFile): CustomCheck {
  switch (f.kind) {
    case 'judge':
    case 'checklist':
      return judgeKind(f);
    case 'rule':
      return ruleKind(f);
    case 'formula':
      return formulaKind(f);
    case 'embedding-set':
      return embeddingKind(f);
    case 'script':
      return scriptKind(f);
    case 'dag':
      return dagKind(f);
  }
}
