import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  WorkspaceStore,
  applyImport,
  buildBundle,
  folderRefs,
  listImports,
  parseSelector,
  previewImport,
  readBundle,
  undoImport,
  type Collection,
} from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

const FIXTURE = join(__dirname, '..', 'fixtures', 'kinds', 'workspace');
const tmp = tempDir('tp-transfer-left-', { alias: true });
afterAll(() => tmp.cleanup());

let n = 0;
const fresh = (name = 'Dest'): WorkspaceStore => WorkspaceStore.create(join(tmp.dir, `ws-${++n}`), name);
const source = (): WorkspaceStore => {
  const s = fresh('Source');
  cpSync(FIXTURE, s.root, { recursive: true });
  return s;
};
// built from pieces: no file of the repository holds a string a secret scanner would take for a key
const FAKE_TOKEN = ['gh', 'p_', 'Ab3'.repeat(12)].join('');

describe('the workspace variables (Globals) travel in the manifest', () => {
  it('are written with a whole-workspace export, secrets blank, and read back by a preview', () => {
    const src = source();
    src.updateWorkspace({
      variables: [
        { key: 'region', value: 'eu', enabled: true },
        { key: 'api_token', value: FAKE_TOKEN, enabled: true },
      ],
    });
    const b = buildBundle(src, 'all');
    expect(b.manifest.workspace?.variables).toEqual([
      { key: 'region', value: 'eu', enabled: true },
      { key: 'api_token', value: '', enabled: true, secret: true },
    ]);
    expect(b.manifest.requires.secrets.map((s) => s.name)).toContain('api_token');
    expect(JSON.stringify(b.manifest)).not.toContain(FAKE_TOKEN);
    expect(b.notes.join(' ')).toMatch(/workspace variables \(the Globals\) travel in the bundle/);
    // a selection leaves them out unless asked
    expect(buildBundle(src, [{ kind: 'collection', id: 'api' }]).manifest.workspace).toBeUndefined();
    expect(buildBundle(src, [{ kind: 'collection', id: 'api' }], { workspaceVariables: true }).manifest.workspace?.variables).toHaveLength(2);
    expect(buildBundle(src, 'all', { workspaceVariables: false }).manifest.workspace).toBeUndefined();

    const dest = fresh();
    dest.updateWorkspace({ variables: [{ key: 'region', value: 'us', enabled: true }] });
    const p = previewImport(dest, readBundle(b.bytes));
    expect(p.workspace?.counts).toEqual({ new: 1, same: 0, differs: 1 });
    expect(p.workspace?.variables.map((v) => `${v.key}:${v.action}`)).toEqual(['region:differs', 'api_token:new']);
  });

  it('merge adds the new keys and keeps yours; replace takes the bundle’s values but never blanks one; one Undo restores them', () => {
    const src = source();
    src.updateWorkspace({
      variables: [
        { key: 'region', value: 'eu', enabled: true },
        { key: 'api_token', value: FAKE_TOKEN, enabled: true },
        { key: 'locale', value: 'en', enabled: true },
      ],
    });
    const bundle = readBundle(buildBundle(src, 'all').bytes);
    const dest = fresh();
    dest.updateWorkspace({ variables: [{ key: 'region', value: 'us', enabled: true }, { key: 'api_token', value: 'mine', enabled: true }] });
    const merged = applyImport(dest, bundle, { workspaceVariables: 'merge' });
    expect(merged.workspaceVariables).toEqual({ added: 1, replaced: 0, kept: 1 });
    expect(dest.workspace.variables.map((v) => `${v.key}=${v.value}`)).toEqual(['region=us', 'api_token=mine', 'locale=en']);
    const undone = undoImport(dest, merged.importId);
    expect(undone.keptChanged).toEqual([]);
    expect(dest.workspace.variables.map((v) => v.key)).toEqual(['region', 'api_token']);

    const replaced = applyImport(dest, bundle, { workspaceVariables: 'replace', onConflict: 'skip' });
    expect(replaced.workspaceVariables).toMatchObject({ added: 1, replaced: 1 });
    // the secret's blank value does not wipe the one the workspace has
    expect(dest.workspace.variables.find((v) => v.key === 'api_token')?.value).toBe('mine');
    expect(dest.workspace.variables.find((v) => v.key === 'region')?.value).toBe('eu');
    // a variable edited after the import is left, and named
    dest.updateWorkspace({ variables: [...dest.workspace.variables, { key: 'later', value: '1', enabled: true }] });
    expect(undoImport(dest, replaced.importId).keptChanged).toEqual(['the workspace variables']);
    expect(dest.workspace.variables.some((v) => v.key === 'later')).toBe(true);
  });

  it('skip leaves them, `only` without workspace leaves them, and an import twice changes nothing', () => {
    const src = source();
    src.updateWorkspace({ variables: [{ key: 'region', value: 'eu', enabled: true }] });
    const bundle = readBundle(buildBundle(src, 'all').bytes);
    const a = fresh();
    expect(applyImport(a, bundle, { workspaceVariables: 'skip' }).workspaceVariables).toBeUndefined();
    expect(a.workspace.variables).toEqual([]);
    const b = fresh();
    expect(applyImport(b, bundle, { only: ['collection'] }).workspaceVariables).toBeUndefined();
    expect(b.workspace.variables).toEqual([]);
    const c = fresh();
    applyImport(c, bundle);
    expect(applyImport(c, bundle).workspaceVariables).toBeUndefined();
    expect(c.workspace.variables).toHaveLength(1);
  });

  it('a hostile section is bounded: no key, a repeated key and a value that is not text are dropped', () => {
    const src = source();
    const b = buildBundle(src, [{ kind: 'collection', id: 'api' }], { format: 'json' });
    const raw = JSON.parse(b.bytes.toString('utf8'));
    raw.workspace = { variables: [{ key: 'ok', value: 'v' }, { key: 'ok', value: 'again' }, { key: '', value: 'x' }, { key: 'num', value: 3 }, 'junk', { key: '__proto__', value: 'p' }] };
    const read = readBundle(Buffer.from(JSON.stringify(raw)));
    expect(read.manifest.workspace?.variables.map((v) => v.key)).toEqual(['ok']);
    expect(Object.keys({}).includes('p')).toBe(false);
  });

  it('the published schema describes the section and the folder', () => {
    const schema = JSON.parse(readFileSync(join(__dirname, '..', '..', 'docs', 'public', 'schemas', 'testpion-bundle-v1.schema.json'), 'utf8'));
    const validate = new (Ajv2020 as unknown as new (o: object) => { compile(s: object): ((v: unknown) => boolean) & { errors?: unknown } })({ strict: false }).compile(schema);
    const src = source();
    src.updateWorkspace({ variables: [{ key: 'region', value: 'eu', enabled: true }] });
    const b = buildBundle(src, 'all');
    expect(validate(b.manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(b.manifest.items.find((i) => i.id === 'specs/petstore.yaml')?.folder).toBe('Public');
  });
});

describe('a folder or a request is exported as a part of its collection', () => {
  it('a folder keeps its place and its requests; the bundle holds a collection of its own', () => {
    const src = source();
    const ref = parseSelector(src, 'folder:api/Pets');
    expect(ref).toEqual({ kind: 'collection', id: 'api#f1' });
    const b = buildBundle(src, [ref]);
    const item = b.manifest.items.find((i) => i.kind === 'collection')!;
    expect(item.id).toBe('api-pets');
    expect(item.name).toBe('Kinds API / Pets');
    expect(item.summary?.partOf).toBe('Kinds API');
    expect(b.manifest.root).toEqual([{ kind: 'collection', id: 'api-pets' }]);
    const col = JSON.parse(readBundle(b.bytes).entries.get(item.entry!)!.toString('utf8')) as Collection;
    expect(col.items.map((x) => x.name)).toEqual(['Pets']);
    expect((col.items[0] as { items: Array<{ name: string }> }).items.map((x) => x.name)).toEqual(['List pets', 'Soap call']);
    expect(b.fileName).toBe('Kinds API - Pets.testpion.json');
  });

  it('a request keeps the folder above it with the folder’s own settings; several parts travel together', () => {
    const src = source();
    const col = src.getCollection('api');
    (col.items[0] as { headers?: unknown }).headers = [{ key: 'X-Team', value: 'pets', enabled: true }];
    src.saveCollection(col);
    const b = buildBundle(src, [parseSelector(src, 'request:api/r1')]);
    const item = b.manifest.items[0]!;
    const part = JSON.parse(readBundle(b.bytes).entries.get(item.entry!)!.toString('utf8')) as Collection;
    const folder = part.items[0] as { name: string; headers?: Array<{ key: string }>; items: Array<{ id: string }> };
    expect(folder.name).toBe('Pets');
    expect(folder.headers?.[0]?.key).toBe('X-Team');
    expect(folder.items.map((x) => x.id)).toEqual(['r1']);
    const two = buildBundle(src, [parseSelector(src, 'request:api/r1,g1')]);
    expect(two.manifest.items[0]!.name).toBe('Kinds API / List pets and 1 more');
    // ItemRefs name the same parts
    expect(parseSelector(src, { kind: 'request', collectionId: 'api', requestId: 'r1' })).toEqual({ kind: 'collection', id: 'api#r1' });
    expect(parseSelector(src, { kind: 'folder', collectionId: 'api', folderId: 'f1' })).toEqual({ kind: 'collection', id: 'api#f1' });
  });

  it('names a missing folder, a repeated name and a missing collection plainly', () => {
    const src = source();
    expect(() => parseSelector(src, 'folder:api/Nope')).toThrow(/No folder or request "Nope" in "Kinds API"/);
    expect(() => parseSelector(src, 'folder:nothing/Pets')).toThrow(/No collection "nothing"/);
    expect(() => parseSelector(src, 'folder:api')).toThrow(/Name the folder as folder:<collection>/);
    expect(() => buildBundle(src, [{ kind: 'collection', id: 'api#zzz' }])).toThrow(/No folder or request "zzz"/);
  });

  it('imports next to the original (Keep both by construction) and is identical the second time', () => {
    const src = source();
    const b = buildBundle(src, [parseSelector(src, 'folder:api/Pets')]);
    const dest = fresh();
    const out = applyImport(dest, readBundle(b.bytes));
    expect(out.created.map((c) => c.name)).toEqual(['Kinds API / Pets']);
    expect(dest.listCollections().map((c) => c.id)).toEqual(['api-pets']);
    expect(previewImport(dest, readBundle(b.bytes)).totals.identical).toBe(1);
    // into the workspace it came from: a collection beside the original, nothing replaced
    const again = applyImport(src, readBundle(b.bytes));
    expect(again.created).toHaveLength(1);
    expect(src.listCollections().map((c) => c.id).sort()).toEqual(['api', 'api-pets']);
  });

  it('brings what the part’s text uses (an environment) but not the whole collection’s saved items', () => {
    const src = source();
    const col = src.getCollection('api');
    (col.items[1] as { request: { endpoint: string } }).request.endpoint = '{{stagingHost}}/graphql';
    src.saveCollection(col);
    const staging = src.listEnvironments().find((e) => e.id === 'staging')!;
    src.saveEnvironment({ ...staging, variables: [...staging.variables, { key: 'stagingHost', value: 'https://s.example', enabled: true }] });
    const b = buildBundle(src, [parseSelector(src, 'request:api/g1')], { uses: true });
    const kinds = b.manifest.items.map((i) => i.kind).sort();
    expect(kinds).toEqual(['collection', 'environment']);
    expect(b.manifest.edges[0]?.from).toBe('collection:api-pets-query');
    expect(b.manifest.root).toEqual([{ kind: 'collection', id: 'api-pets-query' }]);
  });
});

describe('uses can leave items out', () => {
  it('an unticked item is not in the bundle and is listed as left out', () => {
    const src = source();
    const col = src.getCollection('api');
    (col.items[1] as { request: { endpoint: string } }).request.endpoint = '{{stagingHost}}/graphql';
    src.saveCollection(col);
    const staging = src.listEnvironments().find((e) => e.id === 'staging')!;
    src.saveEnvironment({ ...staging, variables: [...staging.variables, { key: 'stagingHost', value: 'https://s.example', enabled: true }] });
    const withEnv = buildBundle(src, [{ kind: 'collection', id: 'api' }], { uses: true });
    expect(withEnv.manifest.items.some((i) => i.kind === 'environment' && i.id === 'staging')).toBe(true);
    const without = buildBundle(src, [{ kind: 'collection', id: 'api' }], { uses: true, exclude: ['environment:staging'] });
    expect(without.manifest.items.some((i) => i.kind === 'environment' && i.id === 'staging')).toBe(false);
    expect(without.manifest.missing).toContainEqual({ from: 'collection:api', to: 'staging', reason: 'left out: you unticked it' });
    // a picked item is never left out
    const picked = buildBundle(src, [{ kind: 'collection', id: 'api' }, { kind: 'environment', id: 'staging' }], { uses: true, exclude: ['environment:staging'] });
    expect(picked.manifest.items.some((i) => i.kind === 'environment')).toBe(true);
  });
});

describe('virtual folders', () => {
  it('an API definition keeps its folder through a bundle, and Undo takes the folder back', () => {
    const src = source();
    const b = buildBundle(src, [{ kind: 'spec', id: 'specs/petstore.yaml' }]);
    expect(b.manifest.items[0]!.folder).toBe('Public');
    const dest = fresh();
    const out = applyImport(dest, readBundle(b.bytes));
    expect(out.placedInFolders).toBe(1);
    expect(dest.getLibrary('spec-folders').items.map((i) => `${i.id}:${i.folder}`)).toEqual(['specs/petstore.yaml:Public']);
    expect(dest.getLibrary('spec-folders').folders).toEqual(['Public']);
    undoImport(dest, out.importId);
    expect(existsSync(dest.path('specs', 'petstore.yaml'))).toBe(false);
    expect(dest.getLibrary('spec-folders').items).toEqual([]);
    expect(listImports(dest)[0]?.undone).toBe(true);
  });

  it('a dataset’s folder is by its name, Keep both follows the new name, and a file without a folder stays at the top', () => {
    const src = source();
    src.saveLibrary('dataset-folders', { folders: ['Seeds'], items: [{ id: 'users.csv', name: 'users.csv', folder: 'Seeds', data: null }] });
    const b = buildBundle(src, [{ kind: 'dataset', id: 'datasets/users.csv' }, { kind: 'dataset', id: 'datasets/nested/cases.jsonl' }]);
    expect(b.manifest.items.map((i) => `${i.id}:${i.folder ?? ''}`)).toEqual(['datasets/nested/cases.jsonl:', 'datasets/users.csv:Seeds']);
    const dest = fresh();
    mkdirSync(dest.path('datasets'), { recursive: true });
    writeFileSync(dest.path('datasets', 'users.csv'), 'other\n');
    const out = applyImport(dest, readBundle(b.bytes));
    expect(out.created.map((c) => c.target?.id).sort()).toEqual(['datasets/nested/cases.jsonl', 'datasets/users-2.csv']);
    expect(dest.getLibrary('dataset-folders').items.map((i) => `${i.id}:${i.folder}`)).toEqual(['users-2.csv:Seeds']);
  });

  it('the items in a folder of a list are found for an export', () => {
    const src = source();
    expect(folderRefs(src, 'spec', 'Public')).toEqual([{ kind: 'spec', id: 'specs/petstore.yaml' }]);
    expect(folderRefs(src, 'test', 'smoke').every((r) => r.id.startsWith('tests/smoke/'))).toBe(true);
    expect(() => folderRefs(src, 'spec', 'Empty')).toThrow(/holds nothing to export/);
    expect(() => folderRefs(src, 'run', 'x')).toThrow(/no folders a bundle can hold/);
    const servers = src.getMcpServers();
    src.saveMcpServers(servers.map((s) => ({ ...s, folder: 'Mocks' })));
    expect(folderRefs(src, 'mcp-server', 'Mocks')).toEqual([{ kind: 'mcp-server', id: 'weather' }]);
  });
});

describe('Import here: a bundle’s collection is added under a collection or a folder', () => {
  it('adds the folders and requests with new ids, the variables the requests need, and Undo restores the file byte for byte', () => {
    const src = source();
    const col = src.getCollection('api');
    col.variables = [{ key: 'petPath', value: '/pets', enabled: true }];
    src.saveCollection(col);
    const b = buildBundle(src, [parseSelector(src, 'folder:api/Pets')]);
    const dest = source();
    const before = readFileSync(dest.path(dest.collectionFileOf('api')), 'utf8');
    const out = applyImport(dest, readBundle(b.bytes), { into: { collectionId: 'api' } });
    expect(out.addedUnder).toEqual({ where: 'Kinds API', nodes: 1, variables: 1 });
    const after = dest.getCollection('api');
    expect(after.items.map((x) => x.name)).toEqual(['Pets', 'Pets query', 'Pets']);
    const ids = new Set<string>();
    const walk = (l: Collection['items']) => l.forEach((x) => (expect(ids.has(x.id), x.id).toBe(false), ids.add(x.id), x.kind === 'folder' && walk(x.items)));
    walk(after.items);
    expect(after.variables.map((v) => v.key)).toEqual(['petPath']);
    expect(out.created[0]!.target).toEqual({ id: 'api', name: 'Kinds API' });
    undoImport(dest, out.importId);
    expect(readFileSync(dest.path(dest.collectionFileOf('api')), 'utf8')).toBe(before);
  });

  it('under a folder, the target’s own settings are untouched, and a missing target is refused before anything is written', () => {
    const src = source();
    const b = buildBundle(src, [parseSelector(src, 'request:api/g1')]);
    const dest = source();
    const dcol = dest.getCollection('api');
    dcol.headers = [{ key: 'X-Own', value: '1', enabled: true }];
    dest.saveCollection(dcol);
    const out = applyImport(dest, readBundle(b.bytes), { into: { collectionId: 'api', folderId: 'f1' } });
    expect(out.addedUnder?.where).toBe('Kinds API / Pets');
    const folder = dest.getCollection('api').items[0] as { items: Array<{ name: string }> };
    expect(folder.items.map((x) => x.name)).toEqual(['List pets', 'Soap call', 'Pets query']);
    expect(dest.getCollection('api').headers?.[0]?.key).toBe('X-Own');
    const files = dest.listCollections().length;
    expect(() => applyImport(dest, readBundle(b.bytes), { into: { collectionId: 'api', folderId: 'nope' } })).toThrow(/No folder "nope" in collection "Kinds API"/);
    expect(() => applyImport(dest, readBundle(b.bytes), { into: { collectionId: 'ghost' } })).toThrow(/No collection "ghost" to import into/);
    expect(dest.listCollections()).toHaveLength(files);
    expect(listImports(dest).filter((i) => !i.undone)).toHaveLength(1);
  });

  it('a bundle imported here twice adds twice with different ids (nothing is merged away)', () => {
    const src = source();
    const b = buildBundle(src, [parseSelector(src, 'request:api/r1')]);
    const dest = source();
    applyImport(dest, readBundle(b.bytes), { into: { collectionId: 'api' } });
    applyImport(dest, readBundle(b.bytes), { into: { collectionId: 'api' } });
    expect(dest.getCollection('api').items.map((x) => x.name)).toEqual(['Pets', 'Pets query', 'Pets', 'Pets']);
  });
});
