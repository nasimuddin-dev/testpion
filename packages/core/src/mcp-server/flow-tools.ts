/**
 * Flows as MCP tools: every test file or suite under tests/ with an `expose:` block becomes one tool of the TestPion
 * MCP server, named after `expose.tool`, taking the flow's `inputs` as arguments. Calling it runs the flow with the
 * arguments as runtime variables (over the chosen or default environment), records the run like run_tests and
 * returns each step's result and the values the flow extracted; `isError` when a step failed or errored.
 * list_flows lists them. Agents see new or changed flows after they reconnect (the tools are read at server start).
 */
import { dirname, join } from 'node:path';
import type { AppSettings, TestCase, TestResult } from '../model/types.js';
import { ApsError } from '../errors.js';
import { createEngineContext } from '../engine.js';
import { exposedFlows, inputRequired, type ExposedFlow } from '../runner/exposed-flows.js';
import { loadSuite, loadTestsFromFile, streamTests } from '../runner/loader.js';
import { recordRun } from '../runner/run-records.js';
import { readFlowOutput, resolveOutput } from '../runner/flow-blocks.js';
import { runTests, type RunEvent } from '../runner/runner.js';
import type { SecretStore } from '../storage/secrets.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { Redactor } from '../util/redact.js';
import { shortId } from '../util/ids.js';
import { str, type Tool } from './tool.js';

export interface FlowToolDeps {
  store: WorkspaceStore;
  secrets: SecretStore;
  settings: AppSettings;
  redactor: Redactor;
  /** The environment's name when it exists and may be sent to (the server's rule), undefined for none. */
  checkEnvironment(name: unknown): string | undefined;
}

/** What a flow tool returns: the run, each step, and the values the flow extracted. */
export interface FlowRunResult {
  runId: string;
  tool: string;
  file: string;
  environment?: string;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  durationMs: number;
  steps: Array<{ name: string; status: string; durationMs: number; error?: string; failedChecks?: string[] }>;
  /** Variables the steps extracted (extract:), minus the inputs; sensitive names are masked. */
  extracted: Record<string, unknown>;
  /** What the flow declares it returns (its `output:`), resolved after the run; sensitive names are masked. */
  output?: Record<string, unknown>;
  /** True when a step failed or errored (the MCP result is then marked isError). */
  isError?: boolean;
}

/** The tool's input schema: one property per input (its description and default), plus the environment. */
export function flowInputSchema(flow: Pick<ExposedFlow, 'inputs'>): Tool['inputSchema'] {
  const properties: Record<string, unknown> = {};
  for (const i of flow.inputs)
    properties[i.name] = { type: 'string', description: i.description ?? `The {{${i.name}}} variable of the flow`, ...(i.default !== undefined ? { default: i.default } : {}) };
  properties.environment = str("Environment to run with (default: the suite's, else none)");
  const required = flow.inputs.filter(inputRequired).map((i) => i.name);
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

/** Run an exposed flow with the tool's arguments: a recorded run, its steps and the extracted values. */
export async function runFlow(deps: FlowToolDeps, flow: ExposedFlow, args: Record<string, unknown>): Promise<FlowRunResult> {
  const { store, secrets, settings, redactor } = deps;
  const abs = join(store.path('tests'), flow.file);
  const inputs: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const i of flow.inputs) {
    const v = args[i.name];
    if (v !== undefined && v !== null && v !== '') inputs[i.name] = v;
    else if (i.default !== undefined) inputs[i.name] = i.default;
    else if (inputRequired(i)) missing.push(i.name);
  }
  if (missing.length) throw new ApsError('ValidationError', `${flow.tool} needs ${missing.join(', ')}`);
  const suite = flow.kind === 'suite' ? await loadSuite(abs) : undefined;
  const environment = deps.checkEnvironment(args.environment ?? suite?.environment);
  const tests: AsyncIterable<TestCase> = suite ? streamTests(suite.tests, dirname(abs), suite.tags?.length ? { tags: suite.tags } : undefined) : loadTestsFromFile(abs);
  const ctx = createEngineContext({ store, secrets, settings, environment, runtimeVars: inputs });
  const runId = shortId('run-');
  const outDir = store.runDir(runId);
  const results: TestResult[] = [];
  try {
    const summary = await runTests({
      name: `${flow.tool} (${flow.file})`,
      runId,
      tests,
      services: ctx.services,
      concurrency: suite?.concurrency ?? 1,
      ...(suite?.retries !== undefined ? { retries: suite.retries } : {}),
      ...(suite?.timeoutMs !== undefined ? { timeoutMs: suite.timeoutMs } : {}),
      resultsFile: join(outDir, 'results.jsonl'),
      traceMode: 'none',
      environment,
      onEvent: (e: RunEvent) => void (e.type === 'test-end' && results.push(e.result)),
    });
    await recordRun(store, summary, outDir);
    const extracted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ctx.vars.scopeValues('runtime'))) if (!(k in inputs)) extracted[k] = redactor.isSensitiveKey(k) ? '***' : typeof v === 'string' ? redactor.redactString(v) : v;
    const declared = readFlowOutput(abs);
    const output = declared
      ? Object.fromEntries(Object.entries(resolveOutput(declared, ctx.vars)).map(([k, v]) => [k, redactor.isSensitiveKey(k) ? '***' : typeof v === 'string' ? redactor.redactString(v) : redactor.redact(v)]))
      : undefined;
    const isError = summary.failed + summary.errors > 0;
    return {
      runId,
      tool: flow.tool,
      file: flow.file,
      ...(environment ? { environment } : {}),
      passed: summary.passed,
      failed: summary.failed,
      errors: summary.errors,
      skipped: summary.skipped,
      durationMs: summary.durationMs,
      steps: results.map((r) => ({
        name: r.name,
        status: r.status,
        durationMs: r.durationMs,
        ...(r.error ? { error: r.error.message } : {}),
        ...(r.checks.some((c) => !c.passed) ? { failedChecks: r.checks.filter((c) => !c.passed).map((c) => `${c.name ?? c.type}: ${c.message ?? 'failed'}`) } : {}),
      })),
      extracted,
      ...(output ? { output } : {}),
      ...(isError ? { isError: true } : {}),
    };
  } finally {
    await ctx.dispose();
  }
}

/** list_flows, and one tool per exposed flow of the workspace (read now: new flows need a reconnect). */
export function flowTools(deps: FlowToolDeps): Tool[] {
  const list: Tool = {
    name: 'list_flows',
    description:
      'The flows (test files and suites under tests/ with an expose: block) this server offers as tools of their own: each with its tool name, description, file and inputs. Call a flow by its tool name with its inputs as arguments; a flow added or changed since the server started appears after a reconnect.',
    inputSchema: { type: 'object', properties: {} },
    run: () => exposedFlows(deps.store),
  };
  const dynamic = exposedFlows(deps.store)
    .filter((f) => !f.problem)
    .map((f): Tool => ({
      name: f.tool,
      write: true,
      description: `${f.description ?? `Run the flow ${f.file}`} (a TestPion flow: tests/${f.file}). Runs its steps with the arguments as variables and returns each step's status, the values it extracted and its declared output; the run is recorded in the workspace history.`,
      inputSchema: flowInputSchema(f),
      run: (a) => runFlow(deps, f, a),
    }));
  return [list, ...dynamic];
}
