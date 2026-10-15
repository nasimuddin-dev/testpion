/**
 * Data-driven runs and environment matrices as the workspace keeps them, under runs/scale/<id>/:
 * - run.json: the summary (a data run), or the whole matrix (a few environments);
 * - rows.jsonl: every row of a data run as it finished (index, status, values, failing step, each step's status and
 *   time), and steps.jsonl: the full step results of the rows whose detail is kept;
 * - rows.idx.json: where each row is in those files (written when the run ends), so a page of 200 rows out of 100,000
 *   is read with 200 small reads, never the whole file.
 * While a run goes, its writer pages the rows it has (the app's grid asks for the rows on screen). The newest 50 runs
 * are kept. The app's per-row grid and matrix, `testpion test --data / --env-matrix` and the MCP tools use these.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { TestResult } from '../model/types.js';
import { ApsError } from '../errors.js';
import { atomicWrite } from '../storage/fsutil.js';
import { shortId } from '../util/ids.js';
import type { DataRowResult, FlowDataRunResult } from './flow-data-run.js';
import { scaleRunStatus, type FlowRunStatus } from '@testpion/shared';
import type { FlowMatrixResult } from './flow-env-matrix.js';

/** The newest scale runs kept. */
export const KEEP_SCALE_RUNS = 50;
/** The most rows one page has. */
export const MAX_ROWS_PAGE = 500;

export type ScaleRunRecord =
  ({ id: string; kind: 'data'; file: string; environment?: string } & Omit<FlowDataRunResult, 'file'>) | ({ id: string; kind: 'matrix'; file: string } & Omit<FlowMatrixResult, 'file'>);

/** A scale run as lists show it. */
export interface ScaleRunRow {
  id: string;
  kind: 'data' | 'matrix';
  file: string;
  startedAt: string;
  durationMs: number;
  /** skipped: nothing ran (every row / environment skipped every step), so the run did not pass. */
  status: FlowRunStatus;
  /** Rows (data) or environments (matrix). */
  total: number;
  passed: number;
  failed: number;
  /** Rows / environments where nothing ran. */
  skipped: number;
  source?: string;
  environments?: string[];
  environment?: string;
}

/** Which rows a page shows. */
export type RowFilter = 'all' | 'failed' | 'passed' | 'cancelled' | 'skipped';

type Store = { path(...p: string[]): string };
const base = (store: Store) => store.path('runs', 'scale');
const ID = /^(data|matrix)-[A-Za-z0-9_-]{4,40}$/;
// the index is kept in rows.idx.json: new statuses go at the end
const STATUS = ['passed', 'failed', 'cancelled', 'skipped'] as const;

function dirOf(store: Store, id: string): string {
  if (!ID.test(id)) throw new ApsError('ValidationError', `Not a data run or matrix id: ${id}`);
  return join(base(store), id);
}

/** A new id for a scale run. */
export const scaleRunId = (kind: 'data' | 'matrix') => shortId(`${kind}-`);

/** Where a row is: [index, status (0 passed, 1 failed, 2 cancelled), offset, length, steps offset, steps length] (-1: no steps kept). */
type Entry = [number, number, number, number, number, number];

/** Insert keeping the entries in row order (rows finish out of order when several run at once). */
function insert(entries: Entry[], e: Entry): void {
  let lo = 0;
  let hi = entries.length;
  if (!hi || entries[hi - 1]![0] < e[0]) return void entries.push(e);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid]![0] < e[0]) lo = mid + 1;
    else hi = mid;
  }
  entries.splice(lo, 0, e);
}

function readAt(fd: number, offset: number, length: number): string {
  const buf = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, offset + got);
    if (!n) break;
    got += n;
  }
  return buf.toString('utf8', 0, got);
}

/** One page of rows (row order), the counts per status and how many rows match the filter. */
export interface RowsPage {
  total: number;
  matched: number;
  counts: { passed: number; failed: number; cancelled: number; skipped: number };
  offset: number;
  rows: DataRowResult[];
}

function page(dir: string, entries: Entry[], q: { offset?: number; limit?: number; status?: RowFilter }): RowsPage {
  const counts = { passed: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (const e of entries) counts[STATUS[e[1]] ?? 'failed']++;
  const want = q.status && q.status !== 'all' ? STATUS.indexOf(q.status as (typeof STATUS)[number]) : -1;
  const list = want >= 0 ? entries.filter((e) => e[1] === want) : entries;
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  const limit = Math.min(MAX_ROWS_PAGE, Math.max(1, Math.floor(q.limit ?? 200)));
  const slice = list.slice(offset, offset + limit);
  const rows: DataRowResult[] = [];
  if (slice.length) {
    const fd = openSync(join(dir, 'rows.jsonl'), 'r');
    try {
      for (const e of slice)
        try {
          rows.push(JSON.parse(readAt(fd, e[2], e[3])) as DataRowResult);
        } catch {
          /* a row cut by a crash */
        }
    } finally {
      closeSync(fd);
    }
  }
  return { total: entries.length, matched: list.length, counts, offset, rows };
}

/**
 * Writes a data run's rows (and the kept rows' step results) as they finish: synchronous appends to two files, an index
 * of where each row is (in memory while the run goes, rows.idx.json once it is closed). `page` reads the rows on screen
 * while the run still goes.
 */
export class ScaleRowsWriter {
  readonly dir: string;
  private rowsFd: number;
  private stepsFd: number;
  private rowsAt = 0;
  private stepsAt = 0;
  private entries: Entry[] = [];
  private closed = false;

  constructor(
    store: Store,
    readonly id: string,
  ) {
    this.dir = dirOf(store, id);
    mkdirSync(this.dir, { recursive: true });
    this.rowsFd = openSync(join(this.dir, 'rows.jsonl'), 'w');
    this.stepsFd = openSync(join(this.dir, 'steps.jsonl'), 'w');
  }

  write(row: DataRowResult, steps?: TestResult[]): void {
    if (this.closed) return;
    const line = Buffer.from(JSON.stringify(row) + '\n');
    writeSync(this.rowsFd, line, 0, line.length, this.rowsAt);
    let so = -1;
    let sn = 0;
    if (steps?.length) {
      const s = Buffer.from(JSON.stringify({ index: row.index, steps }) + '\n');
      writeSync(this.stepsFd, s, 0, s.length, this.stepsAt);
      so = this.stepsAt;
      sn = s.length - 1;
      this.stepsAt += s.length;
    }
    insert(this.entries, [row.index, Math.max(0, STATUS.indexOf(row.status)), this.rowsAt, line.length - 1, so, sn]);
    this.rowsAt += line.length;
  }

  /** A page of the rows written so far. */
  page(q: { offset?: number; limit?: number; status?: RowFilter } = {}): RowsPage {
    return page(this.dir, this.entries, q);
  }

  /** The kept step results of a row written so far. */
  steps(index: number): TestResult[] | undefined {
    return stepsOf(this.dir, this.entries, index);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.rowsFd);
    closeSync(this.stepsFd);
    try {
      atomicWrite(join(this.dir, 'rows.idx.json'), JSON.stringify(this.entries));
    } catch {
      /* the index is rebuilt from rows.jsonl when missing */
    }
  }
}

function stepsOf(dir: string, entries: Entry[], index: number): TestResult[] | undefined {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = entries[mid]!;
    if (e[0] === index) {
      if (e[4] < 0) return undefined;
      const fd = openSync(join(dir, 'steps.jsonl'), 'r');
      try {
        return (JSON.parse(readAt(fd, e[4], e[5])) as { steps: TestResult[] }).steps;
      } catch {
        return undefined;
      } finally {
        closeSync(fd);
      }
    }
    if (e[0] < index) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/** The index of a finished run's rows: rows.idx.json, else rebuilt by reading rows.jsonl (a run that crashed). Cached for the last few runs. */
const indexCache = new Map<string, { size: number; entries: Entry[] }>();
function indexOf(dir: string): Entry[] {
  const rowsFile = join(dir, 'rows.jsonl');
  if (!existsSync(rowsFile)) return [];
  const size = statSync(rowsFile).size;
  const hit = indexCache.get(dir);
  if (hit && hit.size === size) return hit.entries;
  let entries: Entry[] | undefined;
  try {
    const idx = join(dir, 'rows.idx.json');
    if (existsSync(idx)) entries = JSON.parse(readFileSync(idx, 'utf8')) as Entry[];
  } catch {
    entries = undefined;
  }
  if (!entries) {
    entries = [];
    const fd = openSync(rowsFile, 'r');
    try {
      const total = fstatSync(fd).size;
      let at = 0;
      let rest = '';
      let restAt = 0;
      const chunk = Buffer.allocUnsafe(1 << 20);
      while (at < total) {
        const n = readSync(fd, chunk, 0, chunk.length, at);
        if (!n) break;
        const text = rest + chunk.toString('latin1', 0, n);
        let start = 0;
        for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n', start)) {
          const line = text.slice(start, nl);
          try {
            const r = JSON.parse(Buffer.from(line, 'latin1').toString('utf8')) as DataRowResult;
            insert(entries, [r.index, Math.max(0, STATUS.indexOf(r.status)), restAt + start, nl - start, -1, 0]);
          } catch {
            /* a cut line */
          }
          start = nl + 1;
        }
        restAt += start;
        rest = text.slice(start);
        at += n;
      }
    } finally {
      closeSync(fd);
    }
  }
  indexCache.set(dir, { size, entries });
  while (indexCache.size > 4) indexCache.delete(indexCache.keys().next().value!);
  return entries;
}

/** A run whose rows / environments all skipped (nothing ran) is skipped, never passed. */
const statusOf = (r: ScaleRunRecord): ScaleRunRow['status'] => scaleRunStatus(r);

export function scaleRunRow(r: ScaleRunRecord): ScaleRunRow {
  return {
    id: r.id,
    kind: r.kind,
    file: r.file,
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    status: statusOf(r),
    ...(r.kind === 'data'
      ? { total: r.total, passed: r.passed, failed: r.failed, skipped: r.skipped ?? 0, source: r.source, ...(r.environment ? { environment: r.environment } : {}) }
      : { total: r.environments.length, passed: r.passed, failed: r.failed, skipped: r.skipped ?? 0, environments: r.environments }),
  };
}

/** Save a finished scale run (and drop the oldest past KEEP_SCALE_RUNS). */
export function saveScaleRun(store: Store, r: ScaleRunRecord): ScaleRunRow {
  const dir = dirOf(store, r.id);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, 'run.json'), JSON.stringify(r));
  try {
    const all = readdirSync(base(store)).filter((n) => ID.test(n));
    if (all.length > KEEP_SCALE_RUNS) {
      const byAge = all.map((n) => ({ n, t: statSync(join(base(store), n)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const old of byAge.slice(KEEP_SCALE_RUNS)) rmSync(join(base(store), old.n), { recursive: true, force: true });
    }
  } catch {
    /* pruning is best-effort */
  }
  return scaleRunRow(r);
}

/** A saved scale run: a data run's summary (its rows: readScaleRows), or the whole matrix. */
export function readScaleRun(store: Store, id: string): ScaleRunRecord {
  const f = join(dirOf(store, id), 'run.json');
  if (!existsSync(f)) throw new ApsError('ConfigurationError', `No data run or matrix ${id} (it may still be running, or was removed)`);
  return JSON.parse(readFileSync(f, 'utf8')) as ScaleRunRecord;
}

/** A page of a data run's rows, in row order (filtered by status). */
export function readScaleRows(store: Store, id: string, q: { offset?: number; limit?: number; status?: RowFilter } = {}): RowsPage {
  const dir = dirOf(store, id);
  return page(dir, indexOf(dir), q);
}

/** The full step results of one row of a data run (undefined when its detail was not kept). */
export function readScaleRunSteps(store: Store, id: string, index: number): TestResult[] | undefined {
  const dir = dirOf(store, id);
  const entries = indexOf(dir);
  const viaIndex = stepsOf(dir, entries, index);
  if (viaIndex || entries.some((e) => e[4] >= 0)) return viaIndex;
  // a run without its index file: look the row up in steps.jsonl
  const f = join(dir, 'steps.jsonl');
  if (!existsSync(f)) return undefined;
  for (const line of readFileSync(f, 'utf8').split('\n'))
    if (line.startsWith(`{"index":${index},`))
      try {
        return (JSON.parse(line) as { steps: TestResult[] }).steps;
      } catch {
        return undefined;
      }
  return undefined;
}

/** The saved scale runs, newest first: of one file (path inside tests/), of one kind. */
export function listScaleRuns(store: Store, q: { file?: string; kind?: 'data' | 'matrix'; limit?: number } = {}): ScaleRunRow[] {
  const dir = base(store);
  if (!existsSync(dir)) return [];
  const want = q.file?.replace(/\\/g, '/').toLowerCase();
  const rows: ScaleRunRow[] = [];
  for (const n of readdirSync(dir)) {
    if (!ID.test(n) || (q.kind && !n.startsWith(`${q.kind}-`))) continue;
    try {
      const r = readScaleRun(store, n);
      if (want && r.file.replace(/\\/g, '/').toLowerCase() !== want) continue;
      rows.push(scaleRunRow(r));
    } catch {
      /* a run being written, or a broken file */
    }
  }
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, Math.min(Math.max(q.limit ?? 30, 1), KEEP_SCALE_RUNS));
}
