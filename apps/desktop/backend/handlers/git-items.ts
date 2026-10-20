/** RPC handlers: git per item (release B of planning/git-everything.md): versions, who changed what, restore, discard, stage, stash, undo. */
import {
  describeItemDiff,
  discardItem,
  gitLog,
  itemBlame,
  itemHistory,
  listJournal,
  resolveItemTarget,
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

export function gitItemHandlers(be: Backend): Handlers {
  const ws = () => be.ws.root;
  /** After the operation rewrote workspace files: reload and tell the views, without the "changed outside TestPion" notice. */
  const rewritten = async <T>(op: () => Promise<T> | T): Promise<T> => {
    try {
      return await op();
    } finally {
      be.adoptDiskState();
      be.ws.reloadWorkspaceFile();
      be.host.emit('data.changed', { method: 'git' });
      be.host.emit('git.changed', {});
    }
  };
  const changed = <T>(r: T): T => (be.host.emit('git.changed', {}), r);
  const target = (p: ItemTargetInput) => resolveItemTarget(be.ws, p);

  return {
    /** Where an item lives in git: its file and item id (a ref in, the address out), for the menus and dialogs. */
    'git.target': async (p: ItemTargetInput) => {
      const a = target(p);
      return { ...a, title: (await describeItemDiff(ws(), a.file, a.itemId)).title };
    },
    /** The commits that changed one item, each with what it changed (parts side by side). */
    'git.itemVersions': (p: ItemTargetInput & { limit?: number }) => itemHistory(ws(), target(p), p.limit),
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
    'git.undo': ({ id }: { id?: string }) => rewritten(() => undoJournal(ws(), id)),
    'git.undoList': () => listJournal(ws()),
    /** The workspace's recent commits touching one file (the timeline of a whole-file item). */
    'git.fileLog': ({ file, limit }: { file: string; limit?: number }) => gitLog(ws(), { path: file, limit }),
    'git.stashList': () => stashList(ws()),
    'git.stashPush': async ({ name, dryRun }: { name: string; dryRun?: boolean }) => (dryRun ? stashPush(ws(), name, { dryRun: true }) : rewritten(() => stashPush(ws(), name))),
    'git.stashShow': (p: { index?: number; hash?: string }) => stashShow(ws(), p),
    'git.stashApply': ({ pop, ...p }: { index?: number; hash?: string; pop?: boolean }) => rewritten(() => stashApply(ws(), p, { pop })),
    'git.stashDrop': async (p: { index?: number; hash?: string }) => changed(await stashDrop(ws(), p)),
  };
}
