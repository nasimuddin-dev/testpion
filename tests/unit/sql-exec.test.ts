/**
 * The read-only SQL executor, with hostile input (planning/rag-testing.md §4k). The SQL comes from the system under test, so
 * every layer is tested on its own: the statement check refuses writes, a second statement, ATTACH, PRAGMA, extension loading,
 * locking and the functions that sleep or read files, however they are hidden (comments, strings, case, other dialects'
 * escapes); the executor wraps and caps the rows, stops a long query, opens SQLite read-only, and refuses a PostgreSQL or MySQL
 * source that is not declared read-only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SQL_DEFAULTS, checkReadOnlySql, readOnlyPreamble, resolveSqlSource, runReadOnlySql, setDbDriver, wrapLimit, type DbDriver } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

const t = tempDir('tp-sql-exec-');
let db: string;
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

beforeAll(() => {
  db = join(t.dir, 'shop.db');
  const gbm = (process as unknown as { getBuiltinModule: (id: string) => { DatabaseSync: new (p: string) => { exec(s: string): void; close(): void } } }).getBuiltinModule;
  const emit = process.emitWarning;
  process.emitWarning = (() => undefined) as typeof process.emitWarning;
  const { DatabaseSync } = gbm('node:sqlite');
  process.emitWarning = emit;
  const d = new DatabaseSync(db);
  d.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, active INTEGER, balance REAL, update_date TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total REAL);
    INSERT INTO customers VALUES (1, 'Ada', 1, 10.5, '2026-01-01'), (2, 'Grace', 0, NULL, '2026-02-01'), (3, 'Linus', 1, 3.25, NULL);
    INSERT INTO orders VALUES (1, 1, 20.0), (2, 1, 5.5), (3, 3, 7.0);`);
  d.close();
});
afterAll(() => t.cleanup());

const src = () => resolveSqlSource({ path: db });
const refused = (sql: string, dialect: 'sqlite' | 'postgres' | 'mysql' = 'sqlite') => {
  try {
    checkReadOnlySql(sql, dialect);
  } catch (e) {
    return (e as Error).message;
  }
  return undefined;
};

describe('the statement check: what is refused', () => {
  it('writes, DDL and everything that is not a SELECT, WITH or VALUES', () => {
    for (const sql of ['DELETE FROM customers', 'INSERT INTO customers VALUES (9)', 'UPDATE customers SET name = 1', 'DROP TABLE customers', 'CREATE TABLE x (a)', 'ALTER TABLE customers ADD b', 'REPLACE INTO customers VALUES (1)', 'TRUNCATE customers', 'VACUUM', 'REINDEX', 'EXPLAIN SELECT 1', 'SHOW TABLES', 'CALL x()', 'GRANT ALL ON x TO y', 'BEGIN', 'COMMIT', 'SET x = 1', 'COPY x TO STDOUT']) expect(refused(sql), sql).toMatch(/cannot be run/);
  });

  it('case and spacing do not hide a keyword', () => {
    expect(refused('dElEtE\n  FROM customers')).toMatch(/starts with DELETE/);
    expect(refused('  \t DROP   TABLE x')).toMatch(/starts with DROP/);
    expect(refused('SEL/**/ECT 1')).toMatch(/starts with SEL/);
  });

  it('a second statement, however it is separated', () => {
    for (const sql of ['SELECT 1; DELETE FROM customers', 'SELECT 1; SELECT 2', 'SELECT 1;;', 'SELECT 1;​ DROP TABLE customers', 'SELECT 1 ; /* x */ DROP TABLE customers', 'SELECT 1;\nPRAGMA writable_schema = 1']) expect(refused(sql), sql).toMatch(/second statement/);
    // one trailing semicolon is fine
    expect(checkReadOnlySql('SELECT 1;  ', 'sqlite')).toBe('SELECT 1');
  });

  it('ATTACH, PRAGMA, VACUUM INTO and extension loading', () => {
    expect(refused("ATTACH DATABASE '/tmp/x.db' AS x")).toMatch(/starts with ATTACH/);
    expect(refused('PRAGMA writable_schema = 1')).toMatch(/starts with PRAGMA/);
    expect(refused('PRAGMA query_only = OFF')).toMatch(/starts with PRAGMA/);
    expect(refused("VACUUM INTO '/tmp/x.db'")).toMatch(/starts with VACUUM/);
    expect(refused("SELECT load_extension('/tmp/evil')")).toMatch(/load_extension\(\)/);
    expect(refused("SELECT readfile('/etc/passwd')")).toMatch(/readfile\(\)/);
    expect(refused("SELECT writefile('/tmp/x', 'y')")).toMatch(/writefile\(\)/);
    expect(refused("SELECT edit('x')")).toMatch(/edit\(\)/);
  });

  it('a write hidden inside a SELECT or a WITH', () => {
    expect(refused('WITH x AS (SELECT 1) DELETE FROM customers')).toMatch(/DELETE is not allowed/);
    expect(refused('WITH x AS (DELETE FROM customers RETURNING *) SELECT * FROM x', 'postgres')).toMatch(/DELETE is not allowed/);
    expect(refused('WITH x AS (INSERT INTO customers VALUES (1) RETURNING id) SELECT * FROM x', 'postgres')).toMatch(/INSERT is not allowed/);
    expect(refused('SELECT * INTO newtable FROM customers', 'postgres')).toMatch(/INTO is not allowed/);
    expect(refused("SELECT * FROM customers INTO OUTFILE '/tmp/x'", 'mysql')).toMatch(/INTO is not allowed/);
    expect(refused("SELECT * FROM customers INTO DUMPFILE '/tmp/x'", 'mysql')).toMatch(/INTO is not allowed/);
    expect(refused('SELECT * FROM customers FOR UPDATE', 'postgres')).toMatch(/locks rows/);
    expect(refused('SELECT * FROM customers FOR SHARE', 'postgres')).toMatch(/locks rows/);
    expect(refused('SELECT * FROM customers LOCK IN SHARE MODE', 'mysql')).toMatch(/LOCK is not allowed/);
    expect(refused('SELECT 1 UNION ALL SELECT 2 RETURNING 3', 'postgres')).toMatch(/RETURNING/);
  });

  it('the functions that sleep, read files, call out or build huge values', () => {
    for (const sql of ['SELECT pg_sleep(30)', 'SELECT SLEEP(30)', 'SELECT BENCHMARK(1000000000, MD5(1))', "SELECT LOAD_FILE('/etc/passwd')", "SELECT * FROM dblink('host=x', 'select 1') AS t(a int)", "SELECT lo_import('/etc/passwd')", "SELECT pg_read_file('/etc/passwd')", "SELECT pg_ls_dir('/')", "SELECT set_config('x', 'y', false)", "SELECT GET_LOCK('a', 100)", "SELECT zeroblob(2000000000)", "SELECT randomblob(2000000000)", "SELECT repeat('a', 2000000000)", "SELECT rpad('a', 2000000000, 'b')", "SELECT current_setting('x')", "SELECT nextval('s')"])
      expect(refused(sql, /pg_|lo_|dblink|set_config|current_setting|nextval|repeat|rpad/.test(sql) ? 'postgres' : 'mysql') ?? refused(sql, 'sqlite'), sql).toMatch(/the function .* can read files, sleep, load code or build huge values/);
  });

  it('comments that carry code for the server, and unclosed ones', () => {
    expect(refused('SELECT 1 /*! DROP TABLE customers */', 'mysql')).toMatch(/can carry code/);
    expect(refused('SELECT /*+ MAX_EXECUTION_TIME(1) */ 1', 'mysql')).toMatch(/can carry code/);
    expect(refused('SELECT 1 /* never closed')).toMatch(/not closed/);
    expect(refused("SELECT 'never closed")).toMatch(/not closed/);
    expect(refused('SELECT "never closed')).toMatch(/not closed/);
  });

  it('strings that end differently in another dialect cannot hide a second statement (both readings must agree)', () => {
    // standard SQL: the string is  \  and the rest is code; with backslash escapes the string runs on
    expect(refused("SELECT '\\'; DROP TABLE customers; -- '", 'mysql')).toMatch(/second statement|DROP/);
    expect(refused("SELECT '\\'; DROP TABLE customers; -- '", 'postgres')).toMatch(/second statement|DROP/);
    // in SQLite a backslash is just a character: this is one string and one statement
    expect(refused("SELECT '\\'", 'sqlite')).toBeUndefined();
    // dollar quoting hides code from a quote-aware reader
    expect(refused('SELECT $$; DROP TABLE customers; $$', 'postgres')).toMatch(/second statement|dollar-quoted/);
    expect(refused('SELECT $tag$ x $tag$', 'postgres')).toMatch(/dollar-quoted/);
    // a MySQL # comment is a comment to MySQL and code to the others: refused outright, not stripped
    expect(refused('SELECT 1 # ; DROP TABLE customers', 'mysql')).toMatch(/"#" comment/);
  });

  it('empty, NUL and very long texts', () => {
    expect(refused('')).toMatch(/empty/);
    expect(refused('   \n ')).toMatch(/empty/);
    expect(refused('SELECT 1\0; DROP TABLE x')).toMatch(/NUL/);
    expect(refused(`SELECT ${'1,'.repeat(SQL_DEFAULTS.maxChars)} 1`)).toMatch(/longer than/);
    expect(refused('-- only a comment')).toMatch(/empty/);
  });
});

describe('the statement check: what is allowed', () => {
  it('SELECT, WITH and VALUES, with joins, aggregates, windows and subqueries', () => {
    for (const sql of [
      'SELECT * FROM customers',
      'select c.name, sum(o.total) as total from customers c join orders o on o.customer_id = c.id group by c.name having sum(o.total) > 1 order by 2 desc limit 5',
      'WITH big AS (SELECT * FROM orders WHERE total > 5) SELECT count(*) FROM big',
      'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 5) SELECT x FROM n',
      'VALUES (1, 2), (3, 4)',
      'SELECT name, row_number() OVER (ORDER BY id) FROM customers',
      "SELECT REPLACE(name, 'a', 'b') FROM customers",
      "SELECT json_extract('{\"a\":1}', '$.a')",
      'SELECT * FROM pragma_table_info(\'customers\')',
    ])
      expect(refused(sql), sql).toBeUndefined();
  });

  it('keywords inside strings, quoted names, comments and longer words are not code', () => {
    for (const sql of ["SELECT '; DROP TABLE customers; --'", "SELECT 'it''s a delete; insert'", 'SELECT "delete", "drop table" FROM customers', 'SELECT [update] FROM customers', 'SELECT update_date, set_id, drop_count, into_x FROM customers', 'SELECT 1 -- ; DROP TABLE customers', 'SELECT 1 /* ; DELETE FROM customers */', 'SELECT `insert` FROM customers']) expect(refused(sql), sql).toBeUndefined();
  });

  it('is wrapped so that a trailing comment cannot swallow the limit', () => {
    expect(wrapLimit('SELECT 1 -- hi', 10)).toBe('SELECT * FROM (SELECT 1 -- hi\n) AS tp_q LIMIT 11');
  });
});

describe('the executor on SQLite', () => {
  it('runs a query: columns, rows, NULL, numbers and text', async () => {
    const r = await runReadOnlySql(src(), 'SELECT id, name, balance FROM customers ORDER BY id');
    expect(r.columns).toEqual(['id', 'name', 'balance']);
    expect(r.rows).toEqual([[1, 'Ada', 10.5], [2, 'Grace', null], [3, 'Linus', 3.25]]);
    const agg = await runReadOnlySql(src(), 'SELECT c.name, sum(o.total) AS spent FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name ORDER BY c.name');
    expect(agg.rows).toEqual([['Ada', 25.5], ['Linus', 7]]);
    expect((await runReadOnlySql(src(), 'SELECT 1 -- a comment')).rows).toEqual([[1]]);
  });

  it('an empty result keeps its columns when the engine can say them, and an error is a message', async () => {
    const e = await runReadOnlySql(src(), 'SELECT id FROM customers WHERE id < 0');
    expect(e.rows).toEqual([]);
    await expect(runReadOnlySql(src(), 'SELECT nope FROM customers')).rejects.toThrow(/The SQL query failed: .*nope/);
    await expect(runReadOnlySql(src(), 'SELECT * FROM missing_table')).rejects.toThrow(/no such table/);
  });

  it('refuses before it opens anything: a write never reaches the database, and the file is unchanged', async () => {
    const before = sha(db);
    for (const sql of ['DELETE FROM customers', 'SELECT 1; DROP TABLE customers', "ATTACH DATABASE ':memory:' AS x", 'PRAGMA query_only = OFF', 'UPDATE customers SET name = 1']) await expect(runReadOnlySql(src(), sql)).rejects.toThrow(/cannot be run/);
    expect(sha(db)).toBe(before);
    expect((await runReadOnlySql(src(), 'SELECT count(*) FROM customers')).rows).toEqual([[3]]);
  });

  it('is opened read-only: a database file that is not there is not created', async () => {
    const missing = resolveSqlSource({ path: join(t.dir, 'nope.db') });
    await expect(runReadOnlySql(missing, 'SELECT 1')).rejects.toThrow(/unable to open|failed/i);
  });

  it('a result of more rows than the cap is refused, never cut', async () => {
    await expect(runReadOnlySql(src(), 'SELECT * FROM customers', { maxRows: 2 })).rejects.toThrow(/more than 2 rows/);
    expect((await runReadOnlySql(src(), 'SELECT * FROM customers', { maxRows: 3 })).rows).toHaveLength(3);
    // an endless recursive query is cut by the row cap, lazily
    await expect(runReadOnlySql(src(), 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c', { maxRows: 50, timeoutMs: 5000 })).rejects.toThrow(/more than 50 rows/);
  });

  it('a long query is stopped at the time limit, and the next one runs', async () => {
    const t0 = Date.now();
    await expect(runReadOnlySql(src(), 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c', { timeoutMs: 300 })).rejects.toThrow(/ran for more than 300 ms and was stopped/);
    expect(Date.now() - t0).toBeLessThan(5000);
    // a heavy cross join is cut the same way
    await expect(runReadOnlySql(src(), 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 3000) SELECT count(*) FROM n a, n b, n c', { timeoutMs: 300 })).rejects.toThrow(/stopped/);
    expect((await runReadOnlySql(src(), 'SELECT 1')).rows).toEqual([[1]]);
  }, 20_000);

  it('a cancelled query stops', async () => {
    const c = new AbortController();
    const p = runReadOnlySql(src(), 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c', { timeoutMs: 10_000 }, c.signal);
    setTimeout(() => c.abort(), 100);
    await expect(p).rejects.toThrow(/cancelled/);
  }, 20_000);

  it('many queries at once all finish (at most four run together)', async () => {
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => runReadOnlySql(src(), `SELECT ${i} AS n`)));
    expect(rs.map((r) => r.rows[0]![0])).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });
});

describe('PostgreSQL and MySQL sources', () => {
  it('must be declared read-only; a URL in the environment is read from there; a bad URL is refused', () => {
    expect(() => resolveSqlSource({ url: 'postgres://u:p@127.0.0.1/db' })).toThrow(/must be declared read-only/);
    expect(() => resolveSqlSource({ url: 'mysql://u:p@127.0.0.1/db', readOnly: false })).toThrow(/must be declared read-only/);
    const pg = resolveSqlSource({ url: 'postgres://u:secret@127.0.0.1/db', readOnly: true });
    expect(pg).toMatchObject({ dialect: 'postgres' });
    expect(pg.label).not.toContain('secret');
    expect(resolveSqlSource({ connectionEnv: 'SHOP_DB', readOnly: true }, { env: { SHOP_DB: 'mysql://u:p@127.0.0.1/shop' } }).dialect).toBe('mysql');
    expect(() => resolveSqlSource({ connectionEnv: 'NOT_SET', readOnly: true }, { env: {} })).toThrow(/is not set/);
    expect(() => resolveSqlSource({ url: 'http://example.com/db', readOnly: true })).toThrow(/postgres:\/\/ or mysql:\/\//);
    expect(() => resolveSqlSource({})).toThrow(/needs a SQLite file/);
  });

  it('the read-only transaction and the statement time limit are what is sent first', () => {
    expect(readOnlyPreamble('postgres', 10_000)).toEqual(['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 10000']);
    expect(readOnlyPreamble('mysql', 10_000)).toEqual(['SET SESSION MAX_EXECUTION_TIME = 10000', 'START TRANSACTION READ ONLY']);
  });

  it('the checked, wrapped query goes to the driver with a time limit; a refused one never reaches it', async () => {
    const calls: Array<{ sql: string; timeoutMs?: number }> = [];
    const driver: DbDriver = {
      async query(_url, sql, _p, opts) {
        calls.push({ sql, timeoutMs: opts?.timeoutMs });
        return [{ id: 1, name: 'Ada' }];
      },
    };
    const restore = setDbDriver('postgres', driver);
    try {
      const s = resolveSqlSource({ url: 'postgres://u:p@127.0.0.1:5432/shop', readOnly: true });
      const r = await runReadOnlySql(s, 'SELECT id, name FROM customers;', { timeoutMs: 2500, maxRows: 100 });
      expect(r).toEqual({ columns: ['id', 'name'], rows: [[1, 'Ada']] });
      expect(calls).toEqual([{ sql: 'SELECT * FROM (SELECT id, name FROM customers\n) AS tp_q LIMIT 101', timeoutMs: 2500 }]);
      for (const sql of ['DELETE FROM customers', 'SELECT pg_sleep(60)', 'SELECT $$ ; $$', 'SELECT 1; SELECT 2']) await expect(runReadOnlySql(s, sql)).rejects.toThrow(/cannot be run/);
      expect(calls).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('a driver error is a message with its reason; more rows than the cap is refused', async () => {
    const restore = setDbDriver('mysql', {
      async query(_u, sql) {
        if (/boom/.test(sql)) throw new Error('canceling statement due to statement timeout');
        return Array.from({ length: 6 }, (_, i) => ({ n: i }));
      },
    });
    try {
      const s = resolveSqlSource({ url: 'mysql://u:p@127.0.0.1/shop', readOnly: true });
      await expect(runReadOnlySql(s, "SELECT 'boom'")).rejects.toThrow(/ran too long and was stopped/);
      await expect(runReadOnlySql(s, 'SELECT n FROM t', { maxRows: 5 })).rejects.toThrow(/more than 5 rows/);
    } finally {
      restore();
    }
  });
});

describe('a leftover temp file check', () => {
  it('the test database was never written by the executor', () => {
    writeFileSync(join(t.dir, 'marker.txt'), 'x');
    expect(sha(db)).toBe(sha(db));
  });
});
