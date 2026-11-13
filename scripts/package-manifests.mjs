#!/usr/bin/env node
/**
 * Package-manager manifests for a TestPion release: winget (Windows), a Homebrew cask (macOS) and a Scoop manifest
 * (Windows), written from the release's own checksum list so every hash is the one the release workflow published.
 *
 *   node scripts/package-manifests.mjs 0.58.0                         # reads SHA256SUMS.txt of the GitHub release v0.58.0
 *   node scripts/package-manifests.mjs 0.58.0 --sums SHA256SUMS.txt   # a local checksum list
 *   node scripts/package-manifests.mjs 0.58.0 --out dist/packages
 *
 * Nothing is submitted anywhere: the files land in dist/packages/ for the owner to send to microsoft/winget-pkgs, a
 * Homebrew tap and a Scoop bucket (docs/contributing/package-managers.md says how). The functions are exported for the
 * unit test.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = 'nasimuddin-dev/testpion';
export const PACKAGE = {
  id: 'NasimUddin.TestPion',
  name: 'TestPion',
  publisher: 'TestPion contributors',
  license: 'MIT',
  homepage: 'https://nasimuddin-dev.github.io/testpion/',
  short: 'Test, debug and evaluate REST, GraphQL, gRPC, MCP and AI/LLM systems.',
  tags: ['api', 'api-client', 'rest', 'graphql', 'grpc', 'mcp', 'testing', 'llm'],
};

/** The checksum list as { file name → sha256 } (the format of `sha256sum`: hash, two spaces, name). */
export function parseSums(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) out[m[2].trim()] = m[1].toLowerCase();
  }
  return out;
}

const VERSION = /^\d+\.\d+\.\d+$/;

/** The release's files a manifest names, each with its URL and hash; throws when the checksum list lacks one. */
export function releaseFiles(version, sums) {
  if (!VERSION.test(version)) throw new Error(`Not a version: ${version} (expected X.Y.Z)`);
  const file = (name) => {
    const sha256 = sums[name];
    if (!sha256) throw new Error(`The checksum list has no ${name}: is this the SHA256SUMS.txt of v${version}?`);
    return { name, sha256, url: `https://github.com/${REPO}/releases/download/v${version}/${name}` };
  };
  return {
    setup: file(`TestPion-${version}-windows-x64-setup.exe`),
    portable: file(`TestPion-${version}-windows-x64-portable.exe`),
    macArm: file(`TestPion-${version}-macos-arm64.dmg`),
    macIntel: file(`TestPion-${version}-macos-x64.dmg`),
  };
}

/** The three files winget wants (version, installer, default locale), by their file name. */
export function wingetManifests(version, files) {
  const head = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.1.6.0.schema.json\n\nPackageIdentifier: ${PACKAGE.id}\nPackageVersion: ${version}\n`;
  return {
    [`${PACKAGE.id}.yaml`]: `${head('version')}DefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.6.0\n`,
    [`${PACKAGE.id}.installer.yaml`]:
      `${head('installer')}InstallerType: nullsoft\nScope: user\nInstallModes:\n  - interactive\n  - silent\nInstallerSwitches:\n  Silent: /S\n  SilentWithProgress: /S\nUpgradeBehavior: install\n` +
      `Installers:\n  - Architecture: x64\n    InstallerUrl: ${files.setup.url}\n    InstallerSha256: ${files.setup.sha256.toUpperCase()}\nManifestType: installer\nManifestVersion: 1.6.0\n`,
    [`${PACKAGE.id}.locale.en-US.yaml`]:
      `${head('defaultLocale')}PackageLocale: en-US\nPublisher: ${PACKAGE.publisher}\nPublisherUrl: https://github.com/${REPO}\nPublisherSupportUrl: https://github.com/${REPO}/issues\n` +
      `PackageName: ${PACKAGE.name}\nPackageUrl: ${PACKAGE.homepage}\nLicense: ${PACKAGE.license}\nLicenseUrl: https://github.com/${REPO}/blob/main/LICENSE\nShortDescription: ${PACKAGE.short}\n` +
      `Tags:\n${PACKAGE.tags.map((t) => `  - ${t}`).join('\n')}\nReleaseNotesUrl: https://github.com/${REPO}/releases/tag/v${version}\nManifestType: defaultLocale\nManifestVersion: 1.6.0\n`,
  };
}

/** A Homebrew cask (for a tap: the builds are not notarized yet, which the main cask repository requires). */
export function homebrewCask(version, files) {
  return `cask "testpion" do
  version "${version}"

  on_arm do
    sha256 "${files.macArm.sha256}"
    url "https://github.com/${REPO}/releases/download/v#{version}/TestPion-#{version}-macos-arm64.dmg"
  end
  on_intel do
    sha256 "${files.macIntel.sha256}"
    url "https://github.com/${REPO}/releases/download/v#{version}/TestPion-#{version}-macos-x64.dmg"
  end

  name "${PACKAGE.name}"
  desc "${PACKAGE.short.replace(/\.$/, '')}"
  homepage "${PACKAGE.homepage}"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "TestPion.app"

  zap trash: [
    "~/Library/Application Support/TestPion",
    "~/Library/Logs/TestPion",
    "~/Library/Preferences/dev.nasimuddin.protolens.plist",
  ]
end
`;
}

/** A Scoop manifest for the portable build (no installer runs; Scoop keeps the one file and its shortcut). */
export function scoopManifest(version, files) {
  const asset = 'TestPion-$version-windows-x64-portable.exe';
  return `${JSON.stringify(
    {
      version,
      description: PACKAGE.short,
      homepage: PACKAGE.homepage,
      license: PACKAGE.license,
      architecture: { '64bit': { url: `${files.portable.url}#/TestPion.exe`, hash: files.portable.sha256 } },
      shortcuts: [['TestPion.exe', 'TestPion']],
      checkver: { github: `https://github.com/${REPO}` },
      autoupdate: {
        architecture: { '64bit': { url: `https://github.com/${REPO}/releases/download/v$version/${asset}#/TestPion.exe` } },
        hash: { url: `https://github.com/${REPO}/releases/download/v$version/SHA256SUMS.txt`, regex: `$sha256\\s+${asset.replace('$version', '$version').replace(/\./g, '\\.')}` },
      },
    },
    null,
    2,
  )}\n`;
}

/** Every manifest of a release, by its path under the output folder. */
export function packageManifests(version, sumsText) {
  const files = releaseFiles(version, parseSums(sumsText));
  const out = {};
  for (const [name, text] of Object.entries(wingetManifests(version, files))) out[`winget/${PACKAGE.id.replace('.', '/')}/${version}/${name}`] = text;
  out['homebrew/Casks/testpion.rb'] = homebrewCask(version, files);
  out['scoop/testpion.json'] = scoopManifest(version, files);
  return out;
}

async function main(argv) {
  const version = argv.find((a) => !a.startsWith('--'));
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  if (!version || !VERSION.test(version)) {
    console.error('Usage: node scripts/package-manifests.mjs <version> [--sums SHA256SUMS.txt] [--out dist/packages]');
    process.exit(2);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = resolve(opt('--out') ?? join(root, 'dist', 'packages'));
  let sums;
  if (opt('--sums')) sums = readFileSync(resolve(opt('--sums')), 'utf8');
  else {
    const url = `https://github.com/${REPO}/releases/download/v${version}/SHA256SUMS.txt`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} answered ${r.status}: is v${version} released? (or pass --sums <file>)`);
    sums = await r.text();
  }
  const manifests = packageManifests(version, sums);
  for (const [path, text] of Object.entries(manifests)) {
    mkdirSync(dirname(join(outDir, path)), { recursive: true });
    writeFileSync(join(outDir, path), text);
    console.log(join(outDir, path));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch((e) => (console.error(e.message), process.exit(1)));
