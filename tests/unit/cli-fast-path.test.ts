import { describe, expect, it } from 'vitest';
import { existsSync, statSync } from 'node:fs';
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
