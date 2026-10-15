/**
 * The third release's flow blocks at run time: Wait until (`until:` — a step run again until an expression holds on its
 * response, with an interval that grows by a backoff, a timeout and the tries in the result), Set variable (`type: set`
 * — values written to the run, environment, collection or global scope, kept like a script's tp.environment.set) and
 * Assert (`type: assert` — checks only, on the previous step's response or on the variables). Finally steps and
 * parallel groups are the runner's (runner.ts): they decide when a step runs, not what it does.
 */
import type { AssertTest, CheckResult, SetScope, SetTest, TestCase } from '../model/types.js';
import { ApsError } from '../errors.js';
import type { VariableScope } from '../vars/variables.js';
import type { Tracer } from '../trace/tracer.js';
import { applyScriptOutput } from '../scripts/bridge.js';
import type { ScriptScope } from '../scripts/sandbox.js';
import { sleep } from '../util/concurrency.js';
import { executeTest, type ExecServices, type ExecutionOutcome } from './execute.js';
import { evaluateCondition, type BlockRunner, type StepResponse } from './flow-blocks.js';

const summarize = (v: unknown, n = 4000): string => {
  const s = typeof v === 'string' ? v : (JSON.stringify(v, null, 2) ?? '');
  return s.length > n ? s.slice(0, n) + `… [${s.length - n} more chars]` : s;
};

/** 60000 → "60 s", 1500 → "1.5 s", 250 → "250 ms". */
export function durationLabel(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`;
}

/** The waits between the tries of a Wait until: every, every × backoff, … capped at maxEvery (the timeout cuts the last). */
export function untilWaits(u: NonNullable<TestCase['until']>, tries: number): number[] {
  const out: number[] = [];
  let w = u.everyMs;
  for (let i = 1; i < tries; i++) {
    out.push(Math.round(w));
    w = Math.min(u.maxEveryMs, w * u.backoff);
  }
  return out;
}

/* ------------------------------------------------------------------ Wait until */

/**
 * Run a step with `until:` until its expression is true on the step's response (and the variables, with what the try
 * extracted): the try that makes it true is the step's result, with `tries` and `waitedMs` in its metadata. When the
 * time is up the step fails with "condition not met within 60 s (n tries): last status …". The run's cancel stops the
 * wait at once. A pinned step is tried once (its response does not change).
 */
export async function executeUntil(test: TestCase, svc: ExecServices, opts: { tracer: Tracer; signal?: AbortSignal; prev?: StepResponse }): Promise<ExecutionOutcome> {
  const u = test.until!;
  const once = { ...test, until: undefined };
  const pinned = !!svc.pinned?.(test.id ?? test.name);
  const t0 = performance.now();
  let wait = u.everyMs;
  let tries = 0;
  let last: ExecutionOutcome | undefined;
  for (;;) {
    if (opts.signal?.aborted) throw new ApsError('CancelledError', 'Run cancelled');
    tries++;
    const o = await executeTest(once, svc, opts);
    last = o;
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

/* ------------------------------------------------------------------ Set variable */

const SCRIPT_SCOPE: Record<Exclude<SetScope, 'run'>, ScriptScope> = { environment: 'environment', collection: 'collectionVariables', global: 'globals' };

/**
 * Write the step's `set:` values (templates resolved) to its scope. The run scope is this run's variables; environment,
 * collection and global go to those scopes and are kept the way a script's tp.environment.set keeps them (the app's
 * current values, where a secret-looking value is stored as a secret; the CLI: this run only). The result shows each
 * name with its value redacted when it is (or holds) a secret.
 */
export async function runSet(test: SetTest, scope: VariableScope, svc: ExecServices): BlockRunner {
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(test.set)) {
    const name = k.trim();
    if (!name) continue;
    values[name] = scope.resolveDeep(v);
  }
  if (!Object.keys(values).length) throw new ApsError('ConfigurationError', 'set: names no variable to write');
  for (const [k, v] of Object.entries(values)) if (typeof v === 'string' && v && svc.redactor.isSensitiveKey(k)) svc.redactor.addSecret(v);
  const out = {
    vars: {} as Record<string, unknown>,
    unset: [] as string[],
    scopeSets: { environment: {}, globals: {}, collectionVariables: {} } as Record<ScriptScope, Record<string, unknown>>,
    scopeUnsets: { environment: [], globals: [], collectionVariables: [] } as Record<ScriptScope, string[]>,
  };
  if (test.scope === 'run') out.vars = values;
  else out.scopeSets[SCRIPT_SCOPE[test.scope]] = values;
  applyScriptOutput(out, [scope, svc.vars], { redactor: svc.redactor, persist: svc.persistVariable });
  const shown = svc.redactor.redact(values);
  const where = test.scope === 'run' ? 'this run' : `the ${test.scope} variables${svc.persistVariable ? '' : ' (this run only)'}`;
  return {
    ctx: { testType: 'set', body: shown, text: JSON.stringify(shown) },
    partial: { input: `${Object.keys(values).join(', ')} → ${where}`, output: summarize(shown) },
    metadata: { setVariables: Object.keys(values), scope: test.scope, persisted: test.scope !== 'run' && !!svc.persistVariable },
  };
}

/* ------------------------------------------------------------------ Assert */

/** An Assert step's subject: the previous step's response, or the variables (each check's path reads $.name). */
export async function runAssert(test: AssertTest, scope: VariableScope, prev: StepResponse | undefined): BlockRunner {
  if (test.subject === 'variables') {
    const vars = scope.toObject();
    return {
      ctx: { testType: 'assert', body: vars, text: JSON.stringify(vars) },
      partial: { input: `${test.assertions?.length ?? 0} checks on the variables`, output: `${Object.keys(vars).length} variables` },
      metadata: { subject: 'variables' },
    };
  }
  if (!prev)
    throw new ApsError(
      'ConfigurationError',
      'Nothing to check: no step before this one has a response (make it wait for the step whose response it checks, or check the variables: subject: variables)',
    );
  const text = prev.text ?? (typeof prev.body === 'string' ? prev.body : (JSON.stringify(prev.body) ?? ''));
  return {
    ctx: { testType: 'assert', status: prev.status, headers: prev.headers, body: prev.body, text },
    partial: { input: `${test.assertions?.length ?? 0} checks on the previous response${prev.status !== undefined ? ` (${prev.status})` : ''}` },
    metadata: { subject: 'response', ...(prev.status !== undefined ? { status: prev.status } : {}) },
  };
}
