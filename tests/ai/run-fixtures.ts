/** Recorded runs for the triage and flaky-analysis cases: results written as the runner writes them, then recorded. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordRun, type CheckResult, type RunSummary, type TestResult, type WorkspaceStore } from '../../packages/core/src/index.js';

const LAT = { count: 0, min: 0, max: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0 };

/** One HTTP result: the request line, the status, the body the runner keeps (output) and the checks. */
export function httpResult(o: {
  id: string;
  name?: string;
  method?: string;
  url: string;
  status: number;
  body?: unknown;
  checks?: Array<Partial<CheckResult> & { name: string; passed: boolean }>;
  file?: string;
  error?: { kind: string; message: string };
  latencyMs?: number;
  unresolved?: string[];
  attempts?: number;
}): TestResult {
  const checks = (o.checks ?? []).map((c) => ({ type: c.type ?? 'status', source: 'deterministic' as const, message: c.message ?? (c.passed ? 'ok' : 'failed'), ...c }));
  const failed = checks.some((c) => !c.passed);
  return {
    id: o.id,
    name: o.name ?? o.id,
    type: 'http',
    status: o.error ? 'error' : failed ? 'failed' : 'passed',
    ...(o.file ? { file: o.file } : {}),
    startedAt: '2026-10-16T10:00:00.000Z',
    durationMs: o.latencyMs ?? 20,
    attempts: o.attempts ?? 1,
    checks,
    ...(o.error ? { error: { kind: o.error.kind as never, message: o.error.message } } : {}),
    latencyMs: o.latencyMs ?? 20,
    input: `${o.method ?? 'GET'} ${o.url}`,
    ...(o.body !== undefined ? { output: typeof o.body === 'string' ? o.body : JSON.stringify(o.body, null, 2) } : {}),
    metadata: { url: o.url, method: o.method ?? 'GET', status: o.status, ...(o.unresolved ? { unresolvedVariables: o.unresolved } : {}) },
  } as TestResult;
}

/** A finished run with these results, in the workspace's run history. */
export async function addRun(
  store: WorkspaceStore,
  o: { id: string; name?: string; startedAt: string; origin?: RunSummary['origin']; environment?: string; results: TestResult[] },
): Promise<RunSummary> {
  const dir = store.runDir(o.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'results.jsonl'), o.results.map((r) => JSON.stringify({ ...r, startedAt: o.startedAt })).join('\n') + '\n');
  const count = (s: string) => o.results.filter((r) => r.status === s).length;
  const summary: RunSummary = {
    runId: o.id,
    name: o.name ?? o.id,
    startedAt: o.startedAt,
    finishedAt: o.startedAt,
    durationMs: 100,
    total: o.results.length,
    passed: count('passed'),
    failed: count('failed'),
    skipped: 0,
    errors: count('error'),
    latency: LAT,
    tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    costUsd: 0,
    cancelled: false,
    ...(o.environment ? { environment: o.environment } : {}),
    scores: {},
    reproducibility: {},
    ...(o.origin ? { origin: o.origin } : {}),
  };
  await recordRun(store, summary, dir);
  return summary;
}
