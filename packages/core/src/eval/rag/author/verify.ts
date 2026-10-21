/**
 * The verifier `rag-eval-dry-run` of an authored evaluation: it runs the evaluation on a few of its own samples before
 * anyone relies on it, and sends nothing to a model. Every evaluator must resolve and have its inputs (from the dataset or
 * from what the target returns); the free metrics are computed for real on the samples that already hold an answer and
 * contexts; judged metrics build their prompts on a dry judge host (counted, never sent) and the whole dataset is estimated
 * with the existing run estimate. A threshold the samples already miss by a lot is a warning, not a failure: it may be what
 * the person wants to fix.
 */
import { mean } from '../../../util/stats.js';
import { registerVerifier } from '../../../ai/verify.js';
import type { ProposalItem, VerificationBadge } from '../../../ai/proposal.js';
import type { VerifyContext } from '../../../ai/verify.js';
import type { CheckConfig } from '../../../model/types.js';
import { parseRagDatasetText } from '../dataset-formats.js';
import { estimateRagRun, sampleShapeOf } from '../estimate.js';
import { dryHost, type RagJudgeHost } from '../judge.js';
import { resolveMetric } from '../metric-registry.js';
import { scoreRagSample } from '../score.js';
import { findRagTarget } from '../targets.js';
import { contextOfSample, sampleInputs, type TrySample } from '../try-metric.js';
import { sampleOfRecord, suppliedInputs } from './catalogue.js';
import type { AuthoredData } from './propose.js';

const SAMPLES = 5;
const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

export async function dryRunEvaluation(item: ProposalItem, ctx: VerifyContext): Promise<VerificationBadge | undefined> {
  if (item.kind !== 'evaluation') return undefined;
  const v = 'rag-eval-dry-run';
  const data = item.data as AuthoredData | undefined;
  const ev = data?.evaluation;
  if (!ev) return { verifier: v, status: 'fail', label: 'not an evaluation', detail: 'The item holds no saved evaluation.' };
  if (!ev.evaluators?.length) return { verifier: v, status: 'fail', label: 'no metric to run', detail: 'Every metric of the plan was dropped (see the notes); choose metrics the data can supply.' };

  const records = ev.dataset ? parseRagDatasetText(ev.dataset, 'jsonl') : [];
  let target: ReturnType<typeof findRagTarget> | undefined;
  try {
    target = ctx.store && ev.target ? findRagTarget(ctx.store, ev.target) : undefined;
  } catch {
    return { verifier: v, status: 'fail', label: `no RAG target "${ev.target}"`, detail: 'Connect the target first (AI Lab ▸ RAG).' };
  }
  const supplied = suppliedInputs(records, target);
  const problems: string[] = [];
  const configs: Array<{ cfg: CheckConfig; id: string; kind: string; threshold?: number; direction: string }> = [];
  for (const cfg of ev.evaluators) {
    const r = resolveMetric(cfg.type);
    if (!r) {
      problems.push(`${cfg.type} is not a metric of the catalogue`);
      continue;
    }
    const miss = r.def.requires.filter((i) => !supplied[i]);
    if (miss.length) problems.push(`${r.def.id} cannot run: ${miss.join(', ')} ${miss.length === 1 ? 'is' : 'are'} missing${records.length ? '' : ' (the evaluation has no dataset)'}`);
    else configs.push({ cfg, id: r.def.id, kind: r.def.kind, threshold: typeof cfg.threshold === 'number' ? cfg.threshold : r.def.threshold, direction: r.def.direction });
  }
  if (problems.length) return { verifier: v, status: 'fail', label: `${problems.length} of ${ev.evaluators.length} metrics cannot run`, detail: problems.join('; ') };

  const samples: TrySample[] = records.slice(0, SAMPLES).map(sampleOfRecord);
  // a sample that already holds the system's answer and contexts is scored for real; the others wait for the target
  const scoreable = samples.filter((s) => s.answer && (s.contexts?.length || !configs.some((c) => c.cfg && (resolveMetric(c.cfg.type)?.def.requires ?? []).includes('contexts'))));
  const warns: string[] = [];
  let scored = 0;
  const free = configs.filter((c) => c.kind === 'deterministic');
  const lines: string[] = [];
  for (const c of free) {
    const need = resolveMetric(c.cfg.type)!.def.requires;
    const usable = scoreable.filter((s) => need.every((i) => sampleInputs(s)[i]));
    if (!usable.length) continue;
    const scores: number[] = [];
    for (const s of usable) {
      const { checks } = await scoreRagSample([c.cfg], contextOfSample(s));
      if (typeof checks[0]?.score === 'number') scores.push(checks[0].score);
    }
    if (!scores.length) continue;
    scored++;
    const m = mean(scores);
    const gate = data.gates[c.id];
    const bar = gate ?? c.threshold;
    const bad = bar !== undefined && (c.direction === 'lower' ? m > bar + 0.3 : m < bar - 0.3);
    if (bad) warns.push(`your ${scores.length} sample${scores.length === 1 ? '' : 's'} score ${m.toFixed(2)} on ${c.id}; ${gate !== undefined ? `a gate at ${gate}` : `a pass mark of ${bar}`} fails today`);
  }
  if (scored) lines.push(`${scored} free metric${scored === 1 ? '' : 's'} computed for real on samples that hold an answer`);
  else if (free.length) lines.push(`${free.length} free metric${free.length === 1 ? '' : 's'} have their inputs (they are computed when the target answers)`);

  // the judged part: prompts built on a dry host (nothing is sent), and the whole dataset estimated
  const judged = configs.filter((c) => c.kind !== 'deterministic');
  let judgeNote: string | undefined;
  if (judged.length) {
    const judge = { ...(ev.judge ?? {}), ...(ev.maxJudgeCostUsd !== undefined ? { maxCostUsd: ev.maxJudgeCostUsd } : {}), ...(ev.maxJudgeCalls !== undefined ? { maxCalls: ev.maxJudgeCalls } : {}) };
    const tasks = ctx.tasks ?? ctx.services?.ragJudge?.tasks;
    if (!ctx.runDeps || !tasks) judgeNote = `${judged.length} judged metric${judged.length === 1 ? '' : 's'} checked structurally only (no model is set up to price them)`;
    else {
      const host: RagJudgeHost = { deps: ctx.runDeps, tasks, budget: { calls: 0, cached: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, inflight: new Map() };
      try {
        const est = estimateRagRun(host, ctx.store, { evaluators: judged.map((c) => c.cfg), samples: Math.max(1, records.length), judge, shape: records.length ? sampleShapeOf(samples.filter((s) => s.answer)) : undefined, hasTarget: !!ev.target });
        if (est.judgeProblem) judgeNote = `${judged.length} judged metric${judged.length === 1 ? '' : 's'} checked structurally only: ${est.judgeProblem.split('\n')[0]}`;
        else {
          // the real prompts on the samples that can build them, on a dry host
          const dry = dryHost(host);
          let built = 0;
          for (const s of scoreable) {
            await scoreRagSample(judged.map((c) => c.cfg), contextOfSample(s, { judge, providers: ctx.runDeps.providers, ragJudge: dry, signal: ctx.signal }));
            built++;
          }
          judgeNote = `${judged.length} judged metric${judged.length === 1 ? '' : 's'} would make ${est.total.llmCalls.toLocaleString("en-US")} model call${est.total.llmCalls === 1 ? "" : "s"} for ${records.length || 'the'} record${records.length === 1 ? '' : 's'}${est.costUsd ? `, about ${usd(est.costUsd.low)} to ${usd(est.costUsd.high)}` : ''}${built ? `; their prompts were built on ${built} sample${built === 1 ? '' : 's'} and nothing was sent` : ''}`;
          for (const x of est.caps.exceeds) warns.push(`this evaluation would break ${x}`);
        }
      } catch (e) {
        judgeNote = `${judged.length} judged metric${judged.length === 1 ? '' : 's'} checked structurally only: ${(e as Error).message.split('\n')[0]}`;
      }
    }
  }
  if (judgeNote) lines.push(judgeNote);
  if (!records.length) warns.push('the evaluation has no dataset: add one before it can run');
  const label = `${configs.length} of ${ev.evaluators.length} metrics can run${samples.length ? ` on ${samples.length} sample${samples.length === 1 ? '' : 's'}` : ''}${judgeNote && !/structurally/.test(judgeNote) ? `; ${judgeNote.replace(/;.*$/, '')}` : ''}`;
  const detail = [...lines, ...warns].join('. ');
  return { verifier: v, status: warns.length || /structurally/.test(judgeNote ?? '') ? 'warn' : 'pass', label, detail };
}

registerVerifier('rag-eval-dry-run', dryRunEvaluation);
