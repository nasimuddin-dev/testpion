import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { liveKinds } from '@testpion/shared';
import { WorkspaceStore, describeKinds } from '../../packages/core/src/index.js';
import { kindTools } from '../../packages/core/src/mcp-server/kind-tools.js';
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
    expect(describeKinds({ all: true }).kinds.some((k) => k.id === 'rag-target' && k.since === '0.60')).toBe(true);
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
  });
});
