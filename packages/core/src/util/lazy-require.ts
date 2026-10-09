import { createRequire } from 'node:module';

/**
 * Heavy libraries load at first use, not when the engine is imported (the desktop app's start waits for every module
 * body its bundle runs). Async code uses a cached `import()`. A synchronous API that needs a library writes
 *
 *   let m: typeof import('graphql') | undefined;
 *   const graphql = (): typeof import('graphql') => (m ??= typeof require === 'function' ? require('graphql') : nodeRequire('graphql'));
 *
 * The literal `require('graphql')` is what a bundler (esbuild: the desktop app, the npm CLI) sees and bundles as a
 * module that runs when first called; plain Node ES modules have no `require` and use `nodeRequire`.
 */
export const nodeRequire = createRequire(import.meta.url);
