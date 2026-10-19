import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { CAPABILITIES, ITEM_KINDS, ITEM_REF_FIELDS, KIND_IDS, KIND_INFO, kindOfPath, kindOfRef, liveKinds, refOfWorkspacePath, watchKindOfPath, type ItemRef, type KindId } from '@testpion/shared';
import { WorkspaceSearch, WorkspaceStore, kind, kinds, removeItem, resolveItemRef, restoreItem, type RunSummary } from '../../packages/core/src/index.js';
import { RPC_PARAMS } from '../../apps/desktop/backend/rpc-params.js';
import { refTarget } from '../../apps/desktop/src/lib/ref-target';
import { tempDir } from '../helpers';

/**
 * REG-4 (planning/master-roadmap.md §1.9): every kind declares every capability, and a `true` is implemented. A `planned`
 * marker fails once its release is reached; a `na` needs a reason worth reading (all of them are in the snapshot, so a new
 * exemption shows in review). The menu capabilities (rename, duplicate, move, delete, container, run, monitor, ci,
 * test-file, flow, favorite, link) are checked against buildNodeMenu in node-menu.test.ts.
 */

const root = join(__dirname, '..', '..');
const FIXTURE = join(__dirname, '..', 'fixtures', 'kinds', 'workspace');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;
const minor = (v: string) => Number(/^0\.(\d+)/.exec(v)?.[1] ?? NaN);

/** One ref of every kind that has one, pointing at the fixture workspace's item. */
const SAMPLE_REF: Partial<Record<KindId, ItemRef>> = {
  collection: { kind: 'collection', collectionId: 'api' },
  folder: { kind: 'folder', collectionId: 'api', folderId: 'f1' },
  request: { kind: 'request', collectionId: 'api', requestId: 'r1' },
  'grpc-call': { kind: 'saved', library: 'grpc', itemId: 'g-call' },
  'ws-connection': { kind: 'saved', library: 'websocket', itemId: 'ws-echo' },
  environment: { kind: 'environment', environmentId: 'staging' },
  workspace: { kind: 'environment', scope: 'workspace' },
  test: { kind: 'test', path: 'smoke/login.yaml' },
  flow: { kind: 'flow', path: 'flows/checkout.yaml' },
  spec: { kind: 'spec', path: 'specs/petstore.yaml' },
  dataset: { kind: 'dataset', name: 'users.csv' },
  'mcp-server': { kind: 'mcp-server', serverId: 'weather' },
  provider: { kind: 'provider', providerId: 'demo' },
  prompt: { kind: 'saved', library: 'ai-prompts', itemId: 'p-greet' },
  'load-test': { kind: 'saved', library: 'load-tests', itemId: 'lt-pets' },
  evaluation: { kind: 'saved', library: 'evaluations', itemId: 'ev-tone' },
  'rag-target': { kind: 'saved', library: 'rag-targets', itemId: 'rag-clinic' },
  monitor: { kind: 'monitor', monitorId: 'mon-pets' },
  capture: { kind: 'capture', name: 'morning capture' },
  run: { kind: 'run', runId: 'run-1' },
  history: { kind: 'history', historyId: 'h1' },
  trace: { kind: 'trace', traceId: 'tr1' },
  exchange: { kind: 'exchange', exchangeId: 'x1' },
  variable: { kind: 'variable', key: 'baseUrl', environmentId: 'staging' },
  'test-case': { kind: 'test-case', testId: 't1' },
  certificate: { kind: 'certificate', host: 'api.example.com' },
  'git-file': { kind: 'git-file', path: 'collections/api.json' },
  doc: { kind: 'doc', url: 'https://testpion.dev/' },
  mock: { kind: 'mock', collectionId: 'api' },
};

/** The fixture item each trash kind removes and puts back. */
const TRASH_IDS: Partial<Record<KindId, string>> = { collection: 'api', environment: 'staging', dataset: 'users.csv', spec: 'specs/petstore.yaml', 'mcp-server': 'weather' };

let t: ReturnType<typeof tempDir>;
let store: WorkspaceStore;
beforeAll(() => {
  t = tempDir('tp-kind-caps-', { alias: true });
  store = WorkspaceStore.create(join(t.dir, 'ws'), 'Kinds');
  cpSync(FIXTURE, store.root, { recursive: true });
  store.meta.addHistory({ id: 'h1', timestamp: '2026-01-01T00:00:00.000Z', kind: 'http', name: 'GET pets history', method: 'GET', url: 'https://x/pets', status: 200 });
  store.meta.addTrace({ id: 'tr1', name: 'pets trace', kind: 'http', status: 'ok', startTime: 0, durationMs: 1, spanCount: 1, path: 'traces/tr1.json' });
  const run = {
    runId: 'run-1',
    name: 'pets run',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1,
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    errors: 0,
  } as RunSummary;
  store.meta.addRun(run, store.path('runs', 'run-1'));
  cpSync(join(FIXTURE, 'baselines'), store.path('runs', 'run-1'), { recursive: true });
});
afterAll(() => {
  store?.close();
  t?.cleanup();
});

describe('the item-kind registry is complete', () => {
  it('every ItemKind maps to exactly one registry kind, and every library kind is reached by its library', () => {
    for (const k of ITEM_KINDS) {
      if (k === 'saved') continue;
      expect(kindOfRef({ kind: k })?.id, k).toBe(k);
      expect(KIND_INFO[k as KindId].ref, k).toBe(k);
    }
    for (const k of liveKinds().filter((x) => x.ref === 'saved' || x.library)) expect(kindOfRef({ kind: 'saved', library: k.library })?.id).toBe(k.id);
    expect(kindOfRef({ kind: 'saved', library: 'not-a-library' })).toBeUndefined();
  });

  it('the core registry has every kind of KIND_INFO, and no other', () => {
    expect(kinds({ all: true }).map((d) => d.info.id)).toEqual([...KIND_IDS]);
    for (const id of KIND_IDS) expect(kind(id).info).toBe(KIND_INFO[id]);
  });

  it('aliases are unique and never another kind’s id', () => {
    const seen = new Map<string, string>();
    for (const k of Object.values(KIND_INFO))
      for (const a of k.aliases) {
        expect(seen.get(a), `${a} is an alias of ${seen.get(a)} and ${k.id}`).toBeUndefined();
        expect(KIND_IDS.includes(a as KindId), `${a} (alias of ${k.id}) is a kind id`).toBe(false);
        seen.set(a, k.id);
      }
  });

  it('every capability is declared; a na says why (the reasons are reviewed in the snapshot)', () => {
    const reasons: Record<string, Record<string, string>> = {};
    for (const k of Object.values(KIND_INFO)) {
      expect(Object.keys(k.capabilities).sort()).toEqual([...CAPABILITIES].sort());
      for (const [cap, state] of Object.entries(k.capabilities)) {
        if (state === true) continue;
        if ('na' in state) {
          expect(state.na.trim().length, `${k.id}.${cap}: "${state.na}" is not a reason`).toBeGreaterThanOrEqual(12);
          (reasons[k.id] ??= {})[cap] = state.na;
        }
      }
    }
    expect(reasons).toMatchSnapshot();
  });

  it(`a planned capability (or a kind registered ahead of its release) has not outlived its release (version ${version})`, () => {
    const late: string[] = [];
    for (const k of Object.values(KIND_INFO)) {
      if (k.since && minor(k.since) <= minor(version)) late.push(`${k.id}: since ${k.since}`);
      for (const [cap, state] of Object.entries(k.capabilities))
        if (state !== true && 'planned' in state && minor(state.planned) <= minor(version)) late.push(`${k.id}.${cap}: planned for ${state.planned}`);
    }
    expect(late).toEqual([]);
  });

  it('a kind with storage has an item in the fixture workspace, and kindOfPath finds the kind there', () => {
    for (const k of Object.values(KIND_INFO)) {
      // a variant is stored as its base kind; a kind registered ahead of its release gets its fixture with it
      if (['nested', 'record', 'ref-only'].includes(k.storage.layout) || k.variantOf || k.since) continue;
      expect(k.sample, `${k.id} needs a sample path in tests/fixtures/kinds/workspace`).toBeTruthy();
      expect(existsSync(join(FIXTURE, ...k.sample!.split('/'))), `${k.id}: ${k.sample}`).toBe(true);
      expect(kindOfPath(k.sample!)?.kind, k.sample).toBe(k.id);
      expect(kindOfPath(k.sample!.replace(/\//g, '\\'))?.kind, `${k.sample} with \\`).toBe(k.id);
    }
  });

  it('kindOfPath is built from the registry’s storage: the sample path of a kind with a ref round-trips to its sample ref', () => {
    for (const k of liveKinds()) {
      if (!k.sample || !k.ref || k.storage.layout === 'library' || k.storage.layout === 'single-file' || k.storage.layout === 'items-in-file') continue;
      const found = kindOfPath(k.sample);
      expect(found?.kind, k.sample).toBe(k.id);
      const ref = SAMPLE_REF[k.id] as Record<string, string> | undefined;
      // the id the path gives is the ref's first id (a collection's id, a test file's path inside tests/, a spec's workspace path …)
      if (ref && k.ref === ref.kind) expect(found?.id, k.sample).toBe(ref[ITEM_REF_FIELDS[k.ref][0]!.replace(/\?$/, '')]);
      if (k.pathRef) expect(refOfWorkspacePath(k.sample), k.sample).toEqual(SAMPLE_REF[k.id]);
    }
    // a folder path names the kind without an item; a file the kind's glob does not match too
    expect(kindOfPath('tests/')).toEqual({ kind: 'test' });
    expect(kindOfPath('tests/notes.txt')).toEqual({ kind: 'test' });
    expect(kindOfPath('collections/sub/api.json')).toEqual({ kind: 'collection' });
    expect(kindOfPath('debugger/rules.json')).toEqual({ kind: 'debugger-rules' });
    expect(kindOfPath('debugger/x.har')).toEqual({ kind: 'capture', id: 'x' });
    expect(kindOfPath('packages/helpers.js')).toEqual({ kind: 'script-package', id: 'helpers' });
    expect(kindOfPath('specs/asyncapi/events.yaml')).toEqual({ kind: 'spec', id: 'specs/asyncapi/events.yaml' });
    expect(kindOfPath('runs/run-1/results.jsonl')).toEqual({ kind: 'run', id: 'run-1' });
    expect(kindOfPath('README.md')).toBeUndefined();
  });

  it('watch: a change to the sample is reported as the kind’s watch kind', () => {
    for (const k of liveKinds()) {
      if (k.capabilities.watch !== true || !k.sample) continue;
      expect(k.watch, k.id).not.toBe('none');
      expect(watchKindOfPath(k.sample), k.id).toBe(k.watch !== 'none' && k.watch.legacy);
    }
  });

  it('versioned: a stored kind git merges, found by its path', () => {
    for (const k of liveKinds()) {
      if (k.capabilities.versioned !== true) continue;
      expect(['record', 'ref-only', 'nested'], k.id).not.toContain(k.storage.layout);
      expect(k.git.merge, k.id).not.toBe('none');
      // a variant (a flow) is stored as its base kind (a test file)
      const sample = k.sample ?? KIND_INFO[k.variantOf!].sample!;
      expect(kindOfPath(sample)?.kind, k.id).toBe(k.variantOf ?? k.id);
    }
  });

  it('link and open: the kind resolves its fixture item and opens it somewhere', () => {
    for (const k of liveKinds()) {
      if (k.capabilities.link !== true && k.capabilities.open !== true) continue;
      const ref = SAMPLE_REF[k.id];
      expect(ref, `${k.id} needs a sample ref`).toBeTruthy();
      expect(kind(k.id).resolve, `${k.id} has no resolve facet`).toBeTypeOf('function');
      const r = resolveItemRef(store, ref);
      expect(r.ok, `${k.id}: ${JSON.stringify(r)}`).toBe(true);
      expect(refTarget(ref!), k.id).toBeTruthy();
    }
  });

  it('search: the fixture item of every searchable kind is found by its name', () => {
    const search = new WorkspaceSearch(store);
    const names: Partial<Record<KindId, string>> = {
      collection: 'Kinds API',
      request: 'List pets',
      'grpc-call': 'Say hello',
      'ws-connection': 'Echo socket',
      environment: 'Staging',
      test: 'Login works',
      dataset: 'users',
      spec: 'petstore',
      'mcp-server': 'Weather mock',
      provider: 'Demo model',
      prompt: 'Greeting prompt',
      'load-test': 'Pets load',
      evaluation: 'Tone evaluation',
      'rag-target': 'Clinic bot',
      monitor: 'Pets monitor',
      run: 'pets run',
      history: 'GET pets history',
      trace: 'pets trace',
      variable: 'baseUrl',
    };
    for (const k of liveKinds()) {
      if (k.capabilities.search !== true) continue;
      const name = names[k.id];
      expect(name, `${k.id} needs a searchable fixture name`).toBeTruthy();
      const hits = search.search(name!, 100);
      expect(
        hits.some((h) => kindOfRef(h.ref as ItemRef & { library?: string })?.id === k.id),
        `${k.id} not found by "${name}": ${hits.map((h) => h.ref.kind).join(', ')}`,
      ).toBe(true);
    }
  });

  it('trash: remove then restore puts the item back, and it resolves again', () => {
    for (const k of liveKinds()) {
      if (k.capabilities.trash !== true) continue;
      const def = kind(k.id);
      expect(def.ops, `${k.id} has the trash capability but no ops facet`).toBeTruthy();
      const id = TRASH_IDS[k.id];
      expect(id, `${k.id} needs a fixture id`).toBeTruthy();
      const trashId = def.ops!.remove(store, id!);
      expect(resolveItemRef(store, SAMPLE_REF[k.id]).ok, `${k.id} still resolves after remove`).toBe(false);
      const back = def.ops!.restore(store, trashId);
      expect(back.id, k.id).toBe(id);
      expect(resolveItemRef(store, SAMPLE_REF[k.id]).ok, `${k.id} does not resolve after restore`).toBe(true);
    }
  });

  it('every kind with trash is reachable through the one generic remove / restore (RPC item.remove / item.restore, CLI item, MCP delete_item)', () => {
    expect(RPC_PARAMS['item.remove']).toEqual({ ref: 'x' });
    expect(RPC_PARAMS['item.restore']).toEqual({ trashId: 's' });
    for (const k of liveKinds()) {
      if (k.capabilities.trash !== true) continue;
      const ref = SAMPLE_REF[k.id]!;
      const gone = removeItem(store, ref);
      expect(gone, k.id).toMatchObject({ kind: k.id, id: TRASH_IDS[k.id], ref });
      expect(gone.name, k.id).not.toBe('');
      expect(gone.trashId.startsWith(`${k.id}/`), k.id).toBe(true);
      expect(resolveItemRef(store, ref).ok, `${k.id} still resolves after removeItem`).toBe(false);
      // the string forms of a ref work too (what the CLI and MCP get)
      expect(() => removeItem(store, `${k.id}:nope`)).toThrow();
      const back = restoreItem(store, gone.trashId);
      expect(back, k.id).toMatchObject({ kind: k.id, id: TRASH_IDS[k.id], ref });
      expect(resolveItemRef(store, ref).ok, `${k.id} does not resolve after restoreItem`).toBe(true);
    }
    // a kind without the trash capability says why instead of deleting
    expect(() => removeItem(store, SAMPLE_REF.test)).toThrow(/Test file: cannot be deleted to Recently deleted \(planned for 0.54\)/);
    expect(() => removeItem(store, SAMPLE_REF.request)).toThrow(/Request: cannot be deleted/);
    expect(() => removeItem(store, 'nonsense')).toThrow(/Not a ref/);
    expect(() => restoreItem(store, 'nope/1--x.json')).toThrow(/Not a trash entry/);
  });
});

/**
 * No back doors: kind switches and kind path regexes live in the registry (packages/shared/src/item-kinds.ts,
 * packages/core/src/kinds/**). The allow-list names the adapters that still have one; it shrinks each release and is
 * empty in 0.65.
 */
describe('no kind switches outside the registry', () => {
  const ALLOW: Record<string, string> = {
    'packages/core/src/ai/item-context.ts': '0.53: per-kind AI context through kind facets',
    'packages/core/src/runner/test-from-ref.ts': '0.53: test files from refs through kind facets',
    'packages/core/src/storage/template-update.ts': '0.57: mergeKind from the registry (§1.7 row 15)',
    'apps/desktop/backend/backend.ts': '0.57: the collection id of a changed file through kind.paths',
    'apps/desktop/src/lib/terminal-links.ts': '0.57: terminal links through kindOfPath',
    'apps/desktop/src/lib/open-ref.ts': '0.53: open-ref side effects per kind through the UI half',
    'apps/desktop/src/components/RefLink.tsx': '0.53: RefLink icons from KIND_INFO.icon',
  };
  const PATTERNS = [
    /switch \((ref|r)\.kind\)\s*{\s*case '(request|collection|saved|spec|dataset|test|mcp-server)'/,
    /case 'mcp-server':/,
    /\/\^(collections|environments|library)\\\//,
    /\/\^\((collections|environments|library)\|/,
  ];
  const scan = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (e === 'node_modules' || e === 'dist') continue;
      if (statSync(p).isDirectory()) scan(p, out);
      else if (/\.(ts|tsx)$/.test(e) && !e.endsWith('.d.ts')) out.push(p);
    }
    return out;
  };
  it('finds none outside the registry and the allow-list', () => {
    const found: string[] = [];
    for (const d of ['packages/core/src', 'packages/cli/src', 'packages/shared/src', 'apps/desktop/src', 'apps/desktop/backend'])
      for (const f of scan(join(root, d))) {
        const rel = relative(root, f).split(sep).join('/');
        if (rel === 'packages/shared/src/item-kinds.ts' || rel.startsWith('packages/core/src/kinds/') || ALLOW[rel]) continue;
        const text = readFileSync(f, 'utf8').replace(/testpion:\\\/\\\/collections/g, '');
        for (const re of PATTERNS) if (re.test(text)) found.push(`${rel}: ${re}`);
      }
    expect(found).toEqual([]);
  });
  it('the allow-list holds only files that still need it', () => {
    const stale = Object.keys(ALLOW).filter((rel) => {
      const text = readFileSync(join(root, rel), 'utf8').replace(/testpion:\\\/\\\/collections/g, '');
      return !PATTERNS.some((re) => re.test(text)) && !/switch \((ref|r)\.kind\)/.test(text);
    });
    expect(stale).toEqual([]);
  });
});
