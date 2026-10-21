import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, importDocument, importIntoWorkspace, planImport, type CollectionNode, type SavedHttpRequest } from '../../packages/core/src/index.js';

// Import compatibility leftovers: Yaak plugins, encrypted fields (HTTPie, Apidog), Postman v3 $ref, script lines in the update preview.

const dirs: string[] = [];
const open: WorkspaceStore[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});
const workspace = () => {
  const d = mkdtempSync(join(tmpdir(), 'tp-impleft-'));
  dirs.push(d);
  const s = WorkspaceStore.create(d, 'Leftovers');
  open.push(s);
  return s;
};
const flat = (nodes: CollectionNode[]): CollectionNode[] => nodes.flatMap((n) => (n.kind === 'folder' ? [n, ...flat(n.items)] : [n]));
const messages = (text: string) => importDocument(text).document.findings.map((f) => f.message);

describe('Yaak: plugin auth and template functions', () => {
  const yaak = (req: Record<string, unknown>) =>
    JSON.stringify({
      yaakVersion: '2025.1.0',
      yaakSchema: 4,
      resources: { workspaces: [{ id: 'w1', name: 'W' }], folders: [], environments: [], httpRequests: [{ id: 'r1', workspaceId: 'w1', name: 'Call', method: 'GET', url: 'https://a.test', ...req }] },
    });

  it('an auth type from a Yaak plugin says it is a plugin’s, and is never inherited', () => {
    const m = messages(yaak({ authenticationType: 'auth-acme-sso', authentication: { token: 'x' } }));
    expect(m.join('\n')).toMatch(/auth "acme-sso" \(an auth type from a Yaak plugin: TestPion does not run Yaak plugins\) is not supported/);
    const doc = importDocument(yaak({ authenticationType: 'auth-acme-sso', authentication: {} })).document;
    const req = flat(doc.collections[0]!.items)[0] as SavedHttpRequest;
    expect(req.request.auth).toEqual({ type: 'none' });
  });

  it('Akamai EdgeGrid is read under the name Yaak’s plugin gives it', () => {
    const doc = importDocument(yaak({ authenticationType: 'auth-akamai-edgegrid', authentication: { clientToken: 'ct', clientSecret: 'cs', accessToken: 'at' } })).document;
    expect((flat(doc.collections[0]!.items)[0] as SavedHttpRequest).request.auth).toMatchObject({ type: 'edgegrid' });
  });

  it('random.range(a, b) becomes a random whole number; Yaak’s own functions and plugin functions get two plain findings', () => {
    const doc = importDocument(yaak({ url: 'https://a.test/${[ random.range(1, 9) ]}', headers: [{ name: 'X-Hash', value: '${[ hash.sha256(input="a") ]}' }, { name: 'X-Plug', value: '${[ acme.token() ]}' }] })).document;
    const req = flat(doc.collections[0]!.items)[0] as SavedHttpRequest;
    expect(req.request.url).toBe('https://a.test/{{$randomInt(1,9)}}');
    const m = doc.findings.map((f) => f.message).join('\n');
    expect(m).toMatch(/1 Yaak function has no TestPion dynamic variable \(\$\{\[ hash\.sha256\(input="a"\) \]\}\) and stay as text: compute the value in a pre-request script/);
    expect(m).toMatch(/1 template function comes from a Yaak plugin \(\$\{\[ acme\.token\(\) \]\}\) and stay as text: TestPion does not run Yaak plugins/);
  });
});

describe('encrypted fields in HTTPie and Apidog exports', () => {
  const salted = 'U2FsdGVkX1+abcdefghijklmnopqrstuv==';
  it('HTTPie: an encrypted password and an encrypted variable are left empty and named', () => {
    const coll = JSON.stringify({
      meta: { format: 'httpie', version: '4.0.0', contentType: 'collection' },
      entry: { name: 'C', requests: [{ name: 'R', method: 'GET', url: 'https://a.test', auth: { type: 'basic', credentials: { username: 'ann', password: { iv: 'aGVsbG8=', data: 'c2VjcmV0' } } } }], collections: [] },
    });
    const r = importDocument(coll).document;
    const req = flat(r.collections[0]!.items)[0] as SavedHttpRequest;
    expect(req.request.auth).toEqual({ type: 'basic', username: 'ann', password: '' });
    expect(r.findings.map((f) => f.message).join('\n')).toMatch(/"R": 1 credential field \(credentials\.password\) is encrypted in the HTTPie export and TestPion has no key for it: it was left empty, enter it again/);
    const env = JSON.stringify({ meta: { format: 'httpie', version: '4.0.0', contentType: 'environment' }, entry: { name: 'Prod', variables: [{ name: 'API_KEY', value: salted }, { name: 'HOST', value: 'a.test' }] } });
    const e = importDocument(env).document;
    expect(e.environments[0]!.variables).toEqual([
      { key: 'API_KEY', value: '', enabled: true },
      { key: 'HOST', value: 'a.test', enabled: true },
    ]);
    expect(e.findings.map((f) => f.message).join('\n')).toMatch(/1 value is encrypted in the HTTPie export \(API_KEY\)/);
  });

  it('Apidog: an encrypted environment value and an encrypted auth field are left empty and named', () => {
    const d = JSON.stringify({
      apidogProject: '1.0.0',
      apiCollection: [{ name: 'Orders', items: [{ name: 'List', api: { method: 'get', path: '/orders', auth: { type: 'bearer', bearer: [{ key: 'token', value: salted, type: 'string' }] } } }] }],
      environments: [{ name: 'Prod', variables: [{ name: 'SECRET', value: 'ENC[AES256,abc]' }, { name: 'REGION', value: 'eu' }] }],
    });
    const doc = importDocument(d).document;
    expect(doc.environments[0]!.variables.map((v) => `${v.key}=${v.value}`)).toEqual(['SECRET=', 'REGION=eu']);
    const m = doc.findings.map((f) => f.message).join('\n');
    expect(m).toMatch(/1 value is encrypted in the Apidog export \(SECRET\)/);
  });
});

describe('Postman v3 $ref', () => {
  const v3 = (files: Array<{ path: string; text: string }>) => JSON.stringify({ postmanV3: 1, name: 'Shared', files });
  const request = (extra = '') => `$kind: http-request\nname: List\nmethod: GET\nurl: https://a.test/list\n${extra}`;

  it('a reference to a file inside the folder is followed, from any depth; the shared folder is not a folder of the collection', () => {
    const files = [
      { path: 'definition.yaml', text: '$kind: collection\nname: Shared\n' },
      { path: 'shared/auth.yaml', text: 'type: bearer\ncredentials:\n  - key: token\n    value: "{{token}}"\n' },
      { path: 'orders/list.request.yaml', text: request('auth:\n  $ref: ../shared/auth.yaml\n') },
    ];
    const doc = importDocument(v3(files)).document;
    const req = flat(doc.collections[0]!.items).find((n) => n.name === 'List') as SavedHttpRequest;
    expect(req.request.auth).toMatchObject({ type: 'bearer', token: '{{token}}' });
    expect(flat(doc.collections[0]!.items).map((n) => n.name).sort()).toEqual(['List', 'orders']);
  });

  it('a reference with a #pointer takes that part of the file', () => {
    const files = [
      { path: 'defs.yaml', text: 'auths:\n  main:\n    type: bearer\n    credentials:\n      - key: token\n        value: abc\n' },
      { path: 'list.request.yaml', text: request('auth:\n  $ref: defs.yaml#/auths/main\n') },
    ];
    const req = flat(importDocument(v3(files)).document.collections[0]!.items)[0] as SavedHttpRequest;
    expect(req.request.auth).toMatchObject({ type: 'bearer', token: 'abc' });
  });

  it('a reference outside the folder, a missing file and a loop are named and left out; the rest imports', () => {
    const files = [
      { path: 'a.request.yaml', text: request('auth:\n  $ref: ../../elsewhere/auth.yaml\n') },
      { path: 'b.request.yaml', text: request('headers:\n  $ref: nothing.yaml\n').replace('name: List', 'name: B') },
      { path: 'c.request.yaml', text: request('body:\n  $ref: loop.yaml\n').replace('name: List', 'name: C') },
      { path: 'loop.yaml', text: 'inner:\n  $ref: loop.yaml\n' },
    ];
    const r = importDocument(v3(files)).document;
    expect(flat(r.collections[0]!.items).map((n) => n.name).sort()).toEqual(['B', 'C', 'List']);
    const m = r.findings.map((f) => f.message).join('\n');
    expect(m).toMatch(/a\.request\.yaml refers to \.\.\/\.\.\/elsewhere\/auth\.yaml, a file outside the collection folder: it was not imported/);
    expect(m).toMatch(/b\.request\.yaml refers to nothing\.yaml, which is not in the folder/);
    expect(m).toMatch(/loop\.yaml refers to loop\.yaml, which refers back to it/);
  });
});

describe('the update preview shows the script lines that differ', () => {
  const doc = (test: string, pre = '') =>
    JSON.stringify({
      info: { name: 'Orders', _postman_id: 'col-9', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [
        {
          id: 'i-list',
          name: 'List',
          request: { method: 'GET', url: 'https://a.test/orders' },
          event: [
            ...(pre ? [{ listen: 'prerequest', script: { exec: pre.split('\n') } }] : []),
            { listen: 'test', script: { exec: test.split('\n') } },
          ],
        },
      ],
    });

  it('lists the changed lines of each script, before the choice is made', () => {
    const store = workspace();
    importIntoWorkspace(store, doc('pm.test("ok", () => {\n  pm.response.to.have.status(200);\n});', 'pm.variables.set("a", 1);'));
    const next = doc('pm.test("ok", () => {\n  pm.response.to.have.status(201);\n});\npm.test("fast", () => {});', 'pm.variables.set("a", 2);');
    const plan = planImport(store, next);
    const item = plan.reimport![0]!.items.find((i) => i.path.join('/') === 'List')!;
    expect(item.action).toBe('replace');
    const fields = Object.fromEntries((item.scripts ?? []).map((s) => [s.field, s.diff]));
    expect(Object.keys(fields).sort()).toEqual(['preRequestScript', 'testScript']);
    expect(fields.testScript).toMatch(/^--- a\/List test script$/m);
    expect(fields.testScript).toMatch(/^-\s+tp\.response\.to\.have\.status\(200\);$|^-.*200/m);
    expect(fields.testScript).toMatch(/^\+.*201/m);
    expect(fields.testScript).toMatch(/^\+.*fast/m);
    expect(fields.preRequestScript).toMatch(/^-.*"a", 1/m);
    expect(fields.preRequestScript).toMatch(/^\+.*"a", 2/m);
  });

  it('an item whose scripts did not change has none, and an unchanged source has nothing to show', () => {
    const store = workspace();
    importIntoWorkspace(store, doc('pm.test("ok", () => {});'));
    const same = planImport(store, doc('pm.test("ok", () => {});'));
    expect(same.reimport![0]!.items.every((i) => !i.scripts)).toBe(true);
    // a change that is not in a script (the URL) shows no script lines
    const changed = JSON.parse(doc('pm.test("ok", () => {});'));
    changed.item[0].request.url = 'https://a.test/v2/orders';
    const plan = planImport(store, JSON.stringify(changed));
    const item = plan.reimport![0]!.items.find((i) => i.path.join('/') === 'List')!;
    expect(item.action).toBe('replace');
    expect(item.scripts).toBeUndefined();
  });
});
