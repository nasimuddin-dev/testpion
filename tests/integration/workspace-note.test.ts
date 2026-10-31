import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { WorkspaceStore } from '../../packages/core/src/index.js';
import { cliData, runCli, tempDir } from '../helpers.js';

/** The note of a workspace: a few lines everyone who opens it sees on Home; set from the command line, kept in the workspace file. */
describe('testpion workspace note', () => {
  it('shows, sets, trims, clears and limits the note', async () => {
    const tmp = tempDir('tp-workspace-note-');
    try {
      const ws = join(tmp.dir, 'ws');
      WorkspaceStore.create(ws, 'Note').close();
      const env = { ...process.env, TESTPION_HOME: join(tmp.dir, 'home') };
      const note = (...a: string[]) => runCli(['workspace', 'note', ...a, '-w', ws, '--json'], { env });
      expect(cliData<{ note: string }>((await note()).out).note).toBe('');
      const set = cliData<{ note: string }>((await note('  Start with Staging. Ask Ana for the key.  ')).out);
      expect(set.note).toBe('Start with Staging. Ask Ana for the key.');
      // kept in the workspace file (so git carries it), and read back
      const s = WorkspaceStore.open(ws);
      expect(s.workspace.description).toBe('Start with Staging. Ask Ana for the key.');
      s.close();
      expect(cliData<{ note: string }>((await note()).out).note).toContain('Staging');
      const tooLong = await note('x'.repeat(1501));
      expect(tooLong.status).toBe(2);
      expect(tooLong.err + tooLong.out).toMatch(/1 characters too long/);
      expect(cliData<{ note: string }>((await note('--clear')).out).note).toBe('');
    } finally {
      tmp.cleanup();
    }
  }, 120_000);
});
