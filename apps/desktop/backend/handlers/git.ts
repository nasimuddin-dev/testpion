/** RPC handlers: git for the open workspace (GIT-201 … GIT-304, planning/git-integration.md). Uses the system git. */
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  ApsError,
  changesMarkdown,
  describeGitChanges,
  describeRevChanges,
  runGit,
  findCollectionItem,
  findCommittableSecrets,
  fixCommittableSecrets,
  type SecretFinding,
  gitBranches,
  gitClone,
  gitCommit,
  gitDefaultBranch,
  gitDeleteBranch,
  gitRenameBranch,
  gitAbortMerge,
  describeItemDiff,
  gitConflictDetail,
  gitResolve,
  gitSetupMergeDriver,
  gitDiff,
  gitDiscard,
  gitFetch,
  gitInit,
  gitItemHistory,
  gitLog,
  gitPull,
  gitPush,
  gitRemoteUrl,
  gitShow,
  gitStage,
  gitStatus,
  gitSwitch,
  gitSync,
  gitUnstage,
  gitVersion,
  makeGitReady,
  pullRequestUrl,
  replaceCollectionItem,
  type Collection,
  type GitFile,
  gitCommitDetail,
  gitCommitDiff,
  atomicWrite,
  isWorkspaceDir,
} from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

export function gitHandlers(be: Backend): Handlers {
  const ws = () => be.ws.root;
  /**
   * After git rewrote files (discard, switch, pull, restore): reload and tell the views, without the "changed
   * outside TestPion" notice (the user asked for it).
   */
  const rewritten = async <T>(op: () => Promise<T>): Promise<T> => {
    be.lastOwnChange = Date.now();
    try {
      return await op();
    } finally {
      be.lastOwnChange = Date.now();
      be.ws.reloadWorkspaceFile();
      be.host.emit('data.changed', { method: 'git' });
      be.host.emit('git.changed', {});
    }
  };
  const mergeDriverChecked = new Set<string>();
  const proposalFile = () => join(ws(), '.local', 'git-proposal.json');
  const changed = <T>(r: T): T => (be.host.emit('git.changed', {}), r);

  /** Register a cloned or connected workspace folder in the workspace list and open it. */
  const openFolder = (dir: string) => {
    const s = be.manager.loadSettings();
    if (!s.workspacePaths.includes(dir)) be.settings = be.manager.saveSettings({ ...s, workspacePaths: [...s.workspacePaths, dir] });
    be.openStore(dir);
    be.host.emit('data.changed', { method: 'ws.open' });
  };

  /** The workspace folders in a cloned repository: the root, or folders one or two levels down. */
  const findWorkspaces = (dir: string, depth = 2): string[] => {
    // a TestPion workspace.json only (an Nx / Angular monorepo has one too)
    if (isWorkspaceDir(dir)) return [dir];
    if (depth === 0) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .flatMap((d) => findWorkspaces(join(dir, d.name), depth - 1));
  };

  /** Collection files merge request by request (GIT-301): this app is the merge driver (`--merge-driver`), else the CLI. */
  const setupMergeDriver = async () => {
    const self = be.host.mcpCommand;
    const q = (a: string) => `"${a.split('\\').join('/')}"`;
    const command = self ? [self.command, ...self.args].map(q).join(' ') + ' --merge-driver' : 'testpion merge-driver';
    await gitSetupMergeDriver(ws(), command).catch((e) => be.appLog('warn', `git merge driver not set up: ${String(e)}`));
  };

  return {
    /** Branch, ahead / behind, changed files; `available: false` when git is not installed. */
    'git.status': async () => {
      const version = await gitVersion();
      if (!version) return { available: false, repository: false, ahead: 0, behind: 0, files: [], conflicted: false };
      const st = await gitStatus(ws());
      const remote = st.repository ? await gitRemoteUrl(ws()) : undefined;
      if (st.repository && !mergeDriverChecked.has(ws())) {
        // once per workspace and start: a repository cloned or made elsewhere gets the merge driver too
        mergeDriverChecked.add(ws());
        await setupMergeDriver();
      }
      return { available: true, version, remote, ...st };
    },
    /** The changes said by what they mean (requests, environments …), for the Git panel and the commit message. */
    'git.changes': async () => {
      const st = await be.handlers['git.status']!({});
      const files = (st as { files: GitFile[] }).files;
      return { ...(st as object), files, changes: files.length ? await describeGitChanges(ws(), files) : [] };
    },
    'git.diff': ({ path, staged }: { path: string; staged?: boolean }) => gitDiff(ws(), path, staged),
    /** A file as it is in a commit (default HEAD). */
    'git.show': ({ path, rev }: { path: string; rev?: string }) => gitShow(ws(), path, rev),
    'git.stage': async ({ paths }: { paths: string[] }) => changed(await gitStage(ws(), paths)),
    'git.unstage': async ({ paths }: { paths: string[] }) => changed(await gitUnstage(ws(), paths)),
    'git.discard': ({ files }: { files: Array<Pick<GitFile, 'path' | 'state'>> }) => rewritten(() => gitDiscard(ws(), files)),
    /** Secrets typed into the workspace that a commit would publish (GIT-104). */
    'git.check': () => findCommittableSecrets(be.ws),
    /**
     * Fix findings in one click: typed values become {{variables}} whose values live as secret variables of the given
     * environment (in the OS secret store); plain environment / workspace / collection variables become secret.
     */
    'git.fixSecrets': async ({ findings, environmentId }: { findings: SecretFinding[]; environmentId: string }) => {
      be.lastOwnChange = Date.now();
      const r = await fixCommittableSecrets(be.ws, be.secrets, findings, { environmentId });
      be.host.emit('data.changed', { method: 'col.save' });
      return changed(r);
    },
    /**
     * Commit (GIT-206). The secret guard runs first: with findings nothing is committed and they are returned, unless
     * `force` (the user read them and chose to go on).
     */
    'git.commit': async ({ message, paths, amend, force }: { message: string; paths?: string[]; amend?: boolean; force?: boolean }) => {
      const secrets = findCommittableSecrets(be.ws);
      if (secrets.length && !force) return { committed: false, secrets };
      const commit = await gitCommit(ws(), message, { paths, amend });
      rmSync(proposalFile(), { force: true });
      return changed({ committed: true, commit, secrets: [] });
    },
    /** A commit an AI agent proposed (MCP git_propose_commit): its message fills the commit box for a person to review. */
    'git.proposal': () => {
      try {
        return JSON.parse(readFileSync(proposalFile(), 'utf8')) as { message: string; at: string; files: string[] };
      } catch {
        return null;
      }
    },
    /** A commit message written by the AI assistant from the changes' meaning (never from secret values). */
    'git.suggestMessage': async () => {
      const st = await gitStatus(ws());
      const staged = st.files.some((f) => f.staged) ? st.files.filter((f) => f.staged) : st.files;
      if (!staged.length) throw new ApsError('ValidationError', 'There is nothing to commit');
      const changes = await describeGitChanges(ws(), staged);
      const r = await be.assistant({ task: 'write-commit-message', context: { workspace: be.ws.workspace.name, changes: changes.slice(0, 200) } });
      return { message: r.text.trim().replace(/^```\w*\n?|```$/g, '').trim(), model: `${r.provider}/${r.model}` };
    },
    /** Commits, newest first: of the workspace, of a file, or of one request (its collection's file). */
    /** A picked commit: its message and the files it changed in the workspace; and one file's diff in it. */
    'git.commitDetail': ({ hash }: { hash: string }) => gitCommitDetail(ws(), hash),
    'git.commitDiff': ({ hash, path }: { hash: string; path: string }) => gitCommitDiff(ws(), hash, path),
    'git.log': ({ path, collectionId, limit }: { path?: string; collectionId?: string; limit?: number }) =>
      gitLog(ws(), { path: path ?? (collectionId ? be.ws.collectionFileOf(collectionId) : undefined), limit }),
    /**
     * History of one request (GIT-209): the commits that changed it, each with the request as it was then. Commits
     * that touched the collection but not this request are left out.
     */
    'git.itemHistory': ({ collectionId, itemId, limit }: { collectionId: string; itemId: string; limit?: number }) => gitItemHistory(ws(), be.ws.collectionFileOf(collectionId), itemId, limit),
    /**
     * The versions of a request, a whole collection or an environment in git (GIT-209): the commits that changed it,
     * newest first, and the file they are in (git.itemDiff compares a version with now).
     */
    'git.history': async ({ collectionId, environmentId, itemId, limit = 30 }: { collectionId?: string; environmentId?: string; itemId?: string; limit?: number }) => {
      const file = collectionId ? be.ws.collectionFileOf(collectionId) : environmentId ? be.ws.environmentFileOf(environmentId) : undefined;
      if (!file) throw new ApsError('ValidationError', 'A collection or an environment');
      const commits = itemId && collectionId ? (await gitItemHistory(ws(), file, itemId, limit)).map((v) => v.commit) : await gitLog(ws(), { path: file, limit });
      return { file, itemId, versions: commits };
    },
    /** Put a whole collection or environment back as it was in a commit (a change to commit; history keeps the current one). */
    'git.restoreFile': async ({ collectionId, environmentId, rev }: { collectionId?: string; environmentId?: string; rev: string }) => {
      const file = collectionId ? be.ws.collectionFileOf(collectionId) : environmentId ? be.ws.environmentFileOf(environmentId) : undefined;
      if (!file) throw new ApsError('ValidationError', 'A collection or an environment');
      const text = await gitShow(ws(), file, rev);
      if (text === undefined) throw new ApsError('ValidationError', `${file} is not in commit ${rev.slice(0, 7)}`);
      be.lastOwnChange = Date.now();
      atomicWrite(be.ws.safePath(file), text);
      be.host.emit('data.changed', { method: collectionId ? 'col.save' : 'env.save' });
      return { file, rev };
    },
    /** Put one request back as it was in a commit (the rest of the collection is unchanged). */
    'git.restoreItem': async ({ collectionId, itemId, rev }: { collectionId: string; itemId: string; rev: string }) => {
      const text = await gitShow(ws(), be.ws.collectionFileOf(collectionId), rev);
      const old = text ? findCollectionItem(JSON.parse(text) as Collection, itemId) : undefined;
      if (!old) throw new ApsError('ValidationError', `The request is not in commit ${rev.slice(0, 7)}`);
      const current = be.ws.getCollection(collectionId);
      const next = replaceCollectionItem(current, itemId, old) ?? { ...current, items: [...current.items, old] };
      be.lastOwnChange = Date.now();
      const saved = be.ws.saveCollection(next as Collection);
      be.host.emit('data.changed', { method: 'col.save' });
      return changed({ collection: saved.id, item: old });
    },
    'git.branches': () => gitBranches(ws()),
    'git.switch': ({ branch, create, from }: { branch: string; create?: boolean; from?: string }) => rewritten(() => gitSwitch(ws(), branch, { create, from })),
    'git.deleteBranch': async ({ branch, force }: { branch: string; force?: boolean }) => changed(await gitDeleteBranch(ws(), branch, force)),
    'git.renameBranch': async ({ from, to }: { from: string; to: string }) => changed(await gitRenameBranch(ws(), from, to)),
    'git.fetch': async () => changed(await be.gitAutoFetch.exclusive(() => gitFetch(ws()))),
    /**
     * A quiet fetch now (the Git view calls it when it opens; the backend also does it every few minutes): never asks
     * for a sign-in, skipped while a pull or push runs; `git.remoteChanged` tells the views when `behind` changed.
     */
    'git.autoFetch': () => be.gitAutoFetch.fetchNow(),
    /**
     * Pull (GIT-208): `conflicted` when it stopped on conflicts (then the conflict screen). Uncommitted changes git
     * would refuse to pull over are set aside and put back (`setAside`, `message`).
     */
    'git.pull': ({ rebase }: { rebase?: boolean }) => be.gitAutoFetch.exclusive(() => rewritten(() => gitPull(ws(), { rebase }))),
    'git.push': async () => changed(await be.gitAutoFetch.exclusive(() => gitPush(ws()))),
    /**
     * Pull & push in one step: fetch, pull with a merge when the remote has new commits, push; stops on conflicts
     * (`state: 'conflicts'`, the files) without pushing. A push refused meanwhile is retried once after another pull.
     */
    'git.sync': () => be.gitAutoFetch.exclusive(() => rewritten(() => gitSync(ws()))),
    /** Put the workspace under git: init (when not in a repository), the git files, the merge driver, optionally a remote. */
    'git.init': async ({ remote }: { remote?: string }) => {
      await gitInit(ws(), { remote });
      const ready = makeGitReady(be.ws);
      await setupMergeDriver();
      return changed({ ...ready, inRepository: true });
    },
    /** Settle a conflicted file with one side (GIT-302). */
    /** One changed item side by side (GIT-205): a request, folder, collection settings or environment, last commit vs now. */
    'git.itemDiff': ({ file, itemId, rev }: { file: string; itemId?: string; rev?: string }) => describeItemDiff(ws(), file, itemId, rev),
    /** What conflicts in one file, request by request and part by part (GIT-302's side-by-side view). */
    'git.conflictDetail': ({ path }: { path: string }) => gitConflictDetail(ws(), path),
    /** Settle a conflicted file: one side for every conflict, or a choice per conflict (`resolutions`, keys from git.conflictDetail). */
    'git.resolve': ({ path, side, resolutions }: { path: string; side?: 'ours' | 'theirs'; resolutions?: Record<string, 'ours' | 'theirs'> }) =>
      rewritten(() => gitResolve(ws(), path, side ?? 'ours', resolutions)),
    /** Give up a pull that stopped on conflicts. */
    'git.abortMerge': () => rewritten(() => gitAbortMerge(ws())),
    /**
     * Clone a repository (GIT-202) into `dest` (or a folder the user picks, named after the repository) and open
     * the TestPion workspace in it. With several, the list comes back for the user to choose (git.openFolder).
     */
    'git.clone': async ({ url, dest, branch }: { url: string; dest?: string; branch?: string }) => {
      if (!url?.trim()) throw new ApsError('ValidationError', 'Enter the repository URL');
      let target = dest;
      if (!target && be.host.openDialog) {
        const parent = await be.host.openDialog({ directory: true });
        if (!parent) return null;
        target = join(parent, basename(url.trim().replace(/\/+$/, '')).replace(/\.git$/, '') || 'repository');
      }
      if (!target) throw new ApsError('ValidationError', 'Choose where to clone the repository');
      await gitClone(url.trim(), target, { branch });
      const found = findWorkspaces(target);
      if (found.length === 1) openFolder(found[0]!);
      return { path: target, workspaces: found, opened: found.length === 1 ? found[0] : undefined };
    },
    /** Open a workspace folder of a cloned repository. */
    'git.openFolder': ({ path }: { path: string }) => {
      if (!isWorkspaceDir(path)) throw new ApsError('ConfigurationError', `${path} is not a TestPion workspace`);
      openFolder(path);
      return { opened: path };
    },
    /** A link to open a pull request for the current branch (GIT-304). */
    'git.pullRequestUrl': async () => {
      const st = await gitStatus(ws());
      const remote = await gitRemoteUrl(ws());
      if (!remote || !st.branch) return { url: undefined };
      const base = await gitDefaultBranch(ws());
      if (st.branch === base) return { url: undefined, base, branch: st.branch };
      // the description: what the branch changes in the workspace, by meaning
      let body: string | undefined;
      try {
        const from = (await runGit(ws(), ['merge-base', `origin/${base}`, 'HEAD'])).trim();
        body = `Changes to the TestPion workspace:\n\n${changesMarkdown(await describeRevChanges(ws(), from, 'HEAD'))}`;
      } catch {
        /* no remote base yet: no description */
      }
      return { url: pullRequestUrl(remote, st.branch, base, body), base, branch: st.branch };
    },
  };
}
