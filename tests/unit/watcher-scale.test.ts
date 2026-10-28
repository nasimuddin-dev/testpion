import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchWorkspace, type WorkspaceChange } from '../../packages/core/src/index.js';
import { expectWithin } from '../perf-budget';

/**
 * The watcher at scale: opening a 20,000-file workspace must not block the event loop for the whole walk, an outside
 * change that arrives before the walk reaches its file is still reported, and a storm of events (a branch switch, a
 * build) is one batch per quiet period, or per longest wait, never one timer per event and never starved forever.
 */
const root = mkdtempSync(join(tmpdir(), 'tp-wscale-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('workspace watcher at scale', () => {
  // the 20,000 files are written before the clock starts (the open is the measured part); writing them can take minutes on a busy machine, hence the explicit timeout
  it('opens a 20,000-file workspace in slices, and still reports a change to a file the walk has not reached', { timeout: 240_000 }, async () => {
    mkdirSync(join(root, 'tests', 'bulk'), { recursive: true });
    for (let i = 0; i < 20000; i++) writeFileSync(join(root, 'tests', 'bulk', `t${i}.yaml`), `name: t${i}\n`);
    let emit: (event: string, name: string | null) => void = () => undefined;
    const batches: WorkspaceChange[][] = [];
    const t0 = performance.now();
    const stop = watchWorkspace(root, (b) => batches.push(b), { debounceMs: 50, watch: (_r, l) => ((emit = l), { close() {} }) });
    const openMs = performance.now() - t0;
    try {
      console.log(`watchWorkspace open of 20,000 files: ${openMs.toFixed(0)} ms before it returns`);
      expect(openMs).toBeLessThan(500);
      // a file the walk is unlikely to have reached changes now
      writeFileSync(join(root, 'tests', 'bulk', 't19999.yaml'), 'name: changed\n');
      emit('change', 'tests/bulk/t19999.yaml');
      await sleep(400);
      expect(batches.flat().map((c) => c.path)).toContain('tests/bulk/t19999.yaml');
    } finally {
      stop();
    }
  });

  /** A watcher on `root` whose walks and batches can be waited for (`onSettled`), not slept for. */
  function observed() {
    let emit: (event: string, name: string | null) => void = () => undefined;
    const batches: WorkspaceChange[][] = [];
    const waiting: Array<{ what: string; resolve(): void }> = [];
    const stop = watchWorkspace(root, (b) => batches.push(b), {
      debounceMs: 30,
      watch: (_r, l) => ((emit = l), { close() {} }),
      onSettled: (what) => {
        for (const w of waiting.splice(0)) if (w.what === what) w.resolve();
          else waiting.push(w);
      },
    });
    const next = (what: 'open' | 'adopt' | 'flush') => new Promise<void>((resolve) => waiting.push({ what, resolve }));
    return { stop, batches, next, emit: (event: string, name: string | null) => emit(event, name) };
  }

  /** How late a 1 ms timer runs on this machine right now, nothing else going on (a loaded box starves the probe itself). */
  async function idleLateness(): Promise<number> {
    let last = performance.now();
    let worst = 0;
    const probe = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 1);
    await sleep(300);
    clearInterval(probe);
    return worst;
  }

  /** The longest stretch the event loop was held while `work` ran and until `finished` resolved (a 1 ms timer measures the gaps). */
  async function longestBlock(work: () => void, finished: Promise<void>): Promise<number> {
    let last = performance.now();
    let longest = 0;
    const probe = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 1);
    last = performance.now();
    work();
    longest = Math.max(longest, performance.now() - last);
    await finished;
    clearInterval(probe);
    return longest;
  }

  it('adopt() on 20,000 files returns in a slice; a git change made before it is not reported, and one made after it is', { timeout: 240_000 }, async () => {
    const w = observed();
    try {
      await w.next('open'); // the open walk has finished
      const idle = await idleLateness();
      // "git" rewrites a file, the app adopts the folder, and the watcher's late event for that file arrives
      writeFileSync(join(root, 'tests', 'bulk', 't5.yaml'), 'name: by git\n');
      const adopted = w.next('adopt');
      const flushed = w.next('flush');
      const longest = await longestBlock(() => w.stop.adopt(), Promise.resolve());
      w.emit('change', 'tests/bulk/t5.yaml');
      await Promise.all([adopted, flushed]); // the adoption walk has finished and the late event was looked at
      console.log(`adopt() of 20,000 files: longest block ${longest.toFixed(1)} ms (idle timer lateness ${idle.toFixed(1)} ms)`);
      expectWithin(Math.max(0, longest - idle), 16, 'adopt() on 20,000 files returns');
      expect(w.batches.flat().map((c) => c.path)).not.toContain('tests/bulk/t5.yaml');
      // a change after the adoption has settled is reported
      writeFileSync(join(root, 'tests', 'bulk', 't6.yaml'), 'name: later\n');
      const later = w.next('flush');
      w.emit('change', 'tests/bulk/t6.yaml');
      await later;
      expect(w.batches.flat().map((c) => c.path)).toContain('tests/bulk/t6.yaml');
    } finally {
      w.stop();
    }
  });

  it('an overflow of the system\'s events (no file named) rescans 20,000 files in slices and still reports the changed one', { timeout: 240_000 }, async () => {
    const w = observed();
    try {
      // the open walk has taken its baseline: the file below changes after it, so the rescan has something to report
      await w.next('open');
      const idle = await idleLateness();
      writeFileSync(join(root, 'tests', 'bulk', 't77.yaml'), 'name: changed during the overflow\n');
      // the walk and the comparison run in slices: the batch is reported when they are done
      const longest = await longestBlock(() => w.emit('change', null), w.next('flush'));
      console.log(`overflow rescan of 20,000 files: longest block ${longest.toFixed(1)} ms (idle timer lateness ${idle.toFixed(1)} ms)`);
      expectWithin(Math.max(0, longest - idle), 16, 'the rescan after an overflow never holds the loop');
      expect(w.batches.flat().map((c) => c.path)).toEqual(['tests/bulk/t77.yaml']);
    } finally {
      w.stop();
    }
  });

  it('reports a storm in batches no later than the longest wait, one entry per file', async () => {
    mkdirSync(join(root, 'collections'), { recursive: true });
    let emit: (event: string, name: string | null) => void = () => undefined;
    const batches: WorkspaceChange[][] = [];
    const stop = watchWorkspace(root, (b) => batches.push(b), { debounceMs: 80, maxWaitMs: 400, watch: (_r, l) => ((emit = l), { close() {} }) });
    try {
      await sleep(50);
      const t0 = Date.now();
      let i = 0;
      // an event every 20 ms for ~1.2 s: quiet never lasts 80 ms
      while (Date.now() - t0 < 1200) {
        const name = `collections/c${i % 300}.json`;
        writeFileSync(join(root, name), `{"n":${i}}\n`);
        for (let k = 0; k < 20; k++) emit('change', name); // events repeat per file
        i++;
        await sleep(20);
      }
      expect(batches.length, 'reported while the storm was still going').toBeGreaterThanOrEqual(2);
      await sleep(300);
      for (const b of batches) expect(new Set(b.map((c) => c.path)).size).toBe(b.length);
    } finally {
      stop();
    }
  });
});
