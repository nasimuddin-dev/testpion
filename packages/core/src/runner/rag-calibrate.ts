/**
 * Judge calibration over a workspace (planning/rag-testing.md R4): labelling a run's judged results, the calibration report
 * of a run against a label set, and applying a tuned pass mark to a saved evaluation or a custom metric file. The statistics
 * are eval/rag/calibrate; this module reads the run and writes the workspace.
 */
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { readMetricFile, writeMetricFile } from '../storage/metric-files.js';
import { collectSamples, OVERALL } from '../eval/rag/calibrate/collect.js';
import { checkLabelsName, clearLabel, hash12, readLabels, recordOfResult, setLabel, transcriptText, type RagLabel } from '../eval/rag/calibrate/labels.js';
import { calibrationReport, type CalibrationReport } from '../eval/rag/calibrate/report.js';
import { resolveMetric } from '../eval/rag/metric-registry.js';
import { readRunSummary } from './run-records.js';
import { runResults, runReviews } from './run-results.js';
import { EVALUATIONS_LIBRARY, type SavedEvaluation } from './saved-evaluations.js';

/** The label set a run uses when none is named: its evaluation's name, made safe for a file name. */
export function defaultLabelsName(store: Pick<WorkspaceStore, 'runDir'>, runId: string): string {
  const name = readRunSummary(store, runId)?.name ?? runId;
  const safe = name.replace(/^monitor:\s*/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+|-+$/g, '').slice(0, 60);
  return safe || runId.replace(/[^A-Za-z0-9._-]+/g, '-');
}

export interface LabelInput {
  run: string;
  /** A result id of the run, or a dataset record id. */
  result: string;
  /** A check name or metric id, or `overall` (the whole answer). */
  metric: string;
  label: 'pass' | 'fail';
  labels?: string;
  by?: string;
  note?: string;
}

/** Record a person's verdict on one judged result: what they saw (the judge's score and identity) is kept with it. */
export async function labelResult(store: WorkspaceStore, i: LabelInput): Promise<{ labels: string; label: RagLabel }> {
  const name = checkLabelsName(i.labels ?? defaultLabelsName(store, i.run));
  for await (const r of runResults(store, i.run)) {
    if (r.id !== i.result && recordOfResult(r.id) !== i.result) continue;
    const rag = (r.metadata?.rag ?? {}) as { query?: string; sample?: { answer?: string }; record?: { turns?: Array<{ role: string; content: string }> } };
    const canon = (m: string) => resolveMetric(m)?.def.id ?? m;
    const c = i.metric === OVERALL ? undefined : r.checks.find((x) => x.name === i.metric || x.type === i.metric || canon(x.name || x.type) === canon(i.metric));
    if (i.metric !== OVERALL && !c) throw new ApsError('ValidationError', `The result ${r.id} has no metric "${i.metric}"`, { suggestions: [`Its metrics: ${r.checks.map((x) => x.name || x.type).join(', ') || 'none'}`, 'Use `overall` to label the whole answer.'] });
    const md = (c?.metadata ?? {}) as { judge?: { provider?: string; model?: string }; promptVersion?: string };
    const label = setLabel(store, name, {
      record: recordOfResult(r.id),
      metric: c ? c.name || c.type : OVERALL,
      label: i.label,
      run: i.run,
      resultId: r.id,
      questionHash: hash12(rag.query),
      answerHash: hash12(rag.sample?.answer),
      ...(rag.record?.turns?.length ? { transcriptHash: hash12(transcriptText(rag.record.turns)) } : {}),
      ...(i.by ? { by: i.by } : {}),
      ...(i.note ? { note: i.note } : {}),
      ...(c ? { judge: { provider: md.judge?.provider, model: md.judge?.model, promptVersion: md.promptVersion, ...(typeof c.score === 'number' ? { score: c.score } : {}) } } : {}),
    });
    return { labels: name, label };
  }
  throw new ApsError('ValidationError', `Run ${i.run} has no result "${i.result}"`, { suggestions: ['`testpion rag matrix <run> --format json` lists the result ids.'] });
}

export function unlabel(store: WorkspaceStore, o: { labels: string; record: string; metric: string }): boolean {
  return clearLabel(store, o.labels, recordOfResult(o.record), o.metric);
}

export interface CalibrateInput {
  run: string;
  labels?: string;
  metrics?: string[];
  tune?: boolean;
  /** Use the good/bad reviews of the run as `overall` labels (default on). */
  reviews?: boolean;
  /** What-if pass marks by metric. */
  thresholds?: Record<string, number>;
}

export async function calibrateRun(store: WorkspaceStore, i: CalibrateInput): Promise<CalibrationReport> {
  if (!readRunSummary(store, i.run)) throw new ApsError('ValidationError', `No finished run ${i.run}`, { suggestions: ['`testpion history list` shows the runs.'] });
  const name = i.labels ?? defaultLabelsName(store, i.run);
  let labels: RagLabel[] = [];
  try {
    labels = readLabels(store, name).labels;
  } catch {
    /* no label file yet: reviews may still count */
  }
  const collected = await collectSamples(runResults(store, i.run), { labels, reviews: i.reviews === false ? undefined : runReviews(store, i.run), metrics: i.metrics, thresholds: i.thresholds });
  return calibrationReport(collected, { tune: i.tune, run: i.run, labels: name });
}

/* ------------------------------------------------------------------ applying a tuned pass mark */

const setLine = (text: string, key: string, value: string): string => {
  // the key's own line and the indented lines under it are replaced; a key that is not there is added at the end
  const re = new RegExp(`^${key}:.*(?:\\r?\\n[ \\t]+.*)*`, 'm');
  return re.test(text) ? text.replace(re, `${key}: ${value}`) : `${text.replace(/\s*$/, '')}\n${key}: ${value}\n`;
};

export interface ApplyInput {
  metric: string;
  threshold: number;
  /** The saved evaluation (id or name) whose evaluator gets the pass mark; a custom metric (`custom/<id>`) is edited in its file. */
  evaluation?: string;
  /** What to record beside it in a custom metric file: `calibration:`. */
  calibration?: { run: string; kappa?: number; tpr?: number; tnr?: number; n: number };
}

export function applyThreshold(store: WorkspaceStore, i: ApplyInput): { changed: string; threshold: number } {
  if (!(Number.isFinite(i.threshold) && i.threshold >= 0 && i.threshold <= 1e6)) throw new ApsError('ValidationError', 'The threshold is a number');
  const custom = /^custom\/(.+)$/.exec(i.metric)?.[1];
  if (custom) {
    const f = readMetricFile(store, custom);
    if (!f) throw new ApsError('ConfigurationError', `No metric file metrics/${custom}.yaml`);
    let text = setLine(f.text, 'threshold', String(i.threshold));
    if (i.calibration) {
      const c = i.calibration;
      const flow = `{ reviewedRun: ${JSON.stringify(c.run)}, n: ${c.n}${c.kappa !== undefined ? `, kappa: ${c.kappa}` : ''}${c.tpr !== undefined ? `, tpr: ${c.tpr}` : ''}${c.tnr !== undefined ? `, tnr: ${c.tnr}` : ''}, at: ${JSON.stringify(new Date().toISOString().slice(0, 10))} }`;
      text = setLine(text, 'calibration', flow);
    }
    writeMetricFile(store, custom, text);
    return { changed: `metrics/${custom}.yaml`, threshold: i.threshold };
  }
  if (!i.evaluation) throw new ApsError('ValidationError', 'Name the saved evaluation whose metric gets the new pass mark (--evaluation)');
  const lib = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY);
  const ref = i.evaluation.toLowerCase();
  const item = lib.items.find((x) => x.id === i.evaluation) ?? lib.items.find((x) => x.name.toLowerCase() === ref);
  if (!item) throw new ApsError('ConfigurationError', `No saved evaluation "${i.evaluation}"`);
  const canon = (m: string) => resolveMetric(m)?.def.id ?? m;
  let hits = 0;
  const evaluators = (item.data.evaluators ?? []).map((e) => {
    if (e.name === i.metric || canon(e.name || e.type) === canon(i.metric)) {
      hits++;
      return { ...e, threshold: i.threshold };
    }
    return e;
  });
  if (!hits) throw new ApsError('ValidationError', `The evaluation "${item.name}" has no evaluator for ${i.metric}`, { suggestions: [`Its evaluators: ${(item.data.evaluators ?? []).map((e) => e.name || e.type).join(', ') || 'none'}`] });
  store.saveLibrary(EVALUATIONS_LIBRARY, { folders: lib.folders, items: lib.items.map((x) => (x === item ? { ...x, data: { ...x.data, evaluators }, updatedAt: new Date().toISOString() } : x)) });
  return { changed: `evaluation ${item.name}`, threshold: i.threshold };
}

