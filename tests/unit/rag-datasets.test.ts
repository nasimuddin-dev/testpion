/**
 * Ragas and DeepEval dataset files, as their public documentation shows them (Ragas: `EvaluationDataset` /
 * `SingleTurnSample`, https://docs.ragas.io/en/stable/concepts/components/eval_sample/ ; DeepEval: `Golden` and
 * `LLMTestCase`, https://deepeval.com/docs/evaluation-datasets). The fixtures are written from those pages; the files are
 * only data, nothing in them is executed.
 */
import { describe, expect, it } from 'vitest';
import { detectRagFormat, exportRagRecords, importRagRecords, parseRagDatasetText, stringifyRagRecords } from '../../packages/core/src/index.js';

const RAGAS_JSONL = [
  JSON.stringify({ user_input: 'When was the first super bowl?', retrieved_contexts: ['The First AFL–NFL World Championship Game was played on January 15, 1967.'], reference_contexts: ['The first Super Bowl took place on January 15, 1967.'], response: 'The first superbowl was held on Jan 15, 1967', reference: 'The first superbowl was held on January 15, 1967' }),
  JSON.stringify({ user_input: 'Who won it?', reference: 'The Green Bay Packers.', reference_context_ids: ['kb-12'], retrieved_context_ids: ['kb-12', 'kb-40'], retrieved_contexts: ['Green Bay won.', 'Unrelated.'], persona_name: 'Sports fan', query_style: 'PERFECT_GRAMMAR', query_length: 'SHORT' }),
].join('\n');

const DEEPEVAL_JSON = JSON.stringify([
  { input: 'What if these shoes don\'t fit?', actual_output: 'We offer a 30-day full refund at no extra cost.', expected_output: 'You are eligible for a 30 day refund at no extra cost.', context: ['All customers are eligible for a 30 day full refund at no extra cost.'], retrieval_context: ['Only shoes can be refunded.', 'Returns are free.'], additional_metadata: { tags: ['returns'] } },
  { input: 'Do you ship abroad?', expectedOutput: 'Yes, to 40 countries.', retrievalContext: ['We ship to 40 countries.'] },
]);

describe('Ragas dataset import', () => {
  const imported = importRagRecords(parseRagDatasetText(RAGAS_JSONL, 'jsonl'));
  it('is detected by its column names', () => {
    expect(imported.from).toBe('ragas');
    expect(detectRagFormat([{ question: 'q' }])).toBe('testpion');
    expect(detectRagFormat([{ input: 'q', expected_output: 'a' }])).toBe('deepeval');
  });
  it('becomes TestPion records: question, reference, reference_contexts, reference_ids, tags, and the answer with the contexts it came with', () => {
    expect(imported.records[0]).toEqual({
      question: 'When was the first super bowl?',
      reference: 'The first superbowl was held on January 15, 1967',
      reference_contexts: ['The first Super Bowl took place on January 15, 1967.'],
      answer: 'The first superbowl was held on Jan 15, 1967',
      contexts: [{ id: 'doc-1', text: 'The First AFL–NFL World Championship Game was played on January 15, 1967.' }],
    });
    expect(imported.records[1]).toMatchObject({
      reference_ids: ['kb-12'],
      contexts: [{ id: 'kb-12', text: 'Green Bay won.' }, { id: 'kb-40', text: 'Unrelated.' }],
      tags: ['persona:Sports fan', 'query-style:PERFECT_GRAMMAR', 'query-length:SHORT'],
    });
  });
  it('a multi-turn sample becomes a conversation record (its goal, expected tool calls and topics kept) and exports back to the Ragas shape', () => {
    const sample = {
      user_input: [
        { content: 'Book me a flight to Paris', type: 'human' },
        { content: '', type: 'ai', tool_calls: [{ name: 'search_flights', args: { to: 'Paris' } }] },
        { content: 'found 3 flights', type: 'tool' },
        { content: 'Booked the 9am.', type: 'ai' },
      ],
      reference: 'A flight to Paris is booked.',
      reference_tool_calls: [{ name: 'search_flights', args: { to: 'Paris' } }],
      reference_topics: ['travel'],
    };
    const r = importRagRecords([sample, { user_input: [{ content: '', type: 'ai' }] }, { user_input: 'q', reference: 'a' }], 'ragas');
    expect(r.records).toHaveLength(2);
    expect(r.notes[0]).toMatch(/no user message/);
    expect(r.records[0]).toMatchObject({ question: 'Book me a flight to Paris', expected_outcome: 'A flight to Paris is booked.', reference_topics: ['travel'], reference_tool_calls: sample.reference_tool_calls });
    expect((r.records[0]!.turns as Array<{ role: string }>).map((t) => t.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    // and back: the messages as human / ai / tool, the goal as `reference`
    expect(exportRagRecords([r.records[0]!], 'ragas')[0]).toEqual({
      user_input: [
        { content: 'Book me a flight to Paris', type: 'human' },
        { content: '', type: 'ai', tool_calls: [{ name: 'search_flights', args: { to: 'Paris' } }] },
        { content: 'found 3 flights', type: 'tool' },
        { content: 'Booked the 9am.', type: 'ai' },
      ],
      reference: 'A flight to Paris is booked.',
      reference_tool_calls: [{ name: 'search_flights', args: { to: 'Paris' } }],
      reference_topics: ['travel'],
    });
  });
  it('the older column names (question, answer, contexts, ground_truth) are read too', () => {
    const r = importRagRecords([{ question: 'q?', answer: 'a', contexts: ['c1'], ground_truth: 'g' }], 'ragas');
    expect(r.records[0]).toEqual({ question: 'q?', reference: 'g', answer: 'a', contexts: [{ id: 'doc-1', text: 'c1' }] });
  });
  it('exports back to the same Ragas columns (round trip)', () => {
    const back = exportRagRecords(imported.records, 'ragas');
    expect(back[0]).toEqual({
      user_input: 'When was the first super bowl?',
      retrieved_contexts: ['The First AFL–NFL World Championship Game was played on January 15, 1967.'],
      reference_contexts: ['The first Super Bowl took place on January 15, 1967.'],
      response: 'The first superbowl was held on Jan 15, 1967',
      reference: 'The first superbowl was held on January 15, 1967',
    });
    expect(back[1]).toMatchObject({ retrieved_context_ids: ['kb-12', 'kb-40'], reference_context_ids: ['kb-12'], reference: 'The Green Bay Packers.' });
    // and the exported file imports to the same records
    expect(importRagRecords(parseRagDatasetText(stringifyRagRecords(back), 'jsonl')).records.map(({ tags: _t, ...r }) => r)).toEqual(imported.records.map(({ tags: _t, ...r }) => r));
  });
});

describe('DeepEval dataset import', () => {
  const imported = importRagRecords(parseRagDatasetText(DEEPEVAL_JSON, 'json'));
  it('reads Golden / LLMTestCase records (snake_case and the camelCase aliases)', () => {
    expect(imported.from).toBe('deepeval');
    expect(imported.records[0]).toEqual({
      question: "What if these shoes don't fit?",
      reference: 'You are eligible for a 30 day refund at no extra cost.',
      reference_contexts: ['All customers are eligible for a 30 day full refund at no extra cost.'],
      answer: 'We offer a 30-day full refund at no extra cost.',
      contexts: [{ id: 'doc-1', text: 'Only shoes can be refunded.' }, { id: 'doc-2', text: 'Returns are free.' }],
      tags: ['returns'],
      metadata: { tags: ['returns'] },
    });
    expect(imported.records[1]).toEqual({ question: 'Do you ship abroad?', reference: 'Yes, to 40 countries.', contexts: [{ id: 'doc-1', text: 'We ship to 40 countries.' }] });
  });
  it('exports to DeepEval’s names', () => {
    const [a] = exportRagRecords(imported.records, 'deepeval');
    expect(a).toEqual({
      input: "What if these shoes don't fit?",
      actual_output: 'We offer a 30-day full refund at no extra cost.',
      expected_output: 'You are eligible for a 30 day refund at no extra cost.',
      context: ['All customers are eligible for a 30 day full refund at no extra cost.'],
      retrieval_context: ['Only shoes can be refunded.', 'Returns are free.'],
      additional_metadata: { tags: ['returns'] },
    });
  });
  it('a file that holds its records under test_cases / goldens is read through it', () => {
    expect(parseRagDatasetText(JSON.stringify({ goldens: [{ input: 'a' }, { input: 'b' }] }), 'json')).toHaveLength(2);
    expect(parseRagDatasetText('input,expected_output\nq1,a1\nq2,a2\n', 'csv')).toEqual([{ input: 'q1', expected_output: 'a1' }, { input: 'q2', expected_output: 'a2' }]);
  });
});

describe('TestPion records', () => {
  it('stay as they are on import, and export to the other formats', () => {
    const own = [{ question: 'q', reference: 'r', reference_ids: ['a', 'b'] }];
    expect(importRagRecords(own).records).toEqual(own);
    expect(exportRagRecords(own, 'ragas')).toEqual([{ user_input: 'q', reference_context_ids: ['a', 'b'], reference: 'r' }]);
    expect(stringifyRagRecords(own)).toBe('{"question":"q","reference":"r","reference_ids":["a","b"]}\n');
  });
  it('a dataset with a record without a question says which one', () => {
    const r = importRagRecords([{ input: '', expected_output: 'x' }], 'deepeval');
    expect(r.records).toEqual([]);
    expect(r.notes[0]).toMatch(/Record 1 has no question/);
  });
});
