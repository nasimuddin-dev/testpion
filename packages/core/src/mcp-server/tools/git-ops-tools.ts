import { ApsError } from '../../errors.js';
import { discardItem, itemBlame, itemHistory, restoreItemVersion, stageItem } from '../../git/item-ops.js';
import { listJournal, undoJournal } from '../../git/journal.js';
import { stashApply, stashDrop, stashList, stashPush, stashShow } from '../../git/stash.js';
import { resolveItemTarget } from '../../git/item-target.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import type { Redactor } from '../../util/redact.js';
import { str, type Tool } from '../tool.js';

/**
 * Git per item for agents (release B of planning/git-everything.md): the versions of one item and who changed its fields,
 * putting an older version back, discarding or staging one item, undoing that, and setting changes aside. The same core
 * functions as the app's Git view and `testpion git history|blame|restore|discard-item|stage-item|undo|stash`.
 */
const target = {
  ref: { description: 'The item: a testpion:// link, a short ref such as mcp-server:weather, environment:staging or provider:openai, or an ItemRef object (from git_changes, item_info, resolve_ref)', anyOf: [{ type: 'string' }, { type: 'object' }] },
  file: str('Instead of ref: a workspace file, optionally with the item id after #: mcp-servers.json#weather'),
  itemId: str('With file: the item id inside it'),
};
const dryRun = { type: 'boolean', description: 'true: only report what would change, write nothing' };
const pick = (a: Record<string, unknown>) => ({ ref: a.ref, file: a.file === undefined ? undefined : String(a.file), itemId: a.itemId === undefined ? undefined : String(a.itemId) });

export function gitOpsTools({ store, redactor }: { store: WorkspaceStore; redactor?: Redactor }): Tool[] {
  const red = (v?: string) => (v === undefined || !redactor ? v : redactor.redactString(v));
  const to = (a: Record<string, unknown>) => resolveItemTarget(store, pick(a));
  const redactParts = <T extends { before?: string; after?: string }>(parts: T[]): T[] => parts.map((p) => ({ ...p, before: red(p.before), after: red(p.after) }));

  return [
    {
      name: 'git_history',
      description:
        'The versions of one item in git, newest first: for each commit that changed it (hash, author, date, subject) what it changed (`changed`: the parts, such as URL or Headers) and the changed `parts` side by side (before, after; values redacted). The item can be any versioned kind: a request, an environment, an MCP server, a provider, a prompt, a test file, an API definition, a dataset. Pick a `rev` from here for git_restore_item.',
      inputSchema: { type: 'object', properties: { ...target, limit: { type: 'number', description: 'How many versions' } } },
      run: async (a) => {
        const h = await itemHistory(store.root, to(a), Number(a.limit) || undefined);
        return { ...h, versions: h.versions.map((v) => ({ ...v, parts: redactParts(v.parts) })) };
      },
    },
    {
      name: 'git_blame',
      description: 'Who last changed each field of one item, and when: per field (URL, Headers, Name …) its value now (redacted), the commit that last changed it, or `uncommitted: true` when the change is not committed yet.',
      inputSchema: { type: 'object', properties: { ...target, limit: { type: 'number', description: 'How many versions to look through (default 200)' } } },
      run: async (a) => {
        const b = await itemBlame(store.root, to(a), Number(a.limit) || undefined);
        return { ...b, fields: b.fields.map((f) => ({ ...f, value: red(f.value)! })) };
      },
    },
    {
      name: 'git_restore_item',
      write: true,
      description:
        'Write an older version of just one item back (the rest of its file keeps its content); the change is left uncommitted. Returns the plan: the item\'s title, what happens to the file (`action`) and the parts that change (now → after; redacted), and an `undoId` for git_undo. With `dryRun: true` it only returns the plan. Needs `confirm: true` (or the user\'s yes) unless `dryRun`.',
      inputSchema: { type: 'object', properties: { ...target, rev: str('The commit whose version to put back (a hash from git_history)'), dryRun }, required: ['rev'] },
      run: async (a) => {
        const r = await restoreItemVersion(store.root, to(a), String(a.rev ?? ''), { dryRun: a.dryRun === true });
        return { ...r, parts: redactParts(r.parts) };
      },
    },
    {
      name: 'git_discard_item',
      write: true,
      description:
        'Throw away the uncommitted change of one item only: it goes back to the last commit and the other changes in its file stay. Returns the plan (parts now → after, redacted) and an `undoId` for git_undo. With `dryRun: true` it only returns the plan. Needs `confirm: true` (or the user\'s yes) unless `dryRun`.',
      inputSchema: { type: 'object', properties: { ...target, dryRun } },
      run: async (a) => {
        const r = await discardItem(store.root, to(a), { dryRun: a.dryRun === true });
        return { ...r, parts: redactParts(r.parts) };
      },
    },
    {
      name: 'git_stage_item',
      write: true,
      description:
        'Stage (or with `unstage: true`, unstage) one item, so a commit takes it. In a file that holds several items (a collection, MCP servers, providers, a library) only the change of this item goes into the index (`partial: true`; `leftUnstaged` names the other changed items of the file, which stay out of the commit); a file that is one item, or whose staged copy is not in the stable form, stages whole and `alsoStages` names the other changed items that come along, so check it before committing. With `dryRun: true` it only reports.',
      inputSchema: { type: 'object', properties: { ...target, unstage: { type: 'boolean', description: 'true: take it out of the staged files' }, dryRun } },
      run: (a) => stageItem(store.root, to(a), { unstage: a.unstage === true, dryRun: a.dryRun === true }),
    },
    {
      name: 'git_undo',
      write: true,
      description:
        'Undo the last git_restore_item / git_discard_item (the same as the app\'s Undo): the files go back exactly as they were, even when the change was never committed. `id` picks an older one (an `undoId`); `list: true` lists what can be undone (the newest 30). Needs `confirm: true` (or the user\'s yes) unless `list`.',
      inputSchema: { type: 'object', properties: { id: str('An undoId (default: the newest)'), list: { type: 'boolean', description: 'true: only list the undoable operations' } } },
      run: (a) => (a.list === true ? listJournal(store.root) : undoJournal(store.root, a.id ? String(a.id) : undefined)),
    },
    {
      name: 'git_stash',
      write: true,
      description:
        'Set the workspace\'s uncommitted changes aside under a name and put them back. `action`: "list" (the stashes, newest first), "show" (what one holds, by item), "push" (set everything aside under `name`; the workspace goes back to the last commit; `dryRun` only reports), "apply" (put it back, it stays listed), "pop" (put it back and remove it), "drop" (remove it for good). Pick a stash by `index` (0 = newest) or `hash`. A put-back that conflicts says so and keeps the stash; settle it with git_conflicts / git_resolve. Needs `confirm: true` (or the user\'s yes) for push, apply, pop and drop.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'show', 'push', 'apply', 'pop', 'drop'] },
          name: str('push: the name, e.g. "Before the pagination rewrite"'),
          index: { type: 'number', description: 'The stash\'s number in the list (0 = newest, the default)' },
          hash: str('Instead of index: the stash\'s hash'),
          dryRun,
        },
        required: ['action'],
      },
      run: async (a) => {
        const ref = { ...(a.hash ? { hash: String(a.hash) } : {}), ...(a.index !== undefined ? { index: Number(a.index) } : {}) };
        switch (a.action) {
          case 'list':
            return stashList(store.root);
          case 'show':
            return stashShow(store.root, ref);
          case 'push':
            return stashPush(store.root, String(a.name ?? ''), { dryRun: a.dryRun === true });
          case 'apply':
          case 'pop':
            return stashApply(store.root, ref, { pop: a.action === 'pop' });
          case 'drop':
            return { dropped: await stashDrop(store.root, ref) };
          default:
            throw new ApsError('ValidationError', 'action is list, show, push, apply, pop or drop');
        }
      },
    },
  ];
}
