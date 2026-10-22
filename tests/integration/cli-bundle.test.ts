import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceStore } from '../../packages/core/src/index.js';
import { bundleTools } from '../../packages/core/src/mcp-server/tools/bundle-tools.js';
import { withToolContract } from '../../packages/core/src/mcp-server/tool-contract.js';
import { TOOL_DOCS } from '../../packages/core/src/mcp-server/tool-docs.js';
import { runCliSync, tempDir } from '../helpers';

// export and import of bundles on the command line and over MCP: the same core as the app's dialogs
const FIXTURE = join(__dirname, '..', 'fixtures', 'kinds', 'workspace');
const t = tempDir('tp-cli-bundle-', { alias: true });
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
  b = WorkspaceStore.create(join(t.dir, 'b'), 'B');
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

describe('testpion export / import with bundles', () => {
  const zip = () => join(t.dir, 'api.testpion.zip');

  it('export <kind:id> --uses writes a zip with what the collection uses (--json)', () => {
    const r = cli(['export', 'collection:api', '--uses', '--out', zip(), '--json', '-w', a.root]);
    expect(r.status).toBe(0);
    expect(r.env!.data.path).toBe(zip());
    expect(readFileSync(zip()).subarray(0, 2).toString()).toBe('PK');
    const kinds = new Set((r.env!.data.items as Array<{ kind: string }>).map((i) => i.kind));
    expect([...kinds].sort()).toEqual(['collection', 'environment', 'grpc-call', 'load-test', 'monitor', 'ws-connection']);
  });

  it('export --section and --all; a flag a collection export does not take is refused with a hint', () => {
    const r = cli(['export', '--section', 'dataset', '--out', join(t.dir, 'data.testpion.json'), '--json', '-w', a.root]);
    expect(r.status).toBe(0);
    expect(r.env!.data.counts).toEqual({ dataset: 2 });
    expect(JSON.parse(readFileSync(join(t.dir, 'data.testpion.json'), 'utf8')).format).toBe('testpion-bundle');
    const all = cli(['export', '--all', '--out', join(t.dir, 'all.testpion.zip'), '--json', '-w', a.root]);
    expect(all.env!.data.items.length).toBeGreaterThan(14);
    expect(all.env!.data.counts.provider).toBeUndefined();
    const none = cli(['export', '--json', '-w', a.root]);
    expect(none.status).not.toBe(0);
    expect(none.env!.errors[0]!.message).toMatch(/Give one collection/);
    const gone = cli(['export', 'spec:specs/missing.yaml', '--out', join(t.dir, 'x.zip'), '--json', '-w', a.root]);
    expect(gone.status).toBe(2);
    expect(existsSync(join(t.dir, 'x.zip'))).toBe(false);
  });

  it('a collection still exports in its formats (nothing changed for them)', () => {
    const r = runCliSync(['export', 'api', '--format', 'testpion', '-w', a.root]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out).id).toBe('api');
  });

  it('bundle inspect reads a bundle without a workspace', () => {
    const r = cli(['bundle', 'inspect', zip(), '--json']);
    expect(r.status).toBe(0);
    expect(r.env!.data.counts).toMatchObject({ collection: 1, monitor: 1 });
    expect(r.env!.data.summary).toContain('Collection');
    expect(cli(['bundle', 'inspect', join(t.dir, 'nope.zip'), '--json']).status).toBe(2);
  });

  it('import --preview --json says what would happen and changes nothing', () => {
    const r = cli(['import', zip(), '--preview', '--json', '-w', b.root]);
    expect(r.status).toBe(0);
    // the new workspace's default environment is in the bundle too (it uses {{baseUrl}}): already here, identical
    expect(r.env!.data.totals).toMatchObject({ create: 6, identical: 1, conflict: 0 });
    expect(b.listCollections()).toHaveLength(0);
  });

  it('import applies, a second import is all identical, --on-conflict and --undo work', () => {
    const first = cli(['import', zip(), '--json', '-w', b.root]);
    expect(first.status).toBe(0);
    expect(first.env!.data.created).toHaveLength(6);
    expect(b.getCollection('api').name).toBe('Kinds API');
    const again = cli(['import', zip(), '--json', '-w', b.root]);
    expect(again.env!.data.created).toHaveLength(0);
    expect(again.env!.data.skipped.every((s: { why: string }) => s.why.includes('identical'))).toBe(true);

    // change the workspace's own collection: now it is a conflict
    b.saveCollection({ ...b.getCollection('api'), description: 'mine' });
    const skip = cli(['import', zip(), '--on-conflict', 'skip', '--json', '-w', b.root]);
    expect(skip.env!.data.created).toHaveLength(0);
    expect(b.listCollections()).toHaveLength(1);
    const both = cli(['import', zip(), '--json', '-w', b.root]);
    expect(both.env!.data.created.map((c: { target: { id: string } }) => c.target.id)).toEqual(['api-2']);
    expect(
      b
        .listCollections()
        .map((c) => c.id)
        .sort(),
    ).toEqual(['api', 'api-2']);
    const undo = cli(['import', '--undo', both.env!.data.importId, '--yes', '--json', '-w', b.root]);
    expect(undo.status).toBe(0);
    expect(b.listCollections().map((c) => c.id)).toEqual(['api']);
    const list = cli(['import', '--list', '--json', '-w', b.root]);
    expect(list.env!.data.length).toBeGreaterThanOrEqual(2);
    const replace = cli(['import', zip(), '--on-conflict', 'replace', '--json', '-w', b.root]);
    expect(replace.env!.data.replaced).toHaveLength(1);
    expect(b.getCollection('api').description).toBeUndefined();
    expect(cli(['import', zip(), '--on-conflict', 'merge', '--json', '-w', b.root]).status).toBe(2);
  });

  it('--dry-run changes nothing, and a hostile file is refused with a reason (exit 2)', () => {
    const c = WorkspaceStore.create(join(t.dir, 'c'), 'C');
    const dry = cli(['import', zip(), '--dry-run', '--json', '-w', c.root]);
    expect(dry.status).toBe(0);
    expect(c.listCollections()).toHaveLength(0);
    const evil = join(t.dir, 'evil.testpion.zip');
    writeFileSync(evil, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40, 1)]));
    const bad = cli(['import', evil, '--json', '-w', c.root]);
    expect(bad.status).toBe(2);
    expect(bad.env!.errors[0]!.message).toMatch(/Not a valid TestPion bundle/);
    const big = cli(['import', zip(), '--max-size', '0.0001', '--json', '-w', c.root]);
    expect(big.status).toBe(2);
    expect(big.env!.errors[0]!.message).toMatch(/larger than/);
    c.close();
  });
});

describe('MCP bundle tools', () => {
  it('export, describe, preview, apply (needs the plan), undo', async () => {
    const dest = WorkspaceStore.create(join(t.dir, 'mcp-dest'), 'Dest');
    const tools = bundleTools({ store: a });
    const destTools = bundleTools({ store: dest });
    const call = async (list: typeof tools, name: string, args: Record<string, unknown>) => (await list.find((x) => x.name === name)!.run(args)) as any;
    expect(tools.map((x) => x.name)).toEqual(['export_bundle', 'describe_bundle', 'import_bundle_preview', 'import_bundle_apply', 'undo_import']);

    const exp = await call(tools, 'export_bundle', { items: ['collection:api'], uses: true });
    expect(exp.path).toMatch(/^\.local\/exports\/.*\.testpion\.(zip|json)$/);
    expect(existsSync(exp.absolutePath)).toBe(true);
    // a second export under the same default name gets a number instead of replacing the first
    const second = await call(tools, 'export_bundle', { items: ['collection:api'], uses: true });
    expect(second.path).not.toBe(exp.path);
    expect(existsSync(exp.absolutePath)).toBe(true);
    // an explicit `out` is a new file under exports/ or .local/exports/ and nothing else: never a definition, a hook, a config or an existing file
    const ours = await call(tools, 'export_bundle', { items: ['collection:api'], out: 'exports/mine.testpion.zip' });
    expect(ours.path).toBe('exports/mine.testpion.zip');
    for (const out of ['exports/mine.testpion.zip', 'collections/api.json', 'workspace.json', '.git/hooks/pre-commit', '.husky/pre-commit', 'package.json', 'mcp-servers.json', 'exports/.x/y.zip', 'exports/run.bat'])
      await expect(call(tools, 'export_bundle', { items: ['collection:api'], out }), out).rejects.toThrow(/already exists|not allowed/);
    // the export cannot write outside the workspace
    await expect(call(tools, 'export_bundle', { items: ['collection:api'], out: '../outside.zip' })).rejects.toThrow(/escapes the workspace/);
    await expect(call(tools, 'export_bundle', {})).rejects.toThrow(/Name what to export/);

    const bytes = readFileSync(exp.absolutePath).toString('base64');
    expect((await call(destTools, 'describe_bundle', { base64: bytes })).counts).toMatchObject({ collection: 1 });
    // applying needs a plan from a preview
    await expect(call(destTools, 'import_bundle_apply', { plan_id: 'plan-doesnotexist' })).rejects.toThrow(/No import plan/);
    const pre = await call(destTools, 'import_bundle_preview', { base64: bytes });
    expect(pre.plan_id).toMatch(/^plan-/);
    expect(pre.totals.create).toBe(6);
    expect(dest.listCollections()).toHaveLength(0);
    const applied = await call(destTools, 'import_bundle_apply', { plan_id: pre.plan_id, on_conflict: 'keep-both' });
    expect(applied.created).toHaveLength(6);
    // a plan belongs to the workspace it was made for
    await expect(call(tools, 'import_bundle_apply', { plan_id: pre.plan_id })).rejects.toThrow(/No import plan/);
    const undone = await call(destTools, 'undo_import', { import_id: applied.importId });
    expect(undone.removed).toBeGreaterThan(0);
    expect(dest.listCollections()).toHaveLength(0);
    expect((await call(destTools, 'undo_import', {})).imports[0].undone).toBe(true);
    dest.close();
  });

  it('the contract: docs in every description, and the apply and the undo ask for confirmation', async () => {
    const dest = WorkspaceStore.create(join(t.dir, 'mcp-contract'), 'Contract');
    const tools = withToolContract(bundleTools({ store: dest }), { docs: TOOL_DOCS });
    for (const x of tools) expect(x.description, x.name).toMatch(/Use it/);
    const apply = tools.find((x) => x.name === 'import_bundle_apply')!;
    expect(JSON.stringify(await apply.run({ plan_id: 'plan-anything' }))).toContain('confirmationRequired');
    expect(JSON.stringify(await tools.find((x) => x.name === 'undo_import')!.run({ import_id: 'imp-abcdef123456' }))).toContain('confirmationRequired');
    dest.close();
  });
});
