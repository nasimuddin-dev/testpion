import { csvRecords } from '@testpion/shared';

/** A table in a CSV / TSV file: its columns and its rows (each row as one line of text, for comparing). Null: not a table. */
export function csvTable(text: string, file: string): { header: string[]; rows: string[] } | null {
  try {
    const records = csvRecords(text.replace(/^﻿/, ''), /\.tsv$/i.test(file) ? '\t' : ',').filter((r) => r.length > 1 || (r[0] ?? '') !== '');
    const [header, ...rest] = records;
    return { header: header ?? [], rows: rest.map((r) => r.join('\u001f')) };
  } catch {
    return null;
  }
}
