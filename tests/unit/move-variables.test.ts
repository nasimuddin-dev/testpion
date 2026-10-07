import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySecretStore, moveCollectionVariablesToEnvironments, WorkspaceStore } from '../../packages/core/src/index.js';

describe('moving collection variables to environments', () => {
  it('copies the values into each environment (keeping theirs), removes them from the collection; a dry run changes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-move-'));
    const store = WorkspaceStore.create(dir, 'move');
    try {
      store.saveCollection({
        schemaVersion: '1.0',
        id: 'c',
        name: 'Master',
        version: 1,
        updatedAt: '',
        items: [],
        variables: [{ key: 'bannerBaseUrl', value: 'http://localhost:5002' }, { key: 'pageSize', value: '20' }, { key: 'token', value: '', secret: true } as never],
      });
      store.saveEnvironment({ id: 'dev', name: 'Development', variables: [] });
      store.saveEnvironment({ id: 'prod', name: 'Production', variables: [{ key: 'bannerBaseUrl', value: 'https://banners.example.com' }] });
      const secrets = new MemorySecretStore();
      const dry = await moveCollectionVariablesToEnvironments(store, { collectionId: 'c', keys: ['bannerBaseUrl', 'token'], environments: ['Development', 'prod'], dryRun: true, secrets });
      expect(dry.environments).toEqual([
        { id: 'dev', name: 'Development', added: ['bannerBaseUrl', 'token'], kept: [] },
        { id: 'prod', name: 'Production', added: ['token'], kept: ['bannerBaseUrl'] },
      ]);
      expect(store.getCollection('c').variables).toHaveLength(3);
      await moveCollectionVariablesToEnvironments(store, { collectionId: 'c', keys: ['bannerBaseUrl', 'token'], environments: ['Development', 'prod'], secrets });
      expect(store.getCollection('c').variables.map((v) => v.key)).toEqual(['pageSize']);
      expect(store.getEnvironment('dev')!.variables).toEqual([
        { key: 'bannerBaseUrl', value: 'http://localhost:5002', enabled: true },
        { key: 'token', value: '', enabled: true, secret: true },
      ]);
      expect(store.getEnvironment('prod')!.variables.find((v) => v.key === 'bannerBaseUrl')!.value).toBe('https://banners.example.com');
      await expect(moveCollectionVariablesToEnvironments(store, { collectionId: 'c', keys: ['nope'], environments: ['dev'] })).rejects.toThrow(/Not variables of Master: nope/);
      await expect(moveCollectionVariablesToEnvironments(store, { collectionId: 'c', environments: ['Staging'] })).rejects.toThrow(/No environment "Staging"/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
