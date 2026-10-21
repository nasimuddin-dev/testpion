/**
 * The SQL checker against hostile input, per dialect (review 2, finding 5). The SQL comes from the system under test; the
 * checker and the server must read it the same way. MySQL and MariaDB read `--x`, `#`, `/*! *\/` and `/*M! *\/` differently from
 * the others, PostgreSQL ends a line comment at a carriage return, and quoted names can be called: every form whose meaning
 * depends on the server is refused (never stripped), and nothing that is only a harmless SELECT is lost.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { SQLITE_GUARDS, checkReadOnlySql, resolveSqlSource, runReadOnlySql, type SqlDialect } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

const refused = (sql: string, dialect: SqlDialect) => {
  try {
    checkReadOnlySql(sql, dialect);
  } catch (e) {
    return (e as Error).message;
  }
  return undefined;
};

const CORPUS: Record<SqlDialect, string[]> = {
  sqlite: [
    "SELECT load_extension('/tmp/evil')",
    'SELECT "load_extension"(\'/tmp/evil\')',
    '  SELECT 1load_extension(\'/tmp/evil\')',
    "ATTACH DATABASE '/etc/passwd' AS x",
    'SELECT 1; ATTACH DATABASE \'/tmp/x\' AS x',
    'PRAGMA writable_schema = 1',
    'SELECT 1; PRAGMA writable_schema = 1',
    'SELECT 1\n;\nPRAGMA writable_schema = ON',
    "SELECT readfile('/etc/passwd')",
    "SELECT writefile('/tmp/x', 'y')",
    'SELECT 1 /*! DROP TABLE customers */',
    'SELECT 1 /*+ x */',
    'SELECT 1 /* never closed',
    'SELECT 1 ; DROP TABLE customers',
    'SELECT 1 ; DROP TABLE customers',
    'SELECT 1 --\r; DROP TABLE customers',
    'SELECT zeroblob(1000000000)',
    'SELECT 1 \\g',
    'WITH x AS (SELECT 1) DELETE FROM customers',
    'VACUUM INTO \'/tmp/x\'',
  ],
  postgres: [
    "SELECT pg_read_file('/etc/passwd')",
    'SELECT "pg_read_file"(\'/etc/passwd\')',
    "SELECT pg_catalog.pg_read_binary_file('/etc/passwd')",
    "COPY (SELECT 1) TO PROGRAM 'id'",
    "SELECT 1; COPY customers TO '/tmp/y'",
    "SELECT set_config('log_statement', 'all', false)",
    "SELECT lo_import('/etc/passwd')",
    "SELECT lo_export(1, '/tmp/x')",
    "SELECT pg_ls_dir('/')",
    "SELECT * FROM dblink('host=evil', 'select 1') AS t(a int)",
    'SELECT pg_advisory_lock(1)',
    'SELECT pg_sleep(10)',
    'SELECT pg_sleep_for(\'1 hour\')',
    'SELECT 1 --\r; DROP TABLE customers',
    'SELECT 1 --\r\nSELECT 2 --\r; DELETE FROM customers',
    "SELECT E'\\'; DROP TABLE customers; --'",
    "SELECT '\\'; DROP TABLE customers; -- '",
    'SELECT $$ ; DROP TABLE customers; $$',
    'SELECT $q$ x $q$',
    'SELECT 1 INTO newtable',
    'SELECT * FROM customers FOR UPDATE',
    'SELECT 1; SELECT pg_read_file(\'x\')',
    'SELECT 1 \\copy customers to x',
    'SELECT 1 /*! x */',
    'SELECT 1 ; DROP TABLE customers',
  ],
  mysql: [
    "SELECT 1 --1 UNION SELECT load_file('/etc/passwd')",
    "SELECT 1--1 UNION SELECT load_file('/etc/passwd')",
    'SELECT 1 --x',
    'SELECT 1 # ; DROP TABLE customers',
    "SELECT 1 #' \n, load_file('/x') # '\n",
    'SELECT 1 #\n UNION SELECT 2',
    "SELECT /*!50000 load_file('/etc/passwd') */",
    "SELECT /*!50000 UNION SELECT 1 */ 1",
    'SELECT /*M!100000 sleep(10) */ 1',
    'SELECT 1 /*!12345 DROP TABLE customers */',
    'SELECT /*+ MAX_EXECUTION_TIME(1) */ 1',
    "SELECT 1 INTO OUTFILE '/tmp/x'",
    "SELECT 1 INTO DUMPFILE '/tmp/x'",
    'SELECT * FROM customers INTO @v',
    'SELECT 1; DROP TABLE customers',
    "SELECT 1 -- x\n; DROP TABLE customers",
    "SELECT 'a\\'; DROP TABLE customers; -- '",
    'SELECT "a\\"; DROP TABLE customers; -- "',
    "SELECT `load_file`('/etc/passwd')",
    "SELECT LOAD_FILE('/etc/passwd')",
    'SELECT sleep(5)',
    'SELECT benchmark(1000000000, md5(1))',
    "SELECT get_lock('a', 10)",
    'SELECT 1 \\G',
    'SELECT 1 LOCK IN SHARE MODE',
    'SELECT 1 ; DROP TABLE customers',
    "SELECT 1\u0001; DROP TABLE customers",
  ],
};

const FINE: Record<SqlDialect, string[]> = {
  sqlite: ['SELECT 1 -- a comment', 'SELECT 1 --not a problem', 'SELECT a - -b FROM customers', "SELECT 'it''s' || 'x'", 'SELECT [name] FROM customers', 'SELECT 1 /* a comment */ + 2'],
  postgres: ['SELECT 1 -- a comment', "SELECT data #> '{a}' FROM customers", "SELECT 'a\\b'", 'SELECT "pg_read_file" FROM customers', 'SELECT 1 /* a /* nested */ comment */ + 1'],
  mysql: ['SELECT 1 -- a comment', 'SELECT 1 -- \n+ 2', 'SELECT a - -b FROM customers', 'SELECT a - - b FROM customers', 'SELECT "text", `col` FROM customers', 'SELECT 1 /* a comment */ + 2'],
};

describe('the hostile-input corpus, per dialect', () => {
  for (const dialect of ['sqlite', 'postgres', 'mysql'] as const) {
    it(`${dialect}: every hostile text is refused`, () => {
      for (const sql of CORPUS[dialect]) expect(refused(sql, dialect), JSON.stringify(sql)).toMatch(/cannot be run/);
    });
    it(`${dialect}: a harmless SELECT is still allowed`, () => {
      for (const sql of FINE[dialect]) expect(refused(sql, dialect), JSON.stringify(sql)).toBeUndefined();
    });
  }

  it('the same text is judged by the rules of the dialect it runs on', () => {
    // `--1` is a comment to SQLite and PostgreSQL, two minus signs to MySQL
    expect(refused('SELECT 1 --1', 'sqlite')).toBeUndefined();
    expect(refused('SELECT 1 --1', 'postgres')).toBeUndefined();
    expect(refused('SELECT 1 --1', 'mysql')).toMatch(/"--" that is not followed by a space/);
    // `#` is an operator in PostgreSQL, a comment in MySQL
    expect(refused('SELECT 1 # 2', 'postgres')).toBeUndefined();
    expect(refused('SELECT 1 # 2', 'mysql')).toMatch(/"#" comment/);
  });

  it('a quoted function name is checked as the function', () => {
    expect(refused('SELECT "sleep"(1)', 'postgres')).toMatch(/sleep\(\)/);
    expect(refused('SELECT "customers" FROM customers', 'postgres')).toBeUndefined();
  });
});

describe('SQLite native memory (review 2, finding 8)', () => {
  const t = tempDir('tp-sql-mem-');
  let db: string;
  beforeAll(() => {
    db = join(t.dir, 'm.db');
    const gbm = (process as unknown as { getBuiltinModule: (id: string) => { DatabaseSync: new (p: string) => { exec(s: string): void; close(): void } } }).getBuiltinModule;
    const emit = process.emitWarning;
    process.emitWarning = (() => undefined) as typeof process.emitWarning;
    const { DatabaseSync } = gbm('node:sqlite');
    process.emitWarning = emit;
    const d = new DatabaseSync(db);
    d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT); INSERT INTO t VALUES (1, \'a\'), (2, \'b\');');
    d.close();
  });
  afterAll(() => t.cleanup());
  const src = () => resolveSqlSource({ path: db });
  const rssMb = () => process.memoryUsage.rss() / 1_048_576;

  it('the doubling query (x||x) is stopped in seconds without taking the memory', async () => {
    const before = rssMb();
    const t0 = Date.now();
    await expect(runReadOnlySql(src(), "WITH RECURSIVE t(x) AS (SELECT 'a' UNION ALL SELECT x||x FROM t) SELECT length(x) FROM t", { timeoutMs: 4000 })).rejects.toThrow(/too big|memory|stopped|ran for more|more than/);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(rssMb() - before).toBeLessThan(SQLITE_GUARDS.memoryGrowthMb);
  }, 30_000);

  it('printf, group_concat and replace cannot build a huge value', async () => {
    for (const sql of [
      "SELECT length(printf('%1000000000c', 'x'))",
      "SELECT length(printf('%*d', 1000000000, 1))",
      "SELECT length(group_concat(x)) FROM (WITH RECURSIVE c(i, x) AS (SELECT 1, printf('%1000000c', 'x') UNION ALL SELECT i + 1, x FROM c WHERE i < 100) SELECT x FROM c)",
      "SELECT length(replace(printf('%10000000c', 'x'), 'x', printf('%10000000c', 'y')))",
    ])
      await expect(runReadOnlySql(src(), sql, { timeoutMs: 8000 }), sql).rejects.toThrow(/too big|memory|stopped|ran for more/);
  }, 60_000);

  it('the engine limits are set: too many compound terms and too many function arguments are refused by SQLite', async () => {
    const compound = Array.from({ length: SQLITE_GUARDS.limits.compoundSelect + 20 }, () => 'SELECT 1').join(' UNION ALL ');
    await expect(runReadOnlySql(src(), compound)).rejects.toThrow(/too many terms|failed/);
    const wide = `SELECT max(${Array.from({ length: SQLITE_GUARDS.limits.functionArg + 5 }, () => '1').join(', ')})`;
    await expect(runReadOnlySql(src(), wide)).rejects.toThrow(/too many arguments|failed/);
    // and an ordinary query still runs
    expect((await runReadOnlySql(src(), 'SELECT count(*) FROM t')).rows).toEqual([[2]]);
  });

  it('a worker that makes the process grow past its memory limit is killed', async () => {
    const t0 = Date.now();
    // 1 MB of growth is allowed: the sort below needs far more and runs longer than the watch interval
    await expect(
      runReadOnlySql(src(), "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 4000000) SELECT x, printf('%050d', x) AS s FROM n ORDER BY s DESC", { timeoutMs: 20_000, maxRows: 5_000_000, memoryMb: 1 }),
    ).rejects.toThrow(/used more than 1 MB of memory/);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 30_000);
});
