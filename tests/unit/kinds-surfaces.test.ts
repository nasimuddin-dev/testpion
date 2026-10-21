import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { liveKinds } from '@testpion/shared';
import { WorkspaceStore, describeKinds } from '../../packages/core/src/index.js';
import { itemTools } from '../../packages/core/src/mcp-server/tools/item-tools.js';
import { kindTools } from '../../packages/core/src/mcp-server/tools/kind-tools.js';
import { withToolContract } from '../../packages/core/src/mcp-server/tool-contract.js';
import { TOOL_DOCS } from '../../packages/core/src/mcp-server/tool-docs.js';
import { runCliSync, tempDir } from '../helpers';

// REG-5: the registry for agents, one answer on every surface (CLI `testpion kinds --json`, MCP `list_kinds`, RPC kinds.list).
const t = tempDir('tp-kinds-surfaces-', { alias: true });
const store = WorkspaceStore.create(join(t.dir, 'ws'), 'Kinds');
afterAll(() => {
  store.close();
  t.cleanup();
});

describe('kinds for agents', () => {
  it('lists every live kind with its capabilities, and one kind by alias', () => {
    const r = describeKinds({}, store);
    expect(r.kinds.map((k) => k.id)).toEqual(liveKinds().map((k) => k.id));
    expect(r.workspace).toEqual({ git: false, libraries: [] });
    const mcp = r.kinds.find((k) => k.id === 'mcp-server')!;
    expect(mcp.can).toEqual(expect.arrayContaining(['open', 'rename', 'delete', 'trash']));
    expect(mcp.facets).toEqual(['resolve', 'ops']);
    expect(describeKinds({ kind: 'library:grpc' }).kinds.map((k) => k.id)).toEqual(['grpc-call']);
    expect(describeKinds({ all: true }).kinds.some((k) => k.id === 'metric' && !k.since)).toBe(true);
    expect(() => describeKinds({ kind: 'nope' })).toThrow(/Unknown kind "nope"/);
  });

  it('MCP list_kinds goes through the tool contract (its docs entry composes the description)', async () => {
    const [tool] = withToolContract(kindTools({ store }), { docs: TOOL_DOCS });
    expect(tool!.name).toBe('list_kinds');
    expect(tool!.description).toMatch(/Use it to learn what an item of a kind offers/);
    const r = (await tool!.run({ kind: 'dataset' })) as { kinds: Array<{ id: string }> };
    expect(JSON.stringify(r)).toContain('"dataset"');
  });

  it('CLI kinds --json prints the envelope', () => {
    const r = runCliSync(['kinds', 'spec', '--json', '-w', store.root]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.out) as { status: string; command: string; data: { kinds: Array<{ id: string; can: string[] }>; workspace: unknown } };
    expect(env.status).toBe('ok');
    expect(env.command).toBe('kinds');
    expect(env.data.kinds[0]).toMatchObject({ id: 'spec' });
    expect(env.data.kinds[0]!.can).toEqual(expect.arrayContaining(['rename', 'delete', 'move']));
    const bad = runCliSync(['kinds', 'nope', '--json']);
    expect(bad.status).toBe(2);
    // the menus of its rows, for agents
    expect(env.data.kinds[0]).toHaveProperty('nodes');
  });

  it('CLI item delete / restore (--json) and MCP delete_item / restore_item go through the same ops', async () => {
    store.saveEnvironment({ id: 'tmp-env', name: 'Tmp env', variables: [] });
    const del = runCliSync(['item', 'delete', 'environment:tmp-env', '--json', '-w', store.root]);
    expect(del.status).toBe(0);
    const gone = (JSON.parse(del.out) as { data: { trashId: string; kind: string; name: string } }).data;
    expect(gone).toMatchObject({ kind: 'environment', name: 'Tmp env' });
    expect(store.getEnvironment('tmp-env')).toBeUndefined();
    const back = runCliSync(['item', 'restore', gone.trashId, '--json', '-w', store.root]);
    expect(JSON.parse(back.out).data).toMatchObject({ kind: 'environment', id: 'tmp-env' });
    expect(runCliSync(['item', 'delete', 'test:smoke/x.yaml', '--json', '-w', store.root]).status).not.toBe(0);
    const tools = itemTools({ store });
    const run = (n: string, a: Record<string, unknown>) => tools.find((t) => t.name === n)!.run(a) as { trashId: string };
    const r = run('delete_item', { ref: 'environment:tmp-env' });
    expect(store.getEnvironment('tmp-env')).toBeUndefined();
    run('restore_item', { trash_id: r.trashId });
    expect(store.getEnvironment('tmp-env')).toBeDefined();
  });
});
