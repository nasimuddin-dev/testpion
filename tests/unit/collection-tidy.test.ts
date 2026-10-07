import { describe, expect, it } from 'vitest';
import { applyTidy, tidyCollection, type Collection } from '../../packages/core/src/index.js';

const req = (id: string, name: string, method: string, url: string, extra: Record<string, unknown> = {}) => ({ kind: 'http' as const, id, name, request: { method, url, ...extra } });

const c: Collection = {
  schemaVersion: '1.0',
  id: 'c',
  name: 'Master',
  version: 1,
  updatedAt: '',
  variables: [
    { key: 'bannerBaseUrl', value: 'http://localhost:5002' },
    { key: 'unusedOne', value: 'x' },
    { key: 'readInScript', value: 'y' },
  ],
  items: [
    {
      kind: 'folder',
      id: 'admin',
      name: 'Admin',
      items: [
        req('a1', 'GetBanner (GET banner/:id)', 'GET', '{{bannerBaseUrl}}/api/banners?b=2&a=1'),
        req('a2', 'GetBanner (GET api/banners)', 'GET', '{{bannerBaseUrl}}/api/banners/?a=1&b=2'),
        req('a3', 'Create', 'POST', 'http://localhost:5002/api/banners', { body: { type: 'json', content: '{"a": 1}' } }),
        req('a4', 'Create again', 'POST', 'http://LOCALHOST:5002/api/banners', { body: { type: 'json', content: '{"a":1}' } }),
        { kind: 'folder', id: 'empty', name: 'Old', items: [{ kind: 'folder', id: 'empty2', name: 'Older', items: [] }] },
      ],
    },
    { ...req('s1', 'Script', 'GET', 'https://api.example.com/x'), testScript: "pm.collectionVariables.get('readInScript')" },
  ],
};

describe('tidying a collection', () => {
  it('finds duplicates (query order and spaces ignored), typed-in hosts, empty folders and unused variables', () => {
    const f = tidyCollection(c);
    expect(f.filter((x) => x.kind === 'duplicate').map((x) => x.ids)).toEqual([
      ['a1', 'a2'],
      ['a3', 'a4'],
    ]);
    expect(f.filter((x) => x.kind === 'hard-coded-host').map((x) => [x.host, x.ids.length])).toEqual([
      ['http://localhost:5002', 2],
      ['https://api.example.com', 1],
    ]);
    expect(f.filter((x) => x.kind === 'empty-folder').map((x) => x.where[0])).toEqual(['Admin / Old']);
    expect(f.filter((x) => x.kind === 'unused-variable').map((x) => x.variable)).toEqual(['unusedOne']);
  });

  it('removes the copies (keeping the first), empty folders and unused variables when asked', () => {
    const { collection, removed } = applyTidy(c, { removeDuplicates: true, removeEmptyFolders: true, removeUnusedVariables: true });
    expect(removed).toBe(4);
    const admin = collection.items[0] as { items: Array<{ id: string }> };
    expect(admin.items.map((n) => n.id)).toEqual(['a1', 'a3']);
    expect(collection.variables.map((v) => v.key)).toEqual(['bannerBaseUrl', 'readInScript']);
    expect(applyTidy(c, {}).removed).toBe(0);
  });
});
