/**
 * Virtual-folder membership in a bundle. API definitions and datasets sit in folders of the list that exist only in
 * `library/spec-folders.json` / `library/dataset-folders.json` (the files never move). A bundle carries a file's folder
 * as the item's `folder`, and the importer puts the file in a folder of that name. (MCP servers and the saved items of the
 * libraries keep their folder inside the item, so they need nothing here.)
 */
import type { WorkspaceStore } from '../storage/workspace.js';
import type { BundleKindId } from './format.js';
import { plainName } from './format.js';
import type { JournalSink } from './items.js';

const LIBRARY: Partial<Record<BundleKindId, 'spec-folders' | 'dataset-folders'>> = { spec: 'spec-folders', dataset: 'dataset-folders' };

/** How the folder library names a file: a spec by its path (`specs/a.yaml`), a dataset by its name under datasets/. */
const keyOf = (kind: BundleKindId, id: string): string => (kind === 'dataset' ? id.replace(/^datasets\//, '') : id);

/** Whether files of this kind can sit in a virtual folder. */
export const hasVirtualFolders = (kind: BundleKindId): boolean => kind in LIBRARY;

/** The virtual folder a file is in (undefined: the top level, or a kind without folders). */
export function virtualFolderOf(store: WorkspaceStore, kind: BundleKindId, id: string): string | undefined {
  const lib = LIBRARY[kind];
  if (!lib) return undefined;
  const folder = store.getLibrary(lib).items.find((i) => i.id === keyOf(kind, id))?.folder;
  return folder || undefined;
}

/** Put imported files in their folders (a folder that does not exist yet is made); returns how many were placed. One write per library. */
export function placeInFolders(store: WorkspaceStore, rows: ReadonlyArray<{ kind: BundleKindId; id: string; folder?: string }>, journal: JournalSink): number {
  let placed = 0;
  for (const lib of ['spec-folders', 'dataset-folders'] as const) {
    const mine = rows.filter((r) => LIBRARY[r.kind] === lib && r.folder && plainName(r.folder, ''));
    if (!mine.length) continue;
    const file = `library/${lib}.json`;
    const current = store.getLibrary(lib);
    const folders = [...current.folders];
    const items = current.items.map((i) => ({ ...i }));
    for (const r of mine) {
      const folder = plainName(r.folder, '');
      if (!folders.includes(folder)) folders.push(folder);
      const key = keyOf(r.kind, r.id);
      const at = items.findIndex((i) => i.id === key);
      if (at >= 0) items[at] = { ...items[at]!, folder };
      else items.push({ id: key, name: key, folder, data: null });
      placed++;
    }
    journal.before(file);
    store.saveLibrary(lib, { folders, items });
    journal.after(file);
  }
  return placed;
}
