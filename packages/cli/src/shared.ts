/** Shared CLI helpers: exit codes, colours, errors, opening workspaces and collections. */
import { existsSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  WorkspaceManager,
  WorkspaceStore,
  formatBytes,
  importAny,
  fetchImportText,
  readResultsFile,
  type LoadSnapshot,
  type Collection,
  type TestResult,
} from '@testpion/core';

/** Exit codes (spec §37). */
export const EXIT = { SUCCESS: 0, TEST_FAILURE: 1, CONFIG_ERROR: 2, EXECUTION_ERROR: 3 } as const;

export const tty = process.stdout.isTTY && !process.env.NO_COLOR && !process.env.CI;

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

export function collectVar(v: string, prev: Record<string, string> = {}): Record<string, string> {
  const i = v.indexOf('=');
  if (i <= 0) throw new CliError(`--var expects key=value, got "${v}"`, EXIT.CONFIG_ERROR);
  return { ...prev, [v.slice(0, i)]: v.slice(i + 1) };
}

export function findWorkspaceUp(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'workspace.json'))) return dir;
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
  const { store, ephemeral } = openWorkspace(workspace, undefined, new WorkspaceManager());
  try {
    const cols = store.listCollections().filter((c) => !c.problem);
    const found = cols.find((c) => c.id === ref) ?? cols.find((c) => c.name.toLowerCase() === ref.toLowerCase());
    if (!found) throw new CliError(`Collection "${ref}" not found. Available: ${cols.map((c) => c.name).join(', ') || 'none'} (or pass a collection file)`, EXIT.CONFIG_ERROR);
    return found;
  } finally {
    store.close();
    if (ephemeral) rmSync(ephemeral, { recursive: true, force: true });
  }
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
  if (/^https?:\/\//i.test(ref)) return (await fetchImportText(ref)).text;
  const root = workspace && existsSync(workspace) && statSync(workspace).isDirectory() ? workspace : findWorkspaceUp(process.cwd());
  const candidates = [resolve(ref), ...(root ? [resolve(root, ref)] : [])];
  const file = candidates.find((c) => existsSync(c)) ?? candidates[0]!;
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    throw new CliError(`Cannot read ${ref}: ${(e as Error).message}`, EXIT.CONFIG_ERROR);
  }
}
