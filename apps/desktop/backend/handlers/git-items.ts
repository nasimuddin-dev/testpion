/** RPC handlers: git per item (release B of planning/git-everything.md): versions, who changed what, restore, discard, stage, stash, undo. */
import {
  describeItemDiff,
  discardItem,
  itemBlame,
  itemHistory,
  itemLastChange,
  resolveItemTarget,
  runGit,
  type ItemLastChange,
  restoreItemVersion,
  stageItem,
  stashApply,
  stashDrop,
  stashList,
  stashPush,
  stashShow,
  undoJournal,
  type ItemTargetInput,
} from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import { restoreConflict, savedConflict, gitHelpers } from './git-undoable.js';

export function gitItemHandlers(be: Backend): Handlers {
  const { ws, rewritten, changed } = gitHelpers(be);
  const target = (p: ItemTargetInput) => resolveItemTarget(be.ws, p);
  /** The newest change of an item by HEAD (a hover asks for rows one after the other: a row is walked once per commit). */
  const lastChanges = new Map<string, ItemLastChange | null>();

  return {
    /** Where an item lives in git: its file and item id (a ref in, the address out), for the menus and dialogs. */
    'git.target': async (p: ItemTargetInput) => {
      const a = target(p);
      return { ...a, title: (await describeItemDiff(ws(), a.file, a.itemId)).title };
    },
    /** The commits that changed one item, each with what it changed (parts side by side). */
    'git.itemVersions': (p: ItemTargetInput & { limit?: number }) => itemHistory(ws(), target(p), p.limit),
    /** Who last changed an item and when, in one line (null: no commit has it yet). Asked on hover, so it is cached by HEAD. */
    'git.lastChange': async (p: ItemTargetInput) => {
      const a = target(p);
      const head = (await runGit(ws(), ['rev-parse', 'HEAD']).catch(() => '')).trim();
      if (!head) return null;
      const key = `${ws()}|${head}|${a.file}|${a.itemId ?? ''}`;
      const have = lastChanges.get(key);
      if (have !== undefined) return have;
      const r = (await itemLastChange(ws(), a).catch(() => undefined)) ?? null;
      if (lastChanges.size > 800) lastChanges.clear();
      lastChanges.set(key, r);
      return r;
    },
    /** Who last changed each field of an item. */
    'git.itemBlame': (p: ItemTargetInput & { limit?: number }) => itemBlame(ws(), target(p), p.limit),
    /** Put an older version of one item back (`dryRun`: only what would change). Undo with git.undo. */
    'git.itemRestore': ({ rev, dryRun, ...p }: ItemTargetInput & { rev: string; dryRun?: boolean }) =>
      dryRun ? restoreItemVersion(ws(), target(p), rev, { dryRun: true }) : rewritten(() => restoreItemVersion(ws(), target(p), rev)),
    /** Discard the uncommitted change of one item only. */
    'git.itemDiscard': ({ dryRun, ...p }: ItemTargetInput & { dryRun?: boolean }) => (dryRun ? discardItem(ws(), target(p), { dryRun: true }) : rewritten(() => discardItem(ws(), target(p)))),
    /** Stage or unstage the file an item is in (the result names the other changed items that come along). */
    'git.itemStage': async ({ unstage, dryRun, ...p }: ItemTargetInput & { unstage?: boolean; dryRun?: boolean }) => changed(await stageItem(ws(), target(p), { unstage, dryRun })),
    /** Undo the newest (or the given) restore / discard. */
    'git.undo': async ({ id }: { id?: string }) => {
      const conflict = savedConflict(ws(), id);
      const entry = await rewritten(() => undoJournal(ws(), id));
      if (conflict) await restoreConflict(ws(), conflict);
      return entry;
    },
    'git.stashList': () => stashList(ws()),
    'git.stashPush': async ({ name, dryRun }: { name: string; dryRun?: boolean }) => (dryRun ? stashPush(ws(), name, { dryRun: true }) : rewritten(() => stashPush(ws(), name))),
    'git.stashShow': (p: { index?: number; hash?: string }) => stashShow(ws(), p),
    'git.stashApply': ({ pop, ...p }: { index?: number; hash?: string; pop?: boolean }) => rewritten(() => stashApply(ws(), p, { pop })),
    'git.stashDrop': async (p: { index?: number; hash?: string }) => changed(await stashDrop(ws(), p)),
  };
}
