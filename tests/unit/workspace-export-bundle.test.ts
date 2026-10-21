import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceManager, WorkspaceStore, exportWholeWorkspace, importBundleAsWorkspace, readBundle, type Collection } from '../../packages/core/src/index.js';
import { cliData, runCli, tempDir } from '../helpers.js';
import { FIXTURE_SECRETS } from '../fixtures/secrets/values.js';

/**
 * B-41i · `workspace export` (the CLI, the workspace menu) writes a bundle, the same file `testpion export --all` writes; a
 * bundle opens as a new workspace; the one-file export of earlier versions is still read (and `--legacy` still writes it).
 */
const tmp = tempDir('tp-ws-bundle-', { alias: true });
afterAll(() => tmp.cleanup());

const write = (store: WorkspaceStore, rel: string, data: string | Buffer) => {
  const p = store.path(...rel.split('/'));
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, data);
};

function fixtureWorkspace(root: string, name = 'Clinic API'): WorkspaceStore {
  const store = WorkspaceStore.create(root, name);
  write(store, 'specs/clinic.openapi.yaml', 'openapi: 3.0.0\ninfo:\n  title: Clinic\n  version: "1"\npaths: {}\n');
  write(store, 'datasets/owners.csv', 'id,name\r\n1,Ann\r\n2,Bob\r\n');
  write(store, 'datasets/clinic.sqlite', Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) % 256))]));
  write(store, 'protos/pets.proto', 'syntax = "proto3";\npackage pets;\nmessage Pet { string name = 1; }\n');
  store.writeTestFile('smoke.yaml', 'name: smoke\ntests:\n  - id: ping\n    method: GET\n    url: "{{baseUrl}}/ping"\n');
  store.saveCollection({
    schemaVersion: '1.0',
    id: 'api',
    name: 'API',
    version: 0,
    updatedAt: '',
    variables: [{ key: 'baseUrl', value: 'https://api.example.com', enabled: true }],
    auth: { type: 'bearer', token: FIXTURE_SECRETS.collectionBearer },
    items: [{ kind: 'http', id: 'r1', name: 'List pets', request: { method: 'GET', url: '{{baseUrl}}/pets', headers: [] } }],
  } as Collection);
  store.deleteEnvironment('development');
  store.saveEnvironment({ id: 'staging', name: 'Staging', variables: [{ key: 'password', value: FIXTURE_SECRETS.envPassword, enabled: true }, { key: 'region', value: 'eu', enabled: true }] });
  store.saveMcpServers([{ id: 'petstore', name: 'Petstore MCP', transport: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: [{ key: 'Authorization', value: FIXTURE_SECRETS.mcpAuthorization, enabled: true }] }]);
  return store;
}

describe('workspace export is a bundle', () => {
  const src = fixtureWorkspace(join(tmp.dir, 'source'));
  afterAll(() => src.close());

  it('holds every kind, no secret value, and a zip when a file is binary', async () => {
    const built = await exportWholeWorkspace(src);
    expect(built.format).toBe('zip');
    expect(built.fileName).toBe('Clinic API.testpion.zip');
    expect(built.counts).toMatchObject({ collection: 1, environment: 1, test: 1, spec: 1, dataset: 2, proto: 1, 'mcp-server': 1 });
    expect(built.summary).toMatchObject({ collections: 1, environments: 1, tests: 1, files: 4 });
    const bundle = readBundle(built.bytes);
    expect(bundle.source).toBe('zip');
    const all = [...bundle.entries.values()].map((b) => b.toString('latin1')).join('\n');
    for (const [name, value] of Object.entries(FIXTURE_SECRETS)) expect(all.includes(value), name).toBe(false);
    expect(built.replaced.length).toBeGreaterThanOrEqual(3);
    expect(built.summary.lines[0]).toMatch(/^Exported \d+ items?:/);
  });

  it('a small workspace of text is the JSON form, and the format can be chosen', async () => {
    const small = WorkspaceStore.create(join(tmp.dir, 'small'), 'Small');
    try {
      small.writeTestFile('a.yaml', 'name: a\ntests: []\n');
      const auto = await exportWholeWorkspace(small);
      expect(auto.format).toBe('json');
      expect(auto.fileName).toBe('Small.testpion.json');
      expect(readBundle(auto.bytes).source).toBe('json');
      expect((await exportWholeWorkspace(small, { format: 'zip' })).format).toBe('zip');
    } finally {
      small.close();
    }
  });

  it('says the workspace-level variables (Globals) are not part of a bundle, instead of dropping them silently', async () => {
    const g = WorkspaceStore.create(join(tmp.dir, 'globals'), 'Globals');
    try {
      g.writeTestFile('a.yaml', 'name: a\ntests: []\n');
      expect((await exportWholeWorkspace(g)).notes.join(' ')).not.toMatch(/Globals/);
      g.updateWorkspace({ variables: [{ key: 'region', value: 'eu', enabled: true }] });
      const built = await exportWholeWorkspace(g);
      expect(built.notes.join(' ')).toMatch(/workspace's own variable \(the Globals\) is not part of a bundle/);
      expect(built.summary.lines.join(' ')).toMatch(/Globals/);
    } finally {
      g.close();
    }
  });

  it('opens as a new workspace with its items, files and the values to fill in; a second import gets a numbered name', async () => {
    const mgr = new WorkspaceManager(join(tmp.dir, 'app'));
    const built = await exportWholeWorkspace(src);
    const r = importBundleAsWorkspace(mgr, readBundle(built.bytes));
    try {
      expect(r.store.workspace.name).toBe('Clinic API (imported)');
      expect(r.store.listCollections().map((c) => c.id)).toEqual(['api']);
      // the bundle's own environments replace the default one
      expect(r.store.listEnvironments().map((e) => e.id)).toEqual(['staging']);
      expect(readFileSync(r.store.path('specs', 'clinic.openapi.yaml'), 'utf8')).toContain('title: Clinic');
      expect(existsSync(r.store.path('datasets', 'clinic.sqlite'))).toBe(true);
      expect(readFileSync(r.store.path('protos', 'pets.proto'), 'utf8')).toContain('message Pet');
      expect(r.store.getMcpServers().map((s) => s.id)).toEqual(['petstore']);
      expect(r.files).toBe(4);
      expect(r.valuesNeeded.length).toBeGreaterThanOrEqual(3);
      expect(r.valuesNeeded.join(' ')).not.toContain(FIXTURE_SECRETS.envPassword);
    } finally {
      r.store.close();
    }
    const again = importBundleAsWorkspace(mgr, readBundle(built.bytes));
    expect(again.store.workspace.name).toBe('Clinic API (imported) 2');
    again.store.close();
    expect(mgr.list().map((w) => w.name)).toEqual(expect.arrayContaining(['Clinic API (imported)', 'Clinic API (imported) 2']));
  });

  it('the one-file export of earlier versions is still read, as a bundle and as a new workspace', () => {
    const legacy = src.exportBundle();
    const bundle = readBundle(Buffer.from(JSON.stringify(legacy)));
    expect(bundle.source).toBe('legacy-workspace');
    expect(bundle.manifest.items.some((i) => i.kind === 'collection' && i.id === 'api')).toBe(true);
    const mgr = new WorkspaceManager(join(tmp.dir, 'app2'));
    const copy = mgr.importBundle(legacy);
    expect(copy.listCollections().map((c) => c.id)).toEqual(['api']);
    copy.close();
  });
});

describe('testpion workspace export', () => {
  const home = join(tmp.dir, 'cli-home');
  const wsDir = join(tmp.dir, 'cli-ws');
  const store = fixtureWorkspace(wsDir, 'Cli Clinic');
  store.close();

  it('writes a bundle by default, and --json says what it holds', async () => {
    const out = join(tmp.dir, 'out.testpion.zip');
    const r = await runCli(['workspace', 'export', wsDir, '-o', out, '--json'], { home });
    expect(r.status, r.err).toBe(0);
    const data = cliData<{ path: string; format: string; counts: Record<string, number>; collections: number; replaced: unknown[]; legacy?: boolean }>(r.out);
    expect(data).toMatchObject({ format: 'zip', collections: 1 });
    expect(data.legacy).toBeUndefined();
    expect(data.counts.collection).toBe(1);
    expect(data.replaced.length).toBeGreaterThanOrEqual(3);
    expect(readBundle(readFileSync(out)).manifest.items.length).toBeGreaterThan(5);
  });

  it('--format json, and --legacy for the one-file export of earlier versions', async () => {
    const small = join(tmp.dir, 'cli-small');
    const s = WorkspaceStore.create(small, 'Cli Small');
    s.writeTestFile('a.yaml', 'name: a\ntests: []\n');
    s.close();
    const outJson = join(tmp.dir, 'f.testpion.json');
    const j = await runCli(['workspace', 'export', small, '-o', outJson, '--format', 'json', '--json'], { home });
    expect(j.status, j.err).toBe(0);
    expect(JSON.parse(readFileSync(outJson, 'utf8')).format).toBe('testpion-bundle');
    const outLegacy = join(tmp.dir, 'l.testpion.json');
    const l = await runCli(['workspace', 'export', small, '-o', outLegacy, '--legacy', '--json'], { home });
    expect(l.status, l.err).toBe(0);
    expect(cliData<{ legacy: boolean }>(l.out).legacy).toBe(true);
    expect(JSON.parse(readFileSync(outLegacy, 'utf8')).format).toBe('testpion-workspace');
    const bad = await runCli(['workspace', 'export', small, '--format', 'xml'], { home });
    expect(bad.status).not.toBe(0);
  });
});
