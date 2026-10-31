import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceStore } from '../../packages/core/src/index.js';
import { cliData, runCli, tempDir } from '../helpers.js';

/** A computer that has never used git has no name and e-mail: a commit says so in words, `git identity` sets them for this repository only. */
describe('git identity', () => {
  it('refuses a commit with a way out, sets the identity for this repository only, then commits', async () => {
    const tmp = tempDir('tp-git-identity-');
    try {
      const ws = join(tmp.dir, 'ws');
      WorkspaceStore.create(ws, 'GI').close();
      // a git that knows nobody: no global or system config, no author variables
      const env: NodeJS.ProcessEnv = { ...process.env, TESTPION_HOME: join(tmp.dir, 'home'), GIT_CONFIG_GLOBAL: join(tmp.dir, 'no-global'), GIT_CONFIG_NOSYSTEM: '1', HOME: tmp.dir, USERPROFILE: tmp.dir, XDG_CONFIG_HOME: join(tmp.dir, 'xdg') };
      for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete env[k];
      execFileSync('git', ['init', '-q', '-b', 'main', ws], { env });
      writeFileSync(join(ws, 'note.txt'), 'x');
      execFileSync('git', ['add', '-A'], { cwd: ws, env });

      const before = await runCli(['git', 'identity', '-w', ws, '--json'], { env });
      expect(cliData<{ ok: boolean }>(before.out).ok).toBe(false);
      expect(before.status).toBe(2);

      const refused = await runCli(['git', 'commit', '-m', 'first', '-w', ws], { env });
      expect(refused.status).not.toBe(0);
      expect(refused.err + refused.out).toMatch(/Git does not know who you are/);
      expect(refused.err + refused.out).toMatch(/testpion git identity --name/);

      expect((await runCli(['git', 'identity', '--name', 'Ana Silva', '-w', ws], { env })).status).toBe(2);
      expect((await runCli(['git', 'identity', '--name', 'Ana Silva', '--email', 'not-an-email', '-w', ws], { env })).status).toBe(2);
      const set = await runCli(['git', 'identity', '--name', 'Ana Silva', '--email', 'ana@example.com', '-w', ws, '--json'], { env });
      expect(set.status).toBe(0);
      expect(cliData(set.out)).toMatchObject({ ok: true, name: 'Ana Silva', email: 'ana@example.com' });
      // for this repository only: the global config was not written
      expect(() => execFileSync('git', ['config', '--global', '--get', 'user.email'], { env, stdio: 'pipe' })).toThrow();
      expect(execFileSync('git', ['config', '--local', '--get', 'user.email'], { cwd: ws, env }).toString().trim()).toBe('ana@example.com');

      const ok = await runCli(['git', 'commit', '-m', 'first', '-w', ws, '--json'], { env });
      expect(ok.status).toBe(0);
      expect(execFileSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: ws, env }).toString().trim()).toBe('Ana Silva <ana@example.com>');
    } finally {
      tmp.cleanup();
    }
  }, 120_000);
});
