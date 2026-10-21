import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceStore } from '../../packages/core/src/index.js';
import { readZip, ZIP_LIMITS } from '../../packages/core/src/transfer/zip.js';
import { bundleTools } from '../../packages/core/src/mcp-server/tools/bundle-tools.js';
import { runCliSync, tempDir } from '../helpers';

// the leftovers of export and import on the command line and over MCP: a folder or a request, a folder of a list, the Globals,
// Import here, and a collection package for Postman or Bruno

const FIXTURE = join(__dirname, '..', 'fixtures', 'kinds', 'workspace');
const t = tempDir('tp-cli-bundle-left-', { alias: true });
let a: WorkspaceStore;
let b: WorkspaceStore;
afterAll(() => {
  a?.close();
  b?.close();
  t.cleanup();
});
beforeAll(() => {
  a = WorkspaceStore.create(join(t.dir, 'a'), 'A');
  cpSync(FIXTURE, a.root, { recursive: true });
  a.updateWorkspace({ variables: [{ key: 'region', value: 'eu', enabled: true }] });
  b = WorkspaceStore.create(join(t.dir, 'b'), 'B');
  cpSync(FIXTURE, b.root, { recursive: true });
});

const cli = (args: string[]) => {
  const r = runCliSync(args);
  let env: { status: string; data: any; errors: Array<{ message: string }> } | undefined;
  try {
    env = JSON.parse(r.out);
  } catch {
    /* not JSON */
  }
  return { ...r, env };
};

describe('testpion export: a part of a collection, a folder of a list, the Globals', () => {
  it('folder:<collection>/<folder> and request:<collection>/<request> export a collection of their own', () => {
    const f = cli(['export', 'folder:api/Pets', '--out', join(t.dir, 'pets.testpion.json'), '--json', '-w', a.root]);
    expect(f.status).toBe(0);
    expect(f.env!.data.items).toEqual([{ kind: 'collection', id: 'api-pets', name: 'Kinds API / Pets' }]);
    const r = cli(['export', 'request:api/r1', '--out', join(t.dir, 'one.testpion.json'), '--json', '-w', a.root]);
    expect(r.env!.data.items[0]).toMatchObject({ kind: 'collection', id: 'api-list-pets' });
    const bad = cli(['export', 'folder:api/Nope', '--out', join(t.dir, 'x.json'), '--json', '-w', a.root]);
    expect(bad.status).toBe(2);
    expect(bad.env!.errors[0]!.message).toMatch(/No folder or request "Nope"/);
  });

  it('--folder <kind>:<name> takes the items in a folder of a list; --globals and --no-globals decide on the Globals', () => {
    const s = cli(['export', '--folder', 'spec:Public', '--out', join(t.dir, 'public.testpion.json'), '--json', '-w', a.root]);
    expect(s.status).toBe(0);
    expect(s.env!.data.items).toEqual([expect.objectContaining({ kind: 'spec', id: 'specs/petstore.yaml' })]);
    expect(cli(['export', '--folder', 'spec:Empty', '--out', join(t.dir, 'e.json'), '--json', '-w', a.root]).status).toBe(2);
    const all = cli(['export', '--all', '--out', join(t.dir, 'all.testpion.json'), '--format', 'bundle', '--json', '-w', a.root]);
    expect(JSON.parse(readFileSync(join(t.dir, 'all.testpion.json'), 'utf8')).workspace.variables).toEqual([{ key: 'region', value: 'eu', enabled: true }]);
    void all;
    cli(['export', '--all', '--no-globals', '--out', join(t.dir, 'noglobals.testpion.json'), '--json', '-w', a.root]);
    expect(JSON.parse(readFileSync(join(t.dir, 'noglobals.testpion.json'), 'utf8')).workspace).toBeUndefined();
    cli(['export', 'collection:api', '--globals', '--out', join(t.dir, 'withglobals.testpion.json'), '--json', '-w', a.root]);
    expect(JSON.parse(readFileSync(join(t.dir, 'withglobals.testpion.json'), 'utf8')).workspace.variables).toHaveLength(1);
  });

  it('--exclude leaves a used item out and says so', () => {
    const r = cli(['export', 'collection:api', '--uses', '--exclude', 'environment:development', '--out', join(t.dir, 'ex.testpion.json'), '--json', '-w', a.root]);
    expect(r.status).toBe(0);
    expect(r.env!.data.items.some((i: { kind: string; id: string }) => i.kind === 'environment' && i.id === 'development')).toBe(false);
    expect(r.env!.data.missing).toContainEqual(expect.objectContaining({ to: 'development', reason: 'left out: you unticked it' }));
  });
});

describe('testpion import: the Globals and Import here', () => {
  it('--globals merge adds the new keys; replace takes the values; the preview counts them', () => {
    const file = join(t.dir, 'all.testpion.json');
    const pre = cli(['import', file, '--preview', '--json', '-w', b.root]);
    expect(pre.env!.data.workspace.counts).toEqual({ new: 1, same: 0, differs: 0 });
    const done = cli(['import', file, '--only', 'workspace', '--globals', 'merge', '--json', '-w', b.root]);
    expect(done.status).toBe(0);
    expect(done.env!.data.workspaceVariables).toEqual({ added: 1, replaced: 0, kept: 0 });
    expect(cli(['import', file, '--only', 'workspace', '--globals', 'sometimes', '--json', '-w', b.root]).status).toBe(2);
    const undo = cli(['import', '--undo', done.env!.data.importId, '--json', '-w', b.root]);
    expect(undo.status).toBe(0);
  });

  it('--into <collection>/<folder> adds the bundle’s requests under it, with an Undo', () => {
    const before = readFileSync(join(b.root, b.collectionFileOf('api')), 'utf8');
    const r = cli(['import', join(t.dir, 'one.testpion.json'), '--into', 'api/f1', '--json', '-w', b.root]);
    expect(r.status).toBe(0);
    expect(r.env!.data.addedUnder).toMatchObject({ where: 'Kinds API / Pets', nodes: 1 });
    const bad = cli(['import', join(t.dir, 'one.testpion.json'), '--into', 'api/nope', '--json', '-w', b.root]);
    expect(bad.status).toBe(2);
    expect(bad.env!.errors[0]!.message).toMatch(/No folder "nope"/);
    expect(cli(['import', '--undo', r.env!.data.importId, '--json', '-w', b.root]).status).toBe(0);
    expect(readFileSync(join(b.root, b.collectionFileOf('api')), 'utf8')).toBe(before);
  });
});

describe('testpion export --extras: a collection for Postman or Bruno with what it uses', () => {
  it('--format postman --extras writes one zip; --format bruno --extras writes a folder', () => {
    const zipPath = join(t.dir, 'api.postman.zip');
    const p = cli(['export', 'api', '--format', 'postman', '--extras', '--out', zipPath, '--json', '-w', a.root]);
    expect(p.status).toBe(0);
    const names = readZip(readFileSync(zipPath), ZIP_LIMITS).map((e) => e.name);
    expect(names).toContain('Kinds API.postman_collection.json');
    expect(names).toContain('globals.postman_globals.json');
    expect(names).toContain('README.md');
    const folder = join(t.dir, 'bruno');
    const q = cli(['export', 'api', '--format', 'bruno', '--extras', '--out', folder, '--json', '-w', a.root]);
    expect(q.status).toBe(0);
    expect(existsSync(join(folder, 'bruno.json'))).toBe(true);
    expect(existsSync(join(folder, 'README.md'))).toBe(true);
    // only postman and bruno have a package
    expect(cli(['export', 'api', '--format', 'openapi', '--extras', '--json', '-w', a.root]).status).toBe(2);
    expect(cli(['export', 'api', '--format', 'bruno', '--extras', '--json', '-w', a.root]).status).toBe(2);
  });
});

describe('MCP: the same options', () => {
  it('export_bundle takes a folder, the Globals, an exclude list and a package; import_bundle_apply takes globals and into', async () => {
    const tools = bundleTools({ store: a });
    const destStore = WorkspaceStore.create(join(t.dir, 'mcp-dest'), 'Dest');
    cpSync(FIXTURE, destStore.root, { recursive: true });
    const dest = bundleTools({ store: destStore });
    const call = async (list: typeof tools, name: string, args: Record<string, unknown>) => (await list.find((x) => x.name === name)!.run(args)) as any;
    const f = await call(tools, 'export_bundle', { items: ['folder:api/Pets'], globals: true });
    expect(f.items[0]).toMatchObject({ kind: 'collection', id: 'api-pets' });
    const spec = await call(tools, 'export_bundle', { folder: { kind: 'spec', name: 'Public' } });
    expect(spec.counts).toEqual({ spec: 1 });
    const pkg = await call(tools, 'export_bundle', { items: ['collection:api'], package: 'postman' });
    expect(pkg.path).toMatch(/\.local\/exports\/.*\.postman\.zip$/);
    expect(pkg.files).toContain('globals.postman_globals.json');
    await expect(call(tools, 'export_bundle', { items: ['folder:api/Pets'], package: 'postman' })).rejects.toThrow(/one whole collection/);
    const bytes = readFileSync(f.absolutePath).toString('base64');
    const pre = await call(dest, 'import_bundle_preview', { base64: bytes });
    expect(pre.workspace.counts.new).toBe(1);
    const applied = await call(dest, 'import_bundle_apply', { plan_id: pre.plan_id, globals: 'merge', into: { collection_id: 'api', folder_id: 'f1' } });
    expect(applied.addedUnder).toMatchObject({ where: 'Kinds API / Pets' });
    expect(applied.workspaceVariables).toEqual({ added: 1, replaced: 0, kept: 0 });
    destStore.close();
  });
});
