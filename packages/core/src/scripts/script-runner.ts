import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExpressionInput, ScriptInput, ScriptOptions, ScriptOutput } from './sandbox.js';

/**
 * Where user scripts run. Scripts always run in QuickJS (a WASM engine, no host access); the runner decides on which thread:
 * `thread` is the engine inside the calling process (the CLI, tests, the desktop app by default), `workers` is a pool of
 * worker threads (a server, or the app when asked), so a slow script stalls one worker and not every RPC of every tenant, and
 * scripts of different users run in parallel on different cores.
 *
 * The trust gates (script trust, secrets, `tp.sendRequest` limits) are applied by the host BEFORE and AROUND the engine, so
 * they work the same through a worker: the input handed to the engine is already filtered, and `sendRequest` /
 * `requirePackage` stay host functions the worker calls back over messages.
 */
export interface ScriptRunner {
  readonly kind: 'thread' | 'workers';
  runScript(code: string, input: ScriptInput, opts?: ScriptOptions): Promise<ScriptOutput>;
  evaluateExpression(expr: string, input: ExpressionInput, opts?: { timeoutMs?: number; memoryMb?: number }): Promise<{ value?: unknown; error?: string }>;
  renderTemplate(template: string, data: unknown, opts?: { timeoutMs?: number; memoryMb?: number; maxTemplateBytes?: number; maxDataBytes?: number; maxOutputBytes?: number }): Promise<{ html?: string; error?: string }>;
  runMetricScript(code: string, sample: unknown, opts?: { timeoutMs?: number; memoryMb?: number; maxOutputBytes?: number; options?: unknown }): Promise<{ value?: unknown; error?: string; logs: string[] }>;
  /** Ends the workers (the thread runner has none). */
  dispose(): Promise<void>;
}

const als = new AsyncLocalStorage<ScriptRunner>();
let processRunner: ScriptRunner | undefined; // seam: the runner of the process (the CLI, or the desktop app), set once at start-up

/** The runner of the process: what scripts use outside any call that brought its own. Undefined: the engine in the calling thread. */
export function setDefaultScriptRunner(runner: ScriptRunner | undefined): void {
  processRunner = runner;
}

/** The runner the running code uses: its call's (or run's), else the process's, else none (the engine in this thread). */
export function currentScriptRunner(): ScriptRunner | undefined {
  return als.getStore() ?? processRunner;
}

/** Run `fn` so every script inside it goes through `runner` (a no-op wrapper when none is given). */
export function withScriptRunner<T>(runner: ScriptRunner | undefined, fn: () => T): T {
  return runner ? als.run(runner, fn) : fn();
}
