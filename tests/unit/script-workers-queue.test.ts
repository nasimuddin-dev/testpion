import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerScriptRunner, findScriptWorkerFile, type ScriptInput } from '../../packages/core/src/index.js';
import { WatchBudget } from '../../packages/core/src/scripts/script-watchdog.js';

// The worker pool never leaves a queued job waiting for a worker that is gone, an abort is never lost, the require bridge never
// answers the wrong request, and the watchdog's budget is a total (review 2026-10-27, robustness section 4).
// (The worker file is packages/core/dist/scripts/script-worker.js: run the build first.)
const input = (): ScriptInput => ({ variables: {} });
const d = findScriptWorkerFile() ? describe : describe.skip;
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what}: no answer within ${ms} ms`)), ms))]);

d('script worker pool: queue, cancel, watchdog', () => {
  it('a cancelled script with a job queued behind it: the queued job runs on a replacement worker', async () => {
    const pool = new WorkerScriptRunner({ size: 1 });
    try {
      const ac = new AbortController();
      const a = pool.runScript('while (true) {}', input(), { timeoutMs: 60_000, signal: ac.signal });
      const aRejected = expect(a).rejects.toMatchObject({ kind: 'CancelledError' });
      const b = pool.runScript(`tp.variables.set('b', 1)`, input());
      await new Promise((r) => setTimeout(r, 150));
      ac.abort();
      await aRejected;
      expect((await within(b, 4000, 'queued job after cancel')).vars.b).toBe(1);
      expect(pool.workers).toBe(1);
    } finally {
      await pool.dispose();
    }
  });

  it('a script ended by the watchdog with a job queued behind it: the queued job runs', async () => {
    const pool = new WorkerScriptRunner({ size: 1, slackMs: -2900 });
    try {
      const a = pool.runScript('while (true) {}', input(), { timeoutMs: 3000 }); // the watchdog ends it at 100 ms
      const b = pool.runScript(`tp.variables.set('b', 2)`, input(), { timeoutMs: 8000 }); // the replacement is cold: its watchdog (limit - 2.9 s) leaves room
      expect((await within(a, 3000, 'watchdog job')).error).toMatch(/did not stop/);
      expect((await within(b, 4000, 'queued job after the watchdog')).vars.b).toBe(2);
      expect(pool.stats.killed).toBe(1);
    } finally {
      await pool.dispose();
    }
  });

  it('50 queued jobs while workers are killed under them: each completes or fails with a typed error within a bound', async () => {
    const pool = new WorkerScriptRunner({ size: 3 });
    try {
      const jobs: Array<Promise<string>> = [];
      const aborters: AbortController[] = [];
      for (let i = 0; i < 50; i++) {
        const ac = new AbortController();
        aborters.push(ac);
        const kind = i % 5; // 0 hang (ends at its own limit), 1 hang (cancelled later), 2..4 normal
        const code = kind <= 1 ? 'while (true) {}' : `tp.variables.set('n', ${i})`;
        jobs.push(
          pool
            .runScript(code, input(), { timeoutMs: kind === 0 ? 150 : 8000, signal: ac.signal })
            .then((o) => (o.error ? `error:${o.error.slice(0, 20)}` : `ok:${o.vars.n}`))
            .catch((e: { kind?: string }) => `typed:${e.kind ?? 'UNTYPED'}`),
        );
      }
      // kill workers mid-queue, abort every second hang, at fixed points
      const slots = (): Array<{ w: { terminate(): Promise<number> } }> => [...(pool as unknown as { slots: Set<{ w: { terminate(): Promise<number> } }> }).slots];
      for (let round = 0; round < 3; round++) {
        await new Promise((r) => setTimeout(r, 60));
        for (const s of slots().slice(0, 1)) void s.w.terminate();
      }
      aborters.forEach((ac, i) => i % 10 === 1 && ac.abort());
      const results = await within(Promise.all(jobs), 40_000, '50 queued jobs');
      expect(results).toHaveLength(50);
      expect(results.filter((r) => r.startsWith('typed:UNTYPED'))).toEqual([]);
      for (const r of results) expect(r).toMatch(/^(ok:|error:|typed:(CancelledError|InternalError|TimeoutError))/);
      expect(results.filter((r) => r.startsWith('ok:')).length).toBeGreaterThan(0);
    } finally {
      await pool.dispose();
    }
  }, 60_000);

  it('an abort before the worker is acquired still cancels the script', async () => {
    const pool = new WorkerScriptRunner({ size: 1 });
    try {
      await pool.runScript('1', input()); // warm
      const ac = new AbortController();
      const t = Date.now();
      const p = pool.runScript('while (true) {}', input(), { timeoutMs: 20_000, signal: ac.signal });
      ac.abort(); // synchronously: before the acquire has resolved
      await expect(p).rejects.toMatchObject({ kind: 'CancelledError' });
      expect(Date.now() - t).toBeLessThan(500);
      expect((await pool.runScript(`tp.variables.set('after', 1)`, input())).vars.after).toBe(1);
    } finally {
      await pool.dispose();
    }
  });

  it('tp.require: a host that answers late is an error, never undefined, and the late answer is not the next require\'s', async () => {
    const pool = new WorkerScriptRunner({ size: 1, requireWaitMs: 500 });
    try {
      const out = await pool.runScript(
        `let aerr = 'none';
         try { tp.require('a'); } catch (e) { aerr = String(e.message); }
         tp.variables.set('aerr', aerr);
         tp.variables.set('b', tp.require('b').v);`,
        input(),
        {
          timeoutMs: 8000,
          requirePackage: (n) => {
            if (n === 'a') {
              const end = Date.now() + 750; // the main thread is busy: longer than the wait (500) and shorter than twice it, with 250 ms to spare each way for a loaded runner
              while (Date.now() < end);
              return 'module.exports = { v: "A" };';
            }
            return n === 'b' ? 'module.exports = { v: "B" };' : undefined;
          },
        },
      );
      expect(out.error).toBeUndefined();
      expect(String(out.vars.aerr)).toMatch(/did not answer/);
      expect(out.vars.b).toBe('B');
      // a package that does not exist is still the plain "no package" answer
      const none = await pool.runScript(`tp.require('zzz')`, input(), { requirePackage: () => undefined });
      expect(none.error).toMatch(/no package with that name/);
      // a host that throws reports its own reason
      const boom = await pool.runScript(`tp.require('x')`, input(), {
        requirePackage: () => {
          throw new Error('the package store is locked');
        },
      });
      expect(boom.error).toMatch(/package store is locked/);
    } finally {
      await pool.dispose();
    }
  });

  it('a cold worker is not killed before the script runs (the watchdog starts with the job, not before the engine is loaded)', async () => {
    const pool = new WorkerScriptRunner({ size: 1, slackMs: 0 });
    try {
      const out = await pool.runScript(`tp.variables.set('v', 1)`, input(), { timeoutMs: 1500 });
      expect(out.error).toBeUndefined();
      expect(out.vars.v).toBe(1);
    } finally {
      await pool.dispose();
    }
  });

  it('a worker that never becomes ready fails its job and is replaced (a packaged build that cannot load the worker degrades, never hangs)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-sw-dead-'));
    const file = join(dir, 'never-ready.js');
    writeFileSync(file, 'setInterval(() => {}, 1000);');
    const pool = new WorkerScriptRunner({ size: 1, file, startMs: 300 });
    try {
      const t = Date.now();
      const out = await within(pool.runScript('1', input()), 5000, 'job on a worker that never starts');
      expect(out.error).toMatch(/did not start/);
      expect(Date.now() - t).toBeLessThan(3000);
    } finally {
      await pool.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('WatchBudget', () => {
  it('re-arms with what is left, so a script that sends requests in a loop still runs out', () => {
    let t = 0;
    const b = new WatchBudget(1000, 500, () => t);
    expect(b.start()).toBe(1500);
    t += 900; // the engine works 900 ms, then asks the host
    b.pause();
    t += 60_000; // the host's time does not count
    b.grantPass(); // one more pass: +1000
    expect(b.start()).toBe(1600); // 2500 - 900
    t += 1000;
    b.pause();
    b.grantPass();
    expect(b.start()).toBe(1600 - 1000 + 1000); // the slack is not paid again and again
    t += 1600;
    expect(b.remainingMs).toBe(0);
    // an engine that is busy forever: every pass eats its limit, the budget grows by one limit per pass, never by "the whole limit again"
    let total = 0;
    const loop = new WatchBudget(1000, 500, () => total);
    for (let i = 0; i < 5; i++) {
      loop.start();
      total += 1000;
      loop.pause();
      loop.grantPass();
    }
    expect(loop.start()).toBe(1500); // slack + one limit, however many passes came before
  });
});
