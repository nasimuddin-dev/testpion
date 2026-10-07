import { ArrowDown, ArrowUp, Check, Columns2, ExternalLink, FolderGit2, GitBranch, GitCommitHorizontal, GitPullRequest, KeyRound, Pencil, Minus, Plus, RefreshCw, RotateCcw, ShieldAlert, Sparkles, Trash2, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { asError, call, on } from '../api';
import { confirmAction, promptText, useApp } from '../store';
import { Badge, Button, cx, Empty, LinkButton, Menu, MoreMenu, PageHeader, SectionTitle, Spinner } from '../components/ui';
import { GitItemDiffDialog } from '../components/GitItemDiffDialog';
import { GitConflictDialog } from '../components/GitConflictDialog';
import { ChangeMark } from '../components/ChangeMark';

export interface GitFile {
  path: string;
  state: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  staged: boolean;
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
}

interface SecretFinding {
  file: string;
  where: string;
  message: string;
  kind: 'request' | 'collection-auth' | 'collection-variable' | 'environment-variable' | 'workspace-variable' | 'mcp-server' | 'provider';
  collectionId?: string;
  itemId?: string;
  part?: 'auth' | 'headers' | 'params' | 'body';
  field?: string;
  environmentId?: string;
  serverId?: string;
  providerId?: string;
  variable?: string;
}

const fail = (e: unknown) => useApp.getState().toast(asError(e).message, 'error');

/** Open a changed request in its editor. */
function openItem(c: SemanticChange) {
  if (!c.collectionId || !c.itemId) return;
  const view = c.itemKind === 'graphql' ? 'graphql' : c.itemKind === 'http' ? 'rest' : undefined;
  if (view) useApp.getState().openIntent(view, { collectionId: c.collectionId, requestId: c.itemId });
}

/**
 * Git for the workspace (GIT-204 … GIT-209, GIT-304): what changed by meaning, commit (secrets checked first, an AI
 * written message on request), branches, pull and push, and a link to open a pull request.
 */
export function GitView() {
  const [status, setStatus] = useState<GitStatusInfo>();
  const [changes, setChanges] = useState<SemanticChange[]>([]);
  const [itemDiff, setItemDiff] = useState<{ file: string; itemId?: string }>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string>();
  const [secrets, setSecrets] = useState<SecretFinding[]>();
  const [branches, setBranches] = useState<{ current?: string; local: string[]; remote: string[] }>();
  const [log, setLog] = useState<Array<{ hash: string; short: string; author: string; date: string; subject: string }>>([]);
  const [diff, setDiff] = useState<{ path: string; text: string }>();
  const [prUrl, setPrUrl] = useState<string>();

  const load = useCallback(async () => {
    try {
      const { changes: ch, ...st } = await call<GitStatusInfo & { changes: SemanticChange[] }>('git.changes');
      setStatus(st);
      if (!st.repository) return;
      const [br, lg, pr] = await Promise.all([
        call<typeof branches>('git.branches'),
        call<typeof log>('git.log', { limit: 30 }),
        call<{ url?: string }>('git.pullRequestUrl').catch(() => ({ url: undefined })),
      ]);
      setChanges(ch);
      // a commit an AI agent proposed: its message, for the user to review
      const proposal = await call<{ message: string } | null>('git.proposal').catch(() => null);
      if (proposal?.message) setMessage((m) => m || proposal.message);
      setBranches(br);
      setLog(lg);
      setPrUrl(pr.url);
    } catch (e) {
      fail(e);
    }
  }, []);

  useEffect(() => {
    void load();
    const offs = [on('git.changed', () => void load()), on('data.changed', () => void load())];
    return () => offs.forEach((o) => o());
  }, [load]);

  const run = async (label: string, op: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    try {
      await op();
      if (done) useApp.getState().toast(done, 'success');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(undefined);
      void load();
    }
  };

  const files = status?.files ?? [];
  const byFile = useMemo(() => {
    const m = new Map<string, SemanticChange[]>();
    for (const c of changes) m.set(c.file, [...(m.get(c.file) ?? []), c]);
    return m;
  }, [changes]);

  const commit = async (force = false) => {
    if (!message.trim()) return useApp.getState().toast('Write a commit message first (or let the assistant write one).', 'warning');
    setBusy('commit');
    try {
      // with nothing staged, commit every change of the workspace
      const paths = files.some((f) => f.staged) ? undefined : ['.'];
      const r = await call<{ committed: boolean; secrets: SecretFinding[]; commit?: { short: string } }>('git.commit', { message, paths, force });
      if (!r.committed) return setSecrets(r.secrets);
      setSecrets(undefined);
      setMessage('');
      useApp.getState().toast(`Committed ${r.commit?.short ?? ''}`, 'success');
    } catch (e) {
      fail(e);
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
        action={
          <div className="flex gap-2 justify-center">
            <Button variant="primary" loading={busy === 'init'} onClick={() => void run('init', () => call('git.init', {}), 'The workspace is now a git repository')}>
              Initialize repository
            </Button>
            <Button
              loading={busy === 'remote'}
              onClick={async () => {
                const remote = await promptText('Connect to a git repository', { message: 'The URL of an empty repository (GitHub, GitLab, Bitbucket, Azure DevOps …). Push sends the workspace there.', placeholder: 'https://github.com/team/api-tests.git' });
                if (remote) await run('remote', () => call('git.init', { remote }), 'Connected: commit, then Push');
              }}
            >
              Connect to a remote…
            </Button>
          </div>
        }
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
                    if (!/not fully merged/i.test(asError(e).message)) return fail(e);
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
  const push = () => void run('push', () => call('git.push'), 'Pushed');
  return (
    <div className="h-full flex flex-col min-h-0">
      <PageHeader
        icon={<FolderGit2 size={18} />}
        title="Git"
        subtitle={status.remote ?? 'No remote yet'}
        actions={
          <>
            <Menu trigger={<Button icon={<GitBranch size={13} />}>{status.branch ?? 'detached'}</Button>} items={branchItems} />
            {status.remote ? (
              <>
                <Button icon={<RefreshCw size={13} />} loading={busy === 'fetch'} onClick={() => void run('fetch', () => call('git.fetch'))} title="Fetch: see what the remote has">
                  Fetch
                </Button>
                <Button
                  icon={<ArrowDown size={13} />}
                  loading={busy === 'pull'}
                  onClick={() =>
                    void run('pull', async () => {
                      const r = await call<{ conflicted: boolean }>('git.pull', {});
                      useApp.getState().toast(r.conflicted ? 'Pulled with conflicts: resolve them below' : 'Up to date with the remote', r.conflicted ? 'warning' : 'success');
                    })
                  }
                  title="Pull: bring in your team's commits"
                >
                  Pull{status.behind ? ` ${status.behind}` : ''}
                </Button>
                <Button icon={<ArrowUp size={13} />} variant={status.ahead ? 'primary' : undefined} loading={busy === 'push'} onClick={push} title={status.ahead ? `Push: send your ${status.ahead} commit${status.ahead === 1 ? '' : 's'} to ${status.remote}` : 'Push: send your commits'}>
                  Push{status.ahead ? ` ${status.ahead}` : ''}
                </Button>
              </>
            ) : (
              <Button variant="primary" icon={<ExternalLink size={13} />} loading={busy === 'remote'} onClick={() => void connectRemote()} title="Commits stay on this computer until the workspace has a remote: a repository on GitHub, GitLab, Bitbucket or Azure DevOps">
                Connect to a remote…
              </Button>
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
          { label: 'Make ready for git', icon: <Check size={14} />, onSelect: () => void run('ready', () => call('ws.gitReady'), 'Git files are in place') },
        ]}
      />
      <div className="flex-1 min-h-0 overflow-auto p-4 grid gap-5 content-start max-w-5xl w-full">
        {status.conflicted && <ConflictPanel files={files.filter((f) => f.state === 'conflicted')} onDone={() => void load()} />}

        <section>
          <SectionTitle
            right={
              files.length > 0 && (
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => void run('stage', () => call('git.stage', { paths: files.map((f) => f.path) }))}>
                    Stage all
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Undo2 size={12} />}
                    onClick={async () => {
                      if (await confirmAction({ title: 'Discard all changes', message: `Throw away ${files.length} changed file${files.length === 1 ? '' : 's'}?`, detail: 'Files go back to the last commit; new files are deleted.', confirmLabel: 'Discard', danger: true }))
                        await run('discard', () => call('git.discard', { files }), 'Changes discarded');
                    }}
                  >
                    Discard all
                  </Button>
                </div>
              )
            }
          >
            Changes {files.length ? <Badge>{files.length}</Badge> : null}
          </SectionTitle>
          {!files.length ? (
            <div className="text-sm text-muted py-3">Nothing changed since the last commit.</div>
          ) : (
            <ul className="grid gap-1" aria-label="Changes">
              {files.map((f) => (
                <li key={f.path} className="rounded-md border border-line bg-panel">
                  <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
                    <ChangeMark change={f.state} />
                    <button className="font-mono text-xs truncate text-left hover:underline" title="Show the line diff" onClick={() => void call<string>('git.diff', { path: f.path, staged: f.staged }).then((text) => setDiff(diff?.path === f.path ? undefined : { path: f.path, text }), fail)}>
                      {f.path}
                    </button>
                    {f.staged && <Badge tone="accent">staged</Badge>}
                    <span className="ml-auto flex gap-1">
                      <Button size="sm" variant="ghost" icon={f.staged ? <Minus size={12} /> : <Plus size={12} />} onClick={() => void run('stage', () => call(f.staged ? 'git.unstage' : 'git.stage', { paths: [f.path] }))}>
                        {f.staged ? 'Unstage' : 'Stage'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<RotateCcw size={12} />}
                        onClick={async () => {
                          if (await confirmAction({ title: 'Discard changes', message: `Throw away the changes to ${f.path}?`, confirmLabel: 'Discard', danger: true })) await run('discard', () => call('git.discard', { files: [f] }));
                        }}
                      >
                        Discard
                      </Button>
                    </span>
                  </div>
                  {(byFile.get(f.path) ?? []).filter((c) => c.title !== f.path).length > 0 && (
                    <ul className="border-t border-line px-3 py-1.5 grid gap-0.5">
                      {(byFile.get(f.path) ?? []).map((c, i) => (
                        <li key={i} className="flex items-center gap-2 text-xs">
                          <ChangeMark change={c.change} />
                          <button className={cx('truncate text-left', c.itemKind === 'http' || c.itemKind === 'graphql' ? 'hover:underline' : 'cursor-default')} onClick={() => openItem(c)}>
                            {c.title}
                          </button>
                          {c.details.length > 0 && <span className="text-muted truncate">{c.details.join(', ')}</span>}
                          {(c.kind === 'collection' || c.kind === 'environment') && c.change !== 'conflicted' && (
                            <LinkButton className="ml-auto shrink-0" icon={<Columns2 size={12} />} title="Side by side: the last commit and now, part by part" onClick={() => setItemDiff({ file: c.file, itemId: c.itemId })}>
                              Compare
                            </LinkButton>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {diff?.path === f.path && <pre className="border-t border-line max-h-80 overflow-auto p-2 text-[0.72rem] font-mono whitespace-pre">{diff.text || '(no line changes: a new or binary file)'}</pre>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="grid gap-2">
          <SectionTitle>Commit {staged.length ? <span className="text-muted font-normal">· {staged.length} staged</span> : files.length ? <span className="text-muted font-normal">· all changes</span> : null}</SectionTitle>
          <textarea className="field min-h-20 font-mono text-xs" aria-label="Commit message" placeholder="What changed and why (e.g. Add payment tests)" value={message} onChange={(e) => setMessage(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="primary" icon={<GitCommitHorizontal size={13} />} loading={busy === 'commit'} disabled={!files.length} onClick={() => void commit()}>
              Commit
            </Button>
            <Button
              icon={<Sparkles size={13} />}
              loading={busy === 'suggest'}
              disabled={!files.length}
              title="The AI assistant writes a message from what changed (no secret values are sent)"
              onClick={() => void run('suggest', async () => setMessage((await call<{ message: string }>('git.suggestMessage')).message))}
            >
              Write message
            </Button>
          </div>
          {secrets && secrets.length > 0 && <SecretsPanel findings={secrets} onChange={setSecrets} onCommitAnyway={() => void commit(true)} />}
        </section>

        {log.length > 0 && (!status.remote || status.ahead > 0) && (
          // a commit is on this computer only until it is pushed: the next step, where the commit was made
          <div className="rounded-lg border border-accent/40 bg-accent/5 px-3 py-2 text-sm flex items-center gap-3 flex-wrap" data-push-next>
            <span>
              {status.remote
                ? `${status.ahead} commit${status.ahead === 1 ? '' : 's'} not pushed yet: your team and CI do not have ${status.ahead === 1 ? 'it' : 'them'}.`
                : 'Committed on this computer only. Connect a remote (GitHub, GitLab, Bitbucket, Azure DevOps) to share your commits and run them in CI.'}
            </span>
            {status.remote ? (
              <Button size="sm" variant="primary" icon={<ArrowUp size={12} />} loading={busy === 'push'} onClick={push}>
                Push {status.ahead}
              </Button>
            ) : (
              <Button size="sm" variant="primary" icon={<ExternalLink size={12} />} loading={busy === 'remote'} onClick={() => void connectRemote()}>
                Connect to a remote…
              </Button>
            )}
          </div>
        )}

        <section>
          <SectionTitle>History</SectionTitle>
          {!log.length ? (
            <div className="text-sm text-muted py-2">No commits yet.</div>
          ) : (
            <ul className="grid gap-0.5 text-sm" aria-label="Commits">
              {log.map((c) => (
                <li key={c.hash} className="flex items-center gap-2 py-0.5">
                  <span className="font-mono text-xs text-muted">{c.short}</span>
                  <span className="truncate">{c.subject}</span>
                  <span className="ml-auto text-xs text-muted whitespace-nowrap">
                    {c.author} · {new Date(c.date).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className="text-xs text-muted">git {status.version} · sign-in uses your git setup (SSH keys or the credential manager)</div>
      </div>
      {itemDiff && <GitItemDiffDialog file={itemDiff.file} itemId={itemDiff.itemId} onClose={() => setItemDiff(undefined)} />}
    </div>
  );
}

/** Where a finding lives, as the explorer shows it: "Admin ▸ Printers ▸ Print jobs" → the folders and the request. */
function splitWhere(where: string): { path: string; name: string } {
  const parts = where.split(/\s[›▸]\s/);
  return parts.length > 1 ? { path: parts.slice(0, -1).join(' › '), name: parts[parts.length - 1]! } : { path: '', name: where };
}

/** What a finding holds, in a few words: "header Authorization", "body field continuationToken", "bearer token". */
function whatOf(f: SecretFinding): string {
  if (f.kind === 'request' || f.kind === 'collection-auth') return f.part === 'headers' ? `header ${f.field}` : f.part === 'body' ? `body field "${f.field}"` : f.part === 'auth' ? `auth ${f.field}` : (f.field ?? 'a value');
  if (f.kind === 'mcp-server') return `${f.field} of the server`;
  if (f.kind === 'provider') return 'the API key';
  return `variable ${f.field}`;
}

/** Open what a finding points at: the request in its editor, the environment, the collection's variables … */
function openFinding(f: SecretFinding) {
  const go = useApp.getState().openIntent;
  if (f.kind === 'request' && f.collectionId && f.itemId) return go('rest', { collectionId: f.collectionId, requestId: f.itemId });
  if (f.kind === 'collection-auth' && f.collectionId) return go('collections', { collectionId: f.collectionId, tab: 'auth' });
  if (f.kind === 'collection-variable' && f.collectionId) return go('collections', { collectionId: f.collectionId, tab: 'variables' });
  if (f.kind === 'environment-variable') return go('environments', { environmentId: f.environmentId });
  if (f.kind === 'workspace-variable') return go('environments', { tab: 'workspace' });
  if (f.kind === 'mcp-server') return go('mcp', { serverId: f.serverId });
  if (f.kind === 'provider') return go('ai', { tab: 'providers', providerId: f.providerId });
}

/**
 * The secrets a commit would publish, as a list a person can act on: each one opens where it is, is fixed in one
 * click (the value becomes a secret variable of the active environment, the request a {{reference}}), or the request
 * is removed. Grouped by where they are, with the long tail folded.
 */
function SecretsPanel({ findings, onChange, onCommitAnyway }: { findings: SecretFinding[]; onChange(next: SecretFinding[] | undefined): void; onCommitAnyway(): void }) {
  const ws = useApp((s) => s.workspace);
  const envName = useApp((s) => s.environment);
  const env = ws?.environments.find((e) => e.name === envName);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string>();
  const fixable = findings.filter((f) => f.kind !== 'mcp-server' && f.kind !== 'provider');
  const groups = useMemo(() => {
    const m = new Map<string, SecretFinding[]>();
    for (const f of findings) {
      const key = f.kind === 'request' || f.kind === 'collection-auth' ? splitWhere(f.where).path || f.where : f.kind === 'environment-variable' ? f.where.replace(/, variable .*$/, '') : f.kind === 'mcp-server' ? 'MCP servers' : f.kind === 'provider' ? 'AI providers' : f.kind === 'workspace-variable' ? 'Workspace variables' : f.where.replace(/, variable .*$/, '');
      m.set(key, [...(m.get(key) ?? []), f]);
    }
    return [...m.entries()];
  }, [findings]);
  const shownGroups = showAll ? groups : groups.slice(0, 4);
  const hidden = findings.length - shownGroups.reduce((n, [, g]) => n + g.length, 0);

  const fix = async (list: SecretFinding[]) => {
    if (!env) return useApp.getState().toast('Choose the environment that should keep the secret values (top bar), then fix.', 'warning');
    setBusy(list.length === 1 ? list[0]!.where + list[0]!.field : 'all');
    try {
      const r = await call<{ fixed: SecretFinding[]; skipped: Array<{ finding: SecretFinding; reason: string }>; variables: string[] }>('git.fixSecrets', { findings: list, environmentId: env.id });
      const left = await call<SecretFinding[]>('git.check');
      onChange(left.length ? left : undefined);
      useApp.getState().toast(
        r.fixed.length ? `${r.fixed.length} secret${r.fixed.length === 1 ? '' : 's'} moved to ${r.variables.length ? `secret variable${r.variables.length === 1 ? '' : 's'} ${r.variables.join(', ')} of ${env.name}` : 'the secret store'}${r.skipped.length ? `; ${r.skipped.length} left to do by hand` : ''}` : 'Nothing could be fixed by itself; open each one.',
        r.fixed.length ? 'success' : 'warning',
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(undefined);
    }
  };
  const remove = async (f: SecretFinding) => {
    if (!f.collectionId || !f.itemId) return;
    const { name } = splitWhere(f.where);
    if (!(await confirmAction({ title: 'Remove request', message: `Remove "${name}" from the collection?`, detail: 'The request is deleted; its collection keeps everything else. Undo with git until you commit.', confirmLabel: 'Remove', danger: true }))) return;
    try {
      const c = await call<{ id: string; items: unknown[] }>('col.get', { id: f.collectionId }).catch(() => undefined);
      if (!c) return;
      const prune = (nodes: Array<{ id: string; kind: string; items?: unknown[] }>): unknown[] => nodes.filter((n) => n.id !== f.itemId).map((n) => (n.kind === 'folder' ? { ...n, items: prune(n.items as typeof nodes) } : n));
      await call('col.save', { ...c, items: prune(c.items as Array<{ id: string; kind: string; items?: unknown[] }>) });
      const left = await call<SecretFinding[]>('git.check');
      onChange(left.length ? left : undefined);
      useApp.getState().toast(`Removed "${name}"`, 'success');
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div role="alert" className="rounded-md border border-bad/40 bg-bad/5 p-3 text-sm grid gap-2">
      <div className="flex items-center gap-2 font-medium">
        <ShieldAlert size={15} className="text-bad" /> Not committed: {findings.length} secret{findings.length === 1 ? ' is' : 's are'} typed into the workspace
      </div>
      <div className="text-xs text-muted">
        A value typed into a request would go to everyone who pulls. <b>Fix</b> turns it into a {'{{variable}}'} whose value stays on this computer as a secret variable of {env ? <b>{env.name}</b> : 'the active environment (choose one in the top bar)'}; plain variables become secret the same way.
      </div>
      <div className="grid gap-2">
        {shownGroups.map(([group, list]) => (
          <div key={group} className="rounded-md border border-line bg-panel">
            <div className="px-2 py-1 text-xs text-muted border-b border-line truncate" title={group}>
              {group} · {list.length}
            </div>
            <ul>
              {list.map((f, i) => {
                const { name } = splitWhere(f.where);
                const key = f.where + f.field + i;
                return (
                  <li key={key} className="flex items-center gap-2 px-2 py-1 text-xs border-b border-line last:border-b-0">
                    <button className="font-medium truncate hover:underline text-left" title={`${f.message} (${f.file})`} onClick={() => openFinding(f)}>
                      {f.kind === 'request' || f.kind === 'collection-auth' ? name : f.kind === 'environment-variable' || f.kind === 'collection-variable' || f.kind === 'workspace-variable' ? f.field : name}
                    </button>
                    <span className="text-muted truncate">{whatOf(f)}</span>
                    <span className="ml-auto flex items-center gap-1 shrink-0">
                      <Button size="sm" variant="ghost" icon={<ExternalLink size={12} />} onClick={() => openFinding(f)} title="Open it to change by hand">
                        Open
                      </Button>
                      {f.kind !== 'mcp-server' && f.kind !== 'provider' && (
                        <Button size="sm" variant="ghost" icon={<KeyRound size={12} />} loading={busy === f.where + f.field} onClick={() => void fix([f])} title={`Replace the value with {{${f.variable ?? 'variable'}}} and keep it as a secret variable`}>
                          Fix
                        </Button>
                      )}
                      {f.kind === 'request' && <MoreMenu label={`More for ${name}`} items={[{ label: 'Remove request…', icon: <Trash2 size={14} />, danger: true, onSelect: () => void remove(f) }]} />}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {hidden > 0 && (
          <button className="text-xs text-accent text-left hover:underline" onClick={() => setShowAll(true)}>
            Show all ({hidden} more)
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {fixable.length > 0 && (
          <Button size="sm" variant="primary" icon={<KeyRound size={13} />} loading={busy === 'all'} onClick={() => void fix(fixable)} title="Every one of them, in one go">
            Fix all {fixable.length === findings.length ? '' : `(${fixable.length})`}
          </Button>
        )}
        <Button size="sm" icon={<X size={13} />} onClick={() => onChange(undefined)}>
          Later
        </Button>
        <Button size="sm" variant="danger" icon={<ShieldAlert size={13} />} onClick={onCommitAnyway} title="Commit with the secrets in the files (for demo values you mean to share)">
          Commit anyway
        </Button>
      </div>
    </div>
  );
}

/** Files changed on both sides after a pull (GIT-302): keep yours, take theirs, or open the file to merge by hand. */
function ConflictPanel({ files, onDone }: { files: GitFile[]; onDone(): void }) {
  const [busy, setBusy] = useState<string>();
  const [comparing, setComparing] = useState<string>();
  const pick = async (path: string, side: 'ours' | 'theirs') => {
    setBusy(path);
    try {
      await call('git.resolve', { path, side });
      onDone();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <section role="alert" className="rounded-md border border-warn/50 bg-warn/5 p-3 grid gap-2">
      <SectionTitle>Conflicts · changed by you and by someone else</SectionTitle>
      <ul className="grid gap-1">
        {files.map((f) => (
          <li key={f.path} className="flex items-center gap-2 text-sm">
            <ChangeMark change="conflicted" />
            <span className="font-mono text-xs truncate">{f.path}</span>
            <span className="ml-auto flex gap-1">
              {/^(collections|environments|library)\/[^/]+\.json$/.test(f.path) && (
                <Button size="sm" variant="primary" onClick={() => setComparing(f.path)} title="See each conflicting request side by side and choose per request">
                  Compare…
                </Button>
              )}
              <Button size="sm" loading={busy === f.path} onClick={() => void pick(f.path, 'ours')}>
                Keep mine
              </Button>
              <Button size="sm" loading={busy === f.path} onClick={() => void pick(f.path, 'theirs')}>
                Take theirs
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex gap-2 items-center">
        <Button size="sm" variant="ghost" onClick={() => void call('git.abortMerge').then(onDone, fail)}>
          Cancel the pull
        </Button>
        <span className="text-xs text-muted">In a collection, only the requests changed on both sides take the side you choose; every other change of both sides stays. When every file is resolved, commit to finish the pull.</span>
      </div>
      {comparing && <GitConflictDialog path={comparing} onClose={() => setComparing(undefined)} onResolved={() => (setComparing(undefined), onDone())} />}
    </section>
  );
}
