import { ApsError } from '../../errors.js';
import { listSharedSessions, shareSession, unshareSession } from '../../debugger/share-session.js';
import { writeCodeowners } from '../../git/codeowners.js';
import { fixGitSetup } from '../../git/fix-setup.js';
import { checkReferences, findLargeFiles, trackByReference, trackWithLfs } from '../../git/large-files.js';
import { readSecretsAllow } from '../../git/secrets-allow.js';
import { fixStagedFiles } from '../../git/staged-fix.js';
import { scanStagedSecrets } from '../../git/staged-secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import type { Redactor } from '../../util/redact.js';
import { str, type Tool } from '../tool.js';

/**
 * Release C of "Everything under Git" for agents (planning/git-everything.md): fix the git setup, big files, share a Debugger
 * session, a starter CODEOWNERS, and the staged secret scan's allowlist and fix plan. The same core functions as the app's
 * Git view and `testpion git fix|large|share-session|codeowners|allowed-secrets|fix-secrets`.
 *
 * Two things are deliberately not here: adding an entry to `.testpion/secrets-allow.json` (an agent must not be able to switch
 * the secret guard off: a person allows a value, in the app or with `testpion git allow-secret`), and applying the secret
 * fix (the values move to the app's secret store, which a server process does not have: the plan is returned).
 */
const dryRun = { type: 'boolean', description: 'true: only report what would change, write nothing' };

export function gitSetupTools({ store, redactor }: { store: WorkspaceStore; redactor: Redactor }): Tool[] {
  return [
    {
      name: 'git_fix_setup',
      write: true,
      description:
        'Fix git setup in one previewed, undoable step: complete .gitignore and .gitattributes (one line-ending policy, merge and diff drivers for every JSON kind), rewrite existing files into the stable format once (fixed key order, no save counter or time, LF), optionally install the pre-commit secret check, and list the rest (tracked files that should be ignored, big files, CRLF documents). Idempotent. With `dryRun: true` it returns the plan (`steps`, `rewritten`, `files`). A real run returns an `undoId` for git_undo (the files go back; git config is left). The merge and diff drivers are registered by the app or `testpion git fix`, which know their own program path. Needs `confirm: true` (or the user\'s yes) unless `dryRun`.',
      inputSchema: {
        type: 'object',
        properties: { dryRun, hook: { type: 'boolean', description: 'Also install the pre-commit secret check' }, untrack: { type: 'boolean', description: 'Also remove from git (not from disk) the tracked files the ignore rules ignore' } },
      },
      run: (a) => fixGitSetup(store, { dryRun: a.dryRun === true, hook: a.hook === true, untrack: a.untrack === true }),
    },
    {
      name: 'git_large_files',
      description:
        'Files over the size policy in the workspace\'s document folders (datasets, API definitions …) that git would take: level `warn` (5 MB), `lfs` (50 MB: offer Git LFS or tracking by reference) or `refuse` (100 MB: a commit is refused). With `check: true` also each `<file>.ref` reference against the data on this computer (ok, missing, different). Track a file with git_track_large.',
      inputSchema: { type: 'object', properties: { check: { type: 'boolean', description: 'Also check the .ref files against the data' } } },
      run: async (a) => ({ files: await findLargeFiles(store.root), ...(a.check === true ? { references: await checkReferences(store.root) } : {}) }),
    },
    {
      name: 'git_track_large',
      write: true,
      description:
        'Take a big file out of plain git: `mode: "lfs"` adds a Git LFS rule to .gitattributes (git-lfs must be installed; the repository then keeps a pointer), `mode: "reference"` commits `<file>.ref` (size and sha256, `source` says where the team keeps the data) and git-ignores the data file. With `dryRun: true` it only returns the plan. Returns an `undoId` for git_undo. Needs `confirm: true` (or the user\'s yes) unless `dryRun`.',
      inputSchema: {
        type: 'object',
        properties: { file: str('The workspace file, e.g. datasets/patients.csv'), mode: { type: 'string', enum: ['lfs', 'reference'] }, source: str('With mode reference: where the data is kept (a URL, a bucket, a share)'), dryRun },
        required: ['file', 'mode'],
      },
      run: (a) => {
        if (a.mode !== 'lfs' && a.mode !== 'reference') throw new ApsError('ValidationError', 'mode is "lfs" or "reference"');
        return a.mode === 'lfs' ? trackWithLfs(store.root, String(a.file), { dryRun: a.dryRun === true }) : trackByReference(store.root, String(a.file), { dryRun: a.dryRun === true, source: a.source ? String(a.source) : undefined });
      },
    },
    {
      name: 'git_share_session',
      write: true,
      description:
        'Share a saved Debugger session with the team: a copy, masked once more with the redaction every export uses, goes to debugger/shared/<name>.har, which git tracks (the session itself stays git-ignored). `unshare: true` deletes the shared copy. Without `name`, lists the shared sessions. With `dryRun: true` it only reports. Returns an `undoId` for git_undo. Needs `confirm: true` (or the user\'s yes) when it writes.',
      inputSchema: { type: 'object', properties: { name: str('The saved session\'s name'), unshare: { type: 'boolean', description: 'Delete the shared copy instead' }, dryRun } },
      run: (a) => {
        if (!a.name) return { shared: listSharedSessions(store) };
        return a.unshare === true ? unshareSession(store, String(a.name)) : shareSession(store, String(a.name), { redactor, dryRun: a.dryRun === true });
      },
    },
    {
      name: 'git_codeowners',
      write: true,
      description:
        'A starter CODEOWNERS with one line per kind folder of the workspace (environments, MCP servers, providers, tests …); the owners are left as comments to fill in unless `owner` is given. `write: true` writes .github/CODEOWNERS when the workspace is the repository (never over an existing one; never outside the workspace). Otherwise it returns the text. Needs `confirm: true` (or the user\'s yes) when it writes.',
      inputSchema: { type: 'object', properties: { owner: str('The owner for every line, e.g. @your-org/platform'), write: { type: 'boolean', description: 'Write the file instead of returning the text' } } },
      run: (a) => writeCodeowners(store.root, { owner: a.owner ? String(a.owner) : undefined, dryRun: a.write !== true }),
    },
    {
      name: 'git_allowed_secrets',
      description: 'What `.testpion/secrets-allow.json` lets through the staged secret scan: per entry the file, item, field, a fingerprint and the reason (never a value). Adding an entry is a person\'s decision (the app or `testpion git allow-secret`).',
      inputSchema: { type: 'object', properties: {} },
      run: () => readSecretsAllow(store.root),
    },
    {
      name: 'git_secrets_fix_plan',
      description:
        'What the one-click fix would do for secrets typed into the staged files of MCP servers, AI providers, library items, test files and other files: for each finding the `{{variable}}` its value becomes. Nothing is written: the values move to secret variables in the TestPion app (Git view ▸ Fix all), whose secret store this server does not have.',
      inputSchema: { type: 'object', properties: { environment: str('The environment whose secret variables would keep the values (default: the first)') } },
      run: async (a) => {
        const envs = store.listEnvironments();
        const env = a.environment ? envs.find((e) => e.id === String(a.environment) || e.name === String(a.environment)) : envs[0];
        if (!env) throw new ApsError('ValidationError', a.environment ? `No environment "${String(a.environment)}"` : 'The workspace has no environment to keep secret variables in');
        const scan = await scanStagedSecrets(store.root);
        const files = [...new Set([...scan.blocking, ...scan.confirm].map((f) => f.file))];
        return fixStagedFiles(store, undefined, { files, environmentId: env.id, dryRun: true });
      },
    },
  ];
}
