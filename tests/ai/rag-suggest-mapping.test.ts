/**
 * AI "Suggest mapping" with the offline mock: the task is registered, its context is the sample response, and a mapping
 * that reads nothing from that response is sent back to the model (the verifier) until it reads an answer — what comes out
 * has already read the sample. No real model.
 */
import { describe, expect, it } from 'vitest';
import { applyMapping, listAiTasks, responseOf, runAiTask, suggestedMappingProblems, responseOfContext, type RagMapping } from '../../packages/core/src/index.js';
import { harness } from './harness.js';

const RESPONSE = { reply: { text: 'The clinic opens at 8am.' }, hits: [{ doc: { uid: 'a1', body: 'The clinic opens at 8am on weekdays.' }, relevance: 0.9 }], tokens: { in: 30, out: 6 } };
const GOOD = { mapping: { answer: '$.reply.text', contexts: '$.hits[*]', context: { text: '$.doc.body', id: '$.doc.uid', score: '$.relevance' }, usage: { input: '$.tokens.in', output: '$.tokens.out' } }, notes: ['check the score scale'] };
const WRONG = { mapping: { answer: '$.answer', contexts: '$.sources[*]' } };

describe('the rag-suggest-mapping task', () => {
  it('is registered: a small task with a JSON answer', () => {
    expect(listAiTasks().find((t) => t.id === 'rag-suggest-mapping')).toMatchObject({ tier: 'small', output: 'json' });
  });

  it('the verifier: a mapping that reads nothing is a problem with the reason; a good one has none', () => {
    const response = responseOfContext({ response: RESPONSE });
    expect(suggestedMappingProblems(WRONG, response).join('\n')).toMatch(/answer path \$\.answer reads no text.*contexts path \$\.sources\[\*\] matches no document/s);
    expect(suggestedMappingProblems(GOOD, response)).toEqual([]);
    expect(suggestedMappingProblems({}, response)).toEqual(['the answer has no `mapping` object']);
    expect(suggestedMappingProblems({ mapping: { answer: '$.reply.text', contexts: '$.hits[*]', context: { text: '$.nope' } } }, response).join()).toMatch(/no text/);
  });

  it('a wrong first answer is sent back with the problems, and the second one reads the sample', async () => {
    const h = harness({ rules: [{ match: 'rag-suggest|MAP|mapping|response', responses: [JSON.stringify(WRONG), JSON.stringify(GOOD)] }] });
    try {
      const r = await runAiTask(h.deps, { task: 'rag-suggest-mapping', context: { response: RESPONSE, question: 'When does it open?', protocol: 'http' } });
      expect(r.repairs).toBe(1);
      expect(r.problems).toEqual([]);
      const mapping = (r.value as { mapping: RagMapping }).mapping;
      expect(mapping.answer).toBe('$.reply.text');
      const sample = applyMapping(responseOf({ body: RESPONSE, text: '' }), mapping);
      expect(sample.answer).toBe('The clinic opens at 8am.');
      expect(sample.contexts[0]).toMatchObject({ id: 'a1', score: 0.9 });
      // the second request carried the problems
      expect(h.rec.requests[1]!.messages.map((m) => m.content).join('\n')).toMatch(/reads no text/);
      // the model saw the sample response, redacted, and nothing else of the workspace
      expect(h.rec.requests[0]!.messages.map((m) => m.content).join('\n')).toContain('The clinic opens at 8am on weekdays.');
    } finally {
      h.cleanup();
    }
  });

  it('a model that never finds the answer returns its last attempt with the problems still listed (the person sees them)', async () => {
    const h = harness({ rules: [{ match: '.', response: JSON.stringify(WRONG) }] });
    try {
      const r = await runAiTask(h.deps, { task: 'rag-suggest-mapping', context: { response: RESPONSE } });
      expect(r.problems.join('\n')).toMatch(/reads no text/);
    } finally {
      h.cleanup();
    }
  });
});
