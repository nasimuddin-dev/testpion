import { execFile } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { mergeWorkspaceTexts, requestParts, type MergeConflict, type MergeResolutions } from './merge.js';

/** The files TestPion merges by meaning (collections, environments, library), not by lines. */
const MERGED_BY_MEANING = /^(collections|environments|library)\/[^/]+\.json$/;
import { relative, resolve, sep } from 'node:path';
import { ApsError } from '../errors.js';

/**
 * Git for a workspace (GIT-201), through the system `git`: it brings the user's SSH keys, credential helper (Git
 * Credential Manager on Windows), commit signing and hooks. Every call is scoped to the workspace folder, which can
 * be the repository or a folder inside one. See planning/git-integration.md.
 */

export type GitFileState = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface GitFile {
  /** Path inside the workspace, forward slashes. */
  path: string;
  state: GitFileState;
  /** Staged (in the index) rather than only in the working folder. */
  staged: boolean;
  /** For a rename, where it came from. */
  from?: string;
}

export interface GitStatus {
  repository: boolean;
  /** Repository root (absolute). */
  root?: string;
  branch?: string;
  upstream?: string;
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

export interface GitBranches {
  current?: string;
  local: string[];
  remote: string[];
}

const MAX_BUFFER = 64 * 1024 * 1024;

/** Run git in `cwd`; resolves stdout, rejects with git's own message (stderr) as an ApsError. */
export function runGit(cwd: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((done, fail) => {
    const child = execFile(
      'git',
      args,
      { cwd, maxBuffer: MAX_BUFFER, timeout: opts.timeoutMs ?? 120_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        if (!err) return done(stdout);
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        fail(
          new ApsError('ConfigurationError', missing ? 'Git is not installed' : (stderr || err.message).trim().split('\n').slice(-3).join(' '), {
            suggestions: missing ? ['Install Git from https://git-scm.com and restart TestPion.'] : gitHints(stderr),
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
  return u;
}

/** Plain-words next steps for git's usual complaints. */
function gitHints(stderr: string): string[] {
  const s = stderr.toLowerCase();
  if (/rejected|non-fast-forward|fetch first/.test(s)) return ['The remote has commits you don\'t have: pull first, then push again.'];
  if (/authentication|could not read username|permission denied|403/.test(s)) return ['Git could not sign in to the remote: sign in once with git in a terminal (or set up an SSH key), then try again.'];
  if (/not a git repository/.test(s)) return ['This workspace is not in a git repository yet: use Initialize, or clone one.'];
  if (/conflict/.test(s)) return ['Resolve the conflicts (Git panel), then commit.'];
  if (/would be overwritten|local changes/.test(s)) return ['Commit or discard your changes first.'];
  return [];
}

export async function gitVersion(): Promise<string | undefined> {
  try {
    return (await runGit(process.cwd(), ['--version'])).trim().replace(/^git version /, '');
  } catch {
    return undefined;
  }
}

/**
 * The repository root that holds `dir`, or undefined. Remembered for a few seconds: every operation asks, and
 * spawning git for it each time cost more than the operation itself. A `git init` (or deleting .git) is seen on
 * the next ask after that.
 */
const roots = new Map<string, { root: string | undefined; at: number }>();
export async function repoRoot(dir: string): Promise<string | undefined> {
  const known = roots.get(dir);
  if (known && Date.now() - known.at < 3000) return known.root;
  let root: string | undefined;
  try {
    root = resolve((await runGit(dir, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    root = undefined;
  }
  roots.set(dir, { root, at: Date.now() });
  return root;
}

/** Forget the remembered repository roots (after `git init`, a clone into the folder …). */
export const forgetRepoRoots = () => roots.clear();

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
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!;
    if (!line) continue;
    if (line.startsWith('# branch.head ')) st.branch = line.slice(14) === '(detached)' ? undefined : line.slice(14);
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
      st.files.push({ path: toWorkspacePath(repo, ws, path), state, staged: xy[0] !== '.', ...(from ? { from: toWorkspacePath(repo, ws, from) } : {}) });
    } else if (line.startsWith('u ')) {
      const f = line.split(' ');
      st.files.push({ path: toWorkspacePath(repo, ws, f.slice(10).join(' ')), state: 'conflicted', staged: false });
      st.conflicted = true;
    } else if (line.startsWith('? ')) st.files.push({ path: toWorkspacePath(repo, ws, line.slice(2)), state: 'untracked', staged: false });
  }
  st.files = st.files.filter((f) => !f.path.startsWith('..'));
  return st;
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

/** The unified diff of one file (working folder against HEAD, or the staged change). */
export async function gitDiff(ws: string, path: string, staged = false): Promise<string> {
  return runGit(ws, ['diff', '--no-color', ...(staged ? ['--cached'] : []), '--', path]);
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

export async function gitFetch(ws: string): Promise<void> {
  await runGit(ws, ['fetch', '--prune'], { timeoutMs: 300_000 });
}

export async function gitPull(ws: string, opts: { rebase?: boolean } = {}): Promise<{ conflicted: boolean }> {
  try {
    await runGit(ws, ['pull', opts.rebase ? '--rebase' : '--no-rebase'], { timeoutMs: 300_000 });
    return { conflicted: false };
  } catch (e) {
    const st = await gitStatus(ws);
    if (st.conflicted) return { conflicted: true };
    throw e;
  }
}

export async function gitPush(ws: string): Promise<void> {
  const st = await gitStatus(ws);
  // the first push of a branch sets where it goes
  await runGit(ws, ['push', ...(st.upstream ? [] : ['--set-upstream', 'origin', st.branch ?? 'HEAD'])], { timeoutMs: 300_000 });
}

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
  await runGit(process.cwd(), ['clone', ...(opts.branch ? ['--branch', assertGitRef(opts.branch)] : []), '--', assertRemoteUrl(url), dest], { timeoutMs: 600_000 });
}

/** The remote's URL (origin), if any: a link to open pull requests with. */
export async function gitRemoteUrl(ws: string): Promise<string | undefined> {
  try {
    return (await runGit(ws, ['remote', 'get-url', 'origin'])).trim() || undefined;
  } catch {
    return undefined;
  }
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

/**
 * Settle one conflicted file (GIT-302), and mark it resolved. A collection file is merged again request by request,
 * taking `side` only for the requests changed on both sides (every other change of both sides stays); any other file
 * is taken whole from that side.
 */
export async function gitResolve(ws: string, path: string, side: 'ours' | 'theirs', resolutions?: MergeResolutions): Promise<void> {
  const [base, ours, theirs] = await conflictStages(ws, path);
  const merged = MERGED_BY_MEANING.test(path)
    ? resolutions
      ? mergeWorkspaceTexts(base, ours, theirs, resolutions)
      : // the side kept on a conflict is the merge's "ours": swap the sides to prefer theirs
        side === 'ours'
        ? mergeWorkspaceTexts(base, ours, theirs)
        : mergeWorkspaceTexts(base, theirs, ours)
    : undefined;
  if (merged) writeFileSync(resolve(ws, path), merged.text);
  else await runGit(ws, ['checkout', `--${side}`, '--', path]);
  await runGit(ws, ['add', '--', path]);
}

/** The three versions of a conflicted file: the common ancestor, ours, theirs (empty when a side has none). */
async function conflictStages(ws: string, path: string): Promise<[string, string, string]> {
  const repo = await repoRoot(ws);
  const inRepo = repo ? toRepoPath(repo, ws, path) : path;
  const stage = (n: 1 | 2 | 3) => runGit(ws, ['show', `:${n}:${inRepo}`]).catch(() => '');
  return Promise.all([stage(1), stage(2), stage(3)]);
}

export interface ConflictDetail {
  path: string;
  /** A collection file: its conflicts one by one; any other file is resolved whole (mine or theirs). */
  collection: boolean;
  items: Array<Omit<MergeConflict, 'base' | 'ours' | 'theirs'> & { parts: Array<{ part: string; base?: string; ours?: string; theirs?: string; differs: boolean }> }>;
}

/** What conflicts in one file (GIT-302), part by part, for the side-by-side view. */
export async function gitConflictDetail(ws: string, path: string): Promise<ConflictDetail> {
  const [base, ours, theirs] = await conflictStages(ws, path);
  const merged = MERGED_BY_MEANING.test(path) ? mergeWorkspaceTexts(base, ours, theirs) : undefined;
  if (!merged) return { path, collection: false, items: [] };
  return {
    path,
    collection: true,
    items: merged.items.map(({ base: b, ours: o, theirs: th, ...rest }) => {
      const text = (v: unknown) => (v === undefined ? undefined : typeof v === 'string' ? v : JSON.stringify(v, null, 2));
      const isItem = rest.kind !== 'setting';
      const pb = isItem ? requestParts(b) : { Value: text(b) ?? '' };
      const po = isItem ? requestParts(o) : { Value: text(o) ?? '' };
      const pt = isItem ? requestParts(th) : { Value: text(th) ?? '' };
      const names = [...new Set([...Object.keys(pb), ...Object.keys(po), ...Object.keys(pt)])];
      return {
        ...rest,
        parts: names.map((part) => ({
          part,
          base: b === undefined ? undefined : (pb[part] ?? ''),
          ours: o === undefined ? undefined : (po[part] ?? ''),
          theirs: th === undefined ? undefined : (pt[part] ?? ''),
          differs: (o === undefined ? undefined : (po[part] ?? '')) !== (th === undefined ? undefined : (pt[part] ?? '')),
        })),
      };
    }),
  };
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
