import { csvRecords } from './csv.js';
import { datasetFormatOf, type DatasetTextFormat } from './datasets.js';

/**
 * Test cases as a table (AU-10): the records of a dataset text, the columns they have, pasted spreadsheet cells and the
 * text the table writes back. Pure functions, so the window, the engine, the CLI and the MCP tools read cases the same way.
 */
export type CaseRow = Record<string, unknown>;

/** The most rows a table holds (a larger dataset is edited as text). */
export const MAX_TABLE_ROWS = 20000;

/** Every record of a dataset text as objects (JSONL, JSON, CSV or a Markdown table); text that does not parse gives no records. */
export function datasetRecords(text: string, format: DatasetTextFormat, limit = MAX_TABLE_ROWS): CaseRow[] {
  const fmt = datasetFormatOf(text, format);
  try {
    if (fmt === 'jsonl')
      return text
        .split('\n')
        .filter((l) => l.trim())
        .slice(0, limit)
        .map((l) => asRow(JSON.parse(l)));
    if (fmt === 'json') {
      const d = JSON.parse(text);
      return (Array.isArray(d) ? d : [d]).slice(0, limit).map(asRow);
    }
    if (fmt === 'csv') return rowsOfCells(csvRecords(text, delimiterOf(text)), limit);
    if (fmt === 'md') {
      const lines = text.split('\n').filter((l) => l.trim().startsWith('|'));
      const cells = lines.map((l) =>
        l
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim()),
      );
      return rowsOfCells(
        cells.filter((r, i) => !(i === 1 && r.every((c) => /^:?-+:?$/.test(c)))),
        limit,
      );
    }
  } catch {
    /* not parseable (yet): no records */
  }
  return [];
}

const asRow = (v: unknown): CaseRow => (v && typeof v === 'object' && !Array.isArray(v) ? (v as CaseRow) : { input: v });

function delimiterOf(text: string): string {
  const head = text.split('\n', 1)[0] ?? '';
  return head.includes('\t') && !head.includes(',') ? '\t' : ',';
}

function rowsOfCells(cells: string[][], limit: number): CaseRow[] {
  const [h, ...rows] = cells;
  const keys = (h ?? []).map((s) => s.trim());
  return rows.slice(0, limit).map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
}

/** The columns of some rows, in the order they first appear. */
export function caseColumns(rows: CaseRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}

/** What a cell shows: text as it is, anything else as JSON. */
export function cellText(v: unknown): string {
  return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
}

/** A cell edited to `text`: a cell that held a number, a list or an object keeps its kind when the new text reads as that kind. */
export function cellValue(text: string, before: unknown): unknown {
  if (before === undefined || before === null || typeof before === 'string') return text;
  try {
    const v = JSON.parse(text);
    return typeof v === typeof before || (typeof v === 'object' && typeof before === 'object') ? v : text;
  } catch {
    return text;
  }
}

/** The rows as JSONL, one case per line; an empty cell is left out (no empty "expected" answer). Rows without any value are dropped. */
export function casesToJsonl(rows: CaseRow[]): string {
  const lines: string[] = [];
  for (const r of rows) {
    const o: CaseRow = {};
    for (const [k, v] of Object.entries(r)) if (k.trim() && v !== '' && v !== undefined && v !== null) o[k] = v;
    if (Object.keys(o).length) lines.push(JSON.stringify(o));
  }
  return lines.join('\n');
}

export interface PastedCases {
  format: DatasetTextFormat;
  rows: CaseRow[];
  columns: string[];
  /** The first line is not a header (a single column of inputs, or a header-less table): the columns are named input and expected. */
  headerless: boolean;
}

/**
 * Cases pasted from a spreadsheet (tab separated), a CSV file, JSONL or a JSON list. Recognised by its shape. A paste of
 * one column is a list of inputs. When no header row looks like one, the first column is `input` and the second `expected`.
 */
export function parsePastedCases(text: string): PastedCases | undefined {
  const t = text.replace(/^﻿/, '').trim();
  if (!t) return undefined;
  const asJson: DatasetTextFormat | undefined = t.startsWith('[') ? 'json' : t.startsWith('{') ? 'jsonl' : undefined;
  if (asJson) {
    const rows = datasetRecords(t, asJson);
    if (rows.length) return { format: asJson, rows, columns: caseColumns(rows), headerless: false };
  }
  const delim = t.split('\n', 1)[0]!.includes('\t') ? '\t' : ',';
  const cells = csvRecords(t, delim).filter((r) => r.some((c) => c.trim()));
  if (!cells.length) return undefined;
  const header = cells[0]!;
  const looksLikeHeader = cells.length > 1 && header.every((c) => /^[A-Za-z_][\w.-]{0,40}$/.test(c.trim()) || /^expected (answer|output)$/i.test(c.trim())) && new Set(header.map((c) => c.trim().toLowerCase())).size === header.length && cells.length > 1 && header.length === Math.max(...cells.map((r) => r.length));
  if (looksLikeHeader) {
    const rows = rowsOfCells(cells, MAX_TABLE_ROWS);
    return { format: 'csv', rows, columns: header.map((c) => c.trim()), headerless: false };
  }
  const names = cells[0]!.length === 1 ? ['input'] : ['input', 'expected', ...Array.from({ length: Math.max(0, cells[0]!.length - 2) }, (_, i) => `column${i + 3}`)];
  const rows = cells.slice(0, MAX_TABLE_ROWS).map((r) => Object.fromEntries(names.map((k, i) => [k, r[i] ?? ''])));
  return { format: 'csv', rows, columns: names, headerless: true };
}

/** A mapping of the columns a table has to the names the evaluation reads (`{ prompt: 'input', answer: 'expected' }`); columns not named stay as they are. */
export function mapCaseColumns(rows: CaseRow[], mapping: Record<string, string>): CaseRow[] {
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [mapping[k]?.trim() || k, v])));
}

/**
 * A guess for each column: the one that holds the model's input (input, prompt, question, message, text ...) and the
 * one that holds the answer to expect (expected, answer, reference, label ...). Used by the column mapping.
 */
export function guessCaseColumns(columns: string[], expectedField = 'expected'): { input?: string; expected?: string } {
  const find = (names: string[]) => columns.find((c) => names.includes(c.trim().toLowerCase()));
  return {
    input: find(['input', 'prompt', 'question', 'message', 'text', 'query', 'user_input']),
    expected: columns.find((c) => c === expectedField) ?? find(['expected', 'expected_output', 'expected answer', 'answer', 'reference', 'ground_truth', 'label', 'output']),
  };
}
