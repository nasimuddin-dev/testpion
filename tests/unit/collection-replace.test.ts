import { describe, expect, it } from 'vitest';
import { replaceInCollection, type Collection } from '../../packages/core/src/index.js';

const c: Collection = {
  schemaVersion: '1.0',
  id: 'c',
  name: 'Clinic',
  version: 1,
  variables: [],
  updatedAt: '',
  items: [
    {
      kind: 'folder',
      id: 'f1',
      name: 'Admin',
      items: [
        {
          kind: 'http',
          id: 'r1',
          name: 'Get banner',
          request: {
            method: 'GET',
            url: 'http://old.host:5002/api/banners?x=1',
            params: [{ key: 'host', value: 'old.host' }],
            headers: [{ key: 'X-Old-Host', value: 'old.host' }],
            auth: { type: 'bearer', token: '{{oldToken}}' },
          },
          testScript: "pm.expect(pm.response.json().host).to.eql('old.host');",
        },
      ],
    },
    { kind: 'http', id: 'r2', name: 'Create', request: { method: 'POST', url: 'http://OLD.host/api/x', body: { type: 'json', content: '{"host":"old.host"}' } } },
    { kind: 'graphql', id: 'g1', name: 'Q', request: { endpoint: 'http://old.host/graphql', query: '{ a }' } },
  ],
};

describe('find and replace in a collection', () => {
  it('replaces in every field, case-insensitive by default, and lists each change', () => {
    const { collection, matches } = replaceInCollection(c, { find: 'old.host', replace: 'new.host' });
    expect(matches.map((m) => `${m.request} · ${m.where}`)).toEqual([
      'Admin / Get banner · test script',
      'Admin / Get banner · URL',
      'Admin / Get banner · param host',
      'Admin / Get banner · header X-Old-Host',
      'Create · URL',
      'Create · body',
      'Q · endpoint',
    ]);
    const r1 = (collection.items[0] as any).items[0];
    expect(r1.request.url).toBe('http://new.host:5002/api/banners?x=1');
    expect(r1.request.headers[0]).toEqual({ key: 'X-Old-Host', value: 'new.host' });
    expect((collection.items[1] as any).request.body.content).toBe('{"host":"new.host"}');
    // the original is untouched
    expect((c.items[1] as any).request.url).toBe('http://OLD.host/api/x');
  });

  it('narrows to fields, a folder, and exact case', () => {
    expect(replaceInCollection(c, { find: 'old.host', replace: 'x', fields: ['url'] }).matches.map((m) => m.where)).toEqual(['URL', 'URL', 'endpoint']);
    expect(replaceInCollection(c, { find: 'old.host', replace: 'x', folderId: 'f1' }).matches.every((m) => m.requestId === 'r1')).toBe(true);
    expect(replaceInCollection(c, { find: 'OLD.host', replace: 'x', caseSensitive: true }).matches.map((m) => m.requestId)).toEqual(['r2']);
  });

  it('regular expressions with groups; a plain replacement is literal', () => {
    const { matches } = replaceInCollection(c, { find: '\\{\\{old(\\w+)\\}\\}', replace: '{{new$1}}', regex: true, fields: ['auth'] });
    expect(matches).toEqual([{ requestId: 'r1', request: 'Admin / Get banner', field: 'auth', where: 'auth token', before: '{{oldToken}}', after: '{{newToken}}' }]);
    expect(replaceInCollection(c, { find: 'x=1', replace: '$&$1', fields: ['url'] }).matches[0]!.after).toBe('http://old.host:5002/api/banners?$&$1');
    expect(() => replaceInCollection(c, { find: '(', replace: '', regex: true })).toThrow(/Not a valid regular expression/);
  });
});
