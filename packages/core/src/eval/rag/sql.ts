/**
 * Comparing the results of two SQL queries (planning/rag-testing.md §4k; Ragas' DataCompyScore): the values are normalised
 * (numbers and numeric text, dates, NULL, trimmed text), rows are compared as multisets (or in order), columns by name or by
 * position. Precision = matching rows / response rows, recall = matching rows / reference rows; `mode: columns` does the same
 * with columns. No model, no database: the executor (runner/sql-exec.ts) produces the result sets this compares.
 */
import { csvRecords } from '@testpion/shared';
import { tryParseJson } from '../../util/jsonpath.js';

export interface ResultSet {
  columns: string[];
  rows: unknown[][];
}

/** A SQL query in an answer: the first ```sql fence, else the whole text without a trailing semicolon. */
export function sqlOf(answer: string): string {
  const fence = /```(?:sql|sqlite|postgresql|postgres|mysql)?\s*\n([\s\S]*?)```/i.exec(answer);
  return (fence ? fence[1]! : answer).trim();
}

/** A result set written as CSV (a header line) or JSON (a list of objects, or of lists). */
export function parseResultText(text: string): ResultSet {
  const t = text.trim();
  const j = /^[[{]/.test(t) ? tryParseJson(t) : ({ ok: false } as const);
  if (j.ok) {
    const v = Array.isArray(j.value) ? j.value : Array.isArray((j.value as { rows?: unknown }).rows) ? ((j.value as { rows: unknown[] }).rows) : undefined;
    if (v) {
      if (v.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
        const columns = [...new Set(v.flatMap((r) => Object.keys(r as object)))];
        return { columns, rows: v.map((r) => columns.map((c) => (r as Record<string, unknown>)[c])) };
      }
      if (v.every(Array.isArray)) {
        const [head, ...rest] = v as unknown[][];
        return { columns: (head ?? []).map(String), rows: rest };
      }
    }
  }
  const [head, ...rest] = csvRecords(t.replace(/^﻿/, ''));
  return { columns: (head ?? []).map((c) => c.trim()), rows: rest };
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[-+]\d{2}:?\d{2})?)?$/;

/** One cell in a form two equal values share: NULL, numbers (to the epsilon), ISO dates, booleans, trimmed text. */
export function normalizeCell(v: unknown, epsilon = 0): string {
  if (v === null || v === undefined) return 'n:';
  if (typeof v === 'boolean') return `b:${v}`;
  if (typeof v === 'number' || typeof v === 'bigint') return num(Number(v), epsilon);
  if (v instanceof Date) return `d:${v.toISOString()}`;
  const s = String(v).normalize('NFKC').trim();
  if (s === '' || /^(null|none|nan)$/i.test(s)) return 'n:';
  if (/^(true|false)$/i.test(s)) return `b:${s.toLowerCase()}`;
  if (NUMBER.test(s)) return num(Number(s), epsilon);
  if (ISO.test(s)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `d:${s}`;
    const ms = Date.parse(/[Zz]|[-+]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
    return Number.isNaN(ms) ? `s:${s}` : `d:${new Date(ms).toISOString().replace(/\.000Z$/, 'Z')}`;
  }
  return `s:${s}`;
}

function num(n: number, epsilon: number): string {
  if (!Number.isFinite(n)) return `s:${n}`;
  const r = epsilon > 0 ? Math.round(n / epsilon) * epsilon : Number(n.toPrecision(12));
  return `n:${Number(r.toPrecision(12))}`;
}

export interface CompareOptions {
  mode?: 'rows' | 'columns';
  metric?: 'f1' | 'precision' | 'recall';
  /** Rows must come in the same order (the default compares them as a multiset). */
  ordered?: boolean;
  /** Numbers closer than this are equal. */
  epsilon?: number;
  /** How the columns of the two results are paired: by name when both have the same names, else by position (`auto`). */
  columns?: 'name' | 'position' | 'auto';
}

export interface Comparison {
  precision: number;
  recall: number;
  f1: number;
  score: number;
  matching: number;
  responseCount: number;
  referenceCount: number;
  /** Reference rows (or columns) the response does not have, and response ones the reference does not have. */
  missing: string[];
  extra: string[];
  paired: 'name' | 'position' | 'none';
  note?: string;
}

const show = (cells: string[]) => cells.map((c) => c.slice(2)).join(' | ').slice(0, 200);

export function compareResults(resp: ResultSet, ref: ResultSet, o: CompareOptions = {}): Comparison {
  const eps = o.epsilon ?? 0;
  const metric = o.metric ?? 'f1';
  const names = (rs: ResultSet) => rs.columns.map((c) => c.trim().toLowerCase());
  const rn = names(resp);
  const fn = names(ref);
  const sameNames = rn.length === fn.length && [...rn].sort().join('\u0000') === [...fn].sort().join('\u0000') && new Set(rn).size === rn.length;
  const pairing = o.columns ?? 'auto';
  let paired: Comparison['paired'] = 'none';
  let order: number[] = []; // for each reference column, the response column
  if ((pairing === 'name' || pairing === 'auto') && sameNames) {
    paired = 'name';
    order = fn.map((n) => rn.indexOf(n));
  } else if ((pairing === 'position' || pairing === 'auto') && resp.columns.length === ref.columns.length) {
    paired = 'position';
    order = fn.map((_, i) => i);
  }
  const finish = (matching: number, responseCount: number, referenceCount: number, missing: string[], extra: string[], note?: string): Comparison => {
    const precision = responseCount ? matching / responseCount : 0;
    const recall = referenceCount ? matching / referenceCount : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    // two empty results are the same result
    const both = responseCount === 0 && referenceCount === 0;
    const score = both ? 1 : metric === 'precision' ? precision : metric === 'recall' ? recall : f1;
    return { precision: both ? 1 : precision, recall: both ? 1 : recall, f1: both ? 1 : f1, score, matching, responseCount, referenceCount, missing, extra, paired, ...(note ? { note } : {}) };
  };
  if (paired === 'none') {
    const note = `the columns differ (${resp.columns.join(', ') || 'none'} against ${ref.columns.join(', ') || 'none'}) and cannot be paired`;
    return finish(0, o.mode === 'columns' ? resp.columns.length : resp.rows.length, o.mode === 'columns' ? ref.columns.length : ref.rows.length, o.mode === 'columns' ? ref.columns : [], o.mode === 'columns' ? resp.columns : [], note);
  }
  if (o.mode === 'columns') {
    // a column is its name with its values in order (or as a multiset when rows are unordered)
    const colKey = (rs: ResultSet, i: number) => {
      const vals = rs.rows.map((r) => normalizeCell(r[i], eps));
      return (o.ordered ? vals : [...vals].sort()).join('\u0001');
    };
    const respKeys = order.map((i) => colKey(resp, i));
    const refKeys = ref.columns.map((_, i) => colKey(ref, i));
    const missing: string[] = [];
    let matching = 0;
    refKeys.forEach((k, i) => (k === respKeys[i] ? matching++ : missing.push(ref.columns[i]!)));
    return finish(matching, ref.columns.length, ref.columns.length, missing, missing.map((m) => `${m} (different values)`));
  }
  // rows: the response row, its cells in the reference's column order
  const respRows = resp.rows.map((r) => order.map((i) => normalizeCell(r[i], eps)));
  const refRows = ref.rows.map((r) => ref.columns.map((_, i) => normalizeCell(r[i], eps)));
  if (o.ordered) {
    let matching = 0;
    const missing: string[] = [];
    const extra: string[] = [];
    for (let i = 0; i < Math.max(respRows.length, refRows.length); i++) {
      const a = respRows[i];
      const b = refRows[i];
      if (a && b && a.join('\u0001') === b.join('\u0001')) matching++;
      else {
        if (b) missing.push(show(b));
        if (a) extra.push(show(a));
      }
    }
    return finish(matching, respRows.length, refRows.length, missing, extra);
  }
  const counts = new Map<string, number>();
  for (const r of refRows) counts.set(r.join('\u0001'), (counts.get(r.join('\u0001')) ?? 0) + 1);
  let matching = 0;
  const extra: string[] = [];
  for (const r of respRows) {
    const k = r.join('\u0001');
    const c = counts.get(k) ?? 0;
    if (c > 0) {
      counts.set(k, c - 1);
      matching++;
    } else extra.push(show(r));
  }
  const missing: string[] = [];
  for (const r of refRows) {
    const k = r.join('\u0001');
    const c = counts.get(k) ?? 0;
    if (c > 0) {
      counts.set(k, c - 1);
      missing.push(show(r));
    }
  }
  return finish(matching, respRows.length, refRows.length, missing, extra);
}
