import { describe, expect, it } from 'vitest';
import { executeTest, lintTestFile, McpManager, normalizeTest, ProviderRegistry, Redactor, runTests, Tracer, VariableScope, type ExecServices, type TestCase } from '../../packages/core/src/index.js';

function services(timeoutMs = 5000): ExecServices {
  const vars = new VariableScope();
  const redactor = new Redactor();
  return { vars, providers: new ProviderRegistry([], vars, redactor), mcp: new McpManager(() => undefined), mcpServers: [], redactor, pricing: [], defaultTimeoutMs: timeoutMs };
}

const llm = (id: string, extra: Partial<TestCase> = {}): TestCase =>
  ({ id, name: id, type: 'llm', model: { provider: 'mock', name: 'mock' }, prompt: `hello ${id}`, assertions: [{ type: 'contains', expected: `hello ${id}` }], ...extra }) as TestCase;

// A Delay step: a pause in a flow (type: delay, ms), honouring dependsOn, cancellable, capped by the timeout.
describe('delay step', () => {
  it('loads from ms (canonical) and duration, and refuses a bad wait', () => {
    expect(normalizeTest({ name: 'Wait for the index', type: 'delay', ms: 2000 })).toMatchObject({ type: 'delay', ms: 2000 });
    expect(normalizeTest({ name: 'w', type: 'delay', duration: '2s' })).toMatchObject({ ms: 2000 });
    expect(normalizeTest({ name: 'w', type: 'delay', duration: '500ms' })).toMatchObject({ ms: 500 });
    expect(normalizeTest({ name: 'w', type: 'delay', ms: '250' })).toMatchObject({ ms: 250 });
    expect(() => normalizeTest({ name: 'w', type: 'delay' })).toThrow(/needs ms/);
    expect(() => normalizeTest({ name: 'w', type: 'delay', ms: -1 })).toThrow(/0 ms or more/);
    expect(() => normalizeTest({ name: 'w', type: 'delay', ms: 600_001 })).toThrow(/at most 10 minutes/);
  });

  it('waits, passes, and has no request or output', async () => {
    const t0 = Date.now();
    const summary = await runTests({ name: 'delay', tests: [normalizeTest({ id: 'w', name: 'Wait', type: 'delay', ms: 150 })], services: services() });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(summary).toMatchObject({ total: 1, passed: 1 });
  });

  it('honours dependsOn: the step after it starts only when the wait is over', async () => {
    const order: Array<[string, number]> = [];
    const summary = await runTests({
      name: 'deps',
      tests: [llm('b', { dependsOn: ['wait'] }), normalizeTest({ id: 'wait', name: 'Wait', type: 'delay', ms: 120, dependsOn: ['a'] }), llm('a')],
      concurrency: 4,
      services: services(),
      onEvent: (e) => {
        if (e.type === 'test-end') order.push([e.result.id, e.result.durationMs]);
      },
    });
    expect(summary).toMatchObject({ passed: 3, failed: 0 });
    expect(order.map(([id]) => id)).toEqual(['a', 'wait', 'b']);
    expect(order[1]![1]).toBeGreaterThanOrEqual(100);
  });

  it('stops at once when the run is cancelled', async () => {
    const ctrl = new AbortController();
    const test = normalizeTest({ name: 'Long wait', type: 'delay', ms: 60_000 });
    const t0 = Date.now();
    setTimeout(() => ctrl.abort(), 50);
    await expect(executeTest(test, services(120_000), { tracer: new Tracer('delay'), signal: ctrl.signal })).rejects.toMatchObject({ kind: 'CancelledError' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('never waits longer than the test timeout', async () => {
    const t0 = Date.now();
    const r = await executeTest(normalizeTest({ name: 'w', type: 'delay', ms: 60_000, timeoutMs: 100 }), services(), { tracer: new Tracer('delay') });
    expect(r.status).toBe('passed');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.metadata).toMatchObject({ waitedMs: 100, cappedByTimeoutMs: 100 });
  });

  it('lint: a delay knows ms, flags a bad wait at its key and an unknown key', () => {
    const ok = ['name: Flow', 'tests:', '  - name: Wait for the index', '    type: delay', '    ms: 2000', ''].join('\n');
    expect(lintTestFile(ok)).toEqual([]);
    const bad = [
      'name: Flow',
      'tests:',
      '  - name: Too long',
      '    type: delay',
      '    ms: 900000',
      '  - name: Negative',
      '    type: delay',
      '    ms: -5',
      '  - name: Typo',
      '    type: delay',
      '    ms: 10',
      '    msec: 5',
      '',
    ].join('\n');
    const p = lintTestFile(bad);
    expect(p.find((x) => x.line === 5)).toMatchObject({ severity: 'error', message: expect.stringMatching(/at most 10 minutes/) });
    expect(p.find((x) => x.line === 8)).toMatchObject({ severity: 'error', message: expect.stringMatching(/0 ms or more/) });
    expect(p.find((x) => x.line === 12)).toMatchObject({ severity: 'warning' });
    expect(lintTestFile(['name: w', 'type: delay', 'ms: soon', ''].join('\n'))[0]).toMatchObject({ severity: 'error', line: 3 });
  });
});
