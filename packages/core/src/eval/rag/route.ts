/**
 * Decision trees of an evaluation (planning/rag-testing.md R3): a metric runs only when another metric of the same sample
 * gave a result. `when` says on what ("faithfulness < 0.8", or { metric, lt }, or "faithfulness fails"), `unless` is its
 * opposite. Written on the metric's own entry, so a tree is a few lines of the evaluation:
 *
 *     metrics:
 *       - faithfulness
 *       - { type: context-recall,  when: "faithfulness < 0.8" }     # find out why it is unfaithful
 *       - { type: answer-relevance, unless: "faithfulness < 0.8" }  # otherwise check it answers the question
 *
 * Deterministic: the condition reads a number or a pass that is already computed; a metric that was not computed (n/a, a
 * missing input, skipped itself) makes the condition unmet, and the dependent metric says so instead of guessing. A skipped
 * metric is n/a (not a pass, not a fail, not in a mean). Metrics are run in stages, so a branch may depend on a branch; a
 * cycle is refused when the evaluation is checked. The judged cost of a branch not taken is never spent.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { canonicalMetricId } from './metric-registry.js';

type RouteOp = 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'ne';

interface RouteCondition {
  metric: string;
  /** Compare the metric's score … */
  op?: RouteOp;
  value?: number;
  /** … or its pass/fail. */
  passed?: boolean;
}

const OPS: Record<string, RouteOp> = { '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte', '==': 'eq', '=': 'eq', '!=': 'ne' };
const SYMBOL: Record<RouteOp, string> = { lt: '<', lte: '<=', gt: '>', gte: '>=', eq: '=', ne: '!=' };

/** A condition written as text ("faithfulness < 0.8", "context-recall fails", "faithfulness passes") or as an object; a string when it is not valid. */
export function parseCondition(v: unknown): RouteCondition | string {
  if (typeof v === 'string') {
    const t = v.trim();
    const cmp = /^([^\s<>=!]+)\s*(<=|>=|==|!=|<|>|=)\s*(-?\d+(?:\.\d+)?)$/.exec(t);
    if (cmp) return { metric: cmp[1]!, op: OPS[cmp[2]!]!, value: Number(cmp[3]) };
    const pass = /^(\S+)\s+(passes|passed|fails|failed)$/i.exec(t);
    if (pass) return { metric: pass[1]!, passed: /^pass/i.test(pass[2]!) };
    return `cannot read the condition "${t}": write it as "faithfulness < 0.8", "faithfulness passes" or "faithfulness fails"`;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const metric = typeof o.metric === 'string' ? o.metric.trim() : '';
    if (!metric) return 'a condition needs "metric": the metric whose result decides';
    for (const op of Object.keys(SYMBOL) as RouteOp[])
      if (typeof o[op] === 'number') return { metric, op, value: o[op] as number };
    if (typeof o.passed === 'boolean') return { metric, passed: o.passed };
    return `the condition on ${metric} needs one of lt, lte, gt, gte, eq, ne (a number) or passed (true or false)`;
  }
  return 'a condition is text ("faithfulness < 0.8") or { metric, lt }';
}

const describeCondition = (c: RouteCondition) => (c.passed !== undefined ? `${c.metric} ${c.passed ? 'passes' : 'fails'}` : `${c.metric} ${SYMBOL[c.op!]} ${c.value}`);

/** The route of a metric entry: its condition and whether it is negated (`unless`); undefined when it has none. */
function routeOf(cfg: CheckConfig): { cond: RouteCondition; negate: boolean } | undefined | string {
  const raw = cfg.when ?? cfg.unless;
  if (raw === undefined) return undefined;
  if (cfg.when !== undefined && cfg.unless !== undefined) return 'a metric has either "when" or "unless", not both';
  const cond = parseCondition(raw);
  return typeof cond === 'string' ? cond : { cond, negate: cfg.when === undefined };
}

const nameOf = (c: CheckConfig) => c.name ?? c.type;

/** The entry of the evaluation a condition refers to: by the column name first, else by the canonical metric id. */
function target(configs: CheckConfig[], metric: string): CheckConfig | undefined {
  return configs.find((c) => nameOf(c) === metric) ?? configs.find((c) => canonicalMetricId(c.type) === canonicalMetricId(metric));
}

/** What is wrong with the routes of an evaluation's metrics (empty: it can run): unreadable conditions, unknown metrics, cycles. */
export function routeProblems(configs: CheckConfig[]): string[] {
  const out: string[] = [];
  const deps = new Map<CheckConfig, CheckConfig>();
  for (const c of configs) {
    const r = routeOf(c);
    if (r === undefined) continue;
    if (typeof r === 'string') {
      out.push(`${nameOf(c)}: ${r}`);
      continue;
    }
    const t = target(configs, r.cond.metric);
    if (!t) out.push(`${nameOf(c)} depends on "${r.cond.metric}", which is not a metric of this evaluation`);
    else if (t === c) out.push(`${nameOf(c)} depends on itself`);
    else deps.set(c, t);
  }
  for (const start of deps.keys()) {
    const seen = new Set<CheckConfig>([start]);
    for (let at = deps.get(start); at; at = deps.get(at)) {
      if (at === start) {
        out.push(`the metrics ${[...seen].map(nameOf).join(' → ')} depend on each other in a circle`);
        break;
      }
      if (seen.has(at)) break;
      seen.add(at);
    }
  }
  return [...new Set(out)];
}

export const hasRoute = (c: CheckConfig) => c.when !== undefined || c.unless !== undefined;

/** A result that says why a routed metric was not run. */
const skipped = (c: CheckConfig, why: string, route: Record<string, unknown>): CheckResult => ({
  type: c.type,
  name: nameOf(c),
  passed: true,
  source: 'deterministic',
  message: `${canonicalMetricId(c.type)} is n/a: ${why}`,
  metadata: { na: 'route', metric: canonicalMetricId(c.type), route },
});

const holds = (c: RouteCondition, r: CheckResult): boolean | undefined => {
  const na = (r.metadata as { na?: unknown } | undefined)?.na;
  if (na) return undefined;
  if (c.passed !== undefined) return r.passed === c.passed;
  if (typeof r.score !== 'number') return undefined;
  const v = c.value!;
  switch (c.op) {
    case 'lt':
      return r.score < v;
    case 'lte':
      return r.score <= v;
    case 'gt':
      return r.score > v;
    case 'gte':
      return r.score >= v;
    case 'eq':
      return r.score === v;
    default:
      return r.score !== v;
  }
};

/**
 * Runs the routed metrics in stages after the plain ones: `known` holds the results already computed (keyed by entry);
 * `run` computes the entries whose condition holds (the caller's way of running checks); the rest are skipped, with the reason.
 */
export async function runRouted(routed: CheckConfig[], all: CheckConfig[], known: Map<CheckConfig, CheckResult>, run: (cs: CheckConfig[]) => Promise<CheckResult[]>): Promise<void> {
  let pending = [...routed];
  while (pending.length) {
    // an entry is ready when what it depends on has a result; a dependency that is itself pending waits for the next stage
    const ready = pending.filter((c) => {
      const r = routeOf(c);
      const t = typeof r === 'object' ? target(all, r.cond.metric) : undefined;
      return !t || known.has(t);
    });
    // a cycle (refused when the evaluation is checked) is skipped here rather than looping
    const batch = ready.length ? ready : pending;
    const toRun: CheckConfig[] = [];
    for (const c of batch) {
      const r = routeOf(c);
      if (typeof r === 'string') {
        known.set(c, skipped(c, r, { error: r }));
        continue;
      }
      const t = r ? target(all, r.cond.metric) : undefined;
      const dep = t ? known.get(t) : undefined;
      if (!r || !dep) {
        known.set(c, skipped(c, r ? `the metric it depends on (${r.cond.metric}) was not computed` : 'no condition', { condition: r ? describeCondition(r.cond) : '' }));
        continue;
      }
      const ok = holds(r.cond, dep);
      const text = `${r.negate ? 'unless' : 'when'} ${describeCondition(r.cond)}`;
      if (ok === undefined) known.set(c, skipped(c, `${r.cond.metric} gave no ${r.cond.passed !== undefined ? 'result' : 'score'} to decide on (${text})`, { condition: text }));
      else if (ok === r.negate) known.set(c, skipped(c, `skipped, the condition (${text}) did not hold${typeof dep.score === 'number' ? ` — ${r.cond.metric} is ${dep.score}` : ''}`, { condition: text, [r.cond.metric]: dep.score ?? null }));
      else toRun.push(c);
    }
    if (toRun.length) {
      const results = await run(toRun);
      toRun.forEach((c, i) => {
        const res = results[i]!;
        const r = routeOf(c);
        known.set(c, typeof r === 'object' ? { ...res, metadata: { ...(res.metadata ?? {}), route: { condition: `${r.negate ? 'unless' : 'when'} ${describeCondition(r.cond)}` } } } : res);
      });
    }
    pending = pending.filter((c) => !known.has(c));
  }
}
