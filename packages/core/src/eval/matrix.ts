/**
 * Evaluations as a matrix: rows are the cases (dataset records), columns the variants that ran them (a run each — a
 * prompt × model — or one column per model when a run holds several), cells a case's status and score in a variant.
 * Against a baseline run each cell is regressed, improved, unchanged, new or missing, with the score delta.
 *
 * Host-agnostic: it reads results from async iterables (a run's results.jsonl, a server's store, a test's array) and
 * answers pages, so a renderer never holds the full result set (5,000 cases × 10 variants is a 200-row page plus the
 * aggregates). Cells are kept in typed arrays, one per column: 50,000 cells cost ~1 MB besides their result ids.
 */
import type { TestResult, TestStatus } from '../model/types.js';
import { ApsError } from '../errors.js';
import { round } from '../util/stats.js';

/** The tags a person wrote: an evaluation run also tags each case with the prompt it was sent with (`prompt:<hash>`, runner/prompt-versions.ts), which is not a filter to show. */
const userTags = (tags: string[] | undefined): string[] | undefined => {
  const own = tags?.filter((x) => !x.startsWith('prompt:'));
  return own?.length ? own : undefined;
};

type EvalCellStatus = TestStatus;
type EvalChange = 'regressed' | 'improved' | 'unchanged' | 'new' | 'missing';

/** The default score drop (and rise) that counts as a change: the regression report's scoreDrop. */
const DEFAULT_EVAL_THRESHOLD = 0.05;

/** What a cell needs to be compared: whether it passed and its mean score (0 to 1) when it has scored checks. */
interface EvalCellValue {
  status: string;
  score?: number;
}

/**
 * One cell against the baseline's cell of the same case. A case that stopped passing regressed and one that started
 * passing improved, whatever the score; otherwise the score moved by more than `threshold` (strictly: a drop of
 * exactly the threshold is unchanged). Skipped and absent are both "not run": only in the baseline → missing, only
 * here → new. Deltas are rounded to 4 decimals before they are compared (0.1 − 0.05 is not 0.05000000000000001).
 */
export function compareEvalCell(cur: EvalCellValue | undefined, base: EvalCellValue | undefined, threshold = DEFAULT_EVAL_THRESHOLD): { change: EvalChange; delta?: number } | undefined {
  const ran = (c: EvalCellValue | undefined): c is EvalCellValue => !!c && c.status !== 'skipped';
  if (!ran(cur)) return ran(base) ? { change: 'missing' } : undefined;
  if (!ran(base)) return { change: 'new' };
  const delta = typeof cur.score === 'number' && typeof base.score === 'number' && Number.isFinite(cur.score) && Number.isFinite(base.score) ? round(cur.score - base.score, 4) : undefined;
  const ok = cur.status === 'passed';
  const was = base.status === 'passed';
  const d = delta === undefined ? {} : { delta };
  if (was && !ok) return { change: 'regressed', ...d };
  if (!was && ok) return { change: 'improved', ...d };
  if (delta !== undefined && -delta > threshold) return { change: 'regressed', ...d };
  if (delta !== undefined && delta > threshold) return { change: 'improved', ...d };
  return { change: 'unchanged', ...d };
}

/** The mean of a result's scored checks, rounded to 4 decimals; undefined when no check has a score. */
export function resultScore(r: Pick<TestResult, 'checks'>): number | undefined {
  let sum = 0;
  let n = 0;
  for (const c of r.checks ?? []) {
    if (typeof c.score === 'number' && Number.isFinite(c.score)) {
      sum += c.score;
      n++;
    }
  }
  return n ? round(sum / n, 4) : undefined;
}

/* ------------------------------------------------------------------ building */

/** A run to read: its results in the order they were written. */
export interface EvalMatrixSource {
  runId: string;
  name: string;
  startedAt?: string;
  results: AsyncIterable<TestResult>;
}

export interface EvalMatrixColumn {
  /** `runId`, or `runId|model` for one model of a run with several. */
  key: string;
  runId: string;
  runName: string;
  /** "Intent v2 · gpt-4o": the run's name, and the model when it tells columns apart or is known. */
  label: string;
  model?: string;
  startedAt?: string;
}

export interface EvalColumnStats {
  cases: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Mean of the scored cells, undefined when none is scored. */
  meanScore?: number;
  /** Against the baseline (zero without one). */
  regressed: number;
  improved: number;
  unchanged: number;
  missing: number;
  added: number;
  /** Mean of the cells' score deltas against the baseline (cells scored on both sides). */
  meanDelta?: number;
}

const STATUS: EvalCellStatus[] = ['passed', 'failed', 'error', 'skipped'];
const CHANGE: EvalChange[] = ['regressed', 'improved', 'unchanged', 'new', 'missing'];
const statusCode = (s: string) => {
  const i = STATUS.indexOf(s as EvalCellStatus);
  return i < 0 ? 3 : i + 1; // an unknown status counts as an error
};

/** One variant's cells, by row (0 = no result). */
interface Col {
  meta: EvalMatrixColumn;
  status: Uint8Array;
  score: Float32Array;
  ids: Array<string | undefined>;
  /** The baseline comparison, by row (0 = none). */
  change: Uint8Array;
  delta: Float32Array;
  /** Which of the baseline's columns this one is compared with. */
  baseline?: number;
}

interface RawColumn {
  meta: Omit<EvalMatrixColumn, 'key' | 'label'>;
  cells: Map<string, { id: string; status: number; score?: number; name: string; tags?: string[] }>;
}

/**
 * The case a result is of. Evaluation ids are `<evaluation slug>:<record id>`: when every result of a run shares
 * that prefix it is dropped, so runs of differently named evaluations (two prompts, two models) line up by record.
 */
function commonPrefix(ids: string[]): string {
  if (!ids.length) return '';
  const first = ids[0]!;
  const i = first.indexOf(':');
  if (i <= 0) return '';
  const p = first.slice(0, i + 1);
  return ids.every((id) => id.startsWith(p) && id.length > p.length) ? p : '';
}

/** Read a run's results into one column per model (one column when it has one model or none). */
async function readSource(src: EvalMatrixSource, maxCases: number): Promise<RawColumn[]> {
  const byModel = new Map<string, Array<{ r: TestResult; score?: number }>>();
  let n = 0;
  for await (const r of src.results) {
    if (!r || typeof r.id !== 'string') continue;
    if (++n > maxCases) throw new ApsError('ValidationError', `Run ${src.runId} has more than ${maxCases.toLocaleString('en')} results: too many for the matrix`);
    const model = typeof r.model === 'string' ? r.model : '';
    let list = byModel.get(model);
    if (!list) byModel.set(model, (list = []));
    // only what the matrix needs: the result itself (output, checks …) is read again when a cell is opened
    list.push({ r: { id: r.id, name: r.name, status: r.status, checks: [], tags: Array.isArray(r.tags) ? userTags(r.tags.map(String)) : undefined } as unknown as TestResult, score: resultScore(r) });
  }
  // results without a model beside results with one (an error before the model answered): they join the run's model
  if (byModel.size === 2 && byModel.has('')) {
    const [[other, rest]] = [...byModel].filter(([m]) => m !== '');
    rest!.push(...byModel.get('')!);
    byModel.delete('');
    byModel.set(other!, rest!);
  }
  const prefix = commonPrefix([...byModel.values()].flatMap((l) => l.map((x) => x.r.id)));
  return [...byModel].map(([model, list]) => {
    const cells: RawColumn['cells'] = new Map();
    for (const { r, score } of list) {
      // the same case twice (a dataset with repeated ids): numbered, so no result hides another
      let key = r.id.slice(prefix.length);
      if (cells.has(key)) for (let i = 2; cells.has((key = `${r.id.slice(prefix.length)}#${i}`)); i++);
      // "Intent v2 [42]" of the run "Intent v2" says no more than the case key: no name then
      const named = /^(.*) \[[^\]]*\]$/.exec(r.name ?? '');
      cells.set(key, { id: r.id, status: statusCode(r.status), score, name: named && named[1] === src.name ? '' : r.name, tags: userTags(r.tags) });
    }
    return { meta: { runId: src.runId, runName: src.name, startedAt: src.startedAt, ...(model ? { model } : {}) }, cells };
  });
}

/** A row's name: the first result's name that says more than the case key, else the key. */
const caseName = (name: string | undefined, key: string) => (typeof name === 'string' && name ? name : key);

export interface EvalMatrixQuery {
  offset?: number;
  /** Rows per page (1–1000; default 200). */
  limit?: number;
  /** failed: a variant failed it · regressed / improved / missing: against the baseline, in any variant · changed: regressed or improved. */
  filter?: 'all' | 'failed' | 'regressed' | 'improved' | 'changed' | 'missing';
  /** Only cases with this tag. */
  tag?: string;
  /** Cases whose id or name contains this (case-insensitive). */
  search?: string;
  /** case: natural order of the case ids · score / delta: of `column` (or the worst over all) · failures: most failing variants first. */
  sort?: 'case' | 'score' | 'delta' | 'failures';
  column?: number;
  dir?: 'asc' | 'desc';
}

export interface EvalMatrixRowCell {
  /** passed / failed / error / skipped; absent: the variant has no result for the case. */
  status?: EvalCellStatus;
  score?: number;
  change?: EvalChange;
  delta?: number;
  /** The result's id in the column's run (opens the case detail). */
  id?: string;
  /** The baseline's cell, when compared. */
  baseline?: { status?: EvalCellStatus; score?: number; id?: string };
}

export interface EvalMatrixRow {
  /** Position in the whole matrix (stable across filters). */
  index: number;
  key: string;
  name: string;
  tags?: string[];
  cells: EvalMatrixRowCell[];
}

export interface EvalMatrixPage {
  columns: Array<EvalMatrixColumn & { stats: EvalColumnStats }>;
  baseline?: EvalMatrixColumn[];
  threshold: number;
  /** Cases in the matrix, and those the filter keeps. */
  cases: number;
  total: number;
  offset: number;
  rows: EvalMatrixRow[];
  /** Cases per filter chip (over all cases, the tag and search applied). */
  counts: { all: number; failed: number; regressed: number; improved: number; changed: number; missing: number };
  /** The tags of the cases, most used first (at most 50). */
  tags: Array<{ tag: string; count: number }>;
}

/** A built matrix: the cells of every variant, and pages of them filtered and sorted. */
export class EvalMatrix {
  readonly cases: number;
  private readonly keys: string[];
  private readonly names: string[];
  private readonly rowTags: Array<string[] | undefined>;
  private readonly cols: Col[];
  private readonly base: Col[];
  private order?: { key: string; rows: Int32Array };
  private counted?: { key: string; counts: EvalMatrixPage['counts'] };
  private readonly stats: EvalColumnStats[];
  private readonly allTags: Array<{ tag: string; count: number }>;

  constructor(
    raw: RawColumn[],
    rawBase: RawColumn[],
    readonly threshold: number,
  ) {
    // rows: every case of the variants, then the baseline's own (missing everywhere), in the order they ran
    const index = new Map<string, number>();
    this.keys = [];
    this.names = [];
    this.rowTags = [];
    for (const c of [...raw, ...rawBase])
      for (const [key, cell] of c.cells) {
        let i = index.get(key);
        if (i === undefined) {
          index.set(key, (i = this.keys.length));
          this.keys.push(key);
          this.names.push(caseName(cell.name, key));
          this.rowTags.push(cell.tags?.length ? cell.tags : undefined);
        } else {
          if (cell.tags?.length) this.rowTags[i] = [...new Set([...(this.rowTags[i] ?? []), ...cell.tags])];
          if (this.names[i] === key && cell.name) this.names[i] = cell.name;
        }
      }
    this.cases = this.keys.length;
    const multi = new Map<string, number>();
    for (const c of raw) multi.set(c.meta.runId, (multi.get(c.meta.runId) ?? 0) + 1);
    const build = (c: RawColumn): Col => {
      const status = new Uint8Array(this.cases);
      const score = new Float32Array(this.cases).fill(NaN);
      const ids: Array<string | undefined> = new Array(this.cases);
      for (const [key, cell] of c.cells) {
        const i = index.get(key)!;
        status[i] = cell.status;
        if (cell.score !== undefined) score[i] = cell.score;
        ids[i] = cell.id;
      }
      const several = (multi.get(c.meta.runId) ?? 1) > 1;
      const meta: EvalMatrixColumn = {
        ...c.meta,
        key: several && c.meta.model ? `${c.meta.runId}|${c.meta.model}` : c.meta.runId,
        label: c.meta.model ? `${c.meta.runName} · ${c.meta.model}` : c.meta.runName,
      };
      return { meta, status, score, ids, change: new Uint8Array(this.cases), delta: new Float32Array(this.cases).fill(NaN) };
    };
    this.cols = raw.map(build);
    this.base = rawBase.map(build);
    // each variant against the baseline's column of the same model, else the baseline's first
    for (const col of this.cols) {
      if (!this.base.length) break;
      const b = Math.max(
        0,
        this.base.findIndex((x) => x.meta.model === col.meta.model),
      );
      col.baseline = b;
      const bc = this.base[b]!;
      for (let i = 0; i < this.cases; i++) {
        const r = compareEvalCell(this.value(col, i), this.value(bc, i), threshold);
        if (!r) continue;
        col.change[i] = CHANGE.indexOf(r.change) + 1;
        if (r.delta !== undefined) col.delta[i] = r.delta;
      }
    }
    this.stats = this.cols.map((c) => this.columnStats(c));
    const tagCount = new Map<string, number>();
    for (const t of this.rowTags) for (const x of t ?? []) tagCount.set(x, (tagCount.get(x) ?? 0) + 1);
    this.allTags = [...tagCount]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, 50);
  }

  get columns(): EvalMatrixColumn[] {
    return this.cols.map((c) => c.meta);
  }

  private value(c: Col, i: number): EvalCellValue | undefined {
    const s = c.status[i]!;
    if (!s) return undefined;
    const score = c.score[i]!;
    return { status: STATUS[s - 1]!, ...(Number.isNaN(score) ? {} : { score: round(score, 4) }) };
  }

  private columnStats(c: Col): EvalColumnStats {
    const st: EvalColumnStats = { cases: 0, passed: 0, failed: 0, skipped: 0, regressed: 0, improved: 0, unchanged: 0, missing: 0, added: 0 };
    let sum = 0;
    let n = 0;
    let dsum = 0;
    let dn = 0;
    for (let i = 0; i < this.cases; i++) {
      const s = c.status[i]!;
      if (s) {
        st.cases++;
        if (s === 1) st.passed++;
        else if (s === 4) st.skipped++;
        else st.failed++;
        const sc = c.score[i]!;
        if (!Number.isNaN(sc)) {
          sum += sc;
          n++;
        }
      }
      const ch = c.change[i]!;
      if (ch) {
        const k = CHANGE[ch - 1]!;
        if (k === 'new') st.added++;
        else st[k]++;
      }
      const d = c.delta[i]!;
      if (!Number.isNaN(d)) {
        dsum += d;
        dn++;
      }
    }
    if (n) st.meanScore = round(sum / n, 4);
    if (dn) st.meanDelta = round(dsum / dn, 4);
    return st;
  }

  private has(i: number, f: NonNullable<EvalMatrixQuery['filter']>): boolean {
    if (f === 'all') return true;
    for (const c of this.cols) {
      if (f === 'failed') {
        const s = c.status[i]!;
        if (s === 2 || s === 3) return true;
        continue;
      }
      const ch = c.change[i]! ? CHANGE[c.change[i]! - 1] : undefined;
      if (ch && (ch === f || (f === 'changed' && (ch === 'regressed' || ch === 'improved')))) return true;
    }
    return false;
  }

  /** The rows a query keeps, in its order (kept for the next page of the same query). */
  private rowsOf(q: EvalMatrixQuery): Int32Array {
    const filter = q.filter ?? 'all';
    const tag = q.tag || undefined;
    const search = q.search?.trim().toLowerCase() || undefined;
    const col = q.column !== undefined && q.column >= 0 && q.column < this.cols.length ? q.column : undefined;
    const sort = q.sort ?? 'case';
    const dir = q.dir === 'desc' ? -1 : 1;
    const key = JSON.stringify([filter, tag, search, sort, col, dir]);
    if (this.order?.key === key) return this.order.rows;
    const keep: number[] = [];
    for (let i = 0; i < this.cases; i++) {
      if (tag && !this.rowTags[i]?.includes(tag)) continue;
      if (search && !this.keys[i]!.toLowerCase().includes(search) && !this.names[i]!.toLowerCase().includes(search)) continue;
      if (this.has(i, filter)) keep.push(i);
    }
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    const byCase = (a: number, b: number) => collator.compare(this.keys[a]!, this.keys[b]!) || a - b;
    const cols = col === undefined ? this.cols : [this.cols[col]!];
    // a sort value per row (lowest first in ascending order); rows without one go last whichever the direction
    const value = (i: number): number => {
      if (sort === 'failures') return -cols.reduce((n, c) => n + (c.status[i] === 2 || c.status[i] === 3 ? 1 : 0), 0);
      let v = Infinity;
      for (const c of cols) {
        const x = sort === 'score' ? c.score[i]! : c.delta[i]!;
        if (!Number.isNaN(x) && x < v) v = x;
      }
      return v;
    };
    if (sort === 'case') keep.sort((a, b) => dir * byCase(a, b));
    else {
      const vals = new Float64Array(this.cases);
      for (const i of keep) vals[i] = value(i);
      keep.sort((a, b) => {
        const x = vals[a]!;
        const y = vals[b]!;
        if (x === y) return byCase(a, b);
        if (x === Infinity) return 1;
        if (y === Infinity) return -1;
        return dir * (x - y);
      });
    }
    const rows = Int32Array.from(keep);
    this.order = { key, rows };
    return rows;
  }

  private cell(c: Col, i: number): EvalMatrixRowCell {
    const s = c.status[i]!;
    const out: EvalMatrixRowCell = {};
    if (s) {
      out.status = STATUS[s - 1];
      const sc = c.score[i]!;
      if (!Number.isNaN(sc)) out.score = round(sc, 4);
      out.id = c.ids[i];
    }
    if (c.change[i]) out.change = CHANGE[c.change[i]! - 1];
    if (!Number.isNaN(c.delta[i]!)) out.delta = round(c.delta[i]!, 4);
    if (c.baseline !== undefined) {
      const b = this.base[c.baseline]!;
      const bs = b.status[i]!;
      if (bs) out.baseline = { status: STATUS[bs - 1], ...(Number.isNaN(b.score[i]!) ? {} : { score: round(b.score[i]!, 4) }), id: b.ids[i] };
    }
    return out;
  }

  /** The chip counts with the tag and search applied, so a chip says what clicking it shows (kept for the next page). */
  private countsOf(q: EvalMatrixQuery): EvalMatrixPage['counts'] {
    const tag = q.tag || undefined;
    const search = q.search?.trim().toLowerCase() || undefined;
    const key = JSON.stringify([tag, search]);
    if (this.counted?.key === key) return { ...this.counted.counts };
    const counts = { all: 0, failed: 0, regressed: 0, improved: 0, changed: 0, missing: 0 };
    for (let i = 0; i < this.cases; i++) {
      if (tag && !this.rowTags[i]?.includes(tag)) continue;
      if (search && !this.keys[i]!.toLowerCase().includes(search) && !this.names[i]!.toLowerCase().includes(search)) continue;
      counts.all++;
      if (this.has(i, 'failed')) counts.failed++;
      if (this.base.length) {
        const reg = this.has(i, 'regressed');
        const imp = this.has(i, 'improved');
        if (reg) counts.regressed++;
        if (imp) counts.improved++;
        if (reg || imp) counts.changed++;
        if (this.has(i, 'missing')) counts.missing++;
      }
    }
    this.counted = { key, counts };
    return { ...counts };
  }

  /** A page of rows with the column stats, the chip counts and the tags. */
  page(q: EvalMatrixQuery = {}): EvalMatrixPage {
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(q.limit) || 200)));
    const offset = Math.max(0, Math.floor(Number(q.offset) || 0));
    const rows = this.rowsOf(q);
    const out: EvalMatrixRow[] = [];
    for (let k = offset; k < Math.min(rows.length, offset + limit); k++) {
      const i = rows[k]!;
      out.push({ index: i, key: this.keys[i]!, name: this.names[i]!, ...(this.rowTags[i] ? { tags: this.rowTags[i] } : {}), cells: this.cols.map((c) => this.cell(c, i)) });
    }
    const counts = this.countsOf(q);
    return {
      columns: this.cols.map((c, k) => ({ ...c.meta, stats: this.stats[k]! })),
      ...(this.base.length ? { baseline: this.base.map((b) => b.meta) } : {}),
      threshold: this.threshold,
      cases: this.cases,
      total: rows.length,
      offset,
      rows: out,
      counts,
      tags: this.allTags,
    };
  }
}

/** Limits: the matrix is for comparing variants, not for every run of a workspace. */
const EVAL_MATRIX_LIMITS = { columns: 40, runs: 20, casesPerRun: 200_000 };

/** Check a threshold: a score difference from 0 to 1. */
export function evalThreshold(v: unknown): number {
  if (v === undefined || v === null || v === '') return DEFAULT_EVAL_THRESHOLD;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new ApsError('ValidationError', `The threshold is a score difference from 0 to 1 (got ${String(v)})`);
  return n;
}

/**
 * Build the matrix of `sources` (the variants, in column order) against `baseline` (optional). A run with several
 * models becomes a column per model.
 */
export async function buildEvalMatrix(sources: EvalMatrixSource[], baseline?: EvalMatrixSource, o: { threshold?: number } = {}): Promise<EvalMatrix> {
  if (!sources.length) throw new ApsError('ValidationError', 'Pick at least one run for the matrix');
  if (sources.length > EVAL_MATRIX_LIMITS.runs) throw new ApsError('ValidationError', `At most ${EVAL_MATRIX_LIMITS.runs} runs side by side (got ${sources.length})`);
  const threshold = evalThreshold(o.threshold);
  const raw = (await Promise.all(sources.map((s) => readSource(s, EVAL_MATRIX_LIMITS.casesPerRun)))).flat();
  if (raw.length > EVAL_MATRIX_LIMITS.columns) throw new ApsError('ValidationError', `These runs make ${raw.length} columns (one per model): at most ${EVAL_MATRIX_LIMITS.columns}`);
  const rawBase = baseline ? await readSource(baseline, EVAL_MATRIX_LIMITS.casesPerRun) : [];
  return new EvalMatrix(raw, rawBase, threshold);
}
