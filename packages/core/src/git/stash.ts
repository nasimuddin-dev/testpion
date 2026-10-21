import { ApsError } from '../errors.js';
import { gitStatus, runGit } from './git.js';
import { requireRepo } from './item-ops.js';
import { describeGitChanges, describeRevChanges, type SemanticChange } from './semantic.js';

/**
 * Set the workspace's uncommitted changes aside with a name, and put them back (release B of planning/git-everything.md):
 * `git stash` limited to the workspace folder (untracked files too), listed with what each holds by item.
 */
interface StashEntry {
  /** Position in git's stash list now (0 = newest): it shifts when others are made or dropped, so use `hash` to be sure. */
  index: number;
  hash: string;
  /** The name it was given ("Before the pagination rewrite"). */
  name: string;
  branch?: string;
  date: string;
  /** Made by TestPion (not by `git stash` in a terminal). */
  ours: boolean;
}

const PREFIX = 'TestPion: ';

export async function stashList(ws: string): Promise<StashEntry[]> {
  await requireRepo(ws);
  const out = await runGit(ws, ['stash', 'list', '--format=%H%x1f%gs%x1f%aI']).catch(() => '');
  return out
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      const [hash, subject, date] = line.split('\x1f');
      const m = /^(?:WIP on|On) ([^:]+): ([\s\S]*)$/.exec(subject ?? '');
      const rest = m?.[2] ?? subject ?? '';
      const ours = rest.startsWith(PREFIX);
      return { index, hash: hash!, name: ours ? rest.slice(PREFIX.length) : rest, ...(m?.[1] ? { branch: m[1] } : {}), date: date ?? '', ours };
    });
}

async function find(ws: string, ref: { index?: number; hash?: string }): Promise<StashEntry> {
  const list = await stashList(ws);
  const hit = ref.hash ? list.find((e) => e.hash === ref.hash || e.hash.startsWith(ref.hash!)) : list.find((e) => e.index === (ref.index ?? 0));
  if (!hit) throw new ApsError('ValidationError', 'No such stash', { suggestions: [list.length ? `Stashes: ${list.map((e) => `${e.index} ${e.name}`).join('; ')}` : 'There are no stashes: set changes aside first.'] });
  return hit;
}

interface StashPushResult {
  name: string;
  applied: boolean;
  /** The changes set aside (or that would be), by item. */
  changes: SemanticChange[];
  stash?: StashEntry;
}

/** Set every uncommitted change of the workspace aside under a name; the workspace goes back to the last commit. */
export async function stashPush(ws: string, name: string, o: { dryRun?: boolean } = {}): Promise<StashPushResult> {
  await requireRepo(ws);
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!n) throw new ApsError('ValidationError', 'Give the stash a name, e.g. "Before the pagination rewrite"');
  if (n.length > 120) throw new ApsError('ValidationError', 'The name is too long (120 characters at most)');
  const st = await gitStatus(ws);
  if (st.conflicted) throw new ApsError('ValidationError', 'Resolve the conflicts before setting changes aside');
  if (!st.files.length) throw new ApsError('ValidationError', 'There are no changes to set aside');
  const changes = await describeGitChanges(ws, st.files);
  if (o.dryRun) return { name: n, applied: false, changes };
  await runGit(ws, ['stash', 'push', '--include-untracked', '-m', PREFIX + n, '--', '.']);
  return { name: n, applied: true, changes, stash: (await stashList(ws))[0] };
}

/** What a stash holds, by item (tracked changes by meaning; new files listed). */
export async function stashShow(ws: string, ref: { index?: number; hash?: string } = {}): Promise<{ stash: StashEntry; changes: SemanticChange[]; newFiles: string[] }> {
  const stash = await find(ws, ref);
  const changes = await describeRevChanges(ws, `${stash.hash}^`, stash.hash);
  const newFiles = (await runGit(ws, ['show', '--name-only', '--format=', `${stash.hash}^3`]).catch(() => '')).split('\n').filter(Boolean);
  return { stash, changes, newFiles };
}

interface StashApplyResult {
  stash: StashEntry;
  /** Put back and removed from the list (pop), or kept (apply). */
  dropped: boolean;
  /** The changes conflict with the workspace as it is now: settle them in the Git view / `testpion git conflicts`; the stash is kept. */
  conflicted: boolean;
  message: string;
}

/** Put a stash back (`pop` also removes it). Conflicts leave the stash in the list and the files in the conflict list. */
export async function stashApply(ws: string, ref: { index?: number; hash?: string } = {}, o: { pop?: boolean } = {}): Promise<StashApplyResult> {
  const stash = await find(ws, ref);
  try {
    await runGit(ws, ['stash', o.pop ? 'pop' : 'apply', `stash@{${stash.index}}`]);
  } catch (e) {
    if ((await gitStatus(ws)).conflicted) return { stash, dropped: false, conflicted: true, message: `"${stash.name}" conflicts with the workspace as it is now: resolve the conflicts below (the stash is kept until you drop it).` };
    throw e;
  }
  return { stash, dropped: !!o.pop, conflicted: false, message: o.pop ? `Put back "${stash.name}" and removed it from the list` : `Put back "${stash.name}" (it stays in the list)` };
}

export async function stashDrop(ws: string, ref: { index?: number; hash?: string } = {}): Promise<StashEntry> {
  const stash = await find(ws, ref);
  await runGit(ws, ['stash', 'drop', `stash@{${stash.index}}`]);
  return stash;
}
