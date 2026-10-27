import { closeSync, createReadStream, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ResultReview, TestResult } from '../model/types.js';
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { readJson, writeJson } from '../storage/fsutil.js';
import { cursorOf, offsetOfCursor, pageLimit, SURFACE_PAGE, type PageBounds } from '../util/page.js';
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

interface ResultsPage {
  items: TestResult[];
  /** How many results match (before offset and limit). */
  total: number;
  /** The page size used. */
  limit: number;
  /** More results follow this page (ask again with `cursor: nextCursor`, or `offset` of the next position). */
  truncated: boolean;
  nextCursor?: string;
}

/** A page of results: the surfaces' page (100 unless asked, at most 500; the window asks for 50 to 500). */
const RESULTS_PAGE: PageBounds = SURFACE_PAGE;

/* ------------------------------------------------------------------ human review */

/** The reviews of a run's results, by result id (runs/<id>/reviews.json, beside the results, which stay as written). */
const runReviewsFile = (store: Pick<WorkspaceStore, 'runDir'>, runId: string) => join(store.runDir(runId), 'reviews.json');

export function runReviews(store: Pick<WorkspaceStore, 'runDir'>, runId: string): Record<string, ResultReview> {
  try {
    return readJson<Record<string, ResultReview>>(runReviewsFile(store, runId), {});
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
  writeJson(runReviewsFile(store, runId), all);
  return all[resultId];
}

/** A run's reviews as a report: the counts, and each reviewed result with its status and lowest check score. */
export async function runReviewReport(store: Pick<WorkspaceStore, 'runDir'>, runId: string) {
  if (!existsSync(runResultsFile(store, runId))) throw new ApsError('ValidationError', `No finished run ${runId}`);
  const reviews = runReviews(store, runId);
  const results: Array<Pick<TestResult, 'id' | 'name' | 'status'> & { lowestScore?: number } & ResultReview> = [];
  let total = 0;
  for await (const r of runResults(store, runId)) {
    total++;
    const review = reviews[r.id];
    if (!review) continue;
    const scores = r.checks.map((c) => c.score).filter((x): x is number => typeof x === 'number');
    results.push({ id: r.id, name: r.name, status: r.status, ...(scores.length ? { lowestScore: Math.min(...scores) } : {}), ...review });
  }
  return { ...reviewCounts(reviews, total), results };
}

/** How many results were rated good, bad, or not yet. */
export function reviewCounts(reviews: Record<string, ResultReview>, total: number): { good: number; bad: number; unreviewed: number } {
  const v = Object.values(reviews);
  const good = v.filter((r) => r.rating === 'good').length;
  const bad = v.filter((r) => r.rating === 'bad').length;
  return { good, bad, unreviewed: Math.max(0, total - v.filter((r) => r.rating).length) };
}

/* ------------------------------------------------------------------ the results index */

/** One line of a results file: where it is, and what a page's filters look at. */
interface IndexRow {
  offset: number;
  length: number;
  id: string;
  name: string;
  status: string;
}

interface ResultsIndex {
  mtimeMs: number;
  size: number;
  /** Offset after the last line that ended in a newline: the next pass over a file that grew starts here. */
  consumed: number;
  /** The lines that ended in a newline. */
  rows: IndexRow[];
  /** What the lines are for a reader: `rows`, plus a last line without a newline when it is whole (a finished file may end that way). */
  view: IndexRow[];
}

/**
 * The index of a results file (its lines' byte positions, ids, names and statuses), built by one pass over the file and
 * kept while the file is unchanged: a page, a filter keystroke or a count then reads only the lines it shows, not the
 * whole file again. A few files are kept (the runs open on screen); a run still writing is indexed from where the last pass
 * ended, not again from the start (every page or filter call during a 50,000-result run read and parsed the whole file).
 */
const indexes = new Map<string, ResultsIndex>(); // bounded: INDEXED_FILES
const INDEXED_FILES = 4;

async function resultsIndex(file: string): Promise<ResultsIndex> {
  const st = statSync(file);
  const hit = indexes.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  // a file that only grew continues from the end of its last whole line, when that line is still what was indexed
  const grew = hit && st.size >= hit.size && sameTail(file, hit);
  const rows: IndexRow[] = grew ? hit!.rows.slice() : [];
  const from = grew ? hit!.consumed : 0;
  let tail: IndexRow | undefined;
  const parse = (line: Buffer, offset: number): IndexRow | undefined => {
    const text = line.toString('utf8');
    if (!text.trim()) return undefined;
    try {
      const r = JSON.parse(text) as Partial<TestResult>;
      return { offset, length: line.length, id: String(r.id ?? ''), name: String(r.name ?? ''), status: String(r.status ?? '') };
    } catch {
      return undefined; // a torn line (the run was interrupted while writing)
    }
  };
  let base = from;
  let consumed = from;
  let carry: Buffer[] = [];
  let carried = 0;
  for await (const chunk of createReadStream(file, { start: from }) as AsyncIterable<Buffer>) {
    let start = 0;
    for (let nl = chunk.indexOf(10, start); nl !== -1; nl = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, nl);
      const row = parse(carry.length ? Buffer.concat([...carry, piece]) : piece, base + start - carried);
      if (row) rows.push(row);
      carry = [];
      carried = 0;
      start = nl + 1;
      consumed = base + start;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      carry.push(rest);
      carried += rest.length;
    }
    base += chunk.length;
  }
  if (carry.length) tail = parse(Buffer.concat(carry), base - carried);
  const index: ResultsIndex = { mtimeMs: st.mtimeMs, size: st.size, consumed, rows, view: tail ? [...rows, tail] : rows };
  indexes.delete(file);
  indexes.set(file, index);
  for (const k of indexes.keys()) {
    if (indexes.size <= INDEXED_FILES) break;
    indexes.delete(k);
  }
  return index;
}

/** The last indexed line is still the same bytes at the same place (the file was appended to, not rewritten). */
function sameTail(file: string, hit: ResultsIndex): boolean {
  const last = hit.rows[hit.rows.length - 1];
  if (!last) return hit.consumed === 0;
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(last.length);
    if (readSync(fd, buf, 0, last.length, last.offset) !== last.length) return false;
    const r = JSON.parse(buf.toString('utf8')) as Partial<TestResult>;
    return String(r.id ?? '') === last.id && String(r.name ?? '') === last.name && String(r.status ?? '') === last.status;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Forget the indexes (tests). */
export function resetResultsIndexForTest(): void {
  indexes.clear();
}

/**
 * A page of a run's results, filtered by status ('failed' means failed or error; 'reviewed' / 'unreviewed' by a
 * person's rating) and a name substring. Each result carries its review.
 */
export async function pageRunResults(store: Pick<WorkspaceStore, 'runDir'>, q: { runId: string; offset?: number; cursor?: string | number; limit?: number; status?: string; query?: string }): Promise<ResultsPage> {
  const file = runResultsFile(store, q.runId);
  const items: TestResult[] = [];
  let total = 0;
  if (!existsSync(file)) return { items, total, limit: pageLimit(q.limit, RESULTS_PAGE), truncated: false };
  const reviews = runReviews(store, q.runId);
  const offset = q.cursor !== undefined ? offsetOfCursor(q.cursor) : Math.max(0, q.offset ?? 0);
  const limit = pageLimit(q.limit, RESULTS_PAGE);
  const needle = q.query?.toLowerCase();
  const index = await resultsIndex(file);
  const page: IndexRow[] = [];
  for (const row of index.view) {
    const review = reviews[row.id];
    if (q.status === 'reviewed' ? !review?.rating : q.status === 'unreviewed' ? !!review?.rating : q.status && q.status !== 'all' && (q.status === 'failed' ? row.status !== 'failed' && row.status !== 'error' : row.status !== q.status)) continue;
    // by name (a part of it), or by the test's id exactly (a link to one result)
    if (needle && !row.name.toLowerCase().includes(needle) && row.id.toLowerCase() !== needle) continue;
    if (total >= offset && page.length < limit) page.push(row);
    total++;
  }
  // only the lines of the page are read (by their byte positions)
  if (page.length) {
    const fd = openSync(file, 'r');
    try {
      for (const row of page) {
        const buf = Buffer.alloc(row.length);
        const n = readSync(fd, buf, 0, row.length, row.offset);
        let r: TestResult;
        try {
          r = JSON.parse(buf.subarray(0, n).toString('utf8')) as TestResult;
        } catch {
          continue; // the file changed under the index (a run still writing): the next page reads it again
        }
        const review = reviews[r.id];
        items.push(review ? { ...r, review } : r);
      }
    } finally {
      closeSync(fd);
    }
  }
  const truncated = offset + page.length < total;
  return { items, total, limit, truncated, ...(truncated ? { nextCursor: cursorOf(offset + page.length) } : {}) };
}

/** Latency histogram, slowest results, results per type and most failed checks of a finished run. */
export async function breakdownOfRun(store: Pick<WorkspaceStore, 'runDir'>, runId: string): Promise<RunBreakdown> {
  const b = runBreakdown();
  for await (const r of runResults(store, runId)) b.add(r);
  return b.result();
}
