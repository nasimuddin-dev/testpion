import { threadScriptRunner, type ExpressionInput, type ScriptInput, type ScriptOptions, type ScriptOutput, type ScriptRunner, type WorkerScriptRunner } from '@testpion/core';

/**
 * The worker pool with a start-up self-check. A pool that cannot start (a packaged build that cannot load the worker file from the
 * archive, a blocked thread) must degrade to the engine in the calling thread, never hang a run: at creation a trivial job makes the
 * round trip with a 2 s limit; the first real job waits for that answer, and when it fails every job goes to the thread runner and
 * `onProblem` says why (AppServices.scriptWorkersProblem).
 */
export class GuardedScriptRunner implements ScriptRunner {
  private fellBack = false;
  private readonly checked: Promise<void>;

  constructor(
    private readonly pool: WorkerScriptRunner,
    private readonly onProblem: (why: string) => void,
    checkMs = 2000,
  ) {
    this.checked = this.selfCheck(checkMs);
  }

  get kind(): 'thread' | 'workers' {
    return this.fellBack ? 'thread' : 'workers';
  }

  get usingWorkers(): boolean {
    return !this.fellBack;
  }

  private async selfCheck(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const out = await Promise.race([
        this.pool.runScript(`tp.variables.set('ping', 1)`, { variables: {} }, { timeoutMs: ms }),
        new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`no answer within ${ms} ms`)), ms))),
      ]);
      if (out.error || out.vars.ping !== 1) throw new Error(out.error ?? 'the round trip returned the wrong answer');
    } catch (e) {
      this.fellBack = true;
      this.onProblem(`The script worker pool did not start (${(e as Error).message}); scripts run in the main thread.`);
      void this.pool.dispose().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  private async active(): Promise<ScriptRunner> {
    await this.checked;
    return this.fellBack ? threadScriptRunner : this.pool;
  }

  async runScript(code: string, input: ScriptInput, opts?: ScriptOptions): Promise<ScriptOutput> {
    return (await this.active()).runScript(code, input, opts);
  }

  async evaluateExpression(expr: string, input: ExpressionInput, opts?: { timeoutMs?: number; memoryMb?: number }) {
    return (await this.active()).evaluateExpression(expr, input, opts);
  }

  async renderTemplate(template: string, data: unknown, opts?: Parameters<ScriptRunner['renderTemplate']>[2]) {
    return (await this.active()).renderTemplate(template, data, opts);
  }

  async runMetricScript(code: string, sample: unknown, opts?: Parameters<ScriptRunner['runMetricScript']>[2]) {
    return (await this.active()).runMetricScript(code, sample, opts);
  }

  async dispose(): Promise<void> {
    await this.pool.dispose();
  }
}
