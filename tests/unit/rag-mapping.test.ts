import { describe, expect, it } from 'vitest';
import { applyMapping, mappingProblems, responseOf, targetProblems, type RagMapping } from '../../packages/core/src/index.js';
import { assignSlot, emptyMapping, relativeToList, wildcardPath } from '../../packages/shared/src/index.js';

const json = (body: unknown) => responseOf({ body, text: JSON.stringify(body) });

describe('the mapping reads a sample out of a response, the same way every time', () => {
  const body = {
    answer: 'It opens at 8am.',
    sources: [
      { id: 'doc-1', text: 'The clinic opens at 8am.', score: 0.91, metadata: { source: 'hours.md' } },
      { id: 'doc-2', text: 'Closed on Sundays.', score: '0.4', metadata: { source: 'hours.md' } },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 8 },
    server_ms: 42,
  };
  const mapping: RagMapping = {
    answer: '$.answer',
    contexts: '$.sources[*]',
    context: { text: '$.text', id: '$.id', score: '$.score', source: '$.metadata.source' },
    usage: { input: '$.usage.prompt_tokens', output: '$.usage.completion_tokens' },
    latencyMs: '$.server_ms',
  };

  it('answer, contexts with text/id/score/source, usage and latency', () => {
    const s = applyMapping(json(body), mapping);
    expect(s.answer).toBe('It opens at 8am.');
    expect(s.contexts).toEqual([
      { id: 'doc-1', text: 'The clinic opens at 8am.', score: 0.91, source: 'hours.md' },
      { id: 'doc-2', text: 'Closed on Sundays.', score: 0.4, source: 'hours.md' },
    ]);
    expect(s.usage).toEqual({ inputTokens: 120, outputTokens: 8, totalTokens: 128 });
    expect(s.latencyMs).toBe(42);
    expect(s.warnings).toEqual([]);
    expect(applyMapping(json(body), mapping)).toEqual(s);
  });

  it('the contexts path may name the list itself, and items may be plain strings', () => {
    const s = applyMapping(json({ a: 'x', docs: ['first chunk', 'second chunk'] }), { answer: '$.a', contexts: '$.docs', context: { text: '$' } });
    expect(s.contexts).toEqual([{ id: 'doc-1', text: 'first chunk' }, { id: 'doc-2', text: 'second chunk' }]);
  });

  it('unmapped context fields are found under the usual names (LangChain page_content, LlamaIndex node text)', () => {
    const s = applyMapping(json({ a: 'x', docs: [{ page_content: 'chunk', metadata: { source: 's.md' } }, { content: 'other', doc_id: 'd9' }] }), { answer: '$.a', contexts: '$.docs[*]' });
    expect(s.contexts).toEqual([{ id: 'doc-1', text: 'chunk', source: 's.md' }, { id: 'd9', text: 'other' }]);
  });

  it('a path that matches nothing is a warning, not a guess', () => {
    const s = applyMapping(json({ x: 1 }), { answer: '$.answer', contexts: '$.sources[*]' });
    expect(s.answer).toBe('');
    expect(s.warnings).toEqual([expect.stringContaining('answer path $.answer matched nothing'), expect.stringContaining('contexts path $.sources[*] matched nothing')]);
  });

  it('a server-sent event stream is a document of events; the pieces of the answer are joined in order', () => {
    const text = ['data: {"type":"sources","sources":[{"id":"d1","text":"chunk"}]}', '', 'data: {"type":"delta","delta":"It "}', '', 'data: {"type":"delta","delta":"opens."}', '', 'data: [DONE]', '', ''].join('\n');
    const r = responseOf({ body: text, text, headers: [['Content-Type', 'text/event-stream; charset=utf-8']] });
    expect(r.kind).toBe('sse');
    const s = applyMapping(r, { answer: '$.events[*].data.delta', contexts: '$.events[0].data.sources[*]', context: { text: '$.text', id: '$.id' } });
    expect(s.answer).toBe('It opens.');
    expect(s.contexts).toEqual([{ id: 'd1', text: 'chunk' }]);
  });

  it('$text is the response text (a plain-text answer)', () => {
    const r = responseOf({ body: 'just text', text: 'just text' });
    expect(r.kind).toBe('text');
    expect(applyMapping(r, { answer: '$text' }).answer).toBe('just text');
  });

  it('a WebSocket body is read through received', () => {
    const body = { connected: true, received: [{ type: 'sources', sources: [{ id: 'a', text: 't' }] }, { type: 'delta', delta: 'Hi ' }, { type: 'delta', delta: 'there' }] };
    const s = applyMapping(json(body), { answer: '$.received[*].delta', contexts: '$.received[0].sources[*]', context: { text: '$.text', id: '$.id' } });
    expect(s.answer).toBe('Hi there');
    expect(s.contexts).toEqual([{ id: 'a', text: 't' }]);
  });

  it('problems of a mapping and a target are listed', () => {
    expect(mappingProblems(emptyMapping())[0]).toMatch(/no answer path/);
    expect(mappingProblems({ answer: 'answer' })).toEqual([]);
    expect(mappingProblems({ answer: '$.a', contexts: 'sources' })[0]).toMatch(/contexts must be a JSONPath/);
    expect(targetProblems({ protocol: 'grpc', step: { type: 'http', url: 'x' }, mapping: { answer: '$.a' } })[0]).toMatch(/grpc target's request is of type grpc/);
    expect(targetProblems({ protocol: 'sse', step: { type: 'http', url: 'x' }, mapping: { answer: '$.a' } })).toEqual([]);
  });
});

describe('click-to-map: what a click assigns', () => {
  it('wildcard and relative paths', () => {
    expect(wildcardPath('$.sources[2].meta.id')).toBe('$.sources[*].meta.id');
    expect(relativeToList('$.sources[*]', '$.sources[3].meta.id')).toBe('$.meta.id');
    expect(relativeToList('$.sources[*]', '$.sources[0]')).toBe('$');
    expect(relativeToList('$.sources[*]', '$.other[0].id')).toBeUndefined();
    expect(relativeToList('$.sources', '$.sources[1].text')).toBe('$.text');
  });

  it('assigns the slots in order; an item field needs the list first and must be inside it', () => {
    let m = emptyMapping();
    const step = (slot: Parameters<typeof assignSlot>[1], path: string) => {
      const r = assignSlot(m, slot, path);
      if ('problem' in r) return r.problem;
      m = r.mapping;
      return undefined;
    };
    expect(step('context.text', '$.sources[0].text')).toMatch(/list of retrieved contexts first/);
    expect(step('answer', '$.answer')).toBeUndefined();
    expect(step('contexts', '$.sources[0]')).toBeUndefined();
    expect(m.contexts).toBe('$.sources[*]');
    expect(step('context.text', '$.sources[1].text')).toBeUndefined();
    expect(step('context.id', '$.sources[1].meta.doc')).toBeUndefined();
    expect(step('context.score', '$.elsewhere[0].score')).toMatch(/not inside the list/);
    expect(step('usage.input', '$.usage.in')).toBeUndefined();
    expect(step('latencyMs', '$.ms')).toBeUndefined();
    expect(m).toEqual({ answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.meta.doc' }, usage: { input: '$.usage.in' }, latencyMs: '$.ms' });
  });

  it('the answer streamed in pieces joins this field of every event', () => {
    const r = assignSlot(emptyMapping(), 'answer.pieces', '$.events[4].data.delta');
    expect(r).toEqual({ mapping: { answer: '$.events[*].data.delta' } });
  });
});
