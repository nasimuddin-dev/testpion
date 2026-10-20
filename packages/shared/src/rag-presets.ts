/**
 * One-click starting points for connecting a RAG system (the Connect dialog's "Start from", `testpion rag connect
 * <preset>`): the request and the response mapping of the frameworks people deploy, each with a sample response of the
 * documented shape. The mapping is checked against that sample by a unit test, so a preset is never a guess about its own
 * mapping; the request is written for the framework's documented endpoint and the person fills in the host, the flow or
 * pipeline name and the key. Browser-safe data only.
 */
import type { RagMapping, RagProtocol } from './rag.js';

export interface RagTargetPreset {
  id: string;
  name: string;
  protocol: RagProtocol;
  /** What it is for and what to fill in, one or two sentences. */
  description: string;
  /** The variables the request uses besides the question (shown so they get a value in the environment). */
  variables: string[];
  step: Record<string, unknown>;
  mapping: RagMapping;
  /** A response of the documented shape, which `mapping` reads (the test proves it). */
  sample: unknown;
  /** The mapping needs the caller to know something the preset cannot: shown as a note. */
  note?: string;
}

const json = { 'Content-Type': 'application/json' };

export const RAG_TARGET_PRESETS: readonly RagTargetPreset[] = [
  {
    id: 'generic-json',
    name: 'Generic JSON (question in, answer and sources out)',
    protocol: 'http',
    description: 'The simplest shape: POST {"question": …} and read {answer, sources:[{id, text, score}]}. Change the paths to match your service.',
    variables: ['ragUrl'],
    step: { type: 'http', method: 'POST', url: '{{ragUrl}}/query', headers: json, json: { question: '{{question}}' } },
    mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score' } },
    sample: { answer: 'The clinic opens at 8am.', sources: [{ id: 'doc-1', text: 'The clinic opens at 8am on weekdays.', score: 0.91 }] },
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI-compatible chat completions',
    protocol: 'http',
    description: 'Any server that speaks POST /v1/chat/completions (OpenAI, Azure OpenAI, vLLM, Ollama, LiteLLM, a RAG gateway). The answer and the token counts are read; retrieved sources are not part of the standard response, so map them if your gateway adds a field.',
    variables: ['ragUrl', 'ragToken', 'ragModel'],
    step: { type: 'http', method: 'POST', url: '{{ragUrl}}/v1/chat/completions', headers: { ...json, Authorization: 'Bearer {{ragToken}}' }, json: { model: '{{ragModel}}', messages: [{ role: 'user', content: '{{question}}' }] } },
    mapping: { answer: '$.choices[0].message.content', usage: { input: '$.usage.prompt_tokens', output: '$.usage.completion_tokens', total: '$.usage.total_tokens' } },
    sample: { id: 'chatcmpl-1', choices: [{ index: 0, message: { role: 'assistant', content: 'The clinic opens at 8am.' } }], usage: { prompt_tokens: 40, completion_tokens: 7, total_tokens: 47 } },
    note: 'No retrieved contexts are mapped: judged context metrics need them. Gateways that return citations usually put them in a field of the response: click it in the sample response.',
  },
  {
    id: 'openai-compatible-stream',
    name: 'OpenAI-compatible chat completions, streamed',
    protocol: 'sse',
    description: 'The same endpoint with "stream": true. The answer is joined from the delta of every event.',
    variables: ['ragUrl', 'ragToken', 'ragModel'],
    step: { type: 'http', method: 'POST', url: '{{ragUrl}}/v1/chat/completions', headers: { ...json, Accept: 'text/event-stream', Authorization: 'Bearer {{ragToken}}' }, json: { model: '{{ragModel}}', stream: true, messages: [{ role: 'user', content: '{{question}}' }] } },
    mapping: { answer: '$.events[*].data.choices[0].delta.content' },
    sample: { events: [{ data: { choices: [{ delta: { content: 'The clinic ' } }] } }, { data: { choices: [{ delta: { content: 'opens at 8am.' } }] } }] },
  },
  {
    id: 'langserve',
    name: 'LangServe (a LangChain runnable)',
    protocol: 'http',
    description: 'POST /invoke of a LangServe app whose chain returns {answer, context:[Document]}. Change the output keys if your chain names them differently, and use {"input": "{{questionJson}}"} when the chain takes a plain string.',
    variables: ['ragUrl'],
    step: { type: 'http', method: 'POST', url: '{{ragUrl}}/invoke', headers: json, json: { input: { input: '{{question}}' } } },
    mapping: { answer: '$.output.answer', contexts: '$.output.context[*]', context: { text: '$.page_content', id: '$.metadata.source' } },
    sample: { output: { input: 'When does it open?', answer: 'The clinic opens at 8am.', context: [{ page_content: 'The clinic opens at 8am on weekdays.', metadata: { source: 'hours.md' } }] }, metadata: { run_id: 'r1' } },
  },
  {
    id: 'llamaindex',
    name: 'LlamaIndex query endpoint',
    protocol: 'http',
    description: 'A FastAPI or llama-deploy service that returns LlamaIndex’s response object: the answer in "response" and the retrieved nodes in "source_nodes" with their score.',
    variables: ['ragUrl'],
    step: { type: 'http', method: 'POST', url: '{{ragUrl}}/query', headers: json, json: { query: '{{question}}' } },
    mapping: { answer: '$.response', contexts: '$.source_nodes[*]', context: { text: '$.node.text', id: '$.node.id_', score: '$.score' } },
    sample: { response: 'The clinic opens at 8am.', source_nodes: [{ node: { id_: 'n-1', text: 'The clinic opens at 8am on weekdays.', metadata: { file_name: 'hours.md' } }, score: 0.88 }] },
  },
  {
    id: 'haystack',
    name: 'Haystack (Hayhooks pipeline)',
    protocol: 'http',
    description: 'POST /<pipeline>/run of a Hayhooks-served Haystack pipeline with a retriever and a generator. The component names (retriever, llm) are the ones in your pipeline: change them to match.',
    variables: ['ragUrl', 'ragPipeline'],
    step: { type: 'http', method: 'POST', url: '{{ragUrl}}/{{ragPipeline}}/run', headers: json, json: { query: '{{question}}' } },
    mapping: { answer: '$.result.llm.replies[0]', contexts: '$.result.retriever.documents[*]', context: { text: '$.content', id: '$.id', score: '$.score' } },
    sample: { result: { llm: { replies: ['The clinic opens at 8am.'] }, retriever: { documents: [{ id: 'd1', content: 'The clinic opens at 8am on weekdays.', score: 0.8 }] } } },
    note: 'A pipeline that returns only the generator’s output has no documents in the result: add the retriever to the pipeline’s outputs (include_outputs_from).',
  },
  {
    id: 'dify',
    name: 'Dify chat app',
    protocol: 'http',
    description: 'POST /v1/chat-messages of a Dify app in blocking mode. The retrieved segments are in metadata.retriever_resources.',
    variables: ['ragUrl', 'ragToken'],
    step: { type: 'http', method: 'POST', url: '{{ragUrl}}/v1/chat-messages', headers: { ...json, Authorization: 'Bearer {{ragToken}}' }, json: { inputs: {}, query: '{{question}}', response_mode: 'blocking', user: 'testpion' } },
    mapping: { answer: '$.answer', contexts: '$.metadata.retriever_resources[*]', context: { text: '$.content', id: '$.segment_id', score: '$.score', source: '$.document_name' }, usage: { input: '$.metadata.usage.prompt_tokens', output: '$.metadata.usage.completion_tokens' } },
    sample: { answer: 'The clinic opens at 8am.', metadata: { usage: { prompt_tokens: 50, completion_tokens: 8 }, retriever_resources: [{ segment_id: 'seg-1', content: 'The clinic opens at 8am on weekdays.', score: 0.9, document_name: 'hours.md' }] } },
  },
  {
    id: 'flowise',
    name: 'Flowise chatflow',
    protocol: 'http',
    description: 'POST /api/v1/prediction/<chatflow id>. The source documents are returned when the flow is set to return them.',
    variables: ['ragUrl', 'ragFlowId'],
    step: { type: 'http', method: 'POST', url: '{{ragUrl}}/api/v1/prediction/{{ragFlowId}}', headers: json, json: { question: '{{question}}' } },
    mapping: { answer: '$.text', contexts: '$.sourceDocuments[*]', context: { text: '$.pageContent', id: '$.metadata.source' } },
    sample: { text: 'The clinic opens at 8am.', sourceDocuments: [{ pageContent: 'The clinic opens at 8am on weekdays.', metadata: { source: 'hours.md' } }] },
  },
];

export function findRagTargetPreset(id: string): RagTargetPreset | undefined {
  const k = id.trim().toLowerCase();
  return RAG_TARGET_PRESETS.find((p) => p.id === k || p.name.toLowerCase() === k);
}
