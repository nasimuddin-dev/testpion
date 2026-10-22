// Shared esbuild options for the Electron main process / web bridge bundles (also used by tests).
export const nodeBundleOptions = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'warning',
  // Node built-ins and electron are provided at runtime; node-pty (native, loaded at the first terminal) is shipped as files
  external: ['electron', '@lydell/node-pty'],
  // ESM dependencies (QuickJS loader, core) use import.meta.url; provide a real file URL in the CJS bundle
  define: { 'import.meta.url': '__aps_import_meta_url' },
  banner: { js: "const __aps_import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
};

// The sandboxed preload may only require('electron'): no import.meta shim there.
const { define: _d, banner: _b, ...rest } = nodeBundleOptions;
export const preloadBundleOptions = rest;

/**
 * Protocol and database drivers the engine loads on first use (a Kafka topic, an MQTT broker, a MySQL dataset, a certificate, HTML
 * parsing, a Handlebars visualizer ...). Bundled into main.cjs they were 4 MB of source parsed at every start for features most
 * sessions never touch; each is built into dist-electron/lazy/<name>.cjs instead and required at its first use.
 * (Packages that share one instance across the engine - undici, graphql, protobufjs, grpc - stay in the main bundle.)
 */
export const LAZY_MODULES = ['kafkajs', 'mqtt', 'socket.io-client', 'mysql2/promise', 'node-forge', 'node-html-parser', 'handlebars'];
const lazyFile = (spec) => `${spec.replace(/[^\w.-]/g, '_')}.cjs`;

/** esbuild plugin: a LAZY_MODULES import becomes `require('./lazy/<name>.cjs')`, resolved next to the bundle that holds it. */
export const lazyModulesPlugin = {
  name: 'lazy-modules',
  setup(build) {
    const exact = new RegExp(`^(${LAZY_MODULES.map((m) => m.replace(/[.*+?^${}()|[\]\/]/g, '\$&')).join('|')})$`);
    build.onResolve({ filter: exact }, (args) => ({ path: `./lazy/${lazyFile(args.path)}`, external: true }));
  },
};

/** Builds every LAZY_MODULES entry (with its own dependencies) into `<outDir>/lazy/`. */
export async function buildLazyModules(build, outDir, resolveDir) {
  await Promise.all(
    LAZY_MODULES.map((spec) =>
      build({ ...nodeBundleOptions, sourcemap: false, stdin: { contents: `module.exports = require(${JSON.stringify(spec)});`, resolveDir, loader: 'js' }, outfile: `${outDir}/lazy/${lazyFile(spec)}` }),
    ),
  );
}
