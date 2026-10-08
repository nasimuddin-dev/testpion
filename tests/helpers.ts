import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { type ExecServices, McpManager, MemorySecretStore, ProviderRegistry, Redactor, VariableScope, runGit } from '../packages/core/src/index.js';

/** What every test needs and used to write itself: a temp folder, a copy of an example, the CLI, fake services. */

/** A temp folder, removed by `cleanup` (best effort: Windows may hold a file for a moment). */
export function tempDir(prefix = 'tp-test-'): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* left for the system's temp cleanup */
      }
    },
  };
}

/** A copy of an examples workspace, without its runs, traces, payloads and database (the parts a test does not want). */
export function copyExample(name: 'veterinary-workspace' | 'public-workspace', dest: string): string {
  const src = resolve('examples', name);
  cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      const rel = p.slice(src.length).replace(/\\/g, '/');
      return !/^\/(runs|traces|payloads)(\/|$)|^\/database\.sqlite$/.test(rel);
    },
  });
  return dest;
}

export const cliPath = resolve('packages/cli/bin/testpion.js');

export interface CliResult {
  status: number | null;
  out: string;
  err: string;
}

/** The CLI run with the given arguments, plain output, in its own TestPion home when one is given. */
export function runCliSync(args: string[], opts: { cwd?: string; home?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): CliResult {
  const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd: opts.cwd, env: { ...process.env, NO_COLOR: '1', ...(opts.home ? { TESTPION_HOME: opts.home } : {}), ...opts.env }, timeout: opts.timeout ?? 120_000 });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** The same, without blocking the test while it runs (several may run at once). */
export function runCli(args: string[], opts: { cwd?: string; home?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cliPath, ...args], { cwd: opts.cwd, env: { ...process.env, NO_COLOR: '1', ...(opts.home ? { TESTPION_HOME: opts.home } : {}), ...opts.env } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (status) => resolve({ status, out, err }));
  });
}

/** The services a test run needs, with nothing behind them: no providers, no MCP servers, no prices. */
export function fakeServices(opts: { vars?: Record<string, string>; scope?: VariableScope; secrets?: boolean; timeoutMs?: number; extra?: Partial<ExecServices> } = {}): ExecServices {
  const redactor = new Redactor();
  const vars = opts.scope ?? (opts.secrets ? new VariableScope(new MemorySecretStore(), redactor) : new VariableScope());
  if (opts.vars) vars.setScope('environment', opts.vars);
  return { vars, providers: new ProviderRegistry([], vars, redactor), mcp: new McpManager(() => undefined, redactor), mcpServers: [], redactor, pricing: [], defaultTimeoutMs: opts.timeoutMs ?? 5000, ...opts.extra };
}

/** A test identity for a repository: commits need no signing and no global git configuration. */
export async function gitIdentity(dir: string): Promise<void> {
  await runGit(dir, ['config', 'user.name', 'Tester']);
  await runGit(dir, ['config', 'user.email', 'tester@example.com']);
  await runGit(dir, ['config', 'commit.gpgsign', 'false']);
}

/** Polls until `check` holds, or fails after `ms`. */
export async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000, what = 'the condition'): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
