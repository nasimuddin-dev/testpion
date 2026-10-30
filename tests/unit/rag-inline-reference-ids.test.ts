import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTestsFromFile, runChecks, type CheckContext, type TestCase } from '../../packages/core/src/index.js';
import { REFUSAL } from '../../packages/core/src/eval/rag/failure.js';

/**
 * The measures of a bot's retrieval read the right documents wherever the test names them (found with the Learn by example
 * files of the Examples workspace): a rag test without a target (an answer and contexts written in the file), a record whose
 * `reference_ids` is an empty list (no document is right: an unanswerable question), and an answer that says it found nothing.
 */
const ctx = (over: Partial<CheckContext>): CheckContext => ({ testType: 'rag', text: '', body: '', ...over }) as CheckContext;

describe('reference ids of a rag test', () => {
  it('an inline rag test keeps reference_ids and reference_contexts, an empty list included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-rag-ids-'));
    try {
      writeFileSync(
        join(dir, 'rag.yaml'),
        [
          'defaults: { type: rag }',
          'tests:',
          '  - { name: ids, question: q, answer: a, contexts: [{ id: d-1, text: t }], reference_ids: [d-1, d-2], reference_contexts: [t] }',
          '  - { name: none, question: q, answer: a, contexts: [{ id: d-1, text: t }], reference_ids: [] }',
          '  - { name: missing, question: q, answer: a, contexts: [{ id: d-1, text: t }] }',
        ].join('\n'),
      );
      const tests: TestCase[] = [];
      for await (const t of loadTestsFromFile(join(dir, 'rag.yaml'))) tests.push(t);
      const [ids, none, missing] = tests as Array<TestCase & { referenceIds?: string[]; referenceContexts?: string[] }>;
      expect(ids!.referenceIds).toEqual(['d-1', 'd-2']);
      expect(ids!.referenceContexts).toEqual(['t']);
      expect(none!.referenceIds).toEqual([]);
      expect(missing!.referenceIds).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the id measures read them from the check context: found, missing column, and nothing to find', async () => {
    const found = await runChecks([{ type: 'context-recall-ids', threshold: 1 }, { type: 'precision@1' }], ctx({ contexts: [{ id: 'd-1', text: 't' }], referenceIds: ['d-1'] }));
    expect(found.map((r) => r.passed)).toEqual([true, true]);
    const missing = await runChecks([{ type: 'context-recall-ids' }], ctx({ contexts: [{ id: 'd-1', text: 't' }] }));
    expect(missing[0]!.passed).toBe(false);
    expect(missing[0]!.message).toMatch(/needs the gold chunk ids/);
    // an unanswerable record names no right document: nothing can be missed, and the message says so
    const none = await runChecks([{ type: 'context-recall-ids' }, { type: 'precision@3' }, { type: 'r-precision' }], ctx({ contexts: [{ id: 'd-9', text: 't' }], referenceIds: [] }));
    expect(none.map((r) => r.passed)).toEqual([true, true, true]);
    expect(none[0]!.message).toMatch(/names no right document/);
    expect(none[0]!.metadata).toMatchObject({ notApplicable: true });
  });

  it('an answer that found nothing in the documents counts as declining', () => {
    for (const s of ['I could not find that in the handbook.', "I couldn't find an answer in the documents.", 'The documents do not say.', 'That is not mentioned in the sources.', "I don't know."]) expect(REFUSAL.test(s), s).toBe(true);
    for (const s of ['Annual leave is 25 days a year.', 'You can find the form in the Expenses app.']) expect(REFUSAL.test(s), s).toBe(false);
  });
});
