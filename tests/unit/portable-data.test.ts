import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '../..');
const { portableDataDir } = createRequire(import.meta.url)(join(root, 'apps/desktop/electron/portable-data.cjs')) as {
  portableDataDir: (o: { packaged: boolean; platform?: string; execPath?: string; env?: Record<string, string | undefined>; isDir?: (p: string) => boolean }) => string | undefined;
};
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('portable mode: a data folder next to the program', () => {
  const exe = 'D:\\Tools\\TestPion\\TestPion.exe';
  const data = join('D:\\Tools\\TestPion', 'data');
  const has = (dir: string) => (p: string) => p === dir;

  it('the unpacked .zip with a data folder keeps everything in it', () => {
    expect(portableDataDir({ packaged: true, platform: 'win32', execPath: exe, env: {}, isDir: has(data) })).toBe(data);
  });

  it('without the folder the copy behaves like an installed one', () => {
    expect(portableDataDir({ packaged: true, platform: 'win32', execPath: exe, env: {}, isDir: () => false })).toBeUndefined();
  });

  it('the portable .exe looks next to the file that was started, not in its temporary folder', () => {
    const started = 'E:\\stick';
    const env = { PORTABLE_EXECUTABLE_DIR: started };
    expect(portableDataDir({ packaged: true, platform: 'win32', execPath: 'C:\\Users\\a\\AppData\\Local\\Temp\\x\\TestPion.exe', env, isDir: has(join(started, 'data')) })).toBe(join(started, 'data'));
  });

  it('a TESTPION_HOME set by hand wins, and a run from source or another system is never portable', () => {
    expect(portableDataDir({ packaged: true, platform: 'win32', execPath: exe, env: { TESTPION_HOME: 'D:\\home' }, isDir: () => true })).toBeUndefined();
    expect(portableDataDir({ packaged: false, platform: 'win32', execPath: exe, env: {}, isDir: () => true })).toBeUndefined();
    expect(portableDataDir({ packaged: true, platform: 'linux', execPath: '/opt/testpion/testpion', env: {}, isDir: () => true })).toBeUndefined();
  });
});

describe('Windows downloads: User Installer, System Installer, .zip, portable .exe', () => {
  const builder = read('apps/desktop/electron-builder.yml');
  const workflow = read('.github/workflows/release.yml');

  it('the User Installer installs for one person and never asks who to install for', () => {
    expect(builder).toMatch(/nsis:\r?\n  oneClick: false\r?\n  perMachine: false\r?\n  include: build\/installer\.nsh/);
    const hook = read('apps/desktop/build/installer.nsh');
    expect(hook).toMatch(/!macro customInstallMode/);
    expect(hook).toMatch(/isForceCurrentInstall "1"/);
    // an all-users installation with no copy for this person is updated, not doubled
    expect(hook).toMatch(/isForceMachineInstall "1"/);
  });

  it('the System Installer is the same configuration for all users, under its own name', () => {
    const script = read('apps/desktop/scripts/package-system.mjs');
    expect(script).toContain('--config.nsis.perMachine=true');
    expect(script).toContain('windows-${arch}-system-setup.${ext}');
    expect(script).toContain('--prepackaged');
    // the update feed keeps naming the User Installer
    expect(script).toMatch(/latest\.user\.yml/);
    expect(workflow).toContain('node scripts/package-system.mjs');
  });

  it('the .zip and the portable .exe are built, and the build ships the portable-mode module', () => {
    expect(builder).toMatch(/- target: zip\r?\n      arch: \[x64\]/);
    expect(builder).toMatch(/- target: portable/);
    // the .zip takes the Windows artifact name (the installers and the portable .exe have their own)
    expect(builder).toMatch(/win:[\s\S]*?\n  artifactName: TestPion-\$\{version\}-windows-\$\{arch\}\.\$\{ext\}\r?\n/);
    expect(read('apps/desktop/scripts/build-main.mjs')).toContain("'portable-data.cjs'");
    expect(read('apps/desktop/electron/boot.cjs')).toContain("require('./portable-data.cjs')");
  });

  it('only a copy an installer put there updates itself', () => {
    const updater = read('apps/desktop/electron/updater.ts');
    expect(updater).toMatch(/!process\.env\.PORTABLE_EXECUTABLE_DIR && !process\.env\.TESTPION_PORTABLE_DATA && installedByInstaller\(\)/);
  });
});
