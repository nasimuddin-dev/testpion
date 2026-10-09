/**
 * The flow blocks beyond requests: conditions (`if:` on any step, `type: condition` with true/false branches), loops
 * (`repeat: N`, `forEach:` a list or a dataset), script steps, sub-flows (`type: flow`), log steps and a file's
 * `output:`. The runner (runner.ts) asks here whether a step runs and runs it through executeStep; execute.ts runs
 * the blocks' own types with the functions below. A file runs the same in the app, the CLI, CI, monitors and MCP.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { CheckResult, ConditionTest, FlowTest, LogTest, ScriptTest, TestCase, TestResult, TestStatus } from '../model/types.js';
import { ApsError } from '../errors.js';
import type { VariableScope } from '../vars/variables.js';
import type { SpanHandle, Tracer } from '../trace/tracer.js';
import type { CheckContext } from '../eval/checks.js';
import { evaluateExpression, runScript, type ScriptInput, type ScriptRequestSender } from '../scripts/sandbox.js';
import { applyScriptOutput, scriptScopes } from '../scripts/bridge.js';
import { parseYaml } from '../util/lazy-yaml.js';
import { readDataset } from './datasets.js';
import { dbKindOf } from './db-datasets.js';
import { loadTestsFromFile, MAX_ITERATIONS } from './loader.js';
import { executeTest, type ExecServices, type ExecutionOutcome } from './execute.js';
import { runTests } from './runner.js';

/** How deep sub-flows may nest (a flow running a flow running a flow …). */
export const MAX_FLOW_DEPTH = 5;
/** The longest an `if:` expression may compute. */
export const EXPRESSION_TIMEOUT_MS = 250;

/** A step's response as the next step's `if:` sees it. */
export interface StepResponse {
  status?: number;
  headers?: Array<[string, string]>;
  body?: unknown;
  text?: string;
}

export type BlockRunner = Promise<{ ctx: CheckContext; partial: Partial<ExecutionOutcome>; metadata?: Record<string, unknown>; checks?: CheckResult[] }>;

const summarize = (v: unknown, n = 4000): string => {
  const s = typeof v === 'string' ? v : (JSON.stringify(v, null, 2) ?? '');
  return s.length > n ? s.slice(0, n) + `… [${s.length - n} more chars]` : s;
};

/* ------------------------------------------------------------------ if: and conditions */

/** The expression with each {{variable}} replaced by its value as a JavaScript literal (undefined when it has none). */
export function expressionWithVariables(expr: string, scope: VariableScope): string {
  return expr.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole) => {
    const v = scope.resolveDeep(whole);
    return v === whole ? 'undefined' : (JSON.stringify(v) ?? 'undefined');
  });
}

/** Evaluate an `if:` expression over the variables and the previous step's response: true or false; throws when it cannot be evaluated. */
export async function evaluateCondition(expr: string, scope: VariableScope, prev?: StepResponse): Promise<boolean> {
  const headers: Record<string, string> = {};
  for (const [k, v] of prev?.headers ?? []) headers[k.toLowerCase()] = v;
  const r = await evaluateExpression(
    expressionWithVariables(expr, scope),
    { status: prev?.status, headers, body: prev?.body, text: prev?.text, vars: scope.toObject() },
    { timeoutMs: EXPRESSION_TIMEOUT_MS },
  );
  if (r.error) throw new ApsError('ScriptError', `if: ${expr} could not be evaluated: ${r.error}`);
  return !!r.value;
}

export async function runCondition(test: ConditionTest, scope: VariableScope, span: SpanHandle, prev?: StepResponse): BlockRunner {
  const s = span.child('condition', 'internal', { input: test.if });
  const result = await evaluateCondition(test.if, scope, prev).catch((e) => {
    s.fail(e);
    throw e;
  });
  s.end({ output: result });
  return {
    ctx: { testType: 'condition', body: { result }, text: String(result) },
    partial: { input: test.if, output: String(result) },
    metadata: { condition: result, expression: test.if },
  };
}

/* ------------------------------------------------------------------ script and log steps */

export async function runScriptStep(test: ScriptTest, scope: VariableScope, svc: ExecServices, extra: { sendRequest: ScriptRequestSender; info: ScriptInput['info'] }): BlockRunner {
  const s = await runScript(test.script, { ...scriptScopes(scope, test.variables), info: extra.info }, { sendRequest: extra.sendRequest, requirePackage: svc.scriptPackage });
  applyScriptOutput(s, [scope, svc.vars], { redactor: svc.redactor, persist: svc.persistVariable });
  if (s.error) throw new ApsError('ScriptError', `Script failed: ${s.error}`);
  const set = { ...s.vars, ...s.scopeSets.environment, ...s.scopeSets.collectionVariables, ...s.scopeSets.globals };
  const checks: CheckResult[] = s.tests.map((t) => ({ type: 'script', name: t.name, passed: t.passed, source: 'deterministic', message: t.message ?? (t.passed ? 'passed' : 'failed') }));
  return {
    ctx: { testType: 'script', body: svc.redactor.redact(set), text: s.logs.join('\n') },
    partial: { input: summarize(test.script, 1000), output: summarize(svc.redactor.redact(set)) },
    metadata: { ...(s.logs.length ? { scriptLogs: s.logs.slice(0, 100) } : {}), setVariables: Object.keys(set) },
    checks,
  };
}

export async function runLog(test: LogTest, scope: VariableScope, svc: ExecServices): BlockRunner {
  const message = svc.redactor.redactString(scope.resolve(test.message));
  svc.logger?.info(`[log] ${message}`);
  return { ctx: { testType: 'log', body: message, text: message }, partial: { output: summarize(message) }, metadata: { message: summarize(message) } };
}

/* ------------------------------------------------------------------ output: and sub-flows */

/** The `output:` map of a test file (what the flow returns), undefined when it declares none. */
export function readFlowOutput(file: string): Record<string, unknown> | undefined {
  let data: unknown;
  try {
    const text = readFileSync(file, 'utf8');
    data = extname(file).toLowerCase() === '.json' ? JSON.parse(text) : parseYaml(text);
  } catch {
    return undefined;
  }
  const out = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).output : undefined;
  return out && typeof out === 'object' && !Array.isArray(out) ? (out as Record<string, unknown>) : undefined;
}

/** The output's templates resolved with the flow's variables after its run. */
export function resolveOutput(output: Record<string, unknown>, vars: VariableScope): Record<string, unknown> {
  return Object.fromEntries(Object.entries(output).map(([k, v]) => [k, vars.resolveDeep(v)]));
}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Where a sub-flow's file is: relative to the calling file, else inside the workspace's tests/ (or the current folder). */
export function subFlowPath(ref: string, from?: string): string {
  if (isAbsolute(ref)) return ref;
  const near = from ? resolve(dirname(from), ref) : resolve(ref);
  if (existsSync(near)) return near;
  const p = (from ?? '').split(sep).join('/');
  const i = p.lastIndexOf('/tests/');
  if (i >= 0) {
    const inTests = resolve(p.slice(0, i + 7), ref.replace(/^tests[\\/]/, ''));
    if (existsSync(inTests)) return inTests;
  }
  return near;
}

const shortName = (abs: string) => {
  const p = abs.split(sep).join('/');
  const i = p.lastIndexOf('/tests/');
  return i >= 0 ? p.slice(i + 7) : relative(process.cwd(), abs).split(sep).join('/') || p;
};

export async function runSubFlow(test: FlowTest, scope: VariableScope, svc: ExecServices, span: SpanHandle, signal: AbortSignal): BlockRunner {
  const target = subFlowPath(test.flowFile, test.file);
  const chain = svc.flowStack ?? (test.file ? [resolve(test.file)] : []);
  if (chain.some((f) => samePath(f, target)))
    throw new ApsError('ConfigurationError', `Sub-flow cycle: ${[...chain, target].map(shortName).join(' → ')}. A flow cannot run itself, directly or through another flow.`, {
      suggestions: ['Move the steps both flows need into a third file and run that one from each.'],
    });
  if (chain.length > MAX_FLOW_DEPTH)
    throw new ApsError('ConfigurationError', `Sub-flows nest at most ${MAX_FLOW_DEPTH} deep: ${[...chain, target].map(shortName).join(' → ')}`, {
      suggestions: ['Flatten the flows: run the innermost ones from a flow higher up.'],
    });
  if (!existsSync(target)) throw new ApsError('ConfigurationError', `No such flow file: ${test.flowFile} (looked for ${shortName(target)})`);
  const inputs = scope.resolveDeep(test.inputs ?? {});
  const vars = svc.vars.clone();
  for (const [k, v] of Object.entries(inputs)) vars.set(k, v, 'runtime');
  const before = vars.scopeValues('runtime');
  const steps: Array<{ name: string; status: TestStatus; durationMs: number; error?: string }> = [];
  const s = span.child(`flow ${shortName(target)}`, 'internal', { input: svc.redactor.redact(inputs) });
  const summary = await runTests({
    name: `sub-flow ${shortName(target)}`,
    tests: loadTestsFromFile(target),
    services: { ...svc, vars, flowStack: [...chain, target], pinned: undefined },
    concurrency: 1,
    signal,
    traceMode: 'none',
    onEvent: (e) => {
      if (e.type === 'test-end') steps.push(stepOf(e.result));
    },
  });
  if (signal.aborted) {
    s.fail(new Error('cancelled'));
    throw new ApsError('CancelledError', 'Run cancelled');
  }
  const declared = readFlowOutput(target);
  let values: Record<string, unknown>;
  if (declared) values = resolveOutput(declared, vars);
  else {
    // without output: the values the sub-flow extracted or set
    values = {};
    for (const [k, v] of Object.entries(vars.scopeValues('runtime'))) if (!(k in inputs) && (!(k in before) || before[k] !== v)) values[k] = v;
  }
  for (const [k, v] of Object.entries(values)) {
    svc.vars.set(k, v, 'runtime');
    scope.set(k, v, 'runtime');
  }
  const bad = steps.filter((x) => x.status === 'failed' || x.status === 'error');
  s.end({ status: bad.length ? 'error' : 'ok', output: svc.redactor.redact(values) });
  return {
    ctx: { testType: 'flow', body: values, text: JSON.stringify(values) },
    partial: { input: `${shortName(target)}${Object.keys(inputs).length ? ` (${Object.keys(inputs).join(', ')})` : ''}`, output: summarize(svc.redactor.redact(values)) },
    metadata: { flow: shortName(target), steps: steps.slice(0, 200), passed: summary.passed, failed: summary.failed, errors: summary.errors, skipped: summary.skipped, values: Object.keys(values) },
    checks: [
      {
        type: 'sub-flow',
        name: 'sub-flow steps',
        passed: !bad.length,
        source: 'deterministic',
        message: bad.length
          ? `${bad.length} of ${steps.length} steps did not pass: ${bad.map((x) => `${x.name} (${x.status}${x.error ? `: ${x.error}` : ''})`).join('; ')}`
          : `${steps.length} steps: ${summary.passed} passed, ${summary.skipped} skipped`,
      },
    ],
  };
}

function stepOf(r: TestResult) {
  return {
    name: r.name,
    status: r.status,
    durationMs: r.durationMs,
    ...(r.error
      ? { error: r.error.message }
      : r.checks.some((c) => !c.passed)
        ? {
            error: r.checks
              .filter((c) => !c.passed)
              .map((c) => `${c.name}: ${c.message}`)
              .join('; '),
          }
        : {}),
  };
}

/* ------------------------------------------------------------------ loops */

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

/** A label for the loop of a step: "× 3", "× each row of datasets/users.csv" (undefined without a loop). */
export function loopLabel(t: Pick<TestCase, 'repeat' | 'forEach'>): string | undefined {
  if (t.repeat !== undefined) return `× ${t.repeat}`;
  if (Array.isArray(t.forEach)) return `× ${t.forEach.length}`;
  if (t.forEach && typeof t.forEach === 'object') return `× each row of ${t.forEach.dataset}`;
  return undefined;
}

/**
 * Run a step: once, or once per iteration of its `repeat:` / `forEach:` with the row's fields, `$index` and `$item` as
 * its variables. Iterations run in order; the run's cancel stops between them. What the last iteration extracts
 * flows on; the result lists each iteration (metadata.iterationResults) and says how many passed.
 */
export async function executeStep(test: TestCase, svc: ExecServices, opts: { tracer: Tracer; signal?: AbortSignal; prev?: StepResponse }): Promise<ExecutionOutcome> {
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
