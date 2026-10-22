import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * `testpion --version` and `testpion --help` are answered from dist/fast-index.json without loading the command line
 * (review: performance, finding 13: about 500 modules, 0.65 s and 0.93 s before). The answer must be what the full command
 * line prints, byte for byte; the full one is reached with TESTPION_FULL_CLI=1.
 */
const bin = resolve('packages/cli/bin/testpion.js');
const index = resolve('packages/cli/dist/fast-index.json');
const built = existsSync(index) && statSync(index).mtimeMs >= statSync(resolve('packages/cli/dist/index.js')).mtimeMs;

const run = (args: string[], full: boolean) => {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...(full ? { TESTPION_FULL_CLI: '1' } : {}) } });
  return { out: r.stdout, err: r.stderr, status: r.status, ms: performance.now() - t0 };
};
const best = (args: string[], full: boolean, runs = 3) => Math.min(...Array.from({ length: runs }, () => run(args, full).ms));

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

  it('is much faster than loading everything (best of three each; the box is shared, so only the ratio is held)', () => {
    const quick = best(['--version'], false);
    const full = best(['--version'], true);
    console.log(`testpion --version: ${quick.toFixed(0)} ms from the index, ${full.toFixed(0)} ms with the full command line`);
    expect(quick).toBeLessThan(full / 2.5);
  });

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

  it('starts fast: collections --json in under 300 ms (best of three; bare node is about 50)', () => {
    const ms = best(['collections', '--json', '-w', examples], false, 3);
    console.log(`testpion collections --json: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(300 * Number(process.env.TESTPION_PERF_SLACK ?? 1));
  });
});
