import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { WorkspaceStore, importIntoWorkspace, listTrash, replaceSpecWithImported, restoreFromTrash } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// EX-G3: importing an API definition never overwrites the one a workspace has under the same name.
const tmp = tempDir('tp-spec-keep-', { alias: true });
const store = WorkspaceStore.create(`${tmp.dir}/ws`, 'Specs');
afterAll(() => {
  store.close();
  tmp.cleanup();
});

const spec = (version: string, path = '/pets') =>
  `openapi: 3.0.0\ninfo:\n  title: Petstore\n  version: "${version}"\npaths:\n  ${path}:\n    get:\n      responses:\n        "200":\n          description: ok\n`;
const asyncSpec = (v: string) =>
  `asyncapi: 2.6.0\ninfo:\n  title: Events\n  version: "${v}"\nservers:\n  prod:\n    url: ws://localhost:9000\n    protocol: ws\nchannels:\n  pets:\n    subscribe:\n      message:\n        payload:\n          type: object\n`;

describe('spec import: keep both', () => {
  it('the first import keeps specs/<slug>; the same document again reuses it', () => {
    const r = importIntoWorkspace(store, spec('1'));
    expect(r.specPath).toBe('specs/petstore.openapi.yaml');
    expect(r.specKeptBoth).toBeUndefined();
    const again = importIntoWorkspace(store, spec('1'));
    expect(again.specPath).toBe('specs/petstore.openapi.yaml');
    expect(again.notes ?? []).not.toContainEqual(expect.stringMatching(/Saved as/));
  });

  it('a different document is saved as -2 (then -3), the existing one untouched, with a note', () => {
    const r = importIntoWorkspace(store, spec('2'));
    expect(r.specPath).toBe('specs/petstore-2.openapi.yaml');
    expect(r.specKeptBoth).toEqual({ existing: 'specs/petstore.openapi.yaml' });
    expect(r.notes).toContainEqual(expect.stringMatching(/^Saved as specs\/petstore-2\.openapi\.yaml: specs\/petstore\.openapi\.yaml holds a different document/));
    expect(readFileSync(store.path('specs', 'petstore.openapi.yaml'), 'utf8')).toBe(spec('1'));
    expect(readFileSync(store.path('specs', 'petstore-2.openapi.yaml'), 'utf8')).toBe(spec('2'));
    // the new collection's contract checks name the file it was saved as
    const checks = JSON.stringify(r.collection);
    expect(checks).toContain('specs/petstore-2.openapi.yaml');
    expect(importIntoWorkspace(store, spec('3')).specPath).toBe('specs/petstore-3.openapi.yaml');
  });

  it('AsyncAPI documents keep both the same way', () => {
    expect(importIntoWorkspace(store, asyncSpec('1')).specPath).toBe('specs/asyncapi/events.yaml');
    const r = importIntoWorkspace(store, asyncSpec('2'));
    expect(r.specPath).toBe('specs/asyncapi/events-2.yaml');
    expect(readFileSync(store.path('specs', 'asyncapi', 'events.yaml'), 'utf8')).toBe(asyncSpec('1'));
  });

  it('Replace instead: the kept copy takes the name, the old one goes to the trash (undoable), checks follow', () => {
    const r = importIntoWorkspace(store, spec('4', '/owners'));
    expect(r.specPath).toBe('specs/petstore-4.openapi.yaml');
    const done = replaceSpecWithImported(store, { kept: r.specPath!, original: r.specKeptBoth!.existing, collectionId: r.collection!.id });
    expect(done.specPath).toBe('specs/petstore.openapi.yaml');
    expect(done.contractChecks).toBe(1);
    expect(existsSync(store.path('specs', 'petstore-4.openapi.yaml'))).toBe(false);
    expect(readFileSync(store.path('specs', 'petstore.openapi.yaml'), 'utf8')).toBe(spec('4', '/owners'));
    expect(JSON.stringify(store.getCollection(r.collection!.id))).toContain('"spec":"specs/petstore.openapi.yaml"');
    const trashed = listTrash(store).find((i) => i.id === done.trashId)!;
    expect(trashed).toMatchObject({ kind: 'spec', itemId: 'specs/petstore.openapi.yaml' });
    // undo: the earlier document comes back beside it (never over it)
    expect(restoreFromTrash(store, done.trashId!).id).toBe('specs/petstore.openapi-restored.yaml');
    expect(readFileSync(store.path('specs', 'petstore.openapi-restored.yaml'), 'utf8')).toBe(spec('1'));
    expect(() => replaceSpecWithImported(store, { kept: '../workspace.json', original: 'specs/petstore.openapi.yaml' })).toThrow();
  });

  it('specs: replace replaces at once, the old document in the trash', () => {
    const r = importIntoWorkspace(store, spec('5'), { specs: 'replace' });
    expect(r.specPath).toBe('specs/petstore.openapi.yaml');
    expect(r.specReplaced?.path).toBe('specs/petstore.openapi.yaml');
    expect(r.notes).toContainEqual(expect.stringMatching(/^Replaced specs\/petstore\.openapi\.yaml/));
    expect(listTrash(store).some((i) => i.id === r.specReplaced!.trashId)).toBe(true);
  });
});
