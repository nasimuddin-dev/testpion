import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { renameSync } from 'node:fs';
import { resolveSqlSource, runReadOnlySql } from '../../packages/core/src/index.js';
import { sqlWorkerStats } from '../../packages/core/src/runner/sql-exec.js';
import { tempDir } from '../helpers';

const SLACK = Number(process.env.TESTPION_PERF_SLACK ?? 1);
const t = tempDir('tp-sql-pool-');
const make = (file: string, rows: number) => {
  const gbm = (process as unknown as { getBuiltinModule: (id: string) => { DatabaseSync: new (p: string) => { exec(s: string): void; close(): void } } }).getBuiltinModule;
  const emit = process.emitWarning;
  process.emitWarning = (() => undefined) as typeof process.emitWarning;
  const { DatabaseSync } = gbm('node:sqlite');
  process.emitWarning = emit;
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows}) INSERT INTO t SELECT i, 'row ' || i FROM n;`);
  d.close();
};
let db: string;
beforeAll(() => {
  db = join(t.dir, 'pool.db');
  make(db, 10);
});
afterAll(() => t.cleanup());

// D-3: every query started its own worker thread, opened the database and ended the worker
describe('SQL queries share workers', () => {
  it('100 queries on one file start a couple of workers and finish quickly', async () => {
    const src = resolveSqlSource({ path: db });
    const before = sqlWorkerStats.started;
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      const r = await runReadOnlySql(src, `SELECT COUNT(*) AS n FROM t WHERE id > ${i % 5}`);
      expect(r.rows[0]![0]).toBe(10 - (i % 5));
    }
    const ms = performance.now() - t0;
    console.log(`100 SQL queries: ${ms.toFixed(0)} ms, ${sqlWorkerStats.started - before} workers started`);
    expect(sqlWorkerStats.started - before).toBeLessThanOrEqual(2);
    expect(ms).toBeLessThan(5000 * SLACK); // (a worker per query: 17 s for the same 100 queries on a busy box)
  });

  it('a replaced database file is read afresh, not through the old handle', async () => {
    const file = join(t.dir, 'swap.db');
    make(file, 3);
    const src = resolveSqlSource({ path: file });
    expect((await runReadOnlySql(src, 'SELECT COUNT(*) FROM t')).rows[0]![0]).toBe(3);
    const next = join(t.dir, 'swap-next.db');
    make(next, 7);
    renameSync(next, file);
    expect((await runReadOnlySql(src, 'SELECT COUNT(*) FROM t')).rows[0]![0]).toBe(7);
  });

  it('a failing query leaves the pool working', async () => {
    const src = resolveSqlSource({ path: db });
    await expect(runReadOnlySql(src, 'SELECT * FROM nope')).rejects.toThrow(/SQL query failed/);
    expect((await runReadOnlySql(src, 'SELECT COUNT(*) FROM t')).rows[0]![0]).toBe(10);
  });
});
