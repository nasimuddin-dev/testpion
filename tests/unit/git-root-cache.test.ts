import { afterAll, describe, expect, it } from 'vitest';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { itemHistory, repoRoot, runGit } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

/**
 * The repository root is remembered for 3 s. A remembered root must not outlive its `.git`: History of a workspace whose
 * repository was moved away answered "no commits changed this yet" instead of saying there is no repository.
 */
const t = tempDir('tp-git-root-');
afterAll(() => t.cleanup());

const ident = ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];

describe('repoRoot cache', () => {
  it('stops believing a remembered root as soon as its .git is gone', async () => {
    const ws = t.dir;
    writeFileSync(join(ws, 'workspace.json'), JSON.stringify({ schemaVersion: '1.0', id: 'w', name: 'W', variables: [] }));
    await runGit(ws, ['init', '-q', '-b', 'main']);
    await runGit(ws, [...ident, 'add', '-A']);
    await runGit(ws, [...ident, 'commit', '-q', '-m', 'one']);
    expect(await repoRoot(ws)).toBeTruthy();
    expect(await repoRoot(ws)).toBeTruthy(); // remembered
    renameSync(join(ws, '.git'), join(ws, '.git-away'));
    expect(await repoRoot(ws)).toBeUndefined();
    await expect(itemHistory(ws, { file: 'workspace.json', mode: 'whole', itemId: '' } as never)).rejects.toThrow(/repository/i);
    renameSync(join(ws, '.git-away'), join(ws, '.git'));
    expect(await repoRoot(ws)).toBeTruthy(); // and comes back
  });
});
