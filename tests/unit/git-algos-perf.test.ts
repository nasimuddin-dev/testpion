import { describe, expect, it } from 'vitest';
import { diffTexts, mergeCollectionTexts } from '../../packages/core/src/index.js';

const SLACK = Number(process.env.TESTPION_PERF_SLACK ?? 1);
const best = (runs: number, fn: () => void): number => {
  let b = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    b = Math.min(b, performance.now() - t0);
  }
  return b;
};

// G-2: describing a list file (MCP servers, providers, a library) looked every id up with a linear scan of both lists
describe('describing a 9,000-item list file', () => {
  const servers = (n: number, changed: number) => JSON.stringify({ servers: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `Server ${i}`, transport: 'http', url: `http://h/${i}${i < changed ? '-new' : ''}` })) }, null, 2);
  it('takes well under 100 ms, with the changed servers named', () => {
    const before = servers(9000, 0);
    const after = servers(9000, 300);
    let parts = 0;
    const ms = best(3, () => {
      parts = Object.keys(diffTexts('mcp-servers.json', undefined, before, after).parts).length;
    });
    console.log(`describe 9,000-item list file: ${ms.toFixed(0)} ms`);
    expect(parts).toBeGreaterThan(0);
    expect(ms).toBeLessThan(100 * SLACK);
  });
});

// G-3: merging two sides that each add hundreds of requests to a thousand-request folder was quadratic
describe('merging large folders', () => {
  const req = (id: string, url = 'https://x/' + id) => ({ kind: 'http', id, name: id, request: { method: 'GET', url, headers: [] } });
  const col = (items: unknown[]) => JSON.stringify({ schemaVersion: '1.0', id: 'api', name: 'API', items });
  it('2 x 5,000 items merge in well under 100 ms, in the right order', () => {
    const baseItems = Array.from({ length: 1000 }, (_, i) => req(`b${i}`));
    const ours = [...baseItems, ...Array.from({ length: 4000 }, (_, i) => req(`o${i}`))];
    const theirs = [...baseItems.slice(0, 500), ...Array.from({ length: 4000 }, (_, i) => req(`t${i}`)), ...baseItems.slice(500)];
    let r: ReturnType<typeof mergeCollectionTexts>;
    const ms = best(3, () => {
      r = mergeCollectionTexts(col(baseItems), col(ours), col(theirs));
    });
    console.log(`merge 2 x 5,000 items: ${ms.toFixed(0)} ms`);
    const ids = (JSON.parse(r!.text).items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toHaveLength(9000);
    // theirs' additions sit after the item that precedes them in theirs; ours' stay at the end
    expect(ids.indexOf('t0')).toBe(ids.indexOf('b499') + 1);
    expect(ids.indexOf('t3999')).toBe(ids.indexOf('b499') + 4000);
    expect(ms).toBeLessThan(100 * SLACK);
  });
});
