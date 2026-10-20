/**
 * The dataset column mapper: a guess from the names other tools use, the records a choice gives, lists read from cells,
 * unmapped columns kept, and which inputs a dataset's columns do not give a metric.
 */
import { describe, expect, it } from 'vitest';
import { mapColumns, missingDatasetInputs, suggestColumnMapping } from '../../packages/core/src/index.js';

describe('suggestColumnMapping', () => {
  it('guesses from the names tools use; a column is used for one field only', () => {
    expect(suggestColumnMapping(['prompt', 'gold_answer', 'doc_ids', 'qid', 'category'])).toEqual({ question: 'prompt', reference: 'gold_answer', reference_ids: 'doc_ids', id: 'qid', tags: 'category' });
    expect(suggestColumnMapping(['user_input', 'reference', 'retrieved_contexts', 'response'])).toEqual({ question: 'user_input', reference: 'reference', contexts: 'retrieved_contexts', answer: 'response' });
    expect(suggestColumnMapping(['a', 'b'])).toEqual({});
  });
});

describe('mapColumns', () => {
  const records = [
    { prompt: 'q1', gold: 'a1', doc_ids: '["d1","d2"]', topic: 'hours', extra: 7 },
    { prompt: 'q2', gold: '', doc_ids: 'd3;d4', topic: 'policy' },
    { prompt: '', gold: 'orphan' },
  ];

  it('renames the chosen columns, reads lists from cells, keeps the others and drops a record without a question', () => {
    const r = mapColumns(records, { question: 'prompt', reference: 'gold', reference_ids: 'doc_ids', tags: 'topic' });
    expect(r.records).toEqual([
      { question: 'q1', reference: 'a1', reference_ids: ['d1', 'd2'], tags: ['hours'], extra: 7 },
      { question: 'q2', reference_ids: ['d3', 'd4'], tags: ['policy'] },
    ]);
    expect(r.kept).toEqual(['extra']);
    expect(r.notes.join('\n')).toMatch(/1 record\(s\) have no question/);
  });

  it('says when a column is not there or no column is the question', () => {
    expect(mapColumns(records, { question: 'nope' }).notes.join('\n')).toMatch(/column "nope" is not in the dataset/);
    expect(mapColumns(records, {}).notes.join('\n')).toMatch(/No column is the question/);
  });

  it('contexts already retrieved stay a list of objects', () => {
    const r = mapColumns([{ q: 'x', docs: [{ id: 'a', text: 'A' }] }], { question: 'q', contexts: 'docs' });
    expect(r.records[0]!.contexts).toEqual([{ id: 'a', text: 'A' }]);
  });
});

describe('missingDatasetInputs', () => {
  it('names the inputs the columns do not give; the answer and contexts come from the target', () => {
    expect(missingDatasetInputs(['question', 'reference', 'referenceIds', 'answer', 'contexts'], ['question', 'reference'], true)).toEqual(['referenceIds']);
    expect(missingDatasetInputs(['answer', 'contexts'], ['question'], false)).toEqual(['answer', 'contexts']);
    expect(missingDatasetInputs(['answer', 'contexts'], ['question', 'answer', 'contexts'], false)).toEqual([]);
    expect(missingDatasetInputs(['referenceContexts'], ['prompt', 'context'], true)).toEqual([]);
  });
});
