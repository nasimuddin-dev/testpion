import { describe, expect, it } from 'vitest';
import { retrievedDiff, type TestResult } from '../../packages/core/src/index.js';

/** R-5: what a bot with sources retrieved for one case in two runs. */
const result = (documentIds: string[], referenceIds: string[] = ['hb-2'], failure?: string): TestResult =>
  ({ id: 'e:leave', name: 'leave', type: 'rag', status: failure ? 'failed' : 'passed', checks: [], metadata: { rag: { documentIds, referenceIds, ...(failure ? { failure: { class: failure, reason: 'x', metrics: [] } } : {}) } } }) as unknown as TestResult;

describe('retrievedDiff', () => {
  it('names the documents dropped and added, and how the right ones fared', () => {
    const d = retrievedDiff(result(['hb-2', 'hb-4']), result(['hb-4', 'hb-5'], ['hb-2'], 'retrieval-miss'))!;
    expect(d).toMatchObject({ before: ['hb-2', 'hb-4'], now: ['hb-4', 'hb-5'], added: ['hb-5'], dropped: ['hb-2'], right: { ids: ['hb-2'], foundBefore: 1, foundNow: 0 }, causeNow: 'right document not found' });
    expect(d.causeBefore).toBeUndefined();
    expect(d.text).toBe('Dropped hb-2; added hb-5. Right documents found: 1 of 1 → 0 of 1.');
  });

  it('says when the same documents came back, and works without right documents', () => {
    expect(retrievedDiff(result(['a', 'b'], []), result(['b', 'a'], []))).toMatchObject({ added: [], dropped: [], text: 'The same documents were retrieved.' });
    expect(retrievedDiff(result(['a'], []), result(['a', 'c'], []))!.text).toBe('Added c.');
  });

  it('is nothing for a case that is not a bot with sources', () => {
    const plain = { id: 'e:1', name: '1', type: 'llm', status: 'passed', checks: [], metadata: {} } as unknown as TestResult;
    expect(retrievedDiff(plain, plain)).toBeUndefined();
  });
});
