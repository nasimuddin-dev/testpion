import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ApsError } from '../errors.js';
import type { ExpressionInput, ScriptInput, ScriptOptions, ScriptOutput } from './sandbox.js';
import type { ScriptRunner } from './script-runner.js';
import { WatchBudget } from './script-watchdog.js';

/**
 * A pool of worker threads that run user scripts (script-worker.ts): scripts of different runs and users use different cores, and a
 * slow or hung script stalls (and, past its limits, ends) one worker, never the host's event loop.
 *
 * Limits per job: the engine's own CPU and memory limits (`timeoutMs`, `memoryMb`), a watchdog that ends a worker which is
 * busy for longer than the job's time plus a slack (a hang the engine's interrupt handler cannot reach), and the worker's
 * V8 heap limit. A worker that was stopped (watchdog, cancel, crash) is replaced; one that has served many jobs is recycled.
 * `signal` cancels a job by ending its worker.
 */
export interface WorkerPoolOptions {
  /** Most workers at the same time (default: the cores minus one, at most 4). */
  size?: number;
  /** The worker script (a bundle or the built script-worker.js); found next to this module by default. */
  file?: string;
  /** V8 heap limit of a worker, MB. */
  heapMb?: number;
  /** An idle worker is ended after this long (default 60 s). */
  idleMs?: number;
  /** A worker is replaced after this many jobs (default 500). */
  maxUses?: number;
  /** Time a worker may be busy beyond the job's own limit before it is ended (default 3 s: the engine's start-up and a first parse). */
  slackMs?: number;
  /** A new worker must say it is ready within this long, else its job fails and the worker is replaced (default 10 s). */
  startMs?: number;
  /** How long the worker waits for the host's answer to `tp.require` before the call throws (default 10 s). */
  requireWaitMs?: number;
}

interface Slot {
  w: Worker;
  uses: number;
  busy: boolean;
  ready: Promise<void>;
  /** The worker thread has ended (it will not run another job). */
  dead?: boolean;
  shared: SharedArrayBuffer;
  idle?: ReturnType<typeof setTimeout>;
}

interface Waiter {
  go(slot: Slot): void;
  fail(e: Error): void;
}

const PACKAGE_BYTES = 2 * 1024 * 1024;
const HEADER = 32; // the require bridge's control words (script-worker.ts)

/** The worker script: an explicit file, TESTPION_SCRIPT_WORKER_FILE, the built script-worker.js next to this module, or the build output of a source checkout. */
export function findScriptWorkerFile(explicit?: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [explicit, process.env.TESTPION_SCRIPT_WORKER_FILE, join(here, 'script-worker.js'), join(here, 'script-worker.cjs'), join(here, '..', 'script-worker.cjs'), join(here, '..', '..', 'dist', 'scripts', 'script-worker.js')];
  return candidates.find((f): f is string => !!f && existsSync(f));
}

export class WorkerScriptRunner implements ScriptRunner {
  readonly kind = 'workers' as const;
  private readonly size: number;
  private readonly file: string;
  private readonly heapMb: number;
  private readonly idleMs: number;
  private readonly maxUses: number;
  private readonly slackMs: number;
  private readonly startMs: number;
  private readonly requireWaitMs: number;
  private readonly slots = new Set<Slot>();
  private readonly waiting: Waiter[] = [];
  private jobSeq = 0;
  private closed = false;
  /** Workers started and jobs finished so far (tests, diagnostics). */
  readonly stats = { started: 0, jobs: 0, killed: 0 };

  constructor(o: WorkerPoolOptions = {}) {
    const file = findScriptWorkerFile(o.file);
    if (!file) throw new ApsError('ConfigurationError', 'The script worker file was not found', { suggestions: ['Build the engine (npm run build), or set TESTPION_SCRIPT_WORKER_FILE.'] });
    this.file = file;
    this.size = Math.max(1, o.size ?? Math.min(4, availableParallelism() - 1));
    this.heapMb = o.heapMb ?? 512;
    this.idleMs = o.idleMs ?? 60_000;
    this.maxUses = o.maxUses ?? 500;
    this.slackMs = o.slackMs ?? 3000;
    this.startMs = o.startMs ?? 10_000;
    this.requireWaitMs = o.requireWaitMs ?? 10_000;
  }

  get workers(): number {
    return this.slots.size;
  }

  private spawn(): Slot {
    const shared = new SharedArrayBuffer(HEADER + PACKAGE_BYTES);
    const w = new Worker(this.file, { workerData: { pkg: shared }, resourceLimits: { maxOldGenerationSizeMb: this.heapMb, maxYoungGenerationSizeMb: 64 } });
    w.unref(); // an idle worker never keeps the process alive
    this.stats.started++;
    const slot: Slot = { w, uses: 0, busy: false, shared, ready: undefined as never };
    slot.ready = new Promise<void>((res, rej) => {
      const onMsg = (m: { type?: string }) => {
        if (m?.type !== 'ready') return;
        w.off('message', onMsg);
        res();
      };
      w.on('message', onMsg);
      w.once('error', rej);
      w.once('exit', () => rej(new Error('The script worker ended before it was ready')));
    });
    slot.ready.catch(() => undefined);
    // a worker that ends while idle leaves the pool at once (a busy one is dropped by its job); one that ends during the hand-over is seen as `dead`
    w.once('exit', () => {
      slot.dead = true;
      if (!slot.busy && this.slots.delete(slot)) clearTimeout(slot.idle);
    });
    this.slots.add(slot);
    return slot;
  }

  private drop(slot: Slot, kill: boolean): void {
    clearTimeout(slot.idle);
    this.slots.delete(slot);
    if (kill) {
      this.stats.killed++;
      void slot.w.terminate();
    } else void slot.w.terminate();
  }

  /** A free worker, a new one while there is room, else wait for one to be given back. */
  private acquire(signal?: AbortSignal): Promise<Slot> {
    if (this.closed) return Promise.reject(new ApsError('CancelledError', 'The script runner was closed'));
    for (const s of this.slots) {
      if (s.busy) continue;
      if (s.dead || s.uses >= this.maxUses) {
        this.drop(s, false);
        continue;
      }
      clearTimeout(s.idle);
      s.busy = true;
      return Promise.resolve(s);
    }
    if (this.slots.size < this.size) {
      const s = this.spawn();
      s.busy = true;
      return Promise.resolve(s);
    }
    return new Promise<Slot>((resolve, reject) => {
      const waiter: Waiter = {
        go: (s) => (signal?.removeEventListener('abort', onAbort), resolve(s)),
        fail: reject,
      };
      const onAbort = () => {
        const at = this.waiting.indexOf(waiter);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(new ApsError('CancelledError', 'The script was cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  /**
   * Gives a worker back. Every path of a job ends here (result, error, exit, watchdog kill, cancel), and every path ends with
   * "the worker serves the next waiting job, or a replacement is started and serves it": a queued job never waits for a worker
   * that is gone.
   */
  private release(slot: Slot, healthy: boolean): void {
    slot.busy = false;
    if (!healthy || this.closed || slot.dead) {
      this.drop(slot, !healthy);
      return this.refill();
    }
    const next = this.waiting.shift();
    if (next) {
      slot.busy = true;
      return next.go(slot);
    }
    slot.idle = setTimeout(() => this.drop(slot, false), this.idleMs);
    slot.idle.unref();
  }

  /** Room in the pool and jobs waiting: start workers for them. A worker that cannot be started fails the job it was started for. */
  private refill(): void {
    while (!this.closed && this.waiting.length && this.slots.size < this.size) {
      const waiter = this.waiting.shift()!;
      try {
        const s = this.spawn();
        s.busy = true;
        waiter.go(s);
      } catch (e) {
        waiter.fail(new ApsError('InternalError', `The script worker could not be started: ${(e as Error).message}`));
      }
    }
  }

  /** Runs one job; `fns` are the host functions the script may call back. */
  private async job<T>(op: 'script' | 'expression' | 'template' | 'metric', args: unknown[], limitMs: number, signal: AbortSignal | undefined, fns: { sendRequest?: ScriptOptions['sendRequest']; requirePackage?: ScriptOptions['requirePackage'] } = {}, onKilled?: (why: string) => T): Promise<T> {
    const cancelled = () => new ApsError('CancelledError', 'The script was cancelled');
    if (signal?.aborted) throw cancelled();
    let slot = await this.acquire(signal);
    // a worker that ended between being picked and now is not served; the abort that came while waiting for the worker never fired its listener
    for (let tries = 0; slot.dead && tries < 3 && !signal?.aborted; tries++) {
      this.release(slot, false);
      slot = await this.acquire(signal);
    }
    if (signal?.aborted || slot.dead) {
      this.release(slot, !slot.dead);
      throw signal?.aborted ? cancelled() : new ApsError('InternalError', 'The script worker ended before it could start the script');
    }
    slot.uses++;
    const id = ++this.jobSeq;
    return new Promise<T>((resolve, reject) => {
      const w = slot.w;
      let done = false;
      let started = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const budget = new WatchBudget(limitMs, this.slackMs);
      const killed = (why: string) => (onKilled ? resolve(onKilled(why)) : reject(new ApsError('TimeoutError', why)));
      /** The worker is busy with the engine: arm the watchdog with what is left of the budget (it is not armed while the host answers a send). */
      const arm = (ms: number) => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => end(false, () => killed(started ? `The script did not stop after ${limitMs} ms and was ended` : `The script worker did not start within ${Math.round(ms)} ms`)), Math.max(0, ms));
        watchdog.unref();
      };
      const end = (healthy: boolean, f: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(watchdog);
        signal?.removeEventListener('abort', onAbort);
        w.off('message', onMessage);
        w.off('error', onError);
        w.off('exit', onExit);
        this.stats.jobs++;
        this.release(slot, healthy);
        f();
      };
      const onAbort = () => end(false, () => reject(cancelled()));
      const failed = (why: string) => end(false, () => (onKilled ? resolve(onKilled(why)) : reject(new ApsError('InternalError', why))));
      const onError = (e: Error) => failed(`The script worker failed: ${e.message}`);
      const onExit = (code: number) => failed(`The script worker stopped (exit ${code})`);
      const onMessage = (m: { type: string; id?: number; reqId?: number; seq?: number; value?: T; kind?: string; message?: string; stack?: string; request?: never; name?: string }) => {
        if (m.id !== id) return;
        switch (m.type) {
          case 'result':
            return end(true, () => resolve(m.value as T));
          case 'error':
            return end(true, () => {
              const e = new ApsError((m.kind as ApsError['kind'] | undefined) ?? 'ScriptError', m.message ?? 'The script failed');
              if (m.stack) e.stack = m.stack;
              reject(e);
            });
          case 'send': {
            clearTimeout(watchdog); // the host works now, not the engine
            budget.pause();
            const reqId = m.reqId;
            void Promise.resolve()
              .then(() => fns.sendRequest?.(m.request as never))
              .then(
                (response) => ({ type: 'reply', reqId, response }),
                (e: unknown) => ({ type: 'reply', reqId, error: e instanceof Error ? e.message : String(e) }),
              )
              .then((reply) => {
                if (done) return;
                w.postMessage(reply);
                budget.grantPass();
                arm(budget.start());
              });
            return;
          }
          case 'pkg':
            return this.answerPackage(slot, m.seq ?? 0, m.name ?? '', fns.requirePackage, () => done);
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      w.on('message', onMessage);
      w.on('error', onError);
      w.on('exit', onExit);
      // until the worker says it is ready (the engine loads) the watchdog is the start-up limit; the script's clock starts when the job is posted
      arm(this.startMs);
      void slot.ready.then(
        () => {
          if (done) return;
          started = true;
          w.postMessage({ type: 'job', id, op, args, hasSend: !!fns.sendRequest, hasPackages: !!fns.requirePackage, requireWaitMs: this.requireWaitMs });
          arm(budget.start());
        },
        (e: Error) => onError(e),
      );
    });
  }

  /** The reply of the require bridge: written to the shared buffer the worker waits on, unless the worker has given up on this request. */
  private answerPackage(slot: Slot, seq: number, name: string, require: ScriptOptions['requirePackage'], finished: () => boolean): void {
    const ctl = new Int32Array(slot.shared, 0, 8);
    let status = 1;
    let bytes: Buffer | undefined;
    try {
      const src = require?.(name);
      if (src !== undefined) {
        bytes = Buffer.from(src, 'utf8');
        if (bytes.length > PACKAGE_BYTES) {
          status = 2;
          bytes = Buffer.from(`the package "${name}" is larger than ${PACKAGE_BYTES} bytes`, 'utf8');
        } else status = 0;
      }
    } catch (e) {
      status = 2;
      bytes = Buffer.from((e as Error).message.slice(0, 1000), 'utf8');
    }
    // the worker moved on (it timed out, or the job ended): this answer would be taken for the next request's
    if (finished() || Atomics.load(ctl, 2) !== seq) return;
    if (bytes) Buffer.from(slot.shared, HEADER, bytes.length).set(bytes);
    Atomics.store(ctl, 1, bytes ? bytes.length : -1);
    Atomics.store(ctl, 4, status);
    Atomics.store(ctl, 3, seq); // last: the worker reads the rest only after this
    Atomics.notify(ctl, 3);
  }

  runScript(code: string, input: ScriptInput, opts: ScriptOptions = {}): Promise<ScriptOutput> {
    const { sendRequest, requirePackage, signal, ...plain } = opts;
    const limit = plain.timeoutMs ?? 2000;
    return this.job<ScriptOutput>('script', [code, input, plain], limit, signal, { sendRequest, requirePackage }, (why) => ({
      vars: {},
      unset: [],
      scopeSets: { environment: {}, globals: {}, collectionVariables: {} },
      scopeUnsets: { environment: [], globals: [], collectionVariables: [] },
      tests: [],
      logs: [],
      error: why,
      durationMs: limit,
    }));
  }

  evaluateExpression(expr: string, input: ExpressionInput, opts: { timeoutMs?: number; memoryMb?: number } = {}) {
    return this.job<{ value?: unknown; error?: string }>('expression', [expr, input, opts], opts.timeoutMs ?? 250, undefined, {}, (why) => ({ error: why }));
  }

  renderTemplate(template: string, data: unknown, opts: Parameters<ScriptRunner['renderTemplate']>[2] = {}) {
    return this.job<{ html?: string; error?: string }>('template', [template, data, opts], opts.timeoutMs ?? 1000, undefined, {}, (why) => ({ error: why }));
  }

  runMetricScript(code: string, sample: unknown, opts: Parameters<ScriptRunner['runMetricScript']>[2] = {}) {
    return this.job<{ value?: unknown; error?: string; logs: string[] }>('metric', [code, sample, opts], opts.timeoutMs ?? 1000, undefined, {}, (why) => ({ error: why, logs: [] }));
  }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const w of this.waiting.splice(0)) w.fail(new ApsError('CancelledError', 'The script runner was closed'));
    await Promise.all([...this.slots].map((s) => (clearTimeout(s.idle), s.w.terminate())));
    this.slots.clear();
  }
}
