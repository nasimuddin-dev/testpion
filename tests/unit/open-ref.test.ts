import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ITEM_KINDS, itemRefKey, itemRefUrl, parseItemRef, parseItemRefUrl, toItemRef, type ItemKind, type ItemRef } from '@testpion/shared';
import { WorkspaceStore, WorkspaceSearch, refOfChange, resolveItemRef, saveMonitor, workspaceAttention, type RunSummary } from '../../packages/core/src/index.js';
import { historyEditorTarget, refTarget } from '../../apps/desktop/src/lib/ref-target';

/** One ref of every kind: the table every check below walks (a new kind without an entry fails the first test). */
const SAMPLES: Record<ItemKind, ItemRef> = {
  request: { kind: 'request', collectionId: 'api', requestId: 'r1' },
  collection: { kind: 'collection', collectionId: 'api' },
  folder: { kind: 'folder', collectionId: 'api', folderId: 'f1' },
  saved: { kind: 'saved', library: 'grpc', itemId: 'g1' },
  monitor: { kind: 'monitor', monitorId: 'm1' },
  environment: { kind: 'environment', environmentId: 'env-1' },
  variable: { kind: 'variable', key: 'baseUrl', environmentId: 'env-1' },
  test: { kind: 'test', path: 'smoke/login.yaml' },
  flow: { kind: 'flow', path: 'flows/checkout.yaml', step: 'pay' },
  'test-case': { kind: 'test-case', testId: 't1' },
  run: { kind: 'run', runId: 'run-1' },
  history: { kind: 'history', historyId: 'h1' },
  trace: { kind: 'trace', traceId: 'tr1' },
  exchange: { kind: 'exchange', exchangeId: 'x1' },
  'mcp-server': { kind: 'mcp-server', serverId: 's1' },
  provider: { kind: 'provider', providerId: 'p1' },
  spec: { kind: 'spec', path: 'specs/petstore.yaml' },
  dataset: { kind: 'dataset', name: 'users.csv' },
  mock: { kind: 'mock', collectionId: 'api' },
  certificate: { kind: 'certificate', host: 'api.example.com' },
  capture: { kind: 'capture', name: 'morning capture' },
  'git-file': { kind: 'git-file', path: 'collections/api.json' },
  doc: { kind: 'doc', url: 'https://testpion.dev/getting-started/finding-your-way' },
};

/** Where each kind opens: [view, the payload keys its intent handler reads]. */
const EXPECTED: Record<ItemKind, [string, Record<string, unknown>] | 'dialog' | 'external'> = {
  request: ['rest', { collectionId: 'api', requestId: 'r1' }],
  collection: ['collections', { collectionId: 'api' }],
  folder: ['collections', { collectionId: 'api', folderId: 'f1' }],
  saved: ['grpc', { savedId: 'g1' }],
  monitor: ['monitors', { monitorId: 'm1' }],
  environment: ['environments', { environmentId: 'env-1' }],
  variable: ['environments', { environmentId: 'env-1', variable: 'baseUrl' }],
  test: ['tests', { path: 'smoke/login.yaml' }],
  flow: ['tests', { path: 'flows/checkout.yaml', flow: true, step: 'pay' }],
  'test-case': ['tests', { testId: 't1' }],
  run: ['tests', { runId: 'run-1' }],
  history: ['history', { historyId: 'h1' }],
  trace: ['traces', { traceId: 'tr1' }],
  exchange: ['debugger', { exchangeId: 'x1' }],
  'mcp-server': ['mcp', { serverId: 's1' }],
  provider: ['ai', { providerId: 'p1' }],
  spec: ['apidef', { spec: 'specs/petstore.yaml' }],
  dataset: ['dataset', { dataset: 'users.csv' }],
  mock: ['collections', { collectionId: 'api', mock: true }],
  certificate: ['settings', { tab: 'certificates', host: 'api.example.com' }],
  capture: ['debugger', { session: 'morning capture' }],
  'git-file': ['git', { file: 'collections/api.json' }],
  doc: 'external',
};

describe('ItemRef', () => {
  it('has a sample and a target for every kind', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...ITEM_KINDS].sort());
    expect(Object.keys(EXPECTED).sort()).toEqual([...ITEM_KINDS].sort());
  });

  it('round-trips every kind through its testpion:// link, its key and toItemRef', () => {
    for (const ref of Object.values(SAMPLES)) {
      const url = itemRefUrl(ref);
      expect(url).toMatch(/^testpion:\/\/open\?kind=/);
      expect(parseItemRefUrl(url)).toEqual(ref);
      expect(parseItemRef(url)).toEqual(ref);
      expect(toItemRef({ ...ref, extra: 'dropped' })).toEqual(ref);
      expect(itemRefKey(ref)).toBe(itemRefKey(toItemRef(ref)!));
    }
    // ids with characters a URL has to escape
    const odd: ItemRef = { kind: 'test', path: 'a b/c&d=e?.yaml' };
    expect(parseItemRefUrl(itemRefUrl(odd))).toEqual(odd);
    expect(parseItemRefUrl(`testpion://open?ref=${encodeURIComponent(JSON.stringify(SAMPLES.run))}`)).toEqual(SAMPLES.run);
  });

  it('refuses what is not a ref', () => {
    for (const bad of [
      null,
      'x',
      {},
      { kind: 'nope', id: 'x' },
      { kind: 'request', collectionId: 'api' },
      { kind: 'run', runId: 5 },
      { kind: 'doc', url: 'javascript:alert(1)' },
      { kind: 'doc', url: 'file:///etc/passwd' },
    ])
      expect(toItemRef(bad)).toBeUndefined();
    expect(parseItemRefUrl('https://example.com/?kind=run&runId=1')).toBeUndefined();
    expect(parseItemRefUrl('testpion://delete?kind=run&runId=1')).toBeUndefined();
    expect(parseItemRefUrl('testpion://open?kind=run')).toBeUndefined();
  });

  it('reads the short form kind:id (the last id keeps its colons)', () => {
    expect(parseItemRef('run:run-1')).toEqual({ kind: 'run', runId: 'run-1' });
    expect(parseItemRef('request:api:r1')).toEqual({ kind: 'request', collectionId: 'api', requestId: 'r1' });
    expect(parseItemRef('doc:https://testpion.dev/x')).toEqual({ kind: 'doc', url: 'https://testpion.dev/x' });
    expect(parseItemRef('request:api')).toBeUndefined();
    expect(parseItemRef('{"kind":"history","historyId":"h1"}')).toEqual({ kind: 'history', historyId: 'h1' });
  });

  it('a library item of monitors is a monitor', () => {
    expect(toItemRef({ kind: 'saved', library: 'monitors', itemId: 'm1' })).toEqual({ kind: 'monitor', monitorId: 'm1' });
  });
});

describe('openRef targets: every kind opens in its own view', () => {
  it('maps every kind', () => {
    for (const kind of ITEM_KINDS) {
      const t = refTarget(SAMPLES[kind]);
      const want = EXPECTED[kind];
      expect(t, kind).toBeDefined();
      if (want === 'external') expect(t).toEqual({ external: (SAMPLES[kind] as { url: string }).url });
      else if (want === 'dialog') expect('dialog' in t!).toBe(true);
      else expect(t, kind).toEqual({ view: want[0], payload: want[1] });
    }
  });

  it('opens each request protocol in its own editor (the routing bugs of search, Git and History)', () => {
    const r = (protocol?: 'http' | 'soap' | 'graphql' | 'grpc' | 'websocket') =>
      (refTarget({ kind: 'request', collectionId: 'c', requestId: 'r', ...(protocol ? { protocol } : {}) }) as { view: string }).view;
    expect([r(), r('http'), r('soap'), r('graphql'), r('grpc'), r('websocket')]).toEqual(['rest', 'rest', 'rest', 'graphql', 'grpc', 'websocket']);
    const saved = (library: string) => (refTarget({ kind: 'saved', library, itemId: 'i' }) as { view: string } | undefined)?.view;
    expect(['grpc', 'websocket', 'ai-prompts', 'load-tests', 'evaluations', 'monitors'].map(saved)).toEqual(['grpc', 'websocket', 'ai', 'load', 'evaluations', 'monitors']);
    expect(saved('unknown-library')).toBeUndefined();
  });

  it('a variable without an environment opens Variable usages; scopes open their tab; options add a new tab', () => {
    expect(refTarget({ kind: 'variable', key: 'token' })).toEqual({ dialog: 'variableUsages', key: 'token' });
    expect(refTarget({ kind: 'environment', scope: 'globals' })).toEqual({ view: 'environments', payload: { tab: 'globals' } });
    expect(refTarget({ kind: 'collection', collectionId: 'c', tab: 'run' })).toEqual({ view: 'collections', payload: { collectionId: 'c', run: true } });
    expect(refTarget(SAMPLES.saved, { newTab: true })).toEqual({ view: 'grpc', payload: { savedId: 'g1', newDoc: true } });
    expect(refTarget(SAMPLES.request, { noReveal: true })).toEqual({ view: 'rest', payload: { collectionId: 'api', requestId: 'r1', noReveal: true } });
  });

  it('reopens a history entry in its editor with what was sent (GraphQL, MCP and LLM no longer open empty)', () => {
    const gql = { endpoint: 'https://x/graphql', query: '{ me { id } }', variables: { a: 1 } };
    expect(historyEditorTarget({ kind: 'graphql', name: 'Me', request: gql })).toEqual({ view: 'graphql', payload: { request: gql, name: 'Me', newDoc: true } });
    expect(historyEditorTarget({ kind: 'mcp', request: { serverId: 's1', tool: 'add', args: { a: 1 } } })).toEqual({ view: 'mcp', payload: { serverId: 's1', call: { tool: 'add', args: { a: 1 } } } });
    expect(historyEditorTarget({ kind: 'llm', request: { provider: 'p', model: 'm', prompt: 'hi' } })).toEqual({ view: 'ai', payload: { prompt: { provider: 'p', model: 'm', prompt: 'hi' } } });
    expect(historyEditorTarget({ kind: 'http', name: 'Get', request: { method: 'GET', url: 'u' } })).toMatchObject({ view: 'rest' });
    expect(historyEditorTarget({ kind: 'grpc', request: { target: 't' } })).toMatchObject({ view: 'grpc' });
    expect(historyEditorTarget({ kind: 'http' })).toBeUndefined();
  });
});

const dir = mkdtempSync(join(tmpdir(), 'tp-open-ref-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function workspace(name: string) {
  const store = WorkspaceStore.create(join(dir, name), name);
  store.saveCollection({
    schemaVersion: '1.0',
    id: 'api',
    name: 'API',
    version: 0,
    variables: [],
    updatedAt: '',
    items: [
      {
        kind: 'folder',
        id: 'f1',
        name: 'Auth',
        items: [
          { kind: 'http', id: 'r1', name: 'Login', request: { method: 'POST', url: 'https://api.example.com/login', headers: [], params: [] } },
          { kind: 'http', id: 'soap1', name: 'Add', request: { method: 'POST', url: 'https://soap.example.com', headers: [{ key: 'SOAPAction', value: 'Add', enabled: true }], params: [] } },
        ],
      },
      { kind: 'graphql', id: 'q1', name: 'Me', request: { endpoint: 'https://api.example.com/graphql', query: '{ me { id } }' } },
      // a node of a kind this version does not know (a hand edit): never listed as GraphQL
      { kind: 'kafka', id: 'k1', name: 'Mystery topic', request: {} },
    ],
  } as never);
  store.saveLibrary('grpc', { folders: [], items: [{ id: 'g1', name: 'Say hello', collectionId: 'api', data: { target: 'localhost:50051', method: 'helloworld.Greeter/SayHello' } }] } as never);
  store.saveLibrary('websocket', { folders: [], items: [{ id: 'w1', name: 'Echo socket', data: { url: 'wss://echo.example.com' } }] } as never);
  saveMonitor(store, { id: 'm1', name: 'Health', collectionId: 'api', everyMinutes: 5, enabled: true });
  store.saveEnvironment({ id: 'env-1', name: 'Staging', variables: [{ key: 'baseUrl', value: 'https://staging', enabled: true }] } as never);
  mkdirSync(store.path('tests', 'smoke'), { recursive: true });
  writeFileSync(store.path('tests', 'smoke', 'login.yaml'), 'tests:\n  - name: login\n');
  mkdirSync(store.path('specs'), { recursive: true });
  writeFileSync(store.path('specs', 'petstore.yaml'), 'openapi: 3.0.0\ninfo: { title: Pets, version: "1" }\npaths: {}\n');
  writeFileSync(store.path('datasets', 'users.csv'), 'name\nAda\n');
  store.meta.addRun({ runId: 'run-1', name: 'Smoke', startedAt: new Date().toISOString(), durationMs: 1, total: 1, passed: 1, failed: 0, skipped: 0, errors: 0 } as RunSummary, store.runDir('run-1'));
  mkdirSync(store.runDir('run-1'), { recursive: true });
  store.meta.addHistory({ id: 'h1', timestamp: new Date().toISOString(), kind: 'graphql', name: 'Me', status: 200, request: { endpoint: 'https://api.example.com/graphql', query: '{ me { id } }' } });
  return store;
}

describe('resolveItemRef: is it still there, and what instead', () => {
  it('finds what exists, with a request protocol filled in', () => {
    const store = workspace('found');
    const ok = (ref: ItemRef) => resolveItemRef(store, ref);
    expect(ok({ kind: 'request', collectionId: 'api', requestId: 'r1' })).toMatchObject({ ok: true, label: 'Login', detail: 'API / Auth / Login', ref: { protocol: 'http' } });
    expect(ok({ kind: 'request', collectionId: 'api', requestId: 'q1' })).toMatchObject({ ok: true, ref: { protocol: 'graphql' } });
    expect(ok({ kind: 'request', collectionId: 'api', requestId: 'soap1' })).toMatchObject({ ok: true, ref: { protocol: 'soap' } });
    for (const ref of [
      SAMPLES.collection,
      SAMPLES.folder,
      SAMPLES.saved,
      SAMPLES.monitor,
      SAMPLES.environment,
      SAMPLES.variable,
      SAMPLES.test,
      SAMPLES.run,
      SAMPLES.history,
      SAMPLES.spec,
      SAMPLES.dataset,
      SAMPLES.mock,
    ])
      expect(ok(ref).ok, ref.kind).toBe(true);
    store.close();
  });

  it('says why something is gone and offers the nearest thing still there, never an empty editor', () => {
    const store = workspace('gone');
    const no = (ref: ItemRef) => resolveItemRef(store, ref);
    expect(no({ kind: 'request', collectionId: 'api', requestId: 'deleted' })).toMatchObject({ ok: false, reason: 'missing', next: { ref: { kind: 'collection', collectionId: 'api' } } });
    // a folder id is not a request (and the other way round)
    expect(no({ kind: 'request', collectionId: 'api', requestId: 'f1' }).ok).toBe(false);
    expect(no({ kind: 'request', collectionId: 'other-workspace', requestId: 'r1' })).toMatchObject({ ok: false, next: { view: 'search' } });
    expect(no({ kind: 'saved', library: 'grpc', itemId: 'nope' })).toMatchObject({ ok: false, reason: 'missing' });
    expect(no({ kind: 'monitor', monitorId: 'nope' })).toMatchObject({ ok: false, next: { view: 'monitors' } });
    expect(no({ kind: 'environment', environmentId: 'nope' })).toMatchObject({ ok: false, next: { view: 'environments' } });
    expect(no({ kind: 'variable', key: 'missing', environmentId: 'env-1' })).toMatchObject({ ok: false, next: { ref: { kind: 'environment', environmentId: 'env-1' } } });
    expect(no({ kind: 'test', path: 'renamed.yaml' })).toMatchObject({ ok: false, next: { view: 'tests' } });
    expect(no({ kind: 'test', path: '../../etc/passwd' }).ok).toBe(false);
    expect(no({ kind: 'run', runId: 'run-gone' })).toMatchObject({ ok: false, next: { view: 'tests' } });
    expect(no({ kind: 'run', runId: '../x' }).ok).toBe(false);
    expect(no({ kind: 'history', historyId: 'cleared' })).toMatchObject({ ok: false, next: { view: 'history' } });
    expect(no({ kind: 'trace', traceId: 'cleared' }).ok).toBe(false);
    expect(no({ kind: 'spec', path: 'specs/gone.yaml' }).ok).toBe(false);
    expect(no({ kind: 'spec', path: 'collections/api.json' }).ok).toBe(false);
    expect(no({ kind: 'dataset', name: 'gone.csv' }).ok).toBe(false);
    expect(resolveItemRef(store, { kind: 'bogus' })).toMatchObject({ ok: false, reason: 'invalid' });
    // a request deleted after it was resolved once: the index follows the file
    expect(no({ kind: 'request', collectionId: 'api', requestId: 'r1' }).ok).toBe(true);
    const c = store.getCollection('api');
    store.saveCollection({ ...c, items: c.items.filter((n) => n.id !== 'f1') });
    expect(no({ kind: 'request', collectionId: 'api', requestId: 'r1' }).ok).toBe(false);
    store.close();
  });

  it('resolves in O(1) after the first look, in a 9,000-request workspace', () => {
    const store = WorkspaceStore.create(join(dir, 'big'), 'Big');
    for (let c = 0; c < 3; c++)
      store.saveCollection({
        schemaVersion: '1.0',
        id: `big${c}`,
        name: `Big ${c}`,
        version: 0,
        variables: [],
        updatedAt: '',
        items: Array.from({ length: 150 }, (_, f) => ({
          kind: 'folder',
          id: `big${c}-f${f}`,
          name: `Folder ${f}`,
          items: Array.from({ length: 20 }, (_, r) => ({
            kind: 'http',
            id: `big${c}-${f * 20 + r}`,
            name: `Request ${f * 20 + r}`,
            request: { method: 'GET', url: `https://x/${f}/${r}`, headers: [], params: [] },
          })),
        })),
      } as never);
    const first = performance.now();
    for (let c = 0; c < 3; c++) expect(resolveItemRef(store, { kind: 'request', collectionId: `big${c}`, requestId: `big${c}-0` }).ok).toBe(true);
    const indexMs = performance.now() - first;
    const t0 = performance.now();
    for (let i = 0; i < 3000; i++) {
      const c = i % 3;
      const r = resolveItemRef(store, { kind: 'request', collectionId: `big${c}`, requestId: `big${c}-${(i * 7) % 3000}` });
      if (!r.ok) throw new Error(`not found: ${i}`);
    }
    const perClick = (performance.now() - t0) / 3000;
    // a click: a stat of the collection file and a map lookup, far under a frame
    expect(perClick).toBeLessThan(2);
    expect(indexMs).toBeLessThan(5000);
    store.close();
  });
});

describe('refs in results', () => {
  it('search hits carry an ItemRef under their real kind (gRPC is not GraphQL; environments, specs and datasets are hits)', () => {
    const store = workspace('search');
    const search = new WorkspaceSearch(store);
    const hit = (q: string) => search.search(q).find((h) => h.title.toLowerCase().includes(q.toLowerCase()));
    expect(toItemRef(hit('Say hello')!.ref)).toEqual({ kind: 'saved', library: 'grpc', itemId: 'g1' });
    expect(toItemRef(hit('Echo socket')!.ref)).toEqual({ kind: 'saved', library: 'websocket', itemId: 'w1' });
    expect(hit('Add')!.ref).toMatchObject({ kind: 'request', protocol: 'soap' });
    expect(hit('Me')!.ref).toMatchObject({ kind: 'request', protocol: 'graphql' });
    expect(hit('Login')!.ref).toMatchObject({ kind: 'request', protocol: 'http', collectionId: 'api', requestId: 'r1' });
    expect(hit('Mystery')).toBeUndefined();
    expect(hit('Staging')!.ref).toEqual({ kind: 'environment', environmentId: 'env-1' });
    expect(hit('petstore')!.ref).toEqual({ kind: 'spec', path: 'specs/petstore.yaml' });
    expect(hit('users.csv')!.ref).toEqual({ kind: 'dataset', name: 'users.csv' });
    // the older flat fields stay for readers that use them
    expect(hit('login.yaml') ?? search.search('smoke/login').find((h) => h.kind === 'test')).toMatchObject({ ref: { kind: 'test', path: 'smoke/login.yaml', testPath: 'smoke/login.yaml' } });
    for (const h of search.search('a')) expect(toItemRef(h.ref), `${h.kind} ${h.title}`).toBeDefined();
    store.close();
  });

  it('attention items carry an ItemRef', async () => {
    const store = workspace('attention');
    store.meta.addHistory({ id: 'h2', timestamp: new Date().toISOString(), kind: 'http', name: 'Login', status: 500, collectionId: 'api', requestId: 'r1' });
    const items = await workspaceAttention(store);
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(toItemRef(i.ref), i.kind).toBeDefined();
    expect(items.find((i) => i.kind === 'request')!.ref).toMatchObject({ kind: 'request', collectionId: 'api', requestId: 'r1' });
    store.close();
  });

  it('a git change names what to open: request, folder, collection, flow step, test file, else the file', () => {
    const base = { change: 'changed' as const, title: 't', details: [] };
    expect(refOfChange({ ...base, file: 'collections/api.json', kind: 'collection', collectionId: 'api', itemId: 'q1', itemKind: 'graphql' })).toEqual({
      kind: 'request',
      collectionId: 'api',
      requestId: 'q1',
      protocol: 'graphql',
    });
    expect(refOfChange({ ...base, file: 'collections/api.json', kind: 'collection', collectionId: 'api', itemId: 'f1', itemKind: 'folder' })).toEqual({
      kind: 'folder',
      collectionId: 'api',
      folderId: 'f1',
    });
    expect(refOfChange({ ...base, file: 'collections/api.json', kind: 'collection', collectionId: 'api' })).toEqual({ kind: 'collection', collectionId: 'api' });
    expect(refOfChange({ ...base, file: 'tests/flows/checkout.yaml', kind: 'test', itemId: 'pay' })).toEqual({ kind: 'flow', path: 'flows/checkout.yaml', step: 'pay' });
    expect(refOfChange({ ...base, file: 'tests/all.suite.yaml', kind: 'test' })).toEqual({ kind: 'test', path: 'all.suite.yaml' });
    expect(refOfChange({ ...base, file: 'README.md', kind: 'other' })).toEqual({ kind: 'git-file', path: 'README.md' });
  });
});
