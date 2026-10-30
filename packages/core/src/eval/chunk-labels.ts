/**
 * Your verdict on each retrieved document of a sample (R-4): is this document right for the question, partly, or not. The labels
 * are kept with the run (`runs/<id>/chunk-labels.json`), and the ones you mark relevant can be added to the question's right documents
 * (`reference_ids` of its record in the evaluation's test cases), so the next run measures the retrieval against documents you have
 * read. Nothing is sent to a model.
 */
import { join } from 'node:path';
import { ApsError } from '../errors.js';
import { resolveRunRef } from '../runner/eval-matrix-runs.js';
import { readRunSummary } from '../runner/run-records.js';
import { runResults } from '../runner/run-results.js';
import { EVALUATIONS_LIBRARY, findSavedEvaluation, type SavedEvaluation } from '../runner/saved-evaluations.js';
import { readJson, writeJson } from '../storage/fsutil.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { evalCaseKey } from './report.js';

export type ChunkLabel = 'relevant' | 'partly' | 'not';
export const CHUNK_LABELS: readonly ChunkLabel[] = ['relevant', 'partly', 'not'];

export interface ChunkLabelEntry {
  label: ChunkLabel;
  at: string;
}

/** Result id -> document id -> label. */
export type ChunkLabels = Record<string, Record<string, ChunkLabelEntry>>;

type Store = Pick<WorkspaceStore, 'runDir'>;
const file = (store: Store, runId: string) => join(store.runDir(runId), 'chunk-labels.json');

/** The labels of a run, by result and document. */
export function chunkLabels(store: Store, runId: string): ChunkLabels {
  try {
    return readJson<ChunkLabels>(file(store, runId), {});
  } catch {
    return {};
  }
}

/** Label a retrieved document (`label: null` clears it). Returns the labels of that result. */
export function setChunkLabel(store: Store, o: { run: string; resultId: string; doc: string; label: ChunkLabel | null }): Record<string, ChunkLabelEntry> {
  if (o.label !== null && !CHUNK_LABELS.includes(o.label)) throw new ApsError('ValidationError', `A document is relevant, partly or not, not ${String(o.label)}`);
  if (!o.doc.trim()) throw new ApsError('ValidationError', 'Name the document');
  const all = chunkLabels(store, o.run);
  const mine = { ...(all[o.resultId] ?? {}) };
  if (o.label === null) delete mine[o.doc];
  else mine[o.doc] = { label: o.label, at: new Date().toISOString() };
  if (Object.keys(mine).length) all[o.resultId] = mine;
  else delete all[o.resultId];
  writeJson(file(store, o.run), all);
  return mine;
}

export interface AddRightDocuments {
  evaluation: string;
  /** The record of the saved test cases the right documents were written to. */
  record: string;
  added: string[];
  /** Marked relevant, and already among the right documents. */
  already: string[];
  text: string;
}

/**
 * Add the documents you marked relevant for one sample to the right documents (`reference_ids`) of its question, in the saved
 * evaluation's test cases (JSONL or JSON). The next run measures the retrieval against them.
 */
export async function addRightDocuments(store: WorkspaceStore, o: { run: string; resultId: string }): Promise<AddRightDocuments> {
  const ref = resolveRunRef(store, o.run);
  const summary = readRunSummary(store, ref.runId);
  if (!summary) throw new ApsError('ConfigurationError', `Run ${ref.runId} has not finished`);
  const relevant = Object.entries(chunkLabels(store, ref.runId)[o.resultId] ?? {})
    .filter(([, e]) => e.label === 'relevant')
    .map(([doc]) => doc);
  if (!relevant.length) throw new ApsError('ValidationError', 'No document is marked relevant for this question yet', { suggestions: ['Mark the documents that answer the question as relevant first.'] });
  const saved = findSavedEvaluation(store, summary.name);
  if (saved.type !== 'rag') throw new ApsError('ValidationError', `"${saved.name}" is not an evaluation of a bot with sources`);
  if (saved.datasetFormat !== 'jsonl' && saved.datasetFormat !== 'json') throw new ApsError('ValidationError', `The questions are a ${saved.datasetFormat.toUpperCase()} table: add the right documents in the Questions tab`);
  const key = evalCaseKey(o.resultId);
  const records: Array<Record<string, unknown>> = saved.datasetFormat === 'json' ? (JSON.parse(saved.dataset || '[]') as Array<Record<string, unknown>>) : saved.dataset.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  const index = records.findIndex((r, i) => String(r.id ?? i + 1) === key);
  if (index < 0) throw new ApsError('ValidationError', `The question "${key}" is not in the saved test cases any more`);
  const rec = records[index]!;
  const have = Array.isArray(rec.reference_ids) ? rec.reference_ids.map(String) : typeof rec.reference_ids === 'string' && rec.reference_ids.trim() ? rec.reference_ids.split(/[;,]/).map((s) => s.trim()).filter(Boolean) : [];
  const added = relevant.filter((d) => !have.includes(d));
  const already = relevant.filter((d) => have.includes(d));
  if (added.length) rec.reference_ids = [...have, ...added];
  // a question marked answerable by a document is answerable
  if (added.length && rec.answerable === false) rec.answerable = true;
  const dataset = saved.datasetFormat === 'json' ? JSON.stringify(records, null, 2) : records.map((r) => JSON.stringify(r)).join('\n');
  const lib = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY);
  store.saveLibrary(EVALUATIONS_LIBRARY, { folders: lib.folders, items: lib.items.map((i) => (i.id === saved.id ? { ...i, data: { ...i.data, dataset }, updatedAt: new Date().toISOString() } : i)) });
  return {
    evaluation: saved.name,
    record: key,
    added,
    already,
    text: added.length ? `Added ${added.join(', ')} to the right documents of "${key}"${already.length ? ` (${already.join(', ')} already were)` : ''}.` : `${already.join(', ')} ${already.length === 1 ? 'is' : 'are'} already among the right documents of "${key}".`,
  };
}

/** The labels of a run as an export: one record per labelled sample with the documents by label, for a dataset or a spreadsheet. */
export async function exportChunkLabels(store: Store, runId: string): Promise<Array<{ case: string; relevant: string[]; partly: string[]; not: string[] }>> {
  const labels = chunkLabels(store, runId);
  const out: Array<{ case: string; relevant: string[]; partly: string[]; not: string[] }> = [];
  for await (const r of runResults(store, runId)) {
    const mine = labels[r.id];
    if (!mine) continue;
    const by = (l: ChunkLabel) => Object.entries(mine).filter(([, e]) => e.label === l).map(([d]) => d);
    out.push({ case: evalCaseKey(r.id), relevant: by('relevant'), partly: by('partly'), not: by('not') });
  }
  return out;
}

/**
 * Mark one retrieved document of one result right, partly right or wrong (`label: null` clears it), the same as the buttons of a sample in
 * the app; with `addToRight` the documents marked relevant also become the right documents of the question. `run` may be a run id or a ref.
 */
export async function labelDocument(
  store: WorkspaceStore,
  o: { run: string; result: string; doc: string; label: ChunkLabel | null; addToRight?: boolean },
): Promise<{ run: string; result: string; labels: Record<string, ChunkLabelEntry>; added?: AddRightDocuments }> {
  const runId = resolveRunRef(store, o.run).runId;
  const labels = setChunkLabel(store, { run: runId, resultId: o.result, doc: o.doc, label: o.label });
  return { run: runId, result: o.result, labels, ...(o.addToRight ? { added: await addRightDocuments(store, { run: runId, resultId: o.result }) } : {}) };
}
