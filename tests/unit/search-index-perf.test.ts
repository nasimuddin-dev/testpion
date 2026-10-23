import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceSearch, WorkspaceStore } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

const SLACK = Number(process.env.TESTPION_PERF_SLACK ?? 1);
const t = tempDir('tp-search-perf-');
afterAll(() => t.cleanup());

// A-1: Quick Open lowercased the title and text of every indexed document on every query (test files up to 200 KB each)
describe('Quick Open over many large test files', () => {
  it('10 queries over 300 files of 100 KB stay under 700 ms once the index is warm', () => {
    const store = WorkspaceStore.create(join(t.dir, 'ws'), 'Search');
    const dir = store.path('tests', 'bulk');
    mkdirSync(dir, { recursive: true });
    const filler = Array.from({ length: 1000 }, (_, i) => `# Some Comment Line ${i} With MIXED Case Words`).join('\n');
    for (let i = 0; i < 300; i++) writeFileSync(join(dir, `t${i}.yaml`), `name: Bulk Test ${i}\n${filler}\ntests:\n  - name: step ${i}\n    type: log\n    message: needle${i}\n`);
    const search = new WorkspaceSearch(store);
    expect(search.search('needle42')[0]?.title).toMatch(/Bulk Test 42/); // warms the index
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) expect(search.search(`NEEDLE${i * 7}`).length).toBeGreaterThan(0);
    const ms = performance.now() - t0;
    console.log(`10 Quick Open queries over 300 x 100 KB test files: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(700 * SLACK); // (about 430 ms measured; 973 ms when every document was lowercased on every query)
    store.close();
  });
});
