import type { ReactNode } from 'react';
import { formatCost } from '../../lib/format';
import { Spinner } from '../ui';

/**
 * The ONE estimate line of an AI action ("Claude · claude-sonnet · ≈ 1,200 tokens in · up to $0.02"): the model, whether
 * it stays on this computer, and the most the call can cost. Every dialog and button that asks before it sends shows it
 * through here, so the words are the same everywhere and a screen reader is told when it appears or changes (role
 * "status", polite). The judged RAG metrics have their own table (rag/RagEstimate.tsx) and use the same words in it.
 */
export interface EstimatePreview {
  providerName: string;
  model: string;
  local: boolean;
  estimate: { inputTokens: number; priceKnown: boolean; maxCostUsd?: number; maxOutputTokens?: number };
}

/** What the estimate line says for a preview (also the tooltip of the AI buttons). */
export function estimateText(p: EstimatePreview, only: { /** Leave the model out (a badge beside the line names it). */ noModel?: boolean; /** Add the most the answer can take. */ out?: boolean } = {}): string {
  const model = only.noModel ? '' : `${p.providerName} · ${p.model}${p.local ? ' (on this computer)' : ''} · `;
  const out = only.out && p.estimate.maxOutputTokens !== undefined ? ` · up to ${p.estimate.maxOutputTokens.toLocaleString()} out` : '';
  return `${model}≈ ${p.estimate.inputTokens.toLocaleString()} tokens in${out}${p.estimate.priceKnown ? ` · up to ${formatCost(p.estimate.maxCostUsd ?? 0)}` : ' · no price set'}`;
}

/** An estimate as the dialogs keep it: the line, or why there is none (no model set, over a limit). */
export interface EstimateState {
  ok: boolean;
  text: string;
}
export const estimateOf = (p: EstimatePreview): EstimateState => ({ ok: true, text: estimateText(p) });

export function AiEstimateLine({
  estimate,
  waiting = true,
  className = 'text-xs text-muted min-h-5',
  children,
  ...attrs
}: {
  /** The estimate, or the reason there is none. */
  estimate?: EstimateState;
  /** Show a spinner while there is no estimate yet. */
  waiting?: boolean;
  className?: string;
  /** Before the line (a count, the item it is about). */
  children?: ReactNode;
  /** A `data-*` hook the end-to-end plans look for. */
  [attr: `data-${string}`]: string | boolean | undefined;
}) {
  return (
    <div role="status" aria-live="polite" className={className} {...attrs}>
      {children}
      {estimate ? <span className={estimate.ok ? '' : 'text-warn'}>{estimate.text}</span> : waiting ? <Spinner size={11} /> : null}
    </div>
  );
}
