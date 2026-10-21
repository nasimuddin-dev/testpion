/**
 * The catalogue rows of the multimodal metrics (planning/rag-testing.md §2.3 type 12). Same contract as the other tables;
 * the worked examples are golden mock-judge cases in tests/ai/rag-judge-r3.test.ts, with the images served from fixtures.
 */
import { imageTokens } from '../../util/image-info.js';
import { judgeEstimate } from './metric-defs.js';
import { registerMetric, type MetricDef, type MetricEstimate, type SampleShape } from './metric-registry.js';

const SRC = {
  faithfulness: 'https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/multi_modal_faithfulness/',
  relevance: 'https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/multi_modal_relevance/',
};

/** The text part plus one 1024-pixel picture per call (the estimate does not know the images: a typical one). */
const withImage = (e: MetricEstimate): MetricEstimate => ({ ...e, inputTokens: e.inputTokens + imageTokens('openai-compatible', 1024, 1024) });

const COMMON = {
  group: 'multimodal' as const,
  kind: 'judged' as const,
  direction: 'higher' as const,
  judge: 'service' as const,
  aliases: [] as string[],
  calls: '1 vision-judge call (the pictures are sent as data)',
};

const DEFS: MetricDef[] = [
  {
    ...COMMON,
    id: 'multimodal-faithfulness',
    name: 'Multimodal faithfulness',
    what: 'Whether the answer can be inferred from the pictures and the texts of the retrieved context together. The pictures go to a vision judge as data, only when the evaluation allows images.',
    how: 'mode binary (default, Ragas): one verdict, 1 when the context supports the answer, else 0. mode claims: the answer split into claims, each judged against the pictures and texts and naming the one that decides it; supported claims / claims.',
    example: '“The Tesla Model X is an electric SUV.” with a picture of a Model X: 1. “Cats are cute.” with the same picture: 0 (the Ragas documentation’s examples).',
    requires: ['answer', 'images'],
    optional: ['contexts'],
    threshold: 1,
    check: 'multimodal-faithfulness',
    ragas: { names: ['multimodal_faithfulness', 'multi_modal_faithfulness', 'MultiModalFaithfulness'], options: { mode: 'binary' }, differs: 'The Ragas pages call the score “scaled to (0, 1)” but give 1 or 0; so does the default mode.' },
    options: { mode: { type: 'string', default: 'binary', values: ['binary', 'claims'], description: 'binary: one verdict (Ragas). claims: one verdict per claim with the deciding picture or text.' } },
    prompts: ['multimodal-faithfulness-v1', 'multimodal-faithfulness-claims-v1'],
    version: 'multimodal-faithfulness-v1',
    sources: [SRC.faithfulness],
    estimate: (s: SampleShape, o) => withImage(judgeEstimate(s, { prompt: 200, reads: ['answerTokens', 'contextTokens'], items: (x) => (o.mode === 'claims' ? Math.max(1, Math.round(x.answerTokens / 25)) : 1) })),
  },
  {
    ...COMMON,
    id: 'multimodal-relevance',
    name: 'Multimodal relevance',
    what: 'Whether the answer is relevant to the question and consistent with the pictures and texts of the retrieved context. The pictures go to a vision judge as data, only when the evaluation allows images.',
    how: 'One verdict from the vision judge: 1 when the answer addresses the question in line with the context, else 0.',
    example: '“What about the Tesla Model X?” with a picture of a Model X: “an electric SUV made by Tesla” scores 1; “Cats are cute.” scores 0 (the Ragas documentation’s examples).',
    requires: ['question', 'answer', 'images'],
    optional: ['contexts'],
    threshold: 1,
    check: 'multimodal-relevance',
    ragas: { names: ['multimodal_relevance', 'multi_modal_relevance', 'MultiModalRelevance'] },
    prompts: ['multimodal-relevance-v1'],
    version: 'multimodal-relevance-v1',
    sources: [SRC.relevance],
    estimate: (s: SampleShape) => withImage(judgeEstimate(s, { prompt: 200, reads: ['questionTokens', 'answerTokens', 'contextTokens'], items: () => 1 })),
  },
];

for (const d of DEFS) registerMetric(d);
