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
