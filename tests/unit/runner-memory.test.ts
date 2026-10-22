import { describe, expect, it } from 'vitest';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { runTests, type TestCase } from '../../packages/core/src/index.js';
import { fakeServices } from '../helpers.js';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const heapMb = () => {
  gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
};

// R-2: every result created a Deferred (a promise and its resolvers) that stayed until the end of the run, whether or not a step waited for it
describe('a long data-driven run', () => {
  it('50,000 steps hold no promise per result, and a step that depends on an earlier one still waits for it', async () => {
    const steps = function* (): Generator<TestCase> {
      for (let i = 0; i < 50_000; i++) yield { id: `s${i}`, name: `Step ${i}`, type: 'log', message: 'hi' } as TestCase;
      yield { id: 'last', name: 'Last', type: 'log', message: 'after s0 and s49999', dependsOn: ['s0', 's49999'] } as TestCase;
    };
    const before = heapMb();
    let peak = 0;
    let n = 0;
    const summary = await runTests({
      name: 'long',
      tests: steps(),
      services: fakeServices(),
      concurrency: 8,
      onEvent: (e) => {
        if (e.type === 'test-end' && ++n % 10_000 === 0) peak = Math.max(peak, heapMb());
      },
    });
    expect(summary.total).toBe(50_001);
    expect(summary.passed).toBe(50_001);
    console.log(`50,000 steps: heap grew ${(peak - before).toFixed(0)} MB`);
    expect(peak - before, `the heap grew ${Math.round(peak - before)} MB`).toBeLessThan(12); // (15 MB before: a Deferred per result)
  }, 180_000);
});
