/**
 * The failure taxonomy: why a sample scored low, by deterministic rules over its metric results.
 */
import { describe, expect, it } from 'vitest';
import { classifyFailure, FAILURE_CLASSES, type CheckResult } from '../../packages/core/src/index.js';

const check = (type: string, passed: boolean, over: Partial<CheckResult> = {}): CheckResult => ({ type, name: type, passed, source: 'deterministic', message: `${type} ${passed ? 'ok' : 'low'}`, ...over });
const classify = (checks: CheckResult[], over: Partial<Parameters<typeof classifyFailure>[0]> = {}) => classifyFailure({ checks, answer: 'The clinic opens at 8am.', contexts: 3, ...over });

describe('classifyFailure', () => {
  it('a sample that passed has no failure; n/a is not a failure', () => {
    expect(classify([check('faithfulness', true)])).toBeUndefined();
  });

  it('the system did not answer: system-error; an answer the mapping could not read: format', () => {
    expect(classify([check('latency', false)], { error: { message: 'connect ECONNREFUSED' } })?.class).toBe('system-error');
    expect(classify([check('token-f1', false)], { answer: '' })?.class).toBe('format');
    expect(classify([check('token-f1', false)], { warnings: ['The answer path $.x matched nothing'] })?.class).toBe('format');
  });

  it('a judge that failed is the judge’s error, not the system’s', () => {
    expect(classify([check('faithfulness', false, { source: 'ai-judge', message: 'judge failed: no verdict' })])?.class).toBe('judge-error');
  });

  it('retrieval first: a missed gold chunk or nothing retrieved is a retrieval miss even when the answer is also bad', () => {
    expect(classify([check('context-recall-ids', false), check('faithfulness', false)])?.class).toBe('retrieval-miss');
    expect(classify([check('recall@k', false)])?.class).toBe('retrieval-miss');
    expect(classify([check('faithfulness', false)], { contexts: 0 })?.class).toBe('retrieval-miss');
  });

  it('good retrieval and a refusing answer: false refusal', () => {
    expect(classify([check('factual-correctness', false)], { answer: "I'm sorry, but I can't help with that." })?.class).toBe('false-refusal');
  });

  it('ranking, noise, unfaithful, off-topic, incomplete, citation, operational', () => {
    expect(classify([check('ndcg@k', false)])?.class).toBe('ranking');
    expect(classify([check('precision@k', false)])?.class).toBe('noise');
    expect(classify([check('faithfulness', false), check('token-f1', false)])?.class).toBe('unfaithful');
    expect(classify([check('answer-relevance', false)])?.class).toBe('off-topic');
    expect(classify([check('factual-correctness', false)])?.class).toBe('incomplete');
    expect(classify([check('citation', false)])?.class).toBe('citation');
    expect(classify([check('latency', false)])?.class).toBe('operational');
    expect(classify([check('contains-secret', false)])?.class).toBe('other');
  });

  it('Ragas and legacy names classify like the canonical ones', () => {
    expect(classify([check('LLMContextRecall', false)])?.class).toBe('retrieval-miss');
    expect(classify([check('groundedness', false)])?.class).toBe('unfaithful');
  });

  it('every class has a label and a meaning', () => {
    for (const f of FAILURE_CLASSES) {
      expect(f.label.length).toBeGreaterThan(2);
      expect(f.meaning.length).toBeGreaterThan(20);
    }
  });
});
