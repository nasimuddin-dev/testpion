/**
 * Writing CSV / TSV for the output exports (RFC 4180: CRLF line ends, a field quoted when it holds the separator, a
 * quote, CR or LF, or a leading / trailing space; inner quotes doubled) with the CSV-injection guard of OWASP: a cell a
 * spreadsheet would run as a formula (it starts with = + - @, Tab, CR or LF, or their full-width forms) gets a leading
 * apostrophe and is quoted. A cell that is a plain number (-12.5) is kept as a number, so the data stays usable.
 */

const RISKY = /^[=+\-@\t\r\n＝＋－＠]/;
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** A cell as text: null / undefined empty, objects as JSON, dates as ISO. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v);
  }
}

/** The injection guard alone: the cell with a leading apostrophe when a spreadsheet would read it as a formula. */
export function guardCsvCell(s: string): string {
  if (!s || NUMBER.test(s)) return s;
  // a first-character check is not enough: a quote or a separator of another locale (; or tab) inside the value can open a new cell
  if (RISKY.test(s) || INNER.test(s)) return `'${s}`;
  return s;
}
const INNER = /[",;\t|]\s*([=+@＝＋＠]|[-－](?![\d.\s]))/;

/** One field, guarded and quoted as needed. */
export function csvField(v: unknown, delimiter = ',', guard = true): string {
  const raw = cellText(v);
  const s = guard ? guardCsvCell(raw) : raw;
  const quote = s !== raw || s.includes(delimiter) || /["\r\n]/.test(s) || /^\s|\s$/.test(s);
  return quote ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface CsvOptions {
  /** ',' (CSV, the default) or '\t' (TSV). */
  delimiter?: string;
  /** Start with a UTF-8 byte-order mark, so Excel reads the file as UTF-8 ("CSV for Excel"). */
  bom?: boolean;
  /** The injection guard (default on). */
  guard?: boolean;
}

/** Rows (the first one usually the header) as CSV text, CRLF after every row. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<unknown>>, opts: CsvOptions = {}): string {
  const d = opts.delimiter ?? ',';
  const body = rows.map((r) => r.map((c) => csvField(c, d, opts.guard !== false)).join(d)).join('\r\n');
  return (opts.bom ? '﻿' : '') + body + (rows.length ? '\r\n' : '');
}

/** Objects as a table: the columns are every key, in the order first seen; nested values become JSON. */
export function rowsFromObjects(objects: ReadonlyArray<unknown>, columns?: string[]): { columns: string[]; rows: unknown[][] } {
  const cols = columns ?? [];
  if (!columns) {
    const seen = new Set<string>();
    for (const o of objects)
      if (o && typeof o === 'object' && !Array.isArray(o))
        for (const k of Object.keys(o))
          if (!seen.has(k)) {
            seen.add(k);
            cols.push(k);
          }
    if (!cols.length) cols.push('value');
  }
  const rows = objects.map((o) => (o && typeof o === 'object' && !Array.isArray(o) ? cols.map((c) => (o as Record<string, unknown>)[c]) : [o]));
  return { columns: cols, rows };
}

/** Objects as CSV (header row first). */
export function objectsToCsv(objects: ReadonlyArray<unknown>, opts: CsvOptions & { columns?: string[] } = {}): string {
  const t = rowsFromObjects(objects, opts.columns);
  return toCsv([t.columns, ...t.rows], opts);
}
