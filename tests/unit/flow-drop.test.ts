import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { applyFlowEdit, dropIntoFlow, dropSteps, WorkspaceStore, type RunSummary } from '../../packages/core/src/index.js';

// Build a flow by drag and drop: every kind of dropped item, every place it lands, one edit per drop.
const dir = mkdtempSync(join(tmpdir(), 'tp-drop-'));
const store = WorkspaceStore.create(join(dir, 'ws'), 'Drop');
const req = (id: string, name: string, method: string, url: string) => ({ kind: 'http', id, name, request: { method, url, headers: [], params: [] } });
store.saveCollection({
  schemaVersion: '1.0',
  id: 'shop',
  name: 'Shop',
  version: 0,
  variables: [],
  updatedAt: '',
  items: [
    req('login', 'Log in', 'POST', '{{baseUrl}}/login'),
    {
      kind: 'folder',
      id: 'orders',
      name: 'Orders',
      items: [
        req('create', 'Create order', 'POST', '{{baseUrl}}/orders'),
        req('read', 'Read order', 'GET', '{{baseUrl}}/orders/{{orderId}}'),
        req('cancel', 'Cancel order', 'DELETE', '{{baseUrl}}/orders/{{orderId}}'),
      ],
    },
  ],
} as never);
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const FLOW = [
  'name: Built',
  'tests:',
  '  - { id: a, name: A, url: "http://x/a" }',
  '  - { id: cond, name: Cond, type: condition, if: "status == 200", dependsOn: [a] }',
  '  - { id: b, name: B, url: "http://x/b", dependsOn: [a] }',
  '',
].join('\n');
const tests = (text: string) => parse(text).tests as Array<Record<string, unknown>>;
const byId = (text: string, id: string) => tests(text).find((t) => t.id === id)!;
const step = (name: string) => ({ name, type: 'http', method: 'GET', url: `http://x/${name}` });

describe('insertSteps (where a drop lands)', () => {
  it('after a step: the new steps chain from it, in order', () => {
    const r = applyFlowEdit(FLOW, { op: 'insertSteps', steps: [step('n1'), step('n2')], after: 'b' }, { file: 'built.yaml' });
    expect(r.added).toEqual(['n1', 'n2']);
    expect(byId(r.text, 'n1').dependsOn).toEqual(['b']);
    expect(byId(r.text, 'n2').dependsOn).toEqual(['n1']);
  });

  it('into a connection: the step after it now waits for the last new step', () => {
    const r = applyFlowEdit(FLOW, { op: 'insertSteps', steps: [step('mid')], between: { from: 'a', to: 'b' } }, { file: 'built.yaml' });
    expect(byId(r.text, 'mid').dependsOn).toEqual(['a']);
    expect(byId(r.text, 'b').dependsOn).toEqual(['mid']);
    expect(() => applyFlowEdit(FLOW, { op: 'insertSteps', steps: [step('x')], between: { from: 'b', to: 'a' } }, { file: 'built.yaml' })).toThrow(/no connection/);
  });

  it("on a condition's branch, at a point, alone; recorded variables go to defaults", () => {
    const t = applyFlowEdit(FLOW, { op: 'insertSteps', steps: [step('yes')], after: 'cond', when: true }, { file: 'built.yaml' }).text;
    expect(byId(t, 'yes')).toMatchObject({ dependsOn: ['cond'], when: true });
    const placed = applyFlowEdit(FLOW, { op: 'insertSteps', steps: [step('p1'), step('p2')], at: [100, 50], vars: { baseUrl: 'http://x' } }, { file: 'built.yaml' }).text;
    const data = parse(placed);
    expect(data.layout).toMatchObject({ p1: [100, 50], p2: [384, 50] });
    expect(data.defaults).toEqual({ vars: { baseUrl: 'http://x' } });
    expect(byId(placed, 'p1').dependsOn).toBeUndefined();
  });
});

describe('dropSteps (what a drop makes)', () => {
  it('a request, a folder in order, a whole collection, a test file', () => {
    expect(dropSteps(store, [{ kind: 'request', collectionId: 'shop', requestId: 'login' }]).steps.map((s) => s.name)).toEqual(['Log in']);
    const folder = dropSteps(store, [{ kind: 'folder', collectionId: 'shop', folderId: 'orders' }]);
    expect(folder).toMatchObject({ chain: true });
    expect(folder.steps.map((s) => s.name)).toEqual(['Create order', 'Read order', 'Cancel order']);
    expect(dropSteps(store, [{ kind: 'collection', collectionId: 'shop' }]).steps).toHaveLength(4);
    expect(dropSteps(store, [{ kind: 'test', path: 'rest/login.yaml' }]).steps).toEqual([{ name: 'login', type: 'flow', file: 'rest/login.yaml' }]);
    expect(() => dropSteps(store, [{ kind: 'monitor', monitorId: 'm' }])).toThrow(/can't be dropped/);
  });

  it('History entries: the value that flowed from one response into the next request becomes an extract', () => {
    mkdirSync(join(dir, 'payloads'), { recursive: true });
    const body = join(dir, 'payloads', 'login.json');
    writeFileSync(body, JSON.stringify({ token: 'tok-12345678' }));
    store.meta.addHistory({
      id: 'h1',
      timestamp: '2026-10-01T10:00:00Z',
      kind: 'http',
      name: 'Login',
      method: 'POST',
      url: 'https://api.test/login',
      status: 200,
      payloadPath: body,
      request: { method: 'POST', url: 'https://api.test/login', headers: [] },
    });
    store.meta.addHistory({
      id: 'h2',
      timestamp: '2026-10-01T10:00:01Z',
      kind: 'http',
      name: 'Me',
      method: 'GET',
      url: 'https://api.test/me',
      status: 200,
      request: { method: 'GET', url: 'https://api.test/me', headers: [{ key: 'Authorization', value: 'Bearer tok-12345678', enabled: true }] },
    });
    const d = dropSteps(store, [
      { kind: 'history', historyId: 'h2' },
      { kind: 'history', historyId: 'h1' },
    ]);
    expect(d.chain).toBe(false);
    expect(d.steps.map((s) => s.name)).toHaveLength(2);
    expect(JSON.stringify(d.steps[0])).toContain('token');
    expect(JSON.stringify(d.steps[1])).toMatch(/\{\{token\}\}/);
    expect(d.notes.join(' ')).toContain('{{token}}');
  });
});

describe('dropIntoFlow (one edit, and the values an earlier response provides)', () => {
  it('a 300-request folder is one fast edit, chained in order', async () => {
    const many = Array.from({ length: 300 }, (_, i) => req(`r${i}`, `Request ${i}`, 'GET', `{{baseUrl}}/items/${i}`));
    store.saveCollection({ schemaVersion: '1.0', id: 'big', name: 'Big', version: 0, variables: [], updatedAt: '', items: [{ kind: 'folder', id: 'all', name: 'All', items: many }] } as never);
    store.writeTestFile('big.yaml', 'name: Big\ntests: []\n');
    const t0 = performance.now();
    const r = await dropIntoFlow(store, 'big.yaml', { refs: [{ kind: 'folder', collectionId: 'big', folderId: 'all' }] });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(r.added).toHaveLength(300);
    const ts = tests(r.text);
    expect(ts[299]!.dependsOn).toEqual([ts[298]!.id]);
    expect(r.before).toBe('name: Big\ntests: []\n');
  });

  it("a dropped request reading {{orderId}} gets it from an earlier step's latest response", async () => {
    store.writeTestFile('orders.yaml', ['name: Orders', 'tests:', '  - { id: create, name: Create order, url: "http://x/orders", method: POST }', ''].join('\n'));
    const runDir = store.runDir('run-orders');
    mkdirSync(runDir, { recursive: true });
    const file = store.safePath('orders.yaml', store.path('tests'));
    writeFileSync(
      join(runDir, 'results.jsonl'),
      JSON.stringify({
        id: 'create',
        name: 'Create order',
        type: 'http',
        status: 'passed',
        file,
        startedAt: new Date().toISOString(),
        durationMs: 5,
        attempts: 1,
        checks: [],
        output: JSON.stringify({ order: { orderId: 'o-1' } }),
      }) + '\n',
    );
    store.meta.addRun({ runId: 'run-orders', name: 'Orders', startedAt: new Date().toISOString(), durationMs: 5, total: 1, passed: 1, failed: 0, skipped: 0, errors: 0 } as RunSummary, runDir);
    const r = await dropIntoFlow(store, 'orders.yaml', { refs: [{ kind: 'request', collectionId: 'shop', requestId: 'read' }], target: { at: [300, 0] } });
    expect(byId(r.text, 'create').extract).toEqual({ orderId: '$.order.orderId' });
    expect(byId(r.text, r.added[0]!).dependsOn).toEqual(['create']);
    expect(r.notes).toContain('{{orderId}} is extracted from $.order.orderId of "Create order"');
  });
});
