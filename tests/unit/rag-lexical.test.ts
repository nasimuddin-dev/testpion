/**
 * The lexical and structural measures of the catalogue, each with a known value: BLEU and chrF as sacreBLEU defines
 * them (hand-computed from the definition), number and JSON difference, set F1 of labels, quoted spans, Hole@k and graded
 * nDCG. No model is called.
 */
import { describe, expect, it } from 'vitest';
import { bleu, chrf, firstNumber, holeAt, jsonSimilarity, labelPrf, ndcgAt, ndcgGraded, numericCompare, numericSimilarity, quotedSpans, quotedSpansAlignment, tokenize13a } from '../../packages/core/src/index.js';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

describe('tokenize13a', () => {
  it('splits punctuation, keeps a decimal number together', () => {
    expect(tokenize13a('Hello, world! It costs 3.50.')).toEqual(['Hello', ',', 'world', '!', 'It', 'costs', '3.50', '.']);
    expect(tokenize13a('state-of-the-art 5-star')).toEqual(['state-of-the-art', '5', '-', 'star']);
    expect(tokenize13a('say &quot;hi&quot;')).toEqual(['say', '"', 'hi', '"']);
  });
});

describe('bleu (sacreBLEU, exp smoothing)', () => {
  it('identical texts score 1', () => {
    expect(r3(bleu('The dog bit the man.', 'The dog bit the man.', { segmentation: 'whole' }).score)).toBe(1);
  });

  it('“the cat sat on the mat” against “the cat is on the mat”: precisions 5/6, 3/5, 1/4, 0/3 smoothed to 1/6 → 0.38', () => {
    const { score, stats } = bleu('the cat sat on the mat', 'the cat is on the mat');
    expect(stats.correct).toEqual([5, 3, 1, 0]);
    expect(stats.total).toEqual([6, 5, 4, 3]);
    expect(r3(score)).toBe(0.38);
  });

  it('a hypothesis shorter than the reference is penalised (brevity penalty exp(1 − ref/hyp))', () => {
    // 4 of 4 unigrams, 3 of 3, 2 of 2, 1 of 1: every precision 100, brevity penalty exp(1 - 8/4)
    const { score } = bleu('a b c d', 'a b c d e f g h', { segmentation: 'whole' });
    expect(r3(score)).toBe(r3(Math.exp(1 - 8 / 4)));
  });

  it('a hypothesis with fewer than four words scores about 0 (sacreBLEU’s behaviour without effective order)', () => {
    expect(bleu('the cat sat', 'the cat sat').score).toBeLessThan(1e-6);
  });

  it('Ragas segmentation splits on ". " and scores the segments as one corpus; whole does not', () => {
    const a = bleu('The cat sat on the mat. The dog ran home fast.', 'The cat sat on the mat. The dog ran home fast.');
    // "The cat sat on the mat" (6 tokens) and "The dog ran home fast." (5 words and the period)
    expect(a.stats.hypLen).toBe(12);
    expect(r3(a.score)).toBe(1);
    expect(r3(bleu('One two three four five. Six seven eight nine ten.', 'One two three four five. Six seven eight nine ten.', { segmentation: 'whole' }).score)).toBe(1);
  });
});

describe('chrf (sacreBLEU defaults)', () => {
  it('identical texts score 1, ignoring spaces', () => {
    expect(chrf('hello world', 'helloworld')).toBe(1);
  });

  it('“abcd” against “abce”: orders 1 to 4 give 0.75, 0.667, 0.5, 0 → 0.479 (orders 5 and 6 have no n-gram)', () => {
    expect(r3(chrf('abcd', 'abce'))).toBe(0.479);
  });

  it('no overlap scores 0', () => {
    expect(chrf('aaaa', 'bbbb')).toBe(0);
  });

  it('beta weighs recall: a hypothesis that covers the reference but adds text scores higher than the reverse', () => {
    expect(chrf('abcdefgh extra words', 'abcdefgh')).toBeGreaterThan(chrf('abcdefgh', 'abcdefgh extra words'));
  });
});

describe('numbers', () => {
  it('the first number of a text', () => {
    expect(firstNumber('It costs $1,250.50 today')).toBe(1250.5);
    expect(firstNumber('about 95%')).toBe(95);
    expect(firstNumber('no digits')).toBeUndefined();
    expect(firstNumber(7)).toBe(7);
  });

  it('similarity: 95 against 100 → 0.95; equal and zero cases', () => {
    expect(numericSimilarity(95, 100)).toBeCloseTo(0.95, 6);
    expect(numericSimilarity(0, 0)).toBe(1);
    expect(numericSimilarity(-5, 5)).toBe(0);
    expect(numericSimilarity(200, 100)).toBeCloseTo(0.5, 6);
  });

  it('comparisons with an epsilon', () => {
    expect(numericCompare(1.0001, 1, '==', 0.001)).toBe(true);
    expect(numericCompare(1.1, 1, '==', 0.001)).toBe(false);
    expect(numericCompare(5, 4, '>')).toBe(true);
    expect(numericCompare(4, 4, '>')).toBe(false);
    expect(numericCompare(4, 4, '>=')).toBe(true);
    expect(numericCompare(3, 4, '<')).toBe(true);
    expect(numericCompare(3, 4, '!=')).toBe(true);
  });
});

describe('json similarity', () => {
  it('{a: 1, b: "x"} against {a: 1, b: "y"} → 0.5', () => {
    expect(jsonSimilarity({ a: 1, b: 'x' }, { a: 1, b: 'y' })).toBe(0.5);
  });
  it('a missing key is 0, a list is compared element by element, strings by edit similarity', () => {
    expect(jsonSimilarity({ a: 1 }, { a: 1, b: 2 })).toBe(0.5);
    expect(jsonSimilarity([1, 2, 3], [1, 2])).toBeCloseTo(2 / 3, 6);
    expect(jsonSimilarity('kitten', 'sitting')).toBeCloseTo(1 - 3 / 7, 6);
    expect(jsonSimilarity({ a: { b: 1 } }, { a: { b: 2 } })).toBeCloseTo(0.5, 6);
    expect(jsonSimilarity(null, 1)).toBe(0);
  });
});

describe('label F1', () => {
  it('expected {a, b}, answered {a, c} → precision 0.5, recall 0.5, F1 0.5', () => {
    const r = labelPrf(['a', 'c'], ['a', 'b']);
    expect([r.precision, r.recall, r.f1]).toEqual([0.5, 0.5, 0.5]);
    expect(r.missing).toEqual(['b']);
    expect(r.extra).toEqual(['c']);
  });
  it('case is ignored unless asked', () => {
    expect(labelPrf(['Billing'], ['billing']).f1).toBe(1);
    expect(labelPrf(['Billing'], ['billing'], { caseSensitive: true }).f1).toBe(0);
  });
});

describe('quoted spans', () => {
  it('finds quotations of three words or more; apostrophes are not quotes', () => {
    expect(quotedSpans('He said "opens at eight" and "yes". It\'s fine, don\'t worry.')).toEqual(['opens at eight']);
    expect(quotedSpans('She wrote “the clinic is closed on sundays” today')).toEqual(['the clinic is closed on sundays']);
  });
  it('two quotes, one found in the documents → 1 of 2', () => {
    const r = quotedSpansAlignment('The page says "opens at 8am daily" and "free parking for all".', ['The clinic Opens at 8AM daily, except holidays.']);
    expect(r.spans).toHaveLength(2);
    expect(r.found).toEqual([true, false]);
  });
});

describe('Hole@k and graded nDCG', () => {
  it('3 of the top 10 have no label → 0.3', () => {
    const top10 = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    expect(holeAt(top10, ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 10)).toBe(0.3);
    expect(holeAt([], ['a'], 10)).toBe(0);
  });

  it('graded nDCG: grades [3, 2, 0] retrieved in the ideal order → 1; swapped → less', () => {
    const grades = { a: 3, b: 2, c: 0 };
    expect(ndcgGraded(['a', 'b', 'c'], grades, 3)).toBe(1);
    // DCG = 2/1 + 3/log2(3) = 3.893; ideal = 3 + 2/log2(3) = 4.262
    expect(r3(ndcgGraded(['b', 'a', 'c'], grades, 3))).toBe(0.913);
  });

  it('exponential gain weighs high grades more: 2^3 − 1 = 7 against 2^2 − 1 = 3', () => {
    const lin = ndcgGraded(['b', 'a'], { a: 3, b: 2 }, 2);
    const exp = ndcgGraded(['b', 'a'], { a: 3, b: 2 }, 2, { gain: 'exponential' });
    expect(exp).toBeLessThan(lin);
  });

  it('with binary grades it equals the binary nDCG of the catalogue (the worked example 0.693)', () => {
    expect(r3(ndcgGraded(['x', 'a', 'b'], { a: 1, b: 1 }, 3))).toBe(0.693);
    expect(r3(ndcgAt(['x', 'a', 'b'], ['a', 'b'], 3))).toBe(0.693);
    expect(r3(ndcgGraded(['x', 'a', 'b'], {}, 3, { gold: ['a', 'b'] }))).toBe(0.693);
  });
});
