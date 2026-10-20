import { gitRefKey, type ItemRef } from '@testpion/shared';
import { call } from '../api';
import { confirmAction, toastError, useApp } from '../store';
import { gitSnapshot } from './git';
import { icon, type Act, type ActionId, type NodeKind, type NodeMenuCtx } from './node-menu-actions';
import type { MenuItem } from '../components/ui';
import { LABEL } from './vocabulary';
import { plural } from './format';

/**
 * The git group of every item's menu, from one place (release B of planning/git-everything.md): History in git… (versions,
 * who changed what, Restore this version), Stage changes, Discard changes… (this item only). A view never writes these
 * handlers: any row that knows its ref gets them, for every versioned kind, and the registry's capabilities decide whether
 * the menu shows them at all.
 */

/** What the History dialog shows first. */
export type GitItemTab = 'versions' | 'blame';

export const openGitItem = (ref: ItemRef, name: string, tab: GitItemTab = 'versions'): void => useApp.getState().set({ gitItem: { ref, name, tab } });

interface PartChange {
  part: string;
  before?: string;
  after?: string;
  differs: boolean;
}
export interface ItemWritePlan {
  title: string;
  file: string;
  itemId?: string;
  changed: boolean;
  action: 'replace-item' | 'remove-item' | 'replace-file' | 'delete-file' | 'nothing';
  parts: PartChange[];
  undoId?: string;
  applied?: boolean;
}

const short = (s?: string) => {
  const one = (s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > 70 ? `${one.slice(0, 67)}…` : one || '(empty)';
};

/** The parts a write would change, one line each: "URL: old → new". */
export const partsLines = (parts: PartChange[], max = 6): string =>
  [...parts.slice(0, max).map((p) => `${p.part}: ${short(p.before)} → ${p.after === undefined ? '(removed)' : short(p.after)}`), ...(parts.length > max ? [`… and ${plural(parts.length - max, 'more part')}`] : [])].join('\n');

/** A message with Undo (the normal toast): the journal entry of the write puts the file back. */
export function toastWithUndo(message: string, undoId: string | undefined): void {
  useApp.getState().toast(message, 'info', undefined, undoId ? { undo: async () => void (await call('git.undo', { id: undoId })), restored: 'Put back as it was' } : undefined);
}

/** Discard the uncommitted change of one item: the preview (what changes) first, then the write, with Undo. */
export async function discardGitItem(ref: ItemRef, name: string): Promise<void> {
  try {
    const plan = await call<ItemWritePlan>('git.itemDiscard', { ref, dryRun: true });
    if (!plan.changed) return useApp.getState().toast(`${plan.title} has no uncommitted changes`, 'info');
    const what = plan.action === 'remove-item' ? 'This item is new: it is removed.' : plan.action === 'delete-file' ? 'This file is new: it is deleted.' : 'It goes back to the last commit.';
    const ok = await confirmAction({
      title: 'Discard changes',
      message: `Throw away your changes to ${plan.title}?`,
      detail: `${what}${plan.itemId ? ` The other changes in ${plan.file} stay.` : ''}\n\n${partsLines(plan.parts)}`.trim(),
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    const done = await call<ItemWritePlan>('git.itemDiscard', { ref });
    toastWithUndo(`Discarded the changes to ${name || done.title}`, done.undoId);
  } catch (e) {
    toastError(e);
  }
}

/** Stage (or unstage) the file an item is in; the message says when other changed items come along. */
export async function stageGitItem(ref: ItemRef, unstage = false): Promise<void> {
  try {
    const r = await call<{ message: string; applied: boolean }>('git.itemStage', { ref, unstage });
    useApp.getState().toast(r.message, r.applied ? 'success' : 'info');
  } catch (e) {
    toastError(e);
  }
}

/** The git submenu of a node with an ItemRef: History in git…, Stage changes, Discard changes… (the last two disabled while nothing changed). */
export function gitActions(_kind: NodeKind, c: NodeMenuCtx): { repo: boolean; on: Partial<Record<ActionId, Act>>; disabled: Partial<Record<ActionId, string>> } | undefined {
  const ref = c.ref;
  if (!ref) return undefined;
  const snap = gitSnapshot();
  const repo = snap.status?.repository === true;
  const name = c.name ?? '';
  const none = repo && !snap.marks.has(gitRefKey(ref)) ? 'No uncommitted changes' : undefined;
  const items: MenuItem[] = [
    { label: LABEL.historyInGit, icon: icon('history'), onSelect: () => openGitItem(ref, name) },
    { label: LABEL.stageInGit, icon: icon('git-compare'), onSelect: () => void stageGitItem(ref), ...(none ? { disabled: true, title: none } : {}) },
    { label: LABEL.discardInGit, icon: icon('rotate-ccw'), onSelect: () => void discardGitItem(ref, name), ...(none ? { disabled: true, title: none } : {}) },
  ];
  return { repo, on: { gitMenu: items }, disabled: {} };
}
