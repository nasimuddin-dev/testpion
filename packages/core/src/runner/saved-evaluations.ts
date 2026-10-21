import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckConfig, TestCase } from '../model/types.js';
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { expandDataset } from './loader.js';
import type { RagJudgeSetup, RagTarget } from '@testpion/shared';
import { findRagTarget } from '../eval/rag/targets.js';
import { applyRagasCompat } from '../eval/rag/ragas-io.js';
import { datasetFormatOf, countDatasetRecords } from '@testpion/shared';
export { datasetFormatOf, countDatasetRecords };

/**
 * Saved evaluations (the app's Evaluations view, `library/evaluations.json`): a dataset × prompt × model ×
 * evaluators, runnable again by name from the app, `testpion eval run` and the run_evaluation MCP tool.
 */
export interface SavedEvaluation {
  name: string;
  type: 'llm' | 'rag';
  provider: string;
  model: string;
  temperature?: number;
  system?: string;
  prompt: string;
  format: 'text' | 'json';
  datasetFormat: 'jsonl' | 'json' | 'csv' | 'md';
  dataset: string;
  expectedField: string;
  evaluators: CheckConfig[];
  concurrency: number;
  limit?: number;
  retries: number;
  /** type `rag`: the RAG target (id or name) the questions are sent to; without one the contexts written in the dataset are scored. */
  target?: string;
  /** type `rag` with a target: the judge of the judged metrics (unset: the AI settings' large model; never a silent mock) and the run's limits. */
  judge?: Pick<RagJudgeSetup, 'provider' | 'model' | 'judges' | 'aggregate' | 'swap' | 'repeat' | 'shortCircuit' | 'shareClaims' | 'sampleShare'>;
  maxJudgeCostUsd?: number;
  maxJudgeCalls?: number;
  /** `ragas`: every metric takes the options of its Ragas name (reverse-question answer relevance, per-chunk precision, entity recall by model …). */
  compat?: 'ragas';
  /** type `rag` with a target: call it this many times per question (2 to 10) and score the mean of the calls. */
  targetRepeats?: number;
  /** type `rag`: a SQLite file inside the workspace, or a read-only PostgreSQL / MySQL connection, for the SQL metrics (datacompy-score, sql-equivalence). */
  database?: { path?: string; url?: string; connectionEnv?: string; readOnly?: boolean; /** This is a production database: a run asks once before the generated SQL touches it (the production guard). */ production?: boolean };
}

export const EVALUATIONS_LIBRARY = 'evaluations';

/** The judge of a RAG evaluation as the metrics read it: the evaluation's own choices and the run's limits. */
export function judgeSetupOf(d: Pick<SavedEvaluation, 'judge' | 'maxJudgeCostUsd' | 'maxJudgeCalls'>): RagJudgeSetup {
  return { ...(d.judge ?? {}), ...(d.maxJudgeCostUsd !== undefined ? { maxCostUsd: d.maxJudgeCostUsd } : {}), ...(d.maxJudgeCalls !== undefined ? { maxCalls: d.maxJudgeCalls } : {}) };
}

/** The test template each dataset record is expanded into. */
/** The evaluators of an evaluation as they run: Ragas' own options when `compat: ragas`, the evaluation's database for the SQL metrics. */
export function evaluatorsOf(d: Pick<SavedEvaluation, 'evaluators' | 'compat' | 'database'>): CheckConfig[] {
  const list = d.compat === 'ragas' ? applyRagasCompat(d.evaluators ?? []) : (d.evaluators ?? []);
  return withEvaluationDatabase(list, d.database);
}

/**
 * The evaluation's database given to its SQL metrics. A caller that takes evaluators from outside (an RPC from the window, a
 * tool call) strips their `database` first (`stripCallerDatabase`) and passes the database of a SAVED evaluation here.
 */
export function withEvaluationDatabase(list: CheckConfig[], database: SavedEvaluation['database']): CheckConfig[] {
  return database ? list.map((e) => (['datacompy-score', 'sql-equivalence', 'datacompy_score', 'DataCompyScore', 'sql_query_equivalence'].includes(e.type) && !e.database ? { ...e, database } : e)) : list;
}

export function evaluationTemplate(d: SavedEvaluation, target?: RagTarget): Record<string, unknown> {
  const model = { provider: d.provider, name: d.model || undefined, temperature: d.temperature };
  if (d.type === 'rag' && target) {
    const judge = judgeSetupOf(d);
    return { name: d.name, type: 'rag', target, ...(Object.keys(judge).length ? { judge } : {}), ...((d.targetRepeats ?? 1) > 1 ? { targetRepeats: d.targetRepeats } : {}), evaluators: evaluatorsOf(d) };
  }
  if (d.type === 'rag') return { name: d.name, type: 'rag', model, ...(d.prompt.includes('{{context}}') ? { prompt: d.prompt } : {}), evaluators: evaluatorsOf(d) };
  return {
    name: d.name,
    type: 'llm',
    model,
    ...(d.system ? { system: d.system } : {}),
    prompt: d.prompt,
    ...(d.format === 'json' ? { responseFormat: { type: 'json' } } : {}),
    evaluators: d.evaluators,
  };
}

export interface SavedEvaluationInfo {
  id: string;
  name: string;
  folder?: string;
  type: SavedEvaluation['type'];
  provider: string;
  model: string;
  cases: number;
  evaluators: string[];
  /** type `rag`: the RAG target it calls. */
  target?: string;
}

export function listSavedEvaluations(store: WorkspaceStore): SavedEvaluationInfo[] {
  return store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY).items.map((i) => ({
    id: i.id,
    name: i.name,
    folder: i.folder,
    type: i.data.type ?? 'llm',
    provider: i.data.provider,
    model: i.data.model,
    cases: countDatasetRecords(i.data.dataset ?? '', i.data.datasetFormat ?? 'jsonl'),
    evaluators: (i.data.evaluators ?? []).map((e) => e.type),
    ...(i.data.target ? { target: i.data.target } : {}),
  }));
}

/** A saved evaluation by id or name (case-insensitive). */
export function findSavedEvaluation(store: WorkspaceStore, ref: string): SavedEvaluation & { id: string } {
  const items = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY).items;
  const r = ref.toLowerCase();
  const it = items.find((i) => i.id === ref) ?? items.find((i) => i.name.toLowerCase() === r);
  if (!it) throw new ApsError('ConfigurationError', `No saved evaluation "${ref}". Saved: ${items.map((i) => i.name).join(', ') || 'none'}`, { suggestions: ['Save one in the app (Evaluations ▸ Save), or list them with `testpion eval list`.'] });
  return { ...it.data, name: it.name, id: it.id };
}

/**
 * The test cases of an evaluation (one per dataset record). The dataset text goes to a temporary file
 * that is removed when the generator finishes, so nothing is written to the workspace.
 */
export async function* evaluationTests(d: SavedEvaluation, o: { store?: WorkspaceStore } = {}): AsyncGenerator<TestCase> {
  // the RAG target is read when the run starts (a later edit of it never changes a run in progress)
  let target: RagTarget | undefined;
  if (d.type === 'rag' && d.target) {
    if (!o.store) throw new ApsError('ConfigurationError', `The evaluation "${d.name}" calls the RAG target "${d.target}": open it from a workspace`);
    const { id: _id, name: _name, ...t } = findRagTarget(o.store, d.target);
    target = t;
  }
  const dir = mkdtempSync(join(tmpdir(), 'testpion-eval-'));
  try {
    const format = datasetFormatOf(d.dataset ?? '', d.datasetFormat);
    const file = join(dir, `dataset.${format}`);
    writeFileSync(file, d.dataset ?? '');
    const template = {
      ...evaluationTemplate(d, target),
      dataset: { path: file, format: format === 'md' ? 'markdown' : format, limit: d.limit, expectedField: d.expectedField || 'expected' },
    };
    yield* expandDataset(template, join(dir, 'evaluation'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
