/**
 * Recognise the shape of a bot's response (R-9): given the response a probe got, say which common shape it looks like (an
 * OpenAI chat answer with citations, an Anthropic message with citations, LangServe, LlamaIndex, Haystack, Dify, Flowise, a plain
 * `{ answer, sources }` …) and offer the mapping that reads it, with what that mapping finds. Deterministic: every candidate mapping is
 * tried on the response with the engine's own reader, so a suggestion is never a guess about what it reads. No model is called.
 */
import { RAG_TARGET_PRESETS, type RagMapping } from '@testpion/shared';
import { applyMapping, type RagResponse } from './mapping.js';

export interface DetectedShape {
  id: string;
  /** "LlamaIndex query endpoint". */
  name: string;
  mapping: RagMapping;
  /** What the mapping reads from this response, so the person sees it before using it. */
  reads: { answer: string; documents: number; withIds: number; withScores: number };
  /** "Looks like LlamaIndex: the answer is in response and 3 documents are in source_nodes." */
  why: string;
}

interface Candidate {
  id: string;
  name: string;
  mapping: RagMapping;
}

/** Shapes the presets do not cover (they are detect-only): citations in a standard answer, and a few other common ones. */
const EXTRA: readonly Candidate[] = [
  {
    id: 'openai-annotations',
    name: 'OpenAI chat answer with citations',
    mapping: { answer: '$.choices[0].message.content', contexts: '$.choices[0].message.annotations[*]', context: { text: '$.url_citation.title', id: '$.url_citation.url', source: '$.url_citation.url' }, usage: { input: '$.usage.prompt_tokens', output: '$.usage.completion_tokens', total: '$.usage.total_tokens' } },
  },
  {
    id: 'openai-citations-list',
    name: 'Chat answer with a list of cited pages (Perplexity style)',
    mapping: { answer: '$.choices[0].message.content', contexts: '$.search_results[*]', context: { text: '$.snippet', id: '$.url', source: '$.title' }, usage: { input: '$.usage.prompt_tokens', output: '$.usage.completion_tokens', total: '$.usage.total_tokens' } },
  },
  {
    id: 'anthropic-citations',
    name: 'Anthropic message with citations',
    mapping: { answer: '$.content[*].text', contexts: '$.content[*].citations[*]', context: { text: '$.cited_text', id: '$.document_title', source: '$.document_title' }, usage: { input: '$.usage.input_tokens', output: '$.usage.output_tokens' } },
  },
  {
    id: 'anthropic-message',
    name: 'Anthropic message',
    mapping: { answer: '$.content[*].text', usage: { input: '$.usage.input_tokens', output: '$.usage.output_tokens' } },
  },
  {
    id: 'langchain-retrieval-qa',
    name: 'LangChain RetrievalQA (result and source documents)',
    mapping: { answer: '$.result', contexts: '$.source_documents[*]', context: { text: '$.page_content', id: '$.metadata.source' } },
  },
  {
    id: 'cohere-chat',
    name: 'Cohere chat with documents',
    mapping: { answer: '$.text', contexts: '$.documents[*]', context: { text: '$.snippet', id: '$.id' } },
  },
  {
    id: 'answer-with-citations',
    name: 'Answer with a list of citations',
    mapping: { answer: '$.answer', contexts: '$.citations[*]', context: { text: '$.text', id: '$.id', score: '$.score' } },
  },
  {
    id: 'answer-with-context',
    name: 'Answer with the context it used',
    mapping: { answer: '$.answer', contexts: '$.context[*]', context: { text: '$.text', id: '$.id', score: '$.score' } },
  },
];

const CANDIDATES: readonly Candidate[] = [...RAG_TARGET_PRESETS.map((p) => ({ id: p.id, name: p.name.replace(/ \(.*$/, ''), mapping: p.mapping })), ...EXTRA];

const words = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The shapes this response looks like, the best first (at most `limit`); empty when none reads an answer from it. */
export function detectRagShape(response: RagResponse, limit = 3): DetectedShape[] {
  const found: Array<DetectedShape & { rank: number }> = [];
  for (const c of CANDIDATES) {
    let sample;
    try {
      sample = applyMapping(response, c.mapping);
    } catch {
      continue;
    }
    if (!sample.answer.trim()) continue;
    const docs = sample.contexts.filter((d) => d.text.trim());
    // a mapping that names documents but finds none is a worse fit than one that reads them; one with no documents is the weakest
    if (c.mapping.contexts && !docs.length) continue;
    const withIds = docs.filter((d) => !/^doc-\d+$/.test(d.id)).length;
    const withScores = docs.filter((d) => d.score !== undefined).length;
    const where = c.mapping.answer.replace(/^\$\.?/, '').replace(/\[\*\]|\[0\]/g, '') || 'the response';
    found.push({
      id: c.id,
      name: c.name,
      mapping: JSON.parse(JSON.stringify(c.mapping)) as RagMapping,
      reads: { answer: sample.answer.length > 120 ? `${sample.answer.slice(0, 119)}…` : sample.answer, documents: docs.length, withIds, withScores },
      why: `Looks like ${c.name}: the answer is in ${where}${docs.length ? ` and ${words(docs.length, 'document')} ${docs.length === 1 ? 'is' : 'are'} in ${(c.mapping.contexts ?? '').replace(/^\$\.?/, '').replace(/\[\*\]/g, '')}` : '; it has no documents to map'}.`,
      // documents with ids and scores say the most; an answer alone says the least
      rank: docs.length ? 100 + Math.min(docs.length, 20) + withIds * 2 + withScores : 0,
    });
  }
  return found
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
    .map(({ rank: _rank, ...s }) => s);
}
