import { describe, expect, it } from 'vitest';
import { idRetrieval, lcsLength, normalizeAnswer, rouge, tokenOverlap, runChecks, type CheckContext } from '../../packages/core/src/index.js';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

describe('answer against the reference (worked examples of planning/rag-testing.md §2.3)', () => {
  it('normalised match: case, punctuation and articles do not count', () => {
    expect(normalizeAnswer('The Cat, sat!')).toBe('cat sat');
    expect(normalizeAnswer('  A   dog  ')).toBe('dog');
  });

  it('token F1: "the cat sat" against "a cat sat" is 2/3 on each side', () => {
    const o = tokenOverlap('the cat sat', 'a cat sat');
    expect(r3(o.precision)).toBe(0.667);
    expect(r3(o.recall)).toBe(0.667);
    expect(r3(o.f1)).toBe(0.667);
    // the SQuAD normalisation drops the articles first, so the two are the same
    expect(tokenOverlap('the cat sat', 'a cat sat', { normalize: true }).f1).toBe(1);
  });

  it('token F1 counts a repeated word as often as the reference has it', () => {
    expect(r3(tokenOverlap('cat cat cat', 'cat dog').f1)).toBe(0.4);
  });

  it('ROUGE-1 and ROUGE-L: "the cat sat" against "the cat sat down" is precision 1, recall 0.75, F 0.857', () => {
    for (const type of ['rouge1', 'rougeL'] as const) {
      const o = rouge('the cat sat', 'the cat sat down', type);
      expect(o.precision, type).toBe(1);
      expect(o.recall, type).toBe(0.75);
      expect(r3(o.f1), type).toBe(0.857);
    }
  });

  it('ROUGE-2 counts bigrams', () => {
    const o = rouge('the cat sat', 'the cat sat down', 'rouge2');
    expect(o.precision).toBe(1);
    expect(r3(o.recall)).toBe(0.667);
    expect(r3(o.f1)).toBe(0.8);
  });

  it('ROUGE-L is the longest common subsequence: "police killed the gunman" against "police kill the gunman" is 3 of 4', () => {
    expect(lcsLength(['police', 'killed', 'the', 'gunman'], ['police', 'kill', 'the', 'gunman'])).toBe(3);
    expect(rouge('police killed the gunman', 'police kill the gunman', 'rougeL').f1).toBe(0.75);
  });

  it('empty text scores 0 and never divides by zero', () => {
    expect(rouge('', 'a b').f1).toBe(0);
    expect(tokenOverlap('a b', '').f1).toBe(0);
    expect(tokenOverlap('', '').f1).toBe(0);
  });
});

describe('retrieval against the gold ids', () => {
  it('precision and recall by id (Ragas IDBasedContextPrecision / IDBasedContextRecall examples)', () => {
    const a = idRetrieval(['a', 'b', 'c', 'd'], ['a', 'c']);
    expect(a.precision).toBe(0.5);
    expect(a.recall).toBe(1);
    expect(a.extra).toEqual(['b', 'd']);
    const b = idRetrieval(['a', 'b', 'c', 'd'], ['a', 'c', 'e']);
    expect(r3(b.recall)).toBe(0.667);
    expect(b.missed).toEqual(['e']);
    expect(idRetrieval(['a'], ['x', 'y', 'z', 'w']).recall).toBe(0.0);
  });

  it('a retrieved id listed twice counts once', () => {
    expect(idRetrieval(['a', 'a', 'b'], ['a']).precision).toBe(0.5);
  });
});

describe('the metrics as checks', () => {
  const ctx = (text: string, o: Partial<CheckContext> = {}): CheckContext => ({ testType: 'rag', body: text, text, expected: 'The clinic opens at 8am', ...o });
  it('token-f1, rouge and normalized-match read the record’s reference answer', async () => {
    const [f1, rg, nm, nm2] = await runChecks([{ type: 'token-f1', threshold: 0.9 }, { type: 'rouge', rouge: 'rougeL', mode: 'recall', threshold: 1 }, { type: 'normalized-match' }, { type: 'normalized-match', expected: 'the CLINIC opens at 8am!' }], ctx('The clinic opens at 8am on weekdays'));
    expect(f1).toMatchObject({ passed: false, score: 0.833 });
    expect(rg).toMatchObject({ passed: true, score: 1 });
    expect(nm!.passed).toBe(false);
    expect(nm2).toMatchObject({ passed: false });
    const [ok] = await runChecks([{ type: 'normalized-match', expected: 'the CLINIC opens at 8am!' }], ctx('The clinic opens at 8am'));
    expect(ok).toMatchObject({ passed: true, score: 1 });
  });

  it('a missing reference is a failed check that says how to fix it', async () => {
    const [r] = await runChecks([{ type: 'token-f1' }], ctx('x', { expected: undefined }));
    expect(r).toMatchObject({ passed: false });
    expect(r!.message).toMatch(/reference/);
  });

  it('context-recall-ids and context-precision-ids compare the retrieved ids with reference_ids', async () => {
    const docs = ['a', 'b', 'c', 'd'].map((id) => ({ id, text: id }));
    const [rec, prec, missing] = await runChecks(
      [{ type: 'context-recall-ids', threshold: 0.6 }, { type: 'context-precision-ids', threshold: 0.6 }, { type: 'context-recall-ids' }],
      { ...ctx('x'), contexts: docs, referenceIds: ['a', 'c', 'e'] },
    );
    expect(rec).toMatchObject({ passed: true, score: 0.667 });
    expect(prec).toMatchObject({ passed: false, score: 0.5 });
    expect((rec!.metadata as { missed: string[] }).missed).toEqual(['e']);
    // the default threshold of recall is 0.8
    expect(missing).toMatchObject({ passed: false, score: 0.667 });
    const [noIds] = await runChecks([{ type: 'context-recall-ids' }], { ...ctx('x'), contexts: docs });
    expect(noIds!.message).toMatch(/reference_ids/);
    const [nothing] = await runChecks([{ type: 'context-recall-ids' }], { ...ctx('x'), contexts: [], referenceIds: ['a'] });
    expect(nothing).toMatchObject({ passed: false, score: 0 });
  });
});
