import { describe, expect, it } from 'vitest';
import { SortedRows } from '../../apps/desktop/src/components/debugger/sorted-rows';
import type { Exchange } from '../../apps/desktop/src/components/debugger/model';
import { expectWithin } from '../perf-budget';

/**
 * The grid keeps its sorted rows between syncs (performance review 2026-10-27, item 10): the rows that came in or
 * changed are inserted by binary search, and the answer is the one a full sort gives.
 */
const row = (i: number, over: Partial<Exchange> = {}): Exchange =>
  ({ id: `e-${i}`, seq: i + 1, url: `https://h${i % 13}.test/p/${(i * 7919) % 1000}`, durationMs: (i * 31) % 500, ...over }) as Exchange;
const list = (n: number) => Array.from({ length: n }, (_, i) => row(i));
const urlKey = (e: Exchange) => e.url;
const durKey = (e: Exchange) => e.durationMs ?? -1;
const fresh = (rows: Exchange[], col: string, desc: boolean, key: (e: Exchange) => string | number) => new SortedRows().sort(rows, col, desc, key).map((r) => r.id);
const ids = (rows: Exchange[]) => rows.map((r) => r.id);

describe('SortedRows', () => {
  for (const desc of [false, true]) {
    it(`inserts new rows and moves changed ones like a full sort (${desc ? 'descending' : 'ascending'}, text and number keys)`, () => {
      for (const [col, key] of [['url', urlKey], ['duration', durKey]] as const) {
        const s = new SortedRows();
        let rows = list(1000);
        s.sort(rows, col, desc, key);
        for (let round = 0; round < 20; round++) {
          rows = rows.slice();
          // 10 new rows at the end, 5 rows whose key changed, 5 rows replaced by an equal copy
          for (let k = 0; k < 10; k++) rows.push(row(1000 + round * 10 + k));
          for (let k = 0; k < 5; k++) {
            const i = (round * 97 + k * 31) % 1000;
            rows[i] = { ...rows[i]!, durationMs: (round * 13 + k) % 500, url: rows[i]!.url + 'x' };
          }
          for (let k = 0; k < 5; k++) rows[(round * 53 + k * 17 + 3) % 1000] = { ...rows[(round * 53 + k * 17 + 3) % 1000]! };
          const got = ids(s.sort(rows, col, desc, key));
          expect(s.last).toBe('incremental');
          expect(got).toEqual(fresh(rows, col, desc, key));
        }
      }
    });
  }

  it('sorts everything again for a new column, a direction or a big change; the same list is answered as it was', () => {
    const s = new SortedRows();
    const rows = list(500);
    const a = s.sort(rows, 'url', false, urlKey);
    expect(s.sort(rows, 'url', false, urlKey)).toBe(a);
    expect(s.last).toBe('same');
    s.sort(rows, 'url', true, urlKey);
    expect(s.last).toBe('full');
    s.sort(rows, 'duration', true, durKey);
    expect(s.last).toBe('full');
    const fewer = rows.slice(10);
    expect(ids(s.sort(fewer, 'duration', true, durKey))).toEqual(fresh(fewer, 'duration', true, durKey));
    expect(s.last).toBe('incremental'); // the oldest rows left (the session's cap): taken out, nothing sorted again
    const swap = [...fewer.slice(20), ...list(5).map((x, i) => row(900 + i, { url: x.url + 'z' }))];
    expect(ids(s.sort(swap, 'duration', true, durKey))).toEqual(fresh(swap, 'duration', true, durKey));
    expect(s.last).toBe('incremental');
    const more = [...fewer, ...Array.from({ length: 300 }, (_, i) => row(1000 + i))];
    expect(ids(s.sort(more, 'duration', true, durKey))).toEqual(fresh(more, 'duration', true, durKey));
    expect(s.last).toBe('full');
  });

  it('a sync of 5,000 rows with 200 new ones is far cheaper than sorting them all', () => {
    const s = new SortedRows();
    let rows = list(5000);
    s.sort(rows, 'url', false, urlKey);
    const times: number[] = [];
    for (let round = 0; round < 10; round++) {
      rows = [...rows, ...Array.from({ length: 200 }, (_, i) => row(5000 + round * 200 + i))].slice(200);
      const t0 = performance.now();
      s.sort(rows, 'url', false, urlKey);
      times.push(performance.now() - t0);
    }
    expect(s.last).toBe('incremental');
    // and the pure growth case
    rows = list(5000);
    s.sort(rows, 'url', false, urlKey);
    const grow: number[] = [];
    for (let round = 0; round < 10; round++) {
      rows = [...rows, ...Array.from({ length: 100 }, (_, i) => row(6000 + round * 100 + i))];
      const t0 = performance.now();
      s.sort(rows, 'url', false, urlKey);
      grow.push(performance.now() - t0);
      expect(s.last).toBe('incremental');
    }
    const fullMs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      new SortedRows().sort(rows, 'url', false, urlKey);
      fullMs.push(performance.now() - t0);
    }
    console.log('full sort of 5,000 (ms):', fullMs.map((t) => t.toFixed(1)).join(', '), '| at the cap, +200 -200 (ms):', times.map((t) => t.toFixed(1)).join(', '), '| incremental, +100 rows (ms):', grow.map((t) => t.toFixed(1)).join(', '));
    expectWithin(Math.min(...times),4,'a sorted sync at the cap: 200 new rows in, 200 oldest out');
    expectWithin(Math.min(...grow), 4, 'a sorted sync with 100 new rows in 5,000-6,000');
  });
});
