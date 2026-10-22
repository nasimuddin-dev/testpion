import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ApsError } from '../errors.js';

/**
 * Git for a workspace (GIT-201), through the system `git`: it brings the user's SSH keys, credential helper (Git
 * Credential Manager on Windows), commit signing and hooks. Every call is scoped to the workspace folder, which can
 * be the repository or a folder inside one. See planning/git-integration.md.
 */

type GitFileState = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface GitFile {
  /** Path inside the workspace, forward slashes. */
  path: string;
  state: GitFileState;
  /** Staged (in the index) rather than only in the working folder. */
  staged: boolean;
  /** Staged, and changed again in the working folder since (an item staged alone, or an edit after staging). */
  alsoUnstaged?: boolean;
  /** For a rename, where it came from. */
  from?: string;
}

interface GitStatus {
  repository: boolean;
  /** Repository root (absolute). */
  root?: string;
  /** The workspace's folder inside the repository, when the workspace is not the repository itself (the examples inside a checkout). */
  folder?: string;
  branch?: string;
  upstream?: string;
  /** The commit HEAD points at (undefined before the first commit): it moves with a commit, merge, pull, reset or switch, also one made outside the app. */
  head?: string;
  ahead: number;
  behind: number;
  files: GitFile[];
  /** A merge or rebase stopped on conflicts. */
  conflicted: boolean;
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

interface GitBranches {
  current?: string;
  local: string[];
  remote: string[];
}

const MAX_BUFFER = 64 * 1024 * 1024;

/** How many git processes this process has started (tests count them: a refresh must not cost one per changed file). */
export const gitSpawns = { count: 0 };

/** Run git in `cwd`; resolves stdout, rejects with git's own message (stderr) as an ApsError. */
export function runGit(cwd: string, args: string[], opts: { input?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<string> {
  return execGit(cwd, args, opts, 'utf8');
}

/** Like runGit, but stdout as bytes (a blob is not always text, and a batch holds many of them). */
export function runGitBytes(cwd: string, args: string[], opts: { input?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<Buffer> {
  return execGit(cwd, args, opts, 'buffer');
}

/**
 * After git was stopped for taking too long (a remote that hangs, a dropped VPN): execFile's SIGTERM ends `git` but, on Windows, its helper
 * (git-remote-https, a credential manager) can live on holding the index; end the whole tree, and remove an index.lock that is older than the
 * timeout (the process that took it is gone).
 */
function cleanAfterTimeout(cwd: string, pid: number | undefined, timeoutMs: number): void {
  try {
    if (process.platform === 'win32' && pid) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    const lock = join(cwd, '.git', 'index.lock');
    const st = statSync(lock, { throwIfNoEntry: false });
    if (st && Date.now() - st.mtimeMs > timeoutMs) rmSync(lock, { force: true });
  } catch {
    /* best effort */
  }
}

function execGit<E extends 'utf8' | 'buffer'>(cwd: string, args: string[], opts: { input?: string; timeoutMs?: number; env?: Record<string, string> }, encoding: E): Promise<E extends 'buffer' ? Buffer : string> {
  type Out = E extends 'buffer' ? Buffer : string;
  gitSpawns.count++;
  // a remote added, changed or removed (by the app or by anything that goes through here): the remembered URL is stale
  if (args[0] === 'remote') remotes.clear();
  return new Promise<Out>((done, fail) => {
    const child = execFile(
      'git',
      args,
      // GIT_OPTIONAL_LOCKS=0: a read (status, diff …) never takes the index lock to refresh the index's stat cache. The app reads
      // in the background after every save, and such a read holding .git/index.lock made a commit or a stage that came at that
      // moment fail with "Unable to create index.lock: File exists". Writes (add, commit, checkout …) still lock, as they must.
      { cwd, maxBuffer: MAX_BUFFER, encoding, timeout: opts.timeoutMs ?? 120_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', ...opts.env } },
      (err, stdout, stderr) => {
        if (!err) return done(stdout as Out);
        if ((err as { killed?: boolean }).killed) cleanAfterTimeout(cwd, child.pid, opts.timeoutMs ?? 120_000);
        const text = String(stderr);
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        fail(
          new ApsError('ConfigurationError', missing ? 'Git is not installed' : (text || err.message).trim().split('\n').slice(-3).join(' '), {
            suggestions: missing ? ['Install Git from https://git-scm.com and restart TestPion.'] : gitHints(text),
          }),
        );
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/**
 * A branch, tag or commit name that is safe as a git argument: what git itself allows in a ref, and never a dash
 * first (an agent or a page could otherwise slip an option such as `--output=<file>` in as a "revision").
 */
export function assertGitRef(name: string, what = 'branch'): string {
  const n = String(name ?? '').trim();
  if (!n || n.startsWith('-') || /[\s~^:?*[\\\x00-\x1f]|\.\.|@\{|\/\/|\.lock$|\/$|^\/|^@$/.test(n)) throw new ApsError('ValidationError', `Not a valid git ${what}: ${n || '(empty)'}`);
  return n;
}

/** A revision for diff / show / log: a ref, a commit hash, HEAD, or those with ~ and ^ suffixes (never an option). */
export function assertGitRev(rev: string): string {
  const r = String(rev ?? '').trim();
  if (!r || r.startsWith('-') || !/^[\w./@^~-]+$/.test(r) || /\.\./.test(r)) throw new ApsError('ValidationError', `Not a valid git revision: ${r || '(empty)'}`);
  return r;
}

/** A remote URL (https, ssh, git, or a local path): never something git would read as an option. */
export function assertRemoteUrl(url: string): string {
  const u = String(url ?? '').trim();
  if (!u || u.startsWith('-') || /[\s\x00-\x1f]/.test(u)) throw new ApsError('ValidationError', `Not a valid repository URL: ${u || '(empty)'}`);
  // git's `ext::` transport runs a command named in the URL
  if (/^ext::/i.test(u)) throw new ApsError('ValidationError', 'The ext:: transport runs a program and is not allowed', { suggestions: ['Use an https:// or ssh address.'] });
  return u;
}

/** Plain-words next steps for git's usual complaints. */
function gitHints(stderr: string): string[] {
  const s = stderr.toLowerCase();
  if (/rejected|non-fast-forward|fetch first/.test(s)) return ['The remote has commits you don\'t have: pull first, then push again (Pull & push, or `testpion git sync`, does both).'];
  if (/authentication|could not read username|permission denied|403/.test(s)) return ['Git could not sign in to the remote: sign in once with git in a terminal (or set up an SSH key), then try again.'];
  if (/not a git repository/.test(s)) return ['This workspace is not in a git repository yet: use Initialize, or clone one.'];
  if (/conflict/.test(s)) return ['Resolve the conflicts (Git panel), then commit.'];
  if (/would be overwritten|local changes/.test(s)) return ['Commit or discard your changes first.'];
  return [];
}

/** Git's version, asked once per process (git is not installed or upgraded while the app runs; a miss is asked again). */
let knownVersion: Promise<string | undefined> | undefined;
export function gitVersion(): Promise<string | undefined> {
  knownVersion ??= runGit(process.cwd(), ['--version'])
    .then((out) => out.trim().replace(/^git version /, ''))
    .catch(() => {
      knownVersion = undefined;
      return undefined;
    });
  return knownVersion;
}

/**
 * The repository root that holds `dir`, or undefined. Remembered for a few seconds: every operation asks, and
 * spawning git for it each time cost more than the operation itself. A `git init` (or deleting .git) is seen on
 * the next ask after that. A folder that is not in a repository stays known as such (no git spawned on every
 * status) until a `.git` appears in it or above it, or `gitInit` / a clone forgets the roots.
 */
const roots = new Map<string, { root: string | undefined; at: number }>(); // bounded: 500 folders
export async function repoRoot(dir: string): Promise<string | undefined> {
  const known = roots.get(dir);
  if (known) {
    // A remembered root is only believed while its `.git` (folder, or the file of a worktree / submodule) is still
    // there: one stat, no git spawned. Without it a repository moved or deleted within the 3 s looked intact.
    if (known.root ? Date.now() - known.at < 3000 && existsSync(join(known.root, '.git')) : !gitDirNear(dir)) return known.root;
    if (known.root) roots.delete(dir);
  }
  let root: string | undefined;
  try {
    root = resolve((await runGit(dir, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    root = undefined;
  }
  if (roots.size >= 500) roots.delete(roots.keys().next().value!); // bounded: one entry per folder asked about
  roots.set(dir, { root, at: Date.now() });
  return root;
}

/** Whether `dir` or a folder above it has a `.git` (a repository, or a worktree's file). */
function gitDirNear(dir: string): boolean {
  let d = resolve(dir);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(d, '.git'))) return true;
    const up = dirname(d);
    if (up === d) return false;
    d = up;
  }
  return false;
}

/** Forget the remembered repository roots (after `git init`, a clone into the folder …). */
const forgetRepoRoots = () => (roots.clear(), remotes.clear());

/**
 * The workspace folder as git sees it: git reports the real path of the repository (links resolved, Windows 8.3
 * short names like RUNNER~1 expanded, macOS /var as /private/var), so paths are related to the real folder, not to a
 * link to it (else every file came out as ../../real/path).
 */
export function realFolder(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return resolve(dir);
  }
}

/** Paths in git output are relative to the repository root: make them relative to the workspace. */
const toWorkspacePath = (repo: string, ws: string, p: string) => relative(realFolder(ws), resolve(repo, p)).split(sep).join('/');
/** A workspace path as a path in the repository. */
export const toRepoPath = (repo: string, ws: string, p: string) => relative(repo, resolve(realFolder(ws), p)).split(sep).join('/');

/** `git status` of the workspace folder: branch, ahead / behind, and each changed file. */
export async function gitStatus(ws: string): Promise<GitStatus> {
  const repo = await repoRoot(ws);
  if (!repo) return { repository: false, ahead: 0, behind: 0, files: [], conflicted: false };
  const out = await runGit(ws, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', '.']);
  const st: GitStatus = { repository: true, root: repo, ahead: 0, behind: 0, files: [], conflicted: false };
  // the real folder is asked once, not for each of thousands of files (realpath is a system call)
  const real = realFolder(ws);
  const toWs = (p: string) => relative(real, resolve(repo, p)).split(sep).join('/');
  const folder = toRepoPath(repo, ws, '.');
  if (folder && folder !== '.') st.folder = folder;
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!;
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) st.head = /^[0-9a-f]{40,64}$/.test(line.slice(13)) ? line.slice(13) : undefined;
    else if (line.startsWith('# branch.head ')) st.branch = line.slice(14) === '(detached)' ? undefined : line.slice(14);
    else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) (st.ahead = Number(m[1])), (st.behind = Number(m[2]));
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const f = line.split(' ');
      const xy = f[1]!;
      const path = line.startsWith('1 ') ? f.slice(8).join(' ') : f.slice(9).join(' ');
      const from = line.startsWith('2 ') ? parts[++i] : undefined;
      const code = xy[0] !== '.' ? xy[0]! : xy[1]!;
      const state: GitFileState = line.startsWith('2 ') ? 'renamed' : code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
      // staged when the index column has a change; a file changed in both shows once, as staged
      st.files.push({ path: toWs(path), state, staged: xy[0] !== '.', ...(xy[0] !== '.' && xy[1] !== '.' ? { alsoUnstaged: true } : {}), ...(from ? { from: toWs(from) } : {}) });
    } else if (line.startsWith('u ')) {
      const f = line.split(' ');
      st.files.push({ path: toWs(f.slice(10).join(' ')), state: 'conflicted', staged: false });
      st.conflicted = true;
    } else if (line.startsWith('? ')) st.files.push({ path: toWs(line.slice(2)), state: 'untracked', staged: false });
  }
  st.files = st.files.filter((f) => !f.path.startsWith('..'));
  return st;
}

/**
 * A stamp of the repository's branches, without running git: the times and sizes of HEAD, packed-refs, the stash
 * and the folders of local and remote branches. A branch made, deleted, renamed or moved (git writes `<ref>.lock` beside the
 * ref, so its folder's time changes), by the app or by git run anywhere else, gives another stamp. '' outside a repository.
 */
export async function gitRefsStamp(ws: string): Promise<string> {
  const repo = await repoRoot(ws);
  if (!repo) return '';
  const stamp = (p: string) => {
    try {
      const s = statSync(p);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return '-';
    }
  };
  // a worktree or submodule has a `.git` file naming its folder; branches live in the common folder
  let dir = join(repo, '.git');
  try {
    if (statSync(dir).isFile()) dir = resolve(repo, /^gitdir:\s*(.+)$/m.exec(readFileSync(dir, 'utf8'))?.[1]?.trim() ?? '.git');
  } catch {
    return '';
  }
  let common = dir;
  try {
    common = resolve(dir, readFileSync(join(dir, 'commondir'), 'utf8').trim());
  } catch {
    /* not a linked worktree */
  }
  const remotes = join(common, 'refs', 'remotes');
  let perRemote: string[] = [];
  try {
    perRemote = readdirSync(remotes).map((r) => join(remotes, r));
  } catch {
    /* no remote yet */
  }
  return [join(dir, 'HEAD'), join(common, 'packed-refs'), join(common, 'refs', 'heads'), join(common, 'refs', 'stash'), remotes, ...perRemote].map(stamp).join('|');
}

/** A file as it is in a commit (default HEAD); undefined when it does not exist there. */
export async function gitShow(ws: string, path: string, rev = 'HEAD'): Promise<string | undefined> {
  const repo = await repoRoot(ws);
  if (!repo) return undefined;
  const inRepo = toRepoPath(repo, ws, path);
  try {
    return await runGit(ws, ['show', `${assertGitRev(rev)}:${inRepo}`]);
  } catch {
    return undefined;
  }
}

/** A file as it is in the index (what a commit would take); undefined when it is not staged / tracked. */
export async function gitIndexText(ws: string, path: string): Promise<string | undefined> {
  const repo = await repoRoot(ws);
  if (!repo) return undefined;
  try {
    return await runGit(ws, ['show', `:${toRepoPath(repo, ws, path)}`]);
  } catch {
    return undefined;
  }
}

/** The size in bytes of a file as it is in a commit (default HEAD); undefined when it does not exist there. */
export async function gitBlobSize(ws: string, path: string, rev = 'HEAD'): Promise<number | undefined> {
  const repo = await repoRoot(ws);
  if (!repo) return undefined;
  try {
    const n = Number((await runGit(ws, ['cat-file', '-s', `${assertGitRev(rev)}:${toRepoPath(repo, ws, path)}`])).trim());
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** The unified diff of one file (working folder against HEAD, or the staged change). */
export async function gitDiff(ws: string, path: string, staged = false): Promise<string> {
  return runGit(ws, ['diff', '--no-color', '--no-textconv', ...(staged ? ['--cached'] : []), '--', path]);
}

export async function gitStage(ws: string, paths: string[]): Promise<void> {
  if (paths.length) await runGit(ws, ['add', '--all', '--', ...paths]);
}

export async function gitUnstage(ws: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  try {
    await runGit(ws, ['restore', '--staged', '--', ...paths]);
  } catch {
    // a repository without commits yet: nothing to restore from, so remove from the index
    await runGit(ws, ['rm', '--cached', '-r', '--quiet', '--', ...paths]);
  }
}

/** Throw away changes to these files: tracked ones go back to HEAD, new ones are deleted. */
export async function gitDiscard(ws: string, files: Array<Pick<GitFile, 'path' | 'state'>>): Promise<void> {
  const tracked = files.filter((f) => f.state !== 'untracked' && f.state !== 'added').map((f) => f.path);
  const fresh = files.filter((f) => f.state === 'untracked' || f.state === 'added').map((f) => f.path);
  if (tracked.length) await runGit(ws, ['checkout', 'HEAD', '--', ...tracked]);
  if (fresh.length) {
    await runGit(ws, ['rm', '--cached', '-r', '--quiet', '--ignore-unmatch', '--', ...fresh]).catch(() => undefined);
    await runGit(ws, ['clean', '-f', '-q', '--', ...fresh]);
  }
}

/** Commit what is staged (or `paths`, staged first); returns the new commit. */
export async function gitCommit(ws: string, message: string, opts: { paths?: string[]; amend?: boolean } = {}): Promise<GitCommit> {
  if (!message.trim() && !opts.amend) throw new ApsError('ValidationError', 'A commit needs a message');
  if (opts.paths?.length) await gitStage(ws, opts.paths);
  await runGit(ws, ['commit', '-F', '-', ...(opts.amend ? ['--amend'] : [])], { input: message });
  return (await gitLog(ws, { limit: 1 }))[0]!;
}

/** Commits, newest first; with `path`, only those that changed that file (following renames). */
/** A commit as the Git view shows it when picked: its message, and the files it changed in the workspace. */
interface GitCommitDetail extends GitCommit {
  body: string;
  files: Array<{ path: string; state: GitFileState; additions: number; deletions: number }>;
}

export async function gitCommitDetail(ws: string, hash: string): Promise<GitCommitDetail | undefined> {
  const repo = await repoRoot(ws);
  if (!repo || !/^[0-9a-f]{4,40}$/i.test(hash)) return undefined;
  try {
    const [head, stat, names] = await Promise.all([
      runGit(ws, ['show', '-s', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b', hash]),
      runGit(ws, ['show', '--format=', '--numstat', '-M', hash, '--', '.']),
      runGit(ws, ['show', '--format=', '--name-status', '-M', hash, '--', '.']),
    ]);
    const [full, short, author, email, date, subject, body] = head.trim().split('\x1f');
    const states = new Map<string, GitFileState>();
    for (const line of names.split('\n')) {
      const [code, ...rest] = line.split('\t');
      if (!code || !rest.length) continue;
      const path = rest[rest.length - 1]!;
      states.set(path, code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : code.startsWith('R') ? 'renamed' : 'modified');
    }
    const files: GitCommitDetail['files'] = [];
    for (const line of stat.split('\n')) {
      const [a, d, ...rest] = line.split('\t');
      if (!rest.length) continue;
      const path = rest[rest.length - 1]!.replace(/^.*\{.* => (.*)\}(.*)$/, '$1$2');
      const wsPath = toWorkspacePath(repo, ws, path);
      if (wsPath.startsWith('..')) continue;
      files.push({ path: wsPath, state: states.get(path) ?? 'modified', additions: Number(a) || 0, deletions: Number(d) || 0 });
    }
    return { hash: full!, short: short!, author: author!, email: email!, date: date!, subject: subject ?? '', body: (body ?? '').trim(), files };
  } catch {
    return undefined;
  }
}

/** The unified diff of one file in a commit. */
export async function gitCommitDiff(ws: string, hash: string, path: string): Promise<string> {
  const repo = await repoRoot(ws);
  if (!repo || !/^[0-9a-f]{4,40}$/i.test(hash)) return '';
  try {
    return await runGit(ws, ['show', '--format=', '--no-textconv', hash, '--', toRepoPath(repo, ws, path)]);
  } catch {
    return '';
  }
}

export async function gitLog(ws: string, opts: { path?: string; limit?: number } = {}): Promise<GitCommit[]> {
  try {
    // the workspace's own history: a workspace that is a folder of a bigger repository sees the commits that touched it
    const out = await runGit(ws, ['log', `--max-count=${opts.limit ?? 50}`, '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e', ...(opts.path ? ['--follow', '--', opts.path] : ['--', '.'])]);
    return out
      .split('\x1e')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [hash, short, author, email, date, subject] = r.split('\x1f');
        return { hash: hash!, short: short!, author: author!, email: email!, date: date!, subject: subject ?? '' };
      });
  } catch {
    return []; // no commits yet
  }
}

export async function gitBranches(ws: string): Promise<GitBranches> {
  const out = await runGit(ws, ['branch', '--all', '--format=%(HEAD)%1f%(refname)']);
  const b: GitBranches = { local: [], remote: [] };
  for (const line of out.split('\n').filter(Boolean)) {
    const [head, ref] = line.split('\x1f');
    if (ref!.startsWith('refs/heads/')) {
      const name = ref!.slice(11);
      b.local.push(name);
      if (head === '*') b.current = name;
    } else if (ref!.startsWith('refs/remotes/') && !ref!.endsWith('/HEAD')) b.remote.push(ref!.slice(13));
  }
  return b;
}

export async function gitSwitch(ws: string, branch: string, opts: { create?: boolean; from?: string } = {}): Promise<void> {
  assertGitRef(branch);
  if (opts.from) assertGitRev(opts.from);
  // a remote branch ("origin/feature") is checked out as a local branch that tracks it
  const remote = !opts.create && branch.includes('/') ? branch : undefined;
  if (remote) await runGit(ws, ['switch', '--track', remote]);
  else await runGit(ws, ['switch', ...(opts.create ? ['-c', branch, ...(opts.from ? [opts.from] : [])] : [branch])]);
}

export async function gitDeleteBranch(ws: string, branch: string, force = false): Promise<void> {
  await runGit(ws, ['branch', force ? '-D' : '-d', assertGitRef(branch)]);
}

/** Rename a local branch (GIT-207); its upstream setting moves with it. */
export async function gitRenameBranch(ws: string, from: string, to: string): Promise<void> {
  await runGit(ws, ['branch', '-m', assertGitRef(from), assertGitRef(to)]);
}

/**
 * See what the remote has. `quiet` is the background fetch: it never asks for a sign-in (no terminal prompt, no
 * credential manager window) and gives up sooner; a remote that needs one simply fails.
 */
export async function gitFetch(ws: string, opts: { quiet?: boolean } = {}): Promise<void> {
  await runGit(ws, ['fetch', '--prune'], opts.quiet ? { timeoutMs: 60_000, env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' } } : { timeoutMs: 300_000 });
}

/** What a pull did: stopped on conflicts or not, and whether uncommitted changes had to be set aside for it. */
interface GitPullResult {
  conflicted: boolean;
  /** Uncommitted changes were set aside (git stash) for the pull and put back. */
  setAside?: boolean;
  /** They are still in the git stash: the pull stopped on conflicts before they could be put back. */
  stillStashed?: boolean;
  /** In plain words, for the user. */
  message?: string;
}

const STASH_MESSAGE = 'TestPion: uncommitted changes set aside for a pull';
/** git refuses a pull that would overwrite uncommitted changes. */
const REFUSED_FOR_LOCAL_CHANGES = /would be overwritten|commit your changes or stash them|discard your changes first|unstaged changes|uncommitted changes|local changes/i;

/**
 * Pull (merge by default, the merge driver merging collections request by request). When git refuses because of
 * uncommitted changes, they are set aside (`git stash push --include-untracked`), the pull runs, and they are put back
 * (`git stash pop`, which merges with the same driver): a put-back that conflicts leaves the files in the Conflicts list.
 */
export async function gitPull(ws: string, opts: { rebase?: boolean } = {}): Promise<GitPullResult> {
  const pull = () => runGit(ws, ['pull', opts.rebase ? '--rebase' : '--no-rebase'], { timeoutMs: 300_000 });
  try {
    await pull();
    return { conflicted: false };
  } catch (e) {
    if ((await gitStatus(ws)).conflicted) return { conflicted: true };
    if (!REFUSED_FOR_LOCAL_CHANGES.test(errorText(e))) throw e;
  }
  // set the uncommitted work aside, pull, put it back
  await runGit(ws, ['stash', 'push', '--include-untracked', '-m', STASH_MESSAGE]);
  try {
    await pull();
  } catch (e) {
    if ((await gitStatus(ws)).conflicted)
      return {
        conflicted: true,
        setAside: true,
        stillStashed: true,
        message: 'Your uncommitted changes were set aside (git stash) and the pull stopped on conflicts: resolve them and commit, then put your changes back with `git stash pop`.',
      };
    // the pull failed (offline, sign-in …): everything goes back as it was
    await runGit(ws, ['stash', 'pop']).catch(() => undefined);
    throw e;
  }
  try {
    await runGit(ws, ['stash', 'pop']);
  } catch (e) {
    if ((await gitStatus(ws)).conflicted)
      return {
        conflicted: true,
        setAside: true,
        message: 'Your uncommitted changes were set aside and put back, and some conflict with the pull: resolve them below (here "mine" is the pulled version and "theirs" your uncommitted change). Git keeps a copy in its stash until you drop it.',
      };
    throw e;
  }
  return { conflicted: false, setAside: true, message: 'Your uncommitted changes were set aside and put back.' };
}

const errorText = (e: unknown) => {
  const err = e as { message?: string; suggestions?: string[] };
  return `${err?.message ?? String(e)} ${(err?.suggestions ?? []).join(' ')}`;
};

/** A push the remote refused because it has commits this branch does not (someone pushed first). */
const isBehindRejection = (e: unknown) => /rejected|non-fast-forward|fetch first|pull first/i.test(errorText(e));

export async function gitPush(ws: string): Promise<void> {
  const st = await gitStatus(ws);
  // the first push of a branch sets where it goes
  await runGit(ws, ['push', ...(st.upstream ? [] : ['--set-upstream', 'origin', st.branch ?? 'HEAD'])], { timeoutMs: 300_000 });
}

/** What a sync did (`gitSync`). */
export interface GitSyncResult {
  state: 'pushed' | 'up-to-date' | 'pulled-nothing-to-push' | 'conflicts';
  /** Commits brought in from the remote. */
  pulled: number;
  /** Commits sent to the remote. */
  pushed: number;
  /** With `conflicts`: the conflicted files (workspace paths). */
  files?: string[];
  /** Uncommitted changes were set aside for the pull and put back. */
  setAside?: boolean;
  /** In plain words, for the user. */
  message: string;
}

/** Commits on this branch the remote does not have (all of them before the first push). */
async function commitsToPush(ws: string, upstream?: string): Promise<number> {
  try {
    return Number((await runGit(ws, ['rev-list', '--count', 'HEAD', ...(upstream ? ['--not', upstream] : ['--not', '--remotes'])])).trim()) || 0;
  } catch {
    return 0; // no commits yet
  }
}

/**
 * Pull & push in one step, so two people changing the same collection never get stuck at push: fetch; when the
 * remote has new commits, pull them with a merge (collections merge request by request); when that leaves conflicts,
 * stop and return them; otherwise push (setting the upstream on a first push). A push refused because someone pushed
 * in the meantime is retried once, after another pull.
 */
export async function gitSync(ws: string): Promise<GitSyncResult> {
  let st = await gitStatus(ws);
  if (!st.repository) throw new ApsError('ConfigurationError', 'The workspace is not in a git repository', { suggestions: ['Initialize it in the Git view, or run git init in the workspace folder.'] });
  const conflicts = (setAside?: boolean, extra?: string): GitSyncResult => ({
    state: 'conflicts',
    pulled,
    pushed: 0,
    files: st.files.filter((f) => f.state === 'conflicted').map((f) => f.path),
    ...(setAside ? { setAside } : {}),
    message: `Resolve the conflicts, commit, then Push.${extra ? ` ${extra}` : ''}`,
  });
  let pulled = 0;
  let setAside = false;
  let pullNote: string | undefined;
  if (st.conflicted) return conflicts();
  if (!(await gitRemoteUrl(ws))) throw new ApsError('ConfigurationError', 'The workspace has no remote to pull from or push to', { suggestions: ['Connect a remote in the Git view (or git remote add origin <url>), then sync again.'] });

  /** Pull what the remote has; false when it stopped on conflicts. */
  const pull = async (): Promise<boolean> => {
    const behind = st.behind;
    const r = await gitPull(ws);
    if (r.setAside) setAside = true;
    if (r.stillStashed) pullNote = r.message;
    st = await gitStatus(ws);
    if (r.conflicted) return false;
    pulled += behind;
    return true;
  };

  if (st.upstream) {
    await gitFetch(ws);
    st = await gitStatus(ws);
    if (st.behind > 0 && !(await pull())) return conflicts(setAside, pullNote);
  }
  const done = (state: GitSyncResult['state'], pushed: number): GitSyncResult => {
    const words =
      state === 'pushed'
        ? `${pulled ? `Pulled ${plural(pulled, 'commit')}, merged, and pushed` : 'Pushed'} ${plural(pushed, 'commit')}.`
        : state === 'pulled-nothing-to-push'
          ? `Pulled ${plural(pulled, 'commit')}; nothing to push.`
          : 'Up to date with the remote.';
    return { state, pulled, pushed, ...(setAside ? { setAside } : {}), message: setAside ? `${words} Your uncommitted changes were set aside and put back.` : words };
  };
  let ahead = await commitsToPush(ws, st.upstream);
  if (!ahead) return done(pulled ? 'pulled-nothing-to-push' : 'up-to-date', 0);
  try {
    await gitPush(ws);
  } catch (e) {
    // someone pushed between the fetch and the push: pull once more, then push again
    if (!isBehindRejection(e)) throw e;
    await gitFetch(ws);
    st = await gitStatus(ws);
    if (!(await pull())) return conflicts(setAside, pullNote);
    ahead = await commitsToPush(ws, st.upstream);
    await gitPush(ws);
  }
  return done('pushed', ahead);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Make the workspace folder a repository (with a first branch name), optionally with a remote. */
export async function gitInit(ws: string, opts: { remote?: string; branch?: string } = {}): Promise<void> {
  if (!(await repoRoot(ws))) {
    await runGit(ws, ['init', '-b', assertGitRef(opts.branch ?? 'main')]);
    forgetRepoRoots();
  }
  if (opts.remote) {
    const remotes = (await runGit(ws, ['remote'])).split('\n').filter(Boolean);
    await runGit(ws, ['remote', remotes.includes('origin') ? 'set-url' : 'add', 'origin', assertRemoteUrl(opts.remote)]);
  }
}

/** Clone a repository into `dest` (which must not exist or be empty). */
export async function gitClone(url: string, dest: string, opts: { branch?: string } = {}): Promise<void> {
  if (existsSync(dest) && (await import('node:fs')).readdirSync(dest).length) throw new ApsError('ValidationError', `The folder ${dest} is not empty`, { suggestions: ['Choose a new or empty folder to clone into.'] });
  // defence in depth: `ext::<command>` runs a program (off by default in git, refused here too), and a repository's submodules cannot use local paths
  await runGit(process.cwd(), ['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=user', 'clone', '--no-recurse-submodules', ...(opts.branch ? ['--branch', assertGitRef(opts.branch)] : []), '--', assertRemoteUrl(url), dest], { timeoutMs: 600_000 });
}

/** The remote's URL (origin), if any: a link to open pull requests with. Remembered for a few seconds (the status asks after every save). */
const remotes = new Map<string, { url: string | undefined; at: number }>(); // bounded: 500 workspaces
export async function gitRemoteUrl(ws: string): Promise<string | undefined> {
  const known = remotes.get(ws);
  if (known && Date.now() - known.at < 5000) return known.url;
  let url: string | undefined;
  try {
    url = (await runGit(ws, ['remote', 'get-url', 'origin'])).trim() || undefined;
  } catch {
    url = undefined;
  }
  if (remotes.size >= 500) remotes.delete(remotes.keys().next().value!);
  remotes.set(ws, { url, at: Date.now() });
  return url;
}

/**
 * A link that opens a pull request for `branch` on the remote's website (GIT-304): GitHub, GitLab, Bitbucket and
 * Azure DevOps. Undefined for other hosts.
 */
export function pullRequestUrl(remote: string, branch: string, base = 'main', body?: string): string | undefined {
  // git@github.com:owner/repo.git, ssh://git@host/owner/repo.git, https://host/owner/repo(.git)
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(remote.trim());
  if (!m) return undefined;
  const host = m[1]!.toLowerCase();
  const path = m[2]!.replace(/^\/+/, '');
  const b = encodeURIComponent(branch);
  // the description (the changes by meaning), kept short enough for a URL
  const text = body ? encodeURIComponent(body.length > 3000 ? `${body.slice(0, 3000)}\n…` : body) : undefined;
  if (host === 'github.com' || host.startsWith('github.')) return `https://${host}/${path}/compare/${encodeURIComponent(base)}...${b}?expand=1${text ? `&body=${text}` : ''}`;
  if (host === 'gitlab.com' || host.startsWith('gitlab.'))
    return `https://${host}/${path}/-/merge_requests/new?merge_request[source_branch]=${b}&merge_request[target_branch]=${encodeURIComponent(base)}${text ? `&merge_request[description]=${text}` : ''}`;
  if (host === 'bitbucket.org') return `https://${host}/${path}/pull-requests/new?source=${b}&dest=${encodeURIComponent(base)}`;
  if (host === 'dev.azure.com' || host === 'ssh.dev.azure.com') {
    // https: org/project/_git/repo; ssh: v3/org/project/repo
    const p = path.startsWith('v3/') ? path.slice(3).replace(/^([^/]+)\/([^/]+)\/(.+)$/, '$1/$2/_git/$3') : path;
    return `https://dev.azure.com/${p}/pullrequestcreate?sourceRef=${b}&targetRef=${encodeURIComponent(base)}`;
  }
  return undefined;
}

/** The remote's default branch (origin/HEAD), else main. */
export async function gitDefaultBranch(ws: string): Promise<string> {
  try {
    return (await runGit(ws, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim().replace(/^origin\//, '') || 'main';
  } catch {
    return 'main';
  }
}

/** Stop a merge (or rebase) that ended in conflicts: everything goes back to before the pull. */
export async function gitAbortMerge(ws: string): Promise<void> {
  try {
    await runGit(ws, ['merge', '--abort']);
  } catch {
    await runGit(ws, ['rebase', '--abort']);
  }
}

/**
 * Register the TestPion merge driver for this repository (GIT-301): collection files then merge request by request.
 * `command` runs the driver: e.g. `testpion merge-driver` or `"C:/…/TestPion.exe" --merge-driver`. Local config only.
 */
export async function gitSetupMergeDriver(ws: string, command: string): Promise<void> {
  await runGit(ws, ['config', 'merge.testpion.name', 'TestPion collections (by request id)']);
  await runGit(ws, ['config', 'merge.testpion.driver', `${command} %O %A %B %P`]);
}
