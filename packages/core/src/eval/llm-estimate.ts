import { datasetRecords, isLocalProvider, staysOnThisComputer, type CaseRow } from '@testpion/shared';
import { estimateCost, type ProviderRegistry } from '../ai/index.js';
import { estimateTokens } from '../ai/types.js';
import type { PriceEntry } from '../model/types.js';
import type { SavedEvaluation } from '../runner/saved-evaluations.js';
import type { RunEvent, RunOptions } from '../runner/runner.js';

/**
 * What a prompt evaluation costs before it runs (AU-5) and the spend cap that stops it (AU-18). The estimate is made from
 * the cases, the prompt and the price table: calls, tokens, dollars, seconds. The same numbers go to the app (beside Run),
 * `testpion eval estimate` and the `eval_estimate` tool.
 */
export interface EvalEstimate {
  /** The cases that would run (the evaluation's "only the first" limit applied). */
  cases: number;
  /** Calls to the model: one per case, plus one per case for each check an AI reviewer grades. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** About this many dollars, from the price table; undefined when the model has no price. */
  costUsd?: number;
  /** The model has a price in the table (or is free: the offline demo model, a model on this computer). */
  priced: boolean;
  /** The offline demo model answers: nothing is sent and nothing is spent. */
  offline: boolean;
  /** Runs on this computer (the offline demo model, Ollama, a local server): no charge. */
  free: boolean;
  /** About this many seconds. */
  seconds: number;
  provider: string;
  model: string;
  /** Checks that an AI reviewer grades. */
  reviewerChecks: number;
  /** The one line shown beside Run: "20 cases · about $0.03 · ~40 s". */
  summary: string;
}

/** A check that asks a second model to grade the reply. */
export const isReviewerCheck = (type: string): boolean => /judge|rubric|g-?eval/i.test(type);

const usd = (n: number): string => (n === 0 ? '$0.00' : n < 0.01 ? '$' + n.toFixed(4) : '$' + n.toFixed(2));
export const formatEstimateUsd = usd;

/** The text of a prompt for one case: its `{{variables}}` replaced by the case's values (unknown ones stay as they are, they are only counted). */
const fill = (template: string, row: CaseRow): string =>
  template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k: string) => {
    const v = row[k];
    return v === undefined ? m : typeof v === 'string' ? v : JSON.stringify(v);
  });

function lineOf(e: Pick<EvalEstimate, 'cases' | 'costUsd' | 'priced' | 'free' | 'offline' | 'seconds'>): string {
  const cases = `${e.cases} case${e.cases === 1 ? '' : 's'}`;
  const time = e.seconds < 1 ? 'a moment' : e.seconds < 90 ? `~${Math.round(e.seconds)} s` : `~${Math.round(e.seconds / 60)} min`;
  if (e.offline) return `${cases} · free (offline demo model) · ${time}`;
  if (e.free) return `${cases} · free (runs on this computer) · ${time}`;
  if (!e.priced || e.costUsd === undefined) return `${cases} · cost unknown (no price for this model) · ${time}`;
  return `${cases} · about ${usd(e.costUsd)} · ${time}`;
}

export function estimateEvaluation(svc: { providers: ProviderRegistry; pricing: PriceEntry[] }, d: Pick<SavedEvaluation, 'provider' | 'model' | 'system' | 'prompt' | 'format' | 'dataset' | 'datasetFormat' | 'evaluators' | 'limit' | 'concurrency'>): EvalEstimate {
  const all = datasetRecords(d.dataset ?? '', d.datasetFormat ?? 'jsonl');
  const rows = d.limit ? all.slice(0, d.limit) : all;
  const cases = rows.length;
  const reviewerChecks = (d.evaluators ?? []).filter((e) => isReviewerCheck(e.type)).length;
  const config = svc.providers.find(d.provider);
  const model = d.model || config?.defaultModel || '';
  // an average case: the prompt filled in, and an answer of a short JSON or a few sentences
  let inputTokens = 0;
  for (const r of rows) inputTokens += estimateTokens(`${d.system ?? ''}\n${fill(d.prompt ?? '', r)}`);
  const outPer = d.format === 'json' ? 40 : 150;
  let outputTokens = cases * outPer;
  // a reviewer reads the case's input, the reply and its rule, and answers with a score and a sentence
  if (reviewerChecks) {
    inputTokens += reviewerChecks * (inputTokens + cases * (outPer + 120));
    outputTokens += reviewerChecks * cases * 60;
  }
  const calls = cases * (1 + reviewerChecks);
  const offline = config?.kind === 'mock';
  const free = offline || (!!config && (staysOnThisComputer(config) || isLocalProvider(config)));
  const price = config && !free ? estimateCost(svc.pricing, config, model, { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }) : undefined;
  const costUsd = free ? 0 : price?.cost;
  const seconds = offline ? cases * 0.02 : Math.ceil(calls / Math.max(1, d.concurrency || 4)) * 1.5 * (1 + reviewerChecks * 0.5);
  const base = { cases, calls, inputTokens, outputTokens, ...(costUsd !== undefined ? { costUsd } : {}), priced: free || costUsd !== undefined, offline, free, seconds, provider: config?.name ?? d.provider, model, reviewerChecks };
  return { ...base, summary: lineOf(base) };
}

/** What may be spent on a run, and whether it asks first. */
export interface SpendPlan {
  /** The run stops once it has spent this much (USD); undefined: no cap (the offline demo model and models on this computer are free). */
  capUsd?: number;
  /** The cap can only stop a run whose cost is known: without a price for the model it cannot. */
  enforced: boolean;
  /** The estimate is over $0.50 (or 100 calls): ask the person once before sending. */
  ask: boolean;
  /** Why it asks, or says the run is expected to stop at the cap. */
  reason?: string;
}

/** The default cap of a run on a paid model, and the estimate above which it asks first. */
export const DEFAULT_SPEND_CAP_USD = 1;
export const ASK_ABOVE_USD = 0.5;
export const ASK_ABOVE_CALLS = 100;

/**
 * The cap of a run and whether it asks first (AU-18). `maxCostUsd` is the evaluation's own (or `--max-cost`): 0 means no
 * cap. Unset, a paid model gets a hard stop at $1.00 per run; a free one gets none.
 */
export function spendPlan(est: Pick<EvalEstimate, 'costUsd' | 'calls' | 'free' | 'priced'>, maxCostUsd?: number): SpendPlan {
  if (est.free) return { enforced: false, ask: false, ...(maxCostUsd ? { capUsd: maxCostUsd } : {}) };
  const capUsd = maxCostUsd === 0 ? undefined : (maxCostUsd ?? DEFAULT_SPEND_CAP_USD);
  const enforced = capUsd !== undefined && est.costUsd !== undefined;
  const over = est.costUsd !== undefined ? est.costUsd > ASK_ABOVE_USD : est.calls > ASK_ABOVE_CALLS;
  const reasons: string[] = [];
  if (over) reasons.push(est.costUsd !== undefined ? `This run is estimated at about ${usd(est.costUsd)}, over ${usd(ASK_ABOVE_USD)}.` : `This run makes about ${est.calls} calls and the model has no price, so the cost is unknown.`);
  if (capUsd !== undefined && est.costUsd !== undefined && est.costUsd > capUsd) reasons.push(`It stops at the cap of ${usd(capUsd)}, so not every case will run. Raise the cap to run them all.`);
  if (capUsd !== undefined && est.costUsd === undefined) reasons.push('The model has no price in the price table, so the cap of ' + usd(capUsd) + ' cannot stop the run. Set a price first.');
  return { ...(capUsd !== undefined ? { capUsd } : {}), enforced, ask: over, ...(reasons.length ? { reason: reasons.join(' ') } : {}) };
}

/** What a capped run did: how much it spent, and whether it stopped at the cap. */
export interface SpendGuard {
  readonly spentUsd: number;
  readonly stopped: boolean;
  readonly capUsd: number;
  /** "Stopped at $1.00 after 14 of 20 cases. Raise the cap to continue." (empty when it did not stop) */
  message(total: number): string;
}

/**
 * Run options that stop the run once the results have cost `capUsd` (cases already sent finish; no new one starts). The
 * run's own signal still cancels it as before. Returns the options to run and the guard to read afterwards.
 */
export function capRunOptions(o: RunOptions, capUsd: number | undefined): { options: RunOptions; guard: SpendGuard } {
  const state = { spent: 0, stopped: false, done: 0 };
  const cap = capUsd ?? Infinity;
  const ctrl = new AbortController();
  const outer = o.signal;
  if (outer) outer.aborted ? ctrl.abort() : outer.addEventListener('abort', () => ctrl.abort(), { once: true });
  const guard: SpendGuard = {
    get spentUsd() {
      return state.spent;
    },
    get stopped() {
      return state.stopped;
    },
    capUsd: cap,
    message: (total) => (state.stopped ? `Stopped at ${usd(cap)} after ${state.done} of ${total} cases. Raise the cap to continue.` : ''),
  };
  if (capUsd === undefined) return { options: o, guard };
  const options: RunOptions = {
    ...o,
    signal: ctrl.signal,
    onEvent: (e: RunEvent) => {
      if (e.type === 'test-end') {
        state.done++;
        state.spent += e.result.costUsd ?? 0;
        if (!state.stopped && state.spent >= cap) {
          state.stopped = true;
          ctrl.abort();
        }
      }
      o.onEvent?.(e);
    },
  };
  return { options, guard };
}
