import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ApsError } from '../errors.js';
import { generateRows, operationBodySchema, rowsToCsv, type DatasetRow } from '../runner/generate-dataset.js';
import type { WorkspaceStore } from './workspace.js';

export interface GeneratedDataset {
  /** Workspace-relative path, e.g. datasets/patients.csv. */
  path: string;
  rows: number;
  columns: string[];
  preview: DatasetRow[];
}

/**
 * Generate a dataset into the workspace's datasets/ folder: from a JSON schema (text or object), or from an operation's
 * request body in an API definition in specs/. An existing file is not overwritten unless `overwrite`.
 */
export function generateWorkspaceDataset(
  store: Pick<WorkspaceStore, 'root' | 'safePath'>,
  o: { name: string; rows: number; format?: 'csv' | 'json'; schema?: unknown; spec?: string; operation?: string; overwrite?: boolean },
): GeneratedDataset {
  let schema = o.schema;
  let doc: Record<string, unknown> | undefined;
  if (typeof schema === 'string') {
    try {
      schema = parseYaml(schema);
    } catch (e) {
      throw new ApsError('ValidationError', `The schema is not valid JSON or YAML: ${(e as Error).message}`);
    }
  }
  if (!schema) {
    if (!o.spec || !o.operation) throw new ApsError('ValidationError', 'Give a JSON schema, or an API definition and one of its operations');
    doc = parseYaml(readFileSync(store.safePath(o.spec), 'utf8')) as Record<string, unknown>;
    schema = operationBodySchema(doc, o.operation);
  }
  const format = o.format ?? 'csv';
  // a file name, never a path: the dataset stays in datasets/
  const base = o.name
    .replace(/\.(csv|json)$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/^\.+/, '')
    .trim();
  if (!base) throw new ApsError('ValidationError', 'Give the dataset a name');
  const rel = `datasets/${base}.${format}`;
  const file = store.safePath(rel);
  if (existsSync(file) && !o.overwrite) throw new ApsError('ValidationError', `${rel} already exists`, { suggestions: ['Choose another name, or overwrite it.'] });
  const rows = generateRows(schema, o.rows, { doc });
  mkdirSync(join(store.root, 'datasets'), { recursive: true });
  writeFileSync(file, format === 'csv' ? rowsToCsv(rows) : JSON.stringify(rows, null, 2) + '\n');
  return { path: rel, rows: rows.length, columns: [...new Set(rows.flatMap((r) => Object.keys(r)))], preview: rows.slice(0, 10) };
}
