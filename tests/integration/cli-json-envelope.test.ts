import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { buildProgram } from '../../packages/cli/src/index.js';
import { commandPath, JSON_MEANS_JSONL, leafCommands, STREAMING_COMMANDS, WRITE_COMMANDS } from '../../packages/cli/src/contract.js';
import { cliData, copyExample, runCli, tempDir } from '../helpers.js';

// The CLI's output contract: every command with --json prints one envelope { schema_version, command, status, data,
// errors, warnings, metrics }, whatever happens (success, a failed check, a wrong argument, a missing file); the
// streaming commands take --jsonl (a line per event, then the envelope); the commands that write take --dry-run and
// change nothing with it; --non-interactive fails instead of waiting; a failure without --json says how to get it.
const tmp = tempDir('tp-cli-envelope-');
let ws = '';
const home = () => join(tmp.dir, 'home');
beforeAll(() => {
  ws = copyExample('veterinary-workspace', join(tmp.dir, 'ws'));
});
afterAll(() => tmp.cleanup());

const program = buildProgram();
const leaves = leafCommands(program).map((c) => ({ c, path: commandPath(program, c) }));
const has = (c: Command, flag: string) => [c, c.parent].some((x) => !!x && x.options.some((o) => o.long === flag));

/** Servers and commands that leave the machine or the terminal (they are covered by --jsonl below, or by their own tests). */
const LONG_RUNNING = new Set([
  'serve flows',
  'mcp-server',
  'mock',
  'mock-mcp',
  'mock-graphql',
  'record',
  'debug',
  'monitor start',
  'open',
  'wait-for',
  'ws',
  'mqtt',
  'kafka',
  'load',
  'git sync',
  'git push',
  'git pull',
]);

describe('every --json command answers one envelope', () => {
  const targets = leaves.filter(({ c, path }) => has(c, '--json') && !LONG_RUNNING.has(path) && !JSON_MEANS_JSONL.has(path));

  it('there are many, and the shared lists name real commands', () => {
    expect(targets.length).toBeGreaterThan(50);
    const paths = new Set(leaves.map((l) => l.path));
    expect([...STREAMING_COMMANDS, ...WRITE_COMMANDS].filter((p) => !paths.has(p))).toEqual([]);
    for (const { c, path } of leaves) {
      if (STREAMING_COMMANDS.has(path)) expect(has(c, '--jsonl'), path).toBe(true);
      if (WRITE_COMMANDS.has(path)) expect(has(c, '--dry-run'), path).toBe(true);
      expect(has(c, '--non-interactive'), path).toBe(true);
    }
  });

  it('with made-up arguments: an envelope whose status follows the exit code', async () => {
    const bad: string[] = [];
    const results = await Promise.all(
      targets.map(async ({ c, path }) => {
        // each required argument is something that is not there; the workspace is a copy of the example
        const args = [...path.split(' '), ...c.registeredArguments.filter((a) => a.required).map(() => 'nope-not-there'), ...(has(c, '--workspace') ? ['-w', ws] : []), '--json', '--non-interactive'];
        return { path, r: await runCli(args, { cwd: tmp.dir, home: home(), env: { CI: '1' } }) };
      }),
    );
    for (const { path, r } of results) {
      let e: { schema_version?: unknown; command?: unknown; status?: unknown; data?: unknown; errors?: unknown[]; warnings?: unknown; metrics?: { exit_code?: number } };
      try {
        e = JSON.parse(r.out);
      } catch {
        bad.push(`${path}: not one JSON document (exit ${r.status}): ${r.out.slice(0, 160)}`);
        continue;
      }
      const want = r.status === 0 ? 'ok' : r.status === 1 ? 'failed' : 'error';
      if (e.schema_version !== 1 || e.command !== path || e.status !== want || !('data' in e) || !Array.isArray(e.errors) || !Array.isArray(e.warnings) || e.metrics?.exit_code !== r.status)
        bad.push(`${path}: not the envelope (exit ${r.status}): ${r.out.slice(0, 200)}`);
      else if (
        want === 'error' &&
        // an error status always lists its error
        (!e.errors.length ||
          !(e.errors as Array<{ code?: unknown; message?: unknown; retryable?: unknown }>).every((x) => typeof x.code === 'string' && typeof x.message === 'string' && typeof x.retryable === 'boolean'))
      )
        bad.push(`${path}: errors empty or without code / message / retryable`);
    }
    expect(bad).toEqual([]);
  }, 240_000);
});

describe('envelopes in practice', () => {
  it('data is what the command printed before (jq .data), warnings collected, the old shape gone from the top', async () => {
    const r = await runCli(['collections', '-w', ws, '--json'], { home: home() });
    expect(r.status).toBe(0);
    const rows = cliData<Array<{ name: string }>>(r.out);
    expect(rows.map((c) => c.name)).toContain('Veterinary API');
    expect(Array.isArray(JSON.parse(r.out))).toBe(false);
  });

  it('a wrong option is an error envelope with a code; a failure without --json says how to get one', async () => {
    const r = await runCli(['collections', '-w', ws, '--json', '--no-such-option'], { home: home() });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.out)).toMatchObject({ status: 'error', errors: [{ code: 'ConfigurationError', message: expect.stringMatching(/unknown option/), retryable: false }] });
    const plain = await runCli(['eval', 'compare', 'nope', '--baseline', 'nope', '-w', ws], { home: home() });
    expect(plain.status).toBe(2);
    expect(plain.err).toMatch(/run it again with --json/);
  });

  it('`open --json` of something gone: status error with the error in errors (code, message, hint, retryable)', async () => {
    const r = await runCli(['open', 'run:run-nope-not-there', '-w', ws, '--json'], { home: home() });
    expect(r.status).toBe(2);
    const e = JSON.parse(r.out) as { status: string; data: { resolution: { ok: boolean } }; errors: Array<{ code: string; message: string; hint?: string; retryable: boolean }> };
    expect(e.status).toBe('error');
    expect(e.data.resolution.ok).toBe(false);
    expect(e.errors).toHaveLength(1);
    expect(e.errors[0]).toMatchObject({ code: 'ConfigurationError', message: expect.stringMatching(/\S/), hint: expect.stringMatching(/\S/), retryable: false });
  });

  it('--jsonl: a line per result as it happens, the envelope last', async () => {
    const r = await runCli(['test', join(ws, 'tests', 'rest', 'auth.yaml'), '-w', ws, '--jsonl', '-q'], { home: home() });
    const lines = r.out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type?: string; command: string; data?: { status?: string }; status?: string });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(0, -1).every((l) => l.type === 'result' && l.command === 'test' && typeof l.data?.status === 'string')).toBe(true);
    const last = lines.at(-1)!;
    expect(last).toMatchObject({ type: 'result', schema_version: 1, command: 'test', status: r.status === 0 ? 'ok' : r.status === 1 ? 'failed' : 'error' });
    expect((last.data as unknown as { summary: { total: number } }).summary.total).toBe(lines.length - 1);
  }, 120_000);
});

describe('--dry-run changes nothing and lists what would change', () => {
  it('env set: the environment file stays as it was; the result names it', async () => {
    const file = join(ws, 'environments', 'development.json');
    const before = readFileSync(file, 'utf8');
    const r = await runCli(['env', 'set', 'Development', 'dryRunVar=1', '-w', ws, '--dry-run', '--json'], { home: home() });
    expect(r.status, r.err).toBe(0);
    const e = JSON.parse(r.out) as { dry_run: { applied: boolean; changes: Array<{ path: string; change: string }> }; data: { set: string[] } };
    expect(e.data.set).toEqual(['dryRunVar']);
    expect(e.dry_run.applied).toBe(false);
    expect(e.dry_run.changes).toEqual([expect.objectContaining({ path: file, change: 'modified' })]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('export -o: a file outside the workspace is not written, and is listed', async () => {
    const out = join(tmp.dir, 'out', 'vet.postman.json');
    const r = await runCli(['export', 'Veterinary API', '-w', ws, '-o', out, '--dry-run'], { home: home() });
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/Dry run: nothing was changed/);
    expect(r.out).toContain(out);
    expect(existsSync(out)).toBe(false);
  });

  it('workspace delete: the registered folder stays', async () => {
    const r = await runCli(['workspace', 'delete', ws, '--dry-run', '--json'], { home: home() });
    expect([0, 2]).toContain(r.status);
    expect(existsSync(join(ws, 'workspace.json'))).toBe(true);
    expect(JSON.parse(r.out).dry_run.applied).toBe(false);
  });
});

describe('--non-interactive', () => {
  it('fails at once where the command would wait, with a hint', async () => {
    // a token read from a terminal: with no terminal attached (as here) the read is a pipe, so the guard is checked in-process
    const { requireInteractive } = await import('../../packages/cli/src/contract.js');
    const { cli } = await import('../../packages/cli/src/output.js');
    cli.nonInteractive = true;
    try {
      expect(() => requireInteractive('Reading the token from the terminal', 'Pipe it in.')).toThrow(/waits for input, and this run is non-interactive/);
    } finally {
      cli.nonInteractive = false;
    }
  });
});
