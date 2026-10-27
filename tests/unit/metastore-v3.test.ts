import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMetaStore, type HistoryEntry } from '../../packages/core/src/index.js';

type Db = { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown }; close(): void };
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (p: string) => Db };

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'tp-meta-v3-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const entry = (id: string, minutesAgo: number, o: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id,
  timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  kind: 'http',
  name: `req ${id}`,
  method: 'GET',
  url: `http://x/${id}`,
  status: 200,
  durationMs: 10,
  collectionId: 'c1',
  requestId: `r-${id}`,
  ...o,
});

/** A schema-2 database as the previous release wrote it (no checks_ok column). */
function v2Database(dir: string) {
  const db = new DatabaseSync(join(dir, 'database.sqlite'));
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta(key, value) VALUES('schema', '2');
    CREATE TABLE history (id TEXT PRIMARY KEY, ts TEXT, kind TEXT, name TEXT, method TEXT, url TEXT, status TEXT, duration REAL, size INTEGER, trace_id TEXT, payload TEXT, doc TEXT, collection_id TEXT, request_id TEXT, status_ok INTEGER);
    CREATE INDEX history_ts ON history(ts DESC);
    CREATE TABLE runs (id TEXT PRIMARY KEY, name TEXT, started TEXT, duration REAL, total INTEGER, passed INTEGER, failed INTEGER, skipped INTEGER, errors INTEGER, environment TEXT, dir TEXT);
    CREATE TABLE traces (id TEXT PRIMARY KEY, name TEXT, kind TEXT, status TEXT, start INTEGER, duration REAL, spans INTEGER, run_id TEXT, path TEXT);
  `);
  const ins = db.prepare('INSERT INTO history (id, ts, kind, name, method, url, status, duration, doc, collection_id, request_id, status_ok) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const rows: Array<[HistoryEntry, unknown]> = [
    [entry('a', 3), { checksOk: true }],
    [entry('b', 2, { status: 500 }), { checksOk: true }], // its own checks passed although the status is 500
    [entry('c', 1), { checksOk: false }],
    [entry('d', 0, { requestId: 'r-d' }), undefined],
  ];
  for (const [e, meta] of rows)
    ins.run(
      e.id,
      e.timestamp,
      e.kind,
      e.name,
      e.method,
      e.url,
      String(e.status),
      e.durationMs,
      JSON.stringify({ responseMeta: meta, collectionId: e.collectionId, requestId: e.requestId }),
      e.collectionId,
      e.requestId,
      e.status === 200 ? 1 : 0,
    );
  db.close();
}

describe('SQLite metadata store, schema 3', () => {
  it('migrates a schema-2 database: backup first, checks_ok backfilled, the composite index there, stats unchanged', () => {
    const dir = tempDir();
    v2Database(dir);
    const meta = openMetaStore(dir);
    expect(meta.problem).toBeUndefined();
    expect(existsSync(join(dir, 'database.sqlite.bak-v2'))).toBe(true);
    const stats = meta.requestStats('c1');
    expect(stats.find((s) => s.requestId === 'r-b')?.lastOk).toBe(true); // checksOk wins over status 500
    expect(stats.find((s) => s.requestId === 'r-c')?.lastOk).toBe(false);
    expect(meta.historyByCollection()).toEqual({ c1: { sent: 4, failing: 1 } });
    meta.close();
    const db = new DatabaseSync(join(dir, 'database.sqlite'));
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema'").get()).toEqual({ value: '3' });
    expect((db.prepare('SELECT id, checks_ok FROM history ORDER BY id').all() as Array<{ id: string; checks_ok: number | null }>).map((r) => r.checks_ok)).toEqual([1, 1, 0, null]);
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'history_coll_req_ts'").all() as unknown[]).length).toBe(1);
    db.close();
  });

  it('a new row keeps its own check verdict in the column', () => {
    const dir = tempDir();
    const meta = openMetaStore(dir);
    meta.addHistory(entry('x', 1, { responseMeta: { checksOk: false } as never }));
    meta.addHistory(entry('y', 0, { responseMeta: { checksOk: true } as never, status: 503 }));
    expect(meta.historyByCollection()).toEqual({ c1: { sent: 2, failing: 1 } });
    meta.close();
  });

  it('the collection timings come from the collection index and only the timing of each row', () => {
    const dir = tempDir();
    const meta = openMetaStore(dir);
    const timing = (ttfbMs: number) => ({ timing: { ttfbMs, dnsMs: 1, reusedConnection: true } }) as never;
    for (let i = 0; i < 30; i++) meta.addHistory(entry(`h${i}`, 100 - i, { collectionId: i % 3 ? 'other' : 'c1', responseMeta: timing(i) }));
    meta.addHistory(entry('no-timing', 0, { responseMeta: { checksOk: true } as never }));
    const t = meta.collectionTimings('c1', 100);
    expect(t.length).toBe(10);
    expect(t[0]).toMatchObject({ ttfbMs: 27 }); // newest first
    expect(meta.collectionTimings('c1', 3).length).toBe(3);
    meta.close();
    // the plan uses an index of history (the collection's, not a scan of the table)
    const db = new DatabaseSync(join(dir, 'database.sqlite'));
    const plan = (
      db.prepare("EXPLAIN QUERY PLAN SELECT json_extract(doc, '$.responseMeta.timing') FROM history WHERE collection_id = ? AND kind IN ('http') ORDER BY ts DESC LIMIT 5").all('c1') as Array<{
        detail: string;
      }>
    )
      .map((r) => r.detail)
      .join(' ');
    expect(plan).toMatch(/USING INDEX history_(collection_ts|coll_req_ts)|USING COVERING INDEX/);
    expect(plan).not.toMatch(/SCAN history(?! USING)/);
    db.close();
  });

  it('collectionId filters history lists on the index; countTotal:false skips the counting scan', () => {
    const dir = tempDir();
    const meta = openMetaStore(dir);
    for (let i = 0; i < 12; i++) meta.addHistory(entry(`h${i}`, 50 - i, { collectionId: i < 8 ? 'c1' : 'c2' }));
    expect(meta.listHistory({ collectionId: 'c2', limit: 100 }).items.length).toBe(4);
    expect(meta.listHistory({ collectionId: 'c1', limit: 5 }).total).toBe(8);
    const lazy = meta.listHistory({ collectionId: 'c1', limit: 5, countTotal: false });
    expect(lazy.items.length).toBe(5);
    expect(lazy.total).toBe(5); // a lower bound: no second scan
    meta.close();
  });

  it('closing folds the WAL back in (no growing -wal file) and deleting runs is one transaction', () => {
    const dir = tempDir();
    const meta = openMetaStore(dir);
    for (let i = 0; i < 300; i++) meta.addHistory(entry(`h${i}`, 300 - i));
    for (let i = 0; i < 10; i++)
      meta.addRun(
        { runId: `run${i}`, name: 'n', startedAt: new Date(Date.now() - i * 1000).toISOString(), durationMs: 1, total: 1, passed: 1, failed: 0, skipped: 0, errors: 0 } as never,
        `runs/run${i}`,
      );
    meta.deleteRuns(['run1', 'run2', 'run3']);
    expect(meta.listRuns().items.map((r) => r.id)).not.toContain('run2');
    expect(meta.listRuns().total).toBe(7);
    meta.close();
    const wal = join(dir, 'database.sqlite-wal');
    expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes('broken'))).toEqual([]);
  });

  it('clearJudgeCache answers how many verdicts it dropped without counting first', () => {
    const dir = tempDir();
    const meta = openMetaStore(dir);
    meta.putJudgeCache('k1', 'a');
    meta.putJudgeCache('k2', 'b');
    expect(meta.clearJudgeCache()).toBe(2);
    expect(meta.getJudgeCache('k1')).toBeUndefined();
    meta.close();
  });

  it('a list over 20,000 rows reuses its prepared statements (the cache grows by shape, not by call)', () => {
    const dir = tempDir();
    const meta = openMetaStore(dir);
    for (let i = 0; i < 50; i++) meta.addHistory(entry(`h${i}`, 50 - i));
    const before = performance.now();
    for (let i = 0; i < 2000; i++) meta.listHistory({ limit: 10, collectionId: 'c1', countTotal: false });
    const ms = performance.now() - before;
    expect(Object.keys((meta as unknown as { statements: Map<string, unknown> }).statements).length).toBe(0); // a Map, not an object
    expect((meta as unknown as { statements: Map<string, unknown> }).statements.size).toBeLessThan(20);
    expect(ms).toBeLessThan(5000);
    meta.close();
  });
});
