import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { checkFileName, checkKindPath, folderOfWorkspaceFile, WorkspaceStore } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

/**
 * MENU-2: dataset folders are virtual (library/dataset-folders.json, like spec-folders and mcp-folders): the files never
 * move, so `dataset:` paths in tests, bundles and git stay stable. Rename and Duplicate keep an item's folder; an API
 * definition renames in its folder and deletes to Recently deleted (Undo puts it back in its folder).
 */
const open: Array<{ be: Backend; cleanup(): void }> = [];
function fresh() {
  const t = tempDir('tp-dsfolders-', { alias: true });
  const be = new Backend({ appDir: t.dir, emit: () => {}, noMonitors: true });
  open.push({ be, cleanup: t.cleanup });
  const store = (be as unknown as { store: WorkspaceStore }).store;
  const call = <T>(m: string, p: unknown = {}) => Promise.resolve().then(() => be.invoke(m, p) as Promise<T>);
  return { be, store, call };
}
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.be.dispose();
    o.cleanup();
  }
});

type Lib = { folders: string[]; items: Array<{ id: string; folder?: string }> };

describe('dataset folders', () => {
  it('a dataset keeps its folder when renamed or duplicated, and the file never moves into a folder', async () => {
    const { store, call } = fresh();
    mkdirSync(store.path('datasets'), { recursive: true });
    writeFileSync(store.path('datasets', 'users.csv'), 'id\n1\n');
    await call('lib.save', { kind: 'dataset-folders', library: { folders: ['Customers'], items: [{ id: 'users.csv', name: 'users.csv', folder: 'Customers', data: null }] } });
    const renamed = await call<{ name: string }>('datasets.rename', { name: 'users.csv', to: 'people' });
    expect(renamed.name).toBe('people.csv');
    expect(existsSync(store.path('datasets', 'people.csv'))).toBe(true);
    let lib = await call<Lib>('lib.get', { kind: 'dataset-folders' });
    expect(lib.items.map((i) => [i.id, i.folder])).toEqual([['people.csv', 'Customers']]);
    const copy = await call<{ name: string }>('datasets.duplicate', { name: 'people.csv' });
    lib = await call<Lib>('lib.get', { kind: 'dataset-folders' });
    expect(lib.items.map((i) => [i.id, i.folder])).toEqual([
      ['people.csv', 'Customers'],
      [copy.name, 'Customers'],
    ]);
    // the folder is virtual: the files stay where they are
    expect(existsSync(store.path('datasets', 'Customers'))).toBe(false);
  });

  it('an API definition renames in its folder, keeps its virtual folder, and deletes with Undo', async () => {
    const { store, call } = fresh();
    mkdirSync(store.path('specs'), { recursive: true });
    writeFileSync(store.path('specs', 'pets.yaml'), 'openapi: 3.0.0\n');
    await call('lib.save', { kind: 'spec-folders', library: { folders: ['Public'], items: [{ id: 'specs/pets.yaml', name: 'specs/pets.yaml', folder: 'Public', data: null }] } });
    expect(await call('openapi.spec.rename', { path: 'specs/pets.yaml', to: 'petstore' })).toEqual({ path: 'specs/petstore.yaml' });
    const lib = await call<Lib>('lib.get', { kind: 'spec-folders' });
    expect(lib.items.map((i) => [i.id, i.folder])).toEqual([['specs/petstore.yaml', 'Public']]);
    writeFileSync(store.path('specs', 'other.yaml'), 'openapi: 3.0.0\n');
    await expect(call('openapi.spec.rename', { path: 'specs/petstore.yaml', to: 'other.yaml' })).rejects.toMatchObject({ kind: 'ValidationError' });
    const { trashId } = await call<{ trashId: string }>('openapi.spec.delete', { path: 'specs/petstore.yaml' });
    expect(existsSync(store.path('specs', 'petstore.yaml'))).toBe(false);
    await call('trash.restore', { id: trashId });
    expect(existsSync(store.path('specs', 'petstore.yaml'))).toBe(true);
    // still in its folder: the folder library kept it
    expect((await call<Lib>('lib.get', { kind: 'spec-folders' })).items[0]).toMatchObject({ id: 'specs/petstore.yaml', folder: 'Public' });
  });

  it('names and paths are checked lexically, the same on every OS', () => {
    for (const bad of ['', 'a/b', 'a\\b', 'C:x', 'con.yaml', 'x.', 'a|b', '..', 'x'.repeat(101)]) expect(() => checkFileName(bad), JSON.stringify(bad)).toThrow(/Not a usable file name/);
    expect(checkFileName(' orders-v2.yaml ')).toBe('orders-v2.yaml');
    for (const bad of ['specs', 'specs/', 'specs/../x', 'datasets/x', 'specs\\x.yaml', 'C:/specs/x', 'specs//x']) expect(() => checkKindPath(bad, 'specs'), bad).toThrow(/Not a file in specs/);
    expect(checkKindPath('specs/asyncapi/x.yaml', 'specs')).toBe('specs/asyncapi/x.yaml');
  });

  it('Reveal file opens the folder that holds a workspace file, never the file, never outside the workspace', () => {
    const t = tempDir('tp-reveal-', { alias: true });
    const store = WorkspaceStore.create(join(t.dir, 'ws'), 'Reveal');
    try {
      mkdirSync(store.path('specs', 'asyncapi'), { recursive: true });
      writeFileSync(store.path('specs', 'asyncapi', 'e.yaml'), 'x');
      expect(folderOfWorkspaceFile(store, 'specs/asyncapi/e.yaml')).toBe(store.path('specs', 'asyncapi'));
      for (const bad of ['../x', '/etc/passwd', 'C:\\x', 'specs\\x', '']) expect(() => folderOfWorkspaceFile(store, bad), bad).toThrow();
    } finally {
      store.close();
      t.cleanup();
    }
  });
});
