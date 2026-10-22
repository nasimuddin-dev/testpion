import { create } from 'zustand';
import type { Collection } from '../types';
import { afterScopeChange } from './ws-scope';

/**
 * The unsaved edits of a collection's own settings (variables, headers, auth, scripts, settings, description).
 * They live here, not in a view's state: the collection is read again whenever its outline refreshes (a save from a
 * request tab, the file watcher, a pull, an AI apply) and that must never wipe what is being typed.
 *
 * Per collection: `base` is the saved collection the edits were made on; `draft` is base plus the edits. A newer
 * saved version is merged field by field: a field the user did not touch takes the new value, a field they changed
 * keeps their edit, and a field both changed is a `conflict` the user decides ("Keep mine" / "Take the saved one").
 */
export const DRAFT_FIELDS = ['name', 'variables', 'headers', 'auth', 'preRequestScript', 'testScript', 'settings', 'description'] as const;
export type DraftField = (typeof DRAFT_FIELDS)[number];

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The fields where `draft` differs from `base`. */
export const changedFields = (base: Collection, draft: Collection): DraftField[] => DRAFT_FIELDS.filter((f) => !same(base[f], draft[f]));

export interface DraftEntry {
  base: Collection;
  draft: Collection;
  /** Fields the user changed that the saved collection changed too (differently) since. */
  conflict: DraftField[];
  /** The saved collection that conflicts, kept so "Take the saved one" has it. */
  theirs?: Collection;
}

/**
 * The draft after a newer saved version `incoming` arrived. Everything that is not a settings field (items, version,
 * updatedAt) is the saved one's; a settings field keeps the user's edit when they changed it.
 */
export function mergeDraft(entry: DraftEntry, incoming: Collection): DraftEntry {
  const mine = changedFields(entry.base, entry.draft);
  const draft: Collection = { ...incoming };
  const conflict: DraftField[] = [];
  for (const f of mine) {
    // the saved one did not change this field since the edit began (or changed it to the same thing): the edit stands
    if (!same(entry.base[f], incoming[f]) && !same(entry.draft[f], incoming[f])) conflict.push(f);
    (draft as unknown as Record<string, unknown>)[f] = entry.draft[f];
  }
  // the fields of a field both sides changed stay with the user until they choose
  return { base: incoming, draft, conflict: [...new Set([...entry.conflict, ...conflict])].filter((f) => changedFields(incoming, draft).includes(f)), theirs: conflict.length || entry.conflict.length ? incoming : undefined };
}

interface DraftsState {
  entries: Record<string, DraftEntry>;
}

export const useCollectionDrafts = create<DraftsState>(() => ({ entries: {} }));

const put = (id: string, e: DraftEntry | undefined) =>
  useCollectionDrafts.setState((s) => {
    const entries = { ...s.entries };
    if (e) entries[id] = e;
    else delete entries[id];
    return { entries };
  });

/** A saved collection was read: start a draft on it, or merge it into the one being edited. */
export function adoptSaved(saved: Collection): void {
  const cur = useCollectionDrafts.getState().entries[saved.id];
  if (!cur) return put(saved.id, { base: saved, draft: saved, conflict: [] });
  if (cur.base === saved) return;
  // untouched: the draft simply follows the saved collection
  if (!changedFields(cur.base, cur.draft).length) return put(saved.id, { base: saved, draft: saved, conflict: [] });
  put(saved.id, mergeDraft(cur, saved));
}

/** The user edited the collection: the new draft. */
export function editDraft(next: Collection): void {
  const cur = useCollectionDrafts.getState().entries[next.id];
  if (cur) put(next.id, { ...cur, draft: next });
}

/** The draft was written to disk: it is the saved collection now. */
export function markSaved(saved: Collection): void {
  put(saved.id, { base: saved, draft: saved, conflict: [] });
}

/** Throw the edits away. */
export function discardDraft(id: string): void {
  const cur = useCollectionDrafts.getState().entries[id];
  if (cur) put(id, { base: cur.base, draft: cur.base, conflict: [] });
}

/** Settle a conflict: keep the user's edits, or take the saved collection's fields. */
export function resolveConflict(id: string, take: 'mine' | 'theirs'): void {
  const cur = useCollectionDrafts.getState().entries[id];
  if (!cur) return;
  if (take === 'mine' || !cur.theirs) return put(id, { ...cur, conflict: [], theirs: undefined });
  const draft = { ...cur.draft };
  for (const f of cur.conflict) (draft as unknown as Record<string, unknown>)[f] = cur.theirs[f];
  put(id, { ...cur, draft, conflict: [], theirs: undefined });
}

/** The ids of the collections with unsaved edits. */
export const dirtyCollectionIds = (entries: Record<string, DraftEntry>): string[] => Object.keys(entries).filter((id) => changedFields(entries[id].base, entries[id].draft).length);

/** Forget every draft (another workspace). */
export function clearDrafts(): void {
  useCollectionDrafts.setState({ entries: {} });
}

// another workspace: its collections are other files
afterScopeChange(clearDrafts);
