// The CLI with its engine (packages/cli, core and shared) bundled into one ES module, third-party modules left as
// ordinary imports. Two users: scripts/pack-cli.mjs (the npm package) and packages/cli/scripts/bundle.mjs (the build
// writes packages/cli/dist/bundle.js, which bin/testpion.js loads instead of the ~1,000 files of dist/: about 1.4 s less
// to start on a cold disk cache).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (root, p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

/** The three packages' manifests, [shared, core, cli]. */
export const sourcePackages = (root) => ['packages/shared/package.json', 'packages/core/package.json', 'packages/cli/package.json'].map((p) => read(root, p));

/** Every third-party module the engine may load, with the version range its package asks for. */
export function thirdPartyRanges(root) {
  const ranges = {};
  for (const p of sourcePackages(root)) for (const [name, range] of Object.entries(p.dependencies ?? {})) if (!name.startsWith('@testpion/')) ranges[name] = range;
  return ranges;
}

/** Bundle the CLI to `outfile` (with a metafile); the engine's own code comes from source, everything else stays an import. */
export function bundleCli({ root, outfile }) {
  const ranges = thirdPartyRanges(root);
  return build({
    entryPoints: [join(root, 'packages/cli/src/index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
    alias: { '@testpion/core': join(root, 'packages/core/src/index.ts'), '@testpion/shared': join(root, 'packages/shared/src/index.ts') },
    external: Object.keys(ranges).flatMap((n) => [n, `${n}/*`]),
    // CommonJS dependencies that call require() need it in an ES module bundle
    banner: { js: "import { createRequire as __tpCreateRequire } from 'node:module'; const require = __tpCreateRequire(import.meta.url);" },
  });
}
