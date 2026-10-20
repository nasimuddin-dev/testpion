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
export function scoreOf(v: Verdict, metric: JudgedMetric): number | undefined {
  if (!v.items.length) return undefined;
  if (metric.rating) return round3(v.items.reduce((a, i) => a + (i.rating ?? 0), 0) / (v.items.length * metric.rating));
  return round3(v.items.filter((i) => i.verdict).length / v.items.length);
}

const toItems = (v: Verdict): PanelItem[] => v.items.map((i) => ({ text: i.text.slice(0, 500), ok: i.verdict, evidence: i.reason.slice(0, 300), ...(i.rating !== undefined ? { rating: i.rating } : {}) }));

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

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
  if (!metric.inputs.includes('contexts') || !Array.isArray(input.contexts) || input.contexts.length < 2) return undefined;
  return { ...input, contexts: [...(input.contexts as unknown[])].reverse() };
}

export async function judgePanel(host: RagJudgeHost, metric: JudgedMetric, input: Record<string, unknown>, o: PanelOptions): Promise<PanelResult> {
  const judges = o.judges?.length ? o.judges : [o.judge];
  // the run's limits belong to the run, whichever judge is asked
  const limits = { maxCostUsd: o.judge.maxCostUsd, maxCalls: o.judge.maxCalls };
  const repeat = Math.max(1, Math.min(10, Math.floor(o.repeat ?? 1)));
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
      const tie = !!swapped && a.length > 0 && b.length > 0 && (mean(a) >= o.threshold) !== (mean(b) >= o.threshold);
      return { ref, normal, other, scores: a, score, tie, swapScores: swapped ? [a.length ? round3(mean(a)) : undefined, b.length ? round3(mean(b)) : undefined] : undefined };
    }),
  );

  const scored = per.filter((p) => p.score !== undefined);
  const aggregate = o.aggregate ?? 'majority';
  let score: number | undefined;
  if (scored.length) {
    const xs = scored.map((p) => p.score!);
    if (scored.length === 1 || aggregate === 'mean') score = round3(mean(xs));
    else if (aggregate === 'min') score = Math.min(...xs);
    else {
      const pass = scored.filter((p) => p.score! >= o.threshold);
      // a tie of the judges goes to the failing side: the jury is not convinced
      const side = pass.length * 2 > scored.length ? pass : scored.filter((p) => p.score! < o.threshold);
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
    passed: score !== undefined && score >= o.threshold && !tie,
    items: toItems(shown),
    reasoning: shown.reasoning,
    judge: firstJudge,
    usage: { ...usage, costUsd: Math.round(usage.costUsd * 1e6) / 1e6 },
    redactionCount,
    ...(multi || swapped || repeat > 1
      ? {
          panel: {
            ...(multi ? { judges: per.map((p) => ({ provider: p.ref.provider ?? '', model: p.ref.model ?? '', ...(p.score !== undefined ? { score: p.score } : {}), passed: p.score !== undefined && p.score >= o.threshold })), aggregate } : {}),
            ...(swapped ? { swap: { scores: lead.swapScores!, tie } } : {}),
            ...(repeat > 1 ? { repeat: { n: repeat, scores: reps, mean: round3(mean(reps)), sd: round3(sd(reps)), flipRate: flipRate(lead.normal) } } : {}),
          },
        }
      : {}),
  };
}
