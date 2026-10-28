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
 * Libraries the engine loads on first use (a Kafka topic, an MQTT broker, a MySQL dataset, a certificate, HTML parsing, a Handlebars
 * visualizer, the first request (undici), the first script (QuickJS), a GraphQL schema ...). Bundled into main.cjs they were about 9 MB
 * of source read and parsed at every start for features most sessions never touch; each is built into dist-electron/lazy/<name>.cjs
 * instead and required at its first use. A name here is one instance for the whole app (every `require` of it gets the same file).
 * (protobufjs and grpc-js stay in the main bundle: they are loaded together and share their descriptors.)
 */
export const LAZY_MODULES = ['kafkajs', 'mqtt', 'socket.io-client', 'mysql2/promise', 'node-forge', 'node-html-parser', 'handlebars', 'undici', 'graphql', 'quickjs-emscripten-core', '@jitl/quickjs-singlefile-mjs-release-sync', 'pg', 'ajv', 'ajv-formats', 'acorn', 'electron-updater', 'qrcode'];

/** The MCP SDK's entry points the engine uses: built into ONE lazy file so zod and the SDK's types are one instance, whichever entry asks. */
export const MCP_SDK_ENTRIES = [
  'types.js',
  'inMemory.js',
  'client/index.js',
  'client/stdio.js',
  'client/streamableHttp.js',
  'client/sse.js',
  'server/index.js',
  'server/stdio.js',
  'server/streamableHttp.js',
].map((e) => `@modelcontextprotocol/sdk/${e}`);

const lazyFile = (spec) => `${spec.replace(/[^\w.-]/g, '_')}.cjs`;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, (c) => `\\${c}`);

/** esbuild plugin: a LAZY_MODULES (or MCP SDK) import becomes a `require('./lazy/<name>.cjs')`, resolved next to the bundle that holds it. */
export const lazyModulesPlugin = {
  name: 'lazy-modules',
  setup(build) {
    const exact = new RegExp(`^(${LAZY_MODULES.map(escapeRegExp).join('|')})$`);
    build.onResolve({ filter: exact }, (args) => ({ path: `./lazy/${lazyFile(args.path)}`, external: true }));
    // each SDK entry is a one-line module that takes its part of the shared lazy file
    const sdk = new RegExp(`^(${MCP_SDK_ENTRIES.map(escapeRegExp).join('|')})$`);
    build.onResolve({ filter: sdk }, (args) => ({ path: args.path, namespace: 'mcp-sdk' }));
    build.onLoad({ filter: /.*/, namespace: 'mcp-sdk' }, (args) => ({ contents: `module.exports = require("./lazy/mcp-sdk.cjs")[${JSON.stringify(args.path)}];`, loader: 'js', resolveDir: '.' }));
    build.onResolve({ filter: /^\.\/lazy\/mcp-sdk\.cjs$/ }, (args) => ({ path: args.path, external: true }));
  },
};

/** Builds every LAZY_MODULES entry and the MCP SDK (each with its own dependencies) into `<outDir>/lazy/`. */
export async function buildLazyModules(build, outDir, resolveDir) {
  const entries = LAZY_MODULES.map((spec) => ({ contents: `module.exports = require(${JSON.stringify(spec)});`, file: lazyFile(spec) }));
  entries.push({ contents: `module.exports = {\n${MCP_SDK_ENTRIES.map((e) => `  ${JSON.stringify(e)}: require(${JSON.stringify(e)}),`).join('\n')}\n};`, file: 'mcp-sdk.cjs' });
  await Promise.all(entries.map((e) => build({ ...nodeBundleOptions, sourcemap: false, stdin: { contents: e.contents, resolveDir, loader: 'js' }, outfile: `${outDir}/lazy/${e.file}` })));
}
