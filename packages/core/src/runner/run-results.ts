import { createReadStream, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ResultReview, TestResult } from '../model/types.js';
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { readResultsFile } from './runner.js';
import { runBreakdown, type RunBreakdown } from './breakdown.js';

/** Reading a finished run's results (runs/<id>/results.jsonl), streamed: the app, the MCP tools and the CLI share these. */

export const runResultsFile = (store: Pick<WorkspaceStore, 'runDir'>, runId: string) => join(store.runDir(runId), 'results.jsonl');

/** Every result of a run, in order. */
export async function* runResults(store: Pick<WorkspaceStore, 'runDir'>, runId: string): AsyncGenerator<TestResult> {
  const file = runResultsFile(store, runId);
  if (!existsSync(file)) return;
  for await (const r of await readResultsFile(file)) yield r;
}

export interface ResultsPage {
  items: TestResult[];
  /** How many results match (before offset and limit). */
  total: number;
}

/* ------------------------------------------------------------------ human review */

/** The reviews of a run's results, by result id (runs/<id>/reviews.json, beside the results, which stay as written). */
export const runReviewsFile = (store: Pick<WorkspaceStore, 'runDir'>, runId: string) => join(store.runDir(runId), 'reviews.json');

export function runReviews(store: Pick<WorkspaceStore, 'runDir'>, runId: string): Record<string, ResultReview> {
  const f = runReviewsFile(store, runId);
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as Record<string, ResultReview>;
  } catch {
    return {};
  }
}

/**
 * Rate a result good or bad and say why (`null`, or neither a rating nor a note, clears the review). The app, the
 * CLI (`testpion history review`) and agents (`review_result`) share it. Returns the result's review after the change.
 */
export function reviewResult(
  store: Pick<WorkspaceStore, 'runDir'>,
  runId: string,
  resultId: string,
  review: { rating?: 'good' | 'bad' | null; note?: string | null; by?: string } | null,
): ResultReview | undefined {
  if (!existsSync(runResultsFile(store, runId))) throw new ApsError('ValidationError', `No finished run ${runId}`, { suggestions: ['Take the run id from the app, run_tests or `testpion history list`.'] });
  if (review?.rating !== undefined && review.rating !== null && review.rating !== 'good' && review.rating !== 'bad')
    throw new ApsError('ValidationError', `A rating is good or bad, not ${String(review.rating)}`);
  const all = runReviews(store, runId);
  const prev = all[resultId];
  const rating = review === null ? undefined : review.rating === undefined ? prev?.rating : (review.rating ?? undefined);
  const note = review === null ? undefined : review.note === undefined ? prev?.note : review.note?.trim() || undefined;
  if (!rating && !note) delete all[resultId];
  else all[resultId] = { ...(rating ? { rating } : {}), ...(note ? { note: note.slice(0, 2000) } : {}), at: new Date().toISOString(), ...(review?.by ? { by: review.by } : prev?.by ? { by: prev.by } : {}) };
  const f = runReviewsFile(store, runId);
  writeFileSync(`${f}.tmp`, JSON.stringify(all, null, 2));
  renameSync(`${f}.tmp`, f);
  return all[resultId];
}

/** How many results were rated good, bad, or not yet. */
export function reviewCounts(reviews: Record<string, ResultReview>, total: number): { good: number; bad: number; unreviewed: number } {
  const v = Object.values(reviews);
  const good = v.filter((r) => r.rating === 'good').length;
  const bad = v.filter((r) => r.rating === 'bad').length;
  return { good, bad, unreviewed: Math.max(0, total - v.filter((r) => r.rating).length) };
}

/**
 * A page of a run's results, filtered by status ('failed' means failed or error; 'reviewed' / 'unreviewed' by a
 * person's rating) and a name substring. Each result carries its review.
 */
export async function pageRunResults(store: Pick<WorkspaceStore, 'runDir'>, q: { runId: string; offset?: number; limit?: number; status?: string; query?: string }): Promise<ResultsPage> {
  const file = runResultsFile(store, q.runId);
  const items: TestResult[] = [];
  let total = 0;
  if (!existsSync(file)) return { items, total };
  const reviews = runReviews(store, q.runId);
  const offset = q.offset ?? 0;
  const limit = q.limit ?? 100;
  const needle = q.query?.toLowerCase();
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r: TestResult;
    try {
      r = JSON.parse(line) as TestResult;
    } catch {
      continue; // a torn line (the run was interrupted while writing)
    }
    const review = reviews[r.id];
    if (q.status === 'reviewed' ? !review?.rating : q.status === 'unreviewed' ? !!review?.rating : q.status && q.status !== 'all' && (q.status === 'failed' ? r.status !== 'failed' && r.status !== 'error' : r.status !== q.status)) continue;
    if (needle && !r.name.toLowerCase().includes(needle)) continue;
    if (total >= offset && items.length < limit) items.push(review ? { ...r, review } : r);
    total++;
  }
  return { items, total };
}

/** Latency histogram, slowest results, results per type and most failed checks of a finished run. */
export async function breakdownOfRun(store: Pick<WorkspaceStore, 'runDir'>, runId: string): Promise<RunBreakdown> {
  const b = runBreakdown();
  for await (const r of runResults(store, runId)) b.add(r);
  return b.result();
}
