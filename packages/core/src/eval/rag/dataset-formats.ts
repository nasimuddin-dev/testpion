/**
 * RAG datasets and the two formats other tools write them in (planning/rag-testing.md §4b). Only the documented shapes
 * are read — Ragas `EvaluationDataset` / `SingleTurnSample` records and DeepEval goldens / `LLMTestCase` records — as data:
 * nothing from a file is executed. TestPion's own record is
 *
 *   { id?, question, reference?, reference_contexts?: string[], reference_ids?: string[], tags?: string[],
 *     answer?, contexts?: [{ id, text, score?, source? }] }
 *
 * where `answer` and `contexts` (an answer already given and what was retrieved for it) are only there when the file
 * came from a run; a target is called for the question anyway. Import then export keeps every column both formats share.
 */
import { datasetFormatOf, previewDatasetRecords, type DatasetTextFormat } from '@testpion/shared';
import { ApsError } from '../../errors.js';
import { listOf } from './lists.js';

export type RagDatasetFormat = 'testpion' | 'ragas' | 'deepeval';
export const RAG_DATASET_FORMATS: readonly RagDatasetFormat[] = ['testpion', 'ragas', 'deepeval'];

type Rec = Record<string, unknown>;

/** The records of a dataset text (JSON array or an object holding one, JSONL, CSV); a wrapper key of the other tools' files is looked through. */
export function parseRagDatasetText(text: string, format: DatasetTextFormat = 'jsonl'): Rec[] {
  const fmt = datasetFormatOf(text, format);
  if (fmt === 'json') {
    let d: unknown;
    try {
      d = JSON.parse(text);
    } catch (e) {
      throw new ApsError('ValidationError', `The dataset is not valid JSON: ${(e as Error).message}`);
    }
    if (Array.isArray(d)) return d.filter((x): x is Rec => !!x && typeof x === 'object');
    if (d && typeof d === 'object') {
      // DeepEval and Hugging Face style files hold the records under one key
      for (const k of ['test_cases', 'testCases', 'goldens', 'samples', 'data', 'rows', 'records', 'items'])
        if (Array.isArray((d as Rec)[k])) return ((d as Rec)[k] as unknown[]).filter((x): x is Rec => !!x && typeof x === 'object');
      return [d as Rec];
    }
    return [];
  }
  return previewDatasetRecords(text, fmt, Number.MAX_SAFE_INTEGER) as Rec[];
}

const has = (r: Rec, ...keys: string[]) => keys.some((k) => r[k] !== undefined && r[k] !== null && r[k] !== '');
const pick = (r: Rec, ...keys: string[]) => {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null && r[k] !== '') return r[k];
  return undefined;
};
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? undefined : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Which format a dataset's records are in, by the column names each tool uses. */
export function detectRagFormat(records: Rec[]): RagDatasetFormat {
  const r = records[0] ?? {};
  if (has(r, 'question') || has(r, 'reference_ids')) return 'testpion';
  if (has(r, 'user_input', 'retrieved_contexts', 'reference_contexts', 'ground_truth', 'ground_truths', 'response', 'retrieved_context_ids', 'reference_context_ids')) return 'ragas';
  if (has(r, 'input', 'expected_output', 'expectedOutput', 'actual_output', 'actualOutput', 'retrieval_context', 'retrievalContext')) return 'deepeval';
  return 'testpion';
}

const contextObjects = (texts: string[] | undefined, ids: string[] | undefined) => (texts ?? []).map((text, i) => ({ id: ids?.[i] ?? `doc-${i + 1}`, text }));

export interface ImportResult {
  records: Rec[];
  from: RagDatasetFormat;
  /** What was left out or changed, one line each (shown to the person importing). */
  notes: string[];
}

/** Records of a Ragas or DeepEval dataset as TestPion's. A record that is TestPion's own is kept as it is. */
export function importRagRecords(records: Rec[], from?: RagDatasetFormat): ImportResult {
  const fmt = from ?? detectRagFormat(records);
  const notes: string[] = [];
  const out: Rec[] = [];
  records.forEach((r, i) => {
    if (fmt === 'testpion') return void out.push(r);
    const tags: string[] = [];
    let rec: Rec;
    if (fmt === 'ragas') {
      const turns = r.user_input;
      if (Array.isArray(turns)) {
        notes.push(`Record ${i + 1} is a multi-turn sample (a list of messages); conversations are not imported yet.`);
        return;
      }
      const retrieved = listOf(pick(r, 'retrieved_contexts', 'contexts'));
      const gold = pick(r, 'reference', 'ground_truth', 'ground_truths');
      rec = {
        ...(has(r, 'id') ? { id: r.id } : {}),
        question: str(pick(r, 'user_input', 'question')) ?? '',
        ...(gold !== undefined ? { reference: Array.isArray(gold) ? str(gold[0]) : str(gold) } : {}),
        ...(listOf(r.reference_contexts) ? { reference_contexts: listOf(r.reference_contexts) } : {}),
        ...(listOf(r.reference_context_ids) ? { reference_ids: listOf(r.reference_context_ids) } : {}),
        ...(has(r, 'response', 'answer') ? { answer: str(pick(r, 'response', 'answer')) } : {}),
        ...(retrieved ? { contexts: contextObjects(retrieved, listOf(r.retrieved_context_ids)) } : {}),
      };
      for (const k of ['persona_name', 'query_style', 'query_length', 'synthesizer_name']) if (has(r, k)) tags.push(`${k.replace(/_name$/, '').replace(/_/g, '-')}:${str(r[k])}`);
      if (has(r, 'rubrics')) notes.push(`Record ${i + 1}: rubrics are kept as a column but no metric reads them yet.`), (rec.rubrics = r.rubrics);
      if (has(r, 'multi_responses')) notes.push(`Record ${i + 1}: multi_responses are not imported.`);
    } else {
      const retrieved = listOf(pick(r, 'retrieval_context', 'retrievalContext'));
      rec = {
        ...(has(r, 'name') ? { id: str(r.name) } : {}),
        question: str(pick(r, 'input')) ?? '',
        ...(has(r, 'expected_output', 'expectedOutput') ? { reference: str(pick(r, 'expected_output', 'expectedOutput')) } : {}),
        ...(listOf(r.context) ? { reference_contexts: listOf(r.context) } : {}),
        ...(has(r, 'actual_output', 'actualOutput') ? { answer: str(pick(r, 'actual_output', 'actualOutput')) } : {}),
        ...(retrieved ? { contexts: contextObjects(retrieved, undefined) } : {}),
      };
      const meta = pick(r, 'additional_metadata', 'additionalMetadata');
      if (meta && typeof meta === 'object') {
        const t = (meta as Rec).tags;
        if (Array.isArray(t)) tags.push(...t.map(String));
        rec.metadata = meta;
      }
    }
    const own = listOf(r.tags);
    if (own || tags.length) rec.tags = [...new Set([...(own ?? []), ...tags])];
    if (!rec.question) notes.push(`Record ${i + 1} has no question and is skipped.`);
    else out.push(rec);
  });
  return { records: out, from: fmt, notes };
}

/** TestPion records in a Ragas or DeepEval shape (only the columns that tool documents). */
export function exportRagRecords(records: Rec[], to: RagDatasetFormat): Rec[] {
  if (to === 'testpion') return records;
  return records.map((r) => {
    const q = str(pick(r, 'question', 'query', 'input', 'user_input')) ?? '';
    const ref = str(pick(r, 'reference', 'expected', 'ground_truth', 'expected_output'));
    const gold = listOf(r.reference_contexts);
    const ids = listOf(r.reference_ids);
    const docs = Array.isArray(r.contexts) ? (r.contexts as unknown[]).map((d) => (typeof d === 'string' ? { id: '', text: d } : { id: str((d as Rec).id) ?? '', text: str((d as Rec).text) ?? '' })) : undefined;
    const answer = str(pick(r, 'answer', 'response'));
    if (to === 'ragas')
      return {
        user_input: q,
        ...(docs ? { retrieved_contexts: docs.map((d) => d.text) } : {}),
        // an id TestPion made up for a context that had none (doc-1, doc-2 …) is not an id of the system's
        ...(docs?.some((d, i) => d.id && d.id !== `doc-${i + 1}`) ? { retrieved_context_ids: docs.map((d) => d.id) } : {}),
        ...(gold ? { reference_contexts: gold } : {}),
        ...(ids ? { reference_context_ids: ids } : {}),
        ...(answer !== undefined ? { response: answer } : {}),
        ...(ref !== undefined ? { reference: ref } : {}),
      };
    const tags = listOf(r.tags);
    return {
      input: q,
      ...(answer !== undefined ? { actual_output: answer } : {}),
      ...(ref !== undefined ? { expected_output: ref } : {}),
      ...(gold ? { context: gold } : {}),
      ...(docs ? { retrieval_context: docs.map((d) => d.text) } : {}),
      ...(tags || (r.metadata && typeof r.metadata === 'object') ? { additional_metadata: { ...((r.metadata as Rec | undefined) ?? {}), ...(tags ? { tags } : {}) } } : {}),
    };
  });
}

/** Records as JSON Lines (a TestPion dataset file) or a JSON array. */
export const stringifyRagRecords = (records: Rec[], as: 'jsonl' | 'json' = 'jsonl') => (as === 'json' ? `${JSON.stringify(records, null, 2)}\n` : records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));

/**
 * Dataset records with what a run captured for them: the answer and the retrieved contexts of each record's result
 * (`metadata.rag.sample`), so an export carries the RAG system's own answers for another tool to score. A record is
 * matched to its result by id (`<evaluation>:<record id>`, the record's position when it has no id).
 */
export function withCapturedSamples(records: Rec[], results: Array<{ id: string; metadata?: Record<string, unknown> }>): Rec[] {
  const byRecord = new Map<string, unknown>();
  for (const r of results) {
    const sample = (r.metadata?.rag as { sample?: unknown } | undefined)?.sample;
    if (sample) byRecord.set(r.id.slice(r.id.lastIndexOf(':') + 1), sample);
  }
  return records.map((r, i) => {
    const s = byRecord.get(String(r.id ?? i + 1)) as { answer?: string; contexts?: Array<{ id: string; text: string }> } | undefined;
    return s ? { ...r, answer: s.answer, contexts: s.contexts } : r;
  });
}
