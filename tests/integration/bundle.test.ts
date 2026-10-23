import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error - plain JS build config
import { nodeBundleOptions } from '../../apps/desktop/scripts/esbuild-options.mjs';

/**
 * The desktop main process bundles the ESM engine into CommonJS. This guards against regressions
 * where ESM-only features (import.meta.url, WASM loaders) break inside that bundle.
 */
describe('desktop CJS bundle', () => {
  it('runs sandboxed scripts and SQLite metadata inside the bundled engine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aps-bundle-'));
    try {
      const entry = join(dir, 'entry.ts');
      writeFileSync(
        entry,
        `import { runScript, WorkspaceManager } from ${JSON.stringify(resolve('packages/core/src/index.ts'))};
         (async () => {
           const out = await runScript("aps.variables.set('x', 40 + 2)", { variables: {} });
           const ws = new WorkspaceManager(${JSON.stringify(join(dir, 'home'))}).create('bundle');
           console.log(JSON.stringify({ x: out.vars.x, error: out.error ?? null, meta: ws.meta.backend }));
           ws.close();
         })();`,
      );
      await build({ ...nodeBundleOptions, sourcemap: false, entryPoints: [entry], outfile: join(dir, 'out.cjs') });
      const r = spawnSync(process.execPath, [join(dir, 'out.cjs')], { encoding: 'utf8' });
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout.trim())).toEqual({ x: 42, error: null, meta: 'sqlite' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The desktop build keeps libraries loaded on first use (undici, the QuickJS engine, GraphQL, the MCP SDK, the database drivers ...) in
// dist-electron/lazy/*.cjs. A native import() of such a file loses the named exports, so the bundle turns dynamic imports into require().
describe('desktop CJS bundle with lazily loaded libraries', () => {
  it('sends a request, runs a script and makes the MCP server through the lazy files', async () => {
    const { lazyModulesPlugin, buildLazyModules } = await import('../../apps/desktop/scripts/esbuild-options.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'aps-lazy-'));
    try {
      const entry = join(dir, 'entry.ts');
      writeFileSync(
        entry,
        `import { createServer } from 'node:http';
         import { executeHttp, runScript, createTestPionMcpServer, EnvSecretStore, WorkspaceManager, defaultSettings } from ${JSON.stringify(resolve('packages/core/src/index.ts'))};
         (async () => {
           const srv = createServer((_q, r) => r.end('{"ok":1}'));
           await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
           const { response } = await executeHttp({ method: 'GET', url: 'http://127.0.0.1:' + (srv.address() as { port: number }).port + '/', headers: [] } as never);
           const script = await runScript("tp.variables.set('x', 40 + 2)", { variables: {} } as never);
           const ws = new WorkspaceManager(${JSON.stringify(join(dir, 'home'))}).create('lazy');
           const server = createTestPionMcpServer({ store: ws, secrets: new EnvSecretStore(), settings: defaultSettings() });
           console.log(JSON.stringify({ status: response.status, x: script.vars.x, mcp: typeof server.connect }));
           srv.close();
           ws.close();
         })();`,
      );
      await build({ ...nodeBundleOptions, plugins: [lazyModulesPlugin], supported: { 'dynamic-import': false }, sourcemap: false, entryPoints: [entry], outfile: join(dir, 'out.cjs') });
      await buildLazyModules(build, dir, process.cwd());
      const r = spawnSync(process.execPath, [join(dir, 'out.cjs')], { encoding: 'utf8' });
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout.trim())).toEqual({ status: 200, x: 42, mcp: 'function' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
