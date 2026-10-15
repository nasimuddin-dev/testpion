import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, locateTest } from '../../packages/core/src/index.js';

// A link that names a test only by its id (a flaky test, an attention item) opens its file at its line.
const dir = mkdtempSync(join(tmpdir(), 'tp-locate-'));
const store = WorkspaceStore.create(join(dir, 'ws'), 'Locate');
store.writeTestFile('rest/orders.yaml', 'name: Orders\ntests:\n  - name: List orders\n    url: http://x/orders\n  - id: pay\n    name: Pay\n    url: http://x/pay\n');
store.writeTestFile('rest/broken.yaml', 'tests: [ { name: : }');
store.writeTestFile('all.suite.yaml', 'name: All\ntests: [rest]\n');
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('locateTest', () => {
  it('finds a test by the id the runner gives it, or by its own id, with the line of its name', async () => {
    expect(await locateTest(store, 'orders:list-orders')).toEqual({ path: 'rest/orders.yaml', id: 'orders:list-orders', name: 'List orders', line: 3 });
    expect(await locateTest(store, 'pay')).toMatchObject({ path: 'rest/orders.yaml', name: 'Pay', line: 6 });
  });

  it('answers undefined for an id nobody defines (broken files and suites are skipped)', async () => {
    expect(await locateTest(store, 'nope')).toBeUndefined();
    expect(await locateTest(store, '')).toBeUndefined();
  });
});
