/**
 * The dataset column mapper: a dataset whose columns are named however its author liked (`prompt`, `gold_answer`,
 * `doc_ids`) is read as TestPion's RAG records by choosing which column is which. The guess comes from the names tools
 * use; the person confirms it in the window. Pure functions over records; the result is a dataset text.
 */
import { listOf } from './lists.js';

type Rec = Record<string, unknown>;

/** The fields of a RAG record and the column names that usually hold them (first match wins, case and `_` / `-` ignored). */
export const RAG_FIELDS: ReadonlyArray<{ field: RagField; label: string; required?: true; list?: true; names: string[] }> = [
  { field: 'question', label: 'Question', required: true, names: ['question', 'query', 'user_input', 'input', 'prompt', 'q', 'text'] },
  { field: 'reference', label: 'Reference answer', names: ['reference', 'expected', 'expected_output', 'ground_truth', 'groundtruth', 'gold_answer', 'answer_gold', 'target', 'answers', 'label'] },
  { field: 'reference_ids', label: 'Gold chunk ids', list: true, names: ['reference_ids', 'reference_context_ids', 'gold_ids', 'doc_ids', 'positive_ids', 'relevant_ids', 'pids'] },
  { field: 'reference_contexts', label: 'Gold chunk texts', list: true, names: ['reference_contexts', 'gold_contexts', 'context', 'ground_truth_contexts', 'positive_passages'] },
  { field: 'id', label: 'Record id', names: ['id', 'question_id', 'qid', '_id', 'uid'] },
  { field: 'tags', label: 'Tags', list: true, names: ['tags', 'category', 'topic', 'type', 'persona_name'] },
  { field: 'answer', label: 'Answer already given (score without calling a system)', names: ['answer', 'response', 'actual_output', 'output'] },
  { field: 'contexts', label: 'Contexts already retrieved', list: true, names: ['contexts', 'retrieved_contexts', 'retrieval_context', 'documents'] },
];

export type RagField = 'question' | 'reference' | 'reference_ids' | 'reference_contexts' | 'id' | 'tags' | 'answer' | 'contexts';
export type ColumnMapping = Partial<Record<RagField, string>>;

const norm = (s: string) => s.toLowerCase().replace(/[\s-]+/g, '_');

/** A mapping guessed from the columns' names: each column is used for at most one field. */
export function suggestColumnMapping(columns: string[]): ColumnMapping {
  const used = new Set<string>();
  const out: ColumnMapping = {};
  for (const f of RAG_FIELDS) {
    const hit = f.names.map((n) => columns.find((c) => norm(c) === n && !used.has(c))).find(Boolean);
    if (hit) {
      out[f.field] = hit;
      used.add(hit);
    }
  }
  return out;
}

export interface MappedColumns {
  records: Rec[];
  /** Columns that were not mapped (kept as extra fields: available as {{variables}}). */
  kept: string[];
  notes: string[];
}

/** The records as TestPion's, with the chosen columns renamed and list columns read as lists; unmapped columns are kept. */
export function mapColumns(records: Rec[], mapping: ColumnMapping): MappedColumns {
  const notes: string[] = [];
  const target = new Map(Object.entries(mapping).filter(([, c]) => c).map(([field, col]) => [col as string, field as RagField]));
  const columns = new Set(records.flatMap((r) => Object.keys(r)));
  for (const col of target.keys()) if (!columns.has(col)) notes.push(`The column "${col}" is not in the dataset.`);
  const kept = [...columns].filter((c) => !target.has(c));
  let skipped = 0;
  const out: Rec[] = [];
  for (const r of records) {
    const rec: Rec = {};
    for (const [col, field] of target) {
      const v = r[col];
      if (v === undefined || v === null || v === '') continue;
      const spec = RAG_FIELDS.find((f) => f.field === field)!;
      rec[field] = spec.list ? (field === 'contexts' && Array.isArray(v) ? v : listOf(v)) : typeof v === 'string' ? v : Array.isArray(v) ? String(v[0]) : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    if (!rec.question) {
      skipped++;
      continue;
    }
    for (const c of kept) if (r[c] !== undefined) rec[c] = r[c];
    out.push(rec);
  }
  if (skipped) notes.push(`${skipped} record(s) have no question and are left out.`);
  if (!mapping.question) notes.push('No column is the question: nothing can be asked.');
  return { records: out, kept, notes };
}

/** Which of a metric's dataset inputs the columns do not give (the answer and contexts come from the target, or from the answer / contexts columns). */
export function missingDatasetInputs(requires: ReadonlyArray<string>, columns: string[], hasTarget: boolean): string[] {
  const m = suggestColumnMapping(columns);
  const cols = new Set(columns.map(norm));
  const has: Record<string, boolean> = {
    question: !!m.question,
    reference: !!m.reference,
    referenceIds: !!m.reference_ids,
    referenceContexts: !!m.reference_contexts,
    answer: hasTarget || !!m.answer,
    contexts: hasTarget || !!m.contexts,
    // the fields of a record that are not one of the main ones: present when a column of that name is
    canaries: ['canaries', 'canary', 'injection'].some((n) => cols.has(n)),
    referenceToolCalls: ['reference_tool_calls', 'expected_tools'].some((n) => cols.has(n)),
    answerable: cols.has('answerable'),
    source: cols.has('source'),
    rubric: cols.has('rubric') || cols.has('rubrics'),
    goodAnswers: cols.has('good_answers'),
    relevance: cols.has('relevance') || cols.has('qrels'),
  };
  return requires.filter((r) => has[r] === false);
}
