/**
 * What every judged RAG check shares (planning/rag-testing.md §4c): reading the judge of a check, keeping the identity and
 * the usage of the judging with the result, saying a result in words, turning a judge failure or an exhausted budget into a
 * result instead of a throw, and one generic check (`judgedCheck`) for a metric that is one judged prompt over a few
 * fields of the sample. Metrics with several prompts (factual-correctness, noise sensitivity …) use the same pieces.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { checkFn, type CheckContext } from '../checks.js';
import type { JudgeRef, RagJudgeHost } from './judge.js';
import { assertJudgeUsable } from './judge.js';
import type { JudgedMetric } from './judge-prompts.js';
import { judgePanel, type PanelItem, type PanelOptions, type PanelResult } from './judge-panel.js';
import { num, result, short } from './metric-util.js';
import { round3 } from './measures.js';

export type JudgeHost = NonNullable<NonNullable<CheckContext['services']>['ragJudge']>;

/** A result that says why a metric was not computed: n/a is neither a pass nor a fail and is not counted in a mean. */
export const na = (cfg: CheckConfig, m: Pick<JudgedMetric, 'id' | 'version'>, why: string, extra: Partial<CheckResult> = {}): CheckResult =>
  result(cfg, true, `${m.id} is n/a: ${why}`, { source: 'ai-judge', explanation: why, ...extra, metadata: { na: why, metric: m.id, promptVersion: m.version, ...(extra.metadata ?? {}) } });

/** The judge of a check: its own `judge: { provider, model }` over the evaluation's, with the evaluation's panel options. */
export function panelOf(cfg: CheckConfig, ctx: CheckContext, threshold: number, direction: 'higher' | 'lower' = 'higher'): PanelOptions {
  const own = cfg.judge as { provider?: string; model?: string; name?: string } | undefined;
  const setup = ctx.judge ?? {};
  const judge: JudgeRef = { provider: setup.provider, model: setup.model, maxCostUsd: setup.maxCostUsd, maxCalls: setup.maxCalls, ...(own?.provider ? { provider: own.provider, model: own.model ?? own.name } : {}) };
  const judges = (Array.isArray(cfg.judges) ? cfg.judges : setup.judges) as JudgeRef[] | undefined;
  return {
    judge,
    ...(judges?.length ? { judges: judges.map((j) => ({ ...j, maxCostUsd: judge.maxCostUsd, maxCalls: judge.maxCalls })) } : {}),
    aggregate: (cfg.aggregate ?? setup.aggregate) as PanelOptions['aggregate'],
    swap: cfg.swap === undefined ? setup.swap : cfg.swap === true,
    repeat: num(cfg.repeat, setup.repeat ?? 1),
    threshold,
    direction,
    signal: ctx.services?.signal,
  };
}

export type Usage = PanelResult['usage'];
export const noUsage = (): Usage => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, cached: true });
export const addUsage = (a: Usage, b: Usage): Usage => ({ calls: a.calls + b.calls, inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, costUsd: Math.round((a.costUsd + b.costUsd) * 1e6) / 1e6, cached: a.cached && b.cached });

/** What every judged check keeps of its judging: the identity, the usage (apart from the system under test's), the panel. */
export function judgeMeta(m: Pick<JudgedMetric, 'id' | 'labels'>, r: PanelResult, t: number, extra: Record<string, unknown> = {}) {
  return {
    metric: m.id,
    judge: { ...r.judge, cached: r.usage.cached },
    judgeUsage: { calls: r.usage.calls, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costUsd: r.usage.costUsd, cached: r.usage.cached },
    itemLabels: m.labels,
    items: r.items,
    threshold: t,
    redactions: r.redactionCount,
    ...(r.panel ? { panel: r.panel } : {}),
    ...extra,
  };
}

export function describe(m: JudgedMetric, score: number, r: PanelResult, t: number, label = m.id): string {
  const ok = r.items.filter((i) => i.ok).length;
  const worse = r.items.filter((i) => !i.ok);
  const body = m.rating ? `mean rating of ${r.items.length} ${m.noun}` : `${ok} of ${r.items.length} ${m.noun} ${m.labels[0]}${worse.length ? `; ${m.labels[1]}: ${worse.slice(0, 3).map((i) => `"${short(i.text)}"`).join(', ')}${worse.length > 3 ? ` and ${worse.length - 3} more` : ''}` : ''}`;
  const tail = [r.panel?.swap?.tie ? 'the two orders disagree (a tie: not passed)' : '', r.panel?.repeat ? `repeated ${r.panel.repeat.n}×: flip rate ${r.panel.repeat.flipRate}` : '', r.panel?.judges ? `${r.panel.judges.length} judges (${r.panel.aggregate})` : ''].filter(Boolean);
  return `${label} ${score}: ${body}${tail.length ? ` [${tail.join('; ')}]` : ''} (threshold ${t})`;
}

/** Runs the body of a judged check: a judge failure or an exhausted budget is a result, not a throw. */
export async function guarded(cfg: CheckConfig, ctx: CheckContext, m: Pick<JudgedMetric, 'id' | 'version'>, run: (host: JudgeHost) => Promise<CheckResult>): Promise<CheckResult> {
  const host = ctx.services?.ragJudge;
  if (!host) return result(cfg, false, `${m.id} needs a judge model and none is available here.`, { source: 'ai-judge' });
  try {
    return await run(host);
  } catch (e) {
    const budget = (e as { details?: { budget?: boolean } }).details?.budget;
    return result(cfg, false, budget ? `${m.id} n/a: ${(e as Error).message}` : `judge failed: ${(e as Error).message}`, { source: 'ai-judge', metadata: { ...(budget ? { na: 'budget' } : {}), metric: m.id, promptVersion: m.version } });
  }
}

export const contextsInput = (ctx: CheckContext) => (ctx.contexts ?? []).map((d) => ({ id: d.id, text: d.text }));

export const needContexts = (cfg: CheckConfig, id: string) =>
  result(cfg, false, `${id} needs the retrieved contexts: in the RAG target, click the list of sources in the sample response and map it (or turn on the endpoint’s "return sources" option).`, { source: 'ai-judge', explanation: 'No retrieved contexts.' });

export const needsField = (cfg: CheckConfig, id: string, what: string, how: string) => result(cfg, false, `${id} needs ${what}: ${how}`, { source: 'ai-judge', explanation: `No ${what}.` });

/** Whether `score` meets `threshold` in the metric's direction. */
export const meets = (score: number, t: number, direction: 'higher' | 'lower') => (direction === 'lower' ? score <= t : score >= t);

/**
 * The names the older heuristic-or-`judge:` checks answer to: in a RAG target run (or a rescore, or Try) they are the
 * strict judged metric; anywhere else the older check answers as before.
 */
export const strictOver = (strict: (cfg: CheckConfig, ctx: CheckContext) => Promise<CheckResult>, legacy: ReturnType<typeof checkFn>) => (cfg: CheckConfig, ctx: CheckContext) => (ctx.ragRun?.strict || !legacy ? strict(cfg, ctx) : legacy(cfg, ctx));

/** The first judge of a panel (a claim pass asks one judge, once). */
export const single = (panel: PanelOptions): PanelOptions => ({ ...panel, judges: panel.judges?.slice(0, 1), swap: false, repeat: 1 });

/** The items of one claim pass, as text. */
export async function claimsPass(host: RagJudgeHost, m: JudgedMetric, input: Record<string, unknown>, panel: PanelOptions): Promise<{ claims: string[]; usage: Usage; redactions: number }> {
  const r = await judgePanel(host, m, input, single(panel));
  return { claims: r.items.map((i) => i.text), usage: r.usage, redactions: r.redactionCount };
}

export { assertJudgeUsable, round3, judgePanel };
export type { PanelOptions, PanelResult, JudgeRef, RagJudgeHost, PanelItem };

interface JudgedSpec {
  /** The prompt (a function when it depends on the check's options). */
  metric: JudgedMetric | ((cfg: CheckConfig, ctx: CheckContext) => JudgedMetric);
  /** The metric’s id in the matrix and in messages. */
  id: string;
  threshold: number;
  direction?: 'higher' | 'lower';
  /** What the sample must have (a message says how to supply it otherwise). */
  needs?: Array<'question' | 'answer' | 'contexts' | 'reference' | 'source' | 'referenceContexts'>;
  /** The fields the judge is shown. */
  input(cfg: CheckConfig, ctx: CheckContext): Record<string, unknown>;
  /** Extra metadata for the result. */
  extra?(cfg: CheckConfig, ctx: CheckContext, r: PanelResult): Record<string, unknown>;
  /** Turns the panel's score into the metric's (e.g. 1 − score for a lower-is-better reading). */
  map?(score: number): number;
  /** The words for an item whose score is n/a. */
  emptyWhy?: string;
}

const NEEDS_TEXT: Record<NonNullable<JudgedSpec['needs']>[number], [string, string]> = {
  question: ['the question', 'the dataset needs a "question" column.'],
  answer: ['the answer', 'the RAG target maps it, or the dataset has an "answer" column.'],
  contexts: ['the retrieved contexts', 'in the RAG target, click the list of sources in the sample response and map it.'],
  reference: ['a reference answer', 'add a "reference" column to the dataset (or set "expected" on the check).'],
  source: ['the source text', 'add a "source" column to the dataset.'],
  referenceContexts: ['the gold chunk texts', 'add a "reference_contexts" column to the dataset.'],
};

/** The reference answer of a check. */
export const referenceText = (cfg: CheckConfig, ctx: CheckContext): string | undefined => {
  const r = cfg.expected ?? ctx.expected;
  return r === undefined || r === null || r === '' ? undefined : typeof r === 'string' ? r : JSON.stringify(r);
};

/** A judged check made of one prompt: needs, one panel call, one score. */
export function judgedCheck(spec: JudgedSpec): (cfg: CheckConfig, ctx: CheckContext) => Promise<CheckResult> {
  return async (cfg, ctx) => {
    const m = typeof spec.metric === 'function' ? spec.metric(cfg, ctx) : spec.metric;
    return guarded(cfg, ctx, m, async (host) => {
      const direction = spec.direction ?? 'higher';
      for (const n of spec.needs ?? []) {
        const have = n === 'question' ? ctx.question?.trim() : n === 'answer' ? ctx.text?.trim() : n === 'contexts' ? ctx.contexts?.length : n === 'reference' ? referenceText(cfg, ctx) : n === 'source' ? ctx.record?.source : ctx.referenceContexts?.length;
        if (!have) return n === 'answer' ? na(cfg, m, 'the answer is empty') : needsField(cfg, spec.id, NEEDS_TEXT[n][0], NEEDS_TEXT[n][1]);
      }
      const t = num(cfg.threshold, spec.threshold);
      const panel = panelOf(cfg, ctx, t, direction);
      assertJudgeUsable(host, panel.judges?.[0] ?? panel.judge);
      const r = await judgePanel(host, m, spec.input(cfg, ctx), panel);
      if (r.score === undefined) return na(cfg, m, spec.emptyWhy ?? 'the judge found nothing to judge in the sample', { explanation: r.reasoning, metadata: judgeMeta(m, r, t) });
      const score = round3(spec.map ? spec.map(r.score) : r.score);
      const passed = meets(score, t, direction) && !r.panel?.swap?.tie;
      return result(cfg, passed, describe(m, score, r, t, spec.id), { source: 'ai-judge', score, explanation: r.reasoning, metadata: judgeMeta(m, r, t, { promptVersion: m.version, ...(spec.extra?.(cfg, ctx, r) ?? {}) }) });
    });
  };
}
