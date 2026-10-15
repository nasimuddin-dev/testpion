import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { createTestPionMcpServer, loadTestsFromFile, MemorySecretStore, saveTest, testFileOfInput, WorkspaceManager, WorkspaceStore } from '../../packages/core/src/index.js';
import { refNoun, refOfWorkspacePath, refOpenLabel } from '../../packages/shared/src/index.js';
import { cliData, runCli, tempDir } from '../helpers.js';

// WF-07: Save as test is one action, from everywhere: an editor's request, a saved request / folder / collection, a saved
// gRPC call or connection, a History entry, an MCP tool call, a prompt; the app, the MCP tool save_test and the CLI.
// (WF-04 too: the labels and refs of the toasts that say where a test went.)
const tmp = tempDir('tp-savetest-');
let root = '';
let store: WorkspaceStore;

beforeAll(() => {
  root = join(tmp.dir, 'ws');
  store = WorkspaceStore.create(root, 'Save tests');
  store.saveCollection({
    schemaVersion: '1.0',
    id: 'vet',
    name: 'Vet API',
    version: 0,
    updatedAt: '',
    variables: [],
    items: [
      {
        kind: 'folder',
        id: 'f-pat',
        name: 'Patients',
        items: [
          {
            kind: 'http',
            id: 'r-list',
            name: 'List patients',
            request: { method: 'GET', url: '{{baseUrl}}/patients', headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }] },
            assertions: [{ type: 'status', expected: 200 }],
          },
          {
            kind: 'http',
            id: 'r-add',
            name: 'Add patient',
            request: { method: 'POST', url: '{{baseUrl}}/patients', headers: [], body: { type: 'json', content: '{"name":"Rex"}' } },
            testScript: 'tp.test("ok", () => {})',
          },
        ],
      },
      { kind: 'graphql', id: 'g-me', name: 'Me', request: { endpoint: '{{gql}}', query: '{ me { id } }' } },
    ],
  } as never);
  store.saveLibrary('grpc', {
    folders: [],
    items: [{ id: 'grpc-1', name: 'Say hello', collectionId: 'vet', updatedAt: '', data: { target: 'localhost:50051', method: 'hello.Greeter/SayHello', message: '{"name":"x"}' } }],
  } as never);
  store.saveLibrary('websocket', {
    folders: [],
    items: [{ id: 'ws-1', name: 'Echo', collectionId: 'vet', updatedAt: '', data: { url: 'wss://echo.test', mode: 'websocket', message: 'ping' } }],
  } as never);
  store.saveMcpServers([{ id: 'srv-1', name: 'Pet MCP', transport: 'http', url: 'http://localhost:1/mcp' }] as never);
  store.meta.addHistory({
    id: 'h-saved',
    timestamp: new Date().toISOString(),
    kind: 'http',
    name: 'List patients',
    method: 'GET',
    url: 'http://real.test/patients',
    status: 200,
    request: { method: 'GET', url: 'http://real.test/patients' },
    collectionId: 'vet',
    requestId: 'r-list',
  });
  store.meta.addHistory({
    id: 'h-adhoc',
    timestamp: new Date().toISOString(),
    kind: 'graphql',
    name: 'Who',
    method: 'POST',
    url: 'http://g.test',
    status: 200,
    request: { endpoint: '{{gql}}', query: '{ who }', variables: '{"a":1}' },
  });
  store.meta.addHistory({ id: 'h-mcp', timestamp: new Date().toISOString(), kind: 'mcp', name: 'Pet MCP · getPet', status: 'ok', request: { serverId: 'srv-1', tool: 'getPet', args: { id: 1 } } });
  store.meta.addHistory({ id: 'h-llm', timestamp: new Date().toISOString(), kind: 'llm', name: 'demo', status: 'ok', request: { provider: 'demo', model: 'demo', prompt: 'Say hi', input: { a: 1 } } });
});
afterAll(() => {
  store.close();
  tmp.cleanup();
});

const read = (rel: string) => parse(readFileSync(join(root, 'tests', rel), 'utf8')) as Record<string, any>;
/** The tests a saved file loads as (the runner's own loader). */
const load = async (rel: string) => {
  const out = [];
  for await (const t of loadTestsFromFile(join(root, 'tests', rel))) out.push(t);
  return out;
};

describe('one Save as test for every kind of item', () => {
  it('a saved request keeps its {{variables}}, checks and scripts', async () => {
    const r = saveTest(store, { ref: { kind: 'request', collectionId: 'vet', requestId: 'r-list' } });
    expect(r).toMatchObject({ path: 'rest/list-patients.yaml', tests: 1, name: 'List patients' });
    expect(read(r.path)).toMatchObject({
      name: 'List patients',
      type: 'http',
      request: { method: 'GET', url: '{{baseUrl}}/patients', headers: { Authorization: 'Bearer {{token}}' } },
      assertions: [{ type: 'status', expected: 200 }],
    });
    expect((await load(r.path))[0]).toMatchObject({ type: 'http' });
    // a free name the second time
    expect(saveTest(store, { ref: { kind: 'request', collectionId: 'vet', requestId: 'r-list' } }).path).toBe('rest/list-patients-2.yaml');
  });

  it('a folder or a whole collection is one file with a test per request (the collection brings its gRPC calls and connections)', async () => {
    const f = saveTest(store, { ref: { kind: 'folder', collectionId: 'vet', folderId: 'f-pat' } });
    expect(f.tests).toBe(2);
    expect(read(f.path).tests.map((t: { name: string }) => t.name)).toEqual(['List patients', 'Add patient']);
    expect((await load(f.path)).map((t) => t.type)).toEqual(['http', 'http']);
    const c = saveTest(store, { ref: { kind: 'collection', collectionId: 'vet' }, name: 'Vet smoke' });
    expect(c.tests).toBe(5);
    expect((await load(c.path)).map((t) => t.type)).toEqual(['http', 'http', 'graphql', 'grpc', 'websocket']);
  });

  it('a saved gRPC call and a connection', async () => {
    const g = saveTest(store, { ref: { kind: 'saved', library: 'grpc', itemId: 'grpc-1' } });
    expect(read(g.path)).toMatchObject({ name: 'Say hello', type: 'grpc', method: 'hello.Greeter/SayHello', message: { name: 'x' } });
    const w = saveTest(store, { ref: { kind: 'saved', library: 'websocket', itemId: 'ws-1' } });
    expect(read(w.path)).toMatchObject({ name: 'Echo', type: 'websocket', url: 'wss://echo.test', send: ['ping'], assertions: [{ type: 'length', path: '$.received', min: 1 }] });
    expect((await load(w.path))[0]).toMatchObject({ type: 'websocket' });
  });

  it('a History entry: the saved request it came from when it is still there, else what was sent', () => {
    expect(read(saveTest(store, { ref: { kind: 'history', historyId: 'h-saved' } }).path).request.url).toBe('{{baseUrl}}/patients');
    expect(read(saveTest(store, { ref: { kind: 'history', historyId: 'h-adhoc' } }).path)).toMatchObject({ type: 'graphql', query: '{ who }', variables: { a: 1 } });
    expect(read(saveTest(store, { ref: { kind: 'history', historyId: 'h-mcp' } }).path)).toMatchObject({ type: 'mcp', server: 'Pet MCP', tool: 'getPet', arguments: { id: 1 } });
    expect(read(saveTest(store, { ref: { kind: 'history', historyId: 'h-llm' } }).path)).toMatchObject({ type: 'llm', prompt: 'Say hi', model: { provider: 'demo', name: 'demo' } });
  });

  it("an editor's MCP tool call (server by id, written by name) and a prompt", () => {
    expect(read(saveTest(store, { source: { kind: 'mcp', server: 'srv-1', tool: 'listPets', arguments: {} }, name: 'listPets works' }).path)).toMatchObject({
      type: 'mcp',
      server: 'Pet MCP',
      assertions: [{ type: 'status', expected: 'success' }],
    });
    const p = saveTest(store, {
      source: { kind: 'llm', model: { provider: 'demo' }, prompt: 'Hi {{name}}', input: { name: 'x' } },
      name: 'Greets',
      assertions: [{ type: 'contains', value: 'Hi' } as never],
    });
    expect(p.path).toBe('ai/greets.yaml');
    expect(read(p.path)).toMatchObject({ type: 'llm', prompt: 'Hi {{name}}', evaluators: [{ type: 'contains', value: 'Hi' }] });
  });

  it('says why when the item is gone or has nothing to save', () => {
    expect(() => testFileOfInput(store, { ref: { kind: 'request', collectionId: 'vet', requestId: 'gone' } })).toThrow(/no longer/);
    expect(() => testFileOfInput(store, { ref: { kind: 'history', historyId: 'gone' } })).toThrow(/no longer in the history/);
    expect(() => testFileOfInput(store, { ref: { kind: 'monitor', monitorId: 'm' } })).toThrow(/can't be saved as a test/);
  });
});

describe('the same action over RPC, MCP and the CLI', () => {
  it('tests.saveFrom takes a source or a ref and answers the test file ref', async () => {
    const be = new Backend({ appDir: join(tmp.dir, 'app'), emit: () => undefined, noMonitors: true });
    try {
      be.openStore(root);
      expect(await be.invoke('tests.saveFrom', { ref: { kind: 'folder', collectionId: 'vet', folderId: 'f-pat' }, name: 'Patients flow' })).toMatchObject({
        path: 'vet-api/patients-flow.yaml',
        tests: 2,
        ref: { kind: 'test', path: 'vet-api/patients-flow.yaml' },
      });
      expect(await be.invoke('tests.saveFrom', { source: { kind: 'grpc', target: 'x:1', method: 'a.B/C' }, name: 'C works' })).toMatchObject({ path: 'grpc/c-works.yaml' });
      await expect(be.invoke('tests.saveFrom', { name: 'x' })).rejects.toThrow(/source or ref/);
      // the MCP tool call kept under its old name goes the same way
      expect(await be.invoke('mcp.saveTest', { serverId: 'srv-1', tool: 'getPet', args: { id: 2 }, assertions: [], name: 'Get pet' })).toBe('mcp/get-pet.yaml');
    } finally {
      await be.dispose();
    }
  });

  it('save_test (MCP) takes a ref', async () => {
    const s = WorkspaceStore.open(root);
    const srv = createTestPionMcpServer({ store: s, secrets: new MemorySecretStore(), settings: new WorkspaceManager(join(tmp.dir, 'home')).loadSettings() });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await srv.connect(a);
    await client.connect(b);
    try {
      const r = (await client.callTool({ name: 'save_test', arguments: { ref: { kind: 'saved', library: 'grpc', itemId: 'grpc-1' }, name: 'Hello over MCP' } })) as {
        structuredContent: Record<string, unknown>;
      };
      expect(r.structuredContent).toMatchObject({ path: 'tests/grpc/hello-over-mcp.yaml', tests: 1, ref: { kind: 'test', path: 'grpc/hello-over-mcp.yaml' } });
      const old = (await client.callTool({ name: 'save_test', arguments: { collection: 'Vet API', request: 'Me' } })) as { structuredContent: Record<string, unknown> };
      expect(old.structuredContent).toMatchObject({ path: 'tests/graphql/me.yaml' });
    } finally {
      await client.close();
      s.close();
    }
  });

  it('testpion test from-request (a path of names, or a ref) --json', async () => {
    const home = join(tmp.dir, 'cli-home');
    const one = await runCli(['test', 'from-request', 'Vet API/Patients/Add patient', '-w', root, '--json'], { home });
    expect(one.status).toBe(0);
    expect(cliData(one.out)).toMatchObject({ path: 'tests/rest/add-patient.yaml', tests: 1, ref: { kind: 'test' } });
    const folder = await runCli(['test', 'from-request', 'Vet API/Patients', '-w', root, '--json', '-n', 'From CLI'], { home });
    expect(cliData(folder.out)).toMatchObject({ tests: 2 });
    const byRef = await runCli(['test', 'from-request', 'saved:websocket:ws-1', '-w', root, '--json'], { home });
    expect(cliData(byRef.out)).toMatchObject({ path: expect.stringMatching(/^tests\/websocket\/echo(-\d+)?\.yaml$/) });
    const missing = await runCli(['test', 'from-request', 'Vet API/Nope', '-w', root], { home });
    expect(missing.status).toBe(2);
  }, 60_000);
});

describe('labels and refs (WF-04, WF-13)', () => {
  it('one "Open …" label per kind, acronyms kept', () => {
    expect(refOpenLabel({ kind: 'run' })).toBe('Open run');
    expect(refOpenLabel({ kind: 'test' })).toBe('Open test file');
    expect(refOpenLabel({ kind: 'mcp-server' })).toBe('Open MCP server');
    expect(refOpenLabel({ kind: 'spec' })).toBe('Open API definition');
    expect(refNoun({ kind: 'saved', library: 'grpc' })).toBe('gRPC call');
  });

  it('a workspace path names its item', () => {
    expect(refOfWorkspacePath('tests/rest/a.yaml')).toEqual({ kind: 'test', path: 'rest/a.yaml' });
    expect(refOfWorkspacePath('tests\\rest\\a.yaml')).toEqual({ kind: 'test', path: 'rest/a.yaml' });
    expect(refOfWorkspacePath('datasets/users.csv')).toEqual({ kind: 'dataset', name: 'users.csv' });
    expect(refOfWorkspacePath('specs/pets.yaml')).toEqual({ kind: 'spec', path: 'specs/pets.yaml' });
    expect(refOfWorkspacePath('collections/x.json')).toBeUndefined();
    expect(refOfWorkspacePath('tests/readme.md')).toBeUndefined();
  });
});
