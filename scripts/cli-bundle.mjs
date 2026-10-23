// The CLI with its engine (packages/cli, core and shared) bundled into one ES module, third-party modules left as
// ordinary imports. Two users: scripts/pack-cli.mjs (the npm package) and packages/cli/scripts/bundle.mjs (the build
// writes packages/cli/dist/bundle.js, which bin/testpion.js loads instead of the ~1,000 files of dist/: about 1.4 s less
// to start on a cold disk cache).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

/*
 * Loading node:http (30 ms: its module graph pulls in Node's own undici), node:https, node:http2, node:tls and node:dns (20-70 ms)
 * happens when an ES module imports them, and the engine imports them in a dozen files for the servers, proxies and the network
 * policy - none of which most commands touch. In the bundle the engine's own imports of them become forwarders that load the real
 * module at first use (process.getBuiltinModule), so `testpion collections` no longer pays about 80 ms for the network stack.
 */
const LAZY_BUILTINS = /^node:(http|https|http2|tls|dns|dns\/promises)$/;
const require = createRequire(import.meta.url);
function lazyBuiltinSource(spec) {
  const real = require(spec);
  const lines = [`const real = () => process.getBuiltinModule(${JSON.stringify(spec)});`, `const fn = (name) => { const w = function (...args) { const R = real()[name]; return new.target ? Reflect.construct(R, args) : R.apply(this, args); }; Object.defineProperty(w, 'name', { value: name }); Object.defineProperty(w, Symbol.hasInstance, { value: (x) => x instanceof real()[name] }); return w; };`, `const obj = (name, shape) => new Proxy(shape, { get: (_, k) => real()[name][k], has: (_, k) => k in real()[name], ownKeys: () => Reflect.ownKeys(real()[name]), getOwnPropertyDescriptor: (_, k) => ({ ...Reflect.getOwnPropertyDescriptor(real()[name], k), configurable: true }) });`];
  const names = [];
  for (const [k, v] of Object.entries(real)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(k) || k === 'default') continue;
    if (typeof v === 'function') lines.push(`export const ${k} = fn(${JSON.stringify(k)});`);
    else if (v && typeof v === 'object') lines.push(`export const ${k} = obj(${JSON.stringify(k)}, ${Array.isArray(v) ? '[]' : '{}'});`);
    else continue; // a number or string constant cannot be read lazily
    names.push(k);
  }
  // writes go to the real module: the network policy replaces dns.lookup with a guarded one (DNS rebinding), a write kept on the forwarder would leave the real dns unguarded
  lines.push(`export default new Proxy({}, { get: (_, k) => real()[k], set: (_, k, v) => ((real()[k] = v), true), deleteProperty: (_, k) => delete real()[k], has: (_, k) => k in real() });`);
  return lines.join('\n');
}
export const lazyBuiltins = {
  name: 'lazy-builtins',
  setup(b) {
    b.onResolve({ filter: LAZY_BUILTINS }, (args) => (args.importer.includes('node_modules') ? undefined : { path: args.path, namespace: 'lazy-builtin' }));
    b.onLoad({ filter: /.*/, namespace: 'lazy-builtin' }, (args) => ({ contents: lazyBuiltinSource(args.path), loader: 'js' }));
  },
};

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
    plugins: [lazyBuiltins],
    alias: { '@testpion/core': join(root, 'packages/core/src/index.ts'), '@testpion/shared': join(root, 'packages/shared/src/index.ts') },
    external: Object.keys(ranges).flatMap((n) => [n, `${n}/*`]),
    // CommonJS dependencies that call require() need it in an ES module bundle
    banner: { js: "import { createRequire as __tpCreateRequire } from 'node:module'; const require = __tpCreateRequire(import.meta.url);" },
  });
}

/** The MCP SDK's server side (types, server, stdio) with its dependencies as one CommonJS file: `mcp-server` loads it instead of ~500 module files. */
export function bundleMcpSdk({ root, outfile }) {
  return build({
    stdin: {
      contents: "module.exports = { types: require('@modelcontextprotocol/sdk/types.js'), server: require('@modelcontextprotocol/sdk/server/index.js'), stdio: require('@modelcontextprotocol/sdk/server/stdio.js') };",
      resolveDir: join(root, 'packages', 'core'),
      loader: 'js',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  });
}
