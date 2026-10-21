import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApsError } from '../../errors.js';
import type { Collection } from '../../model/types.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { gitLog, gitStage, gitStatus, gitSync, gitUnstage } from '../../git/git.js';
import { gitConflictDetail, gitResolve } from '../../git/conflicts.js';
import type { Redactor } from '../../util/redact.js';
import { changesMarkdown, describeGitChanges, describeItemDiff, describeRevChanges } from '../../git/semantic.js';
import { commitVerdict, scanStagedSecrets } from '../../git/staged-secrets.js';
import type { MergeResolutions } from '../../git/merge.js';
import { str, type Tool } from '../tool.js';

/** MCP tools for the workspace's git repository (GIT-402): status, the changes by meaning, history, a proposed commit. */
export function gitTools(d: { store: WorkspaceStore; findCollection(ref: unknown): Collection; redactor?: Redactor }): Tool[] {
  const { store, findCollection, redactor } = d;
  const red = (v?: string) => (v === undefined || !d.redactor ? v : d.redactor.redactString(v));
  return [
    {
      name: 'git_conflicts',
      description:
        'After a pull that stopped on conflicts: each conflicted file by what it holds (`mode`). `items` (collections, environments, library files, MCP servers, providers, workspace and Debugger settings): each conflict is an item changed on both sides, changed on one side and deleted on the other, or a setting changed differently, with its parts side by side (base, ours = this workspace, theirs = the remote) and, when only some fields clash, those `fields` each with its own key (`item:<id>#<field path>`). `text` (test and flow files, API definitions, mocks, datasets): `hunks`, each with a key (`hunk:<n>`), where it is ("near step create-order") and the lines of each side; everything that merged cleanly is already merged. `binary` (a database, an image): the whole file with the `sizes` of both sides. Values are redacted. Settle them with git_resolve.',
      inputSchema: { type: 'object', properties: { path: str('Only this file (workspace-relative); default: every conflicted file') } },
      run: async (a) => {
        const st = await gitStatus(store.root);
        const files = st.files.filter((f) => f.state === 'conflicted' && (!a.path || f.path === a.path));
        const details = await Promise.all(files.map((f) => gitConflictDetail(store.root, f.path)));
        return {
          conflicted: st.conflicted,
          files: details.map((x) => ({
            ...x,
            items: x.items.map(({ editable: _editable, ...i }) => ({
              ...i,
              parts: i.parts.map((p) => ({ ...p, base: red(p.base), ours: red(p.ours), theirs: red(p.theirs) })),
              ...(i.fields ? { fields: i.fields.map(({ oursJson: _o, theirsJson: _t, ...f }) => ({ ...f, base: red(f.base), ours: red(f.ours), theirs: red(f.theirs) })) } : {}),
            })),
            hunks: x.hunks.map((h) => ({ ...h, ours: red(h.ours)!, base: red(h.base)!, theirs: red(h.theirs)! })),
          })),
        };
      },
    },
    {
      name: 'git_resolve',
      write: true,
      description:
        'Settle one conflicted file and mark it resolved: `side` for every conflict in it (ours = keep this workspace\'s version, theirs = take the remote\'s), or `resolutions` per conflict key from git_conflicts: "ours", "theirs", or { "edit": "<value>" } for your own value (an item key takes the whole item as JSON, an `item:<id>#<field>` key the field\'s JSON value, a `hunk:<n>` key the text lines to keep). Conflicts without a choice take `side` (default ours). In a file merged by meaning only the conflicting items or fields take a side; every other change of both sides stays. A binary file is taken whole by `side`. When nothing is conflicted any more, commit to finish the pull.',
      inputSchema: {
        type: 'object',
        properties: {
          path: str('The conflicted file (workspace-relative)'),
          side: { type: 'string', enum: ['ours', 'theirs'] },
          resolutions: {
            type: 'object',
            description: 'A choice per conflict key: "ours", "theirs" or { edit: "<value>" }',
            additionalProperties: { anyOf: [{ type: 'string', enum: ['ours', 'theirs'] }, { type: 'object', properties: { edit: { type: 'string' } }, required: ['edit'] }] },
          },
        },
        required: ['path'],
      },
      run: async (a) => {
        if (!a.side && !a.resolutions) throw new ApsError('ValidationError', 'Give side (ours or theirs) or resolutions per conflict key');
        const resolutions = a.resolutions as MergeResolutions | undefined;
        for (const [k, v] of Object.entries(resolutions ?? {}))
          if (!(v === 'ours' || v === 'theirs' || (v && typeof v === 'object' && typeof (v as { edit?: unknown }).edit === 'string')))
            throw new ApsError('ValidationError', `The choice for ${k} is "ours", "theirs" or { "edit": "<value>" }`);
        await gitResolve(store.root, String(a.path), (a.side as 'ours' | 'theirs') ?? 'ours', resolutions);
        const st = await gitStatus(store.root);
        return { resolved: String(a.path), stillConflicted: st.files.filter((f) => f.state === 'conflicted').map((f) => f.path), next: st.conflicted ? 'Resolve the other files' : 'Commit to finish the pull (git_propose_commit, then commit)' };
      },
    },
    {
      name: 'git_status',
      description:
        'Git state of the workspace: whether it is in a repository, the branch, commits ahead / behind the remote, and each changed file (modified, added, deleted, renamed, untracked, conflicted; staged or not) with its `ref` (an ItemRef of kind git-file).',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const st = await gitStatus(store.root);
        return st.files ? { ...st, files: st.files.map((f) => ({ ...f, ref: { kind: 'git-file', path: f.path } })) } : st;
      },
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
        'Propose a commit of the workspace changes: stages them, scans what is staged for secrets (certain ones refuse the proposal and are returned; probable ones are returned for the user to confirm with `allow_probable_secrets`; the index is put back when refused), and saves your commit message as the proposal. It does NOT commit: a person commits it in the TestPion Git view (the message is filled in), or CI runs `testpion git commit -m … --json`. Write the message from git_diff: an imperative subject under 72 characters, then the main changes.',
      inputSchema: {
        type: 'object',
        properties: {
          message: str('The commit message you propose'),
          allow_probable_secrets: { type: 'boolean', description: 'true only after the user confirmed that the probable secrets listed by an earlier call are not secrets. Certain secrets are never allowed.' },
        },
        required: ['message'],
      },
      run: async (a) => {
        const st = await gitStatus(store.root);
        if (!st.repository)
          throw new ApsError('ConfigurationError', 'The workspace is not in a git repository', { suggestions: ['Initialize it in TestPion (Git view) or run git init in the workspace folder.'] });
        if (!st.files.length) return { proposed: false, why: 'Nothing changed since the last commit.' };
        // stage, then scan what is staged (the exact blobs a commit would publish); a refusal puts the index back
        const before = new Set(st.files.filter((f) => f.staged).map((f) => f.path));
        await gitStage(store.root, ['.']);
        const scan = await scanStagedSecrets(store.root);
        const verdict = commitVerdict(scan, a.allow_probable_secrets === true);
        if (!verdict.allowed) {
          const now = (await gitStatus(store.root)).files.filter((f) => f.staged && !before.has(f.path)).map((f) => f.path);
          if (now.length) await gitUnstage(store.root, now);
          return verdict.reason === 'blocked'
            ? { proposed: false, secrets: scan.blocking, probableSecrets: scan.confirm, why: 'Secrets are typed into the staged files: make each a secret variable (use the {{variable}} named in the finding) first. This cannot be confirmed away.' }
            : { proposed: false, needsConfirmation: true, probableSecrets: scan.confirm, why: 'These look like secrets. Ask the user: if they are not, call again with allow_probable_secrets: true; otherwise replace them with {{variables}}.' };
        }
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
