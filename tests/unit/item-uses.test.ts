import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { itemUses, WorkspaceStore } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

/**
 * "Uses and used by" (transfer/item-uses.ts): the direct edges of the reading an export makes, turned the way the files
 * read: a monitor uses its collection, an environment is used by the collection whose variables it defines.
 */
const FIXTURE = join(__dirname, '..', 'fixtures', 'kinds', 'workspace');
let t: ReturnType<typeof tempDir>;
let store: WorkspaceStore;
beforeAll(() => {
  t = tempDir('tp-item-uses-', { alias: true });
  store = WorkspaceStore.create(join(t.dir, 'ws'), 'Uses');
  cpSync(FIXTURE, store.root, { recursive: true });
});
afterAll(() => {
  store?.close();
  t?.cleanup();
});

const keys = (rows: Array<{ kind: string; id: string }>) => rows.map((r) => `${r.kind}:${r.id}`);

describe('what an item uses and what uses it', () => {
  it('a collection uses the environment that defines its variables, and is used by what belongs to it', () => {
    const r = itemUses(store, 'collection:api');
    expect(r.item).toMatchObject({ kind: 'collection', id: 'api', name: 'Kinds API' });
    // (a new workspace has a Development environment that defines baseUrl too)
    expect(keys(r.uses)).toContain('environment:staging');
    expect(keys(r.usedBy)).toEqual(['grpc-call:g-call', 'load-test:lt-pets', 'monitor:mon-pets', 'ws-connection:ws-echo']);
    expect(r.uses.find((u) => u.id === 'staging')).toMatchObject({ name: 'Staging', ref: { kind: 'environment', environmentId: 'staging' } });
  });
  it('the other side of each edge agrees', () => {
    expect(keys(itemUses(store, 'environment:staging').usedBy)).toEqual(['collection:api']);
    const monitor = itemUses(store, { kind: 'monitor', monitorId: 'mon-pets' });
    expect(keys(monitor.uses)).toEqual(['collection:api']);
    expect(monitor.uses[0]!.via).toBe('its collection');
    expect(monitor.usedBy).toEqual([]);
  });
  it('takes every form of a ref, and a request answers for its own text', () => {
    expect(itemUses(store, 'saved:rag-targets:rag-clinic').item).toMatchObject({ kind: 'rag-target', name: 'Clinic bot' });
    expect(itemUses(store, { kind: 'git-file', path: 'protos/greeter.proto' }).item.kind).toBe('proto');
    const request = itemUses(store, 'request:api/r1');
    expect(keys(request.uses)).toContain('environment:staging');
    expect(request.usedBy).toEqual([]);
  });
  it('says so when the item is not there', () => {
    expect(() => itemUses(store, 'collection:nope')).toThrow(/No collection "nope" in this workspace/);
    expect(() => itemUses(store, 'nonsense')).toThrow(/Not an item of the workspace/);
    expect(() => itemUses(store, { kind: 'run', runId: 'x' })).toThrow(/Not an item of the workspace/);
  });
});
