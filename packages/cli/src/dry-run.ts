/**
 * `--dry-run` for every command that writes files or changes state, by one mechanism instead of one per command:
 *
 * 1. The workspace the command opens is a copy (a sandbox in the temp folder), and so is the app folder
 *    (TESTPION_HOME: settings, the workspaces list). The command runs exactly as it would, against the copies.
 * 2. While it runs, every write the process makes outside the sandbox (an export to `-o out.json`, a workspace's
 *    registered folder) goes into the sandbox instead, and every delete outside it is skipped; both are recorded.
 * 3. When it ends, the copies are compared with the originals: the result lists each file the command would add,
 *    change or delete, by its real path. Then the sandbox is removed.
 *
 * Nothing outside the sandbox and the temporary folders the command makes itself is touched, whatever the command does with the file system.
 */
import type * as FS from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { defaultAppDir, isInside, relativeInside } from '@testpion/core';

/** The file system module as CommonJS sees it: its functions can be replaced (and syncBuiltinESMExports passes that on to every `import { … } from 'node:fs'`). */
const fs = createRequire(import.meta.url)('node:fs') as typeof FS;

interface DryRunChange {
  /** The real path the command would change. */
  path: string;
  change: 'added' | 'modified' | 'deleted';
  bytes?: number;
}

interface DryRunReport {
  changes: DryRunChange[];
  /** Nothing was written outside the sandbox. */
  applied: false;
}

/** What is not copied into (or compared in) the sandbox: results, traces, the local database. */
const SKIP = /(^|[\\/])(runs|traces|payloads|reports|trash|baselines|\.git|node_modules)([\\/]|$)|(^|[\\/])database\.sqlite[^\\/]*$|(^|[\\/])metadata\.jsonl$/;

interface State {
  sandbox: string;
  /** Temporary folders the command made itself (mkdtemp): its own scratch space, written as usual. */
  temps: string[];
  /** real folder → its copy */
  copies: Map<string, string>;
  outside: Map<string, string>;
  deletes: Set<string>;
  restore: Array<() => void>;
}

let state: State | undefined;

export const dryRunActive = () => !!state;

const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
// as named or really (`relativeInside`): the sandbox and a copied workspace are in the temp folder, which macOS names
// through a link (/var → /private/var), and a command may name a file of either by its real path
const inside = (child: string, parent: string) => isInside(parent, child, { orSame: true });

/** Where a write to `p` goes: itself (inside the sandbox or the temp folder), or a mirror inside the sandbox. */
function target(p: FS.PathLike | number): FS.PathLike | number {
  if (!state || typeof p === 'number' || p instanceof URL || Buffer.isBuffer(p)) return p;
  const abs = resolve(String(p));
  if (inside(abs, state.sandbox)) return p;
  const real = [...state.copies.keys()].find((r) => inside(abs, r));
  if (real) return join(state.copies.get(real)!, relativeInside(real, abs, { orSame: true })!);
  if (state.temps.some((t) => inside(abs, t))) return p;
  const mirror = join(state.sandbox, 'outside', abs.replace(/^([A-Za-z]):/, '$1').replace(/^[\\/]+/, ''));
  state.outside.set(mirror, abs);
  return mirror;
}

/** A delete outside the sandbox and the command's own temporary folders is recorded, not done. */
function blocked(p: FS.PathLike): boolean {
  if (!state) return false;
  const abs = resolve(String(p));
  if (inside(abs, state.sandbox)) return false;
  const real = [...state.copies.keys()].find((r) => inside(abs, r));
  if (real) return false; // goes to the copy (see target)
  if (state.temps.some((t) => inside(abs, t))) return false;
  state.deletes.add(abs);
  return true;
}

const mkdirFor = (p: FS.PathLike | number) => {
  if (typeof p !== 'number' && state && inside(String(p), state.sandbox)) original.mkdirSync(resolve(String(p), '..'), { recursive: true });
};

const original = { ...fs } as typeof fs;
const originalPromises = { ...fs.promises };

function patch(): void {
  const f = fs as unknown as Record<string, unknown>;
  const p = fs.promises as unknown as Record<string, unknown>;
  const set = (obj: Record<string, unknown>, name: string, fn: unknown) => {
    const before = obj[name];
    obj[name] = fn;
    state!.restore.push(() => (obj[name] = before));
  };
  const redirect1 = (name: string) =>
    set(f, name, (path: FS.PathLike, ...rest: unknown[]) => {
      const t = target(path);
      if (t !== path) mkdirFor(t);
      return (original as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!(t, ...rest);
    });
  // a temporary folder the command makes is its own: what it writes there is written (and removed with it)
  set(f, 'mkdtempSync', (prefix: string, ...rest: unknown[]) => {
    const d = (original.mkdtempSync as (...a: unknown[]) => string)(prefix, ...rest);
    state?.temps.push(resolve(d));
    return d;
  });
  set(p, 'mkdtemp', async (prefix: string, ...rest: unknown[]) => {
    const d = await (originalPromises.mkdtemp as (...a: unknown[]) => Promise<string>)(prefix, ...rest);
    state?.temps.push(resolve(d));
    return d;
  });
  for (const n of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'createWriteStream', 'writeFile', 'appendFile', 'mkdir']) redirect1(n);
  set(f, 'openSync', (path: FS.PathLike, flags?: FS.OpenMode, ...rest: unknown[]) => {
    const writes = typeof flags === 'string' ? /[wa+]/.test(flags) : typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0 : false;
    const t = writes ? target(path) : path;
    if (t !== path) mkdirFor(t);
    return (original.openSync as (...a: unknown[]) => number)(t, flags, ...rest);
  });
  const two = (name: string) =>
    set(f, name, (a: FS.PathLike, b: FS.PathLike, ...rest: unknown[]) => {
      const tb = target(b);
      if (tb !== b) mkdirFor(tb);
      const ta = name === 'copyFileSync' || name === 'cpSync' ? a : target(a);
      return (original as unknown as Record<string, (...x: unknown[]) => unknown>)[name]!(ta, tb, ...rest);
    });
  for (const n of ['renameSync', 'copyFileSync', 'cpSync', 'rename', 'copyFile']) two(n);
  const del = (name: string, obj: Record<string, unknown>, orig: Record<string, unknown>, async: boolean) =>
    set(obj, name, (path: FS.PathLike, ...rest: unknown[]) => {
      if (blocked(path)) {
        const cb = rest.find((x) => typeof x === 'function') as ((e: null) => void) | undefined;
        if (cb) return void cb(null);
        return async ? Promise.resolve() : undefined;
      }
      return (orig[name] as (...a: unknown[]) => unknown)(target(path), ...rest);
    });
  for (const n of ['rmSync', 'rmdirSync', 'unlinkSync']) del(n, f, original as unknown as Record<string, unknown>, false);
  for (const n of ['rm', 'rmdir', 'unlink']) del(n, f, original as unknown as Record<string, unknown>, false);
  for (const n of ['rm', 'rmdir', 'unlink']) del(n, p, originalPromises as unknown as Record<string, unknown>, true);
  for (const n of ['writeFile', 'appendFile', 'mkdir'])
    set(p, n, (path: FS.PathLike, ...rest: unknown[]) => {
      const t = target(path);
      if (t !== path) mkdirFor(t);
      return (originalPromises as unknown as Record<string, (...a: unknown[]) => unknown>)[n]!(t, ...rest);
    });
  for (const n of ['rename', 'copyFile'])
    set(p, n, (a: FS.PathLike, b: FS.PathLike, ...rest: unknown[]) => {
      const tb = target(b);
      if (tb !== b) mkdirFor(tb);
      return (originalPromises as unknown as Record<string, (...x: unknown[]) => unknown>)[n]!(n === 'copyFile' ? a : target(a), tb, ...rest);
    });
  syncBuiltinESMExports();
}

function copyTree(from: string, to: string, filesOnly = false): void {
  original.mkdirSync(to, { recursive: true });
  for (const e of original.readdirSync(from, { withFileTypes: true })) {
    const src = join(from, e.name);
    if (SKIP.test(src.slice(from.length))) continue;
    if (e.isDirectory()) {
      if (!filesOnly) original.cpSync(src, join(to, e.name), { recursive: true, preserveTimestamps: true, filter: (s) => !SKIP.test(s.slice(from.length)) });
    } else if (e.isFile()) original.copyFileSync(src, join(to, e.name));
  }
}

/** Start a dry run: the app folder is copied and every write outside the sandbox is redirected (see the top). */
export function startDryRun(): void {
  if (state) return;
  const sandbox = original.mkdtempSync(join(tmpdir(), 'testpion-dry-run-'));
  state = { sandbox, copies: new Map(), outside: new Map(), deletes: new Set(), temps: [], restore: [] };
  const home = defaultAppDir();
  const homeCopy = join(sandbox, 'home');
  if (original.existsSync(home)) copyTree(home, homeCopy, true);
  else original.mkdirSync(homeCopy, { recursive: true });
  state.copies.set(resolve(home), homeCopy);
  const env = process.env.TESTPION_HOME;
  process.env.TESTPION_HOME = homeCopy;
  state.restore.push(() => (env === undefined ? delete process.env.TESTPION_HOME : (process.env.TESTPION_HOME = env)));
  patch();
}

/** The folder a command opens as its workspace: in a dry run, a copy of it (made once). */
export function dryRunWorkspace(real: string): string {
  if (!state) return real;
  const r = resolve(real);
  // the same folder by another name (a link to it) is the same copy
  const known = [...state.copies.entries()].find(([k]) => norm(k) === norm(r) || relativeInside(k, r, { orSame: true }) === '');
  if (known) return known[1];
  const copy = join(state.sandbox, `ws-${state.copies.size}`);
  copyTree(r, copy);
  state.copies.set(r, copy);
  return copy;
}

function files(dir: string, base = dir, out = new Map<string, string>()): Map<string, string> {
  if (!original.existsSync(dir)) return out;
  for (const e of original.readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = relative(base, p);
    if (SKIP.test(`${sep}${rel}`)) continue;
    if (e.isDirectory()) files(p, base, out);
    else if (e.isFile()) out.set(rel, p);
  }
  return out;
}

const digest = (p: string) => createHash('sha1').update(original.readFileSync(p)).digest('hex');

/** End the dry run: what would have changed, by real path; the patches are undone and the sandbox removed. */
export function finishDryRun(): DryRunReport | undefined {
  const s = state;
  if (!s) return undefined;
  for (const r of s.restore.reverse()) r();
  syncBuiltinESMExports();
  state = undefined;
  const changes: DryRunChange[] = [];
  try {
    for (const [real, copy] of s.copies) {
      const home = norm(copy) === norm(join(s.sandbox, 'home'));
      const before = home ? new Map([...files(real)].filter(([rel]) => !rel.includes(sep))) : files(real);
      const after = home ? new Map([...files(copy)].filter(([rel]) => !rel.includes(sep) || rel.startsWith(`workspaces${sep}`))) : files(copy);
      for (const [rel, p] of after) {
        const was = before.get(rel);
        const bytes = original.statSync(p).size;
        if (!was) changes.push({ path: join(real, rel), change: 'added', bytes });
        else if (original.statSync(was).size !== bytes || digest(was) !== digest(p)) changes.push({ path: join(real, rel), change: 'modified', bytes });
      }
      for (const [rel] of before) if (!after.has(rel)) changes.push({ path: join(real, rel), change: 'deleted' });
    }
    for (const [mirror, real] of s.outside)
      if (original.existsSync(mirror) && original.statSync(mirror).isFile())
        changes.push({ path: real, change: original.existsSync(real) ? 'modified' : 'added', bytes: original.statSync(mirror).size });
    for (const d of s.deletes) if (original.existsSync(d)) changes.push({ path: d, change: 'deleted' });
  } finally {
    original.rmSync(s.sandbox, { recursive: true, force: true, maxRetries: 3 });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { changes, applied: false };
}

/** A dry run's report for a person: nothing was changed, and what would have been. */
export function describeDryRun(r: DryRunReport): string {
  if (!r.changes.length) return 'Dry run: nothing was changed, and nothing would be.';
  const verb = { added: 'add', modified: 'change', deleted: 'delete' } as const;
  return [
    `Dry run: nothing was changed. It would ${r.changes.length === 1 ? 'do this' : `make ${r.changes.length} changes`}:`,
    ...r.changes.map((c) => `  ${verb[c.change].padEnd(6)} ${c.path}${c.bytes !== undefined ? ` (${c.bytes} bytes)` : ''}`),
  ].join('\n');
}
