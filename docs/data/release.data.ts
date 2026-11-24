/**
 * Release facts for the website, derived at build time: the version from the root package.json,
 * installer names from the naming convention in apps/desktop/electron-builder.yml and
 * .github/workflows/release.yml, and the release date from the git tag.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/nasimuddin-dev/testpion';

export interface Installer {
  label: string;
  file: string;
  url: string;
  note: string;
}

export interface ReleaseData {
  version: string;
  date: string | null;
  releaseUrl: string;
  windows: Installer[];
  macos: Installer[];
  linux: Installer[];
}

declare const data: ReleaseData;
export { data };

export default {
  watch: ['../../package.json'],
  load(): ReleaseData {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const version: string = JSON.parse(readFileSync(root + 'package.json', 'utf8')).version;
    let date: string | null = null;
    try {
      const seconds = Number(execSync(`git log -1 --format=%ct v${version}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim());
      date = seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : null;
    } catch {
      date = null; // the tag isn't available yet
    }
    const make = (label: string, file: string, note: string): Installer => ({ label, file, url: `${REPO}/releases/download/v${version}/${file}`, note });
    return {
      version,
      date,
      releaseUrl: `${REPO}/releases/tag/v${version}`,
      windows: [
        make('User Installer (x64)', `TestPion-${version}-windows-x64-setup.exe`, 'Recommended. Installs for you only; no administrator rights needed. Updates itself.'),
        make('System Installer (x64)', `TestPion-${version}-windows-x64-system-setup.exe`, 'Installs for everyone who uses the computer; needs administrator rights.'),
        make('.zip (x64)', `TestPion-${version}-windows-x64.zip`, 'No install: unpack and run TestPion.exe. A data folder beside it makes it portable.'),
        make('Portable .exe (x64)', `TestPion-${version}-windows-x64-portable.exe`, 'No install, one file. Starts slower than the .zip: it unpacks itself each time.'),
      ],
      macos: [
        make('Apple Silicon (M1 and later)', `TestPion-${version}-macos-arm64.dmg`, 'Disk image for Macs with Apple chips.'),
        make('Intel', `TestPion-${version}-macos-x64.dmg`, 'Disk image for Macs with Intel processors.'),
      ],
      linux: [
        make('AppImage (x86_64)', `TestPion-${version}-linux-x86_64.AppImage`, 'Runs on most distributions without installation.'),
        make('.deb (amd64)', `TestPion-${version}-linux-amd64.deb`, 'Ubuntu, Debian, Linux Mint, Pop!_OS.'),
        make('.rpm (x86_64)', `TestPion-${version}-linux-x86_64.rpm`, 'Fedora, RHEL, Rocky Linux, openSUSE.'),
      ],
    };
  },
};
