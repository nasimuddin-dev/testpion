/**
 * The judge panel (planning/rag-testing.md §4c): ONE judged metric of ONE sample asked of one judge, a jury, in both
 * orders (`swap`) and/or several times (`repeat`), and the result combined into a single score with the evidence of how
 * the judges agreed:
 *
 *  - a jury (`judges`): each judge scores the sample; `aggregate` is `majority` (default: the pass/fail most judges give,
 *    scored as the mean of the judges on that side), `mean` or `min`;
 *  - `swap`: the documents are judged in their order and in the opposite order (position bias); when the two disagree on
 *    pass or fail the sample is a tie, which is not a pass;
 *  - `repeat: n`: n answers per judge, the first from the cache and the rest asked again, so the result reports the mean,
 *    the standard deviation and the flip rate (the share of items whose verdict was not the same every time).
 *
 * Pure orchestration over `judgeCall`: the cache, the ledger, the caps and Local only are the judge service's.
 */
import { mean, stdev as sd } from '../../util/stats.js';
import { round3 } from './measures.js';
import { judgeCall, type JudgeAnswer, type JudgeRef, type RagJudgeHost } from './judge.js';
import type { JudgedMetric, Verdict } from './judge-prompts.js';

export interface PanelOptions {
  /** The single judge, or the first of a jury's when `judges` is empty; also carries the run's limits. */
  judge: JudgeRef;
  judges?: JudgeRef[];
  aggregate?: 'majority' | 'mean' | 'min';
  swap?: boolean;
  repeat?: number;
  threshold: number;
  /** `lower`: a score at or under the threshold passes (hallucination, noise sensitivity). */
  direction?: 'higher' | 'lower';
  signal?: AbortSignal;
}

export interface PanelItem {
  text: string;
  ok: boolean;
  evidence: string;
  rating?: number;
}

export interface PanelResult {
  /** undefined: nothing to judge (no items from any judge). */
  score?: number;
  passed: boolean;
  items: PanelItem[];
  reasoning: string;
  /** The identity of the first judge, and every judge's score when there was a jury. */
  judge: JudgeAnswer['judge'];
  usage: { calls: number; inputTokens: number; outputTokens: number; costUsd: number; cached: boolean };
  redactionCount: number;
  panel?: {
    judges?: Array<{ provider: string; model: string; score?: number; passed: boolean }>;
    aggregate?: string;
    swap?: { scores: Array<number | undefined>; tie: boolean };
    repeat?: { n: number; scores: number[]; mean: number; sd: number; flipRate: number };
  };
}

/** A verdict's score: the share of true verdicts, or the mean rating over its maximum. */
function scoreOf(v: Verdict, metric: JudgedMetric): number | undefined {
  if (!v.items.length) return undefined;
  if (metric.scorer) return metric.scorer(v.items);
  // a weighted checklist: the weights belong to the items in the order they were asked; a verdict with another count is not weighted
  const w = metric.weights && metric.weights.length === v.items.length ? metric.weights : undefined;
  const weight = (i: number) => w?.[i] ?? 1;
  const total = v.items.reduce((a, _, i) => a + weight(i), 0);
  if (!total) return undefined;
  if (metric.ratingScores) return round3(v.items.reduce((a, it, i) => a + weight(i) * (metric.ratingScores![it.rating ?? 0] ?? 0), 0) / total);
  if (metric.rating) {
    const min = metric.ratingMin ?? 0;
    return round3(v.items.reduce((a, it, i) => a + weight(i) * Math.max(0, Math.min(1, ((it.rating ?? min) - min) / (metric.rating! - min))), 0) / total);
  }
  return round3(v.items.reduce((a, it, i) => a + (it.verdict ? weight(i) : 0), 0) / total);
}

const meets = (score: number, t: number, lower?: boolean) => (lower ? score <= t : score >= t);

const toItems = (v: Verdict): PanelItem[] => v.items.map((i) => ({ text: i.text.slice(0, 500), ok: i.verdict, evidence: i.reason.slice(0, 300), ...(i.rating !== undefined ? { rating: i.rating } : {}) }));


/** The share of items (matched by their text) whose verdict was not the same in every run. */
function flipRate(runs: Verdict[]): number {
  if (runs.length < 2) return 0;
  const key = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
  const by = new Map<string, boolean[]>();
  for (const r of runs) for (const i of r.items) (by.get(key(i.text)) ?? by.set(key(i.text), []).get(key(i.text))!).push(i.verdict);
  const full = [...by.values()].filter((v) => v.length === runs.length);
  return full.length ? round3(full.filter((v) => v.some((x) => x !== v[0])).length / full.length) : 0;
}

/** The input with the documents in the opposite order (position bias); undefined when the metric reads no documents. */
function reversed(metric: JudgedMetric, input: Record<string, unknown>): Record<string, unknown> | undefined {
  if (metric.rankAware || !metric.inputs.includes('contexts') || !Array.isArray(input.contexts) || input.contexts.length < 2) return undefined;
  return { ...input, contexts: [...(input.contexts as unknown[])].reverse() };
}

export async function judgePanel(host: RagJudgeHost, metric: JudgedMetric, input: Record<string, unknown>, o: PanelOptions): Promise<PanelResult> {
  const judges = o.judges?.length ? o.judges : [o.judge];
  // the run's limits belong to the run, whichever judge is asked
  const limits = { maxCostUsd: o.judge.maxCostUsd, maxCalls: o.judge.maxCalls };
  const repeat = Math.max(1, Math.min(10, Math.floor(o.repeat ?? 1)));
  const lower = o.direction === 'lower';
  const swapped = o.swap ? reversed(metric, input) : undefined;
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, cached: true };
  let redactionCount = 0;
  let first: JudgeAnswer | undefined;
  const take = (a: JudgeAnswer) => {
    first ??= a;
    usage.calls += a.usage.calls;
    usage.inputTokens += a.usage.inputTokens;
    usage.outputTokens += a.usage.outputTokens;
    usage.costUsd += a.usage.costUsd ?? 0;
    usage.cached &&= a.cached;
    redactionCount = Math.max(redactionCount, a.redactionCount);
  };
  const per = await Promise.all(
    judges.map(async (j) => {
      const ref: JudgeRef = { ...j, ...limits };
      // the asked runs: every order, repeated; the first of the normal order may come from the cache, the rest never do
      const normal: Verdict[] = [];
      for (let r = 0; r < repeat; r++) {
        const a = await judgeCall(host, metric, input, { judge: ref, signal: o.signal, fresh: r > 0 });
        take(a);
        normal.push(a.verdict);
      }
      const other: Verdict[] = [];
      if (swapped) {
        for (let r = 0; r < repeat; r++) {
          const a = await judgeCall(host, metric, swapped, { judge: ref, signal: o.signal, fresh: r > 0 });
          take(a);
          other.push(a.verdict);
        }
      }
      const scores = (vs: Verdict[]) => vs.map((v) => scoreOf(v, metric)).filter((s): s is number => s !== undefined);
      const a = scores(normal);
      const b = scores(other);
      const all = [...a, ...b];
      const score = all.length ? round3(mean(all)) : undefined;
      const tie = !!swapped && a.length > 0 && b.length > 0 && meets(mean(a), o.threshold, lower) !== meets(mean(b), o.threshold, lower);
      return { ref, normal, other, scores: a, score, tie, swapScores: swapped ? [a.length ? round3(mean(a)) : undefined, b.length ? round3(mean(b)) : undefined] : undefined };
    }),
  );

  const scored = per.filter((p) => p.score !== undefined);
  const aggregate = o.aggregate ?? 'majority';
  let score: number | undefined;
  if (scored.length) {
    const xs = scored.map((p) => p.score!);
    if (scored.length === 1 || aggregate === 'mean') score = round3(mean(xs));
    else if (aggregate === 'min') score = lower ? Math.max(...xs) : Math.min(...xs);
    else {
      const pass = scored.filter((p) => meets(p.score!, o.threshold, lower));
      // a tie of the judges goes to the failing side: the jury is not convinced
      const side = pass.length * 2 > scored.length ? pass : scored.filter((p) => !meets(p.score!, o.threshold, lower));
      score = round3(mean(side.map((p) => p.score!)));
    }
  }
  const tie = per.some((p) => p.tie);
  const lead = per[0]!;
  const shown = lead.normal.find((v) => v.items.length) ?? lead.normal[0]!;
  const firstJudge = first!.judge;
  const multi = judges.length > 1;
  const reps = repeat > 1 ? per.flatMap((p) => p.scores) : [];
  return {
    ...(score !== undefined ? { score } : {}),
    // a tie (the two orders disagree) is not a pass
    passed: score !== undefined && meets(score, o.threshold, lower) && !tie,
    items: toItems(shown),
    reasoning: shown.reasoning,
    judge: firstJudge,
    usage: { ...usage, costUsd: Math.round(usage.costUsd * 1e6) / 1e6 },
    redactionCount,
    ...(multi || swapped || repeat > 1
      ? {
          panel: {
            ...(multi ? { judges: per.map((p) => ({ provider: p.ref.provider ?? '', model: p.ref.model ?? '', ...(p.score !== undefined ? { score: p.score } : {}), passed: p.score !== undefined && meets(p.score, o.threshold, lower) })), aggregate } : {}),
            ...(swapped ? { swap: { scores: lead.swapScores!, tie } } : {}),
            ...(repeat > 1 ? { repeat: { n: repeat, scores: reps, mean: round3(mean(reps)), sd: round3(sd(reps)), flipRate: flipRate(lead.normal) } } : {}),
          },
        }
      : {}),
  };
}
