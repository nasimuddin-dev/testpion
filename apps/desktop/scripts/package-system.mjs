// The Windows System Installer (TestPion-<version>-windows-x64-system-setup.exe): installs for everyone who uses the
// computer, into Program Files, with administrator approval. It is the User Installer's configuration with
// nsis.perMachine=true, made from the app folder the main packaging run left in release/win-unpacked (so the program
// files, and their signatures, are the same in both installers).
//
// Run after `npm run package` (or the release workflow's electron-builder run): `npm run package:system`.
// The update feed (release/latest.yml) must keep naming the User Installer, so it is put back after this run.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(root, 'release');
const unpacked = join(release, 'win-unpacked');
if (!existsSync(join(unpacked, 'TestPion.exe'))) {
  console.error('release/win-unpacked is missing: run the main packaging first (npm run package)');
  process.exit(1);
}
const feed = join(release, 'latest.yml');
const kept = join(release, 'latest.user.yml');
if (existsSync(feed)) copyFileSync(feed, kept);
const run = spawnSync(
  'npx',
  [
    'electron-builder',
    '--config',
    'electron-builder.yml',
    '--win',
    'nsis',
    '--x64',
    '--prepackaged',
    unpacked,
    '--publish',
    'never',
    '--config.nsis.perMachine=true',
    '--config.nsis.artifactName=TestPion-${version}-windows-${arch}-system-setup.${ext}',
  ],
  { cwd: root, stdio: 'inherit', shell: true },
);
if (existsSync(kept)) {
  copyFileSync(kept, feed);
  rmSync(kept);
}
process.exit(run.status ?? 1);
