import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileChecked, runGit, setNetworkPolicy, spawnChecked, spawnSyncChecked, fetchSecretRef } from '../../packages/core/src/index.js';
import { restrictToOwner, setAclTestHooks } from '../../packages/core/src/storage/private-acl.js';

// Every program the engine starts goes through net/process.ts, which applies the process policy first: on a shared server
// (TESTPION_ALLOW_PROCESSES=0) git, secret-manager CLIs, browser launches and the rest are refused, not only MCP stdio servers.
const root = join(__dirname, '..', '..');

/** Modules that may import child_process themselves, with why. The list only shrinks. */
const ALLOWED: Record<string, string> = {
  'packages/core/src/net/process.ts': 'the chokepoint itself',
  'packages/cli/src/commands/open.ts': 'a CLI command that opens a page in the browser of the person at the keyboard (a host, not the engine; never on a server)',
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f).replaceAll('\\', '/');
    return statSync(p).isDirectory() ? (['node_modules', 'dist', 'dist-electron'].includes(f) ? [] : sources(p)) : /\.tsx?$/.test(p) ? [p] : [];
  });
}

describe('one chokepoint for starting programs', () => {
  it('no module imports child_process outside net/process.ts (and the listed hosts)', () => {
    const found: string[] = [];
    for (const dir of ['packages/core/src', 'packages/shared/src', 'packages/cli/src', 'apps/desktop/backend', 'apps/desktop/electron', 'apps/desktop/src'])
      for (const abs of sources(join(root, dir))) {
        const rel = abs.slice(root.length + 1);
        if (/(from|import|require)\s*\(?\s*['"](node:)?child_process['"]/.test(readFileSync(abs, 'utf8')) && !ALLOWED[rel]) found.push(rel);
      }
    expect(found).toEqual([]);
    for (const f of Object.keys(ALLOWED)) expect(readFileSync(join(root, f), 'utf8')).toMatch(/child_process/); // a stale entry is a mistake
  });

  it('the browser launchers, the root-certificate installer and the system proxy are in @testpion/core/desktop, not in the engine barrel', () => {
    const barrel = readFileSync(join(root, 'packages/core/src/index.ts'), 'utf8');
    expect(barrel).not.toContain('debugger/capture.js');
    expect(barrel).not.toContain('debugger/certificate.js');
    const desktop = readFileSync(join(root, 'packages/core/src/desktop.ts'), 'utf8');
    expect(desktop).toContain('debugger/capture.js');
    expect(desktop).toContain('debugger/certificate.js');
    expect(JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')).exports['./desktop'].default).toBe('./dist/desktop.js');
  });

  describe('with TESTPION_ALLOW_PROCESSES=0', () => {
    afterEach(() => {
      setNetworkPolicy({ allowProcesses: true });
      setAclTestHooks();
    });

    it('the wrappers refuse before anything starts', () => {
      setNetworkPolicy({ allowProcesses: false });
      expect(() => spawnChecked('test', process.execPath, ['-e', '0'])).toThrow(/starting local programs/);
      expect(() => spawnSyncChecked('test', process.execPath, ['-e', '0'])).toThrow(/starting local programs/);
      expect(() => execFileChecked('test', process.execPath, ['-e', '0'], {}, () => undefined)).toThrow(/starting local programs/);
    });

    it('git is refused, a secret-manager CLI is refused, and they work again when processes are allowed', async () => {
      setNetworkPolicy({ allowProcesses: false });
      await expect(runGit(root, ['--version'])).rejects.toThrow(/starting local programs \(git\)/);
      await expect(fetchSecretRef('op://vault/item/field')).rejects.toThrow(/starting local programs|trusted|not allowed/i);
      setNetworkPolicy({ allowProcesses: true });
      expect(await runGit(root, ['--version'])).toMatch(/^git version/);
    });

    it('best-effort users (the ACL hardening) swallow the refusal instead of failing a save', () => {
      setNetworkPolicy({ allowProcesses: false });
      setAclTestHooks({ platform: 'win32', user: 'someone' });
      expect(restrictToOwner(join(root, 'package.json'), 'file')).toBe(false);
    });
  });
});

