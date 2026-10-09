import { csvRecords, parseCsvLine } from '@testpion/shared';
import { assertUrlAllowed } from '../net/policy.js';
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, extname, join, relative, sep } from 'node:path';
import { ApsError } from '../errors.js';
import { queryAll } from '../util/jsonpath.js';
import { dbKindOf, dbRecords } from './db-datasets.js';

export type DatasetRecord = Record<string, unknown>;

export interface DatasetSource {
  /** Local file (.jsonl, .ndjson, .json, .csv, .md), or a SQLite database (.db, .sqlite, .sqlite3) with `query`. */
  path?: string;
  /** SQL for a SQLite, PostgreSQL or MySQL database: one record per row, columns as fields. Read-only (SELECT / WITH / VALUES). */
  query?: string;
  /** A PostgreSQL or MySQL database: postgres://user:password@host:5432/db or mysql://… (a `path` with such a URL works too). */
  connection?: string;
  /** The name of an OS environment variable holding the connection URL (keeps the password out of files; CI friendly). */
  connectionEnv?: string;
  /** Values for `?` (array) or `:name` / `$name` / `@name` (object) placeholders in `query`. */
  params?: unknown[] | Record<string, unknown>;
  /** Remote JSON / JSONL (API response dataset). */
  url?: string;
  /** JSONPath to the array of records inside a JSON document. */
  recordsPath?: string;
  /** Inline records. */
  records?: DatasetRecord[];
  format?: 'jsonl' | 'json' | 'csv' | 'markdown' | 'sqlite';
  limit?: number;
  offset?: number;
}

/**
 * Stream dataset records without loading large files fully into memory.
 * JSONL and CSV are read line by line; JSON/Markdown are parsed whole (use JSONL for very large datasets).
 */
export async function* readDataset(src: DatasetSource): AsyncGenerator<DatasetRecord> {
  const limit = src.limit ?? Infinity;
  const offset = src.offset ?? 0;
  let i = 0;
  let emitted = 0;
  for await (const r of rawRecords(src)) {
    if (i++ < offset) continue;
    if (emitted >= limit) return;
    emitted++;
    yield r;
  }
}

function formatOf(src: DatasetSource): NonNullable<DatasetSource['format']> {
  if (src.format) return src.format;
  if (src.query) return 'sqlite';
  const ext = extname(src.path ?? new URL(src.url ?? 'http://x/a.json').pathname).toLowerCase();
  if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
  if (ext === '.csv' || ext === '.tsv') return 'csv';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (SQLITE_EXT.test(ext)) return 'sqlite';
  return 'json';
}

async function* rawRecords(src: DatasetSource): AsyncGenerator<DatasetRecord> {
  if (src.records) {
    yield* src.records;
    return;
  }
  // a database: a connection URL, given directly, in an OS environment variable, or as the path
  // `env:NAME` as the path (CLI, agents, the app's data box) names the variable too
  const envName = src.connectionEnv ?? (src.path && /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(src.path) ? src.path.slice(4) : undefined);
  const conn = src.connection ?? (envName ? process.env[envName] : undefined) ?? (dbKindOf(src.path) ? src.path : undefined);
  if (envName && !conn)
    throw new ApsError('ConfigurationError', `The environment variable ${envName} is not set: it should hold the database URL`, { suggestions: [`Set ${envName}=postgres://user:password@host:5432/db (or mysql://…) before running.`] });
  if (conn) {
    yield* dbRecords(conn, src.query, src.params);
    return;
  }
  const fmt = formatOf(src);
  if (src.url) {
    await assertUrlAllowed(src.url);
    const res = await fetch(src.url);
    if (!res.ok) throw new ApsError('NetworkError', `Dataset URL returned HTTP ${res.status}`);
    const text = await res.text();
    yield* parseText(text, fmt, src.recordsPath);
    return;
  }
  if (!src.path) throw new ApsError('ConfigurationError', 'Dataset needs `path`, `url` or `records`');
  if (fmt === 'sqlite') {
    yield* sqliteRecords(src.path, src.query, src.params);
    return;
  }
  if (fmt === 'jsonl') {
    const rl = createInterface({ input: createReadStream(src.path, 'utf8'), crlfDelay: Infinity });
    let line = 0;
    for await (const l of rl) {
      line++;
      const t = l.trim();
      if (!t || t.startsWith('//')) continue;
      try {
        yield toRecord(JSON.parse(t));
      } catch (e) {
        throw new ApsError('ValidationError', `Invalid JSON on line ${line} of ${src.path}: ${(e as Error).message}`);
      }
    }
    return;
  }
  if (fmt === 'csv') {
    const rl = createInterface({ input: createReadStream(src.path, 'utf8'), crlfDelay: Infinity });
    const delim = src.path.endsWith('.tsv') ? '\t' : ',';
    let header: string[] | undefined;
    let pending = '';
    let openQuotes = 0;
    for await (const l of rl) {
      pending = pending ? `${pending}\n${l}` : l;
      // a record continues while quotes are unbalanced (counted line by line, not over the record again)
      openQuotes = (openQuotes + (l.match(/"/g)?.length ?? 0)) % 2;
      if (openQuotes === 1) continue;
      const cells = parseCsvLine(pending, delim);
      pending = '';
      if (!header) {
        header = cells.map((c) => c.trim());
        continue;
      }
      if (cells.length === 1 && cells[0] === '') continue;
      const rec: DatasetRecord = {};
      header.forEach((h, idx) => (rec[h] = coerce(cells[idx] ?? '')));
      yield rec;
    }
    return;
  }
  const text = await readFile(src.path, 'utf8');
  yield* parseText(text, fmt, src.recordsPath);
}

const SQLITE_EXT = /^\.(db|db3|sqlite|sqlite3)$/;

/** Whether a data file is a SQLite database (it needs a query). */
export const isSqliteDataset = (path: string) => SQLITE_EXT.test(extname(path).toLowerCase());

type SqliteStatement = { all(...a: unknown[]): unknown[]; iterate?(...a: unknown[]): IterableIterator<unknown>; columns?(): Array<{ name: string }> };
type SqliteModule = { DatabaseSync: new (path: string, opts?: { readOnly?: boolean; open?: boolean }) => { prepare(sql: string): SqliteStatement; close(): void } };

function sqliteModule(): SqliteModule {
  const gbm = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const emit = process.emitWarning;
  process.emitWarning = (() => undefined) as typeof process.emitWarning;
  try {
    const m = gbm?.('node:sqlite') as SqliteModule | undefined;
    if (m?.DatabaseSync) return m;
  } catch {
    /* fall through */
  } finally {
    process.emitWarning = emit;
  }
  throw new ApsError('ConfigurationError', 'SQLite datasets need Node.js 22.5 or newer (node:sqlite)', { suggestions: ['Update Node.js, or export the rows to CSV or JSON.'] });
}

/**
 * Rows of a read-only query on a SQLite database. The database is opened read-only and only
 * SELECT / WITH / VALUES statements are accepted, so a dataset can never change it.
 */
function* sqliteRecords(path: string, query: string | undefined, params?: DatasetSource['params']): Generator<DatasetRecord> {
  const sql = query?.trim().replace(/;\s*$/, '');
  const where = ['In a test file: dataset: { path: app.db, query: "SELECT …" }.', 'With run-collection: --iteration-query "SELECT …".', 'In the app: the query box under the data file in the Collection Runner.'];
  if (!sql) throw new ApsError('ConfigurationError', `${path} is a SQLite database: add a query (for example SELECT * FROM users)`, { suggestions: where });
  if (!/^(select|with|values)\b/i.test(sql) || sql.includes(';'))
    throw new ApsError('ValidationError', 'A dataset query must be one SELECT, WITH or VALUES statement', { why: 'Datasets only read data; the database is opened read-only.', suggestions: ['Write a single SELECT (WITH … SELECT and VALUES work too), without a trailing second statement.'] });
  const { DatabaseSync } = sqliteModule();
  let db: InstanceType<SqliteModule['DatabaseSync']>;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (e) {
    throw new ApsError('ConfigurationError', `Could not open the SQLite database ${path}: ${(e as Error).message}`);
  }
  try {
    let stmt: SqliteStatement;
    try {
      stmt = db.prepare(sql);
    } catch (e) {
      throw new ApsError('ValidationError', `The dataset query failed: ${(e as Error).message}`, { suggestions: ["Check the table and column names; SELECT name FROM sqlite_master WHERE type = 'table' lists the tables."] });
    }
    const args = params === undefined ? [] : Array.isArray(params) ? params : [params];
    const rows = stmt.iterate ? stmt.iterate(...args) : stmt.all(...args)[Symbol.iterator]();
    for (const row of rows as Iterable<Record<string, unknown>>) {
      // BLOBs become base64 text; numbers, strings and NULL stay as they are
      const rec: DatasetRecord = {};
      for (const [k, v] of Object.entries(row)) rec[k] = v instanceof Uint8Array ? Buffer.from(v).toString('base64') : typeof v === 'bigint' ? Number(v) : v;
      yield rec;
    }
  } finally {
    db.close();
  }
}

function* parseText(text: string, fmt: string, recordsPath?: string): Generator<DatasetRecord> {
  if (fmt === 'jsonl') {
    for (const l of text.split(/\r?\n/)) if (l.trim()) yield toRecord(JSON.parse(l));
    return;
  }
  if (fmt === 'markdown') {
    yield* parseMarkdownTable(text);
    return;
  }
  if (fmt === 'csv') {
    // quoted fields may span lines: a record ends where the quotes balance
    const [header, ...rows] = csvRecords(text, ',');
    for (const cells of rows) {
      const rec: DatasetRecord = {};
      header!.forEach((h, i) => (rec[h.trim()] = coerce(cells[i] ?? '')));
      yield rec;
    }
    return;
  }
  const data = JSON.parse(text);
  const arr = recordsPath ? queryAll(data, recordsPath).flat() : Array.isArray(data) ? data : Array.isArray(data?.records) ? data.records : Array.isArray(data?.data) ? data.data : [data];
  for (const r of arr) yield toRecord(r);
}

function toRecord(v: unknown): DatasetRecord {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as DatasetRecord) : { input: v };
}

/** CSV text as records of cells (RFC 4180: quoted fields may contain the delimiter, quotes and line breaks); blank lines are skipped. */
export { csvRecords, parseCsvLine } from '@testpion/shared';

function coerce(s: string): unknown {
  const t = s.trim();
  if (t === '') return '';
  if (/^-?\d+(\.\d+)?$/.test(t) && t.length < 16) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  if (/^[[{]/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      /* keep string */
    }
  }
  return s;
}

function* parseMarkdownTable(md: string): Generator<DatasetRecord> {
  const rows = md
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'));
  if (rows.length < 2) return;
  const cells = (l: string) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const header = cells(rows[0]!);
  for (const r of rows.slice(1)) {
    if (/^\|?\s*:?-{2,}/.test(r)) continue;
    const c = cells(r);
    const rec: DatasetRecord = {};
    header.forEach((h, i) => (rec[h] = coerce(c[i] ?? '')));
    yield rec;
  }
}

/** Tables and views of a SQLite database (read-only), for suggesting a dataset query. */
export function sqliteTables(path: string): string[] {
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Array<{ name: string }>).map((r) => r.name);
  } finally {
    db.close();
  }
}

export interface WorkspaceDataset {
  /** Path inside the workspace, e.g. datasets/users.csv (what run_collection's `data` and `-d` take). */
  path: string;
  size: number;
  modified: string;
  format: 'csv' | 'json' | 'jsonl' | 'markdown' | 'sqlite';
  /** SQLite: its tables (a dataset needs a query). */
  tables?: string[];
}

/**
 * Add one record to a JSONL dataset in the workspace's datasets/ folder, made when missing: a Playground answer
 * worth keeping becomes an evaluation case (its inputs and the answer as `expected`). `name` is a file under
 * datasets/ (`.jsonl` is added when it has no extension). Returns the file and how many records it now has.
 */
export async function appendDatasetRow(
  store: { root: string; path(...p: string[]): string; safePath(rel: string, base?: string): string },
  name: string,
  row: Record<string, unknown>,
): Promise<{ path: string; rows: number }> {
  const clean = name.trim().replace(/^datasets[\\/]/, '');
  if (!clean) throw new ApsError('ValidationError', 'A dataset name is needed');
  const rel = extname(clean) ? clean : `${clean}.jsonl`;
  if (!/\.(jsonl|ndjson)$/i.test(rel)) throw new ApsError('ValidationError', `Records are added to JSONL datasets, not ${extname(rel)}`, { suggestions: ['Use a name ending in .jsonl, or no extension.'] });
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new ApsError('ValidationError', 'A record is an object of fields');
  const file = store.safePath(rel, store.path('datasets'));
  mkdirSync(dirname(file), { recursive: true });
  // a file that does not end in a newline gets one first (the last byte says), then the record; the whole file is
  // never read into memory: the count streams through it
  const size = existsSync(file) ? statSync(file).size : 0;
  let needsNewline = false;
  if (size) {
    const fd = openSync(file, 'r');
    try {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      needsNewline = last[0] !== 0x0a;
    } finally {
      closeSync(fd);
    }
  }
  appendFileSync(file, (needsNewline ? '\n' : '') + JSON.stringify(row) + '\n');
  return { path: relative(store.root, file).split(sep).join('/'), rows: await countLines(file) };
}

/** Non-blank lines of a file, streamed. */
async function countLines(file: string): Promise<number> {
  let n = 0;
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const l of rl) if (l.trim()) n++;
  return n;
}

/** Data files in the workspace's datasets/ folder (up to three levels deep), newest first. */
export function listWorkspaceDatasets(store: { root: string; path(...p: string[]): string }): WorkspaceDataset[] {
  const root = store.path('datasets');
  const out: WorkspaceDataset[] = [];
  const walk = (dir: string, depth: number) => {
    if (!existsSync(dir) || depth > 3) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      // inline-*: copies older versions made for evaluation runs
      else if (/\.(csv|tsv|json|jsonl|ndjson|md|db|db3|sqlite|sqlite3)$/i.test(e.name) && !e.name.startsWith('inline-')) {
        const st = statSync(p);
        const format = formatOf({ path: p });
        let tables: string[] | undefined;
        if (format === 'sqlite')
          try {
            tables = sqliteTables(p);
          } catch {
            tables = [];
          }
        out.push({ path: relative(store.root, p).split(sep).join('/'), size: st.size, modified: st.mtime.toISOString(), format: format === 'markdown' ? 'markdown' : format, ...(tables ? { tables } : {}) });
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => (a.modified < b.modified ? 1 : -1)).slice(0, 500);
}

/** A column of a dataset and the kind of value it holds (a hint from the rows read: CSV cells that are all numbers count as numbers). */
export interface DatasetColumn {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' | 'mixed';
}

/** The columns of records in first-seen order, each with the kind of value it holds across the rows. */
export function datasetColumns(rows: DatasetRecord[]): DatasetColumn[] {
  const seen = new Map<string, Set<string>>();
  for (const r of rows)
    for (const [k, v] of Object.entries(r)) {
      const kinds = seen.get(k) ?? new Set<string>();
      seen.set(k, kinds);
      if (v === null || v === undefined || v === '') continue;
      kinds.add(Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v === 'string' ? (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim()) ? 'numeric-text' : /^(true|false)$/i.test(v.trim()) ? 'boolean-text' : 'string') : typeof v);
    }
  return [...seen].map(([name, kinds]) => {
    if (!kinds.size) return { name, type: 'null' };
    // text that always looks like a number (or true/false) is a number (CSV cells are text)
    const all = [...kinds];
    if (all.every((k) => k === 'numeric-text' || k === 'number')) return { name, type: 'number' };
    if (all.every((k) => k === 'boolean-text' || k === 'boolean')) return { name, type: 'boolean' };
    const plain = new Set(all.map((k) => (k === 'numeric-text' || k === 'boolean-text' ? 'string' : k)));
    return { name, type: plain.size === 1 ? ([...plain][0] as DatasetColumn['type']) : 'mixed' };
  });
}

export interface WorkspaceDatasetPreview {
  /** Path inside the workspace (datasets/users.csv). */
  path: string;
  /** The file under datasets/ (users.csv). */
  name: string;
  format: WorkspaceDataset['format'];
  size: number;
  modified: string;
  /** Records in the whole dataset (the rows of the query, for a database). */
  count: number;
  columns: DatasetColumn[];
  /** The first `limit` records. */
  rows: DatasetRecord[];
  /** SQLite: its tables (rows need a `query`). */
  tables?: string[];
  query?: string;
}

/**
 * The first rows of a dataset in the workspace's datasets/ folder with its columns (and their kinds of value) and how
 * many records it holds: what the app's dataset tab, `testpion datasets show` and the read_dataset MCP tool show.
 * `name` is the file under datasets/ (with or without the folder). A SQLite database lists its tables and reads
 * rows only with `query`.
 */
export async function readWorkspaceDataset(store: { root: string; path(...p: string[]): string; safePath(rel: string, base?: string): string }, name: string, opts: { limit?: number; query?: string } = {}): Promise<WorkspaceDatasetPreview> {
  const clean = String(name ?? '')
    .trim()
    .replace(/^datasets[\/]/, '');
  if (!clean) throw new ApsError('ValidationError', 'A dataset name is needed', { suggestions: ['Name a file of the datasets/ folder, e.g. users.csv (list_datasets / `testpion datasets` show them).'] });
  const file = store.safePath(clean, store.path('datasets'));
  if (!existsSync(file)) throw new ApsError('ValidationError', `No dataset datasets/${clean}`, { suggestions: ['`testpion datasets` (or the list_datasets tool) lists the datasets of the workspace.'] });
  const st = statSync(file);
  const format = formatOf({ path: file });
  const limit = Math.max(0, Math.min(Number(opts.limit ?? 200) || 200, 10_000));
  const base = { path: relative(store.root, file).split(sep).join('/'), name: clean.split('\\').join('/'), format: format === 'markdown' ? ('markdown' as const) : format, size: st.size, modified: st.mtime.toISOString() };
  if (format === 'sqlite') {
    let tables: string[] = [];
    try {
      tables = sqliteTables(file);
    } catch {
      /* unreadable database: no tables */
    }
    if (!opts.query) return { ...base, count: 0, columns: [], rows: [], tables, query: '' };
  }
  const rows: DatasetRecord[] = [];
  let count = 0;
  for await (const r of readDataset({ path: file, query: opts.query })) {
    if (count++ < limit) rows.push(r);
  }
  return { ...base, count, columns: datasetColumns(rows), rows, ...(format === 'sqlite' ? { tables: sqliteTables(file), query: opts.query } : {}) };
}
