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
  applyMapping,
  exportRagRecords,
  importRagRecords,
  listRagTargets,
  parseRagDatasetText,
  previewJudge,
  probeRagTarget,
  stringifyRagRecords,
  targetProblems,
  type RagDatasetFormat,
  type RagMapping,
  type RagResponse,
  type RagTarget,
} from '@testpion/core';
import { datasetFormatOfName } from '@testpion/shared';
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
        for (const f of m.inputs) input[f] = f === 'contexts' ? (sample.contexts ?? []).map((d) => ({ id: d.id, text: d.text })) : sample[f];
        return { metric: m.id, version: m.version, what: m.what, preview: previewJudge(ctx.services.ragJudge!, m, input, judge) };
      } finally {
        void ctx.dispose();
      }
    },
    /** A Ragas or DeepEval dataset text to TestPion's records, or TestPion's to Ragas / DeepEval (`to`). */
    'rag.convert': ({ text, name, from, to }: { text: string; name?: string; from?: RagDatasetFormat; to?: RagDatasetFormat }) => {
      const imported = importRagRecords(parseRagDatasetText(text, (name && datasetFormatOfName(name)) || 'jsonl'), from);
      const records = to && to !== 'testpion' ? exportRagRecords(imported.records, to) : imported.records;
      return { from: imported.from, to: to ?? 'testpion', count: records.length, notes: imported.notes, text: stringifyRagRecords(records) };
    },
  };
}
