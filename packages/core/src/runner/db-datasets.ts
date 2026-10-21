import { ApsError } from '../errors.js';
import { assertUrlAllowed } from '../net/policy.js';

/**
 * Datasets from PostgreSQL and MySQL / MariaDB (the roadmap's "database-query datasets"): one record per row of a
 * read-only query, columns as fields. The connection is a URL (postgres://user:password@host:5432/db,
 * mysql://user:password@host:3306/db); in files, name an OS environment variable that holds it (`connectionEnv`), so
 * the password never sits in the workspace. The query must be one SELECT / WITH / VALUES (/ SHOW / TABLE) statement and
 * runs in a read-only transaction.
 */
export type DbKind = 'postgres' | 'mysql';

interface DbRow {
  [column: string]: unknown;
}

/** A database client as the dataset reader needs it: connect, run one read-only query, close. */
export interface DbDriver {
  /** `opts.timeoutMs`: a statement time limit on the server (the SQL metrics set it; datasets keep the driver's default). */
  query(url: string, sql: string, params: unknown[] | Record<string, unknown> | undefined, opts?: { timeoutMs?: number }): Promise<DbRow[]>;
}

/**
 * The statements that make a connection read-only with a time limit before the query runs. PostgreSQL: a read-only
 * transaction and `statement_timeout`. MySQL: the statement time limit, then a read-only transaction. A server that does not
 * take them is not queried: the SQL metrics never run on a connection they could not make read-only.
 */
export function readOnlyPreamble(kind: DbKind, timeoutMs: number): string[] {
  const ms = Math.max(1, Math.floor(timeoutMs));
  return kind === 'postgres' ? ['BEGIN READ ONLY', `SET LOCAL statement_timeout = ${ms}`] : [`SET SESSION MAX_EXECUTION_TIME = ${ms}`, 'START TRANSACTION READ ONLY'];
}

const DB_URL = /^(postgres|postgresql|mysql|mariadb):\/\//i;

/** Whether a dataset path is a database connection URL, and of which kind. */
export function dbKindOf(urlOrPath: string | undefined): DbKind | undefined {
  const m = urlOrPath && DB_URL.exec(urlOrPath.trim());
  if (!m) return undefined;
  return /^postgres/i.test(m[1]!) ? 'postgres' : 'mysql';
}

/** The URL with the password hidden, for messages and logs. */
export function redactDbUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url.replace(/(\/\/[^:/@]+:)[^@]+@/, '$1***@');
  }
}

/** One read-only statement, as datasets only read. */
function assertReadOnlyQuery(sql: string | undefined, kind: string): string {
  const s = sql?.trim().replace(/;\s*$/, '');
  if (!s)
    throw new ApsError('ConfigurationError', `A ${kind} dataset needs a query (for example SELECT * FROM users)`, {
      suggestions: ['In a test file: dataset: { connectionEnv: DATABASE_URL, query: "SELECT …" }.', 'With run-collection: --iteration-data postgres://… --iteration-query "SELECT …".'],
    });
  if (!/^(select|with|values|show|table)\b/i.test(s) || s.includes(';'))
    throw new ApsError('ValidationError', 'A dataset query must be one SELECT, WITH or VALUES statement', {
      why: 'Datasets only read data; the query runs in a read-only transaction.',
      suggestions: ['Write a single SELECT (WITH … SELECT and VALUES work too), without a second statement.'],
    });
  return s;
}

/** A value as a record field: dates as ISO text, binary as base64, big integers as numbers when they fit. */
function cell(v: unknown): unknown {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  if (typeof v === 'bigint') return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString();
  return v;
}

/** PostgreSQL ($1, $2 … placeholders; an object becomes the values in key order). */
const postgresDriver: DbDriver = {
  async query(url, sql, params, opts) {
    const pg = (await import('pg')).default;
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000, statement_timeout: opts?.timeoutMs ?? 120_000 } as never);
    await client.connect();
    try {
      for (const s of opts?.timeoutMs ? readOnlyPreamble('postgres', opts.timeoutMs) : ['BEGIN READ ONLY']) await client.query(s);
      const values = params === undefined ? [] : Array.isArray(params) ? params : Object.values(params);
      const r = await client.query(sql, values);
      await client.query('ROLLBACK');
      return r.rows as DbRow[];
    } finally {
      await client.end().catch(() => undefined);
    }
  },
};

/** MySQL / MariaDB (? placeholders, or :name with an object). */
const mysqlDriver: DbDriver = {
  async query(url, sql, params, opts) {
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection({ uri: url.replace(/^mariadb:/i, 'mysql:'), connectTimeout: 15_000, namedPlaceholders: !!params && !Array.isArray(params), dateStrings: false });
    try {
      if (opts?.timeoutMs) {
        const [limit, tx] = readOnlyPreamble('mysql', opts.timeoutMs);
        try {
          await conn.query(limit!);
        } catch {
          // MariaDB counts the limit in seconds, under another name
          await conn.query(`SET SESSION max_statement_time = ${Math.max(0.001, opts.timeoutMs / 1000)}`);
        }
        await conn.query(tx!);
      } else await conn.query('START TRANSACTION READ ONLY');
      const [rows] = await conn.query(sql, params as never);
      await conn.query('ROLLBACK');
      return (Array.isArray(rows) ? rows : []) as DbRow[];
    } finally {
      await conn.end().catch(() => undefined);
    }
  },
};

const drivers: Record<DbKind, DbDriver> = { postgres: postgresDriver, mysql: mysqlDriver };

/** Replace a driver (tests use an in-memory database). Returns a function that puts the real one back. */
export function setDbDriver(kind: DbKind, driver: DbDriver): () => void {
  const before = drivers[kind];
  drivers[kind] = driver;
  return () => {
    drivers[kind] = before;
  };
}

/** One query through the driver of a kind, with a statement time limit (the SQL metrics call this after their own checks). */
export async function runDriverQuery(kind: DbKind, url: string, sql: string, opts: { timeoutMs: number }): Promise<DbRow[]> {
  try {
    const rows = await drivers[kind].query(url, sql, undefined, opts);
    return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v)])));
  } catch (e) {
    const msg = (e as Error).message;
    const connect = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect|password authentication|Access denied|getaddrinfo/i.test(msg);
    const timeout = /statement timeout|max_execution_time|maximum statement execution time|canceling statement/i.test(msg);
    throw new ApsError(connect ? 'NetworkError' : timeout ? 'TimeoutError' : 'ValidationError', `The ${kind === 'postgres' ? 'PostgreSQL' : 'MySQL'} query ${connect ? 'could not connect' : timeout ? 'ran too long and was stopped' : 'failed'}: ${msg}`, {
      suggestions: connect ? [`Check the host, port, user and password of ${redactDbUrl(url)}.`] : undefined,
    });
  }
}

/** The rows of a read-only query on a PostgreSQL or MySQL database, as dataset records. */
export async function* dbRecords(url: string, query: string | undefined, params?: unknown[] | Record<string, unknown>): AsyncGenerator<DbRow> {
  const kind = dbKindOf(url);
  if (!kind) throw new ApsError('ConfigurationError', 'A database dataset needs a postgres:// or mysql:// connection URL');
  const sql = assertReadOnlyQuery(query, kind === 'postgres' ? 'PostgreSQL' : 'MySQL');
  let host: URL;
  try {
    host = new URL(url.replace(/^(postgres|postgresql|mysql|mariadb):/i, 'http:'));
  } catch {
    throw new ApsError('ConfigurationError', `Not a valid connection URL: ${redactDbUrl(url)}`);
  }
  await assertUrlAllowed(host);
  let rows: DbRow[];
  try {
    rows = await drivers[kind].query(url, sql, params);
  } catch (e) {
    const msg = (e as Error).message;
    const connect = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout|connect|password authentication|Access denied|getaddrinfo/i.test(msg);
    throw new ApsError(connect ? 'NetworkError' : 'ValidationError', `The ${kind === 'postgres' ? 'PostgreSQL' : 'MySQL'} dataset ${connect ? 'could not connect' : 'query failed'}: ${msg}`, {
      suggestions: connect
        ? [`Check the host, port, user and password of ${redactDbUrl(url)}, and that the database accepts connections from this computer.`]
        : ['Check the table and column names, and the placeholders: $1, $2 … for PostgreSQL, ? (or :name with an object) for MySQL.'],
    });
  }
  for (const row of rows) {
    const rec: DbRow = {};
    for (const [k, v] of Object.entries(row)) rec[k] = cell(v);
    yield rec;
  }
}
