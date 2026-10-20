import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngineContext, defaultSettings, lintTestFile, loadTestsFromFile, MemorySecretStore, paceOf, runTests, WorkspaceStore, type TestCase } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

/**
 * `pace:` (B-13): a rate limit for a test file. Steps with a pace start at least that far apart across the whole run, even
 * with the default concurrency — what a security test file relies on to stay gentle. The key is read, linted and shown in
 * the key reference like every other.
 */

describe('pace:', () => {
  it('reads a duration of 1 ms to a minute, in any of the duration spellings', () => {
    expect(paceOf({ pace: '250ms' })).toBe(250);
    expect(paceOf({ pace: 1 })).toBe(1);
    expect(paceOf({ pace: '1s' })).toBe(1000);
    expect(paceOf({ paceMs: 40 })).toBe(40);
    expect(paceOf({})).toBeUndefined();
    expect(paceOf({ pace: 0 })).toMatch(/1 ms to one minute/);
    expect(paceOf({ pace: '2h' })).toMatch(/1 ms to one minute/);
    expect(paceOf({ pace: 'fast' })).toMatch(/is a duration/);
  });

  it('is a known key of a step and of defaults; a wrong value is a lint error at the key', () => {
    const ok = lintTestFile('name: x\ndefaults:\n  pace: 250ms\ntests:\n  - name: a\n    url: http://127.0.0.1:1/\n  - name: b\n    url: http://127.0.0.1:1/\n    pace: 1s\n');
    expect(ok.filter((p) => p.severity === 'error' || /pace/.test(p.message))).toEqual([]);
    const bad = lintTestFile('name: x\ntests:\n  - name: a\n    url: http://127.0.0.1:1/\n    pace: fast\n');
    expect(bad.some((p) => p.severity === 'error' && /pace/.test(p.message))).toBe(true);
  });

  it('is loaded into the step', async () => {
    const tests: TestCase[] = [];
    for await (const t of loadTestsFromFile('x.yaml', 'name: x\ndefaults:\n  pace: 80ms\ntests:\n  - name: a\n    url: http://127.0.0.1:1/\n  - name: b\n    url: http://127.0.0.1:1/\n    pace: 1s\n')) tests.push(t);
    expect(tests.map((t) => t.paceMs)).toEqual([80, 1000]);
  });
});

describe('the runner paces the starts of paced steps', () => {
  let server: Server;
  let base = '';
  const starts: number[] = [];
  beforeAll(async () => {
    server = createServer((_req, res) => {
      starts.push(Date.now());
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  async function run(pace: string | undefined, n: number) {
    const t = tempDir('tp-pace-');
    const store = WorkspaceStore.create(join(t.dir, 'ws'), 'Pace');
    const steps = Array.from({ length: n }, (_, i) => `  - name: s${i}\n    url: ${base}/${i}\n    assertions:\n      - { type: status, expected: 200 }\n`).join('');
    const text = `name: p\n${pace ? `defaults:\n  pace: ${pace}\n` : ''}tests:\n${steps}`;
    const tests: TestCase[] = [];
    for await (const x of loadTestsFromFile('p.yaml', text)) tests.push(x);
    const ctx = createEngineContext({ store, secrets: new MemorySecretStore(), settings: defaultSettings() });
    starts.length = 0;
    const t0 = Date.now();
    try {
      // the default concurrency (4): pace holds whatever it is
      const s = await runTests({ name: 'pace', tests: (async function* () { yield* tests; })(), services: ctx.services, concurrency: 4, traceMode: 'none' });
      return { passed: s.passed, ms: Date.now() - t0, starts: [...starts] };
    } finally {
      await ctx.dispose();
      store.close();
      t.cleanup();
    }
  }

  it('paced steps start at least `pace` apart at concurrency 4; unpaced steps run side by side', async () => {
    const paced = await run('120ms', 5);
    expect(paced.passed).toBe(5);
    expect(paced.starts).toHaveLength(5);
    const gaps = paced.starts.slice(1).map((s, i) => s - paced.starts[i]!);
    // timers fire a few ms early on some systems: the gap is the pace, give or take that
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(100);
    expect(paced.ms).toBeGreaterThanOrEqual(4 * 100);
    const free = await run(undefined, 5);
    expect(free.passed).toBe(5);
    expect(free.ms).toBeLessThan(paced.ms);
  });
});
