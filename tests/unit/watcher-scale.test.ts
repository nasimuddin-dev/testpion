import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchWorkspace, type WorkspaceChange } from '../../packages/core/src/index.js';

/**
 * The watcher at scale: opening a 20,000-file workspace must not block the event loop for the whole walk, an outside
 * change that arrives before the walk reaches its file is still reported, and a storm of events (a branch switch, a
 * build) is one batch per quiet period, or per longest wait, never one timer per event and never starved forever.
 */
const root = mkdtempSync(join(tmpdir(), 'tp-wscale-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('workspace watcher at scale', () => {
  it('opens a 20,000-file workspace in slices, and still reports a change to a file the walk has not reached', async () => {
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
