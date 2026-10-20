/**
 * AI "Suggest mapping" (the `rag-suggest-mapping` task): from a sample response of a RAG endpoint the model writes the
 * mapping (JSONPath of the answer, the list of retrieved contexts and their fields). The model only PROPOSES; TestPion
 * applies the mapping to that same response, and an answer that extracts no answer, or a list path that matches nothing,
 * goes back to the model as a problem (the repair loop of every AI task) before the person ever sees it. What the
 * person gets is therefore a mapping that has already read the sample.
 */
import type { RagMapping } from '@testpion/shared';
import { applyMapping, mappingProblems, type RagResponse } from './mapping.js';

export const SUGGEST_MAPPING_INSTRUCTION = [
  'You map the response of a RAG (retrieval-augmented generation) endpoint. The context holds `response`: one real response of the endpoint to the question in `question`, as a JSON document (a stream of server-sent events is { events: [{ event, data }] }; a WebSocket is { received: [...] }; plain text is { text }).',
  'Write the JSONPath mapping that reads from it: `answer` (where the answer text is; a path that matches several strings, such as the delta of every streamed event, is joined in order), `contexts` (the path of the LIST of retrieved documents, ending in [*], if the response has one), `context` (inside ONE retrieved document: `text` the passage, `id` its identifier, `score` its relevance, `source` its file or url; each relative to the document, so `$.text` or `$.metadata.source`), `usage` (`input`, `output`, `total` token counts if the response has them), `latencyMs` (a latency in milliseconds if it has one).',
  'Rules. Paths start at `$`. Use only fields that exist in the response; leave out what it does not have. Never invent a path. The answer is the text a user would read, not a field about the request. Retrieved documents are the passages the system found (often called sources, documents, context, chunks, nodes, citations); if there are none, leave `contexts` out. Do not map a document id to something that is not unique per document.',
  'Answer with one JSON object: {"mapping": {...}, "notes": [one short sentence for anything the person should check]}. Output only that object.',
].join('\n');

const FIELD = { type: 'string', description: 'A JSONPath' };

export const SUGGEST_MAPPING_SCHEMA = {
  type: 'object',
  required: ['mapping'],
  properties: {
    mapping: {
      type: 'object',
      required: ['answer'],
      properties: {
        answer: FIELD,
        contexts: FIELD,
        context: { type: 'object', properties: { text: FIELD, id: FIELD, score: FIELD, source: FIELD } },
        usage: { type: 'object', properties: { input: FIELD, output: FIELD, total: FIELD } },
        latencyMs: FIELD,
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** The response document of the task's context: what the model was shown, as the mapping engine reads it. */
export function responseOfContext(ctx: Record<string, unknown> | undefined): RagResponse | undefined {
  const doc = ctx?.response;
  if (doc === undefined || doc === null) return undefined;
  const text = typeof ctx?.responseText === 'string' ? ctx.responseText : typeof doc === 'string' ? doc : JSON.stringify(doc);
  const kind = typeof doc === 'object' && doc && 'events' in doc ? 'sse' : typeof doc === 'object' ? 'json' : 'text';
  return { doc: typeof doc === 'string' ? { text: doc } : doc, text, kind };
}

/**
 * The problems of a suggested mapping against the response it was made from (empty when it reads an answer and, when it
 * maps contexts, at least one with a text). These are sent back to the model by the repair loop.
 */
export function suggestedMappingProblems(value: unknown, response: RagResponse | undefined): string[] {
  const m = (value as { mapping?: RagMapping } | undefined)?.mapping;
  if (!m || typeof m !== 'object') return ['the answer has no `mapping` object'];
  const out = mappingProblems(m);
  if (!response) return out;
  const sample = applyMapping(response, m);
  if (!sample.answer.trim()) out.push(`the answer path ${m.answer} reads no text from the response; look again at the response and pick the field that holds the answer`);
  if (m.contexts && !sample.contexts.length) out.push(`the contexts path ${m.contexts} matches no document, or the \`context.text\` path finds no text in them; the list must be a path to the array of documents ending in [*], and \`context.text\` is relative to one document`);
  if (m.contexts && sample.contexts.length && !sample.contexts.some((d) => d.text.trim())) out.push('the retrieved documents have no text: set `context.text` to the passage of one document');
  return out;
}
