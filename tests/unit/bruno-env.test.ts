import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemorySecretStore,
  WorkspaceStore,
  bruFilesToBrunoExport,
  collectionToBru,
  importIntoWorkspace,
  readBrunoFolder,
  runScript,
  secretKeys,
  type CollectionNode,
  type SavedHttpRequest,
} from '../../packages/core/src/index.js';
import { importAny } from '../helpers-import.js';
import { brunoToTp, tpToBruno } from '../../packages/core/src/scripts/bruno.js';

// IMP-FIX-3: Bruno scripts come over as tp.* (bru.* rewritten where TestPion has it, a TODO where it doesn't) with a
// scripts summary; the collection's .env is read (only `.env`, not .env.example): its values go to the secret store and
// {{process.env.X}} becomes {{X}} in a "Bruno .env" environment; names without a value are "values needed".
// The folder is written at test time (a committed .env would look like a leaked secret to scanners).

const FILES: Record<string, string> = {
  'bruno.json': JSON.stringify({ version: '1', name: 'Env clinic', type: 'collection' }),
  '.env': 'API_KEY=demo-key-123\n# a comment\nAPI_SECRET="demo secret"\n',
  '.env.example': 'API_KEY=example-only-value\nEXAMPLE_ONLY=1\n',
  'collection.bru': 'script:pre-request {\n  bru.setVar("startedAt", Date.now());\n}\n',
  'environments/Local.bru': 'vars {\n  baseUrl: http://localhost:3000\n}\nvars:secret [\n  password\n]\n',
  'Log in.bru': `meta {
  name: Log in
  type: http
  seq: 1
}

post {
  url: {{baseUrl}}/login
  body: json
  auth: none
}

headers {
  X-Api-Key: {{process.env.API_KEY}}
  X-Token: {{process.env.MISSING_TOKEN}}
}

vars:pre-request {
  clinic: north
}

vars:post-response {
  token: res.body.token
}

script:pre-request {
  const secret = bru.getProcessEnv('API_SECRET');
  req.setHeader('X-Secret', secret);
  // bru.getVar in a comment stays
  const label = "bru.setEnvVar in a string stays";
}

script:post-response {
  bru.setEnvVar("token", res.body.token);
  if (bru.getEnvVar("token")) bru.runner.setNextRequest("Get patient");
  bru.sendRequest({ url: 'https://x.test' });
}

tests {
  test("logged in", function () {
    expect(res.getStatus()).to.equal(200);
    expect(bru.getVar("clinic")).to.equal("north");
  });
}
`,
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tp-bruno-env-'));
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

const flat = (nodes: CollectionNode[]): CollectionNode[] => nodes.flatMap((n) => (n.kind === 'folder' ? [n, ...flat(n.items)] : [n]));
const login = (items: CollectionNode[]) => flat(items).find((n) => n.name === 'Log in') as SavedHttpRequest;

describe('Bruno .env', () => {
  it('readBrunoFolder reads exactly the root .env (never .env.example)', () => {
    const text = readBrunoFolder(dir);
    expect(JSON.parse(text).dotenv).toBe(FILES['.env']);
    expect(text).not.toContain('example-only-value');
    expect(text).not.toContain('EXAMPLE_ONLY');
    // the app's folder picker sends the same files (path relative to the folder)
    expect(
      bruFilesToBrunoExport([
        { path: '.env', text: 'A=1' },
        { path: 'bruno.json', text: '{"name":"X"}' },
      ]).dotenv,
    ).toBe('A=1');
  });

  it('{{process.env.X}} becomes {{X}}; values are secret variables of "Bruno .env" and each environment, values needed are listed', () => {
    const r = importAny(readBrunoFolder(dir));
    expect(login(r.collection!.items).request.headers).toEqual(
      expect.arrayContaining([
        { key: 'X-Api-Key', value: '{{API_KEY}}', enabled: true },
        { key: 'X-Token', value: '{{MISSING_TOKEN}}', enabled: true },
      ]),
    );
    const env = r.environments!.find((e) => e.name === 'Bruno .env')!;
    expect(env.variables).toEqual([
      { key: 'API_KEY', value: '', secret: true, enabled: true },
      { key: 'API_SECRET', value: '', secret: true, enabled: true },
      { key: 'MISSING_TOKEN', value: '', secret: true, enabled: true },
    ]);
    const local = r.environments!.find((e) => e.name === 'Local')!;
    expect(local.variables.map((v) => v.key)).toEqual(['baseUrl', 'password', 'API_KEY', 'API_SECRET', 'MISSING_TOKEN']);
    expect(r.secretValues).toEqual({ 'bruno-env': { API_KEY: 'demo-key-123', API_SECRET: 'demo secret' }, local: { API_KEY: 'demo-key-123', API_SECRET: 'demo secret' } });
    // the values are in no environment or collection
    expect(JSON.stringify([r.collection, r.environments])).not.toMatch(/demo-key-123|demo secret/);
    expect(r.notes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\.env: 2 values \(API_KEY, API_SECRET\) became secret variables/),
        'Values needed: MISSING_TOKEN (used as process.env but not set in the .env file) in the "Bruno .env" environment',
        'Values needed: password in the "Local" environment (Bruno keeps secret values in the app, not in the export)',
      ]),
    );
  });

  it('a workspace import stores the .env values in the secret store, never in workspace files', () => {
    const ws = mkdtempSync(join(tmpdir(), 'tp-bruno-ws-'));
    try {
      const store = WorkspaceStore.create(ws, 'Bruno env');
      const secrets = new MemorySecretStore();
      const r = importIntoWorkspace(store, readBrunoFolder(dir), { secrets });
      const envId = r.environments!.find((e) => e.name === 'Bruno .env')!.id;
      expect(secrets.get(secretKeys.envVar(envId, 'API_KEY'))).toBe('demo-key-123');
      expect(r.notes!.some((n) => n.startsWith('Values needed: MISSING_TOKEN'))).toBe(true);
      store.close();
      const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
      for (const f of walk(ws)) expect(readFileSync(f, 'utf8')).not.toMatch(/demo-key-123|demo secret/);
    } finally {
      rmSync(ws, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('without a .env, the process.env names are values needed', () => {
    const r = importAny(
      JSON.stringify({ name: 'No env', version: '1', items: [{ type: 'http-request', name: 'A', seq: 1, request: { url: '{{process.env.HOST}}/a', method: 'GET', headers: [], params: [] } }] }),
    );
    expect((r.collection!.items[0] as SavedHttpRequest).request.url).toBe('{{HOST}}/a');
    expect(r.environments!.map((e) => e.name)).toEqual(['Bruno .env']);
    expect(r.secretValues).toBeUndefined();
    expect(r.notes).toEqual([expect.stringMatching(/^Values needed: HOST \(used as process.env; import the collection folder with its \.env file/)]);
  });
});

describe('Bruno scripts as tp.*', () => {
  it('no pm. anywhere; bru.* rewritten; strings and comments untouched; a scripts summary', () => {
    const r = importAny(readBrunoFolder(dir));
    expect(JSON.stringify(r.collection)).not.toMatch(/\bpm\./);
    const req = login(r.collection!.items);
    expect(req.preRequestScript).toContain('tp.variables.set("clinic", "north");');
    expect(req.preRequestScript).toContain("const secret = tp.variables.get('API_SECRET');");
    expect(req.preRequestScript).toContain('// bru.getVar in a comment stays');
    expect(req.preRequestScript).toContain('"bru.setEnvVar in a string stays"');
    expect(req.testScript).toContain('tp.collectionVariables.set("token", tp.response.json().token);');
    expect(req.testScript).toContain('tp.environment.set("token", tp.response.json().token);');
    expect(req.testScript).toContain('if (tp.environment.get("token")) tp.execution.setNextRequest("Get patient");');
    expect(req.testScript).toContain('expect(tp.variables.get("clinic")).to.equal("north");');
    // bru.sendRequest has an equivalent now: an adapter over tp.sendRequest
    expect(req.testScript).toContain('tp.sendRequest({ url: cfg.url');
    expect(req.testScript).not.toContain('bru.sendRequest');
    expect(r.collection!.preRequestScript).toContain('tp.collectionVariables.set("startedAt", Date.now());');
    expect(r.scripts!.converted).toBe(3);
    expect(r.scripts!.warnings).toBeUndefined();
  });

  it('the converted script still runs (req / res / test through the shim)', async () => {
    const r = importAny(readBrunoFolder(dir));
    const req = login(r.collection!.items);
    const out = await runScript(req.testScript!.replace(/^.*tp\.sendRequest.*$/m, ''), {
      variables: { clinic: 'north' },
      request: { method: 'POST', url: 'http://localhost:3000/login', headers: [] },
      response: { status: 200, headers: [['content-type', 'application/json']], body: '{"token":"t-1"}', time: 3 },
    });
    expect(out.error).toBeUndefined();
    expect(out.tests).toEqual([expect.objectContaining({ name: 'logged in', passed: true })]);
    expect(out.scopeSets.environment).toEqual({ token: 't-1' });
    expect(out.nextRequest).toBe('Get patient');
  });

  it('a Bruno export gives the scripts back as bru.* (tp.* only where Bruno has nothing)', () => {
    const r = importAny(readBrunoFolder(dir));
    const files = collectionToBru(r.collection!, r.environments ?? []);
    const text = files.find((f) => f.path === 'Log in.bru')!.text;
    expect(text).toContain('bru.setVar("clinic", "north");');
    expect(text).toContain('bru.setEnvVar("token", res.body.token);');
    expect(text).toContain('expect(bru.getVar("clinic")).to.equal("north");');
    expect(text).toContain('if (bru.getEnvVar("token")) bru.runner.setNextRequest("Get patient");');
    expect(text).toContain('"bru.setEnvVar in a string stays"');
    // (an adapter such as tp.sendRequest has no Bruno form back, and a call whose arguments hold strings is not rewritten)
    expect(text.replace(/tp\.sendRequest|tp\.request\.headers\.upsert/g, '')).not.toMatch(/\btp\./);
    expect(tpToBruno('tp.execution.setNextRequest(null); tp.environment.name; x = "tp.environment.get(1)"')).toBe('bru.runner.stopExecution(); bru.getEnvName(); x = "tp.environment.get(1)"');
  });

  it('brunoToTp maps the whole bru API table and is idempotent', () => {
    const src =
      'bru.getEnvName(); bru.hasVar("a"); bru.deleteVar("a"); bru.getCollectionVar("c"); bru.interpolate("{{x}}"); bru.getRequestName(); bru.runner.skipRequest(); bru.runner.stopExecution(); bru.sleep(5); bru.cookies.jar();';
    const once = brunoToTp(src);
    expect(once.code.split('\n').at(-1)).toBe(
      'tp.environment.name; tp.variables.has("a"); tp.collectionVariables.unset("a"); tp.collectionVariables.get("c"); tp.variables.replaceIn("{{x}}"); tp.info.requestName; tp.execution.skipRequest(); tp.execution.setNextRequest(null); bru.sleep(5); tp.cookies.jar();',
    );
    expect(once.warnings).toEqual([]);
    expect(brunoToTp(once.code).code).toBe(once.code);
  });
});
