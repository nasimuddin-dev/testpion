import { describe, expect, it } from 'vitest';
import { RAG_TARGET_PRESETS } from '@testpion/shared';
import { detectRagShape, responseOf } from '../../packages/core/src/index.js';

/** R-9: the shape of a bot's response is recognised from the response itself, deterministically, and the mapping offered reads it. */
const resp = (body: unknown) => responseOf({ body, text: JSON.stringify(body) });

describe('detectRagShape', () => {
  it('recognises the sample of every preset as that preset (or one that reads the same documents)', () => {
    for (const p of RAG_TARGET_PRESETS) {
      if (p.protocol === 'sse') continue; // a stream is read from its events, tried below
      const found = detectRagShape(resp(p.sample), 6);
      const own = found.find((f) => f.id === p.id);
      expect(own, `${p.id} among ${found.map((f) => f.id).join(', ')}`).toBeDefined();
      expect(own!.reads.answer).toBe('The clinic opens at 8am.');
    }
  });

  it('puts the shape that reads documents before one that reads only the answer', () => {
    const found = detectRagShape(resp({ response: 'The clinic opens at 8am.', source_nodes: [{ node: { id_: 'n-1', text: 'Opens at 8am.' }, score: 0.88 }] }));
    expect(found[0]).toMatchObject({ id: 'llamaindex', reads: { documents: 1, withIds: 1, withScores: 1 } });
    expect(found[0]!.why).toBe('Looks like LlamaIndex query endpoint: the answer is in response and 1 document is in source_nodes.');
  });

  it('knows an Anthropic message with citations and an OpenAI answer with url citations', () => {
    const anthropic = detectRagShape(resp({ content: [{ type: 'text', text: 'Opens at 8am.', citations: [{ type: 'char_location', cited_text: 'The clinic opens at 8am.', document_title: 'hours.md' }] }], usage: { input_tokens: 9, output_tokens: 4 } }));
    expect(anthropic[0]).toMatchObject({ id: 'anthropic-citations', reads: { answer: 'Opens at 8am.', documents: 1 } });
    const openai = detectRagShape(resp({ choices: [{ message: { content: 'Opens at 8am.', annotations: [{ type: 'url_citation', url_citation: { url: 'https://x.test/hours', title: 'Hours' } }] } }] }));
    expect(openai[0]).toMatchObject({ id: 'openai-annotations', reads: { documents: 1 } });
  });

  it('offers the answer-only shapes when there are no documents, and nothing for a response with no answer', () => {
    const plain = detectRagShape(resp({ choices: [{ message: { content: 'Hi' } }] }));
    expect(plain.map((f) => f.id)).toContain('openai-compatible');
    expect(plain.every((f) => f.reads.documents === 0)).toBe(true);
    expect(detectRagShape(resp({ ok: true, items: [] }))).toEqual([]);
    expect(detectRagShape(resp({}))).toEqual([]);
  });

  it('reads a streamed answer from its events', () => {
    const sse = responseOf({ body: undefined, text: 'data: {"choices":[{"delta":{"content":"The clinic "}}]}\n\ndata: {"choices":[{"delta":{"content":"opens at 8am."}}]}\n\n', headers: [['content-type', 'text/event-stream']] });
    expect(detectRagShape(sse)[0]).toMatchObject({ id: 'openai-compatible-stream', reads: { answer: 'The clinic opens at 8am.' } });
  });

  it('returns a copy of the mapping, so using it never changes the catalogue', () => {
    const a = detectRagShape(resp({ answer: 'x y', sources: [{ id: 'a', text: 'doc' }] }))[0]!;
    a.mapping.answer = '$.changed';
    expect(detectRagShape(resp({ answer: 'x y', sources: [{ id: 'a', text: 'doc' }] }))[0]!.mapping.answer).toBe('$.answer');
  });
});
