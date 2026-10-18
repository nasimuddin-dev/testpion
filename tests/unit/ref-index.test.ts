import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { WorkspaceStore, resolveItemRef } from '../../packages/core/src/index.js';
import { environmentIndex, fileListIndex } from '../../packages/core/src/kinds/ref-index.js';
import { tempDir } from '../helpers';

/**
 * Refs to environments, variables, MCP servers and providers resolve through an index of their own file (rebuilt only
 * when the file's stamp changed), never by reading every environment per call.
 */
const FIXTURE = join(__dirname, '..', 'fixtures', 'kinds', 'workspace');
let t: ReturnType<typeof tempDir>;
let store: WorkspaceStore;
beforeAll(() => {
  t = tempDir('tp-ref-index-', { alias: true });
  store = WorkspaceStore.create(join(t.dir, 'ws'), 'Index');
  cpSync(FIXTURE, store.root, { recursive: true });
});
afterAll(() => {
  store?.close();
  t?.cleanup();
});

describe('environment index', () => {
  it('names an environment and its variables from its own file, and follows a change to the file', () => {
    const e = environmentIndex(store, 'staging')!;
    expect(e.name).toBe('Staging');
    expect(e.byId.get('staging')).toMatchObject({ kind: 'environment', name: 'Staging' });
    expect(e.byId.has('var:baseUrl')).toBe(true);
    expect(environmentIndex(store, 'nope')).toBeUndefined();
    // the same object while the file is unchanged; a new one after it changed
    expect(environmentIndex(store, 'staging')).toBe(e);
    const env = store.getEnvironment('staging')!;
    store.saveEnvironment({ ...env, name: 'Staging 2', variables: [...env.variables, { key: 'added', value: '1', enabled: true }] });
    const e2 = environmentIndex(store, 'staging')!;
    expect(e2).not.toBe(e);
    expect(e2.name).toBe('Staging 2');
    expect(e2.byId.has('var:added')).toBe(true);
    store.saveEnvironment(env);
  });

  it('resolves refs without listing every environment, with the same answers', () => {
    const list = vi.spyOn(store, 'listEnvironments');
    expect(resolveItemRef(store, { kind: 'environment', environmentId: 'staging' })).toMatchObject({ ok: true, label: 'Staging', detail: 'Environment' });
    expect(resolveItemRef(store, { kind: 'variable', key: 'baseUrl', environmentId: 'staging' })).toMatchObject({ ok: true, label: 'baseUrl', detail: 'Variable in Staging' });
    expect(resolveItemRef(store, { kind: 'variable', key: 'nope', environmentId: 'staging' })).toMatchObject({ ok: false, next: { label: 'Open Staging', ref: { kind: 'environment', environmentId: 'staging' } } });
    expect(resolveItemRef(store, { kind: 'environment', environmentId: 'gone' })).toMatchObject({ ok: false, reason: 'missing' });
    expect(resolveItemRef(store, { kind: 'variable', key: 'x', environmentId: 'gone' })).toMatchObject({ ok: false, reason: 'missing' });
    expect(list).not.toHaveBeenCalled();
    list.mockRestore();
  });

  it('an unreadable environment file still names the environment by its file, as the list does', () => {
    writeFileSync(store.path('environments', 'broken.json'), '{ not json');
    expect(environmentIndex(store, 'broken')?.name).toBe('broken');
    expect(resolveItemRef(store, { kind: 'environment', environmentId: 'broken' })).toMatchObject({ ok: true, label: 'broken' });
    fs.rmSync(store.path('environments', 'broken.json'));
  });
});

describe('file list index', () => {
  it('names the items of a list kept in one file and follows a change', () => {
    const servers = fileListIndex(store, 'mcp-servers.json', 'servers')!;
    expect(servers.byId.get('weather')?.name).toBe('Weather mock');
    expect(fileListIndex(store, 'providers.json', 'providers')?.byId.get('demo')?.name).toBe('Demo model');
    expect(fileListIndex(store, 'nope.json', 'x')).toBeUndefined();
    store.saveMcpServers(store.getMcpServers().map((s) => (s.id === 'weather' ? { ...s, name: 'Weather' } : s)));
    expect(fileListIndex(store, 'mcp-servers.json', 'servers')?.byId.get('weather')?.name).toBe('Weather');
    expect(resolveItemRef(store, { kind: 'mcp-server', serverId: 'weather' })).toMatchObject({ ok: true, label: 'Weather' });
    expect(resolveItemRef(store, { kind: 'mcp-server', serverId: 'gone' })).toMatchObject({ ok: false });
    expect(resolveItemRef(store, { kind: 'provider', providerId: 'demo' })).toMatchObject({ ok: true, label: 'Demo model', detail: 'AI provider' });
  });
});
