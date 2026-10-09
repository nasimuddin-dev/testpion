/** RPC handlers: Tests, suites, evaluations, runs, baselines, traces and load tests. */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  lintTestFile,
  reviewResult,
  reviewCounts,
  runReviews,
  testEditorGuide,
  evaluationTests,
  workspaceReportHtml,
  loadHistory,
  type SavedEvaluation,
  ApsError,
  compareToBaseline,
  createBaseline,
  loadSuite,
  loadTestsFromFile,
  isSuiteFile,
  ciConfig,
  type CiConfigOptions,
  type LoadTestConfig,
  type CheckConfig,
  exportOtlp,
  testFromRequest,
  type TestSource,
  evaluateThresholds,
  parseThreshold,
  testHistory,
  flakyTests,
  scoreTrend,
  latestResults,
  workspaceAttention,
  readRunSummary,
  compareRuns,
  flowOfFile,
  readExposure,
  setExposure,
  type FlowExposure,
} from '@testpion/core';
import type { Backend, Handlers, EvalRunParams } from '../backend.js';

export function testingHandlers(be: Backend): Handlers {
  return {
    'tests.tree': () => be.ws.testTree(),
    'tests.read': ({ path }: { path: string }) => be.ws.readTestFile(path),
    'tests.write': ({ path, content }: { path: string; content: string }) => be.ws.writeTestFile(path, content),
    /** What is wrong in a test file being edited (unknown keys, types, checks …), with positions, for the editor's markers. */
    'tests.lint': ({ content, path }: { content: string; path?: string }) => lintTestFile(content, { file: path, suite: !!path && isSuiteFile(path) }),
    /** The keys of test files, by context and type, with help: the editor's completion and hover. */
    'tests.guide': () => testEditorGuide(),
    /** Save as test: a request from the REST, GraphQL, gRPC or WebSocket view as tests/<kind>/<name>.yaml (a free name). */
    'tests.saveFrom': ({ name, source, assertions }: { name: string; source: TestSource; assertions?: CheckConfig[] }) => {
      const t = testFromRequest(name, source, assertions);
      let path = t.path;
      for (let i = 2; existsSync(be.ws.safePath(path, be.ws.path('tests'))); i++) path = t.path.replace(/\.yaml$/, `-${i}.yaml`);
      be.ws.writeTestFile(path, t.yaml);
      return { path };
    },
    'tests.delete': ({ path }: { path: string }) => be.ws.deleteTestFile(path),
    /** The expose: block of a test file or suite (the flow as an MCP tool), if any; a proposed tool name otherwise. */
    'tests.exposure': ({ path }: { path: string }) => {
      const text = be.ws.readTestFile(path);
      const suggested = path
        .replace(/\.suite\.(ya?ml|json)$|\.(ya?ml|json)$/i, '')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase()
        .replace(/^[^a-z]+/, '');
      return { expose: readExposure(text, path), suggested: suggested || 'flow' };
    },
    /** Write (or, with expose: null, remove) the expose: block of a test file or suite; the rest of the file stays as it is. */
    'tests.expose': ({ path, expose }: { path: string; expose: FlowExposure | null }) => {
      const next = setExposure(be.ws.readTestFile(path), expose ?? undefined);
      be.ws.writeTestFile(path, next);
      return { path, expose: readExposure(next, path) };
    },
    'tests.preview': async ({ path }: { path: string }) => {
      const out: Array<{ id?: string; name: string; type: string; tags?: string[] }> = [];
      const abs = join(be.ws.path('tests'), path);
      if (isSuiteFile(abs)) return { suite: await loadSuite(abs), tests: [] };
      for await (const t of loadTestsFromFile(abs)) {
        out.push({ id: t.id, name: t.name, type: t.type, tags: t.tags });
        if (out.length >= 500) break;
      }
      return { tests: out };
    },
    /** A test file as a flow: its steps (name, type, request line, extracted names, dependsOn) with the latest run's result of each. */
    'tests.flow': ({ file }: { file: string }) => flowOfFile(be.ws, file),
    /** A CI pipeline (GitHub Actions, GitLab CI, Azure Pipelines, Jenkins) for a suite, collection or test files. */
    'ci.config': (o: CiConfigOptions) => ciConfig(be.ws, o),
    'ci.save': (o: CiConfigOptions) => {
      const c = ciConfig(be.ws, o);
      const name = c.path.split('/').pop()!;
      return be.saveOrDownload(name, undefined, (dest) => writeFileSync(dest, c.content), () => Buffer.from(c.content));
    },
    'tests.run': (p: { paths: string[]; environment?: string; concurrency?: number; retries?: number; name?: string; grep?: string; tags?: string[] }) => be.startTestRun(p),
    /** Run again only the tests that failed or errored in a run. */
    'tests.rerunFailed': ({ runId, environment, concurrency, retries }: { runId: string; environment?: string; concurrency?: number; retries?: number }) => {
      const r = be.ws.failedTestIds(runId);
      if (!r.ids.length) throw new ApsError('ValidationError', 'Nothing failed in that run');
      return be.startTestRun({ paths: [], environment, concurrency, retries, name: `Failed tests of ${r.runId}`, ids: r.ids });
    },
    'eval.run': (p: EvalRunParams) => be.startEvalRun(p),
    /** Run an evaluation as edited in the app (saved or not): the same conversion as `testpion eval run`. */
    'eval.runDraft': ({ draft, environment }: { draft: SavedEvaluation; environment?: string }) =>
      be.startRun(draft.name || 'Evaluation', evaluationTests(draft), { environment, concurrency: draft.concurrency, retries: draft.retries, traceMode: 'all' }),
    'runs.cancel': ({ runId }: { runId: string }) => be.runs.get(runId)?.ctrl.abort(),
    'runs.list': (q: { query?: string; limit?: number; offset?: number }) => be.ws.meta.listRuns(q),
    'runs.breakdown': ({ runId }: { runId: string }) => be.runBreakdown(runId),
    // one test across the latest runs (by id, or by name), newest first
    // tests whose result keeps changing across the latest runs (or pass only after retries)
    // each evaluator's mean score run by run (oldest first)
    'runs.scoreTrend': ({ runIds, name, limit }: { runIds?: string[]; name?: string; limit?: number } = {}) => scoreTrend(be.ws, { runIds, name, limit }),
    // the latest result of each named test (the test file preview)
    'runs.latestResults': ({ names }: { names: string[] }) => latestResults(be.ws, names ?? []),
    'runs.flaky': ({ runs }: { runs?: number } = {}) => flakyTests(be.ws, { runs }),
    'runs.testHistory': ({ id, name, limit }: { id?: string; name?: string; limit?: number }) => testHistory(be.ws, { id, name }, { limit }),
    'runs.summary': ({ runId }: { runId: string }) => readRunSummary(be.ws, runId) ?? null,
    'runs.results': (q: { runId: string; offset?: number; limit?: number; status?: string; query?: string }) => be.pageResults(q),
    // a person's verdict on a result (good / bad and why), and how many were rated
    'runs.review': ({ runId, resultId, rating, note }: { runId: string; resultId: string; rating?: 'good' | 'bad' | null; note?: string | null }) => reviewResult(be.ws, runId, resultId, { rating, note }) ?? null,
    'runs.reviewCounts': ({ runId, total }: { runId: string; total: number }) => reviewCounts(runReviews(be.ws, runId), total),
    'runs.openReport': ({ runId, format }: { runId: string; format: 'html' | 'markdown' | 'junit' | 'json' }) => {
      const file = { html: 'report.html', markdown: 'report.md', junit: 'junit.xml', json: 'report.json' }[format];
      const p = join(be.ws.runDir(runId), file);
      if (!existsSync(p)) throw new ApsError('ConfigurationError', 'Report not found');
      if (be.host.openPath) {
        void be.host.openPath(p);
        return { path: p };
      }
      // no desktop shell (browser, cloud): the UI shows the report itself
      return { path: p, view: { name: file, content: readFileSync(p).toString('base64'), encoding: 'base64', type: format === 'html' ? 'text/html' : 'text/plain' } };
    },
    'runs.exportReport': async ({ runId, format }: { runId: string; format: 'html' | 'markdown' | 'junit' | 'json' }) => {
      const file = { html: 'report.html', markdown: 'report.md', junit: 'junit.xml', json: 'report.json' }[format];
      const src = join(be.ws.runDir(runId), file);
      return be.saveOrDownload(file, undefined, (dest) => copyFileSync(src, dest), () => readFileSync(src));
    },
    /** The workspace report (activity, collection health, monitors, runs) as one HTML file, saved where the user picks. */
    'report.workspace': async ({ days, tzOffsetMin }: { days?: number; tzOffsetMin?: number } = {}) => {
      const text = workspaceReportHtml(be.ws, { days, tzOffsetMin, attention: await workspaceAttention(be.ws) });
      const name = `${be.ws.workspace.name.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'workspace'}-report.html`;
      return be.saveOrDownload(name, [{ name: 'HTML', extensions: ['html'] }], (dest) => writeFileSync(dest, text), () => Buffer.from(text));
    },
    'baselines.list': () => be.ws.listBaselines(),
    'baselines.save': async ({ runId, name }: { runId: string; name: string }) => {
      const summary = await be.handlers['runs.summary']!({ runId });
      const b = await createBaseline(name, summary as never, be.results(runId));
      be.ws.saveBaseline(b);
      return { name, tests: Object.keys(b.tests).length };
    },
    /** Compare a run with a saved baseline (`name`) or with an earlier run (`withRun`, used as the baseline). */
    'baselines.compare': async ({ runId, name, withRun, thresholds }: { runId: string; name?: string; withRun?: string; thresholds?: { latencyPct: number; tokensPct: number; scoreDrop: number } }) => {
      if (withRun) return compareRuns(be.ws, withRun, runId, thresholds);
      const summary = await be.handlers['runs.summary']!({ runId });
      return compareToBaseline(be.ws.getBaseline(String(name)), summary as never, be.results(runId), thresholds);
    },

    'traces.list': (q: { query?: string; kind?: string; failed?: boolean; limit?: number; offset?: number }) => be.ws.meta.listTraces(q),
    'traces.get': ({ id }: { id: string }) => be.ws.loadTrace(id),
    /** Send traces to an OpenTelemetry collector (OTLP/HTTP JSON). Header values may use {{variables}} (e.g. a secret API key). */
    'traces.exportOtlp': async ({ ids, endpoint, headers, environment }: { ids: string[]; endpoint: string; headers?: Array<{ key: string; value: string; enabled?: boolean }>; environment?: string }) => {
      if (!ids?.length) throw new ApsError('ValidationError', 'No traces to send');
      const ctx = be.context({ environment });
      try {
        const traces = ids.slice(0, 2000).map((id) => be.ws.loadTrace(id)).filter((t): t is NonNullable<typeof t> => !!t);
        const h = Object.fromEntries(ctx.vars.resolveDeep(headers ?? []).filter((x) => x.key && x.enabled !== false).map((x) => [x.key, x.value]));
        return await exportOtlp(traces, { endpoint: ctx.vars.resolve(endpoint), headers: h }, { redactor: ctx.redactor, resource: { 'testpion.workspace': be.ws.workspace.name } });
      } finally {
        await ctx.dispose();
      }
    },

    'load.start': (p: { config: LoadTestConfig; environment?: string; collection?: { collectionId: string; selection?: string[]; warmUp?: boolean } }) => be.startLoad(p),
    'load.stop': ({ id }: { id: string }) => be.controllers.get(id)?.abort(),
    /** Finished load tests, newest first (one saved load test's with savedId). */
    'load.history': (q: { savedId?: string; query?: string; limit?: number } = {}) => loadHistory(be.ws, q),
    /** Pass/fail rules ("p95<500", "errors<1%") against a finished load test's numbers. */
    'load.thresholds': ({ rules, snapshot }: { rules: string[]; snapshot: Parameters<typeof evaluateThresholds>[1] }) => evaluateThresholds(rules, snapshot),
    'load.parseThreshold': ({ rule }: { rule: string }) => parseThreshold(rule),
  };
}
