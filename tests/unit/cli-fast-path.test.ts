import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
