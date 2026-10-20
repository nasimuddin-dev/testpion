/**
 * The Ragas side of a RAG run (planning/rag-testing.md §2.6): the metric names Ragas writes in its result tables, an
 * evaluation-level `compat: ragas` that gives every metric Ragas' own options, and the import of a Ragas result table (the
 * CSV or JSON of `EvaluationResult.to_pandas()`) so its scores sit as columns beside TestPion's for the same samples. Only data is
 * read: nothing of a Ragas result is executed.
 */
import { csvRecords } from '@testpion/shared';
import type { CheckConfig } from '../../model/types.js';
import { ApsError } from '../../errors.js';
import { normalizeMetricName, resolveMetric, getMetric } from './metric-registry.js';

/** `LLMContextRecall` → `llm_context_recall`; `nv_accuracy` stays. */
const snake = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

/** The column Ragas gives a metric in its result table: `answer_relevancy`, `nv_accuracy`, `context_entity_recall` … */
export function ragasColumnName(id: string): string {
  const def = getMetric(id) ?? resolveMetric(id)?.def;
  if (!def) return snake(id);
  return def.ragas?.key ?? snake(def.ragas?.names.find((n) => /^[a-z0-9_]+$/.test(n)) ?? def.id.replace(/@k$/, ''));
}

/**
 * Evaluators with Ragas' own definitions: each metric gets the options its Ragas name carries (reverse-question answer
 * relevance, per-chunk context precision, the model mode of entity recall …); a choice the evaluator already makes wins.
 */
export function applyRagasCompat(evaluators: CheckConfig[]): CheckConfig[] {
  return evaluators.map((e) => {
    const r = resolveMetric(`ragas:${e.type}`);
    if (!r || !Object.keys(r.options).length) return e;
    const { k: _k, ...parity } = r.options as Record<string, unknown>;
    return { ...parity, ...e };
  });
}

export interface ExternalScores {
  /** Where the scores come from, for the column headers ("Ragas"). */
  source: string;
  /** The metric columns, as the file names them. */
  metrics: string[];
  rows: Array<{ question?: string; scores: Record<string, number | null> }>;
}

const DATA_COLUMNS = new Set(['user_input', 'question', 'query', 'input', 'response', 'answer', 'actual_output', 'retrieved_contexts', 'retrieval_context', 'reference', 'ground_truth', 'expected_output', 'reference_contexts', 'retrieved_context_ids', 'reference_context_ids', 'multi_responses', 'rubrics', 'persona_name', 'query_style', 'query_length', 'id', 'index', 'unnamed_0', 'contexts', 'context', 'tags', 'synthesizer_name', 'rubric']);
const QUESTION_COLUMNS = ['user_input', 'question', 'query', 'input'];

/** The `EvaluationResult` table of Ragas: a CSV with a header, a JSON list of rows, or JSON Lines. Columns that hold numbers and are not data are metrics. */
export function parseRagasResult(text: string, o: { source?: string } = {}): ExternalScores {
  const t = text.replace(/^﻿/, '').trim();
  if (!t) throw new ApsError('ValidationError', 'The Ragas result is empty');
  let records: Array<Record<string, unknown>>;
  if (/^[[{]/.test(t)) {
    try {
      const v = JSON.parse(t) as unknown;
      const list = Array.isArray(v) ? v : Array.isArray((v as { scores?: unknown }).scores) ? (v as { scores: unknown[] }).scores : Array.isArray((v as { rows?: unknown }).rows) ? (v as { rows: unknown[] }).rows : Array.isArray((v as { data?: unknown }).data) ? (v as { data: unknown[] }).data : undefined;
      if (!list) throw new Error('not a list of rows');
      records = list.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
    } catch {
      // JSON Lines
      records = t.split(/\r?\n/).filter(Boolean).map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          throw new ApsError('ValidationError', 'The Ragas result is not a CSV, a JSON list of rows or JSON Lines');
        }
      });
    }
  } else {
    const [head, ...rest] = csvRecords(t);
    records = rest.map((cells) => Object.fromEntries((head ?? []).map((h, i) => [h.trim(), cells[i] ?? ''])));
  }
  if (!records.length) throw new ApsError('ValidationError', 'The Ragas result has no rows');
  const columns = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const isNumber = (v: unknown) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(v));
  const metrics = columns.filter((c) => !DATA_COLUMNS.has(snake(c)) && records.some((r) => isNumber(r[c])) && records.every((r) => r[c] === undefined || r[c] === null || r[c] === '' || isNumber(r[c]) || /^(nan|null|none)$/i.test(String(r[c]))));
  if (!metrics.length) throw new ApsError('ValidationError', 'The Ragas result has no metric column (a column of scores such as faithfulness or answer_relevancy)', { suggestions: [`Columns found: ${columns.join(', ')}`] });
  const qcol = columns.find((c) => QUESTION_COLUMNS.includes(snake(c)));
  return {
    source: o.source ?? 'Ragas',
    metrics,
    rows: records.map((r) => ({
      ...(qcol && typeof r[qcol] === 'string' ? { question: r[qcol] as string } : {}),
      scores: Object.fromEntries(metrics.map((m) => [m, isNumber(r[m]) ? Number(r[m]) : null])),
    })),
  };
}

const key = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** The external row of each sample: by the question's text (the first unused row with it), else by position when every sample has one. */
export function matchExternal(questions: Array<string | undefined>, ext: ExternalScores): Array<number | undefined> {
  const byQuestion = new Map<string, number[]>();
  ext.rows.forEach((r, i) => r.question && (byQuestion.get(key(r.question)) ?? byQuestion.set(key(r.question), []).get(key(r.question))!).push(i));
  const hasQuestions = ext.rows.some((r) => r.question);
  return questions.map((q, i) => {
    if (hasQuestions) return q ? byQuestion.get(key(q))?.shift() : undefined;
    return questions.length === ext.rows.length ? i : undefined;
  });
}

/**
 * The score of every metric of a run for every dataset record, as columns: `names: ragas` names them the way Ragas names
 * them in its result table, so the same file can be handed to Ragas and the two tools' scores compared column by column.
 * A record is matched to its result by id (`<evaluation>:<record id>`, the position when it has no id).
 */
export function metricScoreColumns(records: Array<Record<string, unknown>>, results: Array<{ id: string; checks?: Array<{ type: string; name?: string; score?: number; metadata?: unknown }> }>, o: { names?: 'testpion' | 'ragas' } = {}): Array<Record<string, number | null>> {
  const byRecord = new Map(results.map((r) => [r.id.slice(r.id.lastIndexOf(':') + 1), r]));
  return records.map((rec, i) => {
    const r = byRecord.get(String(rec.id ?? i + 1));
    const out: Record<string, number | null> = {};
    for (const c of r?.checks ?? []) {
      const na = !!(c.metadata as { na?: string } | undefined)?.na;
      const name = o.names === 'ragas' ? ragasColumnName(c.type) : c.name || c.type;
      out[name] = typeof c.score === 'number' && !na ? c.score : null;
    }
    return out;
  });
}

export { normalizeMetricName };
