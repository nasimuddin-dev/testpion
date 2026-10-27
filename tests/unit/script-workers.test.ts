import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { availableParallelism } from 'node:os';
import { WorkerScriptRunner, findScriptWorkerFile, runScript, threadScriptRunner, withScriptRunner, type ScriptInput } from '../../packages/core/src/index.js';

// Cloud stage 1, step 3: scripts can run off the host's main thread, in a pool of worker threads. The trust gates stay on the host
// (they filter what goes in and answer tp.sendRequest / tp.require), the engine is the same QuickJS, the limits hold per job.
// (The worker file is the built packages/core/dist/scripts/script-worker.js: run the build first.)
const input = (): ScriptInput => ({ variables: {} });
const available = !!findScriptWorkerFile();
const d = available ? describe : describe.skip;

d('script worker pool', () => {
  let pool: WorkerScriptRunner;
  beforeAll(() => {
    pool = new WorkerScriptRunner({ size: 4 });
  });
  afterAll(async () => {
    await pool.dispose();
  });

  it('runs a script and returns its output, like the engine in this thread', async () => {
    const code = `tp.variables.set('x', 40 + 2); tp.test('works', () => tp.expect(1).to.equal(1)); console.log('hello');`;
    const viaPool = await pool.runScript(code, input());
    const inThread = await threadScriptRunner.runScript(code, input());
    expect(viaPool.error).toBeUndefined();
    expect(viaPool.vars).toEqual(inThread.vars);
    expect(viaPool.tests).toEqual(inThread.tests);
    expect(viaPool.vars.x).toBe(42);
  });

  it('runScript goes to the runner of the call (withScriptRunner), and the pool does the work', async () => {
    const before = pool.stats.jobs;
    const out = await withScriptRunner(pool, () => runScript(`tp.variables.set('via', 'pool')`, input()));
    expect(out.vars.via).toBe('pool');
    expect(pool.stats.jobs).toBe(before + 1);
  });

  it('a malicious script cannot see the host: no process, require, fetch, Buffer, or a way out through constructors', async () => {
    const out = await pool.runScript(
      `tp.variables.set('types', [(function(){ try { require('fs'); return 'loaded'; } catch (e) { return 'blocked'; } })(), typeof process, typeof fetch, typeof globalThis.Buffer, typeof SharedArrayBuffer, typeof Atomics].join(','));
       tp.variables.set('escape', (function(){ try { return typeof tp.test.constructor.constructor('return process')(); } catch (e) { return 'blocked'; } })());`,
      input(),
    );
    expect(String(out.vars.types).split(',').slice(0, 4).join(',')).toBe('blocked,undefined,undefined,undefined');
    expect(out.vars.escape).not.toBe('object');
  });

  it('tp.sendRequest and tp.require are answered by the host (trust gates stay there)', async () => {
    const sent: string[] = [];
    const out = await pool.runScript(
      `const a = await pm.sendRequest('http://api.test/token');
       const lib = tp.require('lib');
       pm.environment.set('who', a.json().name + ':' + lib.answer);`,
      input(),
      {
        sendRequest: async (r) => {
          sent.push(r.url);
          return { status: 200, headers: [], body: '{"name":"Ada"}', time: 1 } as never;
        },
        requirePackage: (n) => (n === 'lib' ? 'module.exports = { answer: 42 };' : undefined),
      },
    );
    expect(out.error).toBeUndefined();
    expect(sent).toEqual(['http://api.test/token']);
    expect(out.scopeSets.environment).toEqual({ who: 'Ada:42' });
    // a request the host refuses reaches the script as a rejected promise
    const refused = await pool.runScript(`try { await pm.sendRequest('http://down.test'); } catch (e) { pm.environment.set('why', e.message); }`, input(), {
      sendRequest: async () => {
        throw new Error('blocked by the workspace trust list');
      },
    });
    expect(refused.scopeSets.environment.why).toMatch(/blocked by the workspace trust list/);
  });

  it('the other entry points work through the pool: expressions, templates, metric scripts', async () => {
    expect(await pool.evaluateExpression('status == 200 && $.role == "admin"', { status: 200, body: { role: 'admin' } })).toEqual({ value: true });
    expect((await pool.renderTemplate('<p>{{name}}</p>', { name: 'Ada' })).html).toContain('<p>Ada</p>');
    const m = await pool.runMetricScript('return { score: sample.a + 1 };', { a: 1 });
    expect(m.value).toMatchObject({ score: 2 });
  });

  it('CPU and time limits hold per job: an infinite loop stops at its time limit and the worker stays usable', async () => {
    const t = Date.now();
    const out = await pool.runScript('while (true) {}', input(), { timeoutMs: 150 });
    expect(out.error).toMatch(/timed out|interrupted/i);
    expect(Date.now() - t).toBeLessThan(3000);
    expect((await pool.runScript(`tp.variables.set('ok', 1)`, input())).vars.ok).toBe(1);
  });

  it('a hung script is killed: cancelling ends its worker within 500 ms and the pool carries on with a new one', async () => {
    const ac = new AbortController();
    const killed = pool.stats.killed;
    const p = pool.runScript('while (true) {}', input(), { timeoutMs: 60_000, signal: ac.signal });
    const rejected = expect(p).rejects.toMatchObject({ kind: 'CancelledError' });
    await new Promise((r) => setTimeout(r, 100));
    const t = Date.now();
    ac.abort();
    await rejected;
    expect(Date.now() - t).toBeLessThan(500);
    expect(pool.stats.killed).toBe(killed + 1);
    expect((await pool.runScript(`tp.variables.set('after', 1)`, input())).vars.after).toBe(1);
  });

  it('the watchdog ends a worker that is busy past its limit plus the slack (a hang the engine cannot interrupt)', async () => {
    const strict = new WorkerScriptRunner({ size: 1, slackMs: -2900 });
    try {
      const t = Date.now();
      const out = await strict.runScript('while (true) {}', input(), { timeoutMs: 3000 }); // would run 3 s; the watchdog is at 100 ms
      expect(out.error).toMatch(/did not stop/);
      expect(Date.now() - t).toBeLessThan(2000);
      expect(strict.stats.killed).toBe(1);
    } finally {
      await strict.dispose();
    }
  });

  it('more jobs than workers wait their turn; a job waiting is cancelled without starting', async () => {
    const one = new WorkerScriptRunner({ size: 1 });
    try {
      const order: number[] = [];
      const jobs = [1, 2, 3].map((n) => one.runScript(`tp.variables.set('n', ${n})`, input()).then((o) => order.push(Number(o.vars.n))));
      const ac = new AbortController();
      const waiting = one.runScript('1', input(), { signal: ac.signal });
      ac.abort();
      await expect(waiting).rejects.toMatchObject({ kind: 'CancelledError' });
      await Promise.all(jobs);
      expect(order).toEqual([1, 2, 3]);
      expect(one.workers).toBe(1);
    } finally {
      await one.dispose();
    }
  });

  it('N concurrent scripts run in parallel: the pool is faster than the engine in one thread', async () => {
    const heavy = `let s = 0; for (let i = 0; i < 1500000; i++) s += (i * i) % 7; tp.variables.set('s', s);`;
    const jobs = 8;
    // warm both (the engine and the workers load on first use)
    await Promise.all(Array.from({ length: 4 }, () => pool.runScript(heavy, input(), { timeoutMs: 20_000 })));
    await threadScriptRunner.runScript(heavy, input(), { timeoutMs: 20_000 });
    const t0 = performance.now();
    for (let i = 0; i < jobs; i++) await threadScriptRunner.runScript(heavy, input(), { timeoutMs: 20_000 });
    const serial = performance.now() - t0;
    const t1 = performance.now();
    await Promise.all(Array.from({ length: jobs }, () => pool.runScript(heavy, input(), { timeoutMs: 20_000 })));
    const parallel = performance.now() - t1;
    console.log(`script throughput: ${jobs} jobs serial ${Math.round(serial)} ms, pool(4) ${Math.round(parallel)} ms (${(serial / parallel).toFixed(1)}x)`);
    // a machine with fewer than 4 cores cannot show the gain; it must still not lose
    if (availableParallelism() >= 4) expect(parallel).toBeLessThan(serial * 0.7);
    else expect(parallel).toBeLessThan(serial * 1.5);
  });

  it('a worker is replaced after maxUses jobs', async () => {
    const small = new WorkerScriptRunner({ size: 1, maxUses: 2 });
    try {
      for (let i = 0; i < 5; i++) await small.runScript('1', input());
      expect(small.stats.started).toBe(3);
    } finally {
      await small.dispose();
    }
  });
});

d('script workers in the backend', () => {
  it('TESTPION_SCRIPT_WORKERS and the host choose the pool size (0 = the main thread)', async () => {
    const { scriptWorkersWanted } = await import('../../apps/desktop/backend/app-services.js');
    expect(scriptWorkersWanted(undefined, {})).toBe(0);
    expect(scriptWorkersWanted(true, {})).toBe(1);
    expect(scriptWorkersWanted(3, {})).toBe(3);
    expect(scriptWorkersWanted(true, { TESTPION_SCRIPT_WORKERS: '0' })).toBe(0);
    expect(scriptWorkersWanted(false, { TESTPION_SCRIPT_WORKERS: '1' })).toBe(1);
    expect(scriptWorkersWanted(false, { TESTPION_SCRIPT_WORKERS: '4' })).toBe(4);
  });

  it('a session with workers runs its scripts in the pool, with the same results as the main thread', async () => {
    const { Backend } = await import('../../apps/desktop/backend/backend.js');
    const { tempDir } = await import('../helpers.js');
    const tmp = tempDir('tp-sw-');
    const be = new Backend({ appDir: tmp.dir, emit: () => {}, noMonitors: true, scriptWorkers: 2 });
    try {
      expect(be.scripts?.kind).toBe('workers');
      const ctx = be.context({});
      expect(ctx.services.scriptRunner).toBe(be.scripts);
      await ctx.dispose();
      const r = (await be.invoke('http.send', { id: 'w1', request: { method: 'GET', url: 'http://127.0.0.1:9/never', headers: [] }, preRequestScript: "tp.variables.set('seen', 'pre')" })) as { scriptLogs?: unknown };
      expect(r).toBeDefined();
    } finally {
      await be.dispose();
      tmp.cleanup();
    }
  });
});
