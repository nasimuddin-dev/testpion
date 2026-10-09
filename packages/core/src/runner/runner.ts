import { ENGINE_VERSION } from '../version.js';
import { createReadStream, createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { RunSummary, TestCase, TestResult, TestStatus, Trace } from '../model/types.js';
import { ApsError, isAbortError, normalizeError } from '../errors.js';
import { Tracer } from '../trace/tracer.js';
import { LatencyRecorder, round } from '../util/stats.js';
import { Semaphore, sleep } from '../util/concurrency.js';
import { shortId } from '../util/ids.js';
import { executeTest, type ExecServices } from './execute.js';
import { endAndClose } from '../storage/fsutil.js';

export type RunEvent =
  | { type: 'run-start'; runId: string; name: string; startedAt: string }
  | { type: 'test-start'; runId: string; id: string; name: string; attempt: number }
  | { type: 'test-end'; runId: string; result: TestResult }
  | { type: 'progress'; runId: string; completed: number; passed: number; failed: number; skipped: number; errors: number; running: number }
  | { type: 'run-end'; runId: string; summary: RunSummary };

export interface RunOptions {
  name: string;
  tests: AsyncIterable<TestCase> | Iterable<TestCase>;
  setup?: TestCase[];
  teardown?: TestCase[];
  concurrency?: number;
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  services: ExecServices;
  signal?: AbortSignal;
  /** Stream results as JSON lines to this file (also used as the checkpoint for `resume`). */
  resultsFile?: string;
  /** Skip tests already present in `resultsFile` and continue the run. */
  resume?: boolean;
  /** Persist traces: all, only failing tests, or none. */
  traceMode?: 'all' | 'failures' | 'none';
  /** Persist a trace. Called in batches off the test path (about every 100 ms and at the end of the run), never per test. */
  onTrace?: (trace: Trace, result: TestResult) => void | Promise<void>;
  /** Wraps each batch of `onTrace` calls, e.g. `(fn) => store.meta.batch(fn)` for one database transaction per batch. */
  traceBatch?: (fn: () => void) => void;
  onEvent?: (e: RunEvent) => void;
  environment?: string;
  bail?: boolean;
  runId?: string;
}

/** Incremental aggregation — never holds all results in memory. */
export class RunAggregator {
  total = 0;
  passed = 0;
  failed = 0;
  skipped = 0;
  errors = 0;
  latency = new LatencyRecorder();
  tokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  cost = 0;
  scores = new Map<string, { sum: number; count: number }>();

  add(r: TestResult): void {
    this.total++;
    if (r.status === 'passed') this.passed++;
    else if (r.status === 'failed') this.failed++;
    else if (r.status === 'skipped') this.skipped++;
    else this.errors++;
    if (r.latencyMs !== undefined) this.latency.record(r.latencyMs);
    if (r.tokens) {
      this.tokens.inputTokens += r.tokens.inputTokens;
      this.tokens.outputTokens += r.tokens.outputTokens;
      this.tokens.totalTokens += r.tokens.totalTokens;
    }
    if (r.costUsd) this.cost += r.costUsd;
    for (const c of r.checks) {
      if (typeof c.score !== 'number') continue;
      const s = this.scores.get(c.type) ?? { sum: 0, count: 0 };
      s.sum += c.score;
      s.count++;
      this.scores.set(c.type, s);
    }
  }

  summary(base: { runId: string; name: string; startedAt: string; cancelled: boolean; environment?: string; reproducibility: Record<string, unknown> }): RunSummary {
    const finishedAt = new Date().toISOString();
    return {
      ...base,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(base.startedAt),
      total: this.total,
      passed: this.passed,
      failed: this.failed,
      skipped: this.skipped,
      errors: this.errors,
      latency: this.latency.stats(),
      tokens: { ...this.tokens },
      costUsd: round(this.cost, 6),
      scores: Object.fromEntries([...this.scores].map(([k, v]) => [k, { mean: round(v.sum / v.count, 4), count: v.count }])),
    };
  }
}

interface Deferred {
  promise: Promise<TestStatus | 'missing'>;
  resolve: (s: TestStatus | 'missing') => void;
}
function deferred(): Deferred {
  let resolve!: Deferred['resolve'];
  const promise = new Promise<TestStatus | 'missing'>((r) => (resolve = r));
  return { promise, resolve };
}

export async function readResultsFile(path: string): Promise<AsyncGenerator<TestResult>> {
  async function* gen() {
    if (!existsSync(path)) return;
    const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as TestResult;
      } catch {
        /* partially written last line after a crash — ignore */
      }
    }
  }
  return gen();
}

/**
 * Execute a stream of tests with bounded concurrency and backpressure.
 * Results are streamed to listeners and to disk; only aggregates are kept in memory.
 */
export async function runTests(opts: RunOptions): Promise<RunSummary> {
  const runId = opts.runId ?? shortId('run-');
  const startedAt = new Date().toISOString();
  const agg = new RunAggregator();
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const sem = new Semaphore(concurrency);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  const signal = ctrl.signal;
  const emit = (e: RunEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* listeners must not break the run */
    }
  };
  let running = 0;
  const progress = () => emit({ type: 'progress', runId, completed: agg.total, passed: agg.passed, failed: agg.failed, skipped: agg.skipped, errors: agg.errors, running });

  // resume support: results file doubles as checkpoint
  const done = new Set<string>();
  const statusById = new Map<string, TestStatus>();
  if (opts.resultsFile && opts.resume) {
    for await (const r of await readResultsFile(opts.resultsFile)) {
      done.add(r.id);
      statusById.set(r.id, r.status);
      agg.add(r);
    }
  }
  let out: WriteStream | undefined;
  if (opts.resultsFile) {
    mkdirSync(dirname(opts.resultsFile), { recursive: true });
    out = createWriteStream(opts.resultsFile, { flags: opts.resume ? 'a' : 'w' });
  }
  // many workers write concurrently: share one drain wait instead of one listener per writer
  let drain: Promise<void> | undefined;
  const write = async (r: TestResult) => {
    if (out && !out.write(JSON.stringify(r) + '\n')) {
      drain ??= new Promise<void>((res) =>
        out!.once('drain', () => {
          drain = undefined;
          res();
        }),
      );
      await drain;
    }
  };

  emit({ type: 'run-start', runId, name: opts.name, startedAt });

  const deferreds = new Map<string, Deferred>();
  const seen = new Set<string>();
  const dep = (id: string) => deferreds.get(id) ?? deferreds.set(id, deferred()).get(id)!;

  // traces are derived data: queued and written in batches so a test never waits for a file write
  const traceQueue: Array<[Trace, TestResult]> = [];
  let traceTimer: ReturnType<typeof setTimeout> | undefined;
  let traceWrites: Promise<void> = Promise.resolve();
  const flushTraces = (): Promise<void> => {
    if (traceTimer) clearTimeout(traceTimer);
    traceTimer = undefined;
    const batch = traceQueue.splice(0);
    if (!batch.length || !opts.onTrace) return traceWrites;
    const onTrace = opts.onTrace;
    traceWrites = traceWrites.then(async () => {
      const pending: Array<Promise<void>> = [];
      const all = () => {
        for (const [t, r] of batch) {
          try {
            const p = onTrace(t, r);
            if (p) pending.push(p.catch(() => undefined));
          } catch {
            /* trace persistence is best-effort */
          }
        }
      };
      try {
        if (opts.traceBatch) opts.traceBatch(all);
        else all();
      } catch {
        /* a failed batch loses its traces, not the run */
      }
      await Promise.all(pending);
    });
    return traceWrites;
  };
  const queueTrace = (t: Trace, r: TestResult) => {
    traceQueue.push([t, r]);
    if (traceQueue.length >= 500) void flushTraces();
    else
      traceTimer ??= setTimeout(() => {
        traceTimer = undefined;
        void flushTraces();
      }, 100);
  };

  const record = async (r: TestResult, trace?: Trace) => {
    const redacted = opts.services.redactor.redact(r);
    agg.add(redacted);
    statusById.set(r.id, r.status);
    dep(r.id).resolve(r.status);
    await write(redacted);
    if (trace && opts.onTrace && (opts.traceMode === 'all' || (opts.traceMode !== 'none' && r.status !== 'passed'))) queueTrace(trace, redacted);
    emit({ type: 'test-end', runId, result: redacted });
    progress();
    if (opts.bail && (r.status === 'failed' || r.status === 'error')) ctrl.abort();
  };

  const skippedResult = (t: TestCase, reason: string): TestResult => ({
    id: t.id ?? t.name,
    name: t.name,
    type: t.type,
    status: 'skipped',
    file: t.file,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    attempts: 0,
    checks: [],
    metadata: { reason },
  });

  const runOne = async (t: TestCase): Promise<{ result: TestResult; trace?: Trace }> => {
    const retries = t.retries ?? opts.retries ?? 0;
    let last: { result: TestResult; trace?: Trace } | undefined;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      if (signal.aborted) throw new ApsError('CancelledError', 'Run cancelled');
      emit({ type: 'test-start', runId, id: t.id ?? t.name, name: t.name, attempt });
      const tracer = new Tracer(t.name, opts.services.redactor);
      const t0 = performance.now();
      const started = new Date().toISOString();
      const test = { ...t, timeoutMs: t.timeoutMs ?? opts.timeoutMs };
      const o = await executeTest(test, opts.services, { tracer, signal });
      const trace = tracer.finish(o.status === 'passed' ? 'ok' : 'error');
      const result: TestResult = {
        id: t.id ?? t.name,
        name: t.name,
        type: t.type,
        status: o.status,
        file: t.file,
        startedAt: started,
        durationMs: Math.round(performance.now() - t0),
        attempts: attempt,
        checks: o.checks,
        error: o.error,
        latencyMs: o.latencyMs,
        tokens: o.tokens,
        costUsd: o.costUsd,
        model: o.model,
        traceId: trace.traceId,
        output: o.output,
        input: o.input,
        metadata: Object.keys(o.metadata).length ? o.metadata : undefined,
      };
      last = { result, trace };
      if (o.status === 'passed' || o.status === 'skipped') break;
      if (attempt <= retries) await sleep(Math.min(5000, (opts.retryDelayMs ?? 250) * 2 ** (attempt - 1)), signal).catch(() => undefined);
    }
    return last!;
  };

  const exec = async (t: TestCase) => {
    const id = t.id ?? t.name;
    if (t.skip) return record(skippedResult(t, 'marked skip'));
    if (t.dependsOn?.length) {
      const statuses = await Promise.all(t.dependsOn.map((d) => (statusById.has(d) ? statusById.get(d)! : dep(d).promise)));
      const bad = t.dependsOn.map((d, i) => [d, statuses[i]] as const).filter(([, s]) => s !== 'passed');
      if (bad.length) return record(skippedResult(t, `dependency did not pass: ${bad.map(([d, s]) => `${d} (${s})`).join(', ')}`));
    }
    const release = await sem.acquire(signal);
    running++;
    try {
      const { result, trace } = await runOne(t);
      await record(result, trace);
    } catch (e) {
      if (!isAbortError(e)) {
        const err = normalizeError(e);
        await record({ ...skippedResult(t, 'internal error'), status: 'error', error: err });
      } else dep(id).resolve('skipped');
    } finally {
      running--;
      release();
    }
  };

  let cancelled = false;
  // added right before the try whose finally removes it: a finished run is never kept alive by the caller's signal
  if (opts.signal?.aborted) ctrl.abort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    // setup (sequential). Failures skip the whole run.
    let setupFailed = false;
    for (const t of opts.setup ?? []) {
      seen.add(t.id ?? t.name);
      await exec({ ...t, name: `[setup] ${t.name}` });
      if (statusById.get(t.id ?? t.name) !== 'passed') setupFailed = true;
    }

    const inflight = new Set<Promise<void>>();
    for await (const t of opts.tests as AsyncIterable<TestCase>) {
      if (signal.aborted) break;
      const id = t.id ?? t.name;
      seen.add(id);
      if (done.has(id)) {
        dep(id).resolve(statusById.get(id)!);
        continue;
      }
      if (setupFailed) {
        await record(skippedResult(t, 'setup failed'));
        continue;
      }
      // backpressure: never pull more than 2×concurrency tests from the source ahead of the workers
      while (inflight.size >= concurrency * 2 && !signal.aborted) await Promise.race(inflight);
      const p: Promise<void> = exec(t).finally(() => inflight.delete(p));
      inflight.add(p);
    }
    // dependencies that never appeared in the stream
    for (const [id, d] of deferreds) if (!seen.has(id)) d.resolve('missing');
    await Promise.all(inflight);
  } finally {
    cancelled = signal.aborted && (opts.signal?.aborted ?? false);
    // teardown always runs (not cancellable by bail, but honours user cancellation)
    for (const t of opts.teardown ?? []) {
      if (opts.signal?.aborted) break;
      await exec({ ...t, name: `[teardown] ${t.name}` }).catch(() => undefined);
    }
    opts.signal?.removeEventListener('abort', onAbort);
    await flushTraces();
    if (out) await endAndClose(out);
  }

  const summary = agg.summary({
    runId,
    name: opts.name,
    startedAt,
    cancelled,
    environment: opts.environment,
    reproducibility: {
      engineVersion: ENGINE_VERSION,
      node: process.version,
      platform: process.platform,
      concurrency,
      retries: opts.retries ?? 0,
      environment: opts.environment,
      pricingVersions: [...new Set(opts.services.pricing.map((p) => p.version))],
    },
  });
  emit({ type: 'run-end', runId, summary });
  return summary;
}
