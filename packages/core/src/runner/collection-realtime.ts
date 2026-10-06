import type { Collection, CollectionNode, GrpcTest, KeyValue, LibraryItem, TestCase, WebSocketTest } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';

/**
 * gRPC calls and WebSocket / Socket.IO / MQTT connections are saved in the workspace library
 * (library/grpc.json, library/websocket.json) and shown in a collection through their `collectionId`.
 * A collection run includes them: each becomes a test after the collection's HTTP and GraphQL requests.
 */

/** A saved gRPC call, as the gRPC editor stores it. */
export interface SavedGrpcCall {
  target: string;
  method: string;
  message?: string;
  metadata?: KeyValue[];
  tls?: boolean;
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

/** Library kinds whose items can belong to a collection. */
export const COLLECTION_ITEM_KINDS = ['grpc', 'websocket'] as const;

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
  const renumber = (nodes: CollectionNode[]): CollectionNode[] => nodes.map((n) => (n.kind === 'folder' ? { ...n, id: newId(), items: renumber(n.items) } : { ...n, id: newId() }));
  const copy = store.saveCollection({ ...structuredClone(src), id: newId(), name, version: 0, items: renumber(structuredClone(src.items)) });
  for (const kind of COLLECTION_ITEM_KINDS) {
    const lib = store.getLibrary(kind);
    const mine = lib.items.filter((i) => i.collectionId === id);
    if (mine.length) store.saveLibrary(kind, { folders: lib.folders, items: [...lib.items, ...mine.map((i) => ({ ...structuredClone(i), id: newId(), collectionId: copy.id, updatedAt: new Date().toISOString() }))] });
  }
  return copy;
}

/**
 * The gRPC calls and connections shown in a collection, as tests (gRPC first, then connections; each in
 * folder and name order). With a selection, only the selected ones.
 */
export function collectionRealtimeTests(store: Pick<WorkspaceStore, 'getLibrary'>, collection: { id: string; name: string }, selection?: string[]): TestCase[] {
  const pick = <T>(kind: string) =>
    store
      .getLibrary<T>(kind)
      .items.filter((i) => i.collectionId === collection.id && (!selection?.length || selection.includes(i.id)))
      .sort((a, b) => (a.folder ?? '').localeCompare(b.folder ?? '') || a.name.localeCompare(b.name));
  return [...pick<SavedGrpcCall>('grpc').map((i) => savedGrpcCallToTest(i, collection.name)), ...pick<SavedConnection>('websocket').map((i) => savedConnectionToTest(i, collection.name))];
}
