import { describe, it, expect } from 'vitest';
import { checkFn, checkTypes, overrideCheck, registerCheck, unregisterCheck } from '../../packages/core/src/index.js';

describe('the check registry', () => {
  it('loads every check module without a name registered twice (a second registration throws: which module loaded last must not decide)', () => {
    // importing the engine registered ~130 types; a duplicate would have thrown at import time
    expect(checkTypes().length).toBeGreaterThan(100);
    for (const t of ['status', 'context-precision', 'groundedness', 'faithfulness', 'answer-correctness', 'llm-judge']) expect(checkFn(t), t).toBeTypeOf('function');
  });

  it('registerCheck refuses a type that exists; overrideCheck replaces it on purpose; unregisterCheck frees the name', () => {
    const a = () => ({ type: 'x', name: 'x', passed: true, source: 'deterministic' as const, message: 'a' });
    const b = () => ({ type: 'x', name: 'x', passed: false, source: 'deterministic' as const, message: 'b' });
    registerCheck('b41-test-check', a);
    expect(() => registerCheck('b41-test-check', b)).toThrow(/already registered/);
    expect(checkFn('b41-test-check')).toBe(a);
    overrideCheck('b41-test-check', b);
    expect(checkFn('b41-test-check')).toBe(b);
    unregisterCheck('b41-test-check');
    expect(checkFn('b41-test-check')).toBeUndefined();
    registerCheck('b41-test-check', a);
    unregisterCheck('b41-test-check');
  });

  it('the strict RAG metrics take over the older checks by name through overrideCheck only', () => {
    // the older checks are in their own file; the judged metrics replace some of their names on purpose
    expect(checkFn('context-precision')).toBeTypeOf('function');
    expect(() => registerCheck('context-precision', () => ({ type: 'x', name: 'x', passed: true, source: 'deterministic', message: '' }))).toThrow();
  });
});
