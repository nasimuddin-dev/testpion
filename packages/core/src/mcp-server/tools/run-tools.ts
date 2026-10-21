import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createEngineContext } from '../../engine.js';
import { ApsError } from '../../errors.js';
import { assertEvaluationRunnable } from '../../eval/rag/preflight.js';
import type { CollectionNode, TestResult } from '../../model/types.js';
import { collectionRealtimeTests } from '../../runner/collection-realtime.js';
import { runCollection } from '../../runner/collection-run.js';
import { readDataset, type DatasetRecord } from '../../runner/datasets.js';
import { dbKindOf } from '../../runner/db-datasets.js';
import { webhookFlows } from '../../runner/flow-webhook-config.js';
import { isSuiteFile, streamTests } from '../../runner/loader.js';
import { compareRuns } from '../../runner/run-records.js';
import { breakdownOfRun, reviewResult, runResultsFile, runReviewReport } from '../../runner/run-results.js';
import type { RunEvent } from '../../runner/runner.js';
import { evaluationTests, findSavedEvaluation, listSavedEvaluations } from '../../runner/saved-evaluations.js';
import { lintTestFile } from '../../runner/test-schema.js';
import { shortId } from '../../util/ids.js';
import { planFlowRun } from '../flow-graph-tools.js';
import { str } from '../tool.js';
import type { Tool } from '../tool.js';
import type { ModuleToolDeps } from './deps.js';

/** Running collections, test files and evaluations, and reading runs. */
export function runTools(d: ModuleToolDeps): Tool[] {
  const { store, secrets, settings, findCollection, checkEnvironment, summarizeResult, recordedRun } = d;
  return [
    {
      name: 'run_collection',
      write: true,
      description:
        'Run a collection (or one folder) like the Collection Runner: requests in order with their scripts and assertions. Returns totals and per-request results. With `data` (a CSV / JSON / JSONL file or a SQLite database inside the workspace, plus `query` for SQLite) each row is one iteration ({{column}} in requests, tp.iterationData in scripts).',
      inputSchema: {
        type: 'object',
        properties: {
          collection: str('Collection name or id'),
          folder: str('Only run this folder or request (name or id)'),
          environment: str('Environment name'),
          data: str('Data file inside the workspace (relative path): .csv, .json, .jsonl, or a SQLite .db / .sqlite with `query`'),
          query: str('For a SQLite data file: one read-only SELECT whose rows are the iterations'),
          iterations: { type: 'number', description: 'How many iterations (default: one per data row, or 1)' },
        },
        required: ['collection'],
      },
      run: async (a) => {
        const environment = checkEnvironment(a.environment);
        const c = findCollection(a.collection);
        let selection: string[] | undefined;
        if (a.folder) {
          const r = String(a.folder).toLowerCase();
          const all: CollectionNode[] = [];
          const walk = (nodes: CollectionNode[]) => nodes.forEach((n) => (all.push(n), n.kind === 'folder' && walk(n.items)));
          walk(c.items);
          const n = all.find((x) => x.id.toLowerCase() === r) ?? all.find((x) => x.name.toLowerCase() === r);
          if (!n) throw new ApsError('ConfigurationError', `No folder or request "${String(a.folder)}" in "${c.name}"`);
          selection = [n.id];
        }
        // data files are read only from inside the workspace
        let data: DatasetRecord[] | undefined;
        if (a.data) {
          const database = !!dbKindOf(String(a.data)) || /^env:\w+$/.test(String(a.data));
          const file = database ? String(a.data) : store.safePath(String(a.data));
          if (!database && !existsSync(file)) throw new ApsError('ConfigurationError', `No data file ${String(a.data)} in the workspace`);
          data = [];
          for await (const r of readDataset({ path: file, query: a.query ? String(a.query) : undefined, limit: 10_000 })) data.push(r);
        }
        const iterations = a.iterations === undefined ? undefined : Math.min(Math.max(1, Math.floor(Number(a.iterations)) || 1), 1000);
        const ctx = createEngineContext({ store, secrets, settings, environment, collectionId: c.id });
        const results: TestResult[] = [];
        try {
          const summary = await runCollection({ name: c.name, runId: shortId('mcp-'), collection: c, selection, data, iterations, realtime: collectionRealtimeTests(store, c, selection), services: ctx.services, traceMode: 'none', environment, onEvent: (e: RunEvent) => e.type === 'test-end' && results.push(e.result) });
          return { environment: environment ?? null, total: summary.total, passed: summary.passed, failed: summary.failed, errors: summary.errors, skipped: summary.skipped, durationMs: summary.durationMs, results: results.slice(0, 200).map(summarizeResult) };
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'lint_tests',
      description:
        'Check test files for mistakes before running them: unknown test or check types, keys the runner does not read (typos, with the likely key), dependsOn ids nobody defines, methods that are not HTTP methods, tests the loader refuses. Each problem has a severity, a message and a line. Give `paths` (files or folders under tests/) or `content` (the text of one file) to check.',
      inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Test files or folders under tests/ (default: all)' }, content: str('The text of one test file to check instead of files') } },
      run: (a) => {
        if (typeof a.content === 'string') return { problems: lintTestFile(a.content) };
        const tests = store.path('tests');
        const files: string[] = [];
        const walk = (p: string) => {
          const abs = store.safePath(p, tests);
          if (!existsSync(abs)) throw new ApsError('ValidationError', `No such test file or folder: ${p}`);
          if (statSync(abs).isDirectory()) for (const e of readdirSync(abs).sort()) walk(join(p, e));
          else if (/\.(ya?ml|json)$/.test(abs)) files.push(abs);
        };
        for (const p of ((a.paths as string[] | undefined) ?? ['.']).map(String)) walk(p);
        const webhooks = webhookFlows(tests);
        const out = files.map((f) => ({ file: relative(tests, f).split(sep).join('/'), problems: lintTestFile(readFileSync(f, 'utf8'), { file: f, suite: isSuiteFile(f), webhooks }) })).filter((x) => x.problems.length);
        return { files: files.length, problems: out.reduce((n, x) => n + x.problems.length, 0), results: out };
      },
    },
    {
      name: 'list_tests',
      description: 'The test files under tests/ (YAML / JSON) with the tests in each: id, name, type and tags. Run them with run_tests.',
      inputSchema: { type: 'object', properties: { path: str('Only this file or folder inside tests/') } },
      run: async (a) => {
        const out: Array<{ file: string; tests: Array<{ id?: string; name: string; type: string; tags?: string[] }> }> = [];
        const base = store.path('tests');
        for await (const t of streamTests([a.path ? String(a.path) : '.'], base)) {
          const file = relative(base, t.file ?? '').replace(/\\/g, '/');
          let f = out.find((x) => x.file === file);
          if (!f) out.push((f = { file, tests: [] }));
          if (f.tests.length < 200) f.tests.push({ id: t.id, name: t.name, type: t.type, ...(t.tags?.length ? { tags: t.tags } : {}) });
          if (out.length > 300) break;
        }
        return out;
      },
    },
    {
      name: 'run_tests',
      write: true,
      description:
        'Run test files under tests/ (all, or given files / folders), filtered by name (grep) or tags, like `testpion test`. `rerunFailed: true` runs only the tests that failed in the last run (or give a run id). Returns totals and per-test results with failed checks; the run is recorded in the workspace history.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Files or folders inside tests/ (default: all)' },
          grep: str('Only tests whose name or id matches this regular expression'),
          tags: { type: 'array', items: { type: 'string' }, description: 'Only tests with one of these tags' },
          environment: str('Environment name'),
          rerunFailed: { anyOf: [{ type: 'boolean' }, { type: 'string' }], description: 'true: the failed tests of the last run; or a run id' },
          from: str('With one flow file in paths: run from this step (id or name) on, the steps before it taken from seedRunId (default: the latest run of the file); see flow_runs'),
          seedRunId: str('With one flow file in paths: the earlier run whose variables and responses seed the steps before `from`; alone, replays that run from its first failing step'),
          step: str("Only this test or step (its id: a result's ref.step), e.g. to run one result again"),
        },
      },
      run: async (a) => {
        const environment = checkEnvironment(a.environment);
        const rerun = a.rerunFailed ? store.failedTestIds(typeof a.rerunFailed === 'string' ? a.rerunFailed : 'last') : undefined;
        if (rerun && !rerun.ids.length) return { total: 0, message: `Nothing failed in ${rerun.runId}` };
        const paths = Array.isArray(a.paths) && a.paths.length ? (a.paths as unknown[]).map(String) : ['.'];
        const plan = a.from || a.seedRunId ? await planFlowRun(store, paths, a) : undefined;
        const { summary, ...run } = await recordedRun(environment, {
          name: rerun ? `Failed tests of ${rerun.runId}` : paths.join(', '),
          tests: streamTests(paths, store.path('tests'), { grep: a.grep ? String(a.grep) : undefined, tags: Array.isArray(a.tags) ? (a.tags as unknown[]).map(String) : undefined, ...(rerun ? { ids: rerun.ids } : a.step ? { ids: [String(a.step)] } : {}) }),
          concurrency: 4,
          ...(plan ? { plan: { onlyIds: plan.onlyIds, seed: plan.seed } } : {}),
        });
        return { ...run, skipped: summary.skipped, ...(plan ? { plan: plan.note } : {}) };
      },
    },
    {
      name: 'list_evaluations',
      description: 'Evaluations saved in the app (Evaluations ▸ Save): a dataset × prompt × model × evaluators. Returns id, name, folder, model, number of cases and evaluator types. Run one with run_evaluation.',
      inputSchema: { type: 'object', properties: {} },
      run: () => listSavedEvaluations(store),
    },
    {
      name: 'run_evaluation',
      write: true,
      description:
        'Run a saved evaluation by name or id, like `testpion eval run`: every dataset record through the model, scored by its evaluators (AI-judge scores are labelled as such). Returns totals, mean scores and per-case results with failed checks; the run is recorded in the workspace history. `limit` runs only the first n records (at most 500 here).',
      inputSchema: { type: 'object', properties: { name: str('Saved evaluation name or id'), environment: str('Environment name'), limit: { type: 'number', description: 'Only the first n dataset records' } }, required: ['name'] },
      run: async (a) => {
        const environment = checkEnvironment(a.environment);
        const saved = findSavedEvaluation(store, String(a.name ?? ''));
        const limit = Math.min(500, typeof a.limit === 'number' && a.limit > 0 ? a.limit : (saved.limit ?? 500));
        // a RAG evaluation: its target and judge are checked before any question is sent (the error says what to configure)
        if (saved.type === 'rag') {
          const pre = createEngineContext({ store, secrets, settings, environment, aiSurface: 'mcp' });
          try {
            assertEvaluationRunnable(store, pre.services.ragJudge!, saved);
          } finally {
            await pre.dispose();
          }
        }
        const { summary, ...run } = await recordedRun(environment, {
          name: saved.name,
          tests: evaluationTests({ ...saved, limit }, { store }),
          concurrency: Math.min(8, saved.concurrency || 4),
          retries: saved.retries ?? 0,
        });
        return { ...run, scores: summary.scores };
      },
    },
    {
      name: 'run_breakdown',
      description:
        'A finished run in detail (id from run_tests or the app): how many tests fell in each response-time range (passed and failed), results per test type, the slowest tests, flaky tests (passed only after a retry), the checks that failed most and, for AI evaluations, the score distribution of each evaluator. Use it to see why a run is slow or unstable.',
      inputSchema: { type: 'object', properties: { runId: str('Run id') }, required: ['runId'] },
      run: (a) => {
        if (!existsSync(runResultsFile(store, String(a.runId)))) throw new ApsError('ValidationError', `No finished run ${String(a.runId)}`);
        return breakdownOfRun(store, String(a.runId));
      },
    },
    {
      name: 'run_reviews',
      description:
        "A person's verdicts on a finished run's results (rated good or bad in the app, with a note): the counts, and each reviewed result with its status, checks' lowest score, rating and note. A bad rating on a passing result means the checks missed something; a good rating on a failing one means a check is too strict. Use it to improve tests and evaluators.",
      inputSchema: { type: 'object', properties: { runId: str('Run id') }, required: ['runId'] },
      run: (a) => runReviewReport(store, String(a.runId)),
    },
    {
      name: 'review_result',
      write: true,
      description:
        'Rate a result of a finished run good or bad, with a note (why), as the app\'s 👍 / 👎 does; rating null clears it. The review is marked as an agent\'s. Rate only after reading the result (its output and checks); people see the rating in the app.',
      inputSchema: {
        type: 'object',
        properties: {
          runId: str('Run id'),
          resultId: str('Result id (from run_reviews, run_tests or the run results)'),
          rating: { type: ['string', 'null'], enum: ['good', 'bad', null], description: 'good, bad, or null to clear' },
          note: str('Why (optional)'),
        },
        required: ['runId', 'resultId'],
      },
      run: (a) => ({
        review:
          reviewResult(store, String(a.runId), String(a.resultId), {
            rating: a.rating === undefined ? undefined : (a.rating as 'good' | 'bad' | null),
            note: a.note === undefined ? undefined : String(a.note),
            by: 'agent',
          }) ?? null,
      }),
    },
    {
      name: 'compare_runs',
      description:
        'What changed between two finished runs (ids from run_tests, run_collection results in the app, or list of runs): tests that started failing, tests that were fixed, tests that got slower beyond latencyPct (and, for AI tests, more tokens or a lower score), new and removed tests, and the change of totals (pass rate, latency percentiles, tokens, cost). `passed` is false when something regressed.',
      inputSchema: {
        type: 'object',
        properties: {
          before: str('Run id of the earlier run (the reference)'),
          after: str('Run id of the later run'),
          latencyPct: { type: 'number', description: 'A test counts as slower above this % (default 25)' },
        },
        required: ['before', 'after'],
      },
      run: (a) => compareRuns(store, String(a.before), String(a.after), { latencyPct: Number(a.latencyPct) || 25, tokensPct: 20, scoreDrop: 0.05 }),
    },
  ];
}
