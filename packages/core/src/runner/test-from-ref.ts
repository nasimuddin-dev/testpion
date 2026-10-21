import { existsSync } from 'node:fs';
import type { ItemRef } from '@testpion/shared';
import type { CheckConfig, Collection, CollectionNode, LibraryItem, SavedGraphQLRequest, SavedHttpRequest, TestCase } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { ApsError } from '../errors.js';
import { slugify } from '../util/ids.js';
import { stringifyYaml as stringify } from '../util/lazy-yaml.js';
import { savedConnectionToTest, savedGrpcCallToTest, type SavedConnection, type SavedGrpcCall } from './collection-realtime.js';
import { testObjectFromRequest, type TestSource } from './test-from.js';

/**
 * WF-07 "Save as test", the one way: whatever names a request (a request in an editor, a saved request, folder or whole
 * collection, a saved gRPC call or connection, a History entry, an MCP tool call, a prompt) becomes a YAML test file
 * under tests/, through `saveTest`. The window's Save as test (every editor's ⋯, the Collections menu, History, the
 * Debugger), the MCP tool `save_test` and `testpion test from-request` all end here. {{variables}} stay as they are.
 */

/** What to save: a request as an editor holds it (`source`), or an item by its ref (read from the workspace). */
type SaveTestInput = { name?: string; source: TestSource; assertions?: CheckConfig[] } | { name?: string; ref: ItemRef };

/** A test as written in a file: what the loader fills in (ids, locations) left out. */
type TestObject = Record<string, unknown>;

const HEADER = '# Saved from TestPion. Run it with: testpion test <this file>\n';

const findNode = (nodes: CollectionNode[], id: string): CollectionNode | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.kind === 'folder') {
      const f = findNode(n.items, id);
      if (f) return f;
    }
  }
  return undefined;
};

/** A saved HTTP / SOAP / GraphQL request as a test (its own scripts and checks; auth inherited from folders stays inherited). */
function requestTest(node: SavedHttpRequest | SavedGraphQLRequest, name = node.name): { test: TestObject; folder: string } {
  return node.kind === 'graphql'
    ? testObjectFromRequest(
        name,
        {
          kind: 'graphql',
          endpoint: node.request.endpoint,
          query: node.request.query,
          variables: node.request.variables as Record<string, unknown> | undefined,
          operationName: node.request.operationName,
          headers: node.request.headers,
          auth: node.request.auth,
        },
        node.assertions,
      )
    : testObjectFromRequest(name, { kind: 'http', request: node.request, preRequestScript: node.preRequestScript, testScript: node.testScript }, node.assertions);
}

/** A runnable test (the realtime ones) as it is written in a file. */
function asWritten(t: TestCase): TestObject {
  const { id: _id, location: _location, file: _file, ...rest } = t as TestCase & { location?: unknown; file?: unknown };
  return JSON.parse(JSON.stringify(rest)) as TestObject;
}

/** Every request under a folder (or the whole collection), in order: one test each. */
function requestsUnder(nodes: CollectionNode[], out: Array<SavedHttpRequest | SavedGraphQLRequest> = []) {
  for (const n of nodes) {
    if (n.kind === 'folder') requestsUnder(n.items, out);
    else if (n.kind === 'http' || n.kind === 'graphql') out.push(n);
  }
  return out;
}

function libraryItem<T>(store: WorkspaceStore, library: string, id: string): LibraryItem<T> {
  const item = store.getLibrary<T>(library).items.find((i) => i.id === id);
  if (!item) throw new ApsError('ConfigurationError', `It is no longer in the workspace (${library} ${id})`, { suggestions: [] });
  return item;
}

const collectionName = (store: WorkspaceStore, id: string | undefined) => {
  try {
    return id ? store.getCollection(id).name : '';
  } catch {
    return '';
  }
};

/** The test file an item becomes: one test, or (a folder, a collection) one file with a test per request. */
export function testFileOfInput(store: WorkspaceStore, input: SaveTestInput): { path: string; yaml: string; tests: number; name: string } {
  const one = (t: { test: TestObject; folder: string }, name: string) => ({ path: `${t.folder}/${slugify(name) || 'test'}.yaml`, yaml: HEADER + stringify(t.test, { lineWidth: 0 }), tests: 1, name });
  if ('source' in input) {
    const name = input.name?.trim() || 'Saved test';
    // an MCP server named by its id is written by its name (the test reads either)
    const source = input.source.kind === 'mcp' ? { ...input.source, server: mcpServerName(store, input.source.server) } : input.source;
    return one(testObjectFromRequest(name, source, input.assertions), name);
  }
  const ref = input.ref;
  switch (ref.kind) {
    case 'request': {
      const c = store.getCollection(ref.collectionId);
      const node = findNode(c.items, ref.requestId);
      if (!node || node.kind === 'folder') throw new ApsError('ConfigurationError', `That request is no longer in "${c.name}"`, { suggestions: [] });
      const name = input.name?.trim() || node.name;
      return one(requestTest(node as SavedHttpRequest | SavedGraphQLRequest, name), name);
    }
    case 'folder':
    case 'collection': {
      const c: Collection = store.getCollection(ref.collectionId);
      const folder = ref.kind === 'folder' ? findNode(c.items, ref.folderId) : undefined;
      if (ref.kind === 'folder' && folder?.kind !== 'folder') throw new ApsError('ConfigurationError', `That folder is no longer in "${c.name}"`, { suggestions: [] });
      const nodes = requestsUnder(folder?.kind === 'folder' ? folder.items : c.items);
      // a whole collection brings its gRPC calls and connections too (a folder's are kept by folder name, not id)
      const realtime =
        ref.kind === 'collection'
          ? [
              ...store
                .getLibrary<SavedGrpcCall>('grpc')
                .items.filter((i) => i.collectionId === c.id)
                .map((i) => savedGrpcCallToTest(i, c.name)),
              ...store
                .getLibrary<SavedConnection>('websocket')
                .items.filter((i) => i.collectionId === c.id)
                .map((i) => savedConnectionToTest(i, c.name)),
            ]
          : [];
      if (!nodes.length && !realtime.length) throw new ApsError('ValidationError', `"${folder?.name ?? c.name}" has no requests to save as tests`, { suggestions: [] });
      const name = input.name?.trim() || (folder ? folder.name : c.name);
      const tests = [...nodes.map((n) => requestTest(n).test), ...realtime.map(asWritten)];
      // in a folder named after the collection: tests/<collection>/<name>.yaml
      return { path: `${slugify(c.name)}/${slugify(name)}.yaml`, yaml: HEADER + stringify({ name, tests }, { lineWidth: 0 }), tests: tests.length, name };
    }
    case 'saved': {
      if (ref.library === 'grpc') {
        const item = libraryItem<SavedGrpcCall>(store, 'grpc', ref.itemId);
        const name = input.name?.trim() || item.name;
        return one({ test: { ...asWritten(savedGrpcCallToTest(item, collectionName(store, item.collectionId))), name }, folder: 'grpc' }, name);
      }
      if (ref.library === 'websocket') {
        const item = libraryItem<SavedConnection>(store, 'websocket', ref.itemId);
        const name = input.name?.trim() || item.name;
        const t = asWritten(savedConnectionToTest(item, collectionName(store, item.collectionId)));
        // a connection's test checks that something came back (a run of the collection only checks it connects)
        return one({ test: { ...t, name, assertions: (t.assertions as unknown[])?.length ? t.assertions : [{ type: 'length', path: '$.received', min: 1 }] }, folder: 'websocket' }, name);
      }
      throw new ApsError('ValidationError', `A saved ${ref.library} item can't be saved as a test`, { suggestions: [] });
    }
    case 'history': {
      const e = store.meta.getHistory(ref.historyId);
      if (!e) throw new ApsError('ConfigurationError', 'That entry is no longer in the history', { suggestions: [] });
      // sent from a saved request that is still there: the saved one ({{variables}}, not the values sent)
      if (e.collectionId && e.requestId)
        try {
          return testFileOfInput(store, { name: input.name, ref: { kind: 'request', collectionId: e.collectionId, requestId: e.requestId } });
        } catch {
          /* gone since: what was sent */
        }
      const r = (e.request ?? {}) as Record<string, any>;
      const name = input.name?.trim() || e.name;
      const source: TestSource | undefined =
        e.kind === 'http' && r.url
          ? { kind: 'http', request: r as never, status: typeof e.status === 'number' ? e.status : undefined }
          : e.kind === 'graphql' && r.query
            ? {
                kind: 'graphql',
                endpoint: r.endpoint,
                query: r.query,
                variables: typeof r.variables === 'string' ? safeJson(r.variables) : r.variables,
                operationName: r.operationName,
                headers: r.headers,
                auth: r.auth,
              }
            : e.kind === 'grpc' && r.method
              ? { kind: 'grpc', target: r.target, method: r.method, message: safeJson(r.message) ?? r.message, metadata: r.metadata }
              : e.kind === 'mcp' && r.tool
                ? { kind: 'mcp', server: mcpServerName(store, r.serverId), tool: r.tool, arguments: r.args ?? {} }
                : e.kind === 'llm' && r.prompt
                  ? { kind: 'llm', model: { provider: r.provider, name: r.model || undefined }, system: r.system, prompt: r.prompt, input: r.input }
                  : undefined;
      if (!source) throw new ApsError('ValidationError', `This ${e.kind} entry has no request kept to save as a test`, { suggestions: [] });
      return one(testObjectFromRequest(name, source), name);
    }
    default:
      throw new ApsError('ValidationError', `A ${ref.kind} can't be saved as a test`, { suggestions: [] });
  }
}

function safeJson(text: unknown): unknown {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function mcpServerName(store: WorkspaceStore, id: unknown): string {
  const s = store.getMcpServers().find((x) => x.id === id || x.name === id);
  return s?.name ?? String(id ?? '');
}

/**
 * Save an item (or an editor's request) as a test file under tests/, under a free name (`-2`, `-3` … when taken).
 * Returns its path under tests/ and how many tests it holds.
 */
export function saveTest(store: WorkspaceStore, input: SaveTestInput): { path: string; tests: number; name: string } {
  const f = testFileOfInput(store, input);
  let path = f.path;
  for (let i = 2; existsSync(store.safePath(path, store.path('tests'))); i++) path = f.path.replace(/\.yaml$/, `-${i}.yaml`);
  store.writeTestFile(path, f.yaml);
  return { path, tests: f.tests, name: f.name };
}
