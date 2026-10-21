import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeGitChanges, describeRevChanges, gitSpawns, gitStatus, repoRoot, runGit } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

/**
 * Review (performance, finding 1): a refresh used to start one or more git processes per changed file, and read thousands of
 * new files in one block. The budgets here are counted operations (git processes started, the longest time the event loop
 * was blocked), not one wall-clock sample.
 */
const t = tempDir('tp-git-batch-');
const ws = t.dir;
const git = (...args: string[]) => runGit(ws, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args]);
const FILES = 300;

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const request = (c: number, i: number, url = `{{baseUrl}}/c${c}/r${i}`) => ({
  kind: 'http',
  id: `c${c}-r${i}`,
  name: `Request ${c}.${i}`,
  request: { method: 'GET', url, headers: [{ key: 'Accept', value: 'application/json', enabled: true }], params: [] },
  assertions: [{ type: 'status', operator: 'equals', value: 200 }],
});
const tiny = (n: number, url: string, name = 'Many') => json({ schemaVersion: '1.0', id: `m${n}`, name: `${name} ${n}`, variables: [], items: [request(n, 0, url), request(n, 1)] });
/** Dates a file back, so the remembered rows apply (a file written in the last two seconds is never remembered). */
const age = (rel: string) => utimesSync(join(ws, rel), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

beforeAll(async () => {
  mkdirSync(join(ws, 'collections'), { recursive: true });
  writeFileSync(join(ws, 'workspace.json'), json({ schemaVersion: '1.0', id: 'ws2', name: 'Many', variables: [] }));
  for (let n = 0; n < FILES; n++) writeFileSync(join(ws, 'collections', `m${n}.json`), tiny(n, `{{baseUrl}}/m${n}`));
  await runGit(ws, ['init', '-q', '-b', 'main']);
  await git('add', '-A', '.');
  await git('commit', '-q', '-m', 'many files');
  for (let n = 0; n < FILES; n++) {
    writeFileSync(join(ws, 'collections', `m${n}.json`), tiny(n, `{{baseUrl}}/changed/m${n}`));
    age(`collections/m${n}.json`);
  }
});
afterAll(() => t.cleanup());

describe('git changes: processes per refresh and event-loop blocks', () => {
  it('describes 300 modified files with a handful of git processes, not one per file', async () => {
    const st = await gitStatus(ws);
    expect(st.files.length).toBe(FILES);
    await repoRoot(ws); // the repository root is remembered for a few seconds: ask now, so a slow box does not count its renewal
    const before = gitSpawns.count;
    const t0 = performance.now();
    const changes = await describeGitChanges(ws, st.files);
    const ms = performance.now() - t0;
    const spawned = gitSpawns.count - before;
    console.log(`300 modified files: ${spawned} git processes, ${ms.toFixed(0)} ms`);
    expect(changes.length).toBe(FILES);
    expect(changes[0]!.details).toEqual(['URL']);
    // the sizes of the blobs, then the blobs (and the repository root, once): it was 300 to 600 here
    expect(spawned).toBeLessThanOrEqual(3);
  });

  it('gives what the file-by-file reading gives (the same rows as a diff against HEAD)', async () => {
    const st = await gitStatus(ws);
    const now = await describeGitChanges(ws, st.files);
    const t0 = performance.now();
    const before = gitSpawns.count;
    const reference = await describeRevChanges(ws, 'HEAD');
    console.log(`the file-by-file reading of the same 300 files: ${gitSpawns.count - before} git processes, ${(performance.now() - t0).toFixed(0)} ms`);
    const key = (cs: typeof now) => cs.map((c) => JSON.stringify({ file: c.file, kind: c.kind, kindId: c.kindId, change: c.change, title: c.title, details: c.details, ref: c.ref, containers: c.containers, itemId: c.itemId })).sort();
    expect(key(now)).toEqual(key(reference));
  });

  it('asks again for only the file that changed since the last refresh (rows are remembered by blob, size and time)', async () => {
    await describeGitChanges(ws, (await gitStatus(ws)).files); // remembers every row
    writeFileSync(join(ws, 'collections', 'm7.json'), tiny(7, '{{baseUrl}}/changed-again/m7'));
    age('collections/m7.json');
    const files = (await gitStatus(ws)).files;
    await repoRoot(ws);
    const before = gitSpawns.count;
    const again = await describeGitChanges(ws, files);
    const spawned = gitSpawns.count - before;
    expect(again.length).toBe(FILES);
    // the sizes of the blobs, then the one blob that is wanted
    expect(spawned).toBeLessThanOrEqual(2);
    expect(again.find((c) => c.file === 'collections/m7.json')!.details).toEqual(['URL']);
    // nothing changed at all: only the sizes are asked
    await repoRoot(ws);
    const quiet = gitSpawns.count;
    await describeGitChanges(ws, files);
    expect(gitSpawns.count - quiet).toBeLessThanOrEqual(1);
  });

  it('reads 5,000 new files without blocking the event loop for long', async () => {
    mkdirSync(join(ws, 'fresh'), { recursive: true });
    for (let n = 0; n < 5000; n++) writeFileSync(join(ws, 'fresh', `n${n}.json`), tiny(n, `{{baseUrl}}/n${n}`, 'New'));
    const st = await gitStatus(ws);
    expect(st.files.filter((f) => f.state === 'untracked').length).toBe(5000);
    // The longest gap between two turns of the event loop while the changes are read. The box is shared, so a gap counts for
    // the time this thread was on the CPU in it (a thread kept off the CPU by other programs is not a block of ours); best of three.
    const cpu = () => {
      const u = process.threadCpuUsage?.();
      return u ? (u.user + u.system) / 1000 : Infinity;
    };
    const runs: number[] = [];
    let total = 0;
    for (let r = 0; r < 3; r++) {
      let last = performance.now();
      let lastCpu = cpu();
      let worst = 0;
      const turn = () => {
        const n = performance.now();
        const c = cpu();
        worst = Math.max(worst, Math.min(n - last, c - lastCpu));
        last = n;
        lastCpu = c;
      };
      const timer = setInterval(turn, 1);
      const t0 = performance.now();
      const changes = await describeGitChanges(ws, st.files);
      total = performance.now() - t0;
      clearInterval(timer);
      turn();
      runs.push(worst);
      expect(changes.filter((c) => c.file.startsWith('fresh/')).length).toBeGreaterThanOrEqual(5000);
    }
    const best = Math.min(...runs);
    console.log(`5,000 new files: ${total.toFixed(0)} ms in all, longest event-loop block ${runs.map((x) => x.toFixed(0)).join('/')} ms`);
    expect(best, `longest block ${best.toFixed(0)} ms`).toBeLessThan(50);
  });
});
