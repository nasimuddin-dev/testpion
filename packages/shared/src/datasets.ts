import { csvRecords } from './csv.js';

/** The formats a dataset is written in (a file in datasets/, or the text pasted into an evaluation). */
export type DatasetTextFormat = 'jsonl' | 'json' | 'csv' | 'md';

/** The format a dataset file's extension says (tsv is CSV with tabs, ndjson is JSONL); undefined for other files. */
export function datasetFormatOfName(name: string): DatasetTextFormat | undefined {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext === 'ndjson' || ext === 'jsonl' ? 'jsonl' : ext === 'tsv' || ext === 'csv' ? 'csv' : ext === 'json' ? 'json' : ext === 'md' ? 'md' : undefined;
}

/**
 * The format a dataset text really has: "json" whose text is one JSON object per line is JSONL
 * (a common slip when the format was switched after pasting records).
 */
export function datasetFormatOf(text: string, fmt: DatasetTextFormat): DatasetTextFormat {
  if (fmt !== 'json') return fmt;
  try {
    JSON.parse(text);
    return 'json';
  } catch {
    const lines = text.split('\n').filter((l) => l.trim());
    try {
      return lines.length && lines.every((l) => typeof JSON.parse(l) === 'object') ? 'jsonl' : 'json';
    } catch {
      return 'json';
    }
  }
}

/** Number of records in a dataset text (for listings). */
export function countDatasetRecords(text: string, format: DatasetTextFormat): number {
  const fmt = datasetFormatOf(text, format);
  const lines = text.split('\n').filter((l) => l.trim());
  if (fmt === 'jsonl') return lines.length;
  if (fmt === 'csv') return Math.max(0, csvRecords(text).length - 1);
  if (fmt === 'md') return Math.max(0, lines.filter((l) => l.trim().startsWith('|')).length - 2);
  try {
    const d = JSON.parse(text);
    return Array.isArray(d) ? d.length : 1;
  } catch {
    return 0;
  }
}

/** The first records of a dataset text, as objects (a preview; Markdown tables are not read here). */
export function previewDatasetRecords(text: string, format: DatasetTextFormat, limit = 5): Array<Record<string, unknown>> {
  const fmt = datasetFormatOf(text, format);
  try {
    if (fmt === 'jsonl')
      return text
        .split('\n')
        .filter((l) => l.trim())
        .slice(0, limit)
        .map((l) => JSON.parse(l));
    if (fmt === 'json') {
      const d = JSON.parse(text);
      return (Array.isArray(d) ? d : [d]).slice(0, limit);
    }
    if (fmt === 'csv') {
      const [h, ...rows] = csvRecords(text);
      const keys = (h ?? []).map((s) => s.trim());
      return rows.slice(0, limit).map((r) => Object.fromEntries(r.map((v, i) => [keys[i], v])));
    }
  } catch {
    /* not parseable yet: nothing to preview */
  }
  return [];
}

/** The first fenced code block of a model's answer (optionally of one of `langs`), or the whole text without fences. */
export function extractCodeBlock(text: string, langs: string[] = []): string {
  const fences = [...text.matchAll(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g)];
  const wanted = fences.find((m) => langs.includes((m[1] ?? '').toLowerCase())) ?? fences[0];
  return (wanted ? wanted[2]! : text).trim();
}
