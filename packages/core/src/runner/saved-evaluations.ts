import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckConfig, MockTool, TestCase } from '../model/types.js';
import { ApsError } from '../errors.js';
import { removeScratchDir } from '../storage/fsutil.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { expandDataset } from './loader.js';
import type { RagJudgeSetup, RagTarget } from '@testpion/shared';
import { findRagTarget } from '../eval/rag/targets.js';
import { applyRagasCompat } from '../eval/rag/ragas-io.js';
import { datasetFormatOf, countDatasetRecords, datasetHealth } from '@testpion/shared';
export { datasetFormatOf, countDatasetRecords };

/**
 * Saved evaluations (the app's Evaluations view, `library/evaluations.json`): a dataset × prompt × model ×
 * evaluators, runnable again by name from the app, `testpion eval run` and the run_evaluation MCP tool.
 */
export interface SavedEvaluation {
  name: string;
  type: 'llm' | 'rag' | 'agent';
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
  /** A prompt evaluation: stop the run once it has cost this much (USD). Unset: $1.00 for a paid model, none for the offline demo model or a model on this computer; 0: no cap. */
  maxCostUsd?: number;
  /** The report says whether this share of the cases passed (percent, 1 to 100): "Pass line 80%: met". */
  passLine?: number;
  /** Compare mode: other versions of this evaluation to run on the same cases, each another prompt version, another model, or both. The evaluation itself is the first variant, "Current". */
  variants?: EvalVariant[];
  /** type `agent`: tools the agent may call, answered with a fixed result (`{{args.x}}` is filled from the call). */
  tools?: MockTool[];
  /** type `agent`: MCP servers (names) whose tools the agent may call. */
  mcpServers?: string[];
  /** type `agent`: the most steps (model calls) the agent may take. */
  maxSteps?: number;
  /** Versions of the prompt and system prompt (A-4): named snapshots, each tied to the runs made with it by the hash of what it sent (`prompt:<hash>` on the cases). The evaluation's own `prompt` is the one in use. */
  promptVersions?: PromptVersion[];
  /** type `agent`: the run whose tools are the golden trajectory; the report and `eval trajectory` say how a later run's tools differ from it. */
  baselineRun?: string;
  /** type `rag`: the RAG target (id or name) the questions are sent to; without one the contexts written in the dataset are scored. */
  target?: string;
  /** type `rag` with a target: the judge of the judged metrics (unset: the AI settings' large model; never a silent mock) and the run's limits. */
  judge?: Pick<RagJudgeSetup, 'provider' | 'model' | 'judges' | 'aggregate' | 'swap' | 'repeat' | 'shortCircuit' | 'shareClaims' | 'sampleShare'>;
  maxJudgeCostUsd?: number;
  maxJudgeCalls?: number;
  /** type `rag`: the gates of the evaluation, metric -> the lowest mean it may have in a run. `testpion rag run`, a monitor of the evaluation and the CI step fail a run under one (a `--min` flag or the monitor's own gates win for the same metric). */
  gates?: Record<string, number>;
  /** `ragas`: every metric takes the options of its Ragas name (reverse-question answer relevance, per-chunk precision, entity recall by model …). */
  compat?: 'ragas';
  /** type `rag` with a target: call it this many times per question (2 to 10) and score the mean of the calls. */
  targetRepeats?: number;
  /** type `rag`: a SQLite file inside the workspace, or a read-only PostgreSQL / MySQL connection, for the SQL metrics (datacompy-score, sql-equivalence). */
  database?: { path?: string; url?: string; connectionEnv?: string; readOnly?: boolean; /** This is a production database: a run asks once before the generated SQL touches it (the production guard). */ production?: boolean };
}

/** 12 hex characters of an evaluation's prompt and system prompt (whitespace at the ends does not count): what ties a run to a prompt version. */
export function promptHashOf(d: Pick<SavedEvaluation, 'prompt' | 'system'>): string {
  return createHash('sha256').update(`${(d.prompt ?? '').trim()}\u0000${(d.system ?? '').trim()}`).digest('hex').slice(0, 12);
}

/** A named snapshot of an evaluation's prompt and system prompt. */
export interface PromptVersion {
  /** The hash of the prompt and system prompt (see `promptHashOf`). */
  id: string;
  name: string;
  prompt: string;
  system?: string;
  at: string;
  note?: string;
}

/** One variant of an evaluation in compare mode: what differs from the evaluation itself. */
export interface EvalVariant {
  /** Shown in the comparison ("Shorter prompt", "Haiku"). */
  label: string;
  provider?: string;
  model?: string;
  /** Another prompt version (the evaluation's own prompt when unset). */
  prompt?: string;
  system?: string;
  temperature?: number;
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
  // an agent: the case's `input` column is the task; its should_call / should_not_call columns become tool checks (runner/loader.ts)
  if (d.type === 'agent') {
    return {
      name: d.name,
      type: 'agent',
      model,
      ...(d.system ? { system: d.system } : {}),
      input: d.prompt,
      ...(d.tools?.length ? { tools: d.tools } : {}),
      ...(d.mcpServers?.length ? { mcpServers: d.mcpServers } : {}),
      ...(d.maxSteps ? { maxSteps: d.maxSteps } : {}),
      evaluators: d.evaluators,
    };
  }
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

interface SavedEvaluationInfo {
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
  /** What is off about its test cases (duplicates, missing expected answers, a skewed answer set …), in words; absent when they look healthy. */
  notes?: string[];
}

export function listSavedEvaluations(store: WorkspaceStore): SavedEvaluationInfo[] {
  return store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY).items.map((i) => {
    // a bot with sources reads its questions from the dataset too; only the first cases are looked at here (a list is asked for often)
    const notes = datasetHealth({ dataset: i.data.dataset ?? '', datasetFormat: i.data.datasetFormat ?? 'jsonl', expectedField: i.data.expectedField, prompt: i.data.type === 'rag' ? '' : i.data.prompt, rag: i.data.type === 'rag', evaluators: i.data.type === 'rag' ? [] : (i.data.evaluators as unknown as Array<Record<string, unknown>>) }, 500).notes.filter((n) => n.kind !== 'empty');
    return {
      id: i.id,
      name: i.name,
      folder: i.folder,
      type: i.data.type ?? 'llm',
      provider: i.data.provider,
      model: i.data.model,
      cases: countDatasetRecords(i.data.dataset ?? '', i.data.datasetFormat ?? 'jsonl'),
      evaluators: (i.data.evaluators ?? []).map((e) => e.type),
      ...(i.data.target ? { target: i.data.target } : {}),
      ...(notes.length ? { notes: notes.map((n) => n.text) } : {}),
    };
  });
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
    const { id, name: _name, ...t } = findRagTarget(o.store, d.target);
    target = { ...t, ref: id };
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
    // every case says which prompt it was sent with, so a run is tied to a prompt version by what it ran (runner/prompt-versions.ts)
    const tag = `prompt:${promptHashOf(d)}`;
    for await (const t of expandDataset(template, join(dir, 'evaluation'))) yield d.type === 'rag' ? t : { ...t, tags: [...(t.tags ?? []), tag] };
  } finally {
    removeScratchDir(dir);
  }
}
