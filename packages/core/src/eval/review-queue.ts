/**
 * The review queue (A-6): ten (or more) answers of a run to read and grade good or bad by you, the failed ones first and the rest
 * spread across the run, with what the checks decided kept out of sight until you have graded; then how often the checks agreed with
 * you, and the good answers added to the test cases as the expected answers. The grades are the run's reviews (`runs.review`,
 * `testpion history review`, `review_result`), so a grade given here shows everywhere else. Pure reads and one dataset write.
 */
import { ApsError } from '../errors.js';
import type { ResultReview, TestResult } from '../model/types.js';
import { resolveRunRef } from '../runner/eval-matrix-runs.js';
import { readRunSummary } from '../runner/run-records.js';
import { runResults, runReviews } from '../runner/run-results.js';
import { EVALUATIONS_LIBRARY, findSavedEvaluation, type SavedEvaluation } from '../runner/saved-evaluations.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { evalCaseKey } from './report.js';

export interface ReviewCase {
  resultId: string;
  key: string;
  /** What was asked and what was answered. */
  input?: string;
  answer?: string;
  /** The answer the dataset expects, when a record holds one. */
  expected?: string;
  /** Your grade and note, when you gave them. */
  rating?: 'good' | 'bad';
  note?: string;
  /** What the checks decided: withheld until this case is graded. */
  verdict?: { status: TestResult['status']; failedChecks: string[] };
}

export interface ReviewQueue {
  run: string;
  evaluation?: string;
  cases: ReviewCase[];
  /** How many of the queue you have graded. */
  graded: number;
  total: number;
  done: boolean;
  /** Once something is graded: how often the checks agreed with you (a passed case you called good, a failed one you called bad). */
  agreement?: { graded: number; agreed: number; percent: number };
  /** The good answers can be added to the test cases from here (a saved prompt or agent evaluation with JSONL or JSON test cases). */
  canAddToDataset: boolean;
  /** One sentence: what to do next, or how it went. */
  text: string;
}

const asText = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : typeof v === 'string' ? v : JSON.stringify(v));

/** The cases to review: the failed ones first (up to half), then the others spread across the run, in run order. */
export function pickForReview(results: TestResult[], count: number): TestResult[] {
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'error');
  const rest = results.filter((r) => r.status === 'passed');
  const takeFailed = failed.slice(0, Math.max(1, Math.ceil(count / 2)));
  const need = Math.max(0, count - takeFailed.length);
  const spread = rest.length <= need ? rest : Array.from({ length: need }, (_, i) => rest[Math.floor((i * rest.length) / need)]!);
  // a short list of failures is topped up with more failures before passes are stretched thin
  const more = takeFailed.length < failed.length && spread.length < need ? failed.slice(takeFailed.length, takeFailed.length + (need - spread.length)) : [];
  return [...takeFailed, ...more, ...spread].slice(0, count);
}

/** The queue of a run, with your grades so far. */
export async function evalReviewQueue(store: WorkspaceStore, o: { run: string; count?: number }): Promise<ReviewQueue> {
  const ref = resolveRunRef(store, o.run);
  const summary = readRunSummary(store, ref.runId);
  const all: TestResult[] = [];
  for await (const r of runResults(store, ref.runId)) if (r.status !== 'skipped') all.push(r);
  if (!all.length) throw new ApsError('ValidationError', `Run ${ref.runId} has no answers to review`);
  const count = Math.min(Math.max(1, Math.floor(o.count ?? 10)), 50);
  const reviews = runReviews(store, ref.runId);
  // reviews already given come first in the queue, so closing and opening it again continues where you left off
  const picked = pickForReview(all, count);
  const given = all.filter((r) => reviews[r.id]?.rating && !picked.includes(r));
  const chosen = [...picked, ...given].slice(0, Math.max(count, picked.length));
  const cases: ReviewCase[] = chosen.map((r) => {
    const rv: ResultReview | undefined = reviews[r.id];
    const failedChecks = (r.checks ?? []).filter((c) => !c.passed).map((c) => c.name || c.type);
    const expected = (r.checks ?? []).find((c) => c.expected !== undefined)?.expected;
    return {
      resultId: r.id,
      key: evalCaseKey(r.id),
      ...(r.input ? { input: r.input } : {}),
      ...(r.output ? { answer: r.output } : {}),
      ...(asText(expected) !== undefined ? { expected: asText(expected) } : {}),
      ...(rv?.rating ? { rating: rv.rating } : {}),
      ...(rv?.note ? { note: rv.note } : {}),
      // the checks' verdict is shown only for a case you have graded
      ...(rv?.rating ? { verdict: { status: r.status, failedChecks } } : {}),
    };
  });
  const gradedCases = cases.filter((c) => c.rating);
  const agreed = gradedCases.filter((c) => (c.rating === 'good') === (c.verdict?.status === 'passed')).length;
  const agreement = gradedCases.length ? { graded: gradedCases.length, agreed, percent: Math.round((agreed / gradedCases.length) * 100) } : undefined;
  const done = gradedCases.length === cases.length;
  const good = gradedCases.filter((c) => c.rating === 'good').length;
  const text = done
    ? `You graded ${gradedCases.length}: ${good} good, ${gradedCases.length - good} bad. The checks agreed with you on ${agreed} of ${gradedCases.length}.`
    : gradedCases.length
      ? `${gradedCases.length} of ${cases.length} graded: ${cases.length - gradedCases.length} to go.`
      : `Read ${cases.length} answers and grade each good or bad. What the checks decided stays hidden until you have graded it.`;
  let canAddToDataset = false;
  try {
    const saved = summary ? findSavedEvaluation(store, summary.name) : undefined;
    canAddToDataset = !!saved && saved.type !== 'rag' && (saved.datasetFormat === 'jsonl' || saved.datasetFormat === 'json');
  } catch {
    /* a run of something that is not a saved evaluation */
  }
  return { run: ref.runId, ...(summary ? { evaluation: summary.name } : {}), canAddToDataset, cases, graded: gradedCases.length, total: cases.length, done, ...(agreement ? { agreement } : {}), text };
}

export interface ReviewToDataset {
  evaluation: string;
  /** Good answers written as the expected answer of their record. */
  added: number;
  /** Good answers whose record already had an expected answer (kept as it was). */
  kept: number;
  /** Good answers with no record to write to (the case is not in the saved dataset any more). */
  missing: number;
  text: string;
}

/**
 * Add the answers you graded good to the evaluation's test cases: each becomes the expected answer of its record (a record that
 * already has one keeps it). The dataset must be JSONL or JSON; a CSV or Markdown table is edited in the Test cases tab.
 */
export async function reviewToDataset(store: WorkspaceStore, o: { run: string; resultIds?: string[] }): Promise<ReviewToDataset> {
  const ref = resolveRunRef(store, o.run);
  const summary = readRunSummary(store, ref.runId);
  if (!summary) throw new ApsError('ConfigurationError', `Run ${ref.runId} has not finished`);
  const saved = findSavedEvaluation(store, summary.name);
  if (saved.type === 'rag') throw new ApsError('ValidationError', 'A bot with sources keeps its reference answers in its questions: edit them in Questions', { suggestions: [] });
  const reviews = runReviews(store, ref.runId);
  const good = Object.entries(reviews).filter(([id, r]) => r.rating === 'good' && (!o.resultIds || o.resultIds.includes(id)));
  if (!good.length) throw new ApsError('ValidationError', 'No answer of this run is graded good yet', { suggestions: ['Grade some answers first (Review answers), then add the good ones.'] });
  const format = saved.datasetFormat;
  if (format !== 'jsonl' && format !== 'json') throw new ApsError('ValidationError', `The test cases are a ${format.toUpperCase()} table: add the expected answers in the Test cases tab`, { suggestions: ['Use JSONL or JSON test cases to add them from here.'] });
  const records: Array<Record<string, unknown>> = format === 'json' ? (JSON.parse(saved.dataset || '[]') as Array<Record<string, unknown>>) : saved.dataset.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  const field = saved.expectedField || 'expected';
  const answers = new Map<string, string>();
  // the answer of each good result, by the key of its record (its id, or its place in the dataset)
  {
    for await (const r of runResults(store, ref.runId)) if (reviews[r.id]?.rating === 'good' && good.some(([id]) => id === r.id) && r.output) answers.set(evalCaseKey(r.id), r.output);
    let added = 0;
    let kept = 0;
    let missing = 0;
    const touched = new Set<string>();
    records.forEach((rec, i) => {
      const key = String(rec.id ?? i + 1);
      const answer = answers.get(key);
      if (answer === undefined) return;
      touched.add(key);
      if (rec[field] !== undefined && rec[field] !== null && String(rec[field]).trim() !== '') kept++;
      else {
        rec[field] = answer;
        added++;
      }
    });
    missing = [...answers.keys()].filter((k) => !touched.has(k)).length;
    const dataset = format === 'json' ? JSON.stringify(records, null, 2) : records.map((r) => JSON.stringify(r)).join('\n');
    const lib = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY);
    store.saveLibrary(EVALUATIONS_LIBRARY, { folders: lib.folders, items: lib.items.map((i) => (i.id === saved.id ? { ...i, data: { ...i.data, dataset }, updatedAt: new Date().toISOString() } : i)) });
    return {
      evaluation: saved.name,
      added,
      kept,
      missing,
      text: `Added ${added} good answer${added === 1 ? '' : 's'} as the expected answer${added === 1 ? '' : 's'} of "${saved.name}"${kept ? `; ${kept} already had one and keep it` : ''}${missing ? `; ${missing} have no record in the test cases any more` : ''}.`,
    };
  }
}
