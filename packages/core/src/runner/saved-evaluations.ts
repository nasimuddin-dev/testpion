import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckConfig, TestCase } from '../model/types.js';
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { expandDataset } from './loader.js';
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
}

export const EVALUATIONS_LIBRARY = 'evaluations';

/** The test template each dataset record is expanded into. */
export function evaluationTemplate(d: SavedEvaluation): Record<string, unknown> {
  const model = { provider: d.provider, name: d.model || undefined, temperature: d.temperature };
  if (d.type === 'rag') return { name: d.name, type: 'rag', model, ...(d.prompt.includes('{{context}}') ? { prompt: d.prompt } : {}), evaluators: d.evaluators };
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
export async function* evaluationTests(d: SavedEvaluation): AsyncGenerator<TestCase> {
  const dir = mkdtempSync(join(tmpdir(), 'testpion-eval-'));
  try {
    const format = datasetFormatOf(d.dataset ?? '', d.datasetFormat);
    const file = join(dir, `dataset.${format}`);
    writeFileSync(file, d.dataset ?? '');
    const template = {
      ...evaluationTemplate(d),
      dataset: { path: file, format: format === 'md' ? 'markdown' : format, limit: d.limit, expectedField: d.expectedField || 'expected' },
    };
    yield* expandDataset(template, join(dir, 'evaluation'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
