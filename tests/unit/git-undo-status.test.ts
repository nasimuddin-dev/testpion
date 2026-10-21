import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beginJournal, describeGitChanges, gitDiscard, gitStatus, runGit, undoJournal } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

/**
 * The Undo of a whole-file discard: the file comes back and the very next status (and its meaning, item by item) lists it
 * again, with no wait and whatever was remembered about the file before. The Git panel shows the row again right after Undo.
 */
const t = tempDir('tp-git-undo-');
afterAll(() => t.cleanup());
const ws = t.dir;
const ident = ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];
const doc = (name: string, extra = '') => JSON.stringify({ schemaVersion: '1.0', servers: [{ id: 'a', name, transport: 'http', url: 'http://x.test/mcp' + extra }] }, null, 2) + '\n';

describe('discard, then Undo', () => {
  it('lists the file again at once, every time, also when the new text has the committed size', async () => {
    writeFileSync(join(ws, 'workspace.json'), JSON.stringify({ schemaVersion: '1.0', id: 'w', name: 'W', variables: [] }));
    writeFileSync(join(ws, 'mcp-servers.json'), doc('Docs'));
    await runGit(ws, ['init', '-q', '-b', 'main']);
    await runGit(ws, [...ident, 'add', '-A']);
    await runGit(ws, [...ident, 'commit', '-q', '-m', 'one']);
    for (let round = 0; round < 12; round++) {
      // rounds alternate between a longer text and a text of exactly the committed size
      writeFileSync(join(ws, 'mcp-servers.json'), round % 2 ? doc('Docs') .replace('Docs', 'Dyns') : doc('Docs whole file'));
      const changed = await gitStatus(ws);
      expect(changed.files.map((f) => f.path), `round ${round}: changed`).toContain('mcp-servers.json');
      await describeGitChanges(ws, changed.files); // remembered for the next look
      const entry = beginJournal(ws, 'discard', 'Discard changes to mcp-servers.json', ['mcp-servers.json']);
      await gitDiscard(ws, [{ path: 'mcp-servers.json', state: 'modified' }]);
      expect((await gitStatus(ws)).files.filter((f) => f.path === 'mcp-servers.json'), `round ${round}: discarded`).toHaveLength(0);
      undoJournal(ws, entry.id);
      const back = await gitStatus(ws);
      expect(back.files.map((f) => f.path), `round ${round}: back after Undo`).toContain('mcp-servers.json');
      const rows = await describeGitChanges(ws, back.files);
      expect(rows.length, `round ${round}: described`).toBeGreaterThan(0);
      await runGit(ws, ['checkout', 'HEAD', '--', 'mcp-servers.json']);
    }
  });
});
