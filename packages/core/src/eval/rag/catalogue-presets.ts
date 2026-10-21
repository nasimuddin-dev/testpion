/**
 * Metric presets: a named set of metrics for a purpose (the picker's chips, `rag run --preset`, the monitor and CI
 * dialogs). A preset lists metric ids with the options that make them what the preset says; a metric the dataset has
 * no inputs for is greyed in the picker, not dropped.
 */
import type { CheckConfig } from '../../model/types.js';
import { metricToCheck, resolveMetric } from './metric-registry.js';

interface MetricPreset {
  id: string;
  name: string;
  description: string;
  /** Metric names (id, alias or Ragas name) with the options the preset wants. */
  metrics: Array<string | { metric: string; options: Record<string, unknown> }>;
}

export const METRIC_PRESETS: readonly MetricPreset[] = [
  {
    id: 'rag-triad',
    name: 'RAG triad',
    description: 'TruLens’ three questions: is the context relevant, is the answer grounded in it, does the answer address the question.',
    metrics: [{ metric: 'context-relevance', options: { mode: 'chunks' } }, 'faithfulness', 'answer-relevance'],
  },
  {
    id: 'ragas-core',
    name: 'Ragas core',
    description: 'Ragas’ everyday set, with Ragas’ own definitions (answer relevance by reverse questions).',
    metrics: ['context-precision', 'context-recall', 'context-entity-recall', 'faithfulness', { metric: 'answer-relevance', options: { mode: 'reverse-questions' } }, 'factual-correctness'],
  },
  {
    id: 'deepeval-rag',
    name: 'DeepEval RAG',
    description: 'DeepEval’s RAG metrics: statement-based relevance, faithfulness, contextual precision, recall and relevancy.',
    metrics: [{ metric: 'answer-relevance', options: { mode: 'statements' } }, 'faithfulness', 'context-precision', 'context-recall', { metric: 'context-relevance', options: { mode: 'statements' } }],
  },
  {
    id: 'nvidia-rag',
    name: 'NVIDIA RAG',
    description: 'NVIDIA’s retrieval view: context relevance (two prompts) and the IR measures recall@k and nDCG@k at 5 and 10.',
    metrics: [{ metric: 'context-relevance', options: { mode: 'nvidia' } }, { metric: 'recall@k', options: { k: 5 } }, { metric: 'recall@k', options: { k: 10 } }, { metric: 'ndcg@k', options: { k: 5 } }, { metric: 'ndcg@k', options: { k: 10 } }],
  },
  {
    id: 'retrieval-only',
    name: 'Retrieval only (no model)',
    description: 'Judges the retriever against the gold chunk ids, with no model at all.',
    metrics: ['context-precision-ids', 'context-recall-ids', 'recall@k', 'precision@k', 'hit-rate@k', 'mrr@k', 'ndcg@k', 'map@k'],
  },
  {
    id: 'free',
    name: 'Free (no model at all)',
    description: 'Every metric that needs no judge and no embedding model: ids and rank, lexical, answer text and the limits.',
    metrics: ['context-precision-ids', 'context-recall-ids', 'recall@k', 'ndcg@k', 'context-precision-lexical', 'context-recall-lexical', 'context-entity-recall', 'normalized-match', 'token-f1', 'rouge', 'string-similarity', 'citation', { metric: 'pii-leakage', options: { mode: 'regex' } }, 'no-leak', 'latency', 'tokens'],
  },
  {
    id: 'answer-vs-reference',
    name: 'Answer vs reference',
    description: 'How close the answer is to the reference answer, by facts, by meaning and by words.',
    metrics: ['factual-correctness', { metric: 'semantic-similarity', options: { method: 'embedding' } }, 'rouge', 'exact-match', 'token-f1'],
  },
  {
    id: 'ragas-nl-comparison',
    name: 'Ragas NL comparison',
    description: 'Ragas’ natural-language comparison group that this release has (BLEU and chrF come later).',
    metrics: ['factual-correctness', { metric: 'semantic-similarity', options: { method: 'embedding' } }, 'string-similarity', 'rouge', 'contains', 'exact-match'],
  },
  {
    id: 'safety',
    name: 'Safety',
    description: 'Run it on the seeded probe sets (`testpion rag probes add`): toxicity, bias, personal data, secrets, planted instructions, jailbreaks and whether the system refuses what it should (and answers what it should).',
    metrics: ['toxicity', 'bias', 'pii-leakage', 'no-leak', { metric: 'prompt-injection-resistance', options: { mode: 'both' } }, 'refusal-correctness', 'jailbreak-resistance', 'harmfulness'],
  },
  {
    id: 'conversational',
    name: 'Conversational',
    description: 'Multi-turn conversations (a dataset with `turns`): does the assistant remember, finish what the user came for, stay relevant and keep each answer grounded. Add role-adherence and topic-adherence with your role and topics.',
    metrics: ['knowledge-retention', 'conversation-completeness', 'turn-relevancy', 'user-friction', 'per-turn:faithfulness'],
  },
  {
    id: 'agentic-rag',
    name: 'Agentic RAG',
    description: 'A system that calls tools: the right calls (Ragas tool-call accuracy and F1, trajectory), good arguments, and whether the goal was reached.',
    metrics: ['tool-call-accuracy', 'tool-call-f1', 'trajectory-match', 'argument-correctness', 'goal-accuracy', 'task-completion'],
  },
  {
    id: 'multimodal',
    name: 'Multimodal',
    description: 'RAG over pictures: the answer against the images and texts that were retrieved (needs a vision judge and `allowImages` on the evaluation).',
    metrics: ['multimodal-faithfulness', 'multimodal-relevance', 'answer-relevance'],
  },
  { id: 'ops', name: 'Ops', description: 'Latency, time to first token, tokens and cost of the system under test.', metrics: ['latency', 'ttft', 'tokens', 'cost'] },
];

export function findPreset(id: string): MetricPreset | undefined {
  const key = id.trim().toLowerCase();
  return METRIC_PRESETS.find((p) => p.id === key || p.name.toLowerCase() === key);
}

/** The check configs of a preset (or of a list of metric names), each with its default threshold left to the check. */
export function presetChecks(metrics: MetricPreset['metrics']): CheckConfig[] {
  return metrics.map((m) => (typeof m === 'string' ? metricToCheck(m) : metricToCheck(m.metric, m.options)));
}

/** Every metric name of a preset resolves (the test proves it). */
export const presetUnknown = (p: MetricPreset): string[] => p.metrics.map((m) => (typeof m === 'string' ? m : m.metric)).filter((n) => !resolveMetric(n));
