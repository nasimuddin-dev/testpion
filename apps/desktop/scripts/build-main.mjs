// Bundles the Electron main + preload scripts (and the dev web bridge) with esbuild.
import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { nodeBundleOptions, preloadBundleOptions } from './esbuild-options.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({ ...nodeBundleOptions, entryPoints: [join(root, 'electron/main.ts')], outfile: join(root, 'dist-electron/main.cjs') });
// the entry (package.json "main"): turns on V8's compile cache, then loads main.cjs
copyFileSync(join(root, 'electron/boot.cjs'), join(root, 'dist-electron/boot.cjs'));
// `TestPion --cli …` (the `testpion` command of the Terminal panel): the CLI, loaded only in that mode
await build({ ...nodeBundleOptions, entryPoints: [join(root, '../../packages/cli/src/index.ts')], outfile: join(root, 'dist-electron/cli.cjs') });
await build({ ...preloadBundleOptions, entryPoints: [join(root, 'electron/preload.ts')], outfile: join(root, 'dist-electron/preload.cjs') });
await build({ ...nodeBundleOptions, entryPoints: [join(root, 'backend/web-server.ts')], outfile: join(root, 'dist-electron/web-server.cjs') });
console.log('built electron main, CLI, preload and web bridge');
