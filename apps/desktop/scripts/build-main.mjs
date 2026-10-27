// Bundles the Electron main + preload scripts (and the dev web bridge) with esbuild.
import { build } from 'esbuild';
import { copyFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildLazyModules, lazyModulesPlugin, nodeBundleOptions, preloadBundleOptions } from './esbuild-options.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-electron');
// (dynamic imports of the lazy files become require(): a native import() of a CommonJS file loses the named exports Node cannot see)
const mainOptions = { ...nodeBundleOptions, plugins: [lazyModulesPlugin], supported: { 'dynamic-import': false } };

await build({ ...mainOptions, entryPoints: [join(root, 'electron/main.ts')], outfile: join(out, 'main.cjs') });
// the entry (package.json "main"): turns on V8's compile cache, then loads main.cjs
copyFileSync(join(root, 'electron/boot.cjs'), join(out, 'boot.cjs'));
// `TestPion --cli …` (the `testpion` command of the Terminal panel): the CLI, loaded only in that mode
await build({ ...mainOptions, entryPoints: [join(root, '../../packages/cli/src/index.ts')], outfile: join(out, 'cli.cjs') });
// the script engine in a worker thread (TESTPION_SCRIPT_WORKERS=1; core scripts/script-runner-workers.ts finds it next to main.cjs)
await build({ ...mainOptions, entryPoints: [join(root, '../../packages/core/src/scripts/script-worker.ts')], outfile: join(out, 'script-worker.cjs') });
await build({ ...preloadBundleOptions, entryPoints: [join(root, 'electron/preload.ts')], outfile: join(out, 'preload.cjs') });
await build({ ...mainOptions, entryPoints: [join(root, 'backend/web-server.ts')], outfile: join(out, 'web-server.cjs') });
// drivers loaded on first use (see LAZY_MODULES): beside the bundles, in dist-electron/lazy
await buildLazyModules(build, out, root);

// a size budget for what every start has to read and compile (17.4 MB before the lazy libraries moved out, 7.5 MB after)
const MAIN_BUDGET_MB = 8;
const mb = (f) => statSync(join(out, f)).size / 1048576;
console.log(`built electron main (${mb('main.cjs').toFixed(1)} MB), CLI (${mb('cli.cjs').toFixed(1)} MB), preload and web bridge`);
if (mb('main.cjs') > MAIN_BUDGET_MB) {
  console.error(`dist-electron/main.cjs is ${mb('main.cjs').toFixed(1)} MB, over the ${MAIN_BUDGET_MB} MB budget: a new dependency was bundled eagerly (add it to LAZY_MODULES in scripts/esbuild-options.mjs if it is loaded on first use)`);
  process.exit(1);
}
