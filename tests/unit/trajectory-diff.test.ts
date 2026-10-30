import { describe, expect, it } from 'vitest';
import { diffTrajectory, trajectoryOf, type TestResult } from '../../packages/core/src/index.js';

/** A-2: how the tools of a run differ from the golden run's, per case. */
const run = (...calls: Array<[string, Record<string, unknown>]>): ReturnType<typeof trajectoryOf> & object =>
  trajectoryOf({
    id: 'e:c',
    name: 'c',
    type: 'agent',
    status: 'passed',
    input: 'q',
    output: 'a',
    checks: [],
    metadata: { agent: { steps: calls.length + 1, modelCalls: calls.length + 1, stoppedReason: 'final', toolCalls: calls.map(([name, args], i) => ({ step: i + 1, name, source: 'mock', arguments: args, result: 'ok', isError: false, durationMs: 1 })) } },
  } as unknown as TestResult)!;

describe('diffTrajectory', () => {
  it('the same tools in the same order with the same arguments', () => {
    const d = diffTrajectory(run(['search', { q: 'hours' }], ['open', {}]), run(['search', { q: 'hours' }], ['open', {}]));
    expect(d).toMatchObject({ kind: 'same', text: 'Same tools in the same order, with the same arguments.' });
    expect(diffTrajectory(run(), run())).toMatchObject({ kind: 'same', text: 'No tool was called, as in the baseline.' });
  });

  it('a tool dropped and one added', () => {
    const d = diffTrajectory(run(['search', {}], ['open', {}]), run(['search', {}], ['delete', {}]));
    expect(d).toMatchObject({ kind: 'tools-changed', dropped: ['open'], added: ['delete'] });
    expect(d.text).toBe('Dropped open; added delete. Baseline: search → open. Now: search → delete.');
    expect(diffTrajectory(run(['search', {}]), run())).toMatchObject({ kind: 'tools-changed', dropped: ['search'], text: 'Dropped search. Baseline: search. Now: no tool.' });
  });

  it('a tool called more times than before counts as added', () => {
    const d = diffTrajectory(run(['search', {}]), run(['search', {}], ['search', {}]));
    expect(d).toMatchObject({ kind: 'tools-changed', added: ['search'], dropped: [] });
  });

  it('the same tools in another order', () => {
    const d = diffTrajectory(run(['a', {}], ['b', {}]), run(['b', {}], ['a', {}]));
    expect(d).toMatchObject({ kind: 'reordered', text: 'Same tools in another order. Baseline: a → b. Now: b → a.' });
  });

  it('the same call with other arguments', () => {
    const d = diffTrajectory(run(['search', { q: 'hours' }]), run(['search', { q: 'weekend hours' }]));
    expect(d.kind).toBe('arguments-differ');
    expect(d.argumentsDiffer).toEqual([{ tool: 'search', baseline: { q: 'hours' }, now: { q: 'weekend hours' } }]);
    expect(d.text).toBe('Same tools in the same order, but search was called with other arguments: {"q":"hours"} → {"q":"weekend hours"}.');
  });
});
