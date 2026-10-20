/**
 * The retrieval measures of the catalogue (planning/rag-testing.md §2.3, type 2), each with its worked example, as the
 * pure functions and as checks over a sample; and the lexical metrics.
 */
import { describe, expect, it } from 'vitest';
import { averagePrecisionAt, hitRateAt, levenshtein, mrrAt, ndcgAt, precisionAt, rankedAveragePrecision, recallAt, rPrecision, runChecks, similarityRatio, type CheckContext } from '../../packages/core/src/index.js';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

describe('IR measures: the worked examples', () => {
  it('recall@k, precision@k, hit-rate@k', () => {
    expect(r3(recallAt(['a', 'b', 'c', 'd'], ['a', 'e'], 3))).toBe(0.5);
    expect(r3(precisionAt(['a', 'b', 'c', 'd'], ['a', 'e'], 3))).toBe(0.333);
    expect(hitRateAt(['b', 'a', 'c'], ['a', 'e'], 3)).toBe(1);
    expect(hitRateAt(['b', 'c', 'x', 'a'], ['a', 'e'], 3)).toBe(0);
  });

  it('precision is over k, not over what came back', () => {
    expect(precisionAt(['a'], ['a'], 5)).toBe(0.2);
  });

  it('mrr@k: 1 / rank of the first gold id', () => {
    expect(mrrAt(['a', 'b', 'c'], ['b'])).toBe(0.5);
    expect(mrrAt(['a', 'b', 'c'], ['z'])).toBe(0);
    expect(mrrAt(['a', 'b', 'c'], ['c'], 2)).toBe(0);
  });

  it('ndcg@k: [x, a, b] with gold {a, b} → 0.693', () => {
    expect(r3(ndcgAt(['x', 'a', 'b'], ['a', 'b'], 3))).toBe(0.693);
    expect(ndcgAt(['a', 'b'], ['a', 'b'], 3)).toBe(1);
    expect(ndcgAt(['x'], ['a'], 3)).toBe(0);
  });

  it('map@k: gold {a, c, e}, retrieved [a, b, c], k = 3 → 0.556 (gold never retrieved count as 0)', () => {
    expect(r3(averagePrecisionAt(['a', 'b', 'c'], ['a', 'c', 'e'], 3))).toBe(0.556);
  });

  it('r-precision: gold {a, c}, retrieved [a, b, c] → precision in the top 2 = 0.5', () => {
    expect(rPrecision(['a', 'b', 'c'], ['a', 'c'])).toBe(0.5);
  });

  it('a chunk retrieved twice counts once', () => {
    expect(recallAt(['a', 'a', 'b'], ['b'], 2)).toBe(1);
    expect(precisionAt(['a', 'a', 'b'], ['b'], 2)).toBe(0.5);
  });

  it('ranked average precision (the Ragas context-precision formula): [✓, ✗, ✓] → 0.833, [✗, ✓] → 0.5', () => {
    expect(r3(rankedAveragePrecision([true, false, true]))).toBe(0.833);
    expect(rankedAveragePrecision([false, true])).toBe(0.5);
    expect(rankedAveragePrecision([false, false])).toBe(0);
  });
});

describe('string similarity', () => {
  it('Levenshtein: kitten → sitting is 3', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(r3(similarityRatio('kitten', 'sitting'))).toBe(0.571);
    expect(similarityRatio('', '')).toBe(1);
  });
});

const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({
  testType: 'rag',
  body: '',
  text: 'The clinic opens at 8am.',
  contexts: ['a', 'b', 'c', 'd'].map((id) => ({ id, text: `text of ${id}` })),
  referenceIds: ['a', 'c', 'e'],
  ...over,
});

describe('as checks', () => {
  it('score, threshold and what was found are in the result', async () => {
    const [recall, precision, hit, mrr, ndcg, map, rp] = await runChecks(
      [{ type: 'recall@k', k: 3 }, { type: 'precision@k', k: 3 }, { type: 'hit-rate@k', k: 3 }, { type: 'mrr@k', k: 3 }, { type: 'ndcg@k', k: 3 }, { type: 'map@k', k: 3 }, { type: 'r-precision' }],
      ctx(),
    );
    expect(recall).toMatchObject({ score: 0.667, passed: false });
    expect(precision!.score).toBe(0.667);
    expect(hit!.score).toBe(1);
    expect(mrr!.score).toBe(1);
    // DCG 1 + 0.5 = 1.5 over the ideal 1 + 0.631 + 0.5
    expect(ndcg!.score).toBe(0.704);
    expect(map!.score).toBe(0.556);
    expect(rp!.score).toBe(0.667);
  });

  it('nothing retrieved is 0 (a failure of the retriever), not n/a; no gold ids says what to add', async () => {
    const [none, missing] = await runChecks([{ type: 'recall@k', k: 5 }, { type: 'recall@k' }], ctx({ contexts: [] }));
    expect(none).toMatchObject({ score: 0, passed: false });
    const [m] = await runChecks([{ type: 'ndcg@k' }], ctx({ referenceIds: undefined }));
    expect(m!.message).toMatch(/reference_ids/);
    expect(missing).toBeDefined();
  });

  it('lexical context precision and recall use the gold chunk TEXTS', async () => {
    const gold = ['Paws Clinic opens at 8am Monday to Friday.', 'Parking is behind the building.', 'Closed on public holidays.'];
    const c = ctx({
      contexts: [
        { id: 'x', text: 'Paws Clinic opens at 8am Monday to Friday.' },
        { id: 'y', text: 'Our history began in 1999 with a single room.' },
        { id: 'z', text: 'Parking is behind the building.' },
      ],
      referenceContexts: gold,
    });
    const [p, r] = await runChecks([{ type: 'context-precision-lexical' }, { type: 'context-recall-lexical' }], c);
    // relevant [✓, ✗, ✓] → (1/1 + 2/3) / 2 = 0.833; 2 of 3 gold chunks matched = 0.667
    expect(p!.score).toBe(0.833);
    expect(r!.score).toBe(0.667);
    const [none] = await runChecks([{ type: 'context-recall-lexical' }], ctx({ referenceContexts: undefined }));
    expect(none!.message).toMatch(/reference_contexts/);
  });

  it('string-similarity compares the answer with the reference as text', async () => {
    const [r] = await runChecks([{ type: 'string-similarity', threshold: 0.5 }], ctx({ text: 'kitten', expected: 'sitting' }));
    expect(r).toMatchObject({ score: 0.571, passed: true });
    const [folded] = await runChecks([{ type: 'string-similarity', normalize: true }], ctx({ text: 'Paris ', expected: 'paris' }));
    expect(folded!.score).toBe(1);
  });
});
