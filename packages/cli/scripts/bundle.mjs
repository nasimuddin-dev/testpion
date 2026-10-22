// Writes dist/bundle.js after the build: the command line, core and shared in one file (scripts/cli-bundle.mjs).
// bin/testpion.js loads it instead of dist/index.js while it is newer than every package build; without esbuild
// (a published package has no dev dependencies) the build keeps working and the command line loads module by module.
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let bundleCli;
let bundleMcpSdk;
try {
  ({ bundleCli, bundleMcpSdk } = await import(new URL('../../../scripts/cli-bundle.mjs', import.meta.url).href));
} catch {
  console.log('bundle.js: skipped (esbuild is not installed)');
  process.exit(0);
}
const outfile = join(root, 'packages', 'cli', 'dist', 'bundle.js');
await bundleCli({ root, outfile });
console.log(`bundle.js: ${(statSync(outfile).size / 1024).toFixed(0)} KB`);
// the MCP SDK's server side as one file (loaded by `mcp-server`: about 55 ms against 210 ms for its module files)
const sdkFile = join(root, 'packages', 'cli', 'dist', 'mcp-sdk.cjs');
await bundleMcpSdk({ root, outfile: sdkFile });
console.log(`mcp-sdk.cjs: ${(statSync(sdkFile).size / 1024).toFixed(0)} KB`);
