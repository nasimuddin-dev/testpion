/**
 * RPC handlers of the custom RAG metrics and of what is built on a run's matrix (AI Lab ▸ RAG ▸ Metrics, the Metrics pane
 * of an evaluation): the metric files of the workspace (list, read, check, save, delete, where a metric is used, run the
 * examples), the variant × metric pivot of several runs, and a result's trace. The window never reads or writes a metric
 * file itself and never checks one: the engine does, the same as `testpion rag metric` and the MCP tools.
 */
import { stringify as stringifyYaml } from 'yaml';
import {
  ApsError,
  buildMetricMatrix,
  compileCustomMetric,
  listMetricFiles,
  parseCustomMetric,
  pivotRuns,
  readMetricFile,
  removeMetricFile,
  runMetricExamples,
  runResults,
  syncCustomMetrics,
  writeMetricFile,
  type SavedEvaluation,
} from '@testpion/core';
import { CUSTOM_METRIC_KINDS, customMetricTemplate, type CustomMetricKind } from '@testpion/shared';
import type { Backend, Handlers } from '../backend.js';

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function ragMetricHandlers(be: Backend): Handlers {
  const known = () => new Set(listMetricFiles(be.ws).map((f) => f.id));
  const problems = (list: Array<{ level: string; message: string; field?: string }>) => list.map((p) => ({ level: p.level, message: p.message, field: p.field }));
  return {
    /** The metric files of the workspace with what is wrong with each and whether it is usable. */
    'rag.customMetrics': () => {
      const sync = syncCustomMetrics(be.ws);
      const k = known();
      return {
        kinds: CUSTOM_METRIC_KINDS,
        metrics: listMetricFiles(be.ws).map((f) => {
          const p = parseCustomMetric(f.text, { fileId: f.id, known: k });
          return {
            id: f.id,
            metric: `custom/${f.id}`,
            name: p.metric?.name ?? f.id,
            description: p.metric?.description ?? '',
            kind: p.metric?.kind,
            version: p.metric?.version,
            examples: p.metric?.examples?.length ?? 0,
            registered: sync.registered.includes(`custom/${f.id}`),
            problems: problems(sync.files.find((x) => x.id === f.id)?.problems ?? p.problems),
          };
        }),
      };
    },
    /** One metric file's text (or a starting file of a kind when `id` is new and `kind` is given). */
    'rag.customMetric.get': ({ id, kind }: { id: string; kind?: CustomMetricKind }) => {
      if (!ID.test(id)) throw new ApsError('ValidationError', `"${id}" is not a metric id: lower-case letters, digits and hyphens`);
      const f = readMetricFile(be.ws, id);
      if (f) return { id, text: f.text, exists: true };
      return { id, text: stringifyYaml(customMetricTemplate(kind ?? 'judge', id)), exists: false };
    },
    /** Check a text as a metric file without writing it: the problems, and a summary of what it is. */
    'rag.customMetric.check': ({ text, id }: { text: string; id?: string }) => {
      const p = parseCustomMetric(text, { fileId: id, known: known() });
      return { ok: !!p.metric, problems: problems(p.problems), metric: p.metric ? { id: p.metric.id, kind: p.metric.kind, version: p.metric.version, examples: p.metric.examples?.length ?? 0 } : undefined };
    },
    /** Write the file (checked first; an error refuses it). A file that exists is replaced only with `overwrite`. */
    'rag.customMetric.save': ({ id, text, overwrite }: { id: string; text: string; overwrite?: boolean }) => {
      if (!ID.test(id)) throw new ApsError('ValidationError', `"${id}" is not a metric id: lower-case letters, digits and hyphens`);
      const p = parseCustomMetric(text, { fileId: id, known: known() });
      if (!p.metric) throw new ApsError('ValidationError', `The metric file is not valid: ${p.problems.filter((x) => x.level === 'error').map((x) => `${x.field ? `${x.field}: ` : ''}${x.message}`).join('; ')}`);
      if (readMetricFile(be.ws, id) && overwrite !== true) throw new ApsError('ValidationError', `metrics/${id}.yaml exists`, { suggestions: ['Save it again to replace it.'] });
      const f = writeMetricFile(be.ws, id, text);
      const sync = syncCustomMetrics(be.ws);
      be.host.emit('data.changed', { kind: 'metric', method: 'rag.customMetric.save' });
      return { path: f.path, metric: `custom/${id}`, registered: sync.registered.includes(`custom/${id}`), problems: problems(p.problems) };
    },
    /** The saved evaluations (and the metric files) that name a metric: what deleting or renaming it would break. */
    'rag.customMetric.usedBy': ({ id }: { id: string }) => {
      const names = new Set([id, `custom/${id}`]);
      const uses = (be.ws.getLibrary<SavedEvaluation>('evaluations').items ?? []).filter((e) => (e.data.evaluators ?? []).some((c) => names.has(c.type))).map((e) => e.name);
      const formulas = listMetricFiles(be.ws)
        .filter((f) => f.id !== id && /^kind:\s*formula/m.test(f.text) && new RegExp(`\\b${id.replace(/-/g, '[-_]')}\\b|custom/${id}`).test(f.text))
        .map((f) => f.id);
      return { evaluations: uses, formulas };
    },
    'rag.customMetric.delete': ({ id }: { id: string }) => {
      if (!ID.test(id)) throw new ApsError('ValidationError', `"${id}" is not a metric id`);
      const removed = removeMetricFile(be.ws, id);
      syncCustomMetrics(be.ws);
      be.host.emit('data.changed', { kind: 'metric', method: 'rag.customMetric.delete' });
      return { removed };
    },
    /** Run the examples of a metric (given as text, as edited): each must come out as its `expect`. A judged metric asks the judge. */
    'rag.customMetric.examples': async ({ text, id, only, judge, environment }: { text: string; id?: string; only?: number[]; judge?: { provider?: string; model?: string }; environment?: string }) => {
      const p = parseCustomMetric(text, { fileId: id, known: known() });
      if (!p.metric) throw new ApsError('ValidationError', `The metric file is not valid: ${p.problems.filter((x) => x.level === 'error').map((x) => x.message).join('; ')}`);
      const ctx = be.context({ environment });
      try {
        return { results: await runMetricExamples(compileCustomMetric(p.metric), { providers: ctx.services.providers, ragJudge: ctx.services.ragJudge, judge, only }) };
      } finally {
        await ctx.dispose();
      }
    },
    /** Several runs side by side: the mean of every metric per run (the variant × metric pivot), and the best run per metric. */
    'rag.pivot': async ({ runIds, labels }: { runIds: string[]; labels?: Record<string, string> }) => {
      const runs = [];
      for (const runId of (runIds ?? []).slice(0, 12)) {
        const matrix = await buildMetricMatrix(runResults(be.ws, runId), { runId, limit: 1 });
        runs.push({ runId, label: labels?.[runId] ?? runId, matrix });
      }
      return pivotRuns(runs);
    },
  };
}
