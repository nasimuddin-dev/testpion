import { describe, expect, it } from 'vitest';
import { findScriptWorkerFile } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// The desktop host runs scripts in the worker pool by default: a slow script does not freeze the RPCs of the window, and a pool
// that cannot do a round trip at start degrades to the main thread (review 2026-10-27, robustness section 4).
// (The worker file is packages/core/dist/scripts/script-worker.js: run the build first.)
const d = findScriptWorkerFile() ? describe : describe.skip;

const busy = `const end = Date.now() + 300; while (Date.now() < end) {} tp.variables.set('done', 1)`;

async function latencyDuringSlowScript(workers: number): Promise<{ best: number; worst: number }> {
  const { Backend } = await import('../../apps/desktop/backend/backend.js');
  const tmp = tempDir('tp-sw-ping-');
  const be = new Backend({ appDir: tmp.dir, emit: () => {}, noMonitors: true, scriptWorkers: workers });
  try {
    await be.invoke('app.info', {}); // warm
    await be.invoke('http.send', { id: 'warm', request: { method: 'GET', url: 'http://127.0.0.1:9/never', headers: [] }, preRequestScript: `tp.variables.set('w', 1)` }); // the pool's first job loads the engine
    const send = be.invoke('http.send', { id: 'slow', request: { method: 'GET', url: 'http://127.0.0.1:9/never', headers: [] }, preRequestScript: busy });
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t = performance.now();
      await new Promise((r) => setTimeout(r, 25)); // a blocked event loop shows as a late timer
      await be.invoke('app.info', {});
      times.push(performance.now() - t - 25);
    }
    await send;
    return { best: Math.min(...times), worst: Math.max(...times) };
  } finally {
    await be.dispose();
    tmp.cleanup();
  }
}

d('scripts do not block the RPCs of the window', () => {
  it('a 300 ms script in the pool delays an RPC by less than 10 ms; in the main thread it delays it by most of the 300 ms', async () => {
    const inThread = await latencyDuringSlowScript(0);
    const pooled = await latencyDuringSlowScript(1);
    console.log(`app.info during a 300 ms script: thread best ${inThread.best.toFixed(1)} worst ${inThread.worst.toFixed(1)} ms, pool best ${pooled.best.toFixed(1)} worst ${pooled.worst.toFixed(1)} ms`);
    expect(inThread.worst).toBeGreaterThan(100);
    expect(pooled.best).toBeLessThan(10);
  }, 60_000);
});

d('the pool starts with a self-check', () => {
  it('a pool that cannot start is reported (scriptWorkersProblem) and scripts run in the main thread', async () => {
    const { AppServices } = await import('../../apps/desktop/backend/app-services.js');
    const prev = process.env.TESTPION_SCRIPT_WORKER_FILE;
    process.env.TESTPION_SCRIPT_WORKER_FILE = tempDir('tp-sw-broken-').dir; // a folder, not a script: the worker cannot start
    try {
      const svc = new AppServices();
      const r = svc.scriptRunner(1);
      expect(r).toBeDefined();
      const out = await r!.runScript(`tp.variables.set('x', 5)`, { variables: {} });
      expect(out.vars.x).toBe(5);
      expect(r!.kind).toBe('thread');
      expect(svc.scriptWorkersProblem).toMatch(/did not start/);
      await svc.dispose();
    } finally {
      if (prev === undefined) delete process.env.TESTPION_SCRIPT_WORKER_FILE;
      else process.env.TESTPION_SCRIPT_WORKER_FILE = prev;
    }
  });

  it('GuardedScriptRunner falls back to the thread when the round trip fails', async () => {
    const { GuardedScriptRunner } = await import('../../apps/desktop/backend/guarded-script-runner.js');
    const { WorkerScriptRunner } = await import('../../packages/core/src/index.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'tp-sw-dead-'));
    const file = join(dir, 'never-ready.js');
    writeFileSync(file, 'setInterval(() => {}, 1000);');
    let problem = '';
    const g = new GuardedScriptRunner(new WorkerScriptRunner({ size: 1, file, startMs: 300 }), (why) => (problem = why), 500);
    const t = Date.now();
    const out = await g.runScript(`tp.variables.set('x', 7)`, { variables: {} });
    expect(out.vars.x).toBe(7);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(g.kind).toBe('thread');
    expect(problem).toMatch(/did not start/);
    await g.dispose();
  });
});
