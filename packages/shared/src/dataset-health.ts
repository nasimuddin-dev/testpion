import { cellText, datasetRecords, type CaseRow } from './dataset-table.js';
import { plural } from './format.js';
import type { DatasetTextFormat } from './datasets.js';

/**
 * The health of an evaluation's test cases: what makes an evaluation measure less than it seems. Pure, so the window (under the case
 * table), `testpion eval lint` and the MCP tools say the same words.
 *
 *  - `empty`: no cases.
 *  - `duplicates`: the same input twice (a case that counts double).
 *  - `no-expected`: cases without the expected answer a check compares with.
 *  - `missing-column`: a `{{variable}}` of the prompt that some case has no value for (the model is sent the braces).
 *  - `skewed`: most cases expect the same answer, so a model that always says it already passes.
 *  - `long`: very long inputs (cost and truncation).
 */
export type DatasetNoteKind = 'empty' | 'duplicates' | 'no-expected' | 'missing-column' | 'skewed' | 'long';

export interface DatasetNote {
  kind: DatasetNoteKind;
  /** One sentence for people. */
  text: string;
  /** The case numbers (1-based) it is about, at most 10. */
  cases?: number[];
}

export interface DatasetHealth {
  cases: number;
  notes: DatasetNote[];
  /** "2 things to look at in 12 cases: …" or "12 cases look healthy." */
  text: string;
}

export interface DatasetHealthInput {
  dataset: string;
  datasetFormat: DatasetTextFormat;
  /** The field the checks compare with (default `expected`). */
  expectedField?: string;
  prompt?: string;
  /** The checks: only whether any reads `{{expected}}` or an expected value matters here. */
  evaluators?: Array<Record<string, unknown>>;
}

const LONG_CHARS = 8000;
const MIN_FOR_SKEW = 5;
const SKEW_SHARE = 0.8;

const filled = (v: unknown) => v !== undefined && v !== null && cellText(v).trim() !== '';

/** The input of a case: the field named `input`, else the first field. */
const inputOf = (r: CaseRow) => (r.input !== undefined ? cellText(r.input) : cellText(Object.values(r)[0]));

/** Reads at most `limit` cases (default 5000): a longer dataset is checked on its first cases, which is said. */
export function datasetHealth(i: DatasetHealthInput, limit = 5000): DatasetHealth {
  const rows = datasetRecords(i.dataset, i.datasetFormat, limit);
  const notes: DatasetNote[] = [];
  if (!rows.length) {
    return { cases: 0, notes: [{ kind: 'empty', text: 'There are no test cases yet.' }], text: 'There are no test cases yet.' };
  }
  const first = (pred: (r: CaseRow, n: number) => boolean) => rows.flatMap((r, n) => (pred(r, n) ? [n + 1] : []));
  const expectedField = i.expectedField?.trim() || 'expected';

  // the same input twice
  const seen = new Map<string, number>();
  const dup: number[] = [];
  rows.forEach((r, n) => {
    const key = inputOf(r).trim().toLowerCase();
    if (!key) return;
    if (seen.has(key)) dup.push(n + 1);
    else seen.set(key, n + 1);
  });
  if (dup.length) notes.push({ kind: 'duplicates', text: `${plural(dup.length, 'case')} repeat${dup.length === 1 ? 's' : ''} an input already in the list, so it counts double.`, cases: dup.slice(0, 10) });

  // checks that compare with an expected answer, and cases that have none
  const wantsExpected = (i.evaluators ?? []).some((e) => JSON.stringify(e).includes('{{expected}}') || JSON.stringify(e).includes(`{{${expectedField}}}`));
  if (wantsExpected) {
    const lacking = first((r) => !filled(r[expectedField]));
    if (lacking.length) notes.push({ kind: 'no-expected', text: `${plural(lacking.length, 'case')} ${lacking.length === 1 ? 'has' : 'have'} no "${expectedField}", which a check compares the answer with.`, cases: lacking.slice(0, 10) });
  }

  // prompt variables a case does not fill
  const vars = [...new Set([...(i.prompt ?? '').matchAll(/\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g)].map((m) => m[1]!))];
  for (const v of vars) {
    const lacking = first((r) => !filled(r[v]));
    if (lacking.length) notes.push({ kind: 'missing-column', text: `The prompt uses {{${v}}}, and ${plural(lacking.length, 'case')} ${lacking.length === 1 ? 'has' : 'have'} no "${v}".`, cases: lacking.slice(0, 10) });
  }

  // most cases expect the same answer
  if (rows.length >= MIN_FOR_SKEW) {
    const counts = new Map<string, number>();
    for (const r of rows) if (filled(r[expectedField])) counts.set(cellText(r[expectedField]).trim().toLowerCase(), (counts.get(cellText(r[expectedField]).trim().toLowerCase()) ?? 0) + 1);
    const answered = [...counts.values()].reduce((a, b) => a + b, 0);
    const top = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (top && counts.size > 1 && answered >= MIN_FOR_SKEW && top[1] / answered >= SKEW_SHARE && top[0].length <= 40) {
      notes.push({ kind: 'skewed', text: `${top[1]} of ${answered} cases expect "${top[0]}": a model that always says that already passes ${Math.round((top[1] / answered) * 100)}%. Add cases for the other answers.` });
    }
  }

  // very long inputs
  const long = first((r) => inputOf(r).length > LONG_CHARS);
  if (long.length) notes.push({ kind: 'long', text: `${plural(long.length, 'case')} ${long.length === 1 ? 'has' : 'have'} an input over ${LONG_CHARS.toLocaleString('en-US')} characters: it costs more and a model may cut it.`, cases: long.slice(0, 10) });

  const checked = rows.length >= limit ? ` (the first ${limit.toLocaleString('en-US')} checked)` : '';
  const text = notes.length ? `${plural(notes.length, 'thing')} to look at in ${plural(rows.length, 'case')}${checked}: ${notes.map((n) => n.text).join(' ')}` : `${plural(rows.length, 'case')} look healthy${checked}.`;
  return { cases: rows.length, notes, text };
}
