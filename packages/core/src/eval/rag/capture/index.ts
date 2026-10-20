/**
 * Capture a RAG dataset from real traffic: `captureDataset` reads the calls of a source (History, a Debugger session, a HAR
 * file, an evaluation run), reads question, answer and contexts out of them with a RAG target, masks personal data and
 * secrets, drops duplicates, samples, and writes `datasets/<name>.jsonl` (or, on a dry run, only reports what it would write).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { ApsError } from '../../../errors.js';
import { atomicWrite, noteOwnChange } from '../../../storage/fsutil.js';
import type { WorkspaceStore } from '../../../storage/workspace.js';
import type { Redactor } from '../../../util/redact.js';
import { stringifyRagRecords } from '../dataset-formats.js';
import { findRagTarget } from '../targets.js';
import { buildRecords } from './build.js';
import { readCalls } from './sources.js';
import type { CaptureOptions, CaptureResult } from './types.js';

export { buildRecords, makeMasker, questionKey } from './build.js';
export { describeLocator, matchesTarget, questionLocator, readQuestion } from './question-path.js';
export { callOfExchange, callOfHistory, callsOfHar, listCaptureSources, readCalls } from './sources.js';
export type { CapturedCall, CapturedRecord, CaptureOptions, CaptureReport, CaptureResult, CaptureSourceSpec, QuestionLocator } from './types.js';

/** The preview of a dry run: this many records. */
export const CAPTURE_PREVIEW = 20;

/** A dataset file name under datasets/: letters, digits, `.`, `_`, `-`; `.jsonl` is added. */
export function captureDatasetPath(store: Pick<WorkspaceStore, 'path' | 'safePath'>, name: string | undefined): { rel: string; file: string } {
  const base = basename((name ?? '').trim().replace(/\\/g, '/'))
    .replace(/\.(jsonl|ndjson)$/i, '')
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 100);
  const stem = base || `captured-${new Date().toISOString().slice(0, 10)}`;
  const rel = `${stem}.jsonl`;
  return { rel: `datasets/${rel}`, file: store.safePath(rel, store.path('datasets')) };
}

export async function captureDataset(store: WorkspaceStore, o: CaptureOptions, deps: { redactor?: Redactor } = {}): Promise<CaptureResult> {
  const calls = await readCalls(store, o.source);
  const target = o.target ? findRagTarget(store, o.target) : undefined;
  if (!target && calls.some((c) => !c.sample)) throw new ApsError('ValidationError', 'Name the RAG target the calls were made to (--target)', { suggestions: ['`testpion rag targets` lists them; its request says where the question is and its mapping reads the answer.'] });
  const { records, report } = buildRecords({ calls, target, options: o, redactor: deps.redactor });
  if (o.dryRun) return { report, preview: records.slice(0, CAPTURE_PREVIEW) };
  if (!records.length) throw new ApsError('ValidationError', 'No record could be made from these calls', { details: { report }, suggestions: report.skipped.slice(0, 3).map((s) => `${s.count} × ${s.reason}`) });
  const { rel, file } = captureDatasetPath(store, o.name);
  if (existsSync(file) && !o.overwrite) throw new ApsError('ValidationError', `${rel} exists already: choose another name`, { suggestions: ['Pass another --name, or --overwrite to replace it.'] });
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, stringifyRagRecords(records as unknown as Array<Record<string, unknown>>));
  noteOwnChange(file);
  return { report, preview: records.slice(0, CAPTURE_PREVIEW), written: { path: rel, rows: records.length } };
}
