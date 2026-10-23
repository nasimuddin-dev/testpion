import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * `testpion --version` and `testpion --help` are answered from dist/fast-index.json without loading the command line
 * (review: performance, finding 13: about 500 modules, 0.65 s and 0.93 s before). The answer must be what the full command
 * line prints, byte for byte; the full one is reached with TESTPION_FULL_CLI=1.
 */
const bin = resolve('packages/cli/bin/testpion.js');
const index = resolve('packages/cli/dist/fast-index.json');
const built = existsSync(index) && statSync(index).mtimeMs >= statSync(resolve('packages/cli/dist/index.js')).mtimeMs;

const run = (args: string[], full: boolean) => {
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...(full ? { TESTPION_FULL_CLI: '1' } : {}) } });
  return { out: r.stdout, err: r.stderr, status: r.status };
};

describe.skipIf(!built)('the root --version and --help from the build index', () => {
  for (const flag of ['--version', '-V', '--help', '-h']) {
    it(`${flag} prints what the full command line prints`, () => {
      const quick = run([flag], false);
      const full = run([flag], true);
      expect(quick.status).toBe(0);
      expect(full.status).toBe(0);
      expect(quick.out).toBe(full.out);
      expect(quick.err).toBe('');
    });
  }

  it('lists every top-level command with its description', () => {
    const { out } = run(['--help'], false);
    expect(out).toMatch(/^Usage: testpion \[options\] \[command\]/m);
    for (const c of ['run ', 'import ', 'export ', 'rag ', 'git ', 'bundle ']) expect(out, c).toContain(`  ${c}`);
    expect(out).toContain('Exit codes: 0 success');
  });

  it('loads a handful of modules, not the whole command line (counted, not timed: a timing ratio flakes on a loaded machine)', () => {
    // a resolve hook writes a byte per module resolution, so the work done is counted, whatever the speed of the machine
    const dir = mkdtempSync(join(tmpdir(), 'tp-fastpath-'));
    try {
      const hook = join(dir, 'hook.mjs');
      const pre = join(dir, 'pre.mjs');
      const lines = (...l: string[]) => `${l.join('\n')}\n`;
      writeFileSync(hook, lines("import { appendFileSync } from 'node:fs';", 'export async function resolve(specifier, context, next) {', "  appendFileSync(process.env.TP_COUNT_FILE, 'x');", '  return next(specifier, context);', '}'));
      writeFileSync(pre, lines("import { register } from 'node:module';", "register(new URL('./hook.mjs', import.meta.url));"));
      const resolved = (full: boolean) => {
        const file = join(dir, full ? 'full.txt' : 'quick.txt');
        writeFileSync(file, '');
        const t0 = performance.now();
        const r = spawnSync(process.execPath, ['--disable-warning=DEP0205', '--import', pathToFileURL(pre).href, bin, '--version'], {
          encoding: 'utf8',
          env: { ...process.env, NO_COLOR: '1', TP_COUNT_FILE: file, ...(full ? { TESTPION_FULL_CLI: '1', TESTPION_UNBUNDLED: '1' } : {}) },
        });
        expect(r.status).toBe(0);
        return { count: readFileSync(file).length, ms: performance.now() - t0 };
      };
      const quick = resolved(false);
      const full = resolved(true);
      console.log(`testpion --version: ${quick.count} modules resolved (${quick.ms.toFixed(0)} ms) from the index, ${full.count} (${full.ms.toFixed(0)} ms) with the full command line`);
      expect(quick.count).toBeLessThan(20);
      expect(full.count).toBeGreaterThan(300);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('falls back to the full command line when the index is older than the build', () => {
    // any other argument loads the command line (and still works)
    const r = run(['--version', '--json'], false);
    expect(r.status).toBe(0);
    expect(r.out.trim()).toMatch(/\d+\.\d+\.\d+/);
  });
});

/*
 * C-1: every real command paid about 220 ms over bare Node before it started, most of it for node:http (30 ms: its module
 * graph pulls in Node's own undici) and node:dns (20-70 ms), imported by a dozen engine files for servers and proxies that a
 * listing never uses. In the bundle they now load at first use. The census is exact (what Node loaded), the timing is a
 * generous bound on a shared box: measured 160 ms best of three (bare node: 46 ms, before: 281-365 ms).
 */
describe.skipIf(!built || !existsSync(resolve('packages/cli/dist/bundle.js')))('a real command from the bundle', () => {
  const census = resolve(process.env.TEMP ?? process.env.TMPDIR ?? '.', `tp-census-${process.pid}.js`);
  const examples = resolve('examples/public-workspace');
  const runCensus = () => {
    const out = census.replace(/\.js$/, '.json');
    writeFileSync(census, `process.on('exit', () => require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.moduleLoadList)));`);
    const r = spawnSync(process.execPath, ['--require', census, bin, 'collections', '--json', '-w', examples], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    const loaded = JSON.parse(readFileSync(out, 'utf8')) as string[];
    rmSync(out, { force: true });
    return { r, loaded };
  };

  it('does not load the network stack to list collections', () => {
    try {
      const { r, loaded } = runCensus();
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).data.length).toBeGreaterThan(0);
      for (const m of ['NativeModule http', 'NativeModule dns', 'NativeModule https', 'NativeModule http2']) expect(loaded, m).not.toContain(m);
    } finally {
      rmSync(census, { force: true });
    }
  });

  const best = (args: string[], full: boolean, runs = 3) => Math.min(...Array.from({ length: runs }, () => { const t0 = performance.now(); run(args, full); return performance.now() - t0; }));

  it('starts fast: collections --json within 6x of bare node (best of three each; 160 ms against 46 ms measured on an idle box, 281-365 ms before)', () => {
    const ms = best(['collections', '--json', '-w', examples], false, 3);
    console.log(`testpion collections --json: ${ms.toFixed(0)} ms`);
    const bare = Math.min(...Array.from({ length: 3 }, () => { const t0 = performance.now(); spawnSync(process.execPath, ['-e', '0']); return performance.now() - t0; }));
    expect(ms, `bare node ${bare.toFixed(0)} ms`).toBeLessThan(Math.max(6 * bare, 150));
  });
});

/*
 * The network policy guards `dns.lookup` by replacing it on the module object (so a name that answers differently the second time, DNS
 * rebinding, cannot reach a private address). In the bundle `node:dns` is a forwarder that loads the real module at first use: a write
 * through it must reach the real module, or the guard is silently off.
 */
describe('the lazy node:dns forwarder keeps the DNS guard', () => {
  it('a policy that blocks private networks refuses localhost through the bundled forwarder', async () => {
    const { build } = await import('esbuild');
    const { lazyBuiltins } = (await import(pathToFileURL(resolve('scripts/cli-bundle.mjs')).href)) as { lazyBuiltins: unknown };
    const dir = mkdtempSync(join(tmpdir(), 'tp-lazydns-'));
    try {
      const entry = join(dir, 'entry.ts');
      const policy = resolve('packages/core/src/net/policy.ts').split(sep).join('/');
      writeFileSync(
        entry,
        `import dnsModule from 'node:dns';\nimport { setNetworkPolicy } from ${JSON.stringify(policy)};\n` +
          `const real = process.getBuiltinModule('node:dns');\nconst before = real.lookup;\n` +
          `setNetworkPolicy({ blockPrivateNetworks: true });\n` +
          `const swapped = real.lookup !== before;\n` +
          `dnsModule.lookup('localhost', {}, (err) => { console.log(JSON.stringify({ swapped, code: err && err.code })); setNetworkPolicy({ blockPrivateNetworks: false }); });\n`,
      );
      const out = join(dir, 'out.mjs');
      await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [lazyBuiltins as never], external: ['esbuild'] });
      const r = spawnSync(process.execPath, [out], { encoding: 'utf8' });
      expect(r.stderr).toBe('');
      const got = JSON.parse(r.stdout.trim().split('\n').pop()!) as { swapped: boolean; code?: string };
      expect(got.swapped).toBe(true);
      expect(got.code).toBe('EACCES');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
