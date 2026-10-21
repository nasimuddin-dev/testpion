/** RPC handlers: git for the open workspace (GIT-201 … GIT-304, planning/git-integration.md). Uses the system git. */
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  ApsError,
  changesMarkdown,
  describeGitChanges,
  describeRevChanges,
  runGit,
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
  gitLog,
  gitPull,
  gitPush,
  gitRemoteUrl,
  gitStage,
  gitStatus,
  gitSwitch,
  gitSync,
  gitUnstage,
  scanStagedSecrets,
  commitVerdict,
  fixStagedFiles,
  type StagedSecret,
  gitVersion,
  makeGitReady,
  pullRequestUrl,
  type GitFile,
  gitCommitDetail,
  gitCommitDiff,
  isWorkspaceDir,
} from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import { journalFiles, journalResolve, gitHelpers } from './git-undoable.js';

export function gitHandlers(be: Backend): Handlers {
  const { ws, rewritten, changed } = gitHelpers(be);
  const mergeDriverChecked = new Set<string>();
  const proposalFile = () => join(ws(), '.local', 'git-proposal.json');

  /** Register a cloned or connected workspace folder in the workspace list and open it. */
  const openFolder = (dir: string) => {
    be.settings = be.manager.rememberWorkspacePath(dir);
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
    'git.stage': async ({ paths }: { paths: string[] }) => changed(await gitStage(ws(), paths)),
    'git.unstage': async ({ paths }: { paths: string[] }) => changed(await gitUnstage(ws(), paths)),
    /** Throw away changes to files; the answer's `undoId` puts them back (git.undo), the new files that were deleted too. */
    'git.discard': async ({ files }: { files: Array<Pick<GitFile, 'path' | 'state'>> }) => {
      const undoId = journalFiles(ws(), 'discard', files.length === 1 ? `Discard changes to ${files[0]!.path}` : `Discard changes to ${files.length} files`, files.map((f) => f.path));
      await rewritten(() => gitDiscard(ws(), files));
      return { undoId };
    },
    /** Secrets typed into the workspace that a commit would publish (GIT-104). */
    'git.check': () => findCommittableSecrets(be.ws),
    /**
     * Fix findings in one click: typed values become {{variables}} whose values live as secret variables of the given
     * environment (in the OS secret store); plain environment / workspace / collection variables become secret.
     */
    'git.fixSecrets': async ({ findings, environmentId }: { findings: SecretFinding[]; environmentId: string }) => {
      const r = await fixCommittableSecrets(be.ws, be.secrets, findings, { environmentId });
      be.host.emit('data.changed', { method: 'col.save' });
      return changed(r);
    },
    /**
     * Commit (GIT-206). What is staged (the paths are staged first) is scanned for secrets, blob by blob, with the
     * detector the exports use: a high-confidence secret refuses the commit for good (fix it or unstage it); a probable one
     * needs `force` (the user read the list and confirmed). A refused commit leaves the index as it was.
     */
    'git.commit': async ({ message, paths, amend, force }: { message: string; paths?: string[]; amend?: boolean; force?: boolean }) => {
      const before = new Set((await gitStatus(ws())).files.filter((f) => f.staged).map((f) => f.path));
      if (paths?.length) await gitStage(ws(), paths);
      const scan = await scanStagedSecrets(ws());
      const verdict = commitVerdict(scan, !!force);
      if (!verdict.allowed) {
        // staged only for the scan: put the index back
        if (paths?.length) {
          const now = (await gitStatus(ws())).files.filter((f) => f.staged && !before.has(f.path)).map((f) => f.path);
          await gitUnstage(ws(), now);
        }
        return { committed: false, reason: verdict.reason, secrets: [...scan.blocking, ...scan.confirm], large: scan.large };
      }
      const commit = await gitCommit(ws(), message, { amend });
      rmSync(proposalFile(), { force: true });
      return changed({ committed: true, commit, secrets: [] });
    },
    /** What a commit of the staged files would publish: the secret scan of the index. */
    'git.stagedScan': () => scanStagedSecrets(ws()),
    /**
     * Fix what the staged scan found, in one click, where the app can (collections, environments, workspace variables:
     * the value becomes a secret variable of the environment); the files that were staged are staged again with the fix.
     */
    'git.fixStaged': async ({ findings, environmentId }: { findings: StagedSecret[]; environmentId: string }) => {
      const files = new Set(findings.map((f) => f.file));
      const staged = new Set((await gitStatus(ws())).files.filter((f) => f.staged).map((f) => f.path));
      // collections, environments and workspace variables are saved through the store; every other kind (MCP servers, providers,
      // library items, tests, API definitions …) is rewritten by the same reading as the scan (fixStagedFiles)
      const todo = findCommittableSecrets(be.ws).filter((f) => files.has(f.file));
      const r = await fixCommittableSecrets(be.ws, be.secrets, todo, { environmentId });
      const more = await fixStagedFiles(be.ws, be.secrets, { files: [...files], environmentId });
      await gitStage(ws(), [...files].filter((f) => staged.has(f)));
      be.adoptDiskState();
      be.host.emit('data.changed', { method: 'git' });
      return changed({ ...r, fixed: [...r.fixed, ...more.fixed], variables: [...new Set([...r.variables, ...more.variables])], skipped: [...r.skipped, ...more.skipped.map((k) => ({ finding: { file: k.file }, reason: k.reason }))], undoId: more.undoId, scan: await scanStagedSecrets(ws()) });
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
    /** A picked commit: its message and the files it changed in the workspace; and one file's diff in it. */
    'git.commitDetail': ({ hash }: { hash: string }) => gitCommitDetail(ws(), hash),
    'git.commitDiff': ({ hash, path }: { hash: string; path: string }) => gitCommitDiff(ws(), hash, path),
    /** Commits, newest first: of the workspace or of one file. */
    'git.log': ({ path, collectionId, limit }: { path?: string; collectionId?: string; limit?: number }) =>
      gitLog(ws(), { path: path ?? (collectionId ? be.ws.collectionFileOf(collectionId) : undefined), limit }),
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
    'git.resolve': async ({ path, side, resolutions }: { path: string; side?: 'ours' | 'theirs'; resolutions?: Record<string, 'ours' | 'theirs'> }) => {
      const undoId = await journalResolve(ws(), path);
      await rewritten(() => gitResolve(ws(), path, side ?? 'ours', resolutions));
      return { undoId };
    },
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
