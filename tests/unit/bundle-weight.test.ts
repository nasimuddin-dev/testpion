import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { resolve } from 'node:path';
// @ts-expect-error - plain JS build config
import { LAZY_MODULES, lazyModulesPlugin, nodeBundleOptions } from '../../apps/desktop/scripts/esbuild-options.mjs';

/**
 * What every start of the desktop app reads and compiles (main.cjs). The libraries used once in a while (the update check, a QR
 * code, converting a script) are built into dist-electron/lazy/ and required at first use; they were ~800 KB of the eager bundle.
 * The size gate is the build's own (scripts/build-main.mjs: 7.5 MB); this pins what must stay out of it.
 */
const MAIN_BUDGET_BYTES = 7.5 * 1048576;
const MUST_BE_LAZY = ['electron-updater', 'qrcode', 'acorn'];

describe('the eager main bundle', () => {
  it('lists the update check, the QR code and the script parser as lazy modules', () => {
    for (const m of MUST_BE_LAZY) expect(LAZY_MODULES).toContain(m);
  });

  it('does not contain them, and stays under its size budget', async () => {
    const r = await build({
      ...nodeBundleOptions,
      plugins: [lazyModulesPlugin],
      supported: { 'dynamic-import': false },
      sourcemap: false,
      write: false,
      metafile: true,
      entryPoints: [resolve('apps/desktop/electron/main.ts')],
      outfile: 'main.cjs',
    });
    const inputs = Object.keys(r.metafile.inputs);
    for (const m of MUST_BE_LAZY) expect(inputs.filter((f) => f.includes(`node_modules/${m}/`)), `${m} is bundled into main.cjs`).toEqual([]);
    const bytes = r.outputFiles![0]!.contents.length;
    console.log(`main.cjs: ${(bytes / 1048576).toFixed(2)} MB of ${(MAIN_BUDGET_BYTES / 1048576).toFixed(1)} MB`);
    expect(bytes).toBeLessThan(MAIN_BUDGET_BYTES);
  }, 120_000);
});
