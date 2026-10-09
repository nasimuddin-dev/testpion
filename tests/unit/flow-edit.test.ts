import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  applyFlowEdit,
  collectionSteps,
  editFlowFile,
  flowOfFile,
  lintTestFile,
  loadTestsFromFile,
  suggestedExtracts,
  WorkspaceManager,
  type FlowEditOp,
  type WorkspaceStore,
} from '../../packages/core/src/index.js';
import { flowGraph } from '../../packages/shared/src/flow-graph';
import { copyExample } from '../helpers.js';

// The flow designer edits a test file's text: every operation keeps comments, key order and line endings.
const FLOW = `# A login flow
name: Login flow # the file's name
tests:
  # first, a token
  - id: login
    name: Log in
    type: http
    method: POST
    url: "{{baseUrl}}/auth/token" # the token endpoint
    extract:
      token: $.access_token
    assertions:
      - type: status
        expected: 200
  - id: me
    name: Who am I
    type: http
    method: GET
    url: "{{baseUrl}}/me"
    dependsOn: [login]
  - name: Orders
    type: http
    url: "{{baseUrl}}/orders"
    dependsOn: [me]
`;
const crlf = (s: string) => s.replace(/\n/g, '\r\n');
const edit = (text: string, op: FlowEditOp, file = 'flows/login.yaml') => applyFlowEdit(text, op, { file });
const doc = (text: string) => parse(text) as { tests: Array<Record<string, unknown>>; layout?: Record<string, number[]> };

describe('applyFlowEdit', () => {
  it('adds a step after another: it waits for it, and comments and key order stay', () => {
    const r = edit(FLOW, { op: 'addStep', step: { name: 'Refresh', type: 'http', method: 'POST', url: '{{baseUrl}}/refresh' }, after: 'login' });
    expect(r.added).toEqual(['refresh']);
    expect(r.text).toContain('# A login flow');
    expect(r.text).toContain('# the token endpoint');
    expect(r.text).toContain('# first, a token');
    const d = doc(r.text);
    expect(d.tests.map((t) => t.name)).toEqual(['Log in', 'Refresh', 'Who am I', 'Orders']);
    expect(Object.keys(d.tests[1]!)).toEqual(['id', 'name', 'type', 'method', 'url', 'dependsOn']);
    expect(d.tests[1]!.dependsOn).toEqual(['login']);
    expect(r.text).toMatch(/\n {4}dependsOn: \[ ?login ?\]\n/);
  });

  it('keeps CRLF line endings', () => {
    const r = edit(crlf(FLOW), { op: 'connect', from: 'login', to: 'me' });
    expect(r.text.split('\n').every((l, i, all) => i === all.length - 1 || l.endsWith('\r'))).toBe(true);
    const r2 = edit(crlf(FLOW), { op: 'addStep', step: { name: 'X', type: 'http', url: 'http://x' } });
    expect(r2.text).toContain('\r\n  - id: x\r\n');
    expect(r2.text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('connect gives the source an id of its own and refuses a cycle', () => {
    // Orders has no id: the runner calls it login:orders; connecting from it gives it one
    const r = edit(FLOW, { op: 'addStep', step: { name: 'Receipt', type: 'http', url: 'http://x/r' } });
    const r2 = edit(r.text, { op: 'connect', from: 'Orders', to: 'receipt' });
    const d = doc(r2.text);
    expect(d.tests[2]!.id).toBe('orders');
    expect(Object.keys(d.tests[2]!)[0]).toBe('id');
    expect(d.tests[3]!.dependsOn).toEqual(['orders']);
    expect(() => edit(FLOW, { op: 'connect', from: 'me', to: 'login' })).toThrow(/cycle/);
    expect(() => edit(r2.text, { op: 'connect', from: 'receipt', to: 'login' })).toThrow(/cycle/);
    expect(() => edit(FLOW, { op: 'connect', from: 'me', to: 'me' })).toThrow(/itself/);
  });

  it('a step the runner names by file and name can be named either way', () => {
    const r = edit(FLOW, { op: 'disconnect', from: 'me', to: 'login:orders' });
    expect(doc(r.text).tests[2]!.dependsOn).toBeUndefined();
    const r2 = edit(FLOW, { op: 'disconnect', from: 'me', to: 'Orders' });
    expect(r2.text).toBe(r.text);
  });

  it('disconnect removes one dependency and drops an empty dependsOn', () => {
    const two = edit(FLOW, { op: 'connect', from: 'login', to: 'Orders' });
    expect(doc(two.text).tests[2]!.dependsOn).toEqual(['me', 'login']);
    const one = edit(two.text, { op: 'disconnect', from: 'me', to: 'Orders' });
    expect(doc(one.text).tests[2]!.dependsOn).toEqual(['login']);
    expect(() => edit(FLOW, { op: 'disconnect', from: 'login', to: 'Orders' })).toThrow(/does not wait/);
  });

  it('remove cleans dependsOn of the others and the layout', () => {
    const placed = edit(FLOW, { op: 'setLayout', positions: { login: [10, 20], me: [300, 20] } });
    const r = edit(placed.text, { op: 'removeStep', id: 'me' });
    const d = doc(r.text);
    expect(d.tests.map((t) => t.name)).toEqual(['Log in', 'Orders']);
    expect(d.tests[1]!.dependsOn).toBeUndefined();
    expect(d.layout).toEqual({ login: [10, 20] });
    const all = edit(r.text, { op: 'removeStep', id: ['login'] });
    expect(doc(all.text).layout).toBeUndefined();
  });

  it('rename updates the dependsOn that name the step', () => {
    const r = edit(FLOW, { op: 'renameStep', id: 'login', newId: 'sign-in', name: 'Sign in' });
    const d = doc(r.text);
    expect(d.tests[0]).toMatchObject({ id: 'sign-in', name: 'Sign in' });
    expect(d.tests[1]!.dependsOn).toEqual(['sign-in']);
    // a step without an id: its runner id follows its name, and so do the references
    const withRef = FLOW + '  - name: Receipt\n    type: http\n    url: http://r\n    dependsOn: [login:orders]\n';
    const r2 = edit(withRef, { op: 'renameStep', id: 'Orders', name: 'All orders' });
    expect(doc(r2.text).tests[3]!.dependsOn).toEqual(['login:all-orders']);
    expect(() => edit(FLOW, { op: 'renameStep', id: 'me', name: 'Log in' })).toThrow(/Another step/);
  });

  it('updateStep sets and removes keys, before the checks, and replaces dependsOn with a cycle check', () => {
    const r = edit(FLOW, { op: 'updateStep', id: 'me', set: { extract: { userId: '$.id' }, headers: { Accept: 'application/json' }, url: '{{baseUrl}}/me?x=1' } });
    const d = doc(r.text);
    expect(d.tests[1]).toMatchObject({ url: '{{baseUrl}}/me?x=1', extract: { userId: '$.id' }, headers: { Accept: 'application/json' } });
    const login = edit(FLOW, { op: 'updateStep', id: 'login', set: { headers: { A: 'b' }, extract: null } });
    expect(Object.keys(doc(login.text).tests[0]!)).toEqual(['id', 'name', 'type', 'method', 'url', 'headers', 'assertions']);
    expect(login.text).toContain('# the token endpoint');
    expect(() => edit(FLOW, { op: 'updateStep', id: 'login', set: { dependsOn: ['Orders'] } })).toThrow(/cycle/);
    const deps = edit(FLOW, { op: 'updateStep', id: 'Orders', set: { dependsOn: ['login', 'me'] } });
    expect(doc(deps.text).tests[2]!.dependsOn).toEqual(['login', 'me']);
  });

  it('updateStep writes request keys into a request: block when the step has one', () => {
    const text = 'tests:\n  - name: A\n    type: http\n    request:\n      method: GET\n      url: http://a\n';
    const r = edit(text, { op: 'updateStep', id: 'A', set: { url: 'http://b', method: 'POST', extract: { id: '$.id' } } });
    expect(doc(r.text).tests[0]).toEqual({ name: 'A', type: 'http', request: { method: 'POST', url: 'http://b' }, extract: { id: '$.id' } });
  });

  it('setLayout places steps; null removes the layout (auto-arrange); the runner ignores it and the lint accepts it', async () => {
    const r = edit(FLOW, { op: 'setLayout', positions: { login: [12.4, 40], 'login:orders': [-5, 100] } });
    expect(doc(r.text).layout).toEqual({ login: [12, 40], 'login:orders': [0, 100] });
    expect(r.text).toMatch(/\nlayout:\n {2}login: \[ ?12, 40 ?\]\n/);
    expect(lintTestFile(r.text, { file: 'login.yaml' }).filter((p) => /layout/.test(p.message))).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'tp-flow-edit-'));
    try {
      writeFileSync(join(dir, 'login.yaml'), r.text);
      const names: string[] = [];
      for await (const t of loadTestsFromFile(join(dir, 'login.yaml'))) names.push(t.name);
      expect(names).toEqual(['Log in', 'Who am I', 'Orders']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(doc(edit(r.text, { op: 'setLayout', positions: null }).text).layout).toBeUndefined();
  });

  it('flowGraph keeps placed steps where they are', () => {
    const g = flowGraph([
      { id: 'a', name: 'a', type: 'http', position: [500, 300] },
      { id: 'b', name: 'b', type: 'http', dependsOn: ['a'] },
    ]);
    expect(g.nodes[0]).toMatchObject({ x: 500, y: 300 });
    expect(g.nodes[1]!.y).toBeGreaterThan(300);
    expect(g.width).toBe(Math.max(500 + 220, g.nodes[1]!.x + 220));
  });

  it('flowGraph labels an edge with the variables that flow along it', () => {
    const g = flowGraph([
      { id: 'a', name: 'a', type: 'http', extract: ['token', 'other'] },
      { id: 'b', name: 'b', type: 'http', dependsOn: ['a'], uses: ['token', 'baseUrl'] },
    ]);
    expect(g.edges).toEqual([{ from: 'a', to: 'b', vars: ['token'] }]);
  });

  it('duplicates a step after itself with a new id', () => {
    const r = edit(FLOW, { op: 'duplicateStep', id: 'me' });
    expect(r.added).toEqual(['who-am-i-copy']);
    const d = doc(r.text);
    expect(d.tests[2]).toMatchObject({ id: 'who-am-i-copy', name: 'Who am I copy', dependsOn: ['login'] });
  });

  it('starts an empty file, and turns a single test into a tests: list', () => {
    const empty = edit('', { op: 'addStep', step: { name: 'Health', type: 'http', method: 'GET', url: 'http://h/health' } });
    expect(doc(empty.text).tests).toEqual([{ id: 'health', name: 'Health', type: 'http', method: 'GET', url: 'http://h/health' }]);
    const flowList = edit('name: New flow\ntests: []\n', { op: 'addStep', step: { type: 'http', url: 'http://x' } });
    expect(flowList.text).toBe('name: New flow\ntests:\n  - id: new-step\n    name: New step\n    type: http\n    url: http://x\n');
    const single = edit('name: One\ntype: http\nurl: http://one\n', { op: 'addStep', step: { name: 'Two', type: 'http', url: 'http://two' }, after: 'One' });
    expect(doc(single.text).tests.map((t) => t.name)).toEqual(['One', 'Two']);
  });

  it('chains several steps and refuses a step the runner would not load', () => {
    const r = edit('tests: []\n', {
      op: 'addSteps',
      chain: true,
      steps: [
        { name: 'A', type: 'http', url: 'http://a' },
        { name: 'B', type: 'http', url: 'http://b' },
        { name: 'C', type: 'http', url: 'http://c' },
      ],
      at: [0, 0],
    });
    const d = doc(r.text);
    expect(d.tests.map((t) => t.dependsOn)).toEqual([undefined, ['a'], ['b']]);
    expect(d.layout).toEqual({ a: [0, 0], b: [284, 0], c: [568, 0] });
    expect(() => edit(FLOW, { op: 'addStep', step: { name: 'Bad', type: 'nope' } })).toThrow(/test type/);
  });

  it('writes JSON test files back as JSON', () => {
    const json = JSON.stringify({ name: 'J', tests: [{ id: 'a', name: 'A', type: 'http', url: 'http://a' }] }, null, 2) + '\n';
    const r = applyFlowEdit(json, { op: 'addStep', step: { name: 'B', type: 'http', url: 'http://b' }, after: 'a' }, { file: 'j.json' });
    expect(JSON.parse(r.text).tests[1]).toEqual({ id: 'b', name: 'B', type: 'http', url: 'http://b', dependsOn: ['a'] });
    expect(r.text.startsWith('{\n  "name": "J"')).toBe(true);
  });

  it('replace takes a reviewed text (kept as CRLF in a CRLF file) and refuses one that does not parse', () => {
    expect(edit(crlf(FLOW), { op: 'replace', text: 'name: X\ntests: []\n' }).text).toBe('name: X\r\ntests: []\r\n');
    expect(() => edit(FLOW, { op: 'replace', text: 'a: [\n' })).toThrow(/does not parse/);
    expect(() => edit(FLOW, { op: 'nope' } as unknown as FlowEditOp)).toThrow(/Unknown flow edit/);
  });

  it('suggests extracts for ids and tokens in a saved example', () => {
    expect(suggestedExtracts([{ id: 'e', name: 'ok', status: 200, headers: [], body: JSON.stringify({ id: 7, name: 'x', data: { access_token: 't', user_id: 3 } }) }], 'Create a booking')).toEqual({
      bookingId: '$.id',
      access_token: '$.data.access_token',
      user_id: '$.data.user_id',
    });
    expect(suggestedExtracts(undefined, 'x')).toEqual({});
  });
});

describe('editFlowFile (the workspace)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-flow-edit-ws-'));
  const ws = copyExample('public-workspace', join(dir, 'ws'));
  let store: WorkspaceStore;
  beforeAll(() => {
    store = new WorkspaceManager(join(dir, 'home')).open(ws);
    writeFileSync(join(ws, 'tests', 'rest', 'designed.yaml'), 'name: Designed\ntests: []\n');
  });
  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('adds a folder of a collection chained, and the flow reads the layout and the data flow', async () => {
    const c = store.listCollections().find((x) => x.name.startsWith('Public REST'))!;
    const folder = c.items.find((n) => n.kind === 'folder' && n.name.startsWith('Restful-Booker'))!;
    const steps = collectionSteps(c, [folder.id]);
    expect(steps.length).toBeGreaterThan(3);
    const r = editFlowFile(store, 'rest/designed.yaml', { op: 'addFromCollection', collection: c.name, items: [folder.name], at: [0, 0] });
    expect(r.written).toBe(true);
    expect(r.before).toBe('name: Designed\ntests: []\n');
    expect(r.added!.length).toBe(steps.length);
    expect(r.steps[1]!.dependsOn).toEqual([r.added![0]]);
    const text = readFileSync(join(ws, 'tests', 'rest', 'designed.yaml'), 'utf8');
    expect(text).toContain('layout:');
    const flow = await flowOfFile(store, 'rest/designed.yaml', { raw: true, known: ['restfulBooker'] });
    expect(flow.steps[0]!.position).toEqual([0, 0]);
    expect(Object.keys(flow.raw!)).toEqual(flow.steps.map((s) => s.id));
    // {{bookingId}} is set by a script of an earlier request (or not at all): marked when nothing provides it
    const read = flow.steps.find((s) => s.name === 'Read the booking')!;
    expect(read.uses).toContain('bookingId');
  });

  it('pastes steps from another file with their dependsOn among them, and refuses a suite', () => {
    const r = editFlowFile(store, 'rest/designed.yaml', { op: 'pasteSteps', from: 'rest/httpbin.yaml', ids: ['httpbin-post', 'httpbin-chained'] });
    const added = r.steps.filter((s) => r.added!.includes(s.id));
    expect(added.length).toBe(2);
    expect(added[1]!.dependsOn).toEqual([added[0]!.id]);
    expect(() => editFlowFile(store, 'all.suite.yaml', { op: 'removeStep', id: 'x' })).toThrow(/suite/);
    expect(() => editFlowFile(store, 'rest/none.yaml', { op: 'removeStep', id: 'x' })).toThrow(/No such test file/);
    const dry = editFlowFile(store, 'rest/designed.yaml', { op: 'removeStep', id: r.added![0]! }, { dryRun: true });
    expect(dry.written).toBe(false);
    expect(readFileSync(join(ws, 'tests', 'rest', 'designed.yaml'), 'utf8')).toBe(r.text);
  });
});
