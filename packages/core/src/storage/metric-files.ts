/**
 * The workspace's custom metric files, `metrics/<id>.yaml` (planning/rag-testing.md §4d): git-friendly YAML a person can
 * read, review and diff. This module only lists, reads, writes and removes files; checking and compiling them is
 * eval/rag/custom. Ids are file names, so an id is restricted to the metric id alphabet and a path can never leave the folder.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CUSTOM_METRIC_ID } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { atomicWrite, removeOwned } from './fsutil.js';
import type { WorkspaceStore } from './workspace.js';

const METRICS_DIR = 'metrics';

interface MetricFileInfo {
  id: string;
  /** Relative to the workspace: `metrics/<id>.yaml`. */
  path: string;
  text: string;
  modifiedAt: string;
}

type Dir = Pick<WorkspaceStore, 'path'>;

const fileOf = (store: Dir, id: string) => store.path(METRICS_DIR, `${id}.yaml`);

function checkId(id: string): void {
  if (!CUSTOM_METRIC_ID.test(id)) throw new ApsError('ValidationError', `"${id}" is not a metric id: lower-case letters, digits and hyphens (up to 63), starting with a letter or digit`);
}

/** Every `*.yaml` / `*.yml` file of the folder, by id (the file name without its extension). A file larger than 128 KB is listed with an empty text (the check says why). */
export function listMetricFiles(store: Dir): MetricFileInfo[] {
  const dir = store.path(METRICS_DIR);
  if (!existsSync(dir)) return [];
  const out: MetricFileInfo[] = [];
  for (const name of readdirSync(dir).sort()) {
    const m = /^(.+)\.ya?ml$/i.exec(name);
    if (!m || m[1] === 'presets') continue;
    const file = join(dir, name);
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      out.push({ id: m[1]!, path: `${METRICS_DIR}/${name}`, text: st.size > 256 * 1024 ? '' : readFileSync(file, 'utf8'), modifiedAt: st.mtime.toISOString() });
    } catch {
      /* a file that vanished while listing */
    }
  }
  return out;
}

/**
 * A fingerprint of the folder: every metric file's name, size and modification time (to the nanosecond), without reading a
 * file. It is the same string for the same folder, so a host that has registered these files already can skip reading them
 * again (every request send, run and estimate asks the engine for a context, which syncs the metrics).
 */
export function metricFilesStamp(store: Dir): string {
  const dir = store.path(METRICS_DIR);
  if (!existsSync(dir)) return '';
  const parts: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const m = /^(.+)\.ya?ml$/i.exec(name);
    if (!m || m[1] === 'presets') continue;
    try {
      const st = statSync(join(dir, name), { bigint: true });
      if (st.isFile()) parts.push(`${name}:${st.size}:${st.mtimeNs}`);
    } catch {
      /* a file that vanished while listing */
    }
  }
  return parts.join('|');
}

export function readMetricFile(store: Dir, id: string): MetricFileInfo | undefined {
  checkId(id);
  const file = fileOf(store, id);
  if (!existsSync(file)) return undefined;
  const st = statSync(file);
  return { id, path: `${METRICS_DIR}/${id}.yaml`, text: readFileSync(file, 'utf8'), modifiedAt: st.mtime.toISOString() };
}

export function writeMetricFile(store: Dir, id: string, text: string): MetricFileInfo {
  checkId(id);
  mkdirSync(store.path(METRICS_DIR), { recursive: true });
  atomicWrite(fileOf(store, id), text.endsWith('\n') ? text : `${text}\n`);
  return readMetricFile(store, id)!;
}

/** Removes the file (it is in git: the history has it). Returns false when there was none. */
export function removeMetricFile(store: Dir, id: string): boolean {
  checkId(id);
  const file = fileOf(store, id);
  if (!existsSync(file)) return false;
  removeOwned(file);
  return true;
}
