import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, collectNodeIds, importIntoWorkspace, type Collection } from '../../packages/core/src/index.js';
import { importAny } from '../helpers-import.js';

// An imported collection never shares folder / request ids with another collection of the workspace (shared ids made
// the sidebar repeat rows): colliding ids are renamed, and a note says how many.

const native: Collection = {
  schemaVersion: '1.0',
  id: 'clinic',
  name: 'Clinic',
  version: 0,
  variables: [],
  updatedAt: '2026-10-17T00:00:00.000Z',
  items: [
    { kind: 'folder', id: 'fld-patients', name: 'Patients', items: [{ kind: 'http', id: 'req-list', name: 'List', request: { method: 'GET', url: 'https://clinic.test/patients', headers: [] } }] },
    { kind: 'http', id: 'req-login', name: 'Log in', request: { method: 'POST', url: 'https://clinic.test/login', headers: [] } },
  ],
};
const text = JSON.stringify(native);

let dir: string;
let store: WorkspaceStore;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tp-import-ids-'));
  store = WorkspaceStore.create(dir, 'Ids');
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const ids = (c: Collection) => [...collectNodeIds(c.items)];

describe('imports keep node ids unique in the workspace', () => {
  it('the first import of a TestPion file keeps its ids', () => {
    const r = importIntoWorkspace(store, text);
    expect(ids(r.collection!)).toEqual(['fld-patients', 'req-list', 'req-login']);
    expect(r.notes ?? []).toEqual([]);
  });

  it('importing the same file again gives new ids, and says so', () => {
    const r = importIntoWorkspace(store, text);
    const second = ids(r.collection!);
    expect(second).toHaveLength(3);
    for (const id of second) expect(['fld-patients', 'req-list', 'req-login']).not.toContain(id);
    expect(r.notes).toContain('3 request and folder ids were renamed because another collection of the workspace (or the file itself) uses them');
    const all = store.listCollections().flatMap((c) => ids(c));
    expect(new Set(all).size).toBe(all.length);
  });

  it('only the colliding ids change', () => {
    const partly = { ...native, id: 'other', items: [native.items[1]!, { kind: 'http', id: 'req-new', name: 'New', request: { method: 'GET', url: 'https://clinic.test/new', headers: [] } }] };
    const r = importAny(JSON.stringify(partly), { takenIds: ['req-login'] });
    expect(ids(r.collection!)[1]).toBe('req-new');
    expect(ids(r.collection!)[0]).not.toBe('req-login');
    expect(r.notes).toEqual(['1 request and folder id was renamed because another collection of the workspace (or the file itself) uses them']);
  });

  it('ids a file repeats are made unique too', () => {
    const dup = { ...native, items: [native.items[1]!, native.items[1]!] };
    const r = importAny(JSON.stringify(dup));
    expect(new Set(ids(r.collection!)).size).toBe(2);
  });
});
