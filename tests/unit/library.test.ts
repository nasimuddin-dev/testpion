import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceManager, WorkspaceSearch, WorkspaceStore } from '../../packages/core/src/index.js';

describe('workspace library (saved items with folders)', () => {
  it('saves items and folders per kind, keeps empty folders, and adds folders items refer to', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-lib-'));
    const store = WorkspaceStore.create(dir, 'lib');
    try {
      expect(store.getLibrary('websocket')).toMatchObject({ folders: [], items: [] });
      const saved = store.saveLibrary('websocket', {
        folders: ['Empty folder'],
        items: [
          { id: 'a', name: 'Echo', folder: 'Local', data: { url: 'ws://127.0.0.1:4013' } },
          { id: '', name: '', data: { url: 'wss://x' } },
        ],
      });
      expect(saved.folders).toEqual(['Empty folder', 'Local']);
      expect(saved.items[1]!.id).toMatch(/^lib-/);
      expect(saved.items[1]!.name).toBe('Untitled');
      expect(store.getLibrary('websocket').items.map((i) => i.name)).toEqual(['Echo', 'Untitled']);
      expect(store.getLibrary('ai-prompts').items).toEqual([]);
      expect(() => store.getLibrary('../secrets')).toThrow(/Invalid library kind/);

      // global search finds saved items by name and URL
      const hits = new WorkspaceSearch(store).search('4013');
      expect(hits.find((h) => h.kind === 'saved')).toMatchObject({ title: 'Echo', ref: { library: 'websocket', itemId: 'a' } });

      // workspace export / import carries the saved items and folders
      const bundle = store.exportBundle();
      expect(Object.keys(bundle.library ?? {})).toEqual(['websocket']);
      const imported = new WorkspaceManager(join(dir, 'app')).importBundle(bundle, 'copy');
      try {
        // saved outside a collection (an older export): each goes into one, named after its folder or "Connections"
        const col = (name: string) => imported.listCollections().find((c) => c.name === name)?.id;
        expect(imported.getLibrary('websocket')).toMatchObject({ folders: ['Empty folder'], items: [{ id: 'a', name: 'Echo', collectionId: col('Local') }, { name: 'Untitled', collectionId: col('Connections') }] });
        expect(imported.getLibrary('websocket').items[0]!.folder).toBeUndefined();
      } finally {
        imported.close();
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('global search', () => {
  it('finds monitors and saved load tests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-search-'));
    const store = WorkspaceStore.create(dir, 'search');
    try {
      store.saveLibrary('monitors', { folders: [], items: [{ id: 'm', name: 'Checkout health', data: { everyMinutes: 15 } }] });
      store.saveLibrary('load-tests', { folders: [], items: [{ id: 'l', name: 'Checkout under load', data: { url: 'http://localhost/checkout' } }] });
      const found = new WorkspaceSearch(store).search('checkout');
      expect(found.filter((h) => h.kind === 'saved').map((h) => [h.title, h.ref.library])).toEqual(
        expect.arrayContaining([
          ['Checkout health', 'monitors'],
          ['Checkout under load', 'load-tests'],
        ]),
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
