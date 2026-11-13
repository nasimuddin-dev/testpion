import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain Node script (scripts/package-manifests.mjs), not part of a TypeScript project
import { homebrewCask, packageManifests, parseSums, releaseFiles, scoopManifest, wingetManifests } from '../../scripts/package-manifests.mjs';

/**
 * The package-manager manifests of a release (scripts/package-manifests.mjs): winget, a Homebrew cask and a Scoop
 * manifest, each hash taken from the release's own checksum list.
 */
const h = (c: string) => c.repeat(64);
const SUMS = [
  `${h('a')}  TestPion-1.2.3-linux-amd64.deb`,
  `${h('b')}  TestPion-1.2.3-macos-arm64.dmg`,
  `${h('c')}  TestPion-1.2.3-macos-x64.dmg`,
  `${h('d')}  TestPion-1.2.3-windows-x64-portable.exe`,
  `${h('E')} *TestPion-1.2.3-windows-x64-setup.exe`,
  'not a line of the list',
].join('\r\n');

describe('package-manager manifests', () => {
  it('reads the checksum list (both forms of a line, any line ending, hashes lower-cased)', () => {
    const sums = parseSums(SUMS);
    expect(Object.keys(sums)).toHaveLength(5);
    expect(sums['TestPion-1.2.3-windows-x64-setup.exe']).toBe(h('e'));
    expect(releaseFiles('1.2.3', sums).setup).toEqual({ name: 'TestPion-1.2.3-windows-x64-setup.exe', sha256: h('e'), url: 'https://github.com/nasimuddin-dev/testpion/releases/download/v1.2.3/TestPion-1.2.3-windows-x64-setup.exe' });
  });

  it('refuses a version that is not one, and a list that is another release’s', () => {
    expect(() => releaseFiles('v1.2.3', parseSums(SUMS))).toThrow(/Not a version/);
    expect(() => releaseFiles('1.2.4', parseSums(SUMS))).toThrow(/The checksum list has no TestPion-1\.2\.4-windows-x64-setup\.exe/);
  });

  it('winget: three files, the installer silent and per user, the hash upper-cased', () => {
    const files = releaseFiles('1.2.3', parseSums(SUMS));
    const w = wingetManifests('1.2.3', files);
    expect(Object.keys(w)).toEqual(['NasimUddin.TestPion.yaml', 'NasimUddin.TestPion.installer.yaml', 'NasimUddin.TestPion.locale.en-US.yaml']);
    for (const text of Object.values(w) as string[]) {
      expect(text).toContain('PackageIdentifier: NasimUddin.TestPion\nPackageVersion: 1.2.3\n');
      expect(text).toContain('ManifestVersion: 1.6.0');
    }
    const installer = w['NasimUddin.TestPion.installer.yaml'] as string;
    expect(installer).toContain('InstallerType: nullsoft');
    expect(installer).toContain('  Silent: /S');
    expect(installer).toContain(`InstallerSha256: ${h('E')}`);
    expect(installer).toContain('InstallerUrl: https://github.com/nasimuddin-dev/testpion/releases/download/v1.2.3/TestPion-1.2.3-windows-x64-setup.exe');
    expect(w['NasimUddin.TestPion.locale.en-US.yaml']).toContain('License: MIT');
  });

  it('Homebrew: a cask with a hash per processor, and Scoop: the portable build with its hash and an update rule', () => {
    const files = releaseFiles('1.2.3', parseSums(SUMS));
    const cask = homebrewCask('1.2.3', files) as string;
    expect(cask).toMatch(/^cask "testpion" do\n {2}version "1\.2\.3"/);
    expect(cask).toMatch(new RegExp(`on_arm do\\n\\s+sha256 "${h('b')}"`));
    expect(cask).toMatch(new RegExp(`on_intel do\\n\\s+sha256 "${h('c')}"`));
    expect(cask).toContain('app "TestPion.app"');
    const scoop = JSON.parse(scoopManifest('1.2.3', files));
    expect(scoop).toMatchObject({ version: '1.2.3', license: 'MIT', architecture: { '64bit': { hash: h('d') } } });
    expect(scoop.architecture['64bit'].url).toBe('https://github.com/nasimuddin-dev/testpion/releases/download/v1.2.3/TestPion-1.2.3-windows-x64-portable.exe#/TestPion.exe');
    expect(scoop.autoupdate.hash.url).toContain('/v$version/SHA256SUMS.txt');
  });

  it('writes every manifest under its package manager’s folder', () => {
    expect(Object.keys(packageManifests('1.2.3', SUMS))).toEqual([
      'winget/NasimUddin/TestPion/1.2.3/NasimUddin.TestPion.yaml',
      'winget/NasimUddin/TestPion/1.2.3/NasimUddin.TestPion.installer.yaml',
      'winget/NasimUddin/TestPion/1.2.3/NasimUddin.TestPion.locale.en-US.yaml',
      'homebrew/Casks/testpion.rb',
      'scoop/testpion.json',
    ]);
  });
});
