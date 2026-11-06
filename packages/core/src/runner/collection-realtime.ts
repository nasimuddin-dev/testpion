import { interleave, liveKinds } from '@testpion/shared';
import type { AuthConfig, Collection, CollectionNode, GrpcTest, KeyValue, LibraryItem, TestCase, WebSocketTest } from '../model/types.js';
import { headerAuth } from '../protocols/http/auth.js';
import { folderVariables, inheritedHeaders, joinScripts, withInheritedHeaders } from './folder-defaults.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { folderByPath, textFolderPath } from '../storage/collection-calls.js';

/**
 * gRPC calls and WebSocket / Socket.IO / MQTT connections are saved in the workspace library
 * (library/grpc.json, library/websocket.json) and shown in a collection through their `collectionId`.
 * A collection run includes them: each becomes a test that runs where the collection shows it, after the request it
 * follows there (`runAfter`), with what a request inside gets from the collection and the folders around it: their
 * variables, their pre-request and test scripts, and their headers and auth (bearer, basic, API key in a header) as
 * gRPC metadata or with the WebSocket / Socket.IO handshake.
 */

/** A saved gRPC call, as the gRPC editor stores it. */
export interface SavedGrpcCall {
  target: string;
  method: string;
  message?: string;
  metadata?: KeyValue[];
  tls?: boolean;
  /** gRPC-Web instead of gRPC. */
  web?: boolean;
  protoFiles?: Array<{ name: string; text: string }>;
  descriptorSet?: string;
}

/** A saved WebSocket / Socket.IO / MQTT / Kafka connection, as the WebSocket editor stores it. */
export interface SavedConnection {
  url: string;
  mode?: 'websocket' | 'socketio' | 'mqtt' | 'kafka';
  message?: string;
  protocols?: string;
  headers?: KeyValue[];
  /** Socket.IO */
  event?: string;
  ack?: boolean;
  /** MQTT */
  topic?: string;
  qos?: 0 | 1 | 2;
  subscriptions?: Array<{ topic: string; qos?: 0 | 1 | 2 }>;
  username?: string;
  password?: string;
  clientId?: string;
  /** Kafka: the key and headers of the message to produce, the consumer group, the topics read (and from the beginning), SASL. */
  key?: string;
  kafkaHeaders?: KeyValue[];
  groupId?: string;
  reads?: Array<{ topic: string; fromBeginning?: boolean }>;
  mechanism?: 'plain' | 'scram-sha-256' | 'scram-sha-512';
}

const parseJson = (text: string | undefined): unknown => {
  if (text === undefined || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const location = (collectionName: string, item: LibraryItem<unknown>) => [collectionName, ...(item.folder ? [item.folder] : []), item.name];

/** A saved gRPC call as a test: the call must answer OK (code 0); .proto files or a reflected descriptor travel with it. */
export function savedGrpcCallToTest(item: LibraryItem<SavedGrpcCall>, collectionName: string): GrpcTest {
  const d = item.data;
  return {
    type: 'grpc',
    id: item.id,
    name: [item.folder, item.name].filter(Boolean).join(' / '),
    location: location(collectionName, item),
    target: d.target,
    method: d.method,
    message: parseJson(d.message),
    metadata: d.metadata,
    tls: d.tls,
    ...(d.web ? { web: true } : {}),
    protos: [],
    protoFiles: d.protoFiles?.length ? d.protoFiles : undefined,
    descriptorSet: d.protoFiles?.length ? undefined : d.descriptorSet,
    assertions: [{ type: 'status', expected: 0 }],
  };
}

/** A saved connection as a test: connect, send the saved message (or event / publish), listen briefly, close. */
export function savedConnectionToTest(item: LibraryItem<SavedConnection>, collectionName: string): WebSocketTest {
  const d = item.data;
  const mode = d.mode ?? 'websocket';
  const message = d.message ?? '';
  const parsed = parseJson(message);
  const send: WebSocketTest['send'] =
    mode === 'kafka'
      ? d.topic
        ? [{ topic: d.topic, payload: message, ...(d.key ? { key: d.key } : {}), ...(d.kafkaHeaders?.length ? { headers: Object.fromEntries(d.kafkaHeaders.filter((h) => h.enabled !== false && h.key).map((h) => [h.key, h.value])) } : {}) }]
        : []
      : mode === 'mqtt'
      ? d.topic
        ? [{ topic: d.topic, payload: message, qos: d.qos ?? 0 }]
        : []
      : mode === 'socketio'
        ? d.event
          ? [{ event: d.event, args: Array.isArray(parsed) ? parsed : parsed === undefined ? [] : [parsed], ack: !!d.ack }]
          : []
        : message.trim()
          ? [message]
          : [];
  return {
    type: 'websocket',
    id: item.id,
    name: [item.folder, item.name].filter(Boolean).join(' / '),
    location: location(collectionName, item),
    url: d.url,
    mode,
    send,
    subscribe: mode === 'mqtt' ? (d.subscriptions ?? []).map((s) => ({ topic: s.topic, qos: s.qos })) : mode === 'kafka' ? (d.reads ?? []).map((r) => ({ topic: r.topic, fromBeginning: !!r.fromBeginning })) : undefined,
    headers: mode === 'mqtt' || mode === 'kafka' ? undefined : d.headers,
    protocols: d.protocols?.trim() ? d.protocols.split(',').map((p) => p.trim()).filter(Boolean) : undefined,
    username: mode === 'mqtt' || mode === 'kafka' ? d.username : undefined,
    password: mode === 'mqtt' || mode === 'kafka' ? d.password : undefined,
    clientId: mode === 'mqtt' || mode === 'kafka' ? d.clientId : undefined,
    ...(mode === 'kafka' && d.groupId ? { groupId: d.groupId } : {}),
    ...(mode === 'kafka' && d.mechanism ? { mechanism: d.mechanism } : {}),
    // a connection that isn't accepted fails the test; nothing else is checked
    assertions: [],
  };
}

/** The libraries of a collection's own items: gRPC calls and connections. */
type CollectionItemLibrary = 'grpc' | 'websocket';
/** Library kinds whose items can belong to a collection: the registry's library kinds whose parent is a collection. */
export const COLLECTION_ITEM_KINDS = liveKinds()
  .filter((k) => k.parent === 'collection' && k.storage.layout === 'library')
  .map((k) => k.library) as readonly CollectionItemLibrary[];

/**
 * A collection's gRPC calls and connections, for a TestPion collection file (`savedItems`): sharing the
 * file shares everything the collection holds. Import puts them back (see `importIntoWorkspace`).
 */
export function collectionSavedItems(store: Pick<WorkspaceStore, 'getLibrary'>, collectionId: string): Partial<Record<(typeof COLLECTION_ITEM_KINDS)[number], LibraryItem[]>> | undefined {
  const out: Partial<Record<(typeof COLLECTION_ITEM_KINDS)[number], LibraryItem[]>> = {};
  for (const kind of COLLECTION_ITEM_KINDS) {
    const items = store.getLibrary(kind).items.filter((i) => i.collectionId === collectionId);
    if (items.length) out[kind] = items;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Copy a collection with everything it holds: new ids for the collection, its folders and requests (so
 * tabs, history and monitors of the original aren't confused with the copy), and copies of its gRPC calls
 * and connections, shown in the copy.
 */
export function duplicateCollection(store: Pick<WorkspaceStore, 'getCollection' | 'saveCollection' | 'getLibrary' | 'saveLibrary' | 'listCollections'>, id: string, newId: () => string): Collection {
  const src = store.getCollection(id);
  const taken = new Set(store.listCollections().map((c) => c.name.toLowerCase()));
  let name = `${src.name} copy`;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${src.name} copy ${i}`;
  // old id → new id of every folder, request and call: a copied call keeps its folder and its place in the copy
  const ids = new Map<string, string>();
  const fresh = (old: string) => (ids.get(old) ?? (ids.set(old, newId()), ids.get(old)!));
  const renumber = (nodes: CollectionNode[]): CollectionNode[] => nodes.map((n) => (n.kind === 'folder' ? { ...n, id: fresh(n.id), items: renumber(n.items) } : { ...n, id: fresh(n.id) }));
  const copy = store.saveCollection({ ...structuredClone(src), id: newId(), name, version: 0, items: renumber(structuredClone(src.items)) });
  const libs = COLLECTION_ITEM_KINDS.map((kind) => ({ kind, lib: store.getLibrary(kind) }));
  for (const { lib } of libs) for (const i of lib.items) if (i.collectionId === id) fresh(i.id);
  for (const { kind, lib } of libs) {
    const mine = lib.items.filter((i) => i.collectionId === id);
    const moved = (v?: string) => (v ? (ids.get(v) ?? v) : v);
    if (mine.length)
      store.saveLibrary(kind, {
        folders: lib.folders,
        items: [...lib.items, ...mine.map((i) => ({ ...structuredClone(i), id: ids.get(i.id)!, collectionId: copy.id, ...(i.folderId ? { folderId: moved(i.folderId) } : {}), ...(i.after ? { after: moved(i.after) } : {}), updatedAt: new Date().toISOString() }))],
      });
  }
  return copy;
}

/**
 * The gRPC calls and connections shown in a collection, as tests (gRPC first, then connections; each in
 * folder and name order). With a selection, only the selected ones.
 */
export function collectionRealtimeTests(store: Pick<WorkspaceStore, 'getLibrary'>, collection: { id: string; name: string; items?: CollectionNode[]; auth?: AuthConfig; headers?: KeyValue[]; preRequestScript?: string; testScript?: string }, selection?: string[]): TestCase[] {
  type Call = { kind: 'grpc' | 'websocket'; item: LibraryItem<SavedGrpcCall | SavedConnection> };
  const calls: Call[] = (['grpc', 'websocket'] as const).flatMap((kind) => store.getLibrary<SavedGrpcCall | SavedConnection>(kind).items.filter((i) => i.collectionId === collection.id).map((item) => ({ kind, item })));
  // any kind of request in any folder: a call's folder (`folderId`) and its place there decide when it runs, and a
  // selected folder takes the calls inside it (and inside its folders) too
  const parent = new Map<string, string | undefined>();
  const path = new Map<string, string>();
  const folders = new Map<string, Extract<CollectionNode, { kind: 'folder' }>>();
  const walk = (nodes: CollectionNode[], up?: string) => {
    for (const n of nodes) if (n.kind === 'folder') (parent.set(n.id, up), folders.set(n.id, n), path.set(n.id, up ? `${path.get(up)} / ${n.name}` : n.name), walk(n.items, n.id));
  };
  walk(collection.items ?? []);
  // (a call of an older version names its folder as text: the collection folder of that path, when there is one)
  const folderOf = (c: Call) => (c.item.folderId ? (parent.has(c.item.folderId) ? c.item.folderId : '') : (folderByPath({ items: collection.items ?? [] }, textFolderPath(c.item.folder))?.id ?? ''));
  const selected = (c: Call) => {
    if (!selection?.length || selection.includes(c.item.id)) return true;
    for (let f: string | undefined = folderOf(c) || undefined; f; f = parent.get(f)) if (selection.includes(f)) return true;
    return false;
  };
  const ordered: Call[] = [];
  /** The request each call follows in the collection's order, top to bottom ('' before the first one): where a run sends it. */
  const follows = new Map<Call, string>();
  let lastRequest = '';
  const byFolder = new Map<string, Call[]>();
  for (const c of calls) {
    const at = folderOf(c);
    const list = byFolder.get(at);
    if (list) list.push(c);
    else byFolder.set(at, [c]);
  }
  const visit = (nodes: CollectionNode[], folderId: string) => {
    const here = byFolder.get(folderId) ?? [];
    for (const x of interleave(nodes, here.map((c) => ({ id: c.item.id, name: c.item.name, after: c.item.after, c }))))
      if ('call' in x) (ordered.push(x.call.c), follows.set(x.call.c, lastRequest));
      else if (x.node.kind === 'folder') visit(x.node.items, x.node.id);
      else lastRequest = x.node.id;
  };
  visit(collection.items ?? [], '');
  // a test is named by the call's folder path in the collection (the text folder of an older version otherwise)
  const named = (c: Call) => (folderOf(c) ? { ...c.item, folder: path.get(folderOf(c)) } : c.item);
  /** The folders around a call, outermost first. */
  const foldersOf = (c: Call) => {
    const chain: Array<Extract<CollectionNode, { kind: 'folder' }>> = [];
    for (let f: string | undefined = folderOf(c) || undefined; f; f = parent.get(f)) chain.unshift(folders.get(f)!);
    return chain;
  };
  // what a request inside gets, a call gets too (as with a request, inner folders win and the call's own headers win over
  // all): the folders' variables, the collection's and folders' scripts, and their headers and auth (bearer, basic, API
  // key in a header) as gRPC metadata or with a WebSocket / Socket.IO handshake
  const inheritedOf = (around: ReturnType<typeof foldersOf>): KeyValue[] => {
    const headers = inheritedHeaders(collection, around);
    let auth: AuthConfig | undefined = collection.auth?.type === 'inherit' ? undefined : collection.auth;
    for (const f of around) if (f.auth && f.auth.type !== 'inherit') auth = f.auth;
    const a = headerAuth(auth);
    return a ? [...headers.filter((h) => h.key.toLowerCase() !== a.key.toLowerCase()), a] : headers;
  };
  return ordered.filter(selected).map((c) => {
    const test: TestCase = c.kind === 'grpc' ? savedGrpcCallToTest(named(c) as LibraryItem<SavedGrpcCall>, collection.name) : savedConnectionToTest(named(c) as LibraryItem<SavedConnection>, collection.name);
    const around = foldersOf(c);
    const variables = folderVariables(around);
    const inherited = inheritedOf(around);
    if (inherited.length) {
      if (test.type === 'grpc') test.metadata = withInheritedHeaders(test.metadata, inherited);
      // MQTT and Kafka have no handshake headers
      else if (test.type === 'websocket' && test.mode !== 'mqtt' && test.mode !== 'kafka') test.headers = withInheritedHeaders(test.headers, inherited);
    }
    const preRequestScript = joinScripts(collection.preRequestScript, ...around.map((f) => f.preRequestScript));
    const testScript = joinScripts(collection.testScript, ...around.map((f) => f.testScript));
    return Object.assign(
      { ...test, ...(Object.keys(variables).length ? { variables } : {}), ...(preRequestScript ? { preRequestScript } : {}), ...(testScript ? { testScript } : {}) },
      { runAfter: follows.get(c) ?? '' },
    ) as TestCase;
  });
}
