import type { EvalEstimate, SpendPlan } from '@testpion/core';
import { useDebounced } from '../components/ui';
import { useRpc } from './use-rpc';
import type { CheckConfig } from '../types';

/** What the window knows of an evaluation draft that decides its cost (the rest of the draft does not change the price). */
export interface CostDraft {
  type: 'llm' | 'rag';
  provider: string;
  model: string;
  system?: string;
  prompt: string;
  format: 'text' | 'json';
  datasetFormat: 'jsonl' | 'json' | 'csv' | 'md';
  dataset: string;
  evaluators: CheckConfig[];
  concurrency: number;
  limit?: number;
  maxCostUsd?: number;
}

export type EvalEstimateResult = EvalEstimate & { plan: SpendPlan };

/** The estimate of a prompt evaluation as it is edited (AU-5): asked again a moment after the last change. Nothing for a bot with sources (it has its own). */
export function useEvalEstimate(d: CostDraft, environment?: string): EvalEstimateResult | undefined {
  const picked = useDebounced({ type: d.type, provider: d.provider, model: d.model, system: d.system, prompt: d.prompt, format: d.format, datasetFormat: d.datasetFormat, dataset: d.dataset, evaluators: d.evaluators, concurrency: d.concurrency, limit: d.limit, maxCostUsd: d.maxCostUsd }, 300);
  return useRpc<EvalEstimateResult>('eval.estimate', { draft: picked, environment }, { keep: true, enabled: picked.type === 'llm' && !!picked.provider, reloadOn: ['data.changed'] });
}

/** The cost in a few words for a button label: "free", "about $0.03", "cost unknown". */
export function shortCost(e: EvalEstimateResult | undefined, format: (usd: number) => string): string | undefined {
  if (!e) return undefined;
  if (e.free) return 'free';
  if (!e.priced || e.costUsd === undefined) return 'cost unknown';
  return `about ${format(e.costUsd)}`;
}
