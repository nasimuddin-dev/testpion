import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HISTORY_VALUE_MAX, openMetaStore, summarizeActivity, summarizeRequestStats, type HistoryEntry } from '../../packages/core/src/index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (p: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] }; close(): void };
};

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'tp-meta-v2-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const entry = (id: string, minutesAgo: number, o: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id,
  timestamp: at(minutesAgo),
  kind: 'http',
  name: `req ${id}`,
  method: 'GET',
  url: `http://x/${id}`,
  status: 200,
  durationMs: 10,
  ...o,
});

/** A schema-1 database, as the previous release wrote it. */
function v1Database(dir: string, rows: HistoryEntry[]) {
  const db = new DatabaseSync(join(dir, 'database.sqlite'));
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta(key, value) VALUES('schema', '1');
    CREATE TABLE history (id TEXT PRIMARY KEY, ts TEXT, kind TEXT, name TEXT, method TEXT, url TEXT, status TEXT, duration REAL, size INTEGER, trace_id TEXT, payload TEXT, doc TEXT);
    CREATE INDEX history_ts ON history(ts DESC);
    CREATE INDEX history_kind ON history(kind);
    CREATE TABLE runs (id TEXT PRIMARY KEY, name TEXT, started TEXT, duration REAL, total INTEGER, passed INTEGER, failed INTEGER, skipped INTEGER, errors INTEGER, environment TEXT, dir TEXT);
    CREATE TABLE traces (id TEXT PRIMARY KEY, name TEXT, kind TEXT, status TEXT, start INTEGER, duration REAL, spans INTEGER, run_id TEXT, path TEXT);
  `);
  const ins = db.prepare('INSERT INTO history VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const e of rows)
    ins.run(
      e.id,
      e.timestamp,
      e.kind,
      e.name,
      e.method ?? null,
      e.url ?? null,
      e.status === undefined ? null : String(e.status),
      e.durationMs ?? null,
      null,
      null,
      null,
      JSON.stringify({ request: e.request, responseMeta: e.responseMeta, collectionId: e.collectionId, requestId: e.requestId }),
    );
  db.close();
}

const sample: HistoryEntry[] = [
  entry('a1', 50, { collectionId: 'c1', requestId: 'r1', status: 500 }),
  entry('a2', 40, { collectionId: 'c1', requestId: 'r1', status: 200 }),
  entry('a3', 30, { collectionId: 'c1', requestId: 'r2', status: 404 }),
  entry('a4', 20, { collectionId: 'c2', requestId: 'r3', status: 404, responseMeta: { checksOk: true } }),
  entry('a5', 10, { kind: 'graphql', status: 'NetworkError' }),
  entry('a6', 5, { kind: 'grpc', status: 'OK', durationMs: 30 }),
];

describe('SQLite metadata store, schema 2', () => {
  it('migrates a schema-1 database: columns backfilled, lists and stats unchanged', () => {
    const dir = tempDir();
    v1Database(dir, sample);
    const m = openMetaStore(dir);
    expect(m.backend).toBe('sqlite');
    m.close();
    const db = new DatabaseSync(join(dir, 'database.sqlite'));
    const rows = db.prepare('SELECT id, collection_id, request_id, status_ok FROM history ORDER BY id').all();
    const schema = db.prepare("SELECT value FROM meta WHERE key = 'schema'").all();
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'history'").all() as Array<{ name: string }>).map((r) => r.name);
    db.close();
    expect(schema).toEqual([{ value: '2' }]);
    expect(rows).toEqual([
      { id: 'a1', collection_id: 'c1', request_id: 'r1', status_ok: 0 },
      { id: 'a2', collection_id: 'c1', request_id: 'r1', status_ok: 1 },
      { id: 'a3', collection_id: 'c1', request_id: 'r2', status_ok: 0 },
      { id: 'a4', collection_id: 'c2', request_id: 'r3', status_ok: 0 },
      { id: 'a5', collection_id: null, request_id: null, status_ok: 0 },
      { id: 'a6', collection_id: null, request_id: null, status_ok: 1 },
    ]);
    expect(indexes).toEqual(expect.arrayContaining(['history_kind_ts', 'history_collection_ts', 'history_request_ts']));

    const again = openMetaStore(dir); // opening a migrated database again is a no-op
    expect(again.listHistory({ failed: true }).items.map((h) => h.id)).toEqual(['a5', 'a4', 'a3', 'a1']);
    expect(again.listHistory({ requestId: 'r1' }).items.map((h) => h.id)).toEqual(['a2', 'a1']);
    expect(again.listHistory({ kind: 'graphql' }).items.map((h) => h.id)).toEqual(['a5']);
    expect(again.requestStats('c1')).toEqual(summarizeRequestStats(sample.filter((h) => h.collectionId === 'c1').reverse()));
    again.close();
  });

  it('new rows fill the columns; filters, stats and per-collection health use them', () => {
    const m = openMetaStore(tempDir());
    for (const e of sample) m.addHistory(e);
    expect(m.listHistory({ failed: true }).total).toBe(4);
    expect(m.listHistory({ requestId: 'r1', kind: 'http' }).items.map((h) => h.id)).toEqual(['a2', 'a1']);
    expect(m.listHistory({ kind: 'grpc' }).items.map((h) => h.id)).toEqual(['a6']);
    const stats = m.requestStats('c1');
    expect(stats.find((s) => s.requestId === 'r1')).toMatchObject({ count: 2, failed: 1, lastStatus: 200, lastOk: true, recent: ['failed', 'passed'] });
    expect(stats.find((s) => s.requestId === 'r2')).toMatchObject({ count: 1, lastOk: false });
    // c1: r1 fine now, r2 failing; c2: r3 is a 404 whose own checks passed
    expect(m.historyByCollection()).toEqual({ c1: { sent: 2, failing: 1 }, c2: { sent: 1, failing: 0 } });
    m.close();
  });

  it('historyByCollection agrees with requestStats', () => {
    const m = openMetaStore(tempDir());
    let n = 0;
    for (let c = 0; c < 3; c++)
      for (let r = 0; r < 4; r++) for (let k = 0; k < 3; k++) m.addHistory(entry(`h${n}`, 1000 - n++, { collectionId: `c${c}`, requestId: `c${c}-r${r}`, status: (c + r + k) % 3 ? 200 : 500 }));
    const health = m.historyByCollection();
    for (const c of ['c0', 'c1', 'c2']) {
      const stats = m.requestStats(c);
      expect(health[c]).toEqual({ sent: stats.length, failing: stats.filter((s) => !s.lastOk).length });
    }
    m.close();
  });

  it('pages: total is exact on every page', () => {
    const m = openMetaStore(tempDir());
    for (let i = 0; i < 25; i++) m.addHistory(entry(`p${i}`, 100 - i, { status: i % 5 ? 200 : 503 }));
    expect(m.listHistory({ limit: 10 }).total).toBe(25);
    expect(m.listHistory({ limit: 10, offset: 10 }).total).toBe(25);
    expect(m.listHistory({ limit: 10, offset: 20 })).toMatchObject({ total: 25 });
    expect(m.listHistory({ limit: 10, offset: 20 }).items).toHaveLength(5);
    expect(m.listHistory({ limit: 10, offset: 40 })).toEqual({ total: 25, items: [] });
    expect(m.listHistory({ failed: true, limit: 2 }).total).toBe(5);
    expect(m.listHistory({ query: 'p1', limit: 100 }).total).toBe(11); // p1, p10-p19
    m.close();
  });

  it('brief lists leave out the request details; getHistory has them', () => {
    const m = openMetaStore(tempDir());
    m.addHistory(entry('b1', 1, { request: { method: 'GET', url: 'http://x' }, responseMeta: { checksOk: true }, collectionId: 'c', requestId: 'r' }));
    const [brief] = m.listHistory({ brief: true }).items;
    expect(brief).toMatchObject({ id: 'b1', collectionId: 'c', requestId: 'r', status: 200 });
    expect(brief!.request).toBeUndefined();
    expect(m.listHistory({}).items[0]!.request).toEqual({ method: 'GET', url: 'http://x' });
    expect(m.getHistory('b1')).toMatchObject({ request: { method: 'GET', url: 'http://x' }, responseMeta: { checksOk: true } });
    m.close();
  });

  it('cuts request values over 64 KB and marks the entry as a preview', () => {
    for (const dir of [tempDir()]) {
      const m = openMetaStore(dir);
      const big = 'x'.repeat(HISTORY_VALUE_MAX + 10);
      m.addHistory(entry('big', 1, { request: { method: 'POST', url: 'http://x', body: { type: 'json', content: big } } }));
      m.addHistory(entry('small', 2, { request: { method: 'POST', url: 'http://x', body: { type: 'json', content: 'ok' } } }));
      const h = m.getHistory('big')!;
      expect((h.request as { body: { content: string } }).body.content).toHaveLength(HISTORY_VALUE_MAX);
      expect(h.requestPreview).toBe(true);
      expect(m.getHistory('small')!.requestPreview).toBeUndefined();
      m.close();
    }
  });

  it('activity in SQL matches summarizeActivity over the same rows', () => {
    const m = openMetaStore(tempDir());
    const rows: HistoryEntry[] = [];
    for (let i = 0; i < 300; i++) rows.push(entry(`x${i}`, i * 97, { kind: i % 4 ? 'http' : 'graphql', name: `n${i % 7}`, status: i % 6 ? 200 : 500, durationMs: i % 9 ? (i * 13) % 250 : undefined }));
    for (const r of rows) m.addHistory(r);
    m.addRun({ runId: 'run1', name: 'R', startedAt: at(60), finishedAt: at(59), durationMs: 5, total: 3, passed: 2, failed: 1, skipped: 0, errors: 0 } as never, 'runs/run1');
    for (const tz of [0, 420, -330]) {
      const got = m.activity({ days: 14, tzOffsetMin: tz });
      const want = summarizeActivity(rows, [{ startedAt: at(60), total: 3, passed: 2, failed: 1, errors: 0 }], { days: 14, tzOffsetMin: tz });
      expect(got.days).toEqual(want.days);
      expect(got.byKind).toEqual(want.byKind);
      expect(got.medianMs).toBe(want.medianMs);
      expect(got.slowest).toEqual(want.slowest);
    }
    m.close();
  });

  it('prunes history beyond the cap only when over it (oldest first)', () => {
    const m = openMetaStore(tempDir());
    m.batch(() => {
      for (let i = 0; i < 20_150; i++) m.addHistory(entry(`q${i}`, 30_000 - i));
    });
    // pruning runs every 200 inserts: the check at the 20,200th insert brings it back to the cap (the oldest go)
    for (let i = 0; i < 200; i++) m.addHistory(entry(`z${i}`, 0));
    expect(m.listHistory({ limit: 1 }).total).toBe(20_149);
    expect(m.getHistory('q200')).toBeUndefined();
    expect(m.getHistory('q201')).toBeDefined();
    expect(m.getHistory('z199')).toBeDefined();
    m.close();
  });

  it('batch commits once and rolls back on error', () => {
    const m = openMetaStore(tempDir());
    m.batch(() => {
      m.addHistory(entry('k1', 1));
      m.batch(() => m.addHistory(entry('k2', 2))); // nested joins the outer one
    });
    expect(() =>
      m.batch(() => {
        m.addHistory(entry('k3', 3));
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(m.listHistory({}).items.map((h) => h.id)).toEqual(['k1', 'k2']);
    m.close();
  });
});
