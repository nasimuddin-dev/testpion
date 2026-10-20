/**
 * Re-scoring a finished RAG run (`testpion rag rescore`, MCP `rag_rescore`, the matrix's "Score again"): the answers and
 * retrieved contexts the run captured are scored with other metrics or another judge, and the result is a NEW run. The RAG
 * system is not called, so comparing two judges or adding a metric costs the judging only, and a "two-phase" run (collect
 * the answers with the free metrics first, then judge them) is a run followed by a rescore.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RagJudgeSetup } from '@testpion/shared';
import type { CheckConfig, RunSummary, TestResult } from '../model/types.js';
import { ApsError } from '../errors.js';
import type { ProviderRegistry } from '../ai/index.js';
import { contextOfSample, type TrySample } from '../eval/rag/try-metric.js';
import { scoreRagSample } from '../eval/rag/score.js';
import type { RagJudgeHost } from '../eval/rag/judge.js';
import { shortId } from '../util/ids.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { ReportFormat } from '../report/reports.js';
import { recordRun, readRunSummary } from './run-records.js';
import { RunAggregator } from './runner.js';
import { runResults } from './run-results.js';

/** What a result captured: the sample its metrics were computed from. */
export function storedSample(r: TestResult): (TrySample & { warnings?: string[] }) | undefined {
  const rag = r.metadata?.rag as { query?: string; reference?: string; referenceIds?: string[]; referenceContexts?: string[]; record?: TrySample['record']; sample?: { answer?: string; contexts?: Array<{ id: string; text: string; score?: number }> }; warnings?: string[] } | undefined;
  if (!rag?.sample || typeof rag.sample.answer !== 'string') return undefined;
  return { question: rag.query, answer: rag.sample.answer, contexts: rag.sample.contexts, reference: rag.reference, referenceIds: rag.referenceIds, referenceContexts: rag.referenceContexts, record: rag.record, latencyMs: r.latencyMs, warnings: rag.warnings };
}

/** The metrics a run was scored with, as checks (the distinct check names of its results, with their defaults). */
export async function metricsOfRun(store: Pick<WorkspaceStore, 'runDir'>, runId: string): Promise<string[]> {
  const names = new Set<string>();
  for await (const r of runResults(store, runId)) for (const c of r.checks) names.add(c.name || c.type);
  return [...names];
}

export interface RescoreOptions {
  runId: string;
  /** The metrics to score with (check configs); default: the ones the run had, with their defaults. */
  evaluators?: CheckConfig[];
  judge?: RagJudgeSetup;
  providers?: ProviderRegistry;
  ragJudge: RagJudgeHost;
  signal?: AbortSignal;
  /** Parallel samples (the judge's own limits apply on top). */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  /** Report files to write beside the new run (junit, html …). */
  reports?: ReportFormat[];
  /** The new run's name (default: the old one's, re-scored). */
  name?: string;
}

export async function rescoreRun(store: WorkspaceStore, o: RescoreOptions): Promise<{ runId: string; summary: RunSummary; rescored: number; skipped: number; reports: Partial<Record<ReportFormat, string>> }> {
  const before = readRunSummary(store, o.runId);
  if (!before) throw new ApsError('ValidationError', `No finished run ${o.runId}`, { suggestions: ['List runs with `testpion history list`.'] });
  const evaluators = o.evaluators ?? (await metricsOfRun(store, o.runId)).map((type) => ({ type }));
  if (!evaluators.length) throw new ApsError('ValidationError', `The run ${o.runId} has no metrics to re-score; name them (--metrics a,b or --preset <name>)`);
  const runId = shortId('run-');
  const dir = store.runDir(runId);
  mkdirSync(dir, { recursive: true });
  const agg = new RunAggregator();
  const lines: string[] = [];
  const startedAt = new Date().toISOString();
  let rescored = 0;
  let skipped = 0;
  const all: TestResult[] = [];
  for await (const r of runResults(store, o.runId)) all.push(r);
  let next = 0;
  let done = 0;
  const out = new Array<TestResult>(all.length);
  const worker = async () => {
    for (;;) {
      if (o.signal?.aborted) return;
      const i = next++;
      if (i >= all.length) return;
      const r = all[i]!;
      const sample = storedSample(r);
      // a sample the system never answered (an error, no mapping) has nothing to score
      if (!sample || r.status === 'error') {
        skipped++;
        out[i] = r;
      } else {
        const ctx = contextOfSample(sample, { judge: o.judge, providers: o.providers, ragJudge: o.ragJudge, signal: o.signal });
        ctx.tokens = r.tokens;
        ctx.costUsd = r.costUsd;
        const { checks, failure } = await scoreRagSample(evaluators, ctx, { warnings: sample.warnings });
        const rag = { ...((r.metadata?.rag as Record<string, unknown>) ?? {}) };
        delete rag.failure;
        out[i] = {
          ...r,
          checks,
          status: checks.some((c) => !c.passed) ? 'failed' : 'passed',
          metadata: { ...r.metadata, rag: { ...rag, ...(failure ? { failure } : {}) }, rescoredFrom: o.runId },
        };
        rescored++;
      }
      o.onProgress?.(++done, all.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 4, 16)) }, worker));
  for (const r of out) {
    if (!r) continue;
    agg.add(r);
    lines.push(JSON.stringify(r));
  }
  writeFileSync(join(dir, 'results.jsonl'), lines.map((l) => l + '\n').join(''));
  const summary = agg.summary({ runId, name: o.name ?? `${before.name} (re-scored)`, startedAt, cancelled: !!o.signal?.aborted, environment: before.environment, reproducibility: { ...before.reproducibility, rescoredFrom: o.runId } });
  const reports = await recordRun(store, summary, dir, { reports: o.reports });
  return { runId, summary, rescored, skipped, reports };
}
