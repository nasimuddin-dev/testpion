/**
 * Human labels of judged results (`labels/<name>.json`, a workspace file a team can review and commit). A label says: for
 * this dataset record and this metric, the answer was good (pass) or bad (fail). It is attached to the record, not to a run
 * result, so it applies to any later run of the same dataset; the hash of the answer that was labelled is kept so a run
 * whose answer changed is not scored against a label about another answer.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { ApsError } from '../../../errors.js';
import { readJson, writeJson } from '../../../storage/fsutil.js';
import type { WorkspaceStore } from '../../../storage/workspace.js';

export const LABELS_DIR = 'labels';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export interface RagLabel {
  /** The dataset record the label is about (the id after the last `:` of a result id). */
  record: string;
  metric: string;
  label: 'pass' | 'fail';
  /** The run and result it was made on (provenance). */
  run: string;
  resultId: string;
  /** sha256 (12 hex) of the question and of the answer that was labelled. */
  questionHash?: string;
  answerHash?: string;
  by?: string;
  at: string;
  note?: string;
  /** The judge that scored the sample when it was labelled (what the person saw). */
  judge?: { provider?: string; model?: string; promptVersion?: string; score?: number };
}

export interface LabelsFile {
  schemaVersion: 1;
  name: string;
  labels: RagLabel[];
}

export const hash12 = (s: string | undefined): string | undefined => (s === undefined ? undefined : createHash('sha256').update(s).digest('hex').slice(0, 12));
export const recordOfResult = (resultId: string) => resultId.slice(resultId.lastIndexOf(':') + 1);

export function checkLabelsName(name: string): string {
  const n = name.replace(/\.json$/i, '');
  if (!NAME.test(n)) throw new ApsError('ValidationError', `"${name}" is not a label set name: letters, digits, dots, hyphens and underscores`);
  return n;
}

const fileOf = (store: Pick<WorkspaceStore, 'path'>, name: string) => store.path(LABELS_DIR, `${checkLabelsName(name)}.json`);

export function readLabels(store: Pick<WorkspaceStore, 'path'>, name: string): LabelsFile {
  const doc = readJson<Partial<LabelsFile>>(fileOf(store, name), {});
  const labels = Array.isArray(doc.labels) ? doc.labels.filter((l): l is RagLabel => !!l && typeof l.record === 'string' && typeof l.metric === 'string' && (l.label === 'pass' || l.label === 'fail')) : [];
  return { schemaVersion: 1, name: checkLabelsName(name), labels };
}

export function listLabelSets(store: Pick<WorkspaceStore, 'path'>): Array<{ name: string; path: string; labels: number }> {
  const dir = store.path(LABELS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const name = f.slice(0, -5);
      let labels = 0;
      try {
        labels = readLabels(store, name).labels.length;
      } catch {
        /* a broken file is listed with 0 */
      }
      return { name, path: `${LABELS_DIR}/${f}`, labels };
    });
}

/** Add or replace the label of a record and metric (one label per pair: the newest wins). */
export function setLabel(store: Pick<WorkspaceStore, 'path'>, name: string, label: Omit<RagLabel, 'at'> & { at?: string }): RagLabel {
  const f = readLabels(store, name);
  const entry: RagLabel = { ...label, at: label.at ?? new Date().toISOString() };
  if (entry.note !== undefined) entry.note = entry.note.trim().slice(0, 1000) || undefined;
  if (!entry.note) delete entry.note;
  f.labels = [...f.labels.filter((l) => !(l.record === entry.record && l.metric === entry.metric)), entry];
  mkdirSync(store.path(LABELS_DIR), { recursive: true });
  writeJson(fileOf(store, name), f);
  return entry;
}

export function clearLabel(store: Pick<WorkspaceStore, 'path'>, name: string, record: string, metric: string): boolean {
  const f = readLabels(store, name);
  const kept = f.labels.filter((l) => !(l.record === record && l.metric === metric));
  if (kept.length === f.labels.length) return false;
  writeJson(fileOf(store, name), { ...f, labels: kept });
  return true;
}
