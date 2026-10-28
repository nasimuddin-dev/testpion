import type { Exchange } from './model';

/** One collator for every sort (a localeCompare per comparison made one each). */
const COLLATOR = new Intl.Collator();

type Key = string | number;
interface Entry {
  row: Exchange;
  key: Key;
  /** The pass that last found this row in the list (a row not found left it). */
  mark?: number;
}

/** Equal keys keep the order of the session (seq), so an incremental insert lands where a full sort would have put the row. */
function compare(a: Entry, b: Entry, desc: boolean): number {
  const r = typeof a.key === 'number' && typeof b.key === 'number' ? a.key - b.key : COLLATOR.compare(String(a.key), String(b.key));
  return (desc ? -r : r) || (a.row.seq ?? 0) - (b.row.seq ?? 0);
}

/** More rows than this moved since the last answer: sorting all of them again is the cheaper way. */
const INCREMENTAL_MAX = (n: number) => Math.max(64, n >> 3);

/**
 * The grid's rows sorted by one column, kept between syncs. A list of thousands arrives as the same rows plus a handful
 * that are new or changed (about 100 ms apart during a capture): those are taken out and put back by binary search, the
 * key of every other row is not computed again. A different column or direction, or a big change, sorts all of them (the
 * key of each row once, not twice per comparison).
 */
export class SortedRows {
  private col = '';
  private desc = false;
  private entries: Entry[] = [];
  private byId = new Map<string, Entry>();
  private pass = 0;
  private source: Exchange[] | undefined;
  private result: Exchange[] = [];
  /** How the last answer was made, for the tests: `full` (everything sorted) or `incremental` (rows moved). */
  last: 'full' | 'incremental' | 'same' = 'full';

  sort(rows: Exchange[], col: string, desc: boolean, keyOf: (e: Exchange) => Key): Exchange[] {
    if (rows === this.source && col === this.col && desc === this.desc) return (this.last = 'same'), this.result;
    if (col === this.col && desc === this.desc && this.entries.length) {
      const out = this.incremental(rows, keyOf);
      if (out) {
        this.source = rows;
        return (this.result = out);
      }
    }
    return this.full(rows, col, desc, keyOf);
  }

  private full(rows: Exchange[], col: string, desc: boolean, keyOf: (e: Exchange) => Key): Exchange[] {
    this.last = 'full';
    const entries = rows.map((row) => ({ row, key: keyOf(row) }));
    entries.sort((a, b) => compare(a, b, desc));
    this.col = col;
    this.desc = desc;
    this.entries = entries;
    this.byId = new Map(entries.map((x) => [x.row.id, x]));
    this.source = rows;
    return (this.result = entries.map((x) => x.row));
  }

  /** The rows that are new or changed go in by binary search; undefined when too many moved (or rows left). */
  private incremental(rows: Exchange[], keyOf: (e: Exchange) => Key): Exchange[] | undefined {
    const limit = INCREMENTAL_MAX(rows.length);
    const moved: Entry[] = [];
    const retained = new Set<Entry>();
    const pass = ++this.pass;
    for (const row of rows) {
      const old = this.byId.get(row.id);
      if (!old) {
        if (moved.length >= limit) return undefined;
        moved.push({ row, key: keyOf(row) });
        continue;
      }
      old.mark = pass;
      if (old.row === row) continue;
      const key = keyOf(row);
      if (key === old.key) {
        // the same place: the entry only points at the new object
        old.row = row;
        continue;
      }
      if (moved.length >= limit) return undefined;
      retained.add(old); // taken out below
      moved.push({ row, key });
    }
    this.last = 'incremental';
    // the rows that left the list (the session's oldest, at its cap) and the ones that move are taken out
    const entries = this.entries.filter((x) => x.mark === pass && !retained.has(x));
    if (entries.length < this.entries.length) for (const x of this.entries) if (x.mark !== pass) this.byId.delete(x.row.id);
    moved.sort((a, b) => compare(a, b, this.desc));
    for (const m of moved) {
      let lo = 0;
      let hi = entries.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (compare(entries[mid]!, m, this.desc) <= 0) lo = mid + 1;
        else hi = mid;
      }
      entries.splice(lo, 0, m);
      this.byId.set(m.row.id, m);
    }
    this.entries = entries;
    return entries.map((x) => x.row);
  }
}
