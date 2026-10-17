/**
 * React keys of list rows must be unique among siblings: with two rows under one key React keeps one component for
 * both, and a row is drawn at a stale place or not at all (B-01: two collections sharing request ids drew one request
 * at several places and dropped others). Every list (VirtualList, the plain lists of the sidebar) takes its keys from
 * here: a repeated key is reported in development builds, and the later rows get a suffix so React never merges them.
 */
export type ListKey = string | number;

export interface DuplicateKey {
  key: ListKey;
  /** Positions (in the list given) of the first row with the key and of the repeat. */
  first: number;
  second: number;
}

/** The keys, each unique: a repeat becomes `<key>~2`, `<key>~3` … (in list order, so a row keeps its key while the list does). */
export function dedupeKeys(keys: readonly ListKey[]): { keys: ListKey[]; duplicates: DuplicateKey[] } {
  const firstAt = new Map<ListKey, number>();
  const out: ListKey[] = new Array(keys.length);
  const duplicates: DuplicateKey[] = [];
  let used: Set<ListKey> | undefined;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const at = firstAt.get(k);
    if (at === undefined) {
      firstAt.set(k, i);
      out[i] = k;
      continue;
    }
    duplicates.push({ key: k, first: at, second: i });
    // the suffix must not hit a key the list has elsewhere
    used ??= new Set(keys);
    let n = 2;
    while (used.has(`${k}~${n}`)) n++;
    const next = `${k}~${n}`;
    used.add(next);
    out[i] = next;
  }
  return { keys: out, duplicates };
}

/** Whether to report repeated keys: development builds only (never in what users run). */
export const reportsDuplicateKeys = (): boolean => !!import.meta.env?.DEV;

const reported = new Set<string>();

/**
 * Report each repeated key once per list (`where`): the key and both items, on the console as an error, so a test
 * that fails on console errors catches it. Returns how many were reported now.
 */
export function reportDuplicateKeys<T>(where: string, duplicates: readonly DuplicateKey[], itemAt: (index: number) => T, log: (...args: unknown[]) => void = console.error): number {
  let n = 0;
  for (const d of duplicates) {
    const id = `${where}\u0000${String(d.key)}`;
    if (reported.has(id)) continue;
    reported.add(id);
    n++;
    log(`[TestPion] ${where}: two rows share the key "${String(d.key)}" (rows ${d.first} and ${d.second}); the second is drawn as a row of its own.`, itemAt(d.first), itemAt(d.second));
  }
  return n;
}

/** For tests: forget what was reported. */
export const forgetReportedKeys = () => reported.clear();

/** Unique keys for a whole list (a plain list renders every row): reported in development, suffixed always. */
export function uniqueKeys<T>(items: readonly T[], keyOf: (item: T, index: number) => ListKey, where: string, report = reportsDuplicateKeys()): ListKey[] {
  const r = dedupeKeys(items.map(keyOf));
  if (r.duplicates.length && report) reportDuplicateKeys(where, r.duplicates, (i) => items[i]);
  return r.keys;
}
