import { join } from 'node:path';
import type { AppSettings, Collection, CollectionNode, HttpRequestSpec, TestResult } from '../../model/types.js';
import { ApsError } from '../../errors.js';
import type { Redactor } from '../../util/redact.js';
import { shortId } from '../../util/ids.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import type { SecretStore } from '../../storage/secrets.js';
import { createEngineContext } from '../../engine.js';
import { runTests, type RunEvent } from '../../runner/runner.js';
import { resultSourceRefs } from '../../runner/result-source.js';
import { recordRun } from '../../runner/run-records.js';
import { detectRequestSnippet, parseRequestSnippet } from '../../import/snippet.js';

/** What the tools share (the server builds them once per workspace): flattening a collection, finding a request, clipping text, reading a request from a snippet, summarizing and recording runs. */
export const BODY_CHARS = 20_000;

export type Flat = { node: Exclude<CollectionNode, { kind: 'folder' }>; folder: string };

export const flatten = (nodes: CollectionNode[], path: string[] = []): Flat[] => nodes.flatMap((n) => (n.kind === 'folder' ? flatten(n.items, [...path, n.name]) : [{ node: n, folder: path.join(' / ') }]));

export const findRequestIn = (c: Collection, ref: unknown): Flat => {
  const all = flatten(c.items);
  const r = String(ref ?? '').toLowerCase();
  const f = all.find((x) => x.node.id.toLowerCase() === r) ?? all.find((x) => x.node.name.toLowerCase() === r);
  if (!f) throw new ApsError('ConfigurationError', `No request "${String(ref)}" in "${c.name}"`);
  return f;
};

export const clip = (t: string) => (t.length > BODY_CHARS ? `${t.slice(0, BODY_CHARS)}… [${t.length - BODY_CHARS} more characters]` : t);

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
