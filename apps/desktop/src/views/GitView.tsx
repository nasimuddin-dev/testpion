import { useAiEnabled } from '../lib/use-ai-enabled';
import { ArrowDown, ArrowDownUp, ArrowUp, ExternalLink, FolderGit2, GitBranch, GitCommitHorizontal, GitPullRequest, Pencil, Plus, RefreshCw, Sparkles, Trash2, Users, Wrench } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { asError, call, on } from '../api';
import { useDoc } from '../lib/docs';
import { confirmAction, isPushRejected, promptText, toastError, useApp } from '../store';
import { useIntent } from '../hooks';
import type { ItemRef, KindId } from '@testpion/shared';
import { useEditorTabsStore } from '../components/EditorTabs';
import { Button, Callout, cx, Empty, Menu, PageHeader, SectionTitle, Spinner, Split, Textarea } from '../components/ui';
import { GitCommitPanel } from '../components/GitCommitPanel';
import { plural } from '../lib/format';
import { GitItemDiffDialog } from '../components/GitItemDiffDialog';
import { GitConflictDialog } from '../components/GitConflictDialog';
import { ChangeMark } from '../components/ChangeMark';
import { GitChanges } from '../components/GitChanges';
import { GitSecretsPanel, type StagedSecret } from '../components/GitSecretsPanel';
import { GitStash } from '../components/GitStash';
import { GitFixDialog } from '../components/GitFixDialog';
import { GitLargeFiles } from '../components/GitLargeFiles';
import { GitCodeownersDialog } from '../components/GitCodeownersDialog';
import { toastWithUndo } from '../lib/git-items';
import { gitSnapshot, refreshGit, useGitFull } from '../lib/git';

export interface GitFile {
  path: string;
  state: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  staged: boolean;
  /** Staged, and changed again since (an item staged alone leaves the file's other changes unstaged). */
  alsoUnstaged?: boolean;
  from?: string;
}

export interface GitStatusInfo {
  available: boolean;
  version?: string;
  repository: boolean;
  root?: string;
  branch?: string;
  upstream?: string;
  remote?: string;
  /** The workspace's folder inside the repository, when it is not the repository itself. */
  folder?: string;
  ahead: number;
  behind: number;
  files: GitFile[];
  conflicted: boolean;
}

export interface SemanticChange {
  file: string;
  kind: string;
  change: 'added' | 'removed' | 'changed' | 'renamed' | 'conflicted';
  title: string;
  details: string[];
  collectionId?: string;
  itemId?: string;
  itemKind?: string;
  /** What to open for it (core's refOfChange): the request, folder, environment, saved item, test or flow file … */
  ref?: ItemRef;
  /** The registry kind of the item (an MCP server, a prompt, a dataset …). */
  kindId?: KindId;
  /** The keys of the marks the change makes on the lists it is inside. */
  containers?: string[];
  /** The change is in the index: its file is staged, or just this item was staged alone. */
  staged?: boolean;
}

/** What Pull & push did (git.sync). */
interface GitSyncResult {
  state: 'pushed' | 'up-to-date' | 'pulled-nothing-to-push' | 'conflicts';
  pulled: number;
  pushed: number;
  files?: string[];
  setAside?: boolean;
  message: string;
}

/**
 * Before a pull: open requests with unsaved edits are named, and the user chooses to go on (their edits stay in the
 * tabs; a request the pull changes then asks which version to keep) or to save them first.
 */
async function okToPull(): Promise<boolean> {
  const dirty = Object.values(useEditorTabsStore.getState().byView)
    .flat()
    .filter((t) => t.dirty);
  if (!dirty.length) return true;
  return confirmAction({
    title: 'Unsaved changes',
    message: dirty.length === 1 ? `"${dirty[0]!.title}" has unsaved changes.` : `${dirty.length} open requests have unsaved changes.`,
    detail: 'Pull anyway? Your edits stay in their tabs; if the pull changes one of those requests, TestPion asks which version to keep. Or cancel and save them first (Ctrl+S).',
    confirmLabel: 'Pull anyway',
    tone: 'warning',
  });
}

/**
 * Git for the workspace (GIT-204 … GIT-209, GIT-304): what changed by meaning, commit (secrets checked first, an AI
 * written message on request), branches, pull and push, and a link to open a pull request.
 */
export function GitView() {
  // the status and the changes are the shared read (lib/git.ts) that the marks and the status bar use: this view asks git for the rest
  const { status, changes } = useGitFull();
  const [itemDiff, setItemDiff] = useState<{ file: string; itemId?: string }>();
  const [message, setMessage] = useState('');
  const aiOn = useAiEnabled();
  const [busy, setBusy] = useState<string>();
  const [secrets, setSecrets] = useState<StagedSecret[]>();
  const [branches, setBranches] = useState<{ current?: string; local: string[]; remote: string[] }>();
  const [log, setLog] = useState<Array<{ hash: string; short: string; author: string; date: string; subject: string }>>([]);
  // the commit picked in the history: what it changed shows on the right
  const [selectedCommit, setSelectedCommit] = useState<string>();
  const [diff, setDiff] = useState<{ path: string; text: string; line?: number }>();
  const [prUrl, setPrUrl] = useState<string>();
  // Fix git setup (release C): the dialog, what is still to fix (read when the view opens and after a fix), and CODEOWNERS
  const [fixOpen, setFixOpen] = useState(false);
  const [codeowners, setCodeowners] = useState(false);
  const [toFix, setToFix] = useState(0);
  const refreshToFix = useCallback(() => void call<{ steps: Array<{ state: string }> }>('git.fixPlan', {}).then((p) => setToFix(p.steps.filter((x) => x.state === 'todo').length), () => setToFix(0)), []);

  // the rest (branches, the log, the pull request link, a proposal) is read while the view is on screen: an event that
  // comes while it is hidden is answered when it shows again, not with git processes behind another view
  const { active } = useDoc();
  const activeRef = useRef(active);
  activeRef.current = active;
  const stale = useRef(false);
  const load = useCallback(async () => {
    if (!activeRef.current) return void (stale.current = true);
    stale.current = false;
    try {
      await refreshGit();
      if (!gitSnapshot().status?.repository) return;
      const [br, lg, pr] = await Promise.all([
        call<typeof branches>('git.branches'),
        call<typeof log>('git.log', { limit: 30 }),
        call<{ url?: string }>('git.pullRequestUrl').catch(() => ({ url: undefined })),
      ]);
      // a commit an AI agent proposed: its message, for the user to review
      const proposal = await call<{ message: string } | null>('git.proposal').catch(() => null);
      if (proposal?.message) setMessage((m) => m || proposal.message);
      setBranches(br);
      setLog(lg);
      setPrUrl(pr.url);
    } catch (e) {
      toastError(e);
    }
  }, []);

  useEffect(() => {
    void load();
    refreshToFix();
    // a quiet fetch as the view opens: the team's new commits show at once (git.remoteChanged reloads)
    void call('git.autoFetch').catch(() => undefined);
    // a save or an edit outside the app reaches this view through the shared read (lib/git: one read once things
    // settled), as the status below; only a git event (a commit, a pull, a branch switch) reads the rest at once
    const offs = [on('git.changed', () => void load()), on('git.remoteChanged', () => void load())];
    return () => offs.forEach((o) => o());
  }, [load, refreshToFix]);
  useEffect(() => {
    if (active && stale.current) void load();
  }, [active, load]);
  // the branch, its upstream or its distance to the remote changed in the shared status: the branches and the log follow
  const head = status ? `${status.branch ?? ''}|${status.upstream ?? ''}|${status.ahead}|${status.behind}|${status.repository}` : '';
  const seenHead = useRef<string>(undefined);
  useEffect(() => {
    if (seenHead.current !== undefined && seenHead.current !== head) void load();
    seenHead.current = head;
  }, [head, load]);
  // what a sync that stopped on conflicts said, shown with the Conflicts list
  const [syncNote, setSyncNote] = useState<string>();
  useEffect(() => {
    if (status && !status.conflicted) setSyncNote(undefined);
  }, [status]);

  const run = async (label: string, op: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    try {
      await op();
      if (done) useApp.getState().toast(done, 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(undefined);
      void load();
    }
  };

  /** Pull & push: pull the team's commits (merging collections request by request), then push; stops on conflicts. */
  const sync = async () => {
    if (!(await okToPull())) return;
    await run('sync', async () => {
      const r = await call<GitSyncResult>('git.sync');
      setSyncNote(r.state === 'conflicts' ? r.message : undefined);
      useApp.getState().toast(r.message, r.state === 'conflicts' ? 'warning' : 'success');
    });
  };
  const pull = async () => {
    if (!(await okToPull())) return;
    await run('pull', async () => {
      const r = await call<{ conflicted: boolean; setAside?: boolean; message?: string }>('git.pull', {});
      const words = r.conflicted ? 'Pulled with conflicts: resolve them below' : 'Up to date with the remote';
      useApp.getState().toast(r.message ? (r.conflicted ? r.message : `${words}. ${r.message}`) : words, r.conflicted ? 'warning' : 'success');
    });
  };
  const push = () =>
    void run('push', async () => {
      try {
        await call('git.push');
        useApp.getState().toast('Pushed', 'success');
      } catch (e) {
        // refused because the team pushed first: the toast offers Pull & push, and a fetch shows how many commits
        if (isPushRejected(e)) void call('git.autoFetch').then(() => load(), () => undefined);
        throw e;
      }
    });
  // "Pull & push" from a rejected push's toast (anywhere in the app)
  useIntent('git', (p?: { sync?: boolean; fix?: boolean; codeowners?: boolean; file?: string; line?: number }) => {
    if (p?.sync) void sync();
    if (p?.fix) setFixOpen(true);
    if (p?.codeowners) setCodeowners(true);
    // a changed file named elsewhere (an agent's git_status ref, a link): its line diff, open (at `line` when given)
    if (p?.file) {
      const path = p.file;
      const line = Number.isInteger(p.line) && p.line! > 0 ? p.line : undefined;
      void call<GitStatusInfo>('git.status').then((st) => {
        const f = st.files.find((x) => x.path === path);
        if (!f) return useApp.getState().toast(`${path} has no uncommitted changes`, 'info');
        return call<string>('git.diff', { path, staged: f.staged }).then((text) => setDiff({ path, text, line }));
      }, toastError);
    }
  });

  const files = status?.files ?? [];

  const commit = async (force = false) => {
    if (!message.trim()) return useApp.getState().toast('Write a commit message first (or let the assistant write one).', 'warning');
    setBusy('commit');
    try {
      // with nothing staged, commit every change of the workspace
      const paths = files.some((f) => f.staged) ? undefined : ['.'];
      const r = await call<{ committed: boolean; reason?: string; secrets: StagedSecret[]; commit?: { short: string } }>('git.commit', { message, paths, force });
      if (!r.committed) {
        if (r.reason === 'too-big') useApp.getState().toast('Not committed: a staged file is over 100 MB, which GitHub rejects. Track it with Git LFS or by reference (Big files, above).', 'error');
        return setSecrets(r.secrets);
      }
      setSecrets(undefined);
      setMessage('');
      useApp.getState().toast(`Committed ${r.commit?.short ?? ''}`, 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(undefined);
      void load();
    }
  };

  if (!status) return <Empty icon={<Spinner size={20} />} title="Reading git…" />;
  if (!status.available)
    return (
      <Empty icon={<FolderGit2 size={26} />} title="Git is not installed">
        TestPion uses the git installed on this computer (with your SSH keys and sign-in). Install it from git-scm.com, then restart TestPion.
      </Empty>
    );
  if (!status.repository)
    return (
      <Empty
        icon={<FolderGit2 size={26} />}
        title="This workspace is not in git yet"
        actions={[
          { label: 'Initialize repository', loading: busy === 'init', onClick: () => void run('init', () => call('git.init', {}), 'The workspace is now a git repository') },
          {
            label: 'Connect to a remote…',
            loading: busy === 'remote',
            onClick: async () => {
              const remote = await promptText('Connect to a git repository', { message: 'The URL of an empty repository (GitHub, GitLab, Bitbucket, Azure DevOps …). Push sends the workspace there.', placeholder: 'https://github.com/team/api-tests.git' });
              if (remote) await run('remote', () => call('git.init', { remote }), 'Connected: commit, then Push');
            },
          },
        ]}
      >
        Keep the collections, environments and tests in a git repository to review changes, share them with your team and run them in CI. Results, history and secrets stay on this computer.
      </Empty>
    );

  const staged = files.filter((f) => f.staged);
  const branchItems = [
    ...(branches?.local ?? []).filter((b) => b !== branches?.current).map((b) => ({ label: b, icon: <GitBranch size={14} />, onSelect: () => void run('switch', () => call('git.switch', { branch: b }), `Switched to ${b}`) })),
    ...(branches?.remote ?? [])
      .filter((r) => !(branches?.local ?? []).includes(r.replace(/^[^/]+\//, '')))
      .map((r) => ({ label: r, icon: <GitBranch size={14} />, onSelect: () => void run('switch', () => call('git.switch', { branch: r }), `Switched to ${r.replace(/^[^/]+\//, '')}`) })),
    {
      label: 'New branch…',
      icon: <Plus size={14} />,
      onSelect: async () => {
        const name = await promptText('New branch', { message: 'Your changes come along to the new branch.', placeholder: 'feature/payments-tests' });
        if (name) await run('switch', () => call('git.switch', { branch: name.trim(), create: true }), `On the new branch ${name.trim()}`);
      },
    },
    ...(branches?.current
      ? [
          {
            label: `Rename ${branches.current}…`,
            icon: <Pencil size={14} />,
            separator: true,
            onSelect: async () => {
              const to = await promptText('Rename branch', { message: 'Pushed already? The remote keeps the old name until you push the new one.', value: branches.current, okLabel: 'Rename' });
              if (to && to.trim() !== branches.current) await run('rename', () => call('git.renameBranch', { from: branches.current, to: to.trim() }), `Renamed to ${to.trim()}`);
            },
          },
        ]
      : []),
    ...((branches?.local ?? []).filter((b) => b !== branches?.current).length
      ? [
          {
            label: 'Delete a branch',
            icon: <Trash2 size={14} />,
            danger: true,
            onSelect: () => undefined,
            items: (branches?.local ?? [])
              .filter((b) => b !== branches?.current)
              .map((b) => ({
                label: b,
                icon: <GitBranch size={14} />,
                danger: true,
                onSelect: async () => {
                  if (!(await confirmAction({ title: `Delete ${b}`, message: `Delete the local branch ${b}?`, detail: 'Commits that are not merged anywhere else are lost; git refuses then, and TestPion asks again.', confirmLabel: 'Delete', danger: true }))) return;
                  try {
                    await call('git.deleteBranch', { branch: b });
                    useApp.getState().toast(`Deleted ${b}`, 'success');
                    void load();
                  } catch (e) {
                    if (!/not fully merged/i.test(asError(e).message)) return toastError(e);
                    if (await confirmAction({ title: `${b} is not merged`, message: `${b} has commits no other branch has. Delete it anyway?`, confirmLabel: 'Delete anyway', danger: true }))
                      await run('delete', () => call('git.deleteBranch', { branch: b, force: true }), `Deleted ${b}`);
                  }
                },
              })),
          },
        ]
      : []),
  ];

  const connectRemote = async () => {
    const remote = await promptText(status.remote ? 'Change the remote' : 'Connect to a remote', {
      message: status.remote ? 'The repository URL' : 'The URL of an empty repository on GitHub, GitLab, Bitbucket or Azure DevOps (create it there first). Push then sends your commits to it.',
      value: status.remote,
      placeholder: 'https://github.com/team/api-tests.git',
      okLabel: status.remote ? 'Save' : 'Connect',
    });
    if (remote) await run('remote', () => call('git.init', { remote }), status.ahead ? 'Connected: now Push sends your commits' : 'Connected: commit, then Push');
  };
  // the team pushed while there is work of yours to push: Push would be refused, so it becomes Pull & push
  const pullFirst = !!status.remote && status.behind > 0 && status.ahead > 0;
  const connectButton = (size?: 'sm') => (
    <Button size={size} variant="primary" icon={<ExternalLink size={size ? 12 : 13} />} loading={busy === 'remote'} onClick={() => void connectRemote()} title="Commits stay on this computer until the workspace has a remote: a repository on GitHub, GitLab, Bitbucket or Azure DevOps">
      Connect to a remote…
    </Button>
  );
  return (
    <div className="h-full flex flex-col min-h-0">
      <PageHeader
        icon={<FolderGit2 size={18} />}
        title="Git"
        subtitle={
          <span>
            {status.remote ?? 'No remote yet'}
            {/* a workspace that is a folder of a bigger repository (the examples inside a checkout): say so, and whose remote this is */}
            {status.folder && (
              <>
                {' '}· this workspace is the folder <code className="font-mono text-fg">{status.folder}</code> of the repository at <code className="font-mono text-fg">{status.root}</code>; the changes and the history shown are this folder's
              </>
            )}
          </span>
        }
        actions={
          <>
            <Menu trigger={<Button icon={<GitBranch size={13} />}>{status.branch ?? 'detached'}</Button>} items={branchItems} />
            {status.remote ? (
              <>
                <Button icon={<RefreshCw size={13} />} loading={busy === 'fetch'} onClick={() => void run('fetch', () => call('git.fetch'))} title="Fetch: see what the remote has">
                  Fetch
                </Button>
                <Button icon={<ArrowDown size={13} />} loading={busy === 'pull'} onClick={() => void pull()} title="Pull: bring in your team's commits">
                  Pull{status.behind ? ` ${status.behind}` : ''}
                </Button>
                {pullFirst ? (
                  <Button icon={<ArrowDownUp size={13} />} variant="primary" loading={busy === 'sync'} onClick={() => void sync()} title={`Pull & push: bring in your team's ${plural(status.behind, 'commit')} (requests merge one by one), then send your ${plural(status.ahead, 'commit')}`}>
                    Pull & push
                  </Button>
                ) : (
                  <Button icon={<ArrowUp size={13} />} variant={status.ahead ? 'primary' : undefined} loading={busy === 'push'} onClick={push} title={status.ahead ? `Push: send your ${plural(status.ahead, 'commit')} to ${status.remote}` : 'Push: send your commits'}>
                    Push{status.ahead ? ` ${status.ahead}` : ''}
                  </Button>
                )}
              </>
            ) : (
              connectButton()
            )}
            {prUrl && (
              <Button icon={<GitPullRequest size={13} />} onClick={() => void call('app.openExternal', { url: prUrl }).catch(() => window.open(prUrl))} title="Open a pull request for this branch on the remote's website">
                Pull request
              </Button>
            )}
          </>
        }
        menu={[
          {
            label: status.remote ? 'Change remote…' : 'Connect to a remote…',
            icon: <ExternalLink size={14} />,
            onSelect: () => void connectRemote(),
          },
          { label: 'Fix git setup…', icon: <Wrench size={14} />, onSelect: () => setFixOpen(true) },
          { label: 'Create CODEOWNERS…', icon: <Users size={14} />, onSelect: () => setCodeowners(true) },
        ]}
      />
      <Split id="git-main" initial={58} min={30} collapsedSecond={!selectedCommit}>
      <div className="h-full min-h-0 overflow-auto p-4 grid gap-5 content-start max-w-5xl w-full">
        {status.conflicted && <ConflictPanel files={files.filter((f) => f.state === 'conflicted')} note={syncNote} onDone={() => void load()} />}

        {toFix > 0 && (
          <Callout
            data-fix-banner=""
            action={
              <Button size="sm" variant="primary" icon={<Wrench size={12} />} onClick={() => setFixOpen(true)}>
                Fix git setup…
              </Button>
            }
          >
            Git setup is not complete: {plural(toFix, 'thing')} to fix. The fix keeps secrets and machine-only files out of git, lets two people edit the same collection and merge cleanly, and shows changes by request instead of by line. You see what changes before anything is written.
          </Callout>
        )}

        <GitChanges files={files} changes={changes} run={run} onCompare={(file, itemId) => setItemDiff({ file, itemId })} diff={diff} setDiff={setDiff} />

        <GitLargeFiles afterChange={() => void load()} />

        <GitStash changed={files.length > 0} afterChange={() => void load()} />

        <section className="grid gap-2">
          <SectionTitle>Commit {staged.length ? <span className="text-muted font-normal">· {staged.length} staged</span> : files.length ? <span className="text-muted font-normal">· all changes</span> : null}</SectionTitle>
          <Textarea className="field min-h-20 font-mono text-xs" aria-label="Commit message" placeholder="What changed and why (e.g. Add payment tests)" value={message} onChange={(e) => setMessage(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="primary" icon={<GitCommitHorizontal size={13} />} loading={busy === 'commit'} disabled={!files.length} onClick={() => void commit()}>
              Commit
            </Button>
            {aiOn && (
              <Button
                icon={<Sparkles size={13} />}
                loading={busy === 'suggest'}
                disabled={!files.length}
                title="The AI assistant writes a message from what changed (no secret values are sent)"
                onClick={() => void run('suggest', async () => setMessage((await call<{ message: string }>('git.suggestMessage')).message))}
              >
                Write message
              </Button>
            )}
          </div>
          {secrets && secrets.length > 0 && <GitSecretsPanel findings={secrets} onChange={setSecrets} onCommitAnyway={() => void commit(true)} />}
        </section>

        {status.remote && status.behind > 0 && (status.ahead > 0 || files.length > 0) ? (
          // the team pushed: pull first (Pull & push does both), before a push is refused
          <Callout
            data-pull-first=""
            tone="warn"
            action={
              <span className="flex gap-1">
                {status.ahead > 0 && (
                  <Button size="sm" variant="primary" icon={<ArrowDownUp size={12} />} loading={busy === 'sync'} onClick={() => void sync()}>
                    Pull & push
                  </Button>
                )}
                <Button size="sm" icon={<ArrowDown size={12} />} loading={busy === 'pull'} onClick={() => void pull()}>
                  Pull
                </Button>
              </span>
            }
          >
            Your team pushed {plural(status.behind, 'commit')}. Pull before pushing.
          </Callout>
        ) : log.length > 0 && (!status.remote || status.ahead > 0) && (
          // a commit is on this computer only until it is pushed: the next step, where the commit was made
          <Callout
            data-push-next=""
            action={
              status.remote ? (
                <Button size="sm" variant="primary" icon={<ArrowUp size={12} />} loading={busy === 'push'} onClick={push}>
                  Push {status.ahead}
                </Button>
              ) : (
                connectButton('sm')
              )
            }
          >
            {status.remote
              ? `${plural(status.ahead, 'commit')} not pushed yet: your team and CI do not have ${status.ahead === 1 ? 'it' : 'them'}.`
              : 'Committed on this computer only. Connect a remote (GitHub, GitLab, Bitbucket, Azure DevOps) to share your commits and run them in CI.'}
          </Callout>
        )}

        <section>
          <SectionTitle>History</SectionTitle>
          {!log.length ? (
            <div className="text-sm text-muted py-2">No commits yet.</div>
          ) : (
            <ul className="grid gap-0.5 text-sm" aria-label="Commits">
              {log.map((c) => (
                <li key={c.hash}>
                  <button
                    className={cx('w-full flex items-center gap-2 py-0.5 px-1 rounded text-left hover:bg-hover', selectedCommit === c.hash && 'bg-accent/10')}
                    aria-current={selectedCommit === c.hash || undefined}
                    title="What this commit changed"
                    onClick={() => setSelectedCommit(selectedCommit === c.hash ? undefined : c.hash)}
                  >
                    <span className="font-mono text-xs text-muted">{c.short}</span>
                    <span className="truncate">{c.subject}</span>
                    <span className="ml-auto text-xs text-muted whitespace-nowrap">
                      {c.author} · {new Date(c.date).toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className="text-xs text-muted">git {status.version} · sign-in uses your git setup (SSH keys or the credential manager)</div>
      </div>
      <div className="h-full min-h-0">{selectedCommit && <GitCommitPanel hash={selectedCommit} onClose={() => setSelectedCommit(undefined)} />}</div>
      </Split>
      {fixOpen && (
        <GitFixDialog
          onClose={() => {
            setFixOpen(false);
            refreshToFix();
          }}
          onDone={() => {
            void load();
            refreshToFix();
          }}
        />
      )}
      {codeowners && <GitCodeownersDialog onClose={() => setCodeowners(false)} onDone={() => void load()} />}
      {itemDiff && <GitItemDiffDialog file={itemDiff.file} itemId={itemDiff.itemId} onClose={() => setItemDiff(undefined)} />}
    </div>
  );
}

/** Files changed on both sides after a pull (GIT-302): keep yours, take theirs, or open the file to merge by hand. */
function ConflictPanel({ files, note, onDone }: { files: GitFile[]; /** What a Pull & push that stopped here said. */ note?: string; onDone(): void }) {
  const [busy, setBusy] = useState<string>();
  const [comparing, setComparing] = useState<string>();
  const pick = async (path: string, side: 'ours' | 'theirs') => {
    // a whole file in one click replaces every clash in it: say so first, and the toast has Undo
    const mine = side === 'ours';
    const ok = await confirmAction({
      title: mine ? 'Keep mine' : 'Keep theirs',
      message: `${mine ? 'Keep your version' : "Take your teammate's version"} of every clash in ${path}?`,
      detail: `${mine ? 'What they changed in those places is dropped.' : 'What you changed in those places is dropped.'} Changes that did not clash stay, from both sides. Use Resolve… to choose one by one. You can undo this right after.`,
      confirmLabel: mine ? 'Keep mine' : 'Keep theirs',
    });
    if (!ok) return;
    setBusy(path);
    try {
      const r = await call<{ undoId?: string }>('git.resolve', { path, side });
      toastWithUndo(`${path} resolved: ${mine ? 'kept as mine' : 'taken from theirs'}`, r.undoId);
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Callout tone="warn" block as="section" role="alert" className="rounded-md p-3 grid gap-2">
      <SectionTitle>Conflicts · changed by you and by someone else</SectionTitle>
      {note && (
        <div className="text-sm" data-sync-note="">
          {note}
        </div>
      )}
      <ul className="grid gap-1">
        {files.map((f) => (
          <li key={f.path} className="flex items-center gap-2 text-sm">
            <ChangeMark change="conflicted" />
            <span className="font-mono text-xs truncate">{f.path}</span>
            <span className="ml-auto flex gap-1">
              <Button size="sm" variant="primary" onClick={() => setComparing(f.path)} title="See what clashes (items, fields or lines) and choose: keep mine, keep theirs or edit">
                Resolve…
              </Button>
              <Button size="sm" loading={busy === f.path} onClick={() => void pick(f.path, 'ours')}>
                Keep mine
              </Button>
              <Button size="sm" loading={busy === f.path} onClick={() => void pick(f.path, 'theirs')}>
                Keep theirs
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex gap-2 items-center">
        <Button size="sm" variant="ghost" onClick={() => void call('git.abortMerge').then(onDone, toastError)}>
          Cancel the pull
        </Button>
        <span className="text-xs text-muted">In a file merged by meaning, only what both sides changed differently takes the side you choose; every other change of both sides stays. When every file is resolved, commit to finish the pull.</span>
      </div>
      {comparing && <GitConflictDialog path={comparing} onClose={() => setComparing(undefined)} onResolved={() => (setComparing(undefined), onDone())} />}
    </Callout>
  );
}
