import { describe, expect, it } from 'vitest';
import { firstBadStage, nearestChunk, stagesOf } from '../../apps/desktop/src/lib/rag-stages';

/** R-4: a sample of a bot with sources, by stage: question, retrieved, used, answer. */
describe('stagesOf', () => {
  const ctx = [
    { id: 'doc-1', text: 'The clinic opens at 8am on weekdays and 9am on Saturdays.' },
    { id: 'doc-4', text: 'Emergency care is available around the clock at the main clinic.' },
  ];

  it('says each stage in words and marks the one that went wrong', () => {
    const s = stagesOf({ question: 'Is parking free?', referenceIds: [], contexts: [ctx[1]!] }, [{ ok: false }, { ok: true }], [{ passed: false }, { passed: true }, { passed: true }]);
    expect(s.map((x) => [x.id, x.state])).toEqual([['question', 'info'], ['retrieved', 'info'], ['used', 'bad'], ['answer', 'bad']]);
    expect(s[2]!.summary).toBe('1 of 2 statements backed by the documents');
    expect(s[3]!.summary).toBe('1 of 3 measures failed');
    expect(firstBadStage(s)).toBe('used');
  });

  it('a right document that was not retrieved is a retrieval problem, shown first', () => {
    const s = stagesOf({ question: 'When is the rabies booster due?', referenceIds: ['doc-2'], contexts: [ctx[0]!] }, [], [{ passed: false }]);
    expect(s[1]).toMatchObject({ state: 'bad', summary: '1 document · right documents found 0 of 1' });
    expect(firstBadStage(s)).toBe('retrieved');
  });

  it('nothing retrieved, and everything fine', () => {
    expect(stagesOf({ question: 'q', referenceIds: ['a', 'b'], contexts: [] }, [], [])[1]).toMatchObject({ state: 'bad', summary: 'Nothing was retrieved (2 right documents needed)' });
    const ok = stagesOf({ question: 'q', referenceIds: ['doc-1'], contexts: ctx }, [{ ok: true }], [{ passed: true }]);
    expect(ok.map((x) => x.state)).toEqual(['info', 'ok', 'ok', 'ok']);
    expect(firstBadStage(ok)).toBeUndefined();
    expect(stagesOf(null, [], []).map((x) => x.summary)).toEqual(['No question stored', 'Nothing was retrieved', 'No statements were judged for this measure', 'No measure ran']);
  });
});

describe('nearestChunk', () => {
  it('finds the retrieved document closest to the reference answer, with its rank', () => {
    const ctx = [
      { id: 'doc-1', text: 'The clinic opens at 8am on weekdays.' },
      { id: 'doc-2', text: 'A rabies booster is due every year for dogs.' },
    ];
    expect(nearestChunk('The rabies booster is due every year.', ctx)).toMatchObject({ id: 'doc-2', rank: 2 });
    expect(nearestChunk('Nothing alike here whatsoever', ctx)).toBeUndefined();
    expect(nearestChunk('', ctx)).toBeUndefined();
  });
});
