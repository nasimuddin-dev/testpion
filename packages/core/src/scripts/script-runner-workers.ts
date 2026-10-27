import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ApsError } from '../errors.js';
import type { ExpressionInput, ScriptInput, ScriptOptions, ScriptOutput } from './sandbox.js';
import type { ScriptRunner } from './script-runner.js';

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
}

interface Slot {
  w: Worker;
  uses: number;
  busy: boolean;
  ready: Promise<void>;
  shared: SharedArrayBuffer;
  idle?: ReturnType<typeof setTimeout>;
}

interface Waiter {
  go(slot: Slot): void;
  fail(e: Error): void;
}

const PACKAGE_BYTES = 2 * 1024 * 1024;

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
  }

  get workers(): number {
    return this.slots.size;
  }

  private spawn(): Slot {
    const shared = new SharedArrayBuffer(8 + PACKAGE_BYTES);
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
      if (s.uses >= this.maxUses) {
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

  private release(slot: Slot, healthy: boolean): void {
    slot.busy = false;
    if (!healthy || this.closed) return this.drop(slot, !healthy);
    const next = this.waiting.shift();
    if (next) {
      slot.busy = true;
      return next.go(slot);
    }
    slot.idle = setTimeout(() => this.drop(slot, false), this.idleMs);
    slot.idle.unref();
  }

  /** Runs one job; `fns` are the host functions the script may call back. */
  private async job<T>(op: 'script' | 'expression' | 'template' | 'metric', args: unknown[], limitMs: number, signal: AbortSignal | undefined, fns: { sendRequest?: ScriptOptions['sendRequest']; requirePackage?: ScriptOptions['requirePackage'] } = {}, onKilled?: (why: string) => T): Promise<T> {
    if (signal?.aborted) throw new ApsError('CancelledError', 'The script was cancelled');
    const slot = await this.acquire(signal);
    slot.uses++;
    const id = ++this.jobSeq;
    return new Promise<T>((resolve, reject) => {
      const w = slot.w;
      let done = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      /** The worker is busy with the engine: arm the watchdog (it is not while the host answers a send). */
      const arm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => end(false, () => (onKilled ? resolve(onKilled(`The script did not stop after ${limitMs} ms and was ended`)) : reject(new ApsError('TimeoutError', `The script did not stop after ${limitMs} ms and was ended`)))), limitMs + this.slackMs);
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
      const onAbort = () => end(false, () => reject(new ApsError('CancelledError', 'The script was cancelled')));
      const onError = (e: Error) => end(false, () => (onKilled ? resolve(onKilled(`The script worker failed: ${e.message}`)) : reject(new ApsError('InternalError', `The script worker failed: ${e.message}`))));
      const onExit = (code: number) => end(false, () => (onKilled ? resolve(onKilled(`The script worker stopped (exit ${code})`)) : reject(new ApsError('InternalError', `The script worker stopped (exit ${code})`))));
      const onMessage = (m: { type: string; id?: number; reqId?: number; value?: T; message?: string; request?: never; name?: string }) => {
        if (m.id !== id) return;
        switch (m.type) {
          case 'result':
            return end(true, () => resolve(m.value as T));
          case 'error':
            return end(true, () => reject(new ApsError('ScriptError', m.message ?? 'The script failed')));
          case 'send': {
            clearTimeout(watchdog); // the host works now, not the engine
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
                arm();
              });
            return;
          }
          case 'pkg': {
            // answered at once through the shared buffer the worker waits on
            const ctl = new Int32Array(slot.shared, 0, 2);
            let src: string | undefined;
            try {
              src = fns.requirePackage?.(m.name ?? '');
            } catch {
              src = undefined;
            }
            const bytes = src === undefined ? undefined : Buffer.from(src, 'utf8');
            if (bytes && bytes.length <= PACKAGE_BYTES) {
              Buffer.from(slot.shared, 8, bytes.length).set(bytes);
              Atomics.store(ctl, 1, bytes.length);
            } else Atomics.store(ctl, 1, -1);
            Atomics.store(ctl, 0, 1);
            Atomics.notify(ctl, 0);
          }
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      w.on('message', onMessage);
      w.on('error', onError);
      w.on('exit', onExit);
      arm();
      void slot.ready.then(
        () => !done && w.postMessage({ type: 'job', id, op, args, hasSend: !!fns.sendRequest, hasPackages: !!fns.requirePackage }),
        (e: Error) => onError(e),
      );
    });
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
