/** The collection the Save dialog was last used with: it is the dialog's default the next time (else the only collection, else the first). */
const KEY = 'aps.lastSaveCollection';

export function lastSaveCollection(): string | undefined {
  try {
    return localStorage.getItem(KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function rememberSaveCollection(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* storage unavailable: the dialog starts on the first collection */
  }
}

/** Which collection a Save dialog starts on: the one asked for, the last one used, else the first (with a single collection, that one). */
export function defaultSaveCollection(collections: Array<{ id: string }>, asked?: string): string {
  if (asked && collections.some((c) => c.id === asked)) return asked;
  const last = lastSaveCollection();
  if (last && collections.some((c) => c.id === last)) return last;
  return collections[0]?.id ?? '';
}
