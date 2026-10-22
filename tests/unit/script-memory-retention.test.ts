import { describe, expect, it } from 'vitest';
import { runScript } from '../../packages/core/src/index.js';

const input = () => ({ request: { method: 'GET', url: 'http://x', headers: [] }, vars: {}, environment: {} }) as never;

// garbage a script leaves (cycles only the collector frees) counts against the next script of the pooled context
describe('script runtime memory across pooled runs', () => {
  it('fifty scripts that each leave about 20 MB of cyclic garbage all succeed within a 32 MB limit', async () => {
    const leak = `for (let i = 0; i < 40; i++) { const a = { pad: new Array(60000).fill(i) }; a.self = a; }
      tp.environment.set('done', 'yes');`;
    for (let i = 0; i < 50; i++) {
      const out = await runScript(leak, input(), { memoryMb: 32 });
      expect(out.error, `run ${i + 1}`).toBeUndefined();
      expect(out.scopeSets.environment.done).toBe('yes');
    }
  }, 120_000);

  it('a normal script right after still runs', async () => {
    const out = await runScript(`tp.environment.set('v', String(1 + 1));`, input());
    expect(out.scopeSets.environment.v).toBe('2');
  });
});
