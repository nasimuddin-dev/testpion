/**
 * The metric registry of RAG evaluation (planning/rag-testing.md §4c): ONE table that says what every metric is, which
 * the picker, `testpion rag metrics`, the MCP `rag_metrics` tool, the generated docs (`rag-metrics.md`), the estimate and
 * the matrix all read. A metric is computed by a registered check (`check`), so it works anywhere a check works: the
 * `assertions` / `evaluators` of a test, a saved evaluation, `run_tests` over MCP. Its other names (the old check names,
 * Ragas, DeepEval, NVIDIA) are aliases that resolve to the same metric; `resolveMetric` is the only resolver.
 */
import { normalizeMetricName } from '@testpion/shared';
import type { CheckConfig } from '../../model/types.js';
import { setCheckResolver } from '../checks.js';

/** What a metric reads from a sample (planning §2.2). */
export type MetricInput = 'question' | 'answer' | 'contexts' | 'reference' | 'referenceIds' | 'referenceContexts';

export const INPUT_LABELS: Record<MetricInput, string> = {
  question: 'the question',
  answer: 'the answer',
  contexts: 'the retrieved contexts',
  reference: 'a reference answer (dataset column "reference")',
  referenceIds: 'the gold chunk ids (dataset column "reference_ids")',
  referenceContexts: 'the gold chunk texts (dataset column "reference_contexts")',
};

/** How a metric is computed: from numbers and text, by a judge model, by an embedding model, or by running SQL. */
export type MetricKind = 'deterministic' | 'judged' | 'embedding' | 'sql';

export type MetricGroup = 'retrieval-judged' | 'retrieval-ir' | 'generation' | 'reference' | 'embedding' | 'operational';

export const METRIC_GROUPS: ReadonlyArray<{ id: MetricGroup; label: string }> = [
  { id: 'retrieval-judged', label: 'Retrieval, judged' },
  { id: 'retrieval-ir', label: 'Retrieval, by ids and rank (no model)' },
  { id: 'generation', label: 'Generation' },
  { id: 'reference', label: 'Answer against the reference (no model)' },
  { id: 'embedding', label: 'Embedding' },
  { id: 'operational', label: 'Operational' },
];

export interface MetricOption {
  type: 'string' | 'number' | 'boolean';
  default?: string | number | boolean;
  values?: string[];
  description: string;
}

/** The size of a typical sample, for the estimate (token counts, not characters). */
export interface SampleShape {
  questionTokens: number;
  answerTokens: number;
  contextTokens: number;
  contexts: number;
  referenceTokens: number;
}

export interface MetricEstimate {
  /** Judge model calls per sample (before the cache). */
  llmCalls: number;
  embedCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface MetricDef {
  /** The canonical id: what the matrix, the gates and the docs call it. */
  id: string;
  name: string;
  group: MetricGroup;
  kind: MetricKind;
  direction: 'higher' | 'lower';
  /** What it measures, one line. */
  what: string;
  /** How the score is computed, one line (the formula). */
  how: string;
  /** A worked example that is also a test. */
  example: string;
  requires: MetricInput[];
  /** Read when present (refine the score) but not needed. */
  optional?: MetricInput[];
  /** The default pass mark (a score at or above it passes). */
  threshold?: number;
  /** The registered check type that computes it. */
  check: string;
  /** Other names that resolve to this metric (old check names, DeepEval, NVIDIA …). */
  aliases: string[];
  /** The Ragas names (snake_case, class and legacy class) and the options that give Ragas' own semantics when one is used instead of the id. */
  ragas?: { names: string[]; options?: Record<string, unknown>; differs?: string };
  options?: Record<string, MetricOption>;
  /** `service`: the judge service (strict, cached, ledgered); `optional`: a judge when the check names one, else a heuristic. */
  judge?: 'service' | 'optional';
  /** Versioned prompts it sends (judged metrics). */
  prompts?: string[];
  /** The id of the shared pass it reads (`claims-v1`). */
  shares?: string;
  /** Calls to the judge per sample, in words (`1`, `1 + 1 shared`, `0`). */
  calls: string;
  version: string;
  sources: string[];
  estimate?(s: SampleShape, opts: Record<string, unknown>): MetricEstimate;
}

const registry = new Map<string, MetricDef>();
const names = new Map<string, { def: MetricDef; options?: Record<string, unknown>; ragas?: boolean }>();

export { normalizeMetricName };

export function registerMetric(def: MetricDef): void {
  registry.set(def.id, def);
  const put = (n: string, options?: Record<string, unknown>, ragas?: boolean) => {
    const key = normalizeMetricName(n);
    const old = names.get(key);
    if (old && old.def.id !== def.id) throw new Error(`metric name "${n}" is both ${old.def.id} and ${def.id}`);
    // the canonical id and aliases come first; a Ragas spelling does not take a name that already has a meaning
    if (!old || ragas === undefined) names.set(key, { def, options, ragas });
  };
  put(def.id);
  for (const a of def.aliases) put(a);
  for (const n of def.ragas?.names ?? []) if (!names.has(normalizeMetricName(n))) put(n, def.ragas?.options, true);
}

export interface ResolvedMetric {
  def: MetricDef;
  /** The options the spelling implies (a Ragas alias's parity options, `k` of `recall@5`), under the user's own. */
  options: Record<string, unknown>;
  /** The spelling was a Ragas name (or `ragas:`-prefixed). */
  viaRagas: boolean;
}

/** The metric a name stands for: its id, an alias, a Ragas name (`ragas:` always applies the Ragas options), `recall@5`. */
export function resolveMetric(name: string): ResolvedMetric | undefined {
  let raw = name.trim();
  let ragasPrefix = false;
  if (/^ragas:/i.test(raw)) {
    ragasPrefix = true;
    raw = raw.slice(6);
  }
  const at = /^(.+)@(\d+)$/.exec(raw);
  const key = normalizeMetricName(at ? `${at[1]}@k` : raw);
  // a trailing "score" is dropped when that finds exactly one metric (Ragas class names end with it)
  const hit = names.get(key) ?? names.get(key.replace(/-score$/, ''));
  if (!hit) return undefined;
  const parity = hit.ragas || ragasPrefix;
  const ragasOptions = parity ? { ...(hit.def.ragas?.options ?? {}), ...(hit.options ?? {}) } : {};
  return { def: hit.def, options: { ...ragasOptions, ...(at ? { k: Number(at[2]) } : {}) }, viaRagas: !!parity };
}

/** The canonical id of a name (a check type, a column, a gate), or the name itself when it is not a metric. */
export const canonicalMetricId = (name: string): string => resolveMetric(name)?.def.id ?? name;

export function getMetric(id: string): MetricDef | undefined {
  return registry.get(id);
}

/** The whole catalogue, in registration order. */
export function metricCatalogue(): MetricDef[] {
  return [...registry.values()];
}

/** The catalogue as plain data (the picker, `rag metrics --json`, the MCP tool): no functions. */
export function metricCatalogueRows(): Array<Omit<MetricDef, 'estimate'>> {
  return metricCatalogue().map(({ estimate: _e, ...d }) => d);
}

/**
 * The column a metric gets in a matrix: its id, with the @k and the mode when they matter, so `recall@5` and `recall@10`
 * (or two modes of context-relevance) are two columns, not one that is overwritten.
 */
export function columnName(id: string, options: Record<string, unknown> = {}): string {
  const base = typeof options.k === 'number' ? id.replace('@k', `@${options.k}`) : id;
  const def = registry.get(id);
  const dflt = def?.options?.mode?.default;
  const mode = typeof options.mode === 'string' && options.mode !== dflt ? ` (${options.mode})` : '';
  return base + mode;
}

/** A metric config in the form a check takes: a name (alias or id) with its options and threshold. */
export function metricToCheck(name: string, extra: Record<string, unknown> = {}): CheckConfig {
  const r = resolveMetric(name);
  const options = { ...(r?.options ?? {}), ...extra };
  return { ...options, type: r?.def.check ?? name, ...(r && !('name' in extra) && columnName(r.def.id, options) !== r.def.id ? { name: columnName(r.def.id, options) } : {}) } as CheckConfig;
}

setCheckResolver((cfg) => {
  const r = resolveMetric(cfg.type);
  return r ? { check: r.def.check, options: r.options } : undefined;
});

/** The inputs a metric is missing for a sample, with the message that says how to supply each. */
export function missingInputs(def: MetricDef, has: Partial<Record<MetricInput, boolean>>): MetricInput[] {
  return def.requires.filter((i) => !has[i]);
}
