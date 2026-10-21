import { afterAll, describe, expect, it } from 'vitest';
import { statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitStatus, runGit } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

/**
 * The app reads git's status in the background after every save. A status that refreshes the index's stat cache takes
 * .git/index.lock, and a commit or a stage that came at that moment failed with "Unable to create index.lock: File exists"
 * (seen in the Git panel's e2e plan). Reads must not write the index at all: a file whose time changed but not its text
 * leaves the index file exactly as it was.
 */
const t = tempDir('tp-git-locks-');
afterAll(() => t.cleanup());
const ws = t.dir;
const ident = ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];

describe('git reads take no lock', () => {
  it('a status does not rewrite the index (so it can never hold index.lock against a commit)', async () => {
    writeFileSync(join(ws, 'a.json'), '{"a":1}\n');
    await runGit(ws, ['init', '-q', '-b', 'main']);
    await runGit(ws, [...ident, 'add', '-A']);
    await runGit(ws, [...ident, 'commit', '-q', '-m', 'one']);
    // the file is touched: its stat data no longer matches the index's, its text does (the case in which status refreshes the index)
    const later = new Date(Date.now() + 5000);
    utimesSync(join(ws, 'a.json'), later, later);
    const index = join(ws, '.git', 'index');
    const before = statSync(index);
    await new Promise((r) => setTimeout(r, 50));
    expect((await gitStatus(ws)).files).toHaveLength(0);
    const after = statSync(index);
    expect(after.mtimeMs, 'the index was written by a read').toBe(before.mtimeMs);
    // and a write that follows is not in the way of anything
    writeFileSync(join(ws, 'b.json'), '{"b":1}\n');
    await runGit(ws, [...ident, 'add', 'b.json']);
    await runGit(ws, [...ident, 'commit', '-q', '-m', 'two']);
  });
});
