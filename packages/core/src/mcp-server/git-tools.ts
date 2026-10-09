import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApsError } from '../errors.js';
import type { Collection } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { gitConflictDetail, gitLog, gitResolve, gitStage, gitStatus, gitSync } from '../git/git.js';
import type { Redactor } from '../util/redact.js';
import { changesMarkdown, describeGitChanges, describeItemDiff, describeRevChanges } from '../git/semantic.js';
import { findCommittableSecrets } from '../storage/git-guard.js';
import { str, type Tool } from './tool.js';

/** MCP tools for the workspace's git repository (GIT-402): status, the changes by meaning, history, a proposed commit. */
export function gitTools(d: { store: WorkspaceStore; findCollection(ref: unknown): Collection; redactor?: Redactor }): Tool[] {
  const { store, findCollection, redactor } = d;
  const red = (v?: string) => (v === undefined || !d.redactor ? v : d.redactor.redactString(v));
  return [
    {
      name: 'git_conflicts',
      description:
        'After a pull that stopped on conflicts: each conflicted file, and in a collection file each conflict (a request changed on both sides, changed on one side and deleted on the other, or a setting changed differently) with its parts side by side (base, ours = this workspace, theirs = the remote), values redacted. Settle them with git_resolve.',
      inputSchema: { type: 'object', properties: { path: str('Only this file (workspace-relative); default: every conflicted file') } },
      run: async (a) => {
        const st = await gitStatus(store.root);
        const files = st.files.filter((f) => f.state === 'conflicted' && (!a.path || f.path === a.path));
        const details = await Promise.all(files.map((f) => gitConflictDetail(store.root, f.path)));
        return {
          conflicted: st.conflicted,
          files: details.map((x) => ({ ...x, items: x.items.map((i) => ({ ...i, parts: i.parts.map((p) => ({ ...p, base: red(p.base), ours: red(p.ours), theirs: red(p.theirs) })) })) })),
        };
      },
    },
    {
      name: 'git_resolve',
      write: true,
      description:
        'Settle one conflicted file and mark it resolved: `side` for every conflict in it (ours = keep this workspace\'s version, theirs = take the remote\'s), or `resolutions` as { "<key from git_conflicts>": "ours" | "theirs" } per conflict. In a collection only the conflicting requests take a side; every other change of both sides stays. When nothing is conflicted any more, commit to finish the pull.',
      inputSchema: {
        type: 'object',
        properties: {
          path: str('The conflicted file (workspace-relative)'),
          side: { type: 'string', enum: ['ours', 'theirs'] },
          resolutions: { type: 'object', description: 'A choice per conflict key', additionalProperties: { type: 'string', enum: ['ours', 'theirs'] } },
        },
        required: ['path'],
      },
      run: async (a) => {
        if (!a.side && !a.resolutions) throw new ApsError('ValidationError', 'Give side (ours or theirs) or resolutions per conflict key');
        await gitResolve(store.root, String(a.path), (a.side as 'ours' | 'theirs') ?? 'ours', a.resolutions as Record<string, 'ours' | 'theirs'> | undefined);
        const st = await gitStatus(store.root);
        return { resolved: String(a.path), stillConflicted: st.files.filter((f) => f.state === 'conflicted').map((f) => f.path), next: st.conflicted ? 'Resolve the other files' : 'Commit to finish the pull (git_propose_commit, then commit)' };
      },
    },
    {
      name: 'git_status',
      description:
        'Git state of the workspace: whether it is in a repository, the branch, commits ahead / behind the remote, and each changed file (modified, added, deleted, renamed, untracked, conflicted; staged or not).',
      inputSchema: { type: 'object', properties: {} },
      run: () => gitStatus(store.root),
    },
    {
      name: 'git_sync',
      write: true,
      description:
        'Pull & push in one step: fetch; when the remote has new commits, pull them with a merge (collections merge request by request; uncommitted changes are set aside and put back); then push the committed work (setting the upstream on a first push). A push refused because someone pushed meanwhile is retried once after another pull. Returns state "pushed", "up-to-date", "pulled-nothing-to-push" or "conflicts" (with the files: settle them with git_conflicts / git_resolve, commit, then sync again). Commit first (a person commits a git_propose_commit proposal).',
      inputSchema: { type: 'object', properties: {} },
      run: () => gitSync(store.root),
    },
    {
      name: 'git_diff',
      description:
        'What changed in the workspace, by meaning rather than JSON lines: requests and folders added, changed (which parts: URL, headers, body, auth, scripts, checks …) or removed, environment variables added / changed / removed, flow and test files step by step (steps added, removed, renamed or changed with the parts: request line, headers, body, extract, checks, if, forEach …; connections added / removed; a layout-only change is "rearranged"; `itemId` is the step id). Without `from`: the uncommitted changes. With `from` (and optionally `to`): between two commits, branches or tags (e.g. from "main" to "HEAD"). `markdown: true` also returns a Markdown list for a pull-request comment.',
      inputSchema: {
        type: 'object',
        properties: {
          from: str('Commit, branch or tag to compare from (default: the uncommitted changes)'),
          to: str('Compare to this commit (default: the working folder)'),
          markdown: { type: 'boolean', description: 'Also return the changes as Markdown' },
          file: str('With itemId (or alone for collection settings / an environment): one item side by side, part by part (before = `from` or the last commit, after = the working folder)'),
          itemId: str('A request or folder id in `file`, or a step id of a flow file in tests/'),
        },
      },
      run: async (a) => {
        if (a.file) {
          const d = await describeItemDiff(store.root, String(a.file), a.itemId ? String(a.itemId) : undefined, a.from ? String(a.from) : undefined);
          const red = (v?: string) => (v === undefined || !redactor ? v : redactor.redactString(v));
          return { ...d, parts: d.parts.map((p) => ({ ...p, before: red(p.before), after: red(p.after) })) };
        }
        const changes = a.from ? await describeRevChanges(store.root, String(a.from), a.to ? String(a.to) : undefined) : await describeGitChanges(store.root, (await gitStatus(store.root)).files);
        return a.markdown ? { changes, markdown: changesMarkdown(changes) } : changes;
      },
    },
    {
      name: 'git_log',
      description: 'Commits of the workspace, newest first (hash, author, date, subject); with `file` or `collection`, only those that changed it (following renames).',
      inputSchema: {
        type: 'object',
        properties: {
          file: str('A path inside the workspace, e.g. collections/payments.json'),
          collection: str('Collection name or id'),
          limit: { type: 'number', description: 'How many (default 20, max 200)' },
        },
      },
      run: (a) =>
        gitLog(store.root, {
          path: a.file ? String(a.file) : a.collection ? store.collectionFileOf(findCollection(a.collection).id) : undefined,
          limit: Math.min(Math.max(Number(a.limit) || 20, 1), 200),
        }),
    },
    {
      name: 'git_propose_commit',
      write: true,
      description:
        'Propose a commit of the workspace changes: stages them, checks that no secret is typed in (the findings are returned and nothing is proposed when there are any), and saves your commit message as the proposal. It does NOT commit: a person commits it in the TestPion Git view (the message is filled in), or CI runs `testpion git commit -m … --json`. Write the message from git_diff: an imperative subject under 72 characters, then the main changes.',
      inputSchema: { type: 'object', properties: { message: str('The commit message you propose') }, required: ['message'] },
      run: async (a) => {
        const st = await gitStatus(store.root);
        if (!st.repository)
          throw new ApsError('ConfigurationError', 'The workspace is not in a git repository', { suggestions: ['Initialize it in TestPion (Git view) or run git init in the workspace folder.'] });
        const secrets = findCommittableSecrets(store);
        if (secrets.length) return { proposed: false, secrets, why: 'Secrets are typed into the workspace: make them secret variables (or {{variables}}) first.' };
        if (!st.files.length) return { proposed: false, why: 'Nothing changed since the last commit.' };
        await gitStage(store.root, ['.']);
        const proposal = { message: String(a.message).trim(), at: new Date().toISOString(), files: st.files.map((f) => f.path) };
        mkdirSync(join(store.root, '.local'), { recursive: true });
        writeFileSync(join(store.root, '.local', 'git-proposal.json'), JSON.stringify(proposal, null, 2));
        return {
          proposed: true,
          ...proposal,
          changes: await describeGitChanges(store.root, (await gitStatus(store.root)).files),
          next: 'Ask the user to review and commit it in TestPion (Git view).',
        };
      },
    },
  ];
}
