import { existsSync, readFileSync, rmSync } from 'node:fs';
import { ApsError } from '../errors.js';
import { atomicWrite } from '../storage/fsutil.js';
import { canonicalText, stableValue } from '../storage/stable-files.js';
import { assertGitRev, gitLog, gitShow, gitStage, gitStatus, gitUnstage, gitVersion, repoRoot, runGit, toRepoPath, type GitCommit } from './git.js';
import { addNestedItem, addressOf, holdsNoItems, matchEol, readItem, removeNestedItem, sameText, workspaceFile, writeItem, type ItemAddress } from './item-address.js';
import { isBinaryPath } from './item-changes.js';
import { beginJournal } from './journal.js';
import { describeFile, describeGitChanges, diffTexts, type PartChange } from './semantic.js';
import { toLf } from '../util/text.js';

/**
 * The per-item git operations of release B (planning/git-everything.md §4c): the versions of one item and what changed
 * in each, who last changed each of its fields, putting an older version back, discarding the uncommitted change of one
 * item, and staging it. One implementation for the app, the CLI and the MCP tools. Every write has a plan that says what
 * would change (`dryRun` stops there) and is journaled, so it can be undone (git/journal.ts).
 */

/** Git must be there and the workspace in a repository, else a message that says what to do. */
export async function requireRepo(ws: string): Promise<string> {
  if (!(await gitVersion())) throw new ApsError('ConfigurationError', 'Git is not installed', { suggestions: ['Install Git from https://git-scm.com and restart TestPion.'] });
  const root = await repoRoot(ws);
  if (!root) throw new ApsError('ConfigurationError', 'The workspace is not in a git repository', { suggestions: ['Initialize it in the Git view, or run git init in the workspace folder.'] });
  return root;
}

const textAt = (ws: string, file: string, rev: string) => gitShow(ws, file, rev);

/** The file as the working folder has it; undefined when it is not there. */
function workingText(ws: string, file: string): string | undefined {
  try {
    return readFileSync(workspaceFile(ws, file), 'utf8');
  } catch {
    return undefined;
  }
}

/** The file in the index (what a commit would take); undefined when it is not staged / tracked. */
async function indexText(ws: string, file: string): Promise<string | undefined> {
  const repo = await requireRepo(ws);
  try {
    return await runGit(ws, ['show', `:${toRepoPath(repo, ws, file)}`]);
  } catch {
    return undefined;
  }
}

/** Put a text in the index as the file's staged content (cleaned the way `git add` would: line endings, filters). */
async function setIndexText(ws: string, file: string, text: string): Promise<void> {
  const repo = await requireRepo(ws);
  const path = toRepoPath(repo, ws, file);
  const sha = (await runGit(ws, ['hash-object', '-w', `--path=${path}`, '--stdin'], { input: text })).trim();
  const listed = (await runGit(ws, ['ls-files', '-s', '--', file]).catch(() => '')).trim().split(/\s+/)[0];
  await runGit(ws, ['update-index', '--add', '--cacheinfo', `${listed && /^\d{6}$/.test(listed) ? listed : '100644'},${sha},${path}`]);
}

const nameOf = (a: ItemAddress, text: string | undefined, fallback?: string): string => {
  if (text === undefined) return fallback ?? a.itemId ?? a.file;
  const t = diffTexts(a.file, a.itemId, undefined, text).title;
  return t || fallback || a.file;
};

/* ------------------------------------------------------------------ history and blame */

interface ItemVersion {
  commit: GitCommit;
  /** What this version changed, in words (the parts that differ from the version before; for a whole file its changes by item). */
  changed: string[];
  /** The parts that differ from the version before it, side by side. */
  parts: PartChange[];
}

interface ItemHistory {
  file: string;
  itemId?: string;
  title: string;
  /** Newest first: each commit that changed the item. */
  versions: ItemVersion[];
}

interface Walker {
  versions: Array<{ commit: GitCommit; text: string | undefined }>;
}

/** The commits that changed the item, each with the file as that commit had it. */
async function walkVersions(ws: string, a: ItemAddress, limit: number): Promise<Walker> {
  const repo = await requireRepo(ws);
  const commits = await gitLog(ws, { path: a.file, limit: limit * 4 });
  const cache = new Map<string, Promise<string | undefined>>();
  const textOf = (rev: string) => {
    let p = cache.get(rev);
    if (!p) cache.set(rev, (p = textAt(ws, a.file, rev)));
    return p;
  };
  /** What identifies the item's content in a commit; null: not there. A whole file is its blob (so a binary file works too). */
  const sig = async (rev: string): Promise<string | null> => {
    if (a.mode === 'whole') return (await runGit(ws, ['rev-parse', `${rev}:${toRepoPath(repo, ws, a.file)}`]).catch(() => '')).trim() || null;
    const it = readItem(a, await textOf(rev));
    return it === undefined ? null : JSON.stringify(stableValue(it));
  };
  const out: Walker['versions'] = [];
  for (const commit of commits) {
    const mine = await sig(commit.hash);
    if (mine === null) continue;
    // a version when the item differs from every parent (a merge that took one side made none)
    const parents = (await runGit(ws, ['rev-parse', `${commit.hash}^@`]).catch(() => '')).split('\n').filter(Boolean);
    let changed = true;
    for (const p of parents) if ((await sig(p)) === mine) changed = false;
    if (!changed) continue;
    out.push({ commit, text: isBinaryPath(a.file) ? undefined : await textOf(commit.hash) });
    if (out.length >= limit) break;
  }
  return { versions: out };
}

/** The item's versions in git with what each one changed (newest first). */
export async function itemHistory(ws: string, a: ItemAddress, limit = 30): Promise<ItemHistory> {
  const { versions } = await walkVersions(ws, a, limit);
  // a name that is no item and no file (a plain word typed for an item) is an error, not an empty history
  if (!versions.length) {
    const now = workingText(ws, a.file);
    const there = a.mode === 'whole' ? existsSync(workspaceFile(ws, a.file)) : readItem(a, now) !== undefined;
    if (!there)
      throw new ApsError('ValidationError', a.mode === 'whole' ? `"${a.file}" is not an item or a file of the workspace` : `There is no item ${a.itemId} in ${a.file}`, {
        suggestions: ['Name an item with a testpion:// link, a short ref such as mcp-server:weather, or a file path (path#itemId for an item inside a file).'],
      });
  }
  const out: ItemVersion[] = versions.map((v, i) => {
    const older = versions[i + 1]?.text;
    if (v.text === undefined) return { commit: v.commit, changed: ['binary file'], parts: [] };
    const parts = diffTexts(a.file, a.itemId, older, v.text).parts.filter((p) => p.differs);
    const changed =
      a.mode === 'whole' && a.kind !== undefined && a.kind !== 'workspace'
        ? describeFile(a.file, older, v.text, older === undefined ? 'added' : 'changed').map((c) => `${c.title}${c.details.length ? `: ${c.details.join(', ')}` : ''}`)
        : older === undefined
          ? ['created']
          : parts.map((p) => p.part);
    return { commit: v.commit, changed: changed.length ? changed : ['formatting only'], parts };
  });
  const latest = versions[0]?.text ?? workingText(ws, a.file);
  return { file: a.file, ...(a.itemId ? { itemId: a.itemId } : {}), title: nameOf(a, latest), versions: out };
}

interface BlameLine {
  /** The field (part) of the item: "URL", "Headers", "Name" …; for a whole file the same parts a Compare shows. */
  field: string;
  /** The value now (secrets are hidden by the parts, as in Compare). */
  value: string;
  /** The commit that last changed it; undefined while the change is not committed yet. */
  commit?: GitCommit;
  /** Changed since the last commit. */
  uncommitted?: boolean;
}

/**
 * Who last changed each field of an item, and when: the item's versions walked from the newest, a field belongs to the
 * newest version after which it never differed. Works the same for every kind, whatever the file's layout, line endings
 * or formatting commits; a field changed since the last commit is "not committed yet".
 */
export async function itemBlame(ws: string, a: ItemAddress, limit = 200): Promise<{ file: string; itemId?: string; title: string; fields: BlameLine[] }> {
  const { versions } = await walkVersions(ws, a, limit);
  const valuesOf = (text: string | undefined): Map<string, string> => new Map(text === undefined ? [] : diffTexts(a.file, a.itemId, undefined, text).parts.map((p) => [p.part, p.after ?? '']));
  const now = workingText(ws, a.file);
  const nowItem = a.mode === 'whole' ? now : readItem(a, now) === undefined ? undefined : now;
  const current = valuesOf(nowItem);
  const perVersion = versions.map((v) => valuesOf(v.text));
  const head = perVersion[0];
  const fields: BlameLine[] = [...current].map(([field, value]) => {
    if (!head || head.get(field) !== value) return { field, value, uncommitted: true };
    let idx = 0;
    for (let i = 1; i < perVersion.length; i++) {
      if (perVersion[i]!.get(field) === value) idx = i;
      else break;
    }
    return { field, value, commit: versions[idx]!.commit };
  });
  return { file: a.file, ...(a.itemId ? { itemId: a.itemId } : {}), title: nameOf(a, nowItem), fields };
}

/* ------------------------------------------------------------------ restore and discard */

export interface ItemWritePlan {
  op: 'restore' | 'discard';
  file: string;
  itemId?: string;
  title: string;
  /** The version put back (a commit; `HEAD` for a discard). */
  rev: string;
  /** Whether anything would change. */
  changed: boolean;
  /** What happens to the file. */
  action: 'replace-item' | 'remove-item' | 'replace-file' | 'delete-file' | 'nothing';
  /** The parts that change, now → after. */
  parts: PartChange[];
}

export interface ItemWriteResult extends ItemWritePlan {
  /** Written (false: a dry run, or nothing to change). */
  applied: boolean;
  /** The journal entry that undoes it (`testpion git undo <id>`, the app's Undo). */
  undoId?: string;
}

interface Prepared {
  plan: ItemWritePlan;
  /** The text to write (undefined with `delete`/binary). */
  text?: string;
  delete?: boolean;
  /** A whole binary file comes back from git itself. */
  binary?: boolean;
  head?: string;
}

const isBinary = (a: ItemAddress) => isBinaryPath(a.file);

async function prepareRestore(ws: string, a: ItemAddress, rev: string): Promise<Prepared> {
  assertGitRev(rev);
  await requireRepo(ws);
  const now = workingText(ws, a.file);
  if (a.mode === 'whole') {
    const target = isBinary(a) ? (await runGit(ws, ['cat-file', '-e', `${rev}:${toRepoPath((await requireRepo(ws)), ws, a.file)}`]).then(() => '', () => undefined)) : await textAt(ws, a.file, rev);
    if (target === undefined) throw new ApsError('ValidationError', `${a.file} is not in commit ${rev.slice(0, 7)}`);
    const title = nameOf(a, target || now);
    if (isBinary(a)) {
      const same = existsSync(workspaceFile(ws, a.file)) && (await sameBlob(ws, a.file, rev));
      return { binary: true, plan: { op: 'restore', file: a.file, title, rev, changed: !same, action: same ? 'nothing' : 'replace-file', parts: [] } };
    }
    const next = matchEol(now, target);
    const same = sameText(now, target);
    return { text: next, plan: { op: 'restore', file: a.file, title, rev, changed: !same, action: same ? 'nothing' : 'replace-file', parts: diffTexts(a.file, undefined, now, target).parts.filter((p) => p.differs) } };
  }
  const old = readItem(a, await textAt(ws, a.file, rev));
  if (old === undefined) throw new ApsError('ValidationError', `That item is not in commit ${rev.slice(0, 7)}`);
  const text = writeItem(a, now, old);
  if (text === undefined) throw new ApsError('ValidationError', `${a.file} cannot be read: fix it first`);
  const next = matchEol(now, text);
  const same = JSON.stringify(stableValue(readItem(a, now) ?? null)) === JSON.stringify(stableValue(old));
  return {
    text: next,
    plan: { op: 'restore', file: a.file, itemId: a.itemId, title: nameOf(a, text), rev, changed: !same, action: same ? 'nothing' : 'replace-item', parts: diffTexts(a.file, a.itemId, now, text).parts.filter((p) => p.differs) },
  };
}

async function sameBlob(ws: string, file: string, rev: string): Promise<boolean> {
  const repo = await requireRepo(ws);
  const [a, b] = await Promise.all([runGit(ws, ['hash-object', '--', file]), runGit(ws, ['rev-parse', `${rev}:${toRepoPath(repo, ws, file)}`])]);
  return a.trim() === b.trim();
}

async function prepareDiscard(ws: string, a: ItemAddress): Promise<Prepared> {
  await requireRepo(ws);
  const now = workingText(ws, a.file);
  const head = await textAt(ws, a.file, 'HEAD');
  if (a.mode === 'whole') {
    const title = nameOf(a, now ?? head);
    if (head === undefined && !existsSync(workspaceFile(ws, a.file))) throw new ApsError('ValidationError', `${a.file} has no changes to discard`);
    if (head === undefined && !isBinary(a)) return { delete: true, plan: { op: 'discard', file: a.file, title, rev: 'HEAD', changed: true, action: 'delete-file', parts: diffTexts(a.file, undefined, now, undefined).parts } };
    if (head === undefined) return { delete: true, plan: { op: 'discard', file: a.file, title, rev: 'HEAD', changed: true, action: 'delete-file', parts: [] } };
    if (isBinary(a)) {
      const same = existsSync(workspaceFile(ws, a.file)) && (await sameBlob(ws, a.file, 'HEAD'));
      return { binary: true, head, plan: { op: 'discard', file: a.file, title, rev: 'HEAD', changed: !same, action: same ? 'nothing' : 'replace-file', parts: [] } };
    }
    const same = sameText(now, head);
    return { text: matchEol(now, head), head, plan: { op: 'discard', file: a.file, title, rev: 'HEAD', changed: !same, action: same ? 'nothing' : 'replace-file', parts: diffTexts(a.file, undefined, now, head).parts.filter((p) => p.differs) } };
  }
  const was = readItem(a, head);
  const text = writeItem(a, now, was);
  if (text === undefined) throw new ApsError('ValidationError', `${a.file} cannot be read: fix it first`);
  const cur = readItem(a, now);
  const same = JSON.stringify(stableValue(cur ?? null)) === JSON.stringify(stableValue(was ?? null));
  return {
    text: matchEol(now, text),
    head,
    plan: { op: 'discard', file: a.file, itemId: a.itemId, title: nameOf(a, now ?? head), rev: 'HEAD', changed: !same, action: same ? 'nothing' : was === undefined ? 'remove-item' : 'replace-item', parts: diffTexts(a.file, a.itemId, now, text).parts.filter((p) => p.differs) },
  };
}

async function apply(ws: string, a: ItemAddress, p: Prepared, dryRun: boolean): Promise<ItemWriteResult> {
  if (dryRun || !p.plan.changed) return { ...p.plan, applied: false };
  const verb = p.plan.op === 'restore' ? `Restore ${p.plan.title} from ${p.plan.rev.slice(0, 7)}` : `Discard changes to ${p.plan.title}`;
  const entry = beginJournal(ws, p.plan.op, verb, [a.file]);
  const abs = workspaceFile(ws, a.file);
  if (p.delete) rmSync(abs, { force: true });
  else if (p.binary) await runGit(ws, ['restore', `--source=${p.plan.rev}`, '--worktree', '--', a.file]);
  else atomicWrite(abs, p.text!);
  if (p.plan.op === 'discard') await alignIndex(ws, a, p);
  return { ...p.plan, applied: true, undoId: entry.id };
}

/** After a discard the index must not keep the discarded change (a commit would take it): the same item goes back there too. */
async function alignIndex(ws: string, a: ItemAddress, p: Prepared): Promise<void> {
  const idx = await indexText(ws, a.file);
  if (idx === undefined) return;
  if (a.mode === 'whole' || p.head === undefined) return void (await gitUnstage(ws, [a.file]).catch(() => undefined));
  const was = readItem(a, p.head);
  if (JSON.stringify(stableValue(readItem(a, idx) ?? null)) === JSON.stringify(stableValue(was ?? null))) return;
  const fixed = writeItem(a, idx, was);
  if (fixed !== undefined) await setIndexText(ws, a.file, fixed);
}

/** Put an older version of one item (or file) back; the change is left for the user to commit. */
export async function restoreItemVersion(ws: string, a: ItemAddress, rev: string, o: { dryRun?: boolean } = {}): Promise<ItemWriteResult> {
  return apply(ws, a, await prepareRestore(ws, a, rev), !!o.dryRun);
}

/** Throw away the uncommitted change of one item: only that item goes back to the last commit, the rest of its file stays. */
export async function discardItem(ws: string, a: ItemAddress, o: { dryRun?: boolean } = {}): Promise<ItemWriteResult> {
  return apply(ws, a, await prepareDiscard(ws, a), !!o.dryRun);
}

/* ------------------------------------------------------------------ stage */

interface ItemStageResult {
  file: string;
  itemId?: string;
  title: string;
  /** The file was staged (false: a dry run or nothing changed). */
  applied: boolean;
  /** Staging takes the file: the other changed items in it come along (their titles). Empty when only this item was staged. */
  alsoStages: string[];
  /** Only this item's change went into the index (its file keeps its other changes unstaged). */
  partial?: boolean;
  /** For a partial stage: the other changed items of the file, which stay unstaged. */
  leftUnstaged?: string[];
  /** In words, for the toast and the CLI: "Staged mcp-servers.json (it also holds 2 other changed items)". */
  message: string;
}

/**
 * Stage (or unstage) one item. In a file that holds several items (a collection, an MCP servers or providers list, a library)
 * only that item's change goes into the index: the staged version of the file is the last staged (or committed) one with this
 * item replaced, written by the same serializer the app saves with, and checked by putting the old item back (the other items
 * must come out byte for byte as they were, else the whole file is staged instead and the result says so). A file that is
 * one item, a new file, or one whose staged version is not in the stable form stages as one file, naming the other changed
 * items that come along, so nobody commits more than they meant.
 */
export async function stageItem(ws: string, a: ItemAddress, o: { unstage?: boolean; dryRun?: boolean } = {}): Promise<ItemStageResult> {
  await requireRepo(ws);
  const st = await gitStatus(ws);
  const f = st.files.find((x) => x.path === a.file);
  const changes = f ? await describeGitChanges(ws, [f]) : [];
  const mine = changes.find((c) => (a.itemId ? c.itemId === a.itemId : true));
  const title = mine?.title ?? nameOf(a, workingText(ws, a.file));
  if (!f) return { file: a.file, itemId: a.itemId, title, applied: false, alsoStages: [], message: `${title} has no uncommitted changes` };
  if (a.mode !== 'whole' && f.state !== 'conflicted') {
    const partial = await stageItemBlob(ws, a, title, changes.filter((c) => c.itemId !== a.itemId).map((c) => c.title), o);
    if (partial) return partial;
  }
  const alsoStages = a.itemId ? changes.filter((c) => c.itemId !== a.itemId).map((c) => c.title) : [];
  if (!o.dryRun) await (o.unstage ? gitUnstage(ws, [a.file]) : gitStage(ws, [a.file]));
  const other = alsoStages.length ? ` (it also holds ${alsoStages.length} other changed item${alsoStages.length === 1 ? '' : 's'}: ${alsoStages.slice(0, 3).join(', ')}${alsoStages.length > 3 ? ' …' : ''})` : '';
  return { file: a.file, itemId: a.itemId, title, applied: !o.dryRun, alsoStages, message: `${o.dryRun ? 'Would ' + (o.unstage ? 'unstage' : 'stage') : o.unstage ? 'Unstaged' : 'Staged'} ${a.file}${other}` };
}

/** The item staged alone, or undefined when the file has to be staged whole (see {@link stageItem}). */
async function stageItemBlob(ws: string, a: ItemAddress, title: string, others: string[], o: { unstage?: boolean; dryRun?: boolean }): Promise<ItemStageResult | undefined> {
  const [head, idx, work] = [await textAt(ws, a.file, 'HEAD'), await indexText(ws, a.file), workingText(ws, a.file)];
  const base = idx ?? head;
  const verb = o.unstage ? 'unstage' : 'stage';
  // a staged version that is not stable would stage the formatting of every other item too: the file goes whole
  if (base !== undefined && canonicalText(a.file, base) !== toLf(base)) return undefined;
  let next: string | undefined;
  let emptied = false;
  if (base === undefined) {
    // a new file with nothing in the index yet: the item goes in alone, under the file's own header (id, name, variables …)
    if (o.unstage || work === undefined) return undefined;
    const value = readItem(a, work);
    if (value === undefined) return undefined;
    next = a.mode === 'nested' ? addNestedItem(a, undefined, work) : writeItem(a, undefined, value);
  } else {
    // a deleted file: the item's deletion is staged alone (the index copy keeps the file's other items)
    const source = o.unstage ? head : work;
    const value = readItem(a, source);
    const before = readItem(a, base);
    if (a.mode === 'nested' && before === undefined && value !== undefined) {
      // a nested item that is new, or one deleted and put back: placed under its folders in the index copy (the folders it needs are made)
      next = addNestedItem(a, base, source);
    } else if (a.mode === 'nested' && before !== undefined && value === undefined) {
      // a nested item taken out of the index copy (unstaging what is new, staging a deletion): the folders it leaves empty go too when they are new
      next = removeNestedItem(a, base, head);
    } else {
      next = writeItem(a, base, value);
      if (next === undefined) return undefined;
      // exact or not at all: putting the item back must give the index copy as it was
      const back = writeItem(a, next, before);
      if (back === undefined || !sameText(back, writeItem(a, base, before))) return undefined;
    }
    // the last item of a file that is not committed yet leaves the index with the file
    emptied = o.unstage === true && head === undefined && next !== undefined && holdsNoItems(a, next);
  }
  if (next === undefined) return undefined;
  if (base !== undefined && sameText(next, base)) return { file: a.file, itemId: a.itemId, title, applied: false, alsoStages: [], partial: true, leftUnstaged: others, message: `${title} is already ${o.unstage ? 'unstaged' : 'staged'}` };
  if (!o.dryRun) await (emptied ? gitUnstage(ws, [a.file]) : setIndexText(ws, a.file, next));
  const left = others.length ? `; the file's ${others.length} other changed item${others.length === 1 ? '' : 's'} stay${others.length === 1 ? 's' : ''} ${o.unstage ? 'as they are' : 'unstaged'}` : '';
  return {
    file: a.file,
    itemId: a.itemId,
    title,
    applied: !o.dryRun,
    alsoStages: [],
    partial: true,
    leftUnstaged: others,
    message: `${o.dryRun ? `Would ${verb}` : o.unstage ? 'Unstaged' : 'Staged'} ${title} only${left}`,
  };
}

export { addressOf };
