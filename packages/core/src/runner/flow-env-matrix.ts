/**
 * An environment matrix: one flow file run against several environments (dev, staging, prod …), each with its own
 * variables, and the results side by side: environment × step (status and time), and what each environment's run
 * extracted or returned (its `output:`), with the values that differ between environments marked. Host-agnostic: the
 * caller gives an engine context per environment (the CLI's, the app's, the MCP server's).
 */
import type { TestResult } from '../model/types.js';
import { ApsError, normalizeError } from '../errors.js';
import type { ExecServices } from './execute.js';
import { loadFlowSteps, runFlowOnce, type FlowRunStatus } from './flow-data-run.js';
import { readFlowOutput } from './flow-blocks.js';

/** One environment's run in the matrix. */
export interface MatrixColumn {
  environment: string;
  /** skipped: nothing ran in this environment (every step was skipped). */
  status: FlowRunStatus;
  durationMs: number;
  failedStep?: string;
  error?: string;
  /** Step id → status and ms (skipped steps too). */
  cells: Record<string, { status: string; ms: number; error?: string }>;
  /** What the run extracted, or its declared output when the file has one (redacted, bounded). */
  outputs: Record<string, unknown>;
  /** The full step results (for the drill-in). */
  results: TestResult[];
}

export interface FlowMatrixResult {
  file: string;
  startedAt: string;
  durationMs: number;
  environments: string[];
  steps: Array<{ id: string; name: string }>;
  columns: MatrixColumn[];
  /** Every output across the environments: its value in each (environments' order) and whether they differ. */
  outputs: Array<{ key: string; values: unknown[]; differs: boolean }>;
  /** Steps whose status differs between environments. */
  differingSteps: string[];
  passed: number;
  /** Environments that failed or were cancelled. */
  failed: number;
  /** Environments where nothing ran (every step skipped): a matrix that only skipped did not pass. */
  skipped: number;
}

interface FlowMatrixOptions {
  /** The flow file (absolute). */
  file: string;
  environments: string[];
  /** The engine services of an environment, and how to release them. */
  contextFor(environment: string): Promise<{ services: ExecServices; dispose(): unknown }> | { services: ExecServices; dispose(): unknown };
  /** Environments run at once (default all of them, at most 8). */
  concurrency?: number;
  stepConcurrency?: number;
  retries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Each environment as it finishes. */
  onColumn?(c: MatrixColumn): void;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Run a flow file in each environment and compare. */
export async function runFlowMatrix(o: FlowMatrixOptions): Promise<FlowMatrixResult> {
  const environments = [...new Set(o.environments.map((e) => e.trim()).filter(Boolean))];
  if (environments.length < 1) throw new ApsError('ValidationError', 'An environment matrix needs at least one environment (two to compare)');
  if (environments.length > 20) throw new ApsError('ValidationError', 'An environment matrix runs at most 20 environments');
  const tests = await loadFlowSteps(o.file);
  const output = readFlowOutput(o.file) ?? null;
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const columns: MatrixColumn[] = new Array(environments.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= environments.length) return;
      const environment = environments[i]!;
      let col: MatrixColumn;
      if (o.signal?.aborted) col = { environment, status: 'cancelled', durationMs: 0, cells: {}, outputs: {}, results: [] };
      else {
        let ctx: { services: ExecServices; dispose(): unknown } | undefined;
        try {
          ctx = await o.contextFor(environment);
          const r = await runFlowOnce({
            file: o.file,
            tests,
            output,
            services: ctx.services,
            signal: o.signal,
            concurrency: o.stepConcurrency,
            retries: o.retries,
            timeoutMs: o.timeoutMs,
            name: `${environment}`,
            environment,
          });
          col = {
            environment,
            status: r.status,
            durationMs: r.durationMs,
            ...(r.failedStep ? { failedStep: r.failedStep } : {}),
            ...(r.error ? { error: r.error.slice(0, 500) } : {}),
            cells: Object.fromEntries(
              r.steps.map((s) => [
                s.id,
                {
                  status: s.status,
                  ms: Math.round(s.latencyMs ?? s.durationMs),
                  ...(s.status === 'failed' || s.status === 'error' ? { error: (s.error?.message ?? s.checks.find((c) => !c.passed)?.message ?? '').slice(0, 300) } : {}),
                },
              ]),
            ),
            outputs: r.output ?? r.extracted,
            results: r.steps,
          };
        } catch (e) {
          const err = normalizeError(e);
          col = { environment, status: 'failed', durationMs: 0, error: `${err.kind}: ${err.message}`, cells: {}, outputs: {}, results: [] };
        } finally {
          await Promise.resolve(ctx?.dispose()).catch(() => undefined);
        }
      }
      columns[i] = col;
      try {
        o.onColumn?.(col);
      } catch {
        /* listeners must not break the run */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(environments.length, Math.max(1, Math.min(8, o.concurrency ?? environments.length))) }, worker));
  const keys = [...new Set(columns.flatMap((c) => Object.keys(c.outputs)))].sort();
  const outputs = keys.map((key) => {
    const values = columns.map((c) => c.outputs[key]);
    return { key, values, differs: values.some((v) => !same(v, values[0])) };
  });
  const differingSteps = tests
    .map((t) => t.id ?? t.name)
    .filter((id) => {
      const s = columns.map((c) => c.cells[id]?.status ?? 'not run');
      return s.some((x) => x !== s[0]);
    });
  return {
    file: o.file,
    startedAt,
    durationMs: Math.round(performance.now() - t0),
    environments,
    steps: tests.map((t) => ({ id: t.id ?? t.name, name: t.name })),
    columns,
    outputs,
    differingSteps,
    passed: columns.filter((c) => c.status === 'passed').length,
    failed: columns.filter((c) => c.status === 'failed' || c.status === 'cancelled').length,
    skipped: columns.filter((c) => c.status === 'skipped').length,
  };
}
