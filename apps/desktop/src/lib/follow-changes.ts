/**
 * The pure part of WF-15 (lib/external-change.ts has the hook and the question): what an editor follows, and how a
 * change on disk is decided for each open item. No window APIs here: the unit tests drive it.
 */

/** The kinds of workspace files the watcher reports (core WorkspaceChangeKind). */
export type ChangeKind = 'collections' | 'environments' | 'tests' | 'datasets' | 'library' | 'mcp' | 'providers' | 'workspace' | 'specs' | 'other';

/** One item an editor has open: what it loaded (`base`, a snapshot) and whether it was edited since. */
export interface FollowedItem {
  key: string;
  /** Its name, for the question. */
  label: string;
  /** The snapshot of the saved version it was opened (or last saved) with; undefined: not saved yet (nothing to follow). */
  base: string | undefined;
  dirty: boolean;
}

export interface ExternalChangeOptions<T> {
  /** The file kinds that can hold these items. */
  kinds: ChangeKind[];
  /** The items open now (asked when a change arrives, so it is always current). */
  items(): FollowedItem[];
  /** Their saved versions now, read once for all: key → snapshot and value; a key missing from the map is gone (left as is). */
  read(keys: string[]): Promise<Map<string, { snapshot: string; value: T }>>;
  /** Show the new version (the edits, if any, are dropped). */
  take(key: string, value: T, snapshot: string): void;
  /** Keep the edits: the new version becomes the base, so saving replaces it with them. */
  keep(key: string, snapshot: string): void;
}

/** Questions one at a time, app-wide: two editors (or a burst of changes) never stack dialogs; a repeat for the same item and version is dropped. */
let queue: Promise<unknown> = Promise.resolve();
const asked = new Set<string>();
function serially<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (asked.has(key)) return Promise.resolve(undefined);
  asked.add(key);
  const run = queue.then(fn, fn).finally(() => asked.delete(key));
  queue = run.catch(() => undefined);
  return run;
}

/** Decide for every followed item, given what is on disk now (pure: the tests drive it). */
export async function followChanges<T>(o: Omit<ExternalChangeOptions<T>, 'kinds'>, decide: (label: string) => Promise<'mine' | 'theirs'>): Promise<void> {
  const open = o.items().filter((i) => i.base !== undefined);
  if (!open.length) return;
  const now = await o.read([...new Set(open.map((i) => i.key))]);
  for (const item of open) {
    const saved = now.get(item.key);
    if (!saved || saved.snapshot === item.base) continue;
    // decided on what the editor held before the read (reading may refresh what an editor compares with); an item
    // closed meanwhile is left alone
    if (!o.items().some((i) => i.key === item.key)) continue;
    if (!item.dirty) {
      o.take(item.key, saved.value, saved.snapshot);
      continue;
    }
    const choice = await serially(`${item.key}\u0000${saved.snapshot.length}:${saved.snapshot.slice(0, 64)}`, () => decide(item.label));
    if (choice === 'theirs') o.take(item.key, saved.value, saved.snapshot);
    else if (choice === 'mine') o.keep(item.key, saved.snapshot);
  }
}
