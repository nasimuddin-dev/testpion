import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitSpawns, repoRoot, runGit, scanStagedSecrets } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

/**
 * The secret scan of a commit (review: the commit step waited 5-8 s, `git.stagedScan` took about 17 s with a staged
 * workspace): two git processes per staged file. Now the sizes of all staged blobs come from one process and the texts
 * wanted from another, and a blob scanned before is not read again. Counted processes, not a clock.
 */
const t = tempDir('tp-staged-scan-');
const ws = t.dir;
const FILES = 150;
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

beforeAll(async () => {
  mkdirSync(join(ws, 'environments'), { recursive: true });
  mkdirSync(join(ws, 'datasets'), { recursive: true });
  writeFileSync(join(ws, 'workspace.json'), json({ schemaVersion: '1.0', id: 'w', name: 'W', variables: [] }));
  for (let n = 0; n < FILES; n++)
    writeFileSync(join(ws, 'environments', `e${n}.json`), json({ id: `e${n}`, name: `Env ${n}`, variables: [{ key: 'api_token', value: n % 10 === 0 ? 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' : '{{TOKEN}}', enabled: true }] }));
  writeFileSync(join(ws, 'datasets', 'pic.png'), Buffer.from([137, 80, 78, 71, 0, 1, 2]));
  await runGit(ws, ['init', '-q', '-b', 'main']);
  await runGit(ws, ['add', '-A', '.']);
});
afterAll(() => t.cleanup());

describe('scanStagedSecrets over 150 staged files', () => {
  it('finds the typed secrets with a handful of git processes, and none for a blob it has scanned', async () => {
    await repoRoot(ws);
    const before = gitSpawns.count;
    const first = await scanStagedSecrets(ws);
    const spawned = gitSpawns.count - before;
    console.log(`staged scan of ${first.staged.length} files: ${spawned} git processes`);
    expect(first.staged.length).toBe(FILES + 2);
    expect(first.blocking.length).toBe(FILES / 10);
    expect(first.skipped).toContain('datasets/pic.png');
    // the root, the staged names, the sizes, the texts (it was two for each file: over 300)
    expect(spawned).toBeLessThanOrEqual(5);

    await repoRoot(ws);
    const mid = gitSpawns.count;
    const again = await scanStagedSecrets(ws);
    expect(gitSpawns.count - mid).toBeLessThanOrEqual(4); // no text is asked for again
    expect(again.blocking.map((f) => f.hash)).toEqual(first.blocking.map((f) => f.hash));
    expect(again.skipped).toEqual(first.skipped);
  });
});
