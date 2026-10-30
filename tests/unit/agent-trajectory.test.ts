import { describe, expect, it } from 'vitest';
import { trajectoryOf, type CheckResult, type TestResult } from '../../packages/core/src/index.js';

/**
 * A-1: the trajectory of an agent case. The agent asked for search_docs twice (the second time with other arguments) and then called
 * delete_record, which it must never do; the checks about tools are pinned to the step that decided them.
 */
const check = (type: string, passed: boolean, message: string, extra: Partial<CheckResult> = {}): CheckResult => ({ type, name: type, passed, source: 'deterministic', message, ...extra });

const result = (over: Partial<TestResult> = {}, checks: CheckResult[] = []): TestResult =>
  ({
    id: 'agent:case-1',
    name: 'Agent case 1',
    type: 'agent',
    status: 'failed',
    input: 'Find the opening hours and clean up',
    output: 'Done: hours are 9 to 5.',
    checks,
    metadata: {
      agent: {
        steps: 3,
        modelCalls: 3,
        stoppedReason: 'final',
        rounds: [
          { step: 1, text: 'I will look it up.', calls: 1 },
          { step: 2, text: '', calls: 2 },
          { step: 3, text: 'Done: hours are 9 to 5.', calls: 0 },
        ],
        toolCalls: [
          { step: 1, name: 'search_docs', source: 'mock', arguments: { q: 'hours' }, result: '{"hits":2}', isError: false, durationMs: 4 },
          { step: 2, name: 'search_docs', source: 'mock', arguments: { q: 'weekend hours' }, result: '{"hits":0}', isError: false, durationMs: 3 },
          { step: 2, name: 'delete_record', source: 'mock', arguments: { id: 7 }, result: 'Error: not allowed', isError: true, durationMs: 1 },
        ],
      },
    },
    ...over,
  }) as TestResult;

describe('trajectoryOf', () => {
  it('lays the case out as the question, each model call, each tool call and the answer', () => {
    const t = trajectoryOf(result())!;
    expect(t.items.map((i) => `${i.kind}:${i.title}`)).toEqual([
      'input:The question',
      'model:Model call 1: asks for search_docs',
      'tool:search_docs({"q":"hours"})',
      'model:Model call 2: asks for search_docs, delete_record',
      'tool:search_docs({"q":"weekend hours"})',
      'tool:delete_record({"id":7})',
      'model:Model call 3: answers',
      'answer:The final answer',
    ]);
    expect(t.items.find((i) => i.id === 'tool-2')).toMatchObject({ error: true, detail: 'Error: not allowed' });
    expect(t.items[1]!.detail).toBe('I will look it up.');
    expect(t.text).toBe('3 tool calls (search_docs → search_docs → delete_record) in 3 model calls.');
  });

  it('pins "should call" at the call that met it, and where the arguments differ', () => {
    const met = trajectoryOf(result({}, [check('tool-called', true, 'search_docs called 1×', { expected: { tool: 'search_docs', arguments: { q: 'hours' } } })]))!;
    expect(met.items.find((i) => i.id === 'tool-0')!.pins).toEqual([expect.objectContaining({ state: 'ok', text: 'should call search_docs: called here' })]);
    const differs = trajectoryOf(result({}, [check('tool-called', false, 'x', { expected: { tool: 'search_docs', arguments: { q: 'refunds' } } })]))!;
    expect(differs.items.filter((i) => i.pins.length).map((i) => [i.id, i.pins[0]!.state])).toEqual([['tool-0', 'bad'], ['tool-1', 'bad']]);
    const never = trajectoryOf(result({}, [check('tool-called', false, 'x', { expected: { tool: 'send_email' } })]))!;
    expect(never.endPins).toEqual([expect.objectContaining({ state: 'bad', text: 'should call send_email: never called' })]);
  });

  it('pins a forbidden call red at the call, and "never called" grey at the end when it held', () => {
    const forbidden = trajectoryOf(result({}, [check('tool-not-called', false, 'unauthorized tool(s) called: delete_record', { metadata: { tools: ['delete_record'] } })]))!;
    expect(forbidden.items.find((i) => i.id === 'tool-2')!.pins).toEqual([expect.objectContaining({ state: 'bad', text: 'should not call delete_record: called here' })]);
    const held = trajectoryOf(result({}, [check('tool-not-called', true, 'not called', { metadata: { tools: ['refund'] } })]))!;
    expect(held.endPins).toEqual([expect.objectContaining({ state: 'never', text: 'refund: never called (as it should be)' })]);
  });

  it('pins an allow-list, a call limit and invalid arguments on the calls that broke them', () => {
    const t = trajectoryOf(
      result({}, [
        check('allowed-tools', false, 'tools outside the allow-list: delete_record', { expected: ['search_docs'] }),
        check('max-tool-calls', false, 'tool calls 3 outside ≤ 2', { expected: { min: undefined, max: 2 } }),
        check('tool-args-valid', false, 'invalid tool arguments — delete_record: id must be a string'),
        check('tool-sequence', true, 'sequence matches'),
        check('contains', false, 'not a tool check'),
      ]),
    )!;
    const pinsAt = (id: string) => t.items.find((i) => i.id === id)!.pins.map((p) => p.type);
    expect(pinsAt('tool-2')).toEqual(['allowed-tools', 'max-tool-calls', 'tool-args-valid']);
    expect(pinsAt('tool-0')).toEqual([]);
    expect(t.endPins.map((p) => p.type)).toEqual(['tool-sequence']);
  });

  it('reads a run that stored no model rounds, says when the step limit stopped the agent, and is nothing for a case that is not an agent', () => {
    const old = result();
    delete (old.metadata as { agent: { rounds?: unknown } }).agent.rounds;
    (old.metadata as { agent: { stoppedReason: string } }).agent.stoppedReason = 'max-steps';
    const t = trajectoryOf(old)!;
    expect(t.items.map((i) => i.title)).toContain('Model call 1: asks for search_docs');
    expect(t.items.at(-1)!.title).toBe('Stopped at the step limit');
    expect(t.text).toMatch(/stopped at the step limit\.$/);
    expect(trajectoryOf({ ...result(), metadata: {} } as TestResult)).toBeUndefined();
  });
});
