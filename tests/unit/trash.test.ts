import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceManager, WorkspaceStore, listTrash, purgeTrash, restoreFromTrash, trashMcpServer, trashSpec, TRASH_DAYS } from '../../packages/core/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'tp-trash-'));
const store = WorkspaceStore.create(join(dir, 'ws'), 'Trash');
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const collection = (id: string, name: string) =>
  ({ schemaVersion: '1.0', id, name, version: 0, variables: [], updatedAt: '', items: [{ kind: 'folder', id: 'f', name: 'F', items: [{ kind: 'http', id: 'r', name: 'R', request: { method: 'GET', url: 'x' } }] }] }) as never;

describe('recently deleted', () => {
  it('deleting moves collections and environments to a git-ignored trash, restorable', () => {
    store.saveCollection(collection('api', 'My API'));
    store.saveEnvironment({ id: 'staging', name: 'Staging', variables: [{ key: 'a', value: '1', enabled: true }] });
    store.deleteCollection('api');
    store.deleteEnvironment('staging');
    expect(store.listCollections().map((c) => c.id)).not.toContain('api');
    expect(readFileSync(store.path('trash', '.gitignore'), 'utf8')).toContain('*');
    const items = listTrash(store);
    expect(items.map((i) => [i.kind, i.name, i.size])).toEqual(expect.arrayContaining([['collection', 'My API', 1], ['environment', 'Staging', 1]]));

    const r = restoreFromTrash(store, items.find((i) => i.kind === 'collection')!.id);
    expect(r).toEqual({ kind: 'collection', id: 'api', name: 'My API' });
    expect(store.getCollection('api').items).toHaveLength(1);
    expect(listTrash(store).map((i) => i.kind)).toEqual(['environment']);
  });

  it('a restored item never overwrites one with the same name', () => {
    store.saveEnvironment({ id: 'staging', name: 'Staging', variables: [] });
    const r = restoreFromTrash(store, listTrash(store)[0]!.id);
    expect(r.name).toBe('Staging (restored)');
    expect(r.id).not.toBe('staging');
    expect(store.getEnvironment('staging')?.variables).toEqual([]);
    expect(store.getEnvironment('Staging (restored)')?.variables).toHaveLength(1);
  });

  it('forgets items after 30 days, purges on request, and is left out of copies', () => {
    store.saveCollection(collection('old', 'Old'));
    store.deleteCollection('old');
    // pretend it was deleted 31 days ago
    const d = store.path('trash', 'collections');
    const f = readdirSync(d)[0]!;
    renameSync(join(d, f), join(d, f.replace(/^\d+/, String(Date.now() - (TRASH_DAYS + 1) * 86_400_000))));
    expect(listTrash(store)).toEqual([]);

    store.saveCollection(collection('b', 'B'));
    store.deleteCollection('b');
    const copy = new WorkspaceManager(join(dir, 'app')).duplicate(store.root, 'Copy');
    expect(existsSync(join(copy.path, 'trash'))).toBe(false);
    expect(purgeTrash(store)).toBe(1);
    expect(listTrash(store)).toEqual([]);
    expect(() => restoreFromTrash(store, 'collection/../../workspace.json')).toThrow(/Not a trash entry/);
  });
});

describe('recently deleted: API definitions and MCP servers (EX-G6)', () => {
  it('an MCP server goes to the trash and comes back with its id, config and place in the list', () => {
    const servers = [
      { id: 'a', name: 'A', transport: 'streamable-http' as const, url: 'https://a.example/mcp', headers: [{ key: 'Authorization', value: '{{token}}', enabled: true }] },
      { id: 'b', name: 'B', transport: 'stdio' as const, command: 'node', args: ['b.js'], env: { MODE: 'x' } },
      { id: 'c', name: 'C', transport: 'mock' as const, mockFile: 'mocks/c.mcp-mock.yaml' },
    ];
    store.saveMcpServers(servers);
    const { trashId, server } = trashMcpServer(store, 'b');
    expect(server.name).toBe('B');
    expect(store.getMcpServers().map((s) => s.id)).toEqual(['a', 'c']);
    const item = listTrash(store).find((i) => i.id === trashId)!;
    expect(item).toMatchObject({ kind: 'mcp-server', itemId: 'b', name: 'B' });
    expect(restoreFromTrash(store, trashId)).toEqual({ kind: 'mcp-server', id: 'b', name: 'B' });
    expect(store.getMcpServers()).toEqual(servers);
    expect(listTrash(store).some((i) => i.id === trashId)).toBe(false);
    expect(() => trashMcpServer(store, 'nope')).toThrow(/Unknown MCP server/);
  });

  it('a restored MCP server whose id is taken again gets a new id, never replacing the live one', () => {
    const { trashId } = trashMcpServer(store, 'a');
    store.saveMcpServers([{ id: 'a', name: 'A', transport: 'mock', mockFile: 'mocks/other.yaml' }, ...store.getMcpServers()]);
    const r = restoreFromTrash(store, trashId);
    expect(r.id).not.toBe('a');
    expect(r.name).toBe('A (restored)');
    expect(store.getMcpServers().find((s) => s.id === 'a')).toMatchObject({ transport: 'mock', mockFile: 'mocks/other.yaml' });
  });

  it('an API definition goes to the trash with its path (asyncapi/ too) and comes back there', () => {
    mkdirSync(store.path('specs', 'asyncapi'), { recursive: true });
    writeFileSync(store.path('specs', 'pets.openapi.yaml'), 'openapi: 3.0.0\n');
    writeFileSync(store.path('specs', 'asyncapi', 'events.yaml'), 'asyncapi: 2.6.0\n');
    const one = trashSpec(store, 'specs/pets.openapi.yaml');
    const two = trashSpec(store, 'specs/asyncapi/events.yaml');
    expect(existsSync(store.path('specs', 'pets.openapi.yaml'))).toBe(false);
    expect(listTrash(store).filter((i) => i.kind === 'spec').map((i) => i.itemId).sort()).toEqual(['specs/asyncapi/events.yaml', 'specs/pets.openapi.yaml']);
    expect(restoreFromTrash(store, two)).toEqual({ kind: 'spec', id: 'specs/asyncapi/events.yaml', name: 'asyncapi/events.yaml' });
    expect(readFileSync(store.path('specs', 'asyncapi', 'events.yaml'), 'utf8')).toBe('asyncapi: 2.6.0\n');
    // the name is taken again: restored beside it, never over it
    writeFileSync(store.path('specs', 'pets.openapi.yaml'), 'openapi: 3.1.0\n');
    expect(restoreFromTrash(store, one).id).toBe('specs/pets.openapi-restored.yaml');
    expect(readFileSync(store.path('specs', 'pets.openapi.yaml'), 'utf8')).toBe('openapi: 3.1.0\n');
    expect(() => trashSpec(store, '../workspace.json')).toThrow(/specs/);
    expect(() => trashSpec(store, 'specs/../workspace.json')).toThrow();
    expect(() => restoreFromTrash(store, 'spec/1--..%2F..%2Fworkspace.json')).toThrow();
    // a malformed %-sequence (a file put there by hand) is refused with a normalised error, never a URIError
    expect(() => restoreFromTrash(store, 'spec/1--%E0%A4%A.yaml')).toThrow(expect.objectContaining({ kind: 'ValidationError' }));
  });
});
