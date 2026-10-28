import { join } from 'node:path';
import type { AppSettings, Collection, CollectionNode, HttpRequestSpec, TestResult } from '../../model/types.js';
import { ApsError } from '../../errors.js';
import type { Redactor } from '../../util/redact.js';
import { shortId } from '../../util/ids.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import type { SecretStore } from '../../storage/secrets.js';
import { aiRunDeps, runAiTask } from '../../ai/tasks/run.js';
import type { Proposal } from '../../ai/proposal.js';
import { createEngineContext, type ContextOptions, type EngineContext } from '../../engine.js';
import { runTests, type RunEvent } from '../../runner/runner.js';
import { resultSourceRefs } from '../../runner/result-source.js';
import { recordRun } from '../../runner/run-records.js';
import { detectRequestSnippet, parseRequestSnippet } from '../../import/snippet.js';

/** What the tools share (the server builds them once per workspace): flattening a collection, finding a request, clipping text, reading a request from a snippet, summarizing and recording runs. */
const BODY_CHARS = 20_000;

export type Flat = { node: Exclude<CollectionNode, { kind: 'folder' }>; folder: string };

export const flatten = (nodes: CollectionNode[], path: string[] = []): Flat[] => nodes.flatMap((n) => (n.kind === 'folder' ? flatten(n.items, [...path, n.name]) : [{ node: n, folder: path.join(' / ') }]));

export const findRequestIn = (c: Collection, ref: unknown): Flat => {
  const all = flatten(c.items);
  const r = String(ref ?? '').toLowerCase();
  const f = all.find((x) => x.node.id.toLowerCase() === r) ?? all.find((x) => x.node.name.toLowerCase() === r);
  if (!f) throw new ApsError('ConfigurationError', `No request "${String(ref)}" in "${c.name}"`);
  return f;
};

/** The id of the folder or request a tool's `folder` argument names (by id or name, anywhere in the collection), as a selection; undefined when none is given. */
export const folderSelection = (c: Collection, folder: unknown): string[] | undefined => {
  if (!folder) return undefined;
  const r = String(folder).toLowerCase();
  const all: CollectionNode[] = [];
  const walk = (nodes: CollectionNode[]) => nodes.forEach((n) => (all.push(n), n.kind === 'folder' && walk(n.items)));
  walk(c.items);
  const n = all.find((x) => x.id.toLowerCase() === r) ?? all.find((x) => x.name.toLowerCase() === r);
  if (!n) throw new ApsError('ConfigurationError', `No folder or request "${String(folder)}" in "${c.name}"`);
  return [n.id];
};

export const clip =(t: string) => (t.length > BODY_CHARS ? `${t.slice(0, BODY_CHARS)}… [${t.length - BODY_CHARS} more characters]` : t);

/** A request from `snippet` (cURL / fetch / PowerShell) or from method + url + headers + body. */
export const requestFrom = (a: Record<string, unknown>): { request: HttpRequestSpec; format?: string } => {
  if (typeof a.snippet === 'string' && a.snippet.trim()) {
    const format = detectRequestSnippet(a.snippet);
    if (!format) throw new ApsError('ValidationError', 'snippet is not a cURL, fetch or PowerShell (Invoke-WebRequest / Invoke-RestMethod) command');
    return { request: parseRequestSnippet(a.snippet), format };
  }
  if (!a.url) throw new ApsError('ValidationError', 'Give snippet, or url (+ method, headers, body)');
  const body = typeof a.body === 'string' && a.body ? { type: /^\s*[{[]/.test(a.body) ? ('json' as const) : ('text' as const), content: a.body } : undefined;
  return {
    request: {
      method: String(a.method ?? 'GET').toUpperCase(),
      url: String(a.url),
      headers: Object.entries((a.headers as Record<string, string>) ?? {}).map(([key, value]) => ({ key, value: String(value) })),
      body,
    },
  };
};

/** A test result as the tools show it (where it came from, its failed checks, the scripts' logs and the visualizer's page). */
export function resultSummarizer(store: WorkspaceStore, redactor: Redactor) {
  return (r: TestResult) => ({
    name: r.name,
    // where it came from (its test file at the step): run_tests with paths [ref.path] and step [ref.step] runs it again
    ...(() => {
      const ref = resultSourceRefs(store, r)[0];
      return ref ? { ref } : {};
    })(),
    status: r.status,
    latencyMs: r.latencyMs,
    url: (r.metadata as { url?: string } | undefined)?.url,
    error: r.error?.message,
    failedChecks: r.checks.filter((c) => !c.passed).map((c) => `${c.name ?? c.type}: ${c.message ?? 'failed'}`),
    passedChecks: r.checks.filter((c) => c.passed).length,
    // console.log output of the scripts and the tp.visualizer rendering, when there is one
    scriptLogs: (r.metadata as { scriptLogs?: string[] } | undefined)?.scriptLogs?.map((l) => redactor.redactString(l)),
    visualization: (r.metadata as { visualizer?: { html?: string; error?: string } } | undefined)?.visualizer,
  });
}

/**
 * A run recorded like the app's (runs/<id>/results.jsonl, summary.json, the history): the tests, run with the
 * engine, their results written as they finish; the first 200 come back summarized. run_tests and run_evaluation.
 */
export function runRecorder(d: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings }, summarizeResult: ReturnType<typeof resultSummarizer>) {
  const { store, secrets, settings } = d;
  return async (environment: string | undefined, o: { name: string; tests: Parameters<typeof runTests>[0]['tests']; concurrency: number; retries?: number; plan?: Pick<Parameters<typeof runTests>[0], 'onlyIds' | 'seed'> }) => {
    const ctx = createEngineContext({ store, secrets, settings, environment, aiSurface: 'mcp' });
    const runId = shortId('run-');
    const outDir = store.runDir(runId);
    const results: TestResult[] = [];
    try {
      const summary = await runTests({
        name: o.name,
        runId,
        tests: o.tests,
        services: ctx.services,
        concurrency: o.concurrency,
        ...(o.retries !== undefined ? { retries: o.retries } : {}),
        resultsFile: join(outDir, 'results.jsonl'),
        traceMode: 'none',
        environment,
        ...(o.plan ?? {}),
        onEvent: (e: RunEvent) => void (e.type === 'test-end' && results.push(e.result)),
      });
      await recordRun(store, summary, outDir);
      return { summary, runId, ref: { kind: 'run' as const, runId }, environment: environment ?? null, total: summary.total, passed: summary.passed, failed: summary.failed, errors: summary.errors, durationMs: summary.durationMs, results: results.slice(0, 200).map(summarizeResult) };
    } finally {
      await ctx.dispose();
    }
  };
}

/**
 * What the agent is told when `{{$env.NAME}}` was left unresolved because the person has not allowed that OS variable (the MCP server
 * reads none by default: an API response must not be able to make an agent send the machine's secrets anywhere).
 */
export function blockedEnvNotice(blocked: Iterable<string>): { blockedEnvVariables: string[]; envNotice: string } | undefined {
  const names = [...blocked];
  if (!names.length) return undefined;
  const list = names.map((n) => `{{$env.${n}}}`).join(', ');
  return {
    blockedEnvVariables: names,
    envNotice: `${list} was not resolved: this server may not read OS environment variables the person has not allowed. To allow ${names.length === 1 ? 'it' : 'them'}, the person adds ${names.map((n) => `"${n}"`).join(', ')} to Settings > Privacy (setting envVariables), or runs: testpion settings set envVariables ${names.join(',')}. set_settings can do it too, but only with the person's approval; do not work around this.`,
  };
}

/** An engine context for one tool call, disposed when it ends (the one place the create / try / finally dispose is written). */
export async function withEngine<T>(d: { store: WorkspaceStore; secrets: SecretStore; settings?: AppSettings }, o: Omit<ContextOptions, 'store' | 'secrets' | 'settings'>, fn: (ctx: EngineContext) => Promise<T> | T): Promise<T> {
  const ctx = createEngineContext({ ...d, ...o });
  try {
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
}

/** What an AI task of the RAG tools made, as the agent reads it: the model, usage and cost, the proposal with the items `shape.items` makes, and what to do next (a dry run returns what would be sent). */
export async function runRagProposal(
  d: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings },
  a: Record<string, unknown>,
  task: { task: string; question?: string; context: Record<string, unknown> },
  shape: { items: (p: Proposal) => unknown[]; next: (p: Proposal) => string },
): Promise<Record<string, unknown>> {
  const { store, settings } = d;
  return withEngine(d, { environment: a.environment ? String(a.environment) : undefined, aiSurface: 'mcp' }, async (ctx) => {
    const r = await runAiTask(aiRunDeps({ ctx, settings, store, surface: 'mcp' }), { ...task, dryRun: a.dry_run === true });
    if (r.dryRun) return { dryRun: true, preview: r.preview };
    const p = r.proposal;
    return {
      model: `${r.provider}/${r.model}`,
      usage: r.usage,
      costUsd: r.costUsd,
      problems: r.problems,
      ...(p ? { proposal: { id: p.id, title: p.title, summary: p.summary, assumptions: p.assumptions, notes: p.notes, items: shape.items(p) }, next: shape.next(p) } : {}),
    };
  });
}
