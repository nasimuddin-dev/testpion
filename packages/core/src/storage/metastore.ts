import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import type { HistoryEntry, RunSummary } from '../model/types.js';
import { atomicWrite } from './fsutil.js';

export interface TraceMeta {
  id: string;
  name: string;
  kind: string;
  status: string;
  startTime: number;
  durationMs: number;
  spanCount: number;
  runId?: string;
  path: string;
}

export interface RunMeta {
  id: string;
  name: string;
  startedAt: string;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  environment?: string;
  dir: string;
}

/** One day of workspace activity (local calendar day of the caller). */
export interface ActivityDay {
  /** YYYY-MM-DD */
  day: string;
  requests: number;
  /** Requests that failed: HTTP 4xx/5xx, transport errors, non-OK gRPC codes, MCP tool errors. */
  failedRequests: number;
  /** Median duration of that day's requests, when known. */
  medianMs?: number;
  runs: number;
  /** Runs with at least one failed or errored test. */
  failedRuns: number;
  tests: number;
  failedTests: number;
}

export interface Activity {
  days: ActivityDay[];
  /** Median duration of all the period's requests, when known. */
  medianMs?: number;
  /** Requests in the period per kind (http, graphql, grpc, mcp, llm, websocket). */
  byKind: Record<string, number>;
  /** Slowest requests of the period, by name. */
  slowest: Array<{ name: string; kind: string; durationMs: number; count: number }>;
}

/** Whether a history status means the request worked. */
export function historyOk(status: number | string | undefined): boolean {
  if (status === undefined || status === null || status === '') return true;
  const n = typeof status === 'number' ? status : Number(status);
  if (!isNaN(n)) return n > 0 && n < 400;
  return /^(ok|passed|success|connected|closed)$/i.test(String(status));
}

/**
 * Per-day activity of the last `days` days, from history and runs.
 * `tzOffsetMin` is the caller's offset (Date#getTimezoneOffset) so days follow the user's calendar.
 */
export function summarizeActivity(
  history: Array<Pick<HistoryEntry, 'timestamp' | 'kind' | 'status' | 'durationMs' | 'name'> | ActivityRow>,
  runs: Array<Pick<RunMeta, 'startedAt' | 'total' | 'passed' | 'failed' | 'errors'>>,
  opts: { days?: number; tzOffsetMin?: number; now?: number } = {},
): Activity {
  const n = Math.max(1, Math.min(opts.days ?? 14, 90));
  const off = (opts.tzOffsetMin ?? 0) * 60_000;
  const dayOf = (t: number) => new Date(t - off).toISOString().slice(0, 10);
  const now = opts.now ?? Date.now();
  const days: ActivityDay[] = [];
  const index = new Map<string, ActivityDay>();
  for (let i = n - 1; i >= 0; i--) {
    const d: ActivityDay = { day: dayOf(now - i * 86_400_000), requests: 0, failedRequests: 0, runs: 0, failedRuns: 0, tests: 0, failedTests: 0 };
    days.push(d);
    index.set(d.day, d);
  }
  const durations = new Map<string, number[]>();
  const all: number[] = [];
  const byKind: Record<string, number> = {};
  const slow = new Map<string, { name: string; kind: string; total: number; count: number }>();
  for (const h of history) {
    const pre = 'day' in h ? h : undefined;
    const d = index.get(pre ? pre.day : dayOf(Date.parse((h as HistoryEntry).timestamp)));
    if (!d) continue;
    d.requests++;
    if (!(pre ? pre.ok : historyOk((h as HistoryEntry).status))) d.failedRequests++;
    byKind[h.kind] = (byKind[h.kind] ?? 0) + 1;
    if (typeof h.durationMs === 'number' && h.durationMs >= 0) {
      (durations.get(d.day) ?? durations.set(d.day, []).get(d.day)!).push(h.durationMs);
      all.push(h.durationMs);
      const key = `${h.kind} ${h.name}`;
      const s = slow.get(key) ?? { name: h.name, kind: h.kind, total: 0, count: 0 };
      s.total += h.durationMs;
      s.count++;
      slow.set(key, s);
    }
  }
  const median = (list: number[]) => {
    list.sort((a, b) => a - b);
    const m = list.length >> 1;
    return Math.round(list.length % 2 ? list[m]! : (list[m - 1]! + list[m]!) / 2);
  };
  for (const [day, list] of durations) index.get(day)!.medianMs = median(list);
  for (const r of runs) {
    const d = index.get(dayOf(Date.parse(r.startedAt)));
    if (!d) continue;
    d.runs++;
    d.tests += r.total;
    d.failedTests += r.failed + r.errors;
    if (r.failed + r.errors > 0) d.failedRuns++;
  }
  const slowest = [...slow.values()]
    .map((s) => ({ name: s.name, kind: s.kind, durationMs: Math.round(s.total / s.count), count: s.count }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5);
  return { days, medianMs: all.length ? median(all) : undefined, byKind, slowest };
}

/** A history row for summarizeActivity with its local day and historyOk(status) already worked out. */
export interface ActivityRow {
  day: string;
  ok: boolean | number;
  kind: string;
  name: string;
  durationMs?: number | null;
}

/** How the saved requests of a collection have been doing, from the responses sent in the app. */
export interface RequestStat {
  requestId: string;
  /** Responses recorded (the newest 50 count for the median). */
  count: number;
  failed: number;
  lastStatus?: number | string;
  lastAt: string;
  lastOk: boolean;
  medianMs?: number;
  /** The latest results, oldest first (up to 10): passed or failed. */
  recent?: string[];
}

/** Per saved request: responses, failures, the latest status and the median time of the latest 50. Rows newest first. */
export function summarizeRequestStats(rows: Array<{ requestId?: string; timestamp: string; status?: number | string; durationMs?: number; checksOk?: boolean }>): RequestStat[] {
  // a response is fine when its own checks passed (an expected 404 is), else by its status
  const ok = (r: { status?: number | string; checksOk?: boolean }) => (typeof r.checksOk === 'boolean' ? r.checksOk : historyOk(r.status));
  const by = new Map<string, { stat: RequestStat; times: number[] }>();
  for (const r of rows) {
    if (!r.requestId) continue;
    let e = by.get(r.requestId);
    if (!e) {
      e = { stat: { requestId: r.requestId, count: 0, failed: 0, lastStatus: r.status, lastAt: r.timestamp, lastOk: ok(r), recent: [] }, times: [] };
      by.set(r.requestId, e);
    }
    e.stat.count++;
    if (!ok(r)) e.stat.failed++;
    if (typeof r.durationMs === 'number' && e.times.length < 50) e.times.push(r.durationMs);
    // rows come newest first: prepend so the strip reads oldest to newest
    if (e.stat.recent!.length < 10) e.stat.recent!.unshift(ok(r) ? 'passed' : 'failed');
  }
  return [...by.values()].map(({ stat, times }) => {
    if (times.length) {
      times.sort((a, b) => a - b);
      const m = times.length >> 1;
      stat.medianMs = Math.round(times.length % 2 ? times[m]! : (times[m - 1]! + times[m]!) / 2);
    }
    return stat;
  });
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface ListQuery {
  query?: string;
  kind?: string;
  /** History only: entries sent from this saved request. */
  requestId?: string;
  /** History only: only responses that failed (4xx/5xx, transport errors, non-OK gRPC codes, MCP tool errors). */
  failed?: boolean;
  /** History only: the list columns without `request` and `responseMeta` (lists that show only the summary; `getHistory` has the rest). */
  brief?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Metadata store for history, runs and traces. Only small metadata rows live here —
 * large payloads, traces and results are separate files on disk (spec §25).
 */
export interface MetaStore {
  readonly backend: 'sqlite' | 'jsonl';
  addHistory(e: HistoryEntry): void;
  listHistory(q?: ListQuery): Page<HistoryEntry>;
  getHistory(id: string): HistoryEntry | undefined;
  deleteHistory(id: string): void;
  clearHistory(): void;
  addRun(summary: RunSummary, dir: string): void;
  listRuns(q?: ListQuery): Page<RunMeta>;
  deleteRun(id: string): void;
  addTrace(t: TraceMeta): void;
  listTraces(q?: ListQuery): Page<TraceMeta>;
  getTrace(id: string): TraceMeta | undefined;
  /** Workspace activity per day (requests, failures, runs) for charts. */
  activity(opts?: { days?: number; tzOffsetMin?: number }): Activity;
  /** Per saved request of a collection: responses, failures, latest status, median time. */
  requestStats(collectionId: string): RequestStat[];
  /** Per collection: how many of its saved requests were sent, and how many of those failed the last time. */
  historyByCollection(): Record<string, { sent: number; failing: number }>;
  /** Run `fn` in one transaction (a burst of inserts: a run's traces). Nested calls join the outer one. */
  batch<T>(fn: () => T): T;
  close(): void;
}

/** Longest string kept in a history entry's request (a body, a prompt): history is for finding and re-sending, not archiving. */
export const HISTORY_VALUE_MAX = 64 * 1024;

/** The request with every string longer than HISTORY_VALUE_MAX cut to that length, and whether anything was cut. */
export function capHistoryRequest(v: unknown): { value: unknown; cut: boolean } {
  let cut = false;
  const walk = (x: unknown, depth: number): unknown => {
    if (typeof x === 'string') {
      if (x.length <= HISTORY_VALUE_MAX) return x;
      cut = true;
      return x.slice(0, HISTORY_VALUE_MAX);
    }
    if (!x || typeof x !== 'object' || depth > 20) return x;
    if (Array.isArray(x)) {
      let out: unknown[] | undefined;
      x.forEach((e, i) => {
        const w = walk(e, depth + 1);
        if (w !== e) (out ??= [...x])[i] = w;
      });
      return out ?? x;
    }
    let out: Record<string, unknown> | undefined;
    for (const [k, e] of Object.entries(x)) {
      const w = walk(e, depth + 1);
      if (w !== e) (out ??= { ...(x as Record<string, unknown>) })[k] = w;
    }
    return out ?? x;
  };
  const value = walk(v, 0);
  return { value, cut };
}

/** Start of the activity window (one extra day so any time zone's first day is complete). */
const activitySince = (days = 14) => new Date(Date.now() - (Math.min(Math.max(days, 1), 90) + 1) * 86_400_000).toISOString();

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown };
  close(): void;
};

let sqliteModule: { DatabaseSync: new (path: string) => SqliteDb } | null | undefined;
function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    // silence the ExperimentalWarning printed by some Node versions
    const emit = process.emitWarning;
    process.emitWarning = (() => undefined) as typeof process.emitWarning;
    try {
      // getBuiltinModule works in both ESM and bundled CJS (Electron main process)
      const gbm = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
      sqliteModule = (gbm ? gbm('node:sqlite') : createRequire(import.meta.url)('node:sqlite')) as typeof sqliteModule;
    } finally {
      process.emitWarning = emit;
    }
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

/** v2: history has collection_id, request_id and status_ok columns (indexed) instead of reading them out of `doc`. */
const SQLITE_SCHEMA_VERSION = 2;

/** History entries and traces kept; older ones are pruned, with their files. */
const MAX_HISTORY = 20_000;
const MAX_TRACES = 50_000;
/** Pruning runs once per this many inserts (not on every one: a run can add thousands of traces). */
const PRUNE_EVERY = 200;

/**
 * Delete the files of removed history entries (response bodies in payloads/) and traces (traces/…).
 * Only files inside those two folders of the workspace are touched, whatever the stored path says.
 */
function removeFiles(root: string, paths: Array<string | null | undefined>): void {
  const allowed = [resolve(root, 'payloads') + sep, resolve(root, 'traces') + sep];
  for (const p of paths) {
    if (!p) continue;
    const file = resolve(root, p);
    if (!allowed.some((a) => file.startsWith(a))) continue;
    try {
      rmSync(file, { force: true });
    } catch {
      /* in use or already gone: it stays until the next clean-up */
    }
  }
}

class SqliteMetaStore implements MetaStore {
  readonly backend = 'sqlite' as const;
  private db: SqliteDb;
  private root: string;
  /** Prepared once: inserts happen for every request sent and every trace of a run. */
  private statements = new Map<string, ReturnType<SqliteDb['prepare']>>();
  private inserts = { history: 0, traces: 0 };
  private batchDepth = 0;

  private stmt(sql: string) {
    let s = this.statements.get(sql);
    if (!s) this.statements.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  constructor(path: string, Db: new (p: string) => SqliteDb) {
    mkdirSync(dirname(path), { recursive: true });
    this.root = dirname(path);
    this.db = new Db(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-16000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    const row = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
    const v = row ? Number(row.value) : 0;
    if (v < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, ts TEXT, kind TEXT, name TEXT, method TEXT, url TEXT, status TEXT, duration REAL, size INTEGER, trace_id TEXT, payload TEXT, doc TEXT);
        CREATE INDEX IF NOT EXISTS history_ts ON history(ts DESC);
        CREATE INDEX IF NOT EXISTS history_kind ON history(kind);
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, name TEXT, started TEXT, duration REAL, total INTEGER, passed INTEGER, failed INTEGER, skipped INTEGER, errors INTEGER, environment TEXT, dir TEXT);
        CREATE INDEX IF NOT EXISTS runs_started ON runs(started DESC);
        CREATE TABLE IF NOT EXISTS traces (id TEXT PRIMARY KEY, name TEXT, kind TEXT, status TEXT, start INTEGER, duration REAL, spans INTEGER, run_id TEXT, path TEXT);
        CREATE INDEX IF NOT EXISTS traces_start ON traces(start DESC);
      `);
    }
    if (v < 2) {
      // columns the lists filter on, backfilled from each row's doc, in one transaction with the schema bump
      this.batch(() => {
        const cols = new Set((this.db.prepare('PRAGMA table_info(history)').all() as Array<{ name: string }>).map((c) => c.name));
        for (const [c, type] of [
          ['collection_id', 'TEXT'],
          ['request_id', 'TEXT'],
          ['status_ok', 'INTEGER'],
        ] as const)
          if (!cols.has(c)) this.db.exec(`ALTER TABLE history ADD COLUMN ${c} ${type}`);
        this.db.exec("UPDATE history SET collection_id = json_extract(doc, '$.collectionId'), request_id = json_extract(doc, '$.requestId') WHERE json_valid(doc)");
        const set = this.db.prepare('UPDATE history SET status_ok = ? WHERE rowid = ?');
        for (const r of this.db.prepare('SELECT rowid AS id, status FROM history').all() as Array<{ id: number; status: string | null }>) set.run(historyOk(statusOf(r.status)) ? 1 : 0, r.id);
        this.db.exec(`
          DROP INDEX IF EXISTS history_kind;
          CREATE INDEX IF NOT EXISTS history_kind_ts ON history(kind, ts DESC);
          CREATE INDEX IF NOT EXISTS history_collection_ts ON history(collection_id, ts DESC);
          CREATE INDEX IF NOT EXISTS history_request_ts ON history(request_id, ts DESC);
        `);
        this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema', ?)").run(String(SQLITE_SCHEMA_VERSION));
      });
    }
  }

  batch<T>(fn: () => T): T {
    if (this.batchDepth > 0) return fn();
    this.db.exec('BEGIN');
    this.batchDepth++;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw e;
    } finally {
      this.batchDepth--;
    }
  }

  /** Bound a table to `max` rows: counted first (the common case is "nothing to do"), then the oldest by `order` go, by rowid, with their files. */
  private prune(table: 'history' | 'traces', order: string, fileCol: string, max: number): void {
    const n = (this.stmt(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    if (n <= max) return;
    const old = this.db.prepare(`SELECT rowid AS id, ${fileCol} AS file FROM ${table} ORDER BY ${order} ASC LIMIT ?`).all(n - max) as Array<{ id: number; file: string | null }>;
    this.batch(() => {
      const del = this.stmt(`DELETE FROM ${table} WHERE rowid = ?`);
      for (const r of old) del.run(r.id);
    });
    removeFiles(this.root, old.map((r) => r.file));
  }

  /** `total` of a page: free when the page is not full, else counted (indexed filters are cheap; a text query scans). */
  private total(from: string, w: { sql: string; args: unknown[] }, q: ListQuery, got: number): number {
    const limit = q.limit ?? 100;
    if (got < limit && (got > 0 || !q.offset)) return (q.offset ?? 0) + got;
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM ${from} ${w.sql}`).get(...w.args) as { n: number }).n;
  }

  addHistory(e: HistoryEntry): void {
    // long bodies are cut: the entry is then a preview of what was sent
    const req = capHistoryRequest(e.request);
    const doc = { request: req.value, responseMeta: e.responseMeta, collectionId: e.collectionId, requestId: e.requestId, ...(req.cut || e.requestPreview ? { requestPreview: true } : {}) };
    this.stmt('INSERT OR REPLACE INTO history (id, ts, kind, name, method, url, status, duration, size, trace_id, payload, doc, collection_id, request_id, status_ok) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      e.id,
      e.timestamp,
      e.kind,
      e.name,
      e.method ?? null,
      e.url ?? null,
      e.status === undefined ? null : String(e.status),
      e.durationMs ?? null,
      e.size ?? null,
      e.traceId ?? null,
      e.payloadPath ?? null,
      JSON.stringify(doc),
      e.collectionId ?? null,
      e.requestId ?? null,
      historyOk(e.status) ? 1 : 0,
    );
    // bound history size (and delete the saved response bodies of what goes)
    if (this.inserts.history++ % PRUNE_EVERY === 0) this.prune('history', 'ts', 'payload', MAX_HISTORY);
  }

  private where(q: ListQuery, cols: string[]): { sql: string; args: unknown[] } {
    const parts: string[] = [];
    const args: unknown[] = [];
    if (q.kind) {
      parts.push('kind = ?');
      args.push(q.kind);
    }
    if (q.query) {
      parts.push('(' + cols.map((c) => `${c} LIKE ?`).join(' OR ') + ')');
      for (const _ of cols) args.push(`%${q.query}%`);
    }
    return { sql: parts.length ? 'WHERE ' + parts.join(' AND ') : '', args };
  }

  listHistory(q: ListQuery = {}): Page<HistoryEntry> {
    const w = this.where(q, ['name', 'url', 'method', 'status']);
    if (q.requestId) {
      w.sql = (w.sql ? w.sql + ' AND ' : 'WHERE ') + 'request_id = ?';
      w.args.push(q.requestId);
    }
    // status_ok is historyOk(status), set on insert
    if (q.failed) w.sql = (w.sql ? w.sql + ' AND ' : 'WHERE ') + 'status_ok = 0';
    const cols = q.brief ? 'id, ts, kind, name, method, url, status, duration, size, trace_id, payload, collection_id, request_id' : '*';
    const rows = this.db.prepare(`SELECT ${cols} FROM history ${w.sql} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(...w.args, q.limit ?? 100, q.offset ?? 0) as Array<Record<string, unknown>>;
    return { total: this.total('history', w, q, rows.length), items: rows.map(historyRow) };
  }

  getHistory(id: string): HistoryEntry | undefined {
    const r = this.db.prepare('SELECT * FROM history WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? historyRow(r) : undefined;
  }

  deleteHistory(id: string): void {
    const row = this.db.prepare('SELECT payload FROM history WHERE id = ?').get(id) as { payload: string | null } | undefined;
    this.db.prepare('DELETE FROM history WHERE id = ?').run(id);
    removeFiles(this.root, [row?.payload]);
  }

  clearHistory(): void {
    // the saved response bodies go too: "clear" must not leave them on disk
    const rows = this.db.prepare('SELECT payload FROM history WHERE payload IS NOT NULL').all() as Array<{ payload: string }>;
    this.db.exec('DELETE FROM history');
    removeFiles(this.root, rows.map((r) => r.payload));
  }

  addRun(s: RunSummary, dir: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO runs (id, name, started, duration, total, passed, failed, skipped, errors, environment, dir) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(s.runId, s.name, s.startedAt, s.durationMs, s.total, s.passed, s.failed, s.skipped, s.errors, s.environment ?? null, dir);
  }

  listRuns(q: ListQuery = {}): Page<RunMeta> {
    const w = this.where({ query: q.query }, ['name']);
    const rows = this.db.prepare(`SELECT * FROM runs ${w.sql} ORDER BY started DESC LIMIT ? OFFSET ?`).all(...w.args, q.limit ?? 100, q.offset ?? 0) as Array<Record<string, unknown>>;
    return {
      total: this.total('runs', w, q, rows.length),
      items: rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        startedAt: r.started as string,
        durationMs: r.duration as number,
        total: r.total as number,
        passed: r.passed as number,
        failed: r.failed as number,
        skipped: r.skipped as number,
        errors: r.errors as number,
        environment: (r.environment as string) ?? undefined,
        dir: r.dir as string,
      })),
    };
  }

  deleteRun(id: string): void {
    this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
  }

  activity(opts: { days?: number; tzOffsetMin?: number } = {}): Activity {
    const since = activitySince(opts.days);
    const runs = (this.db.prepare('SELECT started, total, passed, failed, errors FROM runs WHERE started >= ?').all(since) as Array<Record<string, number | string>>).map((r) => ({
      startedAt: r.started as string,
      total: Number(r.total),
      passed: Number(r.passed),
      failed: Number(r.failed),
      errors: Number(r.errors),
    }));
    // only the columns counted, with the local day and the status verdict worked out by SQLite (no date parsing per row)
    const hist = this.stmt('SELECT date(ts, ?) AS day, kind, name, status_ok AS ok, duration AS durationMs FROM history WHERE ts >= ?').all(`${-(opts.tzOffsetMin ?? 0)} minutes`, since) as unknown as ActivityRow[];
    return summarizeActivity(hist, runs, opts);
  }

  requestStats(collectionId: string): RequestStat[] {
    const rows = this.stmt("SELECT ts, status, duration, request_id AS rid, json_extract(doc, '$.responseMeta.checksOk') AS cok FROM history WHERE collection_id = ? ORDER BY ts DESC LIMIT 5000").all(
      collectionId,
    ) as Array<Record<string, unknown>>;
    return summarizeRequestStats(
      rows.map((r) => ({
        requestId: (r.rid as string) ?? undefined,
        timestamp: r.ts as string,
        status: statusOf(r.status),
        durationMs: (r.duration as number) ?? undefined,
        checksOk: r.cok === null || r.cok === undefined ? undefined : !!r.cok,
      })),
    );
  }

  historyByCollection(): Record<string, { sent: number; failing: number }> {
    // the newest row of each saved request (one index probe each), then per collection; a response is fine when
    // its own checks passed, else by its status (as summarizeRequestStats decides)
    const rows = this.stmt(
      `SELECT k.cid, COUNT(*) AS sent, SUM(CASE WHEN COALESCE(json_extract(h.doc, '$.responseMeta.checksOk'), h.status_ok) THEN 0 ELSE 1 END) AS failing
       FROM (SELECT DISTINCT collection_id AS cid, request_id AS rid FROM history WHERE collection_id IS NOT NULL AND request_id IS NOT NULL) k
       JOIN history h ON h.rowid = (SELECT rowid FROM history WHERE request_id = k.rid AND collection_id = k.cid ORDER BY ts DESC LIMIT 1)
       GROUP BY k.cid`,
    ).all() as Array<{ cid: string; sent: number; failing: number }>;
    return Object.fromEntries(rows.map((r) => [r.cid, { sent: r.sent, failing: r.failing }]));
  }

  addTrace(t: TraceMeta): void {
    this.stmt('INSERT OR REPLACE INTO traces (id, name, kind, status, start, duration, spans, run_id, path) VALUES (?,?,?,?,?,?,?,?,?)').run(t.id, t.name, t.kind, t.status, t.startTime, t.durationMs, t.spanCount, t.runId ?? null, t.path);
    if (this.inserts.traces++ % PRUNE_EVERY === 0) this.prune('traces', 'start', 'path', MAX_TRACES);
  }

  listTraces(q: ListQuery = {}): Page<TraceMeta> {
    const w = this.where({ ...q, failed: undefined }, ['name', 'status']);
    // traces that ended in an error
    if (q.failed) {
      w.sql = (w.sql ? w.sql + ' AND ' : 'WHERE ') + "status <> 'ok'";
    }
    const rows = this.db.prepare(`SELECT * FROM traces ${w.sql} ORDER BY start DESC LIMIT ? OFFSET ?`).all(...w.args, q.limit ?? 100, q.offset ?? 0) as Array<Record<string, unknown>>;
    return { total: this.total('traces', w, q, rows.length), items: rows.map(traceRow) };
  }

  getTrace(id: string): TraceMeta | undefined {
    const r = this.db.prepare('SELECT * FROM traces WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? traceRow(r) : undefined;
  }

  close(): void {
    this.db.close();
  }
}

/** A stored status: numbers come back as numbers. */
function statusOf(s: unknown): number | string | undefined {
  return s === null || s === undefined ? undefined : isNaN(Number(s)) ? (s as string) : Number(s);
}

function historyRow(r: Record<string, unknown>): HistoryEntry {
  // a brief list has no doc: the ids come from their columns
  const doc = r.doc ? JSON.parse(r.doc as string) : { collectionId: r.collection_id ?? undefined, requestId: r.request_id ?? undefined };
  return {
    id: r.id as string,
    timestamp: r.ts as string,
    kind: r.kind as HistoryEntry['kind'],
    name: r.name as string,
    method: (r.method as string) ?? undefined,
    url: (r.url as string) ?? undefined,
    status: r.status === null ? undefined : isNaN(Number(r.status)) ? (r.status as string) : Number(r.status),
    durationMs: (r.duration as number) ?? undefined,
    size: (r.size as number) ?? undefined,
    traceId: (r.trace_id as string) ?? undefined,
    payloadPath: (r.payload as string) ?? undefined,
    request: doc.request,
    responseMeta: doc.responseMeta,
    collectionId: doc.collectionId,
    requestId: doc.requestId,
    ...(doc.requestPreview ? { requestPreview: true } : {}),
  };
}

function traceRow(r: Record<string, unknown>): TraceMeta {
  return {
    id: r.id as string,
    name: r.name as string,
    kind: r.kind as string,
    status: r.status as string,
    startTime: r.start as number,
    durationMs: r.duration as number,
    spanCount: r.spans as number,
    runId: (r.run_id as string) ?? undefined,
    path: r.path as string,
  };
}

/** Fallback when `node:sqlite` is unavailable: append-only JSON-lines files with periodic compaction. */
class JsonlMetaStore implements MetaStore {
  readonly backend = 'jsonl' as const;
  private data: { history: HistoryEntry[]; runs: RunMeta[]; traces: TraceMeta[] } = { history: [], runs: [], traces: [] };

  private root: string;

  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.root = dirname(path);
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const { t, v, op } = JSON.parse(line);
          const arr = this.data[t as keyof typeof this.data] as Array<{ id: string }>;
          const i = arr.findIndex((x) => x.id === (op === 'del' ? v : v.id));
          if (op === 'del') {
            if (i >= 0) arr.splice(i, 1);
          } else if (op === 'clear') arr.length = 0;
          else if (i >= 0) arr[i] = v;
          else arr.push(v);
        } catch {
          /* skip corrupt line */
        }
      }
    }
  }

  private log(t: string, v: unknown, op = 'put'): void {
    appendFileSync(this.path, JSON.stringify({ t, v, op }) + '\n');
  }

  private page<T>(arr: T[], q: ListQuery, match: (x: T, s: string) => boolean, sortKey: (x: T) => string | number): Page<T> {
    let items = q.query ? arr.filter((x) => match(x, q.query!.toLowerCase())) : arr;
    if (q.kind) items = items.filter((x) => (x as { kind?: string }).kind === q.kind);
    items = [...items].sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : -1));
    return { total: items.length, items: items.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 100)) };
  }

  addHistory(e: HistoryEntry) {
    const req = capHistoryRequest(e.request);
    if (req.cut) e = { ...e, request: req.value, requestPreview: true };
    this.data.history.push(e);
    this.log('history', e);
  }
  listHistory(q: ListQuery = {}) {
    const base = q.requestId ? this.data.history.filter((h) => h.requestId === q.requestId) : this.data.history;
    return this.page(q.failed ? base.filter((h) => !historyOk(h.status)) : base, q, (h, s) => `${h.name} ${h.url} ${h.method} ${h.status}`.toLowerCase().includes(s), (h) => h.timestamp);
  }
  getHistory(id: string) {
    return this.data.history.find((h) => h.id === id);
  }
  deleteHistory(id: string) {
    removeFiles(this.root, [this.data.history.find((h) => h.id === id)?.payloadPath]);
    this.data.history = this.data.history.filter((h) => h.id !== id);
    this.log('history', id, 'del');
  }
  clearHistory() {
    removeFiles(this.root, this.data.history.map((h) => h.payloadPath));
    this.data.history = [];
    this.log('history', null, 'clear');
  }
  addRun(s: RunSummary, dir: string) {
    const r: RunMeta = { id: s.runId, name: s.name, startedAt: s.startedAt, durationMs: s.durationMs, total: s.total, passed: s.passed, failed: s.failed, skipped: s.skipped, errors: s.errors, environment: s.environment, dir };
    this.data.runs.push(r);
    this.log('runs', r);
  }
  listRuns(q: ListQuery = {}) {
    return this.page(this.data.runs, q, (r, s) => r.name.toLowerCase().includes(s), (r) => r.startedAt);
  }
  deleteRun(id: string) {
    this.data.runs = this.data.runs.filter((r) => r.id !== id);
    this.log('runs', id, 'del');
  }
  activity(opts: { days?: number; tzOffsetMin?: number } = {}) {
    const since = activitySince(opts.days);
    return summarizeActivity(
      this.data.history.filter((h) => h.timestamp >= since),
      this.data.runs.filter((r) => r.startedAt >= since),
      opts,
    );
  }
  requestStats(collectionId: string) {
    return summarizeRequestStats(
      this.data.history
        .filter((h) => h.collectionId === collectionId)
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
        .slice(0, 5000)
        .map((h) => ({ ...h, checksOk: (h.responseMeta as { checksOk?: boolean } | undefined)?.checksOk })),
    );
  }
  historyByCollection() {
    const ids = new Set(this.data.history.map((h) => h.collectionId).filter((c): c is string => !!c));
    return Object.fromEntries(
      [...ids].map((c) => {
        const stats = this.requestStats(c);
        return [c, { sent: stats.length, failing: stats.filter((s) => !s.lastOk).length }];
      }),
    );
  }
  batch<T>(fn: () => T): T {
    return fn();
  }
  addTrace(t: TraceMeta) {
    this.data.traces.push(t);
    this.log('traces', t);
  }
  listTraces(q: ListQuery = {}) {
    return this.page(q.failed ? this.data.traces.filter((t) => t.status !== 'ok') : this.data.traces, q, (t, s) => `${t.name} ${t.status}`.toLowerCase().includes(s), (t) => t.startTime);
  }
  getTrace(id: string) {
    return this.data.traces.find((t) => t.id === id);
  }
  close() {
    // compact
    const lines = [
      ...this.data.history.map((v) => ({ t: 'history', v })),
      ...this.data.runs.map((v) => ({ t: 'runs', v })),
      ...this.data.traces.map((v) => ({ t: 'traces', v })),
    ];
    atomicWrite(this.path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
}

export function openMetaStore(dir: string): MetaStore {
  const sqlite = loadSqlite();
  if (sqlite) {
    try {
      return new SqliteMetaStore(`${dir}/database.sqlite`, sqlite.DatabaseSync);
    } catch {
      /* fall through */
    }
  }
  return new JsonlMetaStore(`${dir}/metadata.jsonl`);
}
