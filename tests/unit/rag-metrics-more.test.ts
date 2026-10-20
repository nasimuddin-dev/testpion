/**
 * The metrics of the second catalogue table that need no judge, run as checks over a sample with their worked examples:
 * Hole@k, graded nDCG from a record, BLEU, chrF, number and JSON difference, label F1, quoted spans, context size and
 * usage, error rate, throughput, retrieval-score statistics, canaries, the deterministic tool-call metrics and the two
 * semantic set metrics (mock embedder). Each metric in the catalogue has an example that these tests compute.
 */
import { describe, expect, it } from 'vitest';
import { ProviderRegistry, VariableScope, metricCatalogue, pickRecord, resolveMetric, runChecks, type CheckContext } from '../../packages/core/src/index.js';

const rag = (over: Partial<CheckContext> = {}): CheckContext => ({ testType: 'rag', body: '', text: 'The clinic opens at 8am [doc-1].', question: 'When does it open?', contexts: [{ id: 'doc-1', text: 'The clinic opens at 8am.' }, { id: 'doc-2', text: 'Parking is free.' }], ...over });
async function one(cfg: Record<string, unknown>, ctx: CheckContext) {
  const [r] = await runChecks([cfg as never], ctx);
  return r!;
}

describe('hole@k', () => {
  it('counts the top-k chunks nobody labelled; relevance grades label too (even grade 0)', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const ctx = rag({ contexts: ids.map((id) => ({ id, text: '' })), referenceIds: ['a', 'b', 'c', 'd', 'e', 'f'], record: { relevance: { g: 0 } } });
    const r = await one({ type: 'hole@k', k: 10, threshold: 0.5 }, ctx);
    expect(r.score).toBe(0.3);
    expect(r.passed).toBe(true);
    expect((await one({ type: 'hole@k', k: 10, threshold: 0.2 }, ctx)).passed).toBe(false);
    expect((await one({ type: 'hole@5' }, ctx)).score).toBe(0);
    expect((await one({ type: 'hole@k' }, rag())).message).toMatch(/needs the labelled ids/);
  });
});

describe('graded nDCG from the record', () => {
  it('a relevance column grades the chunks; without it the binary gold ids are used', async () => {
    const ctx = rag({ contexts: ['b', 'a', 'c'].map((id) => ({ id, text: '' })), referenceIds: ['a', 'b'], record: { relevance: { a: 3, b: 2, c: 0 } } });
    expect((await one({ type: 'ndcg@k', k: 3 }, ctx)).score).toBe(0.913);
    expect((await one({ type: 'ndcg@3' }, rag({ contexts: ['x', 'a', 'b'].map((id) => ({ id, text: '' })), referenceIds: ['a', 'b'] }))).score).toBe(0.693);
    // grades alone are enough
    expect((await one({ type: 'ndcg@k', k: 3 }, rag({ contexts: ['a'].map((id) => ({ id, text: '' })), record: { relevance: { a: 1 } } }))).score).toBe(1);
  });
});

describe('answer against the reference', () => {
  it('bleu: 0.38 for the cat example, with the statistics', async () => {
    const r = await one({ type: 'bleu', threshold: 0.3 }, rag({ text: 'the cat sat on the mat', expected: 'the cat is on the mat' }));
    expect(r.score).toBe(0.38);
    expect(r.passed).toBe(true);
    expect((r.metadata as { correct: number[] }).correct).toEqual([5, 3, 1, 0]);
    expect((await one({ type: 'bleu' }, rag())).message).toMatch(/needs a reference/);
  });

  it('chrf: 0.479 for abcd / abce', async () => {
    expect((await one({ type: 'chrf', threshold: 0.4 }, rag({ text: 'abcd', expected: 'abce' }))).score).toBe(0.479);
  });

  it('numeric-diff: 95 against 100 is 0.95; op compares; a path reads a JSON answer; no number is a failure', async () => {
    expect((await one({ type: 'numeric-diff' }, rag({ text: 'about 95 units', expected: '100' }))).score).toBe(0.95);
    expect((await one({ type: 'numeric-diff', op: '>=', epsilon: 0 }, rag({ text: '12', expected: 10 }))).passed).toBe(true);
    const j = await one({ type: 'numeric-diff', path: '$.total' }, rag({ text: '{"total": 99}', body: { total: 99 }, expected: '100' }));
    expect(j.score).toBe(0.99);
    const none = await one({ type: 'numeric-diff' }, rag({ text: 'many', expected: '100' }));
    expect(none.passed).toBe(false);
    expect(none.score).toBe(0);
    expect((await one({ type: 'numeric-diff', op: '~' }, rag({ text: '1', expected: '1' }))).message).toMatch(/op must be/);
  });

  it('json-diff: 0.5 for {a:1,b:x} against {a:1,b:y}; a non-JSON answer scores 0', async () => {
    expect((await one({ type: 'json-diff', threshold: 0.5 }, rag({ text: '{"a":1,"b":"x"}', expected: '{"a":1,"b":"y"}' }))).score).toBe(0.5);
    const bad = await one({ type: 'json-diff' }, rag({ text: 'not json', expected: '{"a":1}' }));
    expect(bad.passed).toBe(false);
    expect(bad.score).toBe(0);
  });

  it('label-f1: expected {a, b}, answered {a, c} → 0.5; lists and JSON arrays are read', async () => {
    const r = await one({ type: 'label-f1', threshold: 0.5 }, rag({ text: 'a, c', expected: 'a;b' }));
    expect(r.score).toBe(0.5);
    expect(r.passed).toBe(true);
    expect((await one({ type: 'label-f1' }, rag({ text: '["x","y"]', expected: ['x', 'y'] as never }))).score).toBe(1);
  });

  it('quoted-spans: 1 of 2 quotes in the documents → 0.5; no quote scores 1', async () => {
    const ctx = rag({ text: 'It says "opens at 8am" and "free parking for all".' });
    const r = await one({ type: 'quoted-spans' }, ctx);
    expect(r.score).toBe(0.5);
    expect(r.passed).toBe(false);
    expect((await one({ type: 'quoted-spans' }, rag({ text: 'No quotes here.' }))).score).toBe(1);
  });
});

describe('operational reads', () => {
  it('context-size: the share of the token budget; a bound exceeded fails with the numbers', async () => {
    const big = rag({ contexts: Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, text: 'x'.repeat(4000) })) });
    const r = await one({ type: 'context-size' }, big);
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
    const over = await one({ type: 'context-size', maxChunks: 5 }, big);
    expect(over.passed).toBe(false);
    expect(over.message).toMatch(/8 chunks > 5/);
    expect((await one({ type: 'context-size', maxTokens: 1000 }, big)).passed).toBe(false);
  });

  it('context-usage: cites 2 of 8 → 0.25', async () => {
    const ctx = rag({ text: 'Opens at 8 [doc-1] and parking [3].', contexts: Array.from({ length: 8 }, (_, i) => ({ id: `doc-${i + 1}`, text: '' })) });
    const r = await one({ type: 'context-usage' }, ctx);
    expect(r.score).toBe(0.25);
    expect(r.passed).toBe(true);
    expect((await one({ type: 'context-usage' }, rag({ contexts: [] }))).score).toBe(0);
  });

  it('error-rate: 0 for an answered sample, 1 for an error', async () => {
    expect((await one({ type: 'error-rate' }, rag())).score).toBe(0);
    expect((await one({ type: 'error-rate' }, rag({ status: 503 }))).score).toBe(1);
  });

  it('throughput: 650 ms with 8 callers → 738.5 per minute', async () => {
    const r = await one({ type: 'throughput', concurrency: 8, min: 600 }, rag({ latencyMs: 650 }));
    expect(r.score).toBe(738.5);
    expect(r.passed).toBe(true);
    expect((await one({ type: 'throughput' }, rag())).message).toMatch(/needs the latency/);
  });

  it('retrieval-score-stats: top 0.82, gap 0.03, 1 of 3 under the floor', async () => {
    const ctx = rag({ contexts: [0.82, 0.79, 0.2].map((score, i) => ({ id: `d${i}`, text: '', score })) });
    expect((await one({ type: 'retrieval-score-stats' }, ctx)).score).toBe(0.82);
    expect((await one({ type: 'retrieval-score-stats', stat: 'gap', threshold: 0.01 }, ctx)).score).toBe(0.03);
    const below = await one({ type: 'retrieval-score-stats', stat: 'below-floor', threshold: 0.5 }, ctx);
    expect(below.score).toBe(0.333);
    expect(below.passed).toBe(true);
    expect((await one({ type: 'retrieval-score-stats' }, rag())).message).toMatch(/needs the retrieval scores/);
  });
});

describe('prompt-injection-resistance', () => {
  it('the answer containing the canary scores 0, case ignored', async () => {
    expect((await one({ type: 'prompt-injection-resistance', canaries: ['BANANA'] }, rag({ text: 'Sure: banana!' }))).score).toBe(0);
    expect((await one({ type: 'prompt-injection-resistance', canaries: ['BANANA'] }, rag())).score).toBe(1);
    expect((await one({ type: 'prompt-injection-resistance' }, rag({ record: pickRecord({ injection: 'BANANA; SECRET-9' }) }))).passed).toBe(true);
    expect((await one({ type: 'prompt-injection-resistance' }, rag())).message).toMatch(/needs the canaries/);
  });
});

describe('tool calls (Ragas)', () => {
  const search = { name: 'search', arguments: { q: 'x' } };
  it('tool-call-f1: 2 expected, 3 made including an extra → P 2/3, R 1, F1 0.8 (the corrected Ragas example)', async () => {
    const ctx = rag({ toolCalls: [search, { name: 'open', arguments: { id: 1 } }, { name: 'extra', arguments: {} }] });
    const r = await one({ type: 'tool-call-f1', expected: [search, { name: 'open', arguments: { id: 1 } }] }, ctx);
    expect(r.score).toBe(0.8);
    expect((await one({ type: 'tool-call-f1', expected: [] }, rag({ toolCalls: [] }))).score).toBe(1);
    expect((await one({ type: 'tool-call-f1' }, rag())).message).toMatch(/needs the expected tool calls/);
  });

  it('tool-call-accuracy: search(q=x) then open(id=1) expected; open(id=2) made → (1 + 0) / 2 = 0.5', async () => {
    const expected = [search, { name: 'open', arguments: { id: 1 } }];
    const r = await one({ type: 'tool-call-accuracy', expected }, rag({ toolCalls: [search, { name: 'open', arguments: { id: 2 } }] }));
    expect(r.score).toBe(0.5);
    // arguments compared as text, as Ragas does: "1" equals 1
    expect((await one({ type: 'tool-call-accuracy', expected }, rag({ toolCalls: [search, { name: 'open', arguments: { id: '1' } }] }))).score).toBe(1);
    expect((await one({ type: 'tool-call-accuracy', expected, args: 'exact' }, rag({ toolCalls: [search, { name: 'open', arguments: { id: '1' } }] }))).score).toBe(0.5);
  });

  it('tool-call-accuracy: order matters unless strictOrder is false; extra calls between are allowed; missing calls score 0', async () => {
    const expected = [search, { name: 'open', arguments: { id: 1 } }];
    const swapped = rag({ toolCalls: [{ name: 'open', arguments: { id: 1 } }, search] });
    expect((await one({ type: 'tool-call-accuracy', expected }, swapped)).score).toBe(0);
    expect((await one({ type: 'tool-call-accuracy', expected, strictOrder: false }, swapped)).score).toBe(1);
    const between = rag({ toolCalls: [search, { name: 'log', arguments: {} }, { name: 'open', arguments: { id: 1 } }] });
    expect((await one({ type: 'tool-call-accuracy', expected }, between)).score).toBe(1);
    expect((await one({ type: 'tool-call-accuracy', expected }, rag({ toolCalls: [search] }))).score).toBe(0);
    expect((await one({ type: 'tool-call-accuracy', expected: [] }, rag({ toolCalls: [] }))).score).toBe(1);
  });

  it('the dataset record supplies both sides', async () => {
    const record = pickRecord({ reference_tool_calls: '[{"name":"search","args":{"q":"x"}}]', tool_calls: [{ tool: 'search', arguments: { q: 'x' } }] });
    expect((await one({ type: 'tool-call-accuracy' }, rag({ record, toolCalls: record!.toolCalls }))).score).toBe(1);
  });
});

describe('semantic set metrics (mock embedder)', () => {
  const providers = () => new ProviderRegistry([], new VariableScope());
  const sem = (over: Partial<CheckContext> = {}): CheckContext => rag({ services: { providers: providers() }, ...over });

  it('reference-set-similarity: an answer equal to a good answer scores 1; bad answers must stay away', async () => {
    const r = await one({ type: 'reference-set-similarity', embedder: 'mock', good: ['something else entirely', 'The clinic opens at 8am [doc-1].'], negatives: ['zzz qqq'] }, sem());
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
    const bad = await one({ type: 'reference-set-similarity', embedder: 'mock', good: ['The clinic opens at 8am [doc-1].'], negatives: ['The clinic opens at 8am [doc-1].'] }, sem());
    expect(bad.passed).toBe(false);
  });

  it('without an embedding model the message says what to set up (no silent mock)', async () => {
    const r = await one({ type: 'reference-set-similarity', good: ['x'] }, sem());
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/needs an embedding model/);
    expect((await one({ type: 'reference-set-similarity' }, sem())).message).toMatch(/needs good answers/);
  });

  it('context-answer-similarity: sentences that are chunks score 1', async () => {
    const ctx = sem({ text: 'The clinic opens at 8am.', contexts: [{ id: 'd', text: 'The clinic opens at 8am.' }] });
    const r = await one({ type: 'context-answer-similarity', embedder: 'mock' }, ctx);
    expect(r.score).toBe(1);
    expect((await one({ type: 'context-answer-similarity', embedder: 'mock' }, sem({ contexts: [] }))).message).toMatch(/needs the retrieved contexts/);
  });
});

describe('the catalogue entries of these metrics', () => {
  it('each is registered under its id, aliases and Ragas names', () => {
    for (const [name, id] of [['bleu_score', 'bleu'], ['CHRFScore', 'chrf'], ['QuotedSpansAlignment', 'quoted-spans'], ['tool_call_f1', 'tool-call-f1'], ['ToolCallAccuracy', 'tool-call-accuracy'], ['hole@10', 'hole@k'], ['number-check', 'numeric-diff'], ['pi', 'prompt-injection-resistance']] as const) {
      expect(resolveMetric(name)?.def.id, name).toBe(id);
    }
    expect(resolveMetric('ragas:tool_call_accuracy')?.options).toEqual({ strictOrder: true });
    expect(metricCatalogue().find((m) => m.id === 'hole@k')!.direction).toBe('lower');
  });
});

describe('record fields', () => {
  it('pickRecord reads the known spellings and nothing else', () => {
    expect(pickRecord({ question: 'q', other: 1 })).toBeUndefined();
    const r = pickRecord({ answerable: 'false', qrels: '{"a": 2, "b": "x"}', canary: 'BANANA', rubric: { '1': 'bad', '5': 'good' }, source: 'text', good_answers: 'a; b' })!;
    expect(r).toEqual({ answerable: false, relevance: { a: 2 }, canaries: ['BANANA'], rubric: { '1': 'bad', '5': 'good' }, source: 'text', goodAnswers: ['a', 'b'] });
  });
});
