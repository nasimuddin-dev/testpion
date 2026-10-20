/**
 * RPC handlers of RAG testing (AI Lab ▸ RAG, Evaluations of type RAG): the RAG targets with their problems, a probe (one
 * real question to the system under test), the mapping applied to a response already seen (the click-to-map preview),
 * "What will be sent" for a judged metric, and the conversion of Ragas / DeepEval datasets. The saved targets themselves
 * are a library (lib.get / lib.save, `rag-targets`) like saved evaluations. The window never builds a prompt or reads
 * a mapping itself; the engine does, the same as `testpion rag` and the MCP tools.
 */
import {
  ApsError,
  JUDGED_METRICS,
  METRIC_GROUPS,
  METRIC_PRESETS,
  applyMapping,
  buildMetricMatrix,
  compareMetricRuns,
  estimateRagEvaluation,
  estimateRescore,
  findRagTarget,
  importBeir,
  mapColumns,
  missingDatasetInputs,
  metricCatalogueRows,
  metricToCheck,
  parseRagImportText,
  presetChecks,
  readRunSummary,
  rescoreRun,
  runResults,
  storedSample,
  suggestColumnMapping,
  tryMetric,
  RAG_FIELDS,
  type ColumnMapping,
  type MatrixQuery,
  type SavedEvaluation,
  type TrySample,
  exportRagRecords,
  importRagRecords,
  listRagTargets,
  previewJudge,
  probeRagTarget,
  stringifyRagRecords,
  targetProblems,
  type RagDatasetFormat,
  type RagMapping,
  type RagResponse,
  type RagTarget,
} from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

export function ragHandlers(be: Backend): Handlers {
  return {
    /** The saved RAG targets with the problems that stop them from being called. */
    'rag.targets': () => listRagTargets(be.ws),
    /** What is wrong with a target as edited (before it is saved or probed). */
    'rag.check': ({ target }: { target: RagTarget }) => ({ problems: targetProblems(target) }),
    /** One real question to the system under test: the response as the mapping sees it, and the sample the mapping reads from it. */
    'rag.probe': async ({ target, question, environment }: { target: RagTarget; question: string; environment?: string }) => {
      const ctx = be.context({ environment });
      try {
        return await probeRagTarget(ctx, target, String(question ?? ''));
      } finally {
        await ctx.dispose();
      }
    },
    /** The sample a mapping reads from a response the window already has (no new call): the live preview while clicking. */
    'rag.map': ({ response, mapping }: { response: RagResponse; mapping: RagMapping }) => applyMapping(response, mapping),
    /** "What will be sent" to the judge for one sample and one judged metric (nothing is sent). */
    'rag.judgePreview': ({ metric, sample, judge, environment }: { metric: string; sample: { question?: string; answer?: string; contexts?: Array<{ id: string; text: string }>; reference?: string }; judge?: { provider?: string; model?: string }; environment?: string }) => {
      const m = JUDGED_METRICS.find((x) => x.id === metric);
      if (!m) throw new ApsError('ValidationError', `Not a judged RAG metric: ${metric}. Known: ${JUDGED_METRICS.map((x) => x.id).join(', ')}`);
      const ctx = be.context({ environment });
      try {
        const input: Record<string, unknown> = {};
        for (const f of m.inputs) input[f] = f === 'contexts' ? (sample.contexts ?? []).map((d) => ({ id: d.id, text: d.text })) : f === 'claims' ? [] : (sample as Record<string, unknown>)[f];
        return { metric: m.id, version: m.version, what: m.what, preview: previewJudge(ctx.services.ragJudge!, m, input, judge) };
      } finally {
        void ctx.dispose();
      }
    },
    /** The metric catalogue for the picker: groups, every metric (no functions), the presets as ready checks, and the names the target presets carry. */
    'rag.metrics': ({ columns, hasTarget }: { columns?: string[]; hasTarget?: boolean } = {}) => ({
      groups: METRIC_GROUPS,
      // with the dataset's columns, each metric says which inputs the dataset does not give it
      metrics: metricCatalogueRows().map((m) => ({ ...m, ...(columns ? { missing: missingDatasetInputs(m.requires, columns, hasTarget ?? false) } : {}) })),
      presets: METRIC_PRESETS.map((p) => ({ id: p.id, name: p.name, description: p.description, checks: presetChecks(p.metrics) })),
    }),
    /** The check a metric name stands for (an alias, a Ragas name, recall@5), with the options the name implies. */
    'rag.metricCheck': ({ name, options }: { name: string; options?: Record<string, unknown> }) => metricToCheck(name, options),
    /** What an evaluation will cost before it runs; `probe` asks the target one real question to size an answer. */
    'rag.estimate': async ({ draft, probe, environment }: { draft: SavedEvaluation; probe?: boolean; environment?: string }) => {
      const ctx = be.context({ environment });
      try {
        const target = probe && draft.target ? findRagTarget(be.ws, draft.target) : undefined;
        const asker = target
          ? async (question: string): Promise<TrySample> => {
              const { id: _i, name: _n, ...t } = target;
              const p = await probeRagTarget(ctx, t as RagTarget, question);
              return { question, answer: p.sample.answer, contexts: p.sample.contexts, latencyMs: p.latencyMs };
            }
          : undefined;
        const estimate = await estimateRagEvaluation(be.ws, ctx, draft, { probe: asker });
        return { estimate, sampleSize: asker ? 'probe' : 'dataset' };
      } finally {
        await ctx.dispose();
      }
    },
    /** What re-scoring a finished run will cost: every prompt built for its stored samples. */
    'rag.estimateRescore': async ({ runId, evaluators, judge, environment }: { runId: string; evaluators: Array<{ type: string }>; judge?: SavedEvaluation['judge']; environment?: string }) => {
      const ctx = be.context({ environment });
      try {
        return await estimateRescore(be.ws, ctx, runId, evaluators, judge);
      } finally {
        await ctx.dispose();
      }
    },
    /**
     * Try one metric on one sample: given, taken from a result of a run (`runId` + `resultId`), or probed from a target.
     * `dryRun` shows the exact judge prompts and sends nothing.
     */
    'rag.metric.try': async (p: { metric: string; options?: Record<string, unknown>; sample?: TrySample; runId?: string; resultId?: string; target?: string; question?: string; judge?: SavedEvaluation['judge']; dryRun?: boolean; environment?: string }) => {
      const ctx = be.context({ environment: p.environment });
      try {
        let sample: TrySample = p.sample ?? {};
        if (p.runId && p.resultId) {
          let found: TrySample | undefined;
          for await (const r of runResults(be.ws, p.runId)) if (r.id === p.resultId) found = storedSample(r);
          if (!found) throw new ApsError('ValidationError', 'That result holds no stored RAG sample');
          sample = found;
        } else if (p.target) {
          const { id: _i, name: _n, ...t } = findRagTarget(be.ws, p.target);
          const probe = await probeRagTarget(ctx, t as RagTarget, String(p.question ?? sample.question ?? ''));
          sample = { ...sample, question: p.question ?? sample.question, answer: probe.sample.answer, contexts: probe.sample.contexts, latencyMs: probe.latencyMs };
        }
        const r = await tryMetric({ providers: ctx.services.providers, ragJudge: ctx.services.ragJudge! }, { metric: { ...(p.options ?? {}), type: p.metric }, sample, judge: p.judge, dryRun: p.dryRun });
        return { ...r, sample };
      } finally {
        await ctx.dispose();
      }
    },
    /** The samples × metrics matrix of a run: a page of rows, the columns grouped by type, the aggregates over every sample. */
    'rag.matrix': async ({ runId, ...q }: { runId: string } & MatrixQuery) => buildMetricMatrix(runResults(be.ws, runId), { ...q, runId }),
    /** One result of a run with the sample it was scored on (the drill-down of a matrix cell). */
    'rag.sample': async ({ runId, resultId }: { runId: string; resultId: string }) => {
      for await (const r of runResults(be.ws, runId)) if (r.id === resultId) return { result: r, sample: storedSample(r) ?? null };
      throw new ApsError('ValidationError', `No result "${resultId}" in run ${runId}`);
    },
    /** Two runs, metric by metric, with a paired bootstrap on the shared samples. */
    'rag.compare': ({ runId, baselineId, minDelta }: { runId: string; baselineId: string; minDelta?: number }) => compareMetricRuns(runResults(be.ws, runId), runResults(be.ws, baselineId), { minDelta }),
    /** Score a finished run again with other metrics or another judge (no call to the RAG system); a new run is recorded. */
    'rag.rescore': async ({ runId, evaluators, judge, environment }: { runId: string; evaluators?: Array<{ type: string }>; judge?: SavedEvaluation['judge']; environment?: string }) => {
      const ctx = be.context({ environment });
      try {
        // the new run keeps the evaluation's name, so it sits with the evaluation's other runs
        const r = await rescoreRun(be.ws, { runId, evaluators, judge, providers: ctx.services.providers, ragJudge: ctx.services.ragJudge!, name: readRunSummary(be.ws, runId)?.name });
        return { runId: r.runId, rescored: r.rescored, skipped: r.skipped };
      } finally {
        await ctx.dispose();
      }
    },
    /** The columns of a dataset text, the mapping guessed from their names, and the records that mapping gives (the column mapper). */
    'rag.columns': ({ text, name, mapping }: { text: string; name?: string; mapping?: ColumnMapping }) => {
      const records = parseRagImportText(text, name ?? 'dataset.jsonl');
      const columns = [...new Set(records.slice(0, 200).flatMap((r) => Object.keys(r)))];
      const m = mapping ?? suggestColumnMapping(columns);
      const mapped = mapColumns(records, m);
      return { columns, fields: RAG_FIELDS, mapping: m, count: mapped.records.length, preview: mapped.records.slice(0, 5), kept: mapped.kept, notes: mapped.notes, text: mapped.records.map((r) => JSON.stringify(r)).join('\n') };
    },
    /** BEIR: the queries, the qrels and (optionally) the corpus files as RAG records. */
    'rag.importBeir': ({ queries, qrels, corpus, limit }: { queries: string; qrels: string; corpus?: string; limit?: number }) => {
      const r = importBeir({ queries, qrels, corpus }, { limit });
      return { from: 'beir', count: r.records.length, notes: r.notes, text: stringifyRagRecords(r.records) };
    },
    /** A dataset text of another tool to TestPion's records, or TestPion's to Ragas / DeepEval (`to`). */
    'rag.convert': ({ text, name, from, to }: { text: string; name?: string; from?: RagDatasetFormat; to?: RagDatasetFormat }) => {
      const imported = importRagRecords(parseRagImportText(text, name ?? 'dataset.jsonl', from), from);
      const records = to && to !== 'testpion' ? exportRagRecords(imported.records, to) : imported.records;
      return { from: imported.from, to: to ?? 'testpion', count: records.length, notes: imported.notes, text: stringifyRagRecords(records) };
    },
  };
}
