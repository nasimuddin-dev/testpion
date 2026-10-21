/**
 * What an evaluation can be built from: the inputs a dataset and a target supply, and the metric catalogue seen through them
 * (which metrics could run on this data, which lack an input and which). The model is shown only runnable metrics in full;
 * the build and the verifier use the same answer, so a metric is never offered that the run would fail on.
 */
import type { RagTarget } from '@testpion/shared';
import { docsOf, listOf } from '../lists.js';
import { INPUT_LABELS, metricCatalogue, type MetricDef, type MetricInput } from '../metric-registry.js';
import { pickRecord } from '../record.js';
import { sampleInputs, type TrySample } from '../try-metric.js';

type Rec = Record<string, unknown>;
const first = (r: Rec, ...keys: string[]): unknown => {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null && r[k] !== '') return r[k];
  return undefined;
};
const text = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? undefined : String(v));

/** A dataset record as the metrics read it (the spellings of TestPion, Ragas and DeepEval datasets). */
export function sampleOfRecord(r: Rec): TrySample {
  const ctx = first(r, 'contexts', 'retrieved_contexts', 'retrieval_context');
  return {
    question: text(first(r, 'question', 'query', 'input', 'user_input')),
    answer: text(first(r, 'answer', 'response', 'actual_output')),
    reference: text(first(r, 'reference', 'expected', 'ground_truth', 'expected_output')),
    referenceIds: listOf(first(r, 'reference_ids', 'reference_context_ids')),
    referenceContexts: listOf(first(r, 'reference_contexts', 'context')),
    contexts: ctx === undefined ? undefined : docsOf(ctx),
    record: pickRecord(r),
  };
}

/**
 * The inputs the data can supply, each with where it comes from: `dataset` when a record has it, `target` when the system
 * under test produces it (its answer; contexts and scores when the mapping reads them; its latency).
 */
export function suppliedInputs(records: Rec[], target?: Pick<RagTarget, 'mapping'>): Partial<Record<MetricInput, 'dataset' | 'target'>> {
  const out: Partial<Record<MetricInput, 'dataset' | 'target'>> = {};
  for (const r of records) for (const [k, v] of Object.entries(sampleInputs(sampleOfRecord(r)))) if (v) out[k as MetricInput] = 'dataset';
  if (target) {
    for (const k of ['answer', 'latency'] as const) out[k] ??= 'target';
    if (target.mapping?.contexts) out.contexts ??= 'target';
    if (target.mapping?.context?.score) out.scores ??= 'target';
    // the target is asked the question; a dataset without one cannot be run
  }
  return out;
}

interface CatalogueEntry {
  id: string;
  group: string;
  kind: MetricDef['kind'];
  direction: MetricDef['direction'];
  reads: MetricInput[];
  judgeCalls: string;
  threshold?: number;
  what: string;
  runnable: boolean;
  /** What is missing, in words, when it cannot run. */
  missing?: string[];
}

/** The catalogue as the plan sees it, for the inputs that are there. */
export function catalogueFor(supplied: Partial<Record<MetricInput, string>>): CatalogueEntry[] {
  return metricCatalogue().map((d) => {
    const miss = d.requires.filter((i) => !supplied[i]);
    return {
      id: d.id,
      group: d.group,
      kind: d.kind,
      direction: d.direction,
      reads: d.requires,
      judgeCalls: d.calls,
      ...(d.threshold !== undefined ? { threshold: d.threshold } : {}),
      what: d.what,
      runnable: !miss.length,
      ...(miss.length ? { missing: miss.map((i) => INPUT_LABELS[i]) } : {}),
    };
  });
}

/** What the model is shown of the catalogue: the runnable metrics in full, the others as one line each (so it can say what to add). */
export function catalogueContext(rows: CatalogueEntry[]): { metrics: Array<Omit<CatalogueEntry, 'runnable' | 'missing'> & { runnable: true }>; notRunnable: Array<{ id: string; missing: string[] }> } {
  return {
    metrics: rows.filter((r) => r.runnable).map(({ missing: _m, ...r }) => ({ ...r, runnable: true as const })),
    notRunnable: rows.filter((r) => !r.runnable).map((r) => ({ id: r.id, missing: r.missing ?? [] })),
  };
}
