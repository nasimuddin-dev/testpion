/**
 * Why a sample scored low (planning/rag-testing.md §4c, "failure taxonomy"): deterministic rules over the metric results
 * of ONE sample, so the same scores always give the same class. It answers the first question after a bad run: is it
 * the retriever, the generator, the answer's format, or the system? The rules read the canonical metric ids, never a
 * model, and the class is stored with the result (`metadata.rag.failure`) so the matrix can filter by it.
 */
import type { CheckResult } from '../../model/types.js';
import { canonicalMetricId } from './metric-registry.js';

export type FailureClass =
  | 'system-error'
  | 'format'
  | 'judge-error'
  | 'retrieval-miss'
  | 'false-refusal'
  | 'ranking'
  | 'noise'
  | 'unfaithful'
  | 'off-topic'
  | 'incomplete'
  | 'citation'
  | 'operational'
  | 'other';

/** `plain`: the cause in the words of the report card ("3 right document not found"), the same in the app, the CLI and the MCP tools. */
export const FAILURE_CLASSES: ReadonlyArray<{ id: FailureClass; label: string; plain: string; meaning: string }> = [
  { id: 'system-error', label: 'System error', plain: 'the bot did not answer', meaning: 'The RAG system did not answer (an error, a timeout, a refused request).' },
  { id: 'format', label: 'Format', plain: 'answer not found in the response', meaning: 'It answered but the mapping found no answer in the response: the answer is empty or in a shape the target does not read.' },
  { id: 'judge-error', label: 'Judge error', plain: 'the reviewer could not decide', meaning: 'A judge could not score the sample (no verdict in the expected format); fix the judge, not the system.' },
  { id: 'retrieval-miss', label: 'Retrieval miss', plain: 'right document not found', meaning: 'The retriever did not bring what the question needs (the gold chunks or the reference facts are not in the contexts, or nothing was retrieved).' },
  { id: 'false-refusal', label: 'False refusal', plain: 'refused though the documents had the answer', meaning: 'The retrieval was good but the answer refuses or says it does not know.' },
  { id: 'ranking', label: 'Ranking', plain: 'right document ranked too low', meaning: 'The right chunks were retrieved but ranked low.' },
  { id: 'noise', label: 'Noise', plain: 'too many wrong documents', meaning: 'The right chunks were retrieved among many irrelevant ones.' },
  { id: 'unfaithful', label: 'Unfaithful', plain: 'claim not backed by the sources', meaning: 'The retrieval was fine but the answer makes claims the documents do not support.' },
  { id: 'off-topic', label: 'Off topic', plain: 'does not answer the question', meaning: 'The answer does not address the question.' },
  { id: 'incomplete', label: 'Incomplete or wrong', plain: 'differs from the reference answer', meaning: 'Retrieval and grounding were fine but the answer differs from the reference.' },
  { id: 'citation', label: 'Citation', plain: 'cites a document that was not retrieved', meaning: 'The answer cites documents that were not retrieved.' },
  { id: 'operational', label: 'Operational', plain: 'over a time or cost limit', meaning: 'Only a latency, token or cost limit failed.' },
  { id: 'other', label: 'Other', plain: 'another check failed', meaning: 'A check failed that no rule explains.' },
];

export interface RagFailure {
  class: FailureClass;
  /** One sentence, from the scores that decided it. */
  reason: string;
  /** The canonical ids of the failed metrics. */
  metrics: string[];
}

/** An answer that declines or says it has no answer: a refusal, "I don't know", "I could not find that in the documents". */
export const REFUSAL =
  /\b(i can(?:'|no)t|i am (?:not able|unable)|i'm (?:not able|unable)|i don'?t know|i do not know|i won'?t|cannot (?:help|assist|comply)|not (?:able|allowed) to|i must decline|no information|sorry,? but|(?:could|did) not find|couldn'?t find|(?:not|nothing) (?:found|mentioned|covered|stated) in|(?:does|do|did) not (?:say|mention|cover|state)|no (?:answer|mention) (?:in|of)|outside (?:the|my) (?:documents|sources|knowledge))\b/i;

/** The two goals of a bot with sources: its answers are backed by what it retrieved, and it found the right documents. */
export const GOAL_BACKED_METRICS: ReadonlySet<string> = new Set(['faithfulness', 'response-groundedness', 'claim-faithfulness', 'claim-hallucination', 'hallucination']);
export const GOAL_FOUND_METRICS: ReadonlySet<string> = new Set(['context-recall', 'context-recall-ids', 'context-recall-lexical', 'recall@k', 'hit-rate@k', 'retriever-claim-recall']);

const RECALL = new Set(['context-recall', 'context-recall-ids', 'context-recall-lexical', 'context-entity-recall', 'recall@k', 'hit-rate@k', 'retriever-claim-recall']);
const RANKING = new Set(['ndcg@k', 'map@k', 'mrr@k', 'context-precision', 'context-precision-lexical', 'context-utilization']);
const NOISE = new Set(['precision@k', 'r-precision', 'context-precision-ids', 'context-relevance', 'retriever-context-precision', 'retrieval-relevance', 'noise-sensitivity-relevant', 'noise-sensitivity-irrelevant']);
const UNFAITHFUL = new Set(['faithfulness', 'response-groundedness', 'claim-faithfulness', 'claim-hallucination', 'hallucination']);
const REFERENCE = new Set(['factual-correctness', 'answer-correctness', 'answer-accuracy', 'correctness', 'factuality', 'claim-f1', 'claim-precision', 'claim-recall', 'completeness', 'token-f1', 'rouge', 'bleu', 'chrf', 'numeric-diff', 'json-diff', 'label-f1', 'normalized-match', 'exact-match', 'string-similarity', 'semantic-similarity', 'contains']);
const OPERATIONAL = new Set(['latency', 'ttft', 'tokens', 'cost', 'context-size', 'throughput', 'error-rate']);

interface FailureInput {
  checks: CheckResult[];
  answer: string;
  contexts: number;
  warnings?: string[];
  error?: { message: string };
}

/** The class of a failed sample, or undefined when nothing failed (n/a is not a failure). */
export function classifyFailure(i: FailureInput): RagFailure | undefined {
  const failed = i.checks.filter((c) => !c.passed);
  if (!failed.length && !i.error) return undefined;
  const ids = failed.map((c) => canonicalMetricId(c.type));
  const has = (set: Set<string>) => ids.filter((id) => set.has(id));
  const out = (cls: FailureClass, reason: string): RagFailure => ({ class: cls, reason, metrics: [...new Set(ids)] });

  if (i.error) return out('system-error', `the system did not answer: ${i.error.message.slice(0, 160)}`);
  if (!i.answer.trim() || i.warnings?.some((w) => w.startsWith('The answer path'))) return out('format', 'the response held no answer for the mapping to read');
  const judgeFailed = failed.filter((c) => c.source === 'ai-judge' && /^judge failed/.test(c.message));
  if (judgeFailed.length) return out('judge-error', judgeFailed[0]!.message.slice(0, 200));

  const recall = has(RECALL);
  const needsContexts = i.checks.some((c) => ['faithfulness', 'context-relevance', ...UNFAITHFUL, ...RECALL, ...RANKING, ...NOISE].includes(canonicalMetricId(c.type)));
  if (recall.length) return out('retrieval-miss', `${recall[0]} fell below its mark: the contexts miss what the question needs`);
  if (!i.contexts && needsContexts) return out('retrieval-miss', 'nothing was retrieved');
  if (REFUSAL.test(i.answer)) return out('false-refusal', 'the retrieval was fine but the answer says it cannot answer');
  const rank = has(RANKING);
  if (rank.length) return out('ranking', `${rank[0]} fell below its mark: the useful chunks are ranked low`);
  const noise = has(NOISE);
  if (noise.length) return out('noise', `${noise[0]} fell below its mark: too many retrieved chunks are irrelevant`);
  const unfaithful = has(UNFAITHFUL);
  if (unfaithful.length) return out('unfaithful', `${unfaithful[0]} fell below its mark: the answer has claims the documents do not support`);
  if (ids.includes('answer-relevance')) return out('off-topic', 'answer-relevance fell below its mark: the answer does not address the question');
  const ref = has(REFERENCE);
  if (ref.length) return out('incomplete', `${ref[0]} fell below its mark: retrieval and grounding are fine but the answer differs from the reference`);
  if (ids.includes('citation') || ids.includes('citation-accuracy') || ids.includes('quoted-spans')) return out('citation', 'the answer cites or quotes documents that do not support it');
  if (ids.every((id) => OPERATIONAL.has(id))) return out('operational', `${ids[0]} limit exceeded`);
  return out('other', `${failed[0]!.name} failed: ${failed[0]!.message.slice(0, 140)}`);
}
