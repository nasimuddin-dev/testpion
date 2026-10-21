/**
 * Running a step: once, once per iteration of its `repeat:` / `forEach:`, or again and again until its `until:` holds
 * (Wait until). These wrap `executeTest` (execute.ts), which runs one step of any type; execute.ts in turn calls the blocks'
 * own runners (flow-blocks.ts, flow-control.ts), so the wrappers live here, above both, and the import graph has no cycle.
 * The runner (runner.ts) runs every step through `executeStep`.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CheckResult, TestCase, TestStatus } from '../model/types.js';
import { ApsError } from '../errors.js';
import type { Tracer } from '../trace/tracer.js';
import { sleep } from '../util/concurrency.js';
import { readDataset } from './datasets.js';
import { dbKindOf } from './db-datasets.js';
import { MAX_ITERATIONS } from './loader.js';
import { executeTest, type ExecServices, type ExecutionOutcome } from './execute.js';
import { evaluateCondition, subFlowPath, type StepResponse } from './flow-blocks.js';
import { durationLabel } from './flow-control.js';

/**
 * Run a step with `until:` until its expression is true on the step's response (and the variables, with what the try
 * extracted): the try that makes it true is the step's result, with `tries` and `waitedMs` in its metadata. When the
 * time is up the step fails with "condition not met within 60 s (n tries): last status …". The run's cancel stops the
 * wait at once. A pinned step is tried once (its response does not change).
 */
async function executeUntil(test: TestCase, svc: ExecServices, opts: { tracer: Tracer; signal?: AbortSignal; prev?: StepResponse }): Promise<ExecutionOutcome> {
  const u = test.until!;
  const once = { ...test, until: undefined };
  const pinned = !!svc.pinned?.(test.id ?? test.name);
  const t0 = performance.now();
  let wait = u.everyMs;
  let tries = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new ApsError('CancelledError', 'Run cancelled');
    tries++;
    const o = await executeTest(once, svc, opts);
    const c = o.context;
    const response: StepResponse | undefined = c ? { status: c.status, headers: c.headers, body: c.body, text: c.text } : undefined;
    let met = false;
    if (!o.error)
      try {
        met = await evaluateCondition(u.if, svc.vars, response);
      } catch (e) {
        const err =
          e instanceof ApsError
            ? e.toJSON()
            : { kind: 'ScriptError' as const, message: (e as Error).message, what: (e as Error).message, why: 'The until: expression could not be evaluated.', suggestions: [] };
        return { ...o, status: 'error', error: err, metadata: { ...o.metadata, until: u.if, tries, waitedMs: Math.round(performance.now() - t0) } };
      }
    const elapsed = performance.now() - t0;
    const meta = { until: u.if, tries, waitedMs: Math.round(elapsed) };
    if (met) {
      const check: CheckResult = {
        type: 'until',
        name: 'until',
        passed: true,
        source: 'deterministic',
        message: `${u.if} after ${tries} ${tries === 1 ? 'try' : 'tries'} (${durationLabel(Math.round(elapsed))})`,
      };
      return { ...o, checks: [...o.checks, check], metadata: { ...o.metadata, ...meta } };
    }
    if (pinned || elapsed >= u.timeoutMs) {
      const lastSaid = o.error ? `last error: ${o.error.message}` : c?.status !== undefined ? `last status ${c.status}` : 'no response';
      const check: CheckResult = {
        type: 'until',
        name: 'until',
        passed: false,
        source: 'deterministic',
        message: pinned
          ? `${u.if} is not true on the pinned response (a pinned step is tried once): ${lastSaid}`
          : `condition not met within ${durationLabel(u.timeoutMs)} (${tries} ${tries === 1 ? 'attempt' : 'attempts'}): ${lastSaid}`,
        expected: u.if,
      };
      // an error of the last try stays the step's error; else the step failed its wait
      return { ...o, status: o.error ? 'error' : 'failed', checks: [...o.checks.filter((x) => !x.passed), check], metadata: { ...o.metadata, ...meta, timedOut: !pinned } };
    }
    await sleep(Math.max(0, Math.min(wait, u.timeoutMs - elapsed)), opts.signal);
    wait = Math.min(u.maxEveryMs, wait * u.backoff);
  }
}

/** The rows of a loop: `repeat: N` gives N empty rows, `forEach:` the list or the dataset's records (streamed). */
async function* loopRows(test: TestCase): AsyncGenerator<unknown> {
  if (test.repeat !== undefined) {
    for (let i = 0; i < test.repeat; i++) yield undefined;
    return;
  }
  const fe = test.forEach;
  if (Array.isArray(fe)) {
    yield* fe;
    return;
  }
  if (fe && typeof fe === 'object') {
    const path = dbKindOf(fe.dataset) ? fe.dataset : test.file ? subFlowPath(fe.dataset, test.file) : resolve(fe.dataset);
    if (!dbKindOf(path) && !existsSync(path)) throw new ApsError('ConfigurationError', `No such dataset: ${fe.dataset}`);
    yield* readDataset({ path, ...(fe.limit !== undefined ? { limit: fe.limit } : {}) });
  }
}


/**
 * Run a step: once, or once per iteration of its `repeat:` / `forEach:` with the row's fields, `$index` and `$item` as
 * its variables. Iterations run in order; the run's cancel stops between them. What the last iteration extracts
 * flows on; the result lists each iteration (metadata.iterationResults) and says how many passed.
 */
export async function executeStep(test: TestCase, svc: ExecServices, opts: { tracer: Tracer; signal?: AbortSignal; prev?: StepResponse }): Promise<ExecutionOutcome> {
  if (test.until) return executeUntil(test, svc, opts);
  if (test.repeat === undefined && test.forEach === undefined) return executeTest(test, svc, opts);
  const iterations: Array<{ index: number; status: TestStatus; durationMs: number; error?: string; failedChecks?: string[] }> = [];
  const failing: CheckResult[] = [];
  let last: ExecutionOutcome | undefined;
  let firstError: ExecutionOutcome['error'];
  let latency = 0;
  const tokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let cost = 0;
  let tooMany = false;
  let index = 0;
  try {
    for await (const row of loopRows(test)) {
      if (index >= MAX_ITERATIONS) {
        tooMany = true;
        break;
      }
      if (opts.signal?.aborted) throw new ApsError('CancelledError', 'Run cancelled');
      const fields = row && typeof row === 'object' && !Array.isArray(row) ? (row as Record<string, unknown>) : {};
      const t0 = performance.now();
      const o = await executeTest({ ...test, variables: { ...(test.variables ?? {}), ...fields, $index: index, $item: row ?? index } }, svc, opts);
      const bad = o.checks.filter((c) => !c.passed);
      iterations.push({
        index,
        status: o.status,
        durationMs: Math.round(performance.now() - t0),
        ...(o.error ? { error: o.error.message } : {}),
        ...(bad.length ? { failedChecks: bad.slice(0, 5).map((c) => `${c.name}: ${c.message}`) } : {}),
      });
      for (const c of bad) if (failing.length < 200) failing.push({ ...c, name: `[#${index}] ${c.name}` });
      firstError ??= o.error;
      latency += o.latencyMs ?? 0;
      if (o.tokens) {
        tokens.inputTokens += o.tokens.inputTokens;
        tokens.outputTokens += o.tokens.outputTokens;
        tokens.totalTokens += o.tokens.totalTokens;
      }
      cost += o.costUsd ?? 0;
      last = o;
      index++;
    }
  } catch (e) {
    if (e instanceof ApsError && e.kind === 'CancelledError') throw e;
    if (opts.signal?.aborted) throw e;
    const err =
      e instanceof ApsError
        ? e.toJSON()
        : { kind: 'ConfigurationError' as const, message: (e as Error).message, what: (e as Error).message, why: 'The rows of the loop could not be read.', suggestions: [] };
    return { status: 'error', checks: [], error: err, metadata: { iterations: iterations.length, iterationResults: iterations } };
  }
  const n = iterations.length;
  if (!n) return { status: 'skipped', checks: [], metadata: { reason: test.repeat !== undefined ? 'repeat: 0 runs the step no times' : 'forEach: has no rows', iterations: 0 } };
  const passed = iterations.filter((i) => i.status === 'passed').length;
  const errors = iterations.filter((i) => i.status === 'error').length;
  const failed = iterations.filter((i) => i.status === 'failed').length;
  const summary: CheckResult = {
    type: 'iterations',
    name: 'iterations',
    passed: !errors && !failed && !tooMany,
    source: 'deterministic',
    message: `${passed} of ${n} iterations passed${tooMany ? `; the loop stopped at ${MAX_ITERATIONS} iterations (the most a step runs)` : ''}`,
  };
  const status: TestStatus = errors ? 'error' : failed || tooMany ? 'failed' : passed ? 'passed' : 'skipped';
  return {
    status,
    checks: [...(failing.length ? failing : (last?.checks ?? [])), summary],
    error: errors ? firstError : undefined,
    latencyMs: Math.round(latency),
    tokens: tokens.totalTokens ? tokens : undefined,
    costUsd: cost || undefined,
    model: last?.model,
    output: last?.output,
    input: last?.input,
    metadata: { ...(last?.metadata ?? {}), iterations: n, iterationResults: iterations.slice(0, 1000) },
    context: last?.context,
  };
}
