import { describe, expect, it } from 'vitest';
import { importAny, type CollectionFolder, type CollectionNode, type SavedHttpRequest } from '../../packages/core/src/index.js';
import { mapForeignAuth, type ForeignTool } from '../../packages/core/src/import/foreign-auth.js';

// IMP-FIX-1: an auth scheme TestPion doesn't have is never `inherit` (the request would quietly send the parent's
// credentials): it becomes `none`, a disabled placeholder header naming the scheme, and a note naming the item.

const flat = (nodes: CollectionNode[]): CollectionNode[] => nodes.flatMap((n) => (n.kind === 'folder' ? [n, ...flat(n.items)] : [n]));
const byName = (nodes: CollectionNode[], name: string) => flat(nodes).find((n) => n.name === name) as SavedHttpRequest;

const UNKNOWN: Record<ForeignTool, string[]> = {
  postman: ['hawk', 'ntlm', 'edgegrid', 'asap', 'wsse', 'brand-new-scheme'],
  insomnia: ['hawk', 'ntlm', 'asap', 'netrc', 'wsse', 'brand-new-scheme'],
  bruno: ['ntlm', 'wsse', 'akamai-edgegrid', 'hawk', 'brand-new-scheme'],
  hoppscotch: ['aws-signature', 'hawk', 'akamai-eg', 'brand-new-scheme'],
};

const postman = (type: string, attrs: Array<{ key: string; value: string }> = [{ key: 'authId', value: 'x' }]) =>
  JSON.stringify({
    info: { _postman_id: 'p1', name: 'Auth zoo', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      { name: 'Secured', request: { method: 'GET', url: 'https://api.test/x', header: [{ key: 'Accept', value: 'application/json' }], auth: { type, [type]: attrs } } },
      { name: 'Plain', request: { method: 'GET', url: 'https://api.test/y' } },
    ],
  });
const insomnia = (authentication: object) =>
  JSON.stringify({
    _type: 'export',
    __export_format: 4,
    resources: [
      { _id: 'wrk_1', _type: 'workspace', name: 'Auth zoo' },
      { _id: 'req_1', _type: 'request', parentId: 'wrk_1', name: 'Secured', method: 'GET', url: 'https://api.test/x', authentication },
    ],
  });
const bruno = (auth: object) =>
  JSON.stringify({ name: 'Auth zoo', version: '1', items: [{ type: 'http-request', name: 'Secured', seq: 1, request: { url: 'https://api.test/x', method: 'GET', headers: [], params: [], auth } }] });
const hoppscotch = (auth: object) =>
  JSON.stringify({ v: 2, name: 'Auth zoo', folders: [], requests: [{ name: 'Secured', method: 'GET', endpoint: 'https://api.test/x', params: [], headers: [], auth }] });

const imported = (tool: ForeignTool, type: string) => {
  const text = tool === 'postman' ? postman(type) : tool === 'insomnia' ? insomnia({ type }) : tool === 'bruno' ? bruno({ mode: type }) : hoppscotch({ authType: type, authActive: true });
  const r = importAny(text);
  return { r, req: byName(r.collection!.items, 'Secured') };
};

describe('an unsupported auth scheme is never inherit', () => {
  for (const [tool, types] of Object.entries(UNKNOWN) as Array<[ForeignTool, string[]]>)
    for (const type of types)
      it(`${tool}: ${type} → none + a disabled placeholder header + a note`, () => {
        const { r, req } = imported(tool, type);
        expect(req.request.auth).toEqual({ type: 'none' });
        const placeholder = req.request.headers.filter((h) => h.key.startsWith('X-Imported-Auth-'));
        expect(placeholder).toHaveLength(1);
        expect(placeholder[0]).toMatchObject({ value: 'needs manual setup', enabled: false });
        expect(r.notes?.find((n) => n.includes('"Secured"') && n.includes(`"${type}"`) && /not inherited/.test(n))).toBeTruthy();
      });

  it('names the scheme in the placeholder header', () => {
    expect(imported('postman', 'hawk').req.request.headers.at(-1)!.key).toBe('X-Imported-Auth-Hawk');
    expect(imported('postman', 'ntlm').req.request.headers.at(-1)!.key).toBe('X-Imported-Auth-NTLM');
    expect(imported('bruno', 'akamai-edgegrid').req.request.headers.at(-1)!.key).toBe('X-Imported-Auth-EdgeGrid');
    expect(imported('insomnia', 'brand-new-scheme').req.request.headers.at(-1)!.key).toBe('X-Imported-Auth-Brand-new-scheme');
  });

  it('keeps the request’s own headers and adds nothing to a request without auth (it inherits)', () => {
    const { r } = imported('postman', 'hawk');
    expect(byName(r.collection!.items, 'Secured').request.headers[0]).toEqual({ key: 'Accept', value: 'application/json', enabled: true });
    const plain = byName(r.collection!.items, 'Plain');
    expect(plain.request.auth).toEqual({ type: 'inherit' });
    expect(plain.request.headers).toEqual([]);
  });

  it('a folder or collection with an unsupported scheme gets none and a note (no headers to hold a placeholder)', () => {
    const text = JSON.stringify({
      info: { _postman_id: 'p2', name: 'Zoo', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      auth: { type: 'ntlm', ntlm: [] },
      item: [{ name: 'Edge', auth: { type: 'edgegrid', edgegrid: [] }, item: [{ name: 'Inside', request: { method: 'GET', url: 'https://api.test/z' } }] }],
    });
    const r = importAny(text);
    expect(r.collection!.auth).toEqual({ type: 'none' });
    expect((r.collection!.items[0] as CollectionFolder).auth).toEqual({ type: 'none' });
    expect(r.notes).toEqual(expect.arrayContaining([expect.stringContaining('"Zoo": Postman auth "ntlm"'), expect.stringContaining('"Edge": Postman auth "edgegrid"')]));
  });
});

describe('JWT maps to TestPion’s JWT auth', () => {
  it('Postman jwt (HS256) → jwt with secret, payload and prefix', () => {
    const r = importAny(
      postman('jwt', [
        { key: 'algorithm', value: 'HS384' },
        { key: 'secret', value: '{{jwtSecret}}' },
        { key: 'payload', value: '{"sub":"vet"}' },
        { key: 'headerPrefix', value: 'JWT' },
        { key: 'addTokenTo', value: 'header' },
      ]),
    );
    expect(byName(r.collection!.items, 'Secured').request.auth).toEqual({ type: 'jwt', secret: '{{jwtSecret}}', algorithm: 'HS384', payload: '{"sub":"vet"}', prefix: 'JWT' });
    expect(r.notes ?? []).toEqual([]);
  });

  it('Postman jwt sent as a query parameter: still JWT auth, with a note', () => {
    const r = importAny(
      postman('jwt', [
        { key: 'algorithm', value: 'HS256' },
        { key: 'secret', value: 's' },
        { key: 'payload', value: '{}' },
        { key: 'addTokenTo', value: 'queryParam' },
      ]),
    );
    expect(byName(r.collection!.items, 'Secured').request.auth).toMatchObject({ type: 'jwt', algorithm: 'HS256' });
    expect(r.notes).toEqual([expect.stringContaining('Authorization header')]);
  });

  it('an RS256 JWT cannot be signed by TestPion: none + placeholder + note', () => {
    const r = importAny(
      postman('jwt', [
        { key: 'algorithm', value: 'RS256' },
        { key: 'privateKey', value: 'k' },
      ]),
    );
    const req = byName(r.collection!.items, 'Secured');
    expect(req.request.auth).toEqual({ type: 'none' });
    expect(req.request.headers.at(-1)).toEqual({ key: 'X-Imported-Auth-JWT', value: 'needs manual setup', enabled: false });
    expect(r.notes![0]).toMatch(/RS256/);
  });

  it('Insomnia, Bruno and Hoppscotch jwt', () => {
    expect(importAny(insomnia({ type: 'jwt', algorithm: 'HS512', secret: '{{ _.key }}', payload: { sub: 1 } })).collection!.items[0]).toMatchObject({
      request: { auth: { type: 'jwt', algorithm: 'HS512', secret: '{{key}}', payload: '{"sub":1}' } },
    });
    expect(importAny(bruno({ mode: 'jwt', jwt: { algorithm: 'HS256', secret: 's', payload: '{}' } })).collection!.items[0]).toMatchObject({ request: { auth: { type: 'jwt', secret: 's' } } });
    expect(importAny(hoppscotch({ authType: 'jwt', authActive: true, algorithm: 'HS256', secret: 's', payload: '{}' })).collection!.items[0]).toMatchObject({ request: { auth: { type: 'jwt' } } });
  });
});

describe('supported schemes are unchanged', () => {
  it('Postman', () => {
    const r = importAny(postman('bearer', [{ key: 'token', value: '{{t}}' }]));
    expect(byName(r.collection!.items, 'Secured').request.auth).toEqual({ type: 'bearer', token: '{{t}}' });
    expect(byName(r.collection!.items, 'Secured').request.headers).toHaveLength(1);
    expect(importAny(postman('noauth', [])).collection!.items[0]).toMatchObject({ request: { auth: { type: 'none' } } });
    expect(r.notes ?? []).toEqual([]);
  });

  it('every tool through the one mapping layer', () => {
    expect(mapForeignAuth('postman', { type: 'basic', basic: { username: 'u', password: 'p' } }, 'x')).toEqual({ auth: { type: 'basic', username: 'u', password: 'p' }, notes: [], headers: [] });
    expect(mapForeignAuth('insomnia', { type: 'bearer', token: '{{ _.tok }}', prefix: 'Token' }, 'x').auth).toEqual({ type: 'bearer', token: '{{tok}}', prefix: 'Token' });
    expect(mapForeignAuth('insomnia', { type: 'iam', accessKeyId: 'a', secretAccessKey: 's', region: 'r', service: 'execute-api' }, 'x').auth).toMatchObject({ type: 'awsv4', service: 'execute-api' });
    expect(mapForeignAuth('insomnia', { type: 'hawk', disabled: true }, 'x')).toEqual({ auth: { type: 'none' }, notes: [], headers: [] });
    expect(mapForeignAuth('insomnia', {}, 'x')).toEqual({ notes: [], headers: [] });
    expect(mapForeignAuth('bruno', { mode: 'inherit' }, 'x').auth).toEqual({ type: 'inherit' });
    expect(mapForeignAuth('bruno', { mode: 'apikey', apikey: { key: 'k', value: 'v', placement: 'queryparams' } }, 'x').auth).toEqual({ type: 'apiKey', key: 'k', value: 'v', in: 'query' });
    expect(mapForeignAuth('hoppscotch', { authType: 'basic', authActive: false }, 'x').auth).toEqual({ type: 'none' });
    expect(mapForeignAuth('postman', undefined, 'x')).toEqual({ notes: [], headers: [] });
  });

  it('an OAuth 2 grant TestPion does not run is imported as authorization code, with a note', () => {
    const a = mapForeignAuth(
      'postman',
      {
        type: 'oauth2',
        oauth2: [
          { key: 'grant_type', value: 'implicit' },
          { key: 'accessTokenUrl', value: 'https://id.test/token' },
        ],
      },
      'Login',
    );
    expect(a.auth).toMatchObject({ type: 'oauth2', grantType: 'authorization_code' });
    expect(a.notes).toEqual([expect.stringContaining('"Login": Postman OAuth 2 grant "implicit"')]);
    expect(mapForeignAuth('insomnia', { type: 'oauth2', grantType: 'password', accessTokenUrl: 'u', clientId: 'c' }, 'x').notes).toEqual([]);
  });
});
