import { describe, expect, it } from 'vitest';
import { collectionFileContent, sameValue, stableValue, type Collection } from '../../packages/core/src/index.js';

/**
 * The stable serializers on a big document (review: performance, finding 10). The old implementation is kept here as the
 * reference: the new one must write the same bytes for any input, and clone nothing when the input is already in order.
 */
const LEADING = ['schemaVersion', 'kind', 'id', 'key', 'name', 'type', 'value', 'enabled', 'secret'];
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function refKeys(o: Obj, first: readonly string[] = []): string[] {
  const keys = Object.keys(o).filter((k) => o[k] !== undefined);
  const head = [...first, ...LEADING.filter((k) => !first.includes(k))].filter((k) => keys.includes(k));
  return [...head, ...keys.filter((k) => !head.includes(k)).sort(byCode)];
}
function refStable(v: unknown, first?: readonly string[]): unknown {
  if (Array.isArray(v)) return v.map((x) => refStable(x));
  if (!isObj(v)) return v;
  return Object.fromEntries(refKeys(v, first).map((k) => [k, refStable(v[k])]));
}
const refSame = (a: unknown, b: unknown) => JSON.stringify(refStable(a ?? null)) === JSON.stringify(refStable(b ?? null));

/** A deterministic pseudo-random generator (no flaky data). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const KEYS = ['zeta', 'alpha', 'id', 'name', 'value', 'type', 'enabled', 'kind', 'key', 'secret', 'schemaVersion', 'b', 'a', '10', '2', 'items', 'x-y'];
function randomValue(r: () => number, depth: number): unknown {
  const t = r();
  if (depth <= 0 || t < 0.3) return t < 0.1 ? null : t < 0.15 ? undefined : t < 0.2 ? r() < 0.5 : t < 0.25 ? Math.floor(r() * 1000) : `s${Math.floor(r() * 50)}`;
  if (t < 0.5) return Array.from({ length: Math.floor(r() * 4) }, () => randomValue(r, depth - 1));
  const o: Obj = {};
  const n = Math.floor(r() * 7);
  for (let i = 0; i < n; i++) o[KEYS[Math.floor(r() * KEYS.length)]!] = randomValue(r, depth - 1);
  return o;
}

function bigCollection(requests: number): Collection {
  const per = 100;
  const folders = Array.from({ length: requests / per }, (_, f) => ({
    kind: 'folder',
    id: `f${f}`,
    name: `Folder ${f}`,
    items: Array.from({ length: per }, (_, i) => ({
      kind: 'http',
      id: `f${f}-r${i}`,
      name: `Request ${f}.${i}`,
      request: { method: 'POST', url: `{{baseUrl}}/f${f}/r${i}`, headers: [{ key: 'Accept', value: 'application/json', enabled: true }, { key: 'X-Id', value: String(i), enabled: false }], params: [], body: { mode: 'json', json: JSON.stringify({ a: i, b: [1, 2, 3] }) } },
      assertions: [{ type: 'status', operator: 'equals', value: 200 }, { type: 'jsonpath', path: '$.id', operator: 'exists' }],
    })),
  }));
  return { schemaVersion: '1.0', id: 'big', name: 'Big', variables: [], items: folders } as unknown as Collection;
}

const best = (fn: () => void, runs = 5) => {
  let min = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    min = Math.min(min, performance.now() - t0);
  }
  return min;
};

describe('stable serializers: same bytes, one pass', () => {
  it('writes the same bytes as the reference for 400 random documents (with and without a key order)', () => {
    const r = rng(7);
    for (let i = 0; i < 400; i++) {
      const v = randomValue(r, 5);
      const first = i % 3 === 0 ? ['items', 'name', 'zeta'] : undefined;
      expect(JSON.stringify(stableValue(v, first))).toBe(JSON.stringify(refStable(v, first)));
    }
  });

  it('answers sameValue like the reference, in both orders', () => {
    const r = rng(11);
    for (let i = 0; i < 300; i++) {
      const v = randomValue(r, 4);
      const shuffled = JSON.parse(JSON.stringify(v ?? null), function (this: unknown, _k, val) {
        return isObj(val) ? Object.fromEntries(Object.entries(val).reverse()) : val;
      });
      const other = i % 2 ? randomValue(r, 4) : shuffled;
      expect(sameValue(v, other)).toBe(refSame(v, other));
      expect(sameValue(other, v)).toBe(refSame(other, v));
    }
  });

  it('keeps __proto__ as an own key and does not touch the input', () => {
    const input = JSON.parse('{"z":1,"__proto__":{"a":2},"a":{"y":1,"x":2}}');
    const before = JSON.stringify(input);
    const out = stableValue(input) as Obj;
    expect(JSON.stringify(out)).toBe(JSON.stringify(refStable(input)));
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('clones nothing when the input is already in order (the very same objects come back)', () => {
    const c = collectionFileContent(bigCollection(1000)) as unknown as Obj;
    const again = stableValue(c, ['schemaVersion', 'id', 'name', 'description', 'variables', 'auth', 'preRequestScript', 'testScript', 'items']);
    expect(again).toBe(c);
  });

  it('saves a 5,000-request collection (stable form and text) in under 100 ms, best of 5', () => {
    const ORDER = ['schemaVersion', 'id', 'name', 'description', 'variables', 'auth', 'preRequestScript', 'testScript', 'items'];
    const written = bigCollection(5000);
    // what the store holds after loading a file the app wrote: already in the stable order
    const c = JSON.parse(JSON.stringify(refStable(written, ORDER))) as Collection;
    const oldMs = best(() => JSON.stringify(refStable(c, ORDER), null, 2), 3);
    const newMs = best(() => JSON.stringify(collectionFileContent(c), null, 2));
    const orderMs = best(() => void collectionFileContent(c));
    const textMs = best(() => void JSON.stringify(c, null, 2));
    const unsortedMs = best(() => void collectionFileContent(written), 3);
    console.log(`stable save of 5,000 requests: reference ${oldMs.toFixed(0)} ms, now ${newMs.toFixed(0)} ms (ordering ${orderMs.toFixed(1)} ms, plain stringify ${textMs.toFixed(0)} ms); unsorted input ordering ${unsortedMs.toFixed(0)} ms`);
    expect(JSON.stringify(collectionFileContent(written), null, 2)).toBe(JSON.stringify(refStable(written, ORDER), null, 2));
    expect(newMs).toBeLessThan(100);
  });
});
