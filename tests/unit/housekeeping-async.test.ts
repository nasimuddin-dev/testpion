import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNNING_FILE, startRunMarker, runInProgress, sweepWorkspace, sweepWorkspaceAsync, WorkspaceStore } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// A run of another process is not swept, and the sweep never holds the thread (review 2026-10-27, robustness 4.4 / 4.5).
const tmp = tempDir('tp-hk-async-');
afterAll(() => tmp.cleanup());
let n = 0;
const ws = () => WorkspaceStore.create(join(tmp.dir, `w${n++}`), 'W');
const HOUR = 3_600_000;
const old = (path: string, ms: number) => {
  const t = new Date(Date.now() - ms);
  utimesSync(path, t, t);
};
const marker = (dir: string, pid: number, ageMs: number) => {
  writeFileSync(join(dir, RUNNING_FILE), JSON.stringify({ pid }));
  old(join(dir, RUNNING_FILE), ageMs);
  old(dir, 3 * HOUR);
};
function orphanRun(root: string, id: string): string {
  const dir = join(root, 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'results.jsonl'), '');
  old(join(dir, 'results.jsonl'), 3 * HOUR);
  old(dir, 3 * HOUR);
  return dir;
}

describe('a run in progress in another process', () => {
  for (const [name, sweep] of [
    ['sweepWorkspace', async (s: WorkspaceStore) => sweepWorkspace(s)],
    ['sweepWorkspaceAsync', (s: WorkspaceStore) => sweepWorkspaceAsync(s)],
  ] as const) {
    it(`${name}: a marker with a live pid keeps the folder, a dead pid with a stale heartbeat does not, a fresh heartbeat does`, async () => {
      const store = ws();
      const live = orphanRun(store.root, 'live');
      marker(live, process.pid, 10 * 60_000); // old heartbeat, but the process is there
      const fresh = orphanRun(store.root, 'fresh');
      marker(fresh, 999_999, 30_000); // dead pid, but it beat 30 s ago
      const dead = orphanRun(store.root, 'dead');
      marker(dead, 999_999, 10 * 60_000);
      const plain = orphanRun(store.root, 'plain');
      const r = await sweep(store);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(plain)).toBe(false);
      expect(r.runs).toBe(2);
    });

    it(`${name}: monitor, load and scale results and the certificate checks in runs/ are not orphan runs`, async () => {
      const store = ws();
      for (const f of ['load', 'scale', 'monitors']) {
        mkdirSync(join(store.root, 'runs', f), { recursive: true });
        writeFileSync(join(store.root, 'runs', f, 'x.jsonl'), '');
        old(join(store.root, 'runs', f, 'x.jsonl'), 5 * HOUR);
        old(join(store.root, 'runs', f), 5 * HOUR);
      }
      writeFileSync(join(store.root, 'runs', 'certificates.json'), '{}');
      old(join(store.root, 'runs', 'certificates.json'), 5 * HOUR);
      await sweep(store);
      for (const f of ['load', 'scale', 'monitors', 'certificates.json']) expect(existsSync(join(store.root, 'runs', f))).toBe(true);
    });
  }

  it('runTests writes the marker while it runs and removes it at the end', () => {
    const dir = join(tmp.dir, 'marker');
    mkdirSync(dir, { recursive: true });
    const stop = startRunMarker(dir);
    expect(existsSync(join(dir, RUNNING_FILE))).toBe(true);
    expect(runInProgress(dir)).toBe(true);
    stop();
    expect(existsSync(join(dir, RUNNING_FILE))).toBe(false);
    expect(runInProgress(dir)).toBe(false);
  });
});

describe('the sweep does not hold the thread', () => {
  it('5,000 run folders and 1,000 payloads: no stretch without a turn of the event loop over 50 ms; every orphan is removed', async () => {
    const store = ws();
    const runs = join(store.root, 'runs');
    const payloads = join(store.root, 'payloads');
    mkdirSync(runs, { recursive: true });
    mkdirSync(payloads, { recursive: true });
    const t0 = performance.now();
    for (let i = 0; i < 5000; i++) {
      const dir = join(runs, `r${i}`);
      mkdirSync(dir);
      if (i % 2) writeFileSync(join(dir, 'summary.json'), '{}'); // finished: kept
      else {
        writeFileSync(join(dir, 'results.jsonl'), ''); // cut short, long ago: swept
        old(join(dir, 'results.jsonl'), 3 * HOUR);
        old(dir, 3 * HOUR);
      }
    }
    for (let i = 0; i < 1000; i++) {
      writeFileSync(join(payloads, `p${i}.bin`), 'x');
      old(join(payloads, `p${i}.bin`), 3 * 24 * HOUR);
    }
    console.log(`fixture: ${Math.round(performance.now() - t0)} ms`);
    // the gap between two turns of the event loop (setImmediate has no timer granularity); first with nothing going on, as a reference
    const watch = () => {
      let worst = 0;
      let last = performance.now();
      let on = true;
      const spin = () => {
        const now = performance.now();
        worst = Math.max(worst, now - last);
        last = now;
        if (on) setImmediate(spin);
      };
      setImmediate(spin);
      return { stop: () => ((on = false), worst) };
    };
    const idle = watch();
    await new Promise((r) => setTimeout(r, 500));
    const calm = idle.stop();
    const sweepWatch = watch();
    const t = performance.now();
    const r = await sweepWorkspaceAsync(store, { keepRuns: [], retention: { keepRuns: 0, keepDays: 0 } });
    const worst = sweepWatch.stop();
    console.log(`sweep of 5,000 runs + 1,000 payloads: ${Math.round(performance.now() - t)} ms, longest gap between event-loop turns ${worst.toFixed(1)} ms (idle jitter ${calm.toFixed(1)} ms)`);
    expect(r.runs).toBe(2500);
    expect(r.payloads).toBe(1000);
    // 50 ms on a calm machine; on a loaded one (parallel builds, a virus scanner) the loop itself stalls, so the idle jitter measured above is allowed on top.
    // (The synchronous sweep stalls for seconds on this fixture, so the bound still tells the two apart.)
    expect(worst).toBeLessThan(calm < 10 ? 50 : 50 + calm * 4);
  }, 120_000);
});
