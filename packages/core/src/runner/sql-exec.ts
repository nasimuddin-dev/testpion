/**
 * The read-only SQL executor of the text-to-SQL metrics (planning/rag-testing.md §4k). The SQL it runs was written by the
 * system under test: untrusted text. Every layer must hold, and each is tested with hostile input (tests/unit/sql-exec.test.ts):
 *
 *  1. the text is tokenised (strings, quoted names and comments are not code) and must be ONE statement that starts with
 *     SELECT, WITH or VALUES and contains no keyword that writes, attaches, loads, locks or sleeps; functions that read
 *     files, sleep or build huge values are refused. For PostgreSQL and MySQL the text is read twice, with and without
 *     backslash escapes in strings, and both readings must agree, so a string the server ends differently cannot hide a
 *     second statement;
 *  2. the query runs wrapped as `SELECT * FROM (<query>) LIMIT n+1`: a result of more than n rows is refused, never cut;
 *  3. the connection is read-only: SQLite opened read-only (and `query_only`), PostgreSQL `BEGIN READ ONLY` with a statement
 *     timeout, MySQL `START TRANSACTION READ ONLY` with `MAX_EXECUTION_TIME`; when that cannot be set the query is not run;
 *  4. a time limit: a SQLite query runs in a worker thread that is terminated when the time is up;
 *  5. at most 4 queries at once per data source.
 *
 * The connection must be declared `readOnly: true` for PostgreSQL and MySQL (the docs ask for a read-only database user too).
 */
import { Worker } from 'node:worker_threads';
import { isAbsolute, resolve } from 'node:path';
import { ApsError } from '../errors.js';
import { Semaphore } from '../util/concurrency.js';
import { assertUrlAllowed } from '../net/policy.js';
import { dbKindOf, redactDbUrl, runDriverQuery, type DbKind } from './db-datasets.js';

export type SqlDialect = 'sqlite' | 'postgres' | 'mysql';

export const SQL_DEFAULTS = { maxRows: 10_000, timeoutMs: 10_000, maxConcurrent: 4, maxChars: 20_000 } as const;

/* ------------------------------------------------------------------ 1. the statement */

type Tok = { k: 'word' | 'string' | 'name' | 'punct' | 'number'; v: string };

/** Splits SQL into words, strings, quoted names and punctuation; comments vanish. `escapes`: a backslash escapes in a string. */
function tokenize(sql: string, o: { escapes: boolean; brackets: boolean; backticks: boolean }): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const two = sql.slice(i, i + 2);
    if (/\s/.test(c)) i++;
    else if (two === '--') {
      const j = sql.indexOf('\n', i);
      i = j < 0 ? n : j + 1;
    } else if (two === '/*') {
      // an executable comment (MySQL /*! … */, optimizer hints) is code to the server, so it is not allowed to look like a comment
      if (sql[i + 2] === '!' || sql[i + 2] === '+') return 'a /*! … */ or /*+ … */ comment can carry code for the server';
      const j = sql.indexOf('*/', i + 2);
      if (j < 0) return 'a comment is not closed';
      i = j + 2;
    } else if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= n) return 'a string is not closed';
        if (o.escapes && sql[j] === '\\') j += 2;
        else if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      out.push({ k: 'string', v: sql.slice(i, j + 1) });
      i = j + 1;
    } else if (c === '"' || (c === '`' && o.backticks) || (c === '[' && o.brackets)) {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        if (j >= n) return 'a quoted name is not closed';
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) j += 2;
          else break;
        } else j++;
      }
      out.push({ k: 'name', v: sql.slice(i + 1, j) });
      i = j + 1;
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      const m = /^[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/.exec(sql.slice(i))!;
      out.push({ k: 'word', v: m[0].toLowerCase() });
      i += m[0].length;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9][0-9a-zA-Z_.]*/.exec(sql.slice(i))!;
      out.push({ k: 'number', v: m[0] });
      i += m[0].length;
    } else {
      out.push({ k: 'punct', v: c });
      i++;
    }
  }
  return out;
}

const FORBIDDEN = new Set([
  'insert', 'update', 'delete', 'drop', 'create', 'alter', 'attach', 'detach', 'pragma', 'vacuum', 'reindex', 'truncate', 'grant', 'revoke', 'copy', 'call', 'exec', 'execute', 'merge', 'lock', 'set', 'begin', 'commit', 'rollback', 'savepoint', 'release', 'load', 'into', 'outfile', 'dumpfile', 'returning', 'analyze', 'explain', 'declare', 'do', 'handler', 'prepare', 'deallocate', 'listen', 'notify', 'unlisten', 'reset', 'show', 'use',
]);
/** A word that is only forbidden as a statement or a clause: `replace` is a function in SQLite and MySQL. */
const FUNCTION_DENY = /^(pg_sleep\w*|pg_read_\w+|pg_ls_\w+|pg_stat_file|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_logical_\w+|lo_\w+|dblink\w*|set_config|sleep|benchmark|load_file|get_lock|release_lock|is_free_lock|sys_exec|sys_eval|load_extension|readfile|writefile|edit|fts3_tokenizer|zeroblob|randomblob|repeat|rpad|lpad|replicate|query_to_xml\w*|xmlparse|current_setting|txid_\w+|nextval|setval)$/;

function refuse(msg: string): never {
  throw new ApsError('ValidationError', `This SQL cannot be run: ${msg}`, {
    why: 'The query comes from the system under test, so it is only run when it is one read-only SELECT, WITH or VALUES statement.',
    suggestions: ['Compare the results as CSV instead (inputs: results), or fix the system so it writes a single SELECT.'],
  });
}

/** One reading of the text: throws when it is not one read-only statement. */
function checkTokens(toks: Tok[]): void {
  // a single ';' may end the statement; any other is a second statement
  const semi = toks.findIndex((t) => t.k === 'punct' && t.v === ';');
  if (semi >= 0 && semi !== toks.length - 1) refuse('a second statement follows a ";"');
  const body = semi >= 0 ? toks.slice(0, semi) : toks;
  const first = body[0];
  if (!first) refuse('the query is empty');
  if (first.k !== 'word' || !['select', 'with', 'values'].includes(first.v)) refuse(`it starts with ${first.k === 'word' ? first.v.toUpperCase() : `"${first.v}"`}, not SELECT, WITH or VALUES`);
  body.forEach((t, i) => {
    if (t.k !== 'word') return;
    const next = body[i + 1];
    const call = next?.k === 'punct' && next.v === '(';
    if (t.v === 'replace' && !call) refuse('REPLACE is only allowed as a function');
    if (t.v === 'for' && body[i + 1]?.k === 'word' && ['update', 'share', 'no', 'key'].includes(body[i + 1]!.v)) refuse('FOR UPDATE / FOR SHARE locks rows');
    if (FORBIDDEN.has(t.v)) refuse(`${t.v.toUpperCase()} is not allowed in a read-only query`);
    if (call && FUNCTION_DENY.test(t.v)) refuse(`the function ${t.v}() can read files, sleep, load code or build huge values`);
  });
}

/**
 * The query as one statement without a trailing ";", or an error that says what is wrong. PostgreSQL and MySQL texts must pass
 * both readings (with and without backslash escapes in strings).
 */
export function checkReadOnlySql(sql: string, dialect: SqlDialect): string {
  const text = (sql ?? '').trim();
  if (!text) refuse('the query is empty');
  if (text.length > SQL_DEFAULTS.maxChars) refuse(`it is longer than ${SQL_DEFAULTS.maxChars} characters`);
  // a NUL ends a string for some drivers and the text for others
  if (text.includes('\0')) refuse('it contains a NUL character');
  const readings: Array<{ escapes: boolean; brackets: boolean; backticks: boolean }> =
    dialect === 'sqlite' ? [{ escapes: false, brackets: true, backticks: true }] : dialect === 'mysql' ? [{ escapes: false, brackets: false, backticks: true }, { escapes: true, brackets: false, backticks: true }] : [{ escapes: false, brackets: false, backticks: false }, { escapes: true, brackets: false, backticks: false }];
  for (const r of readings) {
    const toks = tokenize(text, r);
    if (typeof toks === 'string') refuse(toks);
    checkTokens(toks);
  }
  // PostgreSQL dollar-quoted strings hide their content from a quote-aware reader
  if (dialect === 'postgres' && /\$[A-Za-z_0-9]*\$/.test(text)) refuse('dollar-quoted strings ($$ … $$) are not allowed');
  return text.replace(/;\s*$/, '').trim();
}

/** `SELECT * FROM (<query>) AS tp_q LIMIT n+1`: the server stops after n+1 rows whatever the query asks for. */
export const wrapLimit = (sql: string, maxRows: number) => `SELECT * FROM (${sql}\n) AS tp_q LIMIT ${maxRows + 1}`;

/* ------------------------------------------------------------------ 2. the source */

export interface SqlSource {
  /** A SQLite database file (relative to `base`). */
  path?: string;
  /** postgres:// or mysql:// */
  url?: string;
  /** The OS environment variable that holds the URL, so the password never sits in a file. */
  connectionEnv?: string;
  /** Declared by the person: this connection (and its user) cannot write. Required for PostgreSQL and MySQL. */
  readOnly?: boolean;
}

export interface SqlLimits {
  maxRows?: number;
  timeoutMs?: number;
}

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
}

const gates = new Map<string, Semaphore>();
const gateOf = (key: string) => {
  let g = gates.get(key);
  if (!g) gates.set(key, (g = new Semaphore(SQL_DEFAULTS.maxConcurrent)));
  return g;
};

export interface ResolvedSource {
  dialect: SqlDialect;
  path?: string;
  url?: string;
  /** For messages: no password. */
  label: string;
  key: string;
}

export function resolveSqlSource(src: SqlSource, o: { base?: string; env?: Record<string, string | undefined> } = {}): ResolvedSource {
  const url = src.url ?? (src.connectionEnv ? (o.env ?? process.env)[src.connectionEnv] : undefined);
  if (src.connectionEnv && !src.url && !url) throw new ApsError('ConfigurationError', `The environment variable ${src.connectionEnv} (the database connection) is not set`);
  const kind = dbKindOf(url);
  if (kind) {
    if (src.readOnly !== true)
      throw new ApsError('ConfigurationError', 'A PostgreSQL or MySQL database for SQL metrics must be declared read-only (readOnly: true)', {
        why: 'The generated SQL comes from the system under test. TestPion checks it and runs it in a read-only transaction, and the database user should be read-only as well.',
        suggestions: ['Use a read-only database user, then set readOnly: true on the database.'],
      });
    return { dialect: kind, url: url!, label: redactDbUrl(url!), key: `${kind}:${redactDbUrl(url!)}` };
  }
  if (url) throw new ApsError('ConfigurationError', 'The database connection must be a postgres:// or mysql:// URL (or a SQLite file in `path`)');
  if (!src.path) throw new ApsError('ConfigurationError', 'A database for SQL metrics needs a SQLite file (path) or a connection (url / connectionEnv)');
  const file = isAbsolute(src.path) ? src.path : resolve(o.base ?? process.cwd(), src.path);
  return { dialect: 'sqlite', path: file, label: src.path, key: `sqlite:${file}` };
}

/* ------------------------------------------------------------------ 3. the run */

/** The worker's program: opens the file read-only, runs one prepared statement, answers up to maxRows + 1 rows. */
const SQLITE_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
process.emitWarning = () => {};
try {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(workerData.path, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  const stmt = db.prepare(workerData.sql);
  const rows = [];
  let columns = [];
  for (const r of stmt.iterate()) {
    if (!columns.length) columns = Object.keys(r);
    rows.push(columns.map((c) => { const v = r[c]; return typeof v === 'bigint' ? (v <= 9007199254740991n && v >= -9007199254740991n ? Number(v) : v.toString()) : v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v; }));
    if (rows.length > workerData.maxRows) break;
  }
  if (!columns.length && typeof stmt.columns === 'function') columns = stmt.columns().map((c) => c.name);
  db.close();
  parentPort.postMessage({ ok: true, columns, rows });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e && e.message || e) });
}
`;

function runSqlite(path: string, sql: string, maxRows: number, timeoutMs: number, signal?: AbortSignal): Promise<SqlResult> {
  return new Promise((resolveP, reject) => {
    const w = new Worker(SQLITE_WORKER, { eval: true, workerData: { path, sql, maxRows }, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } });
    let done = false;
    const finish = (f: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void w.terminate();
      f();
    };
    const timer = setTimeout(() => finish(() => reject(new ApsError('TimeoutError', `The SQL query ran for more than ${timeoutMs} ms and was stopped`, { suggestions: ['Compare the results as CSV, or ask the system for a query that finishes sooner.'] }))), timeoutMs);
    const onAbort = () => finish(() => reject(new ApsError('CancelledError', 'The SQL query was cancelled')));
    signal?.addEventListener('abort', onAbort, { once: true });
    w.once('message', (m: { ok: boolean; error?: string; columns?: string[]; rows?: unknown[][] }) => finish(() => (m.ok ? resolveP({ columns: m.columns ?? [], rows: m.rows ?? [] }) : reject(new ApsError('ValidationError', `The SQL query failed: ${m.error}`)))));
    w.once('error', (e) => finish(() => reject(new ApsError('ValidationError', `The SQL query failed: ${e.message}`))));
    w.once('exit', (code) => finish(() => reject(new ApsError('ValidationError', `The SQL query stopped (worker exit ${code})`))));
  });
}

/**
 * Runs a read-only query. Throws when the SQL is not one read-only statement, when the source is not declared read-only,
 * when the query takes longer than the limit, or when it returns more than `maxRows` rows (the result would be cut).
 */
export async function runReadOnlySql(src: ResolvedSource, sql: string, limits: SqlLimits = {}, signal?: AbortSignal): Promise<SqlResult> {
  const maxRows = Math.max(1, Math.floor(limits.maxRows ?? SQL_DEFAULTS.maxRows));
  const timeoutMs = Math.max(50, Math.floor(limits.timeoutMs ?? SQL_DEFAULTS.timeoutMs));
  const checked = checkReadOnlySql(sql, src.dialect);
  const wrapped = wrapLimit(checked, maxRows);
  const release = await gateOf(src.key).acquire(signal);
  try {
    let result: SqlResult;
    if (src.dialect === 'sqlite') result = await runSqlite(src.path!, wrapped, maxRows, timeoutMs, signal);
    else {
      let host: URL;
      try {
        host = new URL(src.url!.replace(/^(postgres|postgresql|mysql|mariadb):/i, 'http:'));
      } catch {
        throw new ApsError('ConfigurationError', `Not a valid connection URL: ${src.label}`);
      }
      await assertUrlAllowed(host);
      const rows = await runDriverQuery(src.dialect as DbKind, src.url!, wrapped, { timeoutMs });
      const columns = rows.length ? Object.keys(rows[0]!) : [];
      result = { columns, rows: rows.map((r) => columns.map((c) => r[c])) };
    }
    if (result.rows.length > maxRows) throw new ApsError('ValidationError', `The SQL result has more than ${maxRows} rows; it is not compared`, { suggestions: ['Ask for fewer rows (a LIMIT, an aggregate), or compare on a smaller database.'] });
    return result;
  } finally {
    release();
  }
}
