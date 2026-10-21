import { LABEL } from './vocabulary';

/**
 * Every list of saved items that has folders keeps ALL its items in folders: an item with none is in the built-in
 * default folder (LABEL.defaultFolder, "General"). The folder is a view of the list, not stored data: an item in no folder
 * stays `folder: undefined` in its file (no migration, quiet git diffs), and one whose stored folder is literally "General"
 * is in it too. This is the one place that grouping happens: FolderList (saved prompts, evaluations, load tests, monitors,
 * RAG targets) and the explorer's sections (MCP servers, API definitions, datasets) both call it.
 */
export const DEFAULT_FOLDER: string = LABEL.defaultFolder;

/** The folder an item is shown in: its own, or General when it has none. */
export const folderOf = (folder: string | undefined): string => folder || DEFAULT_FOLDER;

/** The folder to store for a chosen one: General is stored as no folder. */
export const storedFolder = (folder: string | undefined): string | undefined => (!folder || folder === DEFAULT_FOLDER ? undefined : folder);

/** The folder names a list shows: General first (always), then every other folder (kept ones and the ones items are in), sorted. */
export function folderNamesOf(folders: readonly string[], items: ReadonlyArray<{ folder?: string }>, def: string = DEFAULT_FOLDER): string[] {
  const others = new Set<string>();
  for (const f of folders) if (f && f !== def) others.add(f);
  for (const i of items) if (i.folder && i.folder !== def) others.add(i.folder);
  return [def, ...[...others].sort((a, b) => a.localeCompare(b))];
}

/**
 * The items of each folder, grouped once: the ordered folder names (General first) and the items of each. No item is left
 * outside a folder, so a list draws nothing at its top level.
 */
export function groupByFolder<T extends { folder?: string }>(items: readonly T[], folders: readonly string[], def: string = DEFAULT_FOLDER): { names: string[]; byFolder: Map<string, T[]> } {
  const names = folderNamesOf(folders, items, def);
  const byFolder = new Map<string, T[]>(names.map((n) => [n, []]));
  for (const i of items) byFolder.get(i.folder || def)!.push(i);
  return { names, byFolder };
}

/** The folder names to keep in a file: General is never kept (it always exists). */
export const keptFolders = (folders: readonly string[], def: string = DEFAULT_FOLDER): string[] => folders.filter((f) => f !== def);

/** Why General can't be renamed or deleted (the reason shown on its disabled menu items). */
export const DEFAULT_FOLDER_WHY = `${DEFAULT_FOLDER} is built in: it always exists and holds the items that have no folder`;
