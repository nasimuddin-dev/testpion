import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ITEM_KINDS, ITEM_KIND_LABEL, LIBRARY_LABEL, refNoun, refOfWorkspacePath, type ItemKind, type ItemRef } from '@testpion/shared';
import {
  COLLECTION_ITEM_KINDS,
  WorkspaceSearch,
  WorkspaceStore,
  changeKind,
  describeGitChanges,
  gitStatus,
  mergeWorkspaceTexts,
  refOfChange,
  resolveItemRef,
  runGit,
  trashKindsText,
  type SemanticChange,
} from '../../packages/core/src/index.js';
import { LIBRARY_VIEW, PROTOCOL_VIEW, refTarget, type TargetOptions } from '../../apps/desktop/src/lib/ref-target';
import { touchesFiles } from '../../apps/desktop/src/lib/data-changed';
import { tempDir } from '../helpers';

/**
 * REG-1 (planning/master-roadmap.md §1.8): today's answers of every table and switch the item-kind registry replaces,
 * frozen before the registry exists. Every adapter commit must leave this snapshot byte-identical: a change here means
 * the adapter is wrong, never the snapshot.
 */

const FIXTURE = join(__dirname, '..', 'fixtures', 'kinds', 'workspace');

/** Every top folder, ignored files, temp files, nested datasets, both separators, leading ./ (60 paths). */
export const KIND_PATHS = [
  'collections/api.json',
  'collections/sub/api.json',
  'collections/readme.md',
  'collections/',
  'environments/staging.json',
  'environments/old/staging.json',
  'workspace.json',
  'mcp-servers.json',
  'providers.json',
  'tests/smoke/login.yaml',
  'tests/smoke/login.yml',
  'tests/flows/checkout.json',
  'tests/all.suite.yaml',
  'tests/notes.txt',
  'tests/sub/',
  'tests/',
  'datasets/users.csv',
  'datasets/nested/cases.jsonl',
  'datasets/db.sqlite',
  'datasets/inline-x.csv',
  'datasets/sub/',
  'specs/petstore.yaml',
  'specs/asyncapi/events.yaml',
  'specs/readme.md',
  'library/grpc.json',
  'library/websocket.json',
  'library/ai-prompts.json',
  'library/load-tests.json',
  'library/evaluations.json',
  'library/monitors.json',
  'library/rag-targets.json',
  'library/mcp-folders.json',
  'library/spec-folders.json',
  'library/dataset-folders.json',
  'library/unknown.json',
  'protos/greeter.proto',
  'packages/helpers.js',
  'mocks/weather.mcp-mock.yaml',
  'metrics/politeness.yaml',
  'debugger/rules.json',
  'debugger/morning capture.har',
  'baselines/pets.json',
  'runs/run-1/results.jsonl',
  'traces/t1.json',
  'payloads/p1.bin',
  'reports/r.html',
  'trash/collections/1--api.json',
  '.local/ai/proposals/p1.json',
  '.git/HEAD',
  'node_modules/x/index.js',
  'database.sqlite',
  'database.sqlite-wal',
  'metadata.jsonl',
  '.template-offered.json',
  'collections/api.json.tmp-12-ab12cd',
  'collections/api.json~',
  'tests/.login.yaml.swp',
  'README.md',
  './tests/smoke/login.yaml',
  'tests\\smoke\\login.yaml',
] as const;

/** One ref of every ItemKind (and of every library). */
const REFS: ItemRef[] = [
  { kind: 'request', collectionId: 'api', requestId: 'r1' },
  { kind: 'request', collectionId: 'api', requestId: 'g1', protocol: 'graphql' },
  { kind: 'request', collectionId: 'api', requestId: 's1', protocol: 'soap' },
  { kind: 'collection', collectionId: 'api' },
  { kind: 'collection', collectionId: 'api', tab: 'run' },
  { kind: 'collection', collectionId: 'api', tab: 'mock' },
  { kind: 'collection', collectionId: 'api', tab: 'variables' },
  { kind: 'folder', collectionId: 'api', folderId: 'f1' },
  { kind: 'saved', library: 'grpc', itemId: 'g-call' },
  { kind: 'saved', library: 'websocket', itemId: 'ws-echo' },
  { kind: 'saved', library: 'ai-prompts', itemId: 'p-greet' },
  { kind: 'saved', library: 'load-tests', itemId: 'lt-pets' },
  { kind: 'saved', library: 'evaluations', itemId: 'ev-tone' },
  { kind: 'saved', library: 'monitors', itemId: 'mon-pets' },
  { kind: 'saved', library: 'rag-targets', itemId: 'rt-1' },
  { kind: 'saved', library: 'unknown-lib', itemId: 'x' },
  { kind: 'monitor', monitorId: 'mon-pets' },
  { kind: 'environment', environmentId: 'staging' },
  { kind: 'environment', scope: 'globals' },
  { kind: 'environment', scope: 'workspace' },
  { kind: 'environment', scope: 'collection', collectionId: 'api' },
  { kind: 'environment' },
  { kind: 'variable', key: 'baseUrl', environmentId: 'staging' },
  { kind: 'variable', key: 'nope', environmentId: 'staging' },
  { kind: 'variable', key: 'baseUrl' },
  { kind: 'test', path: 'smoke/login.yaml' },
  { kind: 'test', path: 'smoke/login.yaml', step: 'Login', line: '3' },
  { kind: 'flow', path: 'flows/checkout.yaml', step: 'pay' },
  { kind: 'test-case', testId: 't1' },
  { kind: 'run', runId: 'run-1' },
  { kind: 'run', runId: 'run-1', resultId: 'res-1' },
  { kind: 'history', historyId: 'h1' },
  { kind: 'trace', traceId: 'tr1' },
  { kind: 'exchange', exchangeId: 'x1' },
  { kind: 'mcp-server', serverId: 'weather' },
  { kind: 'provider', providerId: 'demo' },
  { kind: 'spec', path: 'specs/petstore.yaml' },
  { kind: 'dataset', name: 'users.csv' },
  { kind: 'dataset', name: 'nested/cases.jsonl' },
  { kind: 'mock', collectionId: 'api' },
  { kind: 'certificate', host: 'api.example.com' },
  { kind: 'capture', name: 'morning capture' },
  { kind: 'git-file', path: 'collections/api.json', line: '4' },
  { kind: 'doc', url: 'https://testpion.dev/getting-started/finding-your-way' },
];

/** The same refs pointing at nothing (the "missing" answers). */
const MISSING: ItemRef[] = [
  { kind: 'request', collectionId: 'api', requestId: 'gone' },
  { kind: 'request', collectionId: 'gone', requestId: 'r1' },
  { kind: 'folder', collectionId: 'api', folderId: 'r1' },
  { kind: 'request', collectionId: 'api', requestId: 'f1' },
  { kind: 'collection', collectionId: 'gone' },
  { kind: 'mock', collectionId: 'gone' },
  { kind: 'saved', library: 'grpc', itemId: 'gone' },
  { kind: 'saved', library: 'Bad Lib', itemId: 'x' },
  { kind: 'monitor', monitorId: 'gone' },
  { kind: 'environment', environmentId: 'gone' },
  { kind: 'variable', key: 'x', environmentId: 'gone' },
  { kind: 'test', path: 'gone.yaml' },
  { kind: 'flow', path: 'flows/gone.yaml' },
  { kind: 'run', runId: 'gone' },
  { kind: 'run', runId: '../x' },
  { kind: 'history', historyId: 'gone' },
  { kind: 'trace', traceId: 'gone' },
  { kind: 'mcp-server', serverId: 'gone' },
  { kind: 'provider', providerId: 'gone' },
  { kind: 'spec', path: 'specs/gone.yaml' },
  { kind: 'spec', path: 'datasets/users.csv' },
  { kind: 'dataset', name: 'gone.csv' },
  { kind: 'capture', name: 'gone' },
];

const OPTIONS: TargetOptions[] = [{}, { newTab: true }, { noReveal: true }, { preview: true }, { newTab: true, noReveal: true, preview: true }];

let t: ReturnType<typeof tempDir>;
let store: WorkspaceStore;

beforeAll(() => {
  t = tempDir('tp-kinds-', { alias: true });
  store = WorkspaceStore.create(join(t.dir, 'ws'), 'Kinds');
  cpSync(FIXTURE, store.root, { recursive: true });
  mkdirSync(store.path('runs', 'run-1'), { recursive: true });
  writeFileSync(store.path('runs', 'run-1', 'results.jsonl'), '');
  store.meta.addHistory({ id: 'h1', timestamp: '2026-01-01T00:00:00.000Z', kind: 'http', name: 'GET pets', method: 'GET', url: 'https://x/pets', status: 200 });
  store.meta.addTrace({ id: 'tr1', name: 'pets trace', kind: 'http', status: 'ok', startTime: 0, durationMs: 1, spanCount: 1, path: 'traces/tr1.json' });
});

afterAll(() => {
  store?.close();
  t?.cleanup();
});

describe('kind equivalence (REG-1 snapshots; unchanged by the registry adapters)', () => {
  it('labels and views', () => {
    expect({ ITEM_KINDS, ITEM_KIND_LABEL, LIBRARY_LABEL, LIBRARY_VIEW, PROTOCOL_VIEW, COLLECTION_ITEM_KINDS, trash: trashKindsText() }).toMatchSnapshot();
    expect(REFS.map((r) => refNoun(r as ItemRef & { library?: string }))).toMatchSnapshot();
  });

  it('refTarget for one ref of every kind, with every option', () => {
    const kinds = new Set(REFS.map((r) => r.kind));
    expect(ITEM_KINDS.filter((k: ItemKind) => !kinds.has(k))).toEqual([]);
    expect(REFS.map((r) => OPTIONS.map((o) => refTarget(r, o) ?? null))).toMatchSnapshot();
  });

  it('changeKind, refOfWorkspacePath and touchesFiles over 60 paths', () => {
    expect(KIND_PATHS.length).toBe(60);
    expect(KIND_PATHS.map((p) => [p, changeKind(p) ?? null, refOfWorkspacePath(p) ?? null])).toMatchSnapshot();
    const kinds = ['collections', 'environments', 'tests', 'library', 'mcp', 'providers', 'workspace', 'specs', 'other'] as const;
    expect(kinds.map((k) => [k, kinds.filter((x) => touchesFiles({ kinds: [k] }, [x]))])).toMatchSnapshot();
  });

  it('resolveItemRef over the fixture workspace', () => {
    expect([...REFS, ...MISSING].map((r) => resolveItemRef(store, r))).toMatchSnapshot();
    expect(resolveItemRef(store, { kind: 'nope' })).toMatchSnapshot();
  });

  it('search hits for five queries', () => {
    const search = new WorkspaceSearch(store);
    const strip = (hits: ReturnType<WorkspaceSearch['search']>) => hits.map((h) => ({ ...h }));
    expect(['pets', 'hello', 'staging', 'users', 'monitor'].map((q) => [q, strip(search.search(q))])).toMatchSnapshot();
  });

  it('mergeWorkspaceTexts over the merge matrix', () => {
    const col = (url: string, name = 'API') => JSON.stringify({ schemaVersion: '1.0', id: 'api', name, version: 0, variables: [], updatedAt: '', items: [{ kind: 'http', id: 'r1', name: 'R', request: { method: 'GET', url } }] });
    const env = (v: string) => JSON.stringify({ id: 'e', name: 'E', variables: [{ key: 'a', value: v, enabled: true }] });
    const lib = (name: string, folders: string[] = []) => JSON.stringify({ schemaVersion: '1.0', folders, items: [{ id: 'i', name, data: {} }] });
    const cases: Array<[string, string, string, string]> = [
      ['collection, different parts', col('x'), col('y'), col('x', 'API 2')],
      ['collection, same part', col('x'), col('y'), col('z')],
      ['environment', env('1'), env('2'), env('1')],
      ['environment conflict', env('1'), env('2'), env('3')],
      ['library', lib('a'), lib('b'), lib('a', ['F'])],
      ['library conflict', lib('a'), lib('b'), lib('c')],
      ['not JSON', 'x', 'y', 'z'],
      ['an array', '[]', '[]', '[]'],
      ['empty base', '', col('y'), col('z')],
    ];
    expect(cases.map(([name, b, o, th]) => [name, mergeWorkspaceTexts(b, o, th) ?? null])).toMatchSnapshot();
    // the file's kind (the registry) picks the same merge as the shape of its text did
    const pathOf = (name: string) => (name.startsWith('environment') ? 'environments/e.json' : name.startsWith('library') ? 'library/grpc.json' : 'collections/api.json');
    for (const [name, b, o, th] of cases) expect([name, mergeWorkspaceTexts(b, o, th, {}, pathOf(name)) ?? null]).toEqual([name, mergeWorkspaceTexts(b, o, th) ?? null]);
  });

  it('refOfChange for every kind of change', () => {
    const changes: SemanticChange[] = [
      { file: 'collections/api.json', kind: 'collection', change: 'changed', title: 't', details: [], collectionId: 'api' },
      { file: 'collections/api.json', kind: 'collection', change: 'changed', title: 't', details: [], collectionId: 'api', itemId: 'f1', itemKind: 'folder' },
      { file: 'collections/api.json', kind: 'collection', change: 'changed', title: 't', details: [], collectionId: 'api', itemId: 'g1', itemKind: 'graphql' },
      { file: 'collections/api.json', kind: 'collection', change: 'changed', title: 't', details: [], collectionId: 'api', itemId: 'r1', itemKind: 'http' },
      { file: 'tests/smoke/login.yaml', kind: 'test', change: 'changed', title: 't', details: [] },
      { file: 'tests/flows/checkout.yaml', kind: 'test', change: 'changed', title: 't', details: [], itemId: 'pay' },
      { file: 'tests/all.suite.yaml', kind: 'test', change: 'changed', title: 't', details: [] },
      { file: 'tests/notes.txt', kind: 'test', change: 'changed', title: 't', details: [] },
      { file: 'specs/petstore.yaml', kind: 'other', change: 'changed', title: 't', details: [] },
    ];
    expect(changes.map(refOfChange)).toMatchSnapshot();
  });

  it('describeGitChanges over a scripted repo (a commit, then edits to every tracked kind)', async () => {
    const ws = join(t.dir, 'repo');
    cpSync(FIXTURE, ws, { recursive: true });
    await runGit(ws, ['init', '-b', 'main']);
    await runGit(ws, ['add', '.']);
    await runGit(ws, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', 'commit', '-m', 'base']);
    const edit = (rel: string, fn: (s: string) => string) => writeFileSync(join(ws, rel), fn(readFileSync(join(ws, rel), 'utf8')));
    edit('collections/api.json', (s) => s.replace('/pets"', '/pets/v2"').replace('Pets query', 'Pets query 2'));
    edit('environments/staging.json', (s) => s.replace('staging.example.com', 'staging2.example.com'));
    edit('tests/flows/checkout.yaml', (s) => s.replace('/pay', '/pay/v2'));
    edit('library/grpc.json', (s) => s.replace('Say hello', 'Say hi'));
    edit('library/monitors.json', (s) => s.replace('"everyMinutes": 60', '"everyMinutes": 5'));
    edit('specs/petstore.yaml', (s) => s.replace('1.0.0', '1.0.1'));
    edit('mcp-servers.json', (s) => s.replace('Weather mock', 'Weather'));
    rmSync(join(ws, 'datasets', 'users.csv'));
    renameSync(join(ws, 'protos', 'greeter.proto'), join(ws, 'protos', 'hello.proto'));
    writeFileSync(join(ws, 'library', 'load-tests.json'), JSON.stringify({ schemaVersion: '1.0', folders: [], items: [] }));
    mkdirSync(join(ws, 'environments', 'more'));
    writeFileSync(join(ws, 'environments', 'prod.json'), JSON.stringify({ id: 'prod', name: 'Prod', variables: [] }));
    const st = await gitStatus(ws);
    const files = [...st.files].sort((a, b) => a.path.localeCompare(b.path));
    expect(files.map((f) => [f.path, f.state])).toMatchSnapshot();
    expect(await describeGitChanges(ws, files)).toMatchSnapshot();
  });
});
