/**
 * MCP tools for the metric side of RAG testing (the same engine functions as `testpion rag metrics|metric|run|rescore|
 * compare`): the catalogue, "try on one sample", the estimate before a run, a run with chosen metrics and gates, a re-score
 * of a finished run, and the comparison of two runs. An agent walks probe → metrics → estimate → run → compare
 * (the `evaluate_rag_system` prompt). A judged metric needs a judge: the evaluation's, or the AI settings' large model; a
 * run without one stops before the first question with what to configure.
 */
import type { RagTarget } from '@testpion/shared';
import { ApsError } from '../../errors.js';
import { createEngineContext } from '../../engine.js';
import { chooseRagRun, estimateRagEvaluation, estimateRescore, runRagEvaluation, type RagRunChoices } from '../../runner/rag-evaluation.js';
import { metricsOfRun, rescoreRun, storedSample } from '../../runner/rag-rescore.js';
import { runResults } from '../../runner/run-results.js';
import { findSavedEvaluation, judgeSetupOf } from '../../runner/saved-evaluations.js';
import { probeRagTarget } from '../../runner/rag-probe.js';
import { METRIC_GROUPS, metricCatalogueRows, resolveMetric } from '../../eval/rag/metric-registry.js';
import { METRIC_PRESETS } from '../../eval/rag/catalogue-presets.js';
import { buildMetricMatrix, checkGates, parseGates } from '../../eval/rag/metric-matrix.js';
import { compareMetricRuns } from '../../eval/rag/metric-compare.js';
import { tryMetric, type TrySample } from '../../eval/rag/try-metric.js';
import { pickRecord } from '../../eval/rag/record.js';
import { findRagTarget } from '../../eval/rag/targets.js';
import type { AppSettings, TestResult } from '../../model/types.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { str, type Tool } from '../tool.js';

const strList = (description: string) => ({ type: 'array', items: { type: 'string' }, description });
const judgeProps = {
  judge: str('The judge as provider/model (default: the evaluation’s, else the AI settings’ large model). There is never a silent fallback to a mock.'),
  judges: strList('A jury: several judges as provider/model; `aggregate` combines their scores'),
  aggregate: { type: 'string', enum: ['majority', 'mean', 'min'], description: 'How a jury combines (default majority)' },
  swap: { type: 'boolean', description: 'Judge the documents in both orders; a disagreement is a tie (not passed)' },
  repeat: { type: 'number', description: 'Judge n times, asking again after the first (reports the flip rate)' },
  short_circuit: { type: 'boolean', description: 'Skip the judged answer metrics of a sample whose free retrieval metrics already failed' },
  share_claims: { type: 'boolean', description: 'Split the answer into claims once, shared by faithfulness and answer-relevance' },
  max_cost_usd: { type: 'number', description: 'Stop judging once this much is spent; the rest is n/a' },
  max_calls: { type: 'number', description: 'Stop judging after this many model calls' },
  allow_images: { type: 'boolean', description: 'Let pictures of the sample (an image chunk, a question image) go to the judge as data. Off by default: pictures cannot be redacted. The judge must be able to see (a vision model)' },
};
const branchProps = {
  when: { type: 'object', description: 'A decision tree: { "<metric>": "<other metric> < 0.8" } — the metric runs only when the condition on another metric of the sample holds', additionalProperties: { type: 'string' } },
  unless: { type: 'object', description: 'The opposite of `when`: the metric runs only when the condition does NOT hold', additionalProperties: { type: 'string' } },
};
const metricProps = {
  metrics: strList('Metric names replacing the evaluation’s evaluators: ids, aliases, Ragas names, recall@5, per-turn:faithfulness … (rag_metrics lists them)'),
  preset: str(`A metric preset: ${METRIC_PRESETS.map((p) => p.id).join(', ')}`),
};

const stringMap = (v: unknown): Record<string, string> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string').map(([k, x]) => [k, String(x)])) : undefined);

const choices = (a: Record<string, unknown>): RagRunChoices => ({
  metrics: Array.isArray(a.metrics) ? a.metrics.map(String) : undefined,
  preset: a.preset ? String(a.preset) : undefined,
  target: a.target ? String(a.target) : undefined,
  judge: a.judge ? String(a.judge) : undefined,
  judges: Array.isArray(a.judges) ? a.judges.map(String) : undefined,
  aggregate: a.aggregate as RagRunChoices['aggregate'],
  swap: typeof a.swap === 'boolean' ? a.swap : undefined,
  repeat: typeof a.repeat === 'number' ? a.repeat : undefined,
  shortCircuit: typeof a.short_circuit === 'boolean' ? a.short_circuit : undefined,
  shareClaims: typeof a.share_claims === 'boolean' ? a.share_claims : undefined,
  maxJudgeCostUsd: typeof a.max_cost_usd === 'number' ? a.max_cost_usd : undefined,
  maxJudgeCalls: typeof a.max_calls === 'number' ? a.max_calls : undefined,
  allowImages: a.allow_images === true ? true : undefined,
  when: stringMap(a.when),
  unless: stringMap(a.unless),
  limit: typeof a.limit === 'number' ? Math.min(500, a.limit) : undefined,
});

const gatesOf = (v: unknown): Record<string, number> => {
  try {
    return parseGates(Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v : undefined);
  } catch (e) {
    throw new ApsError('ValidationError', (e as Error).message);
  }
};

/** The few results that explain a run: the failing samples, worst first, with why. */
const worst = (results: TestResult[], n: number) =>
  results
    .filter((r) => r.status !== 'passed')
    .slice(0, n)
    .map((r) => ({ id: r.id, name: r.name, status: r.status, failure: (r.metadata?.rag as { failure?: unknown } | undefined)?.failure, failedMetrics: r.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.message.slice(0, 160)}`) }));

export function ragEvalTools({ store, secrets, settings, checkEnvironment }: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings; checkEnvironment(name: unknown): string | undefined }): Tool[] {
  const context = (environment?: string) => createEngineContext({ store, secrets, settings, environment, aiSurface: 'mcp' });
  return [
    {
      name: 'rag_metrics',
      doc: {"when":"Choosing what to measure for a RAG system: which metrics exist, which need a model, what they read.","whenNot":"To score anything (rag_try_metric, rag_run).","example":{"search":"faithfulness"}},
      description: `The RAG metric catalogue (${metricCatalogueRows().length} metrics): id, name, group, kind (deterministic = no model, judged = needs a judge model, embedding), direction, what it reads, judge calls per sample, default pass mark, and its other names (older check names, DeepEval, NVIDIA, Ragas). Any of those names works wherever a metric is named. Also the metric presets.`,
      inputSchema: { type: 'object', properties: { group: { type: 'string', enum: METRIC_GROUPS.map((g) => g.id) }, kind: { type: 'string', enum: ['deterministic', 'judged', 'embedding', 'sql'] }, search: str('Text in an id, name, description or alias (a Ragas name works)') } },
      run: (a) => {
        let rows = metricCatalogueRows();
        if (a.group) rows = rows.filter((m) => m.group === a.group);
        if (a.kind) rows = rows.filter((m) => m.kind === a.kind);
        if (a.search) {
          const q = String(a.search).toLowerCase();
          const hit = resolveMetric(String(a.search))?.def.id;
          rows = rows.filter((m) => m.id === hit || [m.id, m.name, m.what, ...m.aliases, ...(m.ragas?.names ?? [])].some((s) => s.toLowerCase().includes(q)));
        }
        return {
          count: rows.length,
          metrics: rows.map((m) => ({ id: m.id, name: m.name, group: m.group, kind: m.kind, direction: m.direction, reads: m.requires, judgeCalls: m.calls, threshold: m.threshold, what: m.what, options: m.options, aliases: [...m.aliases, ...(m.ragas?.names ?? [])] })),
          presets: METRIC_PRESETS.map((p) => ({ id: p.id, name: p.name, description: p.description })),
        };
      },
    },
    {
      name: 'rag_try_metric',
      doc: {"when":"Checking a metric on one sample before an evaluation, or seeing exactly what a judge would receive (dry_run).","whenNot":"To score a dataset (rag_run) or to list metrics (rag_metrics).","example":{"metric":"faithfulness","answer":"It opens at 8am.","contexts":["The clinic opens at 8am."],"dry_run":true}},
      write: true,
      description:
        'Try one metric on one sample. With `dry_run` it shows the exact judge prompts that would be sent (after redaction, with size and cost, and whether the verdict is cached) and sends nothing; without it the sample is scored and the result comes back with its items, the judge and the cost. The sample is given (question, answer, contexts, reference, reference_ids), taken from a finished run (`run_id` + `record`), or probed from a RAG target (`target` + `question`). The other metrics read more: `fields` carries a conversation (`turns`), `reference_tool_calls`, `expected_outcome`, `reference_topics`, `should_refuse`, `canaries`; `tool_calls` the calls the system made; `images` pictures (with `allow_images`, for a vision judge — they go as data and a dry run lists them).',
      inputSchema: {
        type: 'object',
        properties: {
          metric: str('A metric id, alias or Ragas name (rag_metrics)'),
          options: { type: 'object', description: 'Metric options, e.g. { mode: "chunks" } or { k: 5 }. A `database` here is ignored: a SQL metric uses the database of a saved evaluation (`evaluation`)' },
          evaluation: str('A saved evaluation whose `database` the SQL metrics (datacompy-score, sql-equivalence) use. A PostgreSQL or MySQL connection also needs the person to have allowed it on this computer (`testpion rag trust-db`); an agent cannot allow it'),
          question: str('The question'),
          answer: str('The answer to score'),
          contexts: strList('The retrieved contexts (texts)'),
          reference: str('The reference answer'),
          reference_ids: strList('The gold chunk ids'),
          images: strList('Pictures the retrieved context holds: a file of the workspace, an http(s) URL or a data: URI. Needs allow_images and a vision judge'),
          allow_images: judgeProps.allow_images,
          tool_calls: { type: 'array', items: { type: 'object' }, description: 'The tool calls the system made: [{ name, arguments }]' },
          fields: { type: 'object', description: 'Other fields of a dataset record the metric reads: turns (a conversation: user messages, or { role, content, tool_calls, contexts }), reference_tool_calls, expected_outcome, reference_topics, should_refuse, canaries / injection, source, rubric, baseline_answer, answerable, relevance' },
          run_id: str('Take the sample from a finished run'),
          record: str('With run_id: the dataset record id'),
          target: str('A RAG target: ask it `question` and score what it answers'),
          environment: str('Environment name (for a probed request)'),
          dry_run: { type: 'boolean', description: 'Show what would be sent; send nothing' },
          judge: judgeProps.judge,
        },
        required: ['metric'],
      },
      run: async (a) => {
        const pictures = Array.isArray(a.images) ? a.images.map((image) => ({ text: '', image: String(image) })) : [];
        const written = a.fields && typeof a.fields === 'object' && !Array.isArray(a.fields) ? pickRecord(a.fields as Record<string, unknown>) : undefined;
        const calls = Array.isArray(a.tool_calls) ? pickRecord({ tool_calls: a.tool_calls })?.toolCalls : undefined;
        let sample: TrySample = {
          question: a.question as string | undefined,
          answer: a.answer as string | undefined,
          contexts: Array.isArray(a.contexts) || pictures.length ? [...(Array.isArray(a.contexts) ? a.contexts.map((text) => ({ text: String(text) })) : []), ...pictures] : undefined,
          reference: a.reference as string | undefined,
          referenceIds: Array.isArray(a.reference_ids) ? a.reference_ids.map(String) : undefined,
          ...(written ? { record: written } : {}),
          ...(calls ? { toolCalls: calls } : {}),
        };
        const ctx = context(checkEnvironment(a.environment));
        try {
          if (a.run_id) {
            let found: TrySample | undefined;
            for await (const r of runResults(store, String(a.run_id))) {
              if (a.record && !r.id.endsWith(`:${String(a.record)}`) && r.id !== a.record) continue;
              found = storedSample(r);
              if (found) break;
            }
            if (!found) throw new ApsError('ValidationError', `No stored sample${a.record ? ` for "${String(a.record)}"` : ''} in run ${String(a.run_id)}`);
            sample = found;
          } else if (a.target) {
            const { id: _i, name: _n, ...target } = findRagTarget(store, String(a.target));
            const p = await probeRagTarget(ctx, target as RagTarget, String(a.question ?? ''));
            sample = { ...sample, answer: p.sample.answer, contexts: p.sample.contexts, latencyMs: p.latencyMs };
          }
          const j = a.judge || a.allow_images === true ? { ...(a.judge ? { provider: String(a.judge).split('/')[0], ...(String(a.judge).includes('/') ? { model: String(a.judge).split('/').slice(1).join('/') } : {}) } : {}), ...(a.allow_images === true ? { allowImages: true } : {}) } : undefined;
          const database = a.evaluation ? findSavedEvaluation(store, String(a.evaluation)).database : undefined;
          const r = await tryMetric({ providers: ctx.services.providers, ragJudge: ctx.services.ragJudge!, workspaceRoot: store.root }, { metric: { ...((a.options as Record<string, unknown>) ?? {}), type: String(a.metric) }, sample, judge: j, dryRun: a.dry_run === true, database });
          return { ...r, sample: { question: sample.question, answer: sample.answer?.slice(0, 1000), contexts: sample.contexts?.length } };
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'rag_estimate',
      doc: {"when":"Before rag_run or rag_rescore: the judge calls, tokens, cost range and caps it would hit.","whenNot":"To run anything.","example":{"evaluation":"Clinic RAG","preset":"rag-triad"}},
      description:
        'What a RAG evaluation will cost BEFORE it runs: judge calls (per metric and in total), tokens, a cost range from the price table, the calls it makes to your RAG system, and any cap it would break (the daily token or budget cap, max_cost_usd, max_calls). Nothing is sent. Run this before rag_run. With `run_id` it estimates re-scoring that run, exactly: every prompt is built for the stored samples, so the calls and the cache hits are real.',
      inputSchema: { type: 'object', properties: { evaluation: str('A saved RAG evaluation (list_evaluations)'), run_id: str('Estimate re-scoring this finished run instead'), limit: { type: 'number' }, ...metricProps, ...branchProps, ...judgeProps }, required: [] },
      run: async (a) => {
        const ctx = context();
        try {
          if (a.run_id) {
            const ch = choices(a);
            const evaluators = ch.metrics?.length || ch.preset ? chooseRagRun({ evaluators: [], judge: {} } as never, ch).evaluators : (await metricsOfRun(store, String(a.run_id))).map((type) => ({ type }));
            return await estimateRescore(store, ctx, String(a.run_id), evaluators, judgeSetupOf(chooseRagRun({ evaluators: [], judge: {} } as never, ch)));
          }
          if (!a.evaluation) throw new ApsError('ValidationError', 'Give `evaluation` (a saved RAG evaluation) or `run_id` (a finished run to re-score)');
          return await estimateRagEvaluation(store, ctx, chooseRagRun(findSavedEvaluation(store, String(a.evaluation)), choices(a)));
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'rag_run',
      doc: {"when":"Measuring a RAG system with a saved evaluation: metrics, gates, why samples failed, a baseline comparison.","whenNot":"For a plain LLM evaluation (run_evaluation), or before rag_estimate has been read when cost matters.","example":{"evaluation":"Clinic RAG","metrics":["faithfulness","recall@5"],"min":["faithfulness=0.8"],"max_cost_usd":1}},
      write: true,
      description:
        'Run a saved RAG evaluation with chosen metrics and gates: every dataset record goes to the RAG target, is scored by the metrics, and the run is recorded. Returns the run id, the per-metric aggregates (mean, p10, pass rate, n/a, 95% interval), why samples failed (retrieval miss, unfaithful, false refusal …), the gates (`min`: ["faithfulness=0.8"], met or not), the comparison with `baseline` (a run id) and the worst samples. Stops BEFORE the first question when the target cannot be called or a judged metric has no judge. Call rag_estimate first and pass `max_cost_usd`.',
      inputSchema: {
        type: 'object',
        properties: {
          evaluation: str('A saved RAG evaluation (list_evaluations)'),
          environment: str('Environment name'),
          limit: { type: 'number', description: 'Only the first n dataset records (at most 500 here)' },
          target: str('A RAG target (default: the evaluation’s)'),
          two_phase: { type: 'boolean', description: 'Collect the answers with the free metrics first, then judge them (a run followed by a re-score)' },
          min: strList('Gates: "metric=value" the mean of the metric must reach, e.g. ["faithfulness=0.8", "recall@5=0.9"]'),
          baseline: str('A run id to compare with, metric by metric'),
          ...metricProps,
          ...branchProps,
          ...judgeProps,
        },
        required: ['evaluation'],
      },
      run: async (a) => {
        const environment = checkEnvironment(a.environment);
        const d = chooseRagRun(findSavedEvaluation(store, String(a.evaluation)), { limit: 500, ...choices(a), ...(typeof a.limit === 'number' ? { limit: Math.min(500, a.limit) } : {}) });
        const gates = gatesOf(a.min);
        const out = await runRagEvaluation({ store, makeContext: () => context(environment), evaluation: d, twoPhase: a.two_phase === true, environment, concurrency: Math.min(8, d.concurrency || 4) });
        const matrix = await buildMetricMatrix(runResults(store, out.runId), { runId: out.runId, limit: 1 });
        const results: TestResult[] = [];
        for await (const r of runResults(store, out.runId)) results.push(r);
        const comparison = a.baseline ? await compareMetricRuns(runResults(store, out.runId), runResults(store, String(a.baseline))) : undefined;
        const g = checkGates(matrix, gates);
        return {
          runId: out.runId,
          ...(out.collectRunId ? { collectRunId: out.collectRunId } : {}),
          ref: { kind: 'run' as const, runId: out.runId },
          total: out.summary.total,
          passed: out.summary.passed,
          failed: out.summary.failed,
          errors: out.summary.errors,
          judgeCostUsd: out.summary.judgeCostUsd ?? 0,
          metrics: matrix.aggregates,
          failures: matrix.failures,
          gates: g,
          gatesPassed: g.every((x) => x.passed) && !comparison?.regressions.length,
          ...(comparison ? { comparison } : {}),
          worstSamples: worst(results, 10),
        };
      },
    },
    {
      name: 'rag_rescore',
      doc: {"when":"Scoring a finished run again with another judge or more metrics, without calling the RAG system.","whenNot":"For a new question set (rag_run).","example":{"run_id":"run-abc","judge":"anthropic/claude-sonnet"}},
      write: true,
      description:
        'Score a finished RAG run again with other metrics or another judge, using the answers and contexts it captured: the RAG system is not called, and verdicts already in the cache cost nothing. A NEW run is recorded. Use it to compare two judges, to add a metric, or to judge a run that collected its answers with the free metrics (two_phase). Same options and result as rag_run; call rag_estimate with `run_id` first for the exact number of judge calls.',
      inputSchema: { type: 'object', properties: { run_id: str('The finished run to score again'), min: strList('Gates on the new run'), ...metricProps, ...judgeProps }, required: ['run_id'] },
      run: async (a) => {
        const ctx = context();
        try {
          const ch = choices(a);
          const evaluators = ch.metrics?.length || ch.preset ? chooseRagRun({ evaluators: [], judge: {} } as never, ch).evaluators : undefined;
          const judge = judgeSetupOf(chooseRagRun({ evaluators: [], judge: {} } as never, ch));
          const r = await rescoreRun(store, { runId: String(a.run_id), evaluators, judge, providers: ctx.services.providers, ragJudge: ctx.services.ragJudge! });
          const matrix = await buildMetricMatrix(runResults(store, r.runId), { runId: r.runId, limit: 1 });
          const g = checkGates(matrix, gatesOf(a.min));
          return { runId: r.runId, rescoredFrom: String(a.run_id), ref: { kind: 'run' as const, runId: r.runId }, rescored: r.rescored, skipped: r.skipped, judgeCostUsd: r.summary.judgeCostUsd ?? 0, metrics: matrix.aggregates, failures: matrix.failures, gates: g, gatesPassed: g.every((x) => x.passed) };
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'rag_compare',
      doc: {"when":"After a change to the retriever, the prompt or the model: which metrics really moved.","whenNot":"To score a run (rag_run).","example":{"run_id":"run-new","baseline_run_id":"run-old"}},
      description:
        'Compare a RAG run with a baseline run, metric by metric: the mean of each, the difference over the samples both scored, a 95% interval of that difference (a seeded paired bootstrap) and whether it is a real regression or improvement. A lower-is-better metric that went up is a regression. Use it after a change to the RAG system, the prompt or the retriever.',
      inputSchema: { type: 'object', properties: { run_id: str('The run to judge'), baseline_run_id: str('The run to compare with'), min_delta: { type: 'number', description: 'The change in a mean that counts (default 0.05)' } }, required: ['run_id', 'baseline_run_id'] },
      run: (a) => compareMetricRuns(runResults(store, String(a.run_id)), runResults(store, String(a.baseline_run_id)), { minDelta: typeof a.min_delta === 'number' ? a.min_delta : undefined }),
    },
  ];
}
