/** Shared CLI helpers: exit codes, colours, errors, opening workspaces and collections. */
import { existsSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ApsError,
  ChainSecretStore,
  EnvSecretStore,
  WorkspaceManager,
  WorkspaceStore,
  createEngineContext,
  isWorkspaceDir,
  formatBytes,
  importAny,
  fetchImportText,
  readResultsFile,
  readSpecRef,
  requireCollection as findCollectionOrThrow,
  requireEnvironment as findEnvironmentOrThrow,
  type ContextOptions,
  type EngineContext,
  type Environment,
  type LoadSnapshot,
  type Collection,
  type TestResult,
} from '@testpion/core';

/** One warning line per collection or environment whose file cannot be read (they are listed, never dropped silently). */
export function warnProblems(items: Array<{ name: string; problem?: string }>, what: 'collection' | 'environment'): void {
  for (const i of items) if (i.problem) console.error(yellow(`warning: ${what} "${i.name}" is broken and was skipped: ${i.problem}`));
}

/** Exit codes (spec §37). */
export const EXIT = { SUCCESS: 0, TEST_FAILURE: 1, CONFIG_ERROR: 2, EXECUTION_ERROR: 3 } as const;

const tty = process.stdout.isTTY && !process.env.NO_COLOR && !process.env.CI;

export const c = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

export const green = c(32);

export const red = c(31);

export const yellow = c(33);

export const dim = c(2);

export const bold = c(1);

export const cyan = c(36);

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

/** `--json` output: one indented JSON document on stdout. */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function collectVar(v: string, prev: Record<string, string> = {}): Record<string, string> {
  const i = v.indexOf('=');
  if (i <= 0) throw new CliError(`--var expects key=value, got "${v}"`, EXIT.CONFIG_ERROR);
  return { ...prev, [v.slice(0, i)]: v.slice(i + 1) };
}

/** The nearest folder up from `start` with a TestPion workspace.json (another tool's workspace.json, e.g. Nx's, is passed by). */
export function findWorkspaceUp(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (isWorkspaceDir(dir)) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export function openWorkspace(ref: string | undefined, hintPath: string | undefined, mgr: WorkspaceManager): { store: WorkspaceStore; ephemeral?: string } {
  if (ref) {
    const p = mgr.resolve(ref) ?? (existsSync(join(resolve(ref), 'workspace.json')) ? resolve(ref) : undefined);
    if (!p) throw new CliError(`Workspace "${ref}" not found. Known: ${mgr.list().map((w) => w.name).join(', ') || 'none'}`, EXIT.CONFIG_ERROR);
    return { store: WorkspaceStore.open(p) };
  }
  const found = findWorkspaceUp(hintPath ?? process.cwd());
  if (found) return { store: WorkspaceStore.open(found) };
  // no workspace: run in an ephemeral one (providers resolve from OPENAI_API_KEY / ANTHROPIC_API_KEY / mock)
  const tmp = mkdtempSync(join(tmpdir(), 'aps-ephemeral-'));
  return { store: WorkspaceStore.create(tmp, 'ephemeral'), ephemeral: tmp };
}

/**
 * Run `fn` with the workspace `ref` names (or the nearest one, or an ephemeral one) open; the store is closed
 * afterwards and an ephemeral workspace removed, whether `fn` returns, throws or rejects. `ephemeral` tells `fn`
 * when there is no real workspace.
 */
export async function withWorkspace<T>(ref: string | undefined, fn: (store: WorkspaceStore, ephemeral: string | undefined) => T | Promise<T>): Promise<T> {
  const { store, ephemeral } = openWorkspace(ref, undefined, new WorkspaceManager());
  try {
    return await fn(store, ephemeral);
  } finally {
    store.close();
    if (ephemeral) rmSync(ephemeral, { recursive: true, force: true });
  }
}

/** The CLI has no OS keychain: secret variables come from TESTPION_SECRET_* environment variables. */
export const cliSecrets = () => new ChainSecretStore([new EnvSecretStore()]);

/** An engine context as every command builds it: the workspace, the CLI's secrets, the app settings and an environment. */
export function cliContext(store: WorkspaceStore, environment?: string, extra: Partial<Omit<ContextOptions, 'store' | 'secrets' | 'settings' | 'environment'>> = {}): EngineContext {
  return createEngineContext({ store, secrets: cliSecrets(), settings: new WorkspaceManager().loadSettings(), environment, ...extra });
}

/** A core lookup that failed ("not found") as the CLI reports it: the message alone, with the configuration exit code. */
function configError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw e instanceof ApsError ? new CliError(e.message, EXIT.CONFIG_ERROR) : e;
  }
}

/** The collection `ref` names (id or name), or a configuration error listing the collections; `hint` is added to it. */
export function requireCollection(store: WorkspaceStore, ref: string, opts: { loadable?: boolean; hint?: string } = {}): Collection {
  try {
    return findCollectionOrThrow(store, ref, { loadable: opts.loadable });
  } catch (e) {
    throw e instanceof ApsError ? new CliError(`${e.message}${opts.hint ? ` ${opts.hint}` : ''}`, EXIT.CONFIG_ERROR) : e;
  }
}

/** The environment `ref` names (id or name), or a configuration error listing the environments; `hint` is added to it. */
export function requireEnvironment(store: WorkspaceStore, ref: string, opts: { hint?: string } = {}): Environment {
  try {
    return findEnvironmentOrThrow(store, ref);
  } catch (e) {
    throw e instanceof ApsError ? new CliError(`${e.message}${opts.hint ? ` ${opts.hint}` : ''}`, EXIT.CONFIG_ERROR) : e;
  }
}

export function readImport<K extends 'collection' | 'environment'>(file: string, want: K): NonNullable<ReturnType<typeof importAny>[K]> {
  let r: ReturnType<typeof importAny>;
  try {
    r = importAny(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new CliError(`Could not read ${want} file ${file}: ${(e as Error).message}`, EXIT.CONFIG_ERROR);
  }
  const v = r[want];
  if (!v) throw new CliError(`${file} is not a ${want} file (detected: ${r.format})`, EXIT.CONFIG_ERROR);
  return v;
}

/** A collection by name or id from a workspace, or from a file or an http(s) link (TestPion / Postman collection, OpenAPI …). */
export async function loadCollectionRef(ref: string, workspace: string | undefined): Promise<Collection> {
  if (/^https?:\/\//i.test(ref)) {
    const f = await fetchImportText(ref);
    let r: ReturnType<typeof importAny>;
    try {
      r = importAny(f.text);
    } catch (e) {
      throw new CliError(`Could not read the collection at ${ref}: ${(e as Error).message}`, EXIT.CONFIG_ERROR);
    }
    if (!r.collection) throw new CliError(`${ref} is not a collection or API definition (detected: ${r.format})`, EXIT.CONFIG_ERROR);
    return r.collection;
  }
  if (existsSync(ref) && statSync(ref).isFile()) return readImport(resolve(ref), 'collection');
  return withWorkspace(workspace, (store) => requireCollection(store, ref, { loadable: true, hint: '(or pass a collection file)' }));
}

/** A run that failed to start leaves nothing behind: drop the default output folder and the ephemeral workspace. */
export function cleanupFailedRun(a: { ephemeral?: string; outDir: string; explicitOut: boolean; store: WorkspaceStore }): void {
  if (a.ephemeral && !a.explicitOut) {
    rmSync(a.outDir, { recursive: true, force: true });
    try {
      rmdirSync(dirname(a.outDir)); // ./testpion-results, only when nothing else is in it
    } catch {
      /* not empty */
    }
  }
  if (a.ephemeral) {
    a.store.close();
    rmSync(a.ephemeral, { recursive: true, force: true });
  }
}

export async function* readResults(file: string): AsyncGenerator<TestResult> {
  for await (const r of await readResultsFile(file)) yield r;
}

export function printLoad(s: LoadSnapshot): void {
  console.log(bold('\nLoad test results'));
  console.log(`  requests      ${s.requests} (${s.throughput}/s)`);
  console.log(`  errors        ${s.errors} (${(s.errorRate * 100).toFixed(2)}%) · connection failures ${s.connectionFailures}`);
  console.log(`  latency       p50 ${s.latency.p50}ms · p90 ${s.latency.p90}ms · p95 ${s.latency.p95}ms · p99 ${s.latency.p99}ms · max ${s.latency.max}ms`);
  console.log(`  status codes  ${Object.entries(s.statusCodes).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  console.log(`  transferred   ${formatBytes(s.bytes)}`);
  if (s.http) {
    console.log(`  server time   p50 ${s.http.ttfb.p50}ms · p95 ${s.http.ttfb.p95}ms (time to first byte)`);
    console.log(`  connections   ${s.http.newConnections} new${s.http.setupMs !== undefined ? ` (set-up ${s.http.setupMs}ms each)` : ''} · ${s.http.reused} reused`);
  }
  if (s.perRequest?.length) {
    console.log(bold(`\nPer request (${s.iterations ?? 0} passes through the collection)`));
    const w = Math.min(48, Math.max(...s.perRequest.map((p) => p.name.length)));
    for (const p of s.perRequest)
      console.log(`  ${p.name.slice(0, w).padEnd(w)}  ${String(p.requests).padStart(6)} req  ${String(p.errors).padStart(4)} err  p50 ${p.latency.p50}ms · p95 ${p.latency.p95}ms`);
  }
}

/**
 * An API definition's text: an http(s) link, or a file as given, else relative to the workspace (`-w`, or the nearest
 * one above the current folder), so `specs/clinic.yaml` works from anywhere like the other commands' paths.
 */
export async function readDefinition(ref: string, workspace?: string): Promise<string> {
  const root = workspace && existsSync(workspace) && statSync(workspace).isDirectory() ? workspace : findWorkspaceUp(process.cwd());
  try {
    return await readSpecRef(undefined, /^https?:\/\//i.test(ref) ? { url: ref } : { path: ref }, { roots: [process.cwd(), ...(root ? [root] : [])] });
  } catch (e) {
    throw e instanceof ApsError ? new CliError(e.message, EXIT.CONFIG_ERROR) : e;
  }
}
