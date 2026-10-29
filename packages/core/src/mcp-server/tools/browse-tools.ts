import { collectionMarkdown } from '../../report/collection-docs.js';
import { collectionSavedItems } from '../../runner/collection-realtime.js';
import { collectionTiming } from '../../storage/collection-timing.js';
import { str } from '../tool.js';
import type { Tool } from '../tool.js';
import type { ModuleToolDeps } from './deps.js';

/** Browsing a workspace: collections, requests, environments, health and timing. */
export function browseTools(d: ModuleToolDeps): Tool[] {
  const { store, redactor, collections, findCollection, findRequest, flatten } = d;
  return [
    {
      name: 'list_collections',
      description: 'List the collections of the TestPion workspace with their request counts (HTTP/GraphQL requests, gRPC calls, WebSocket/MQTT connections).',
      inputSchema: { type: 'object', properties: {} },
      run: () =>
        collections().map((c) => {
          const saved = collectionSavedItems(store, c.id);
          return {
            id: c.id,
            name: c.name,
            description: c.description?.slice(0, 300),
            requests: flatten(c.items).length,
            grpcCalls: saved?.grpc?.length ?? 0,
            connections: saved?.websocket?.length ?? 0,
            examples: flatten(c.items).reduce((a, f) => a + (f.node.kind === 'http' ? f.node.examples?.length ?? 0 : 0), 0),
          };
        }),
    },
    {
      name: 'list_requests',
      description: 'List what a collection holds: HTTP and GraphQL requests (id, name, method, URL with {{variables}}, folder), gRPC calls (kind grpc: target, method) and WebSocket / Socket.IO / MQTT connections (kind websocket: url, mode). run_collection runs all of them.',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id') }, required: ['collection'] },
      run: (a) => {
        const c = findCollection(a.collection);
        const saved = collectionSavedItems(store, c.id);
        return [
          ...flatten(c.items).map(({ node, folder }) => ({
            id: node.id,
            name: node.name,
            kind: node.kind,
            method: node.kind === 'http' ? node.request.method : 'POST',
            url: node.kind === 'http' ? redactor.redactString(node.request.url) : node.request.endpoint,
            folder: folder || undefined,
          })),
          ...(saved?.grpc ?? []).map((i) => {
            const d = i.data as { target?: string; method?: string };
            return { id: i.id, name: i.name, kind: 'grpc', target: d.target, method: d.method, folder: i.folder };
          }),
          ...(saved?.websocket ?? []).map((i) => {
            const d = i.data as { url?: string; mode?: string };
            return { id: i.id, name: i.name, kind: 'websocket', mode: d.mode ?? 'websocket', url: d.url ? redactor.redactString(d.url) : undefined, folder: i.folder };
          }),
        ];
      },
    },
    {
      name: 'collection_health',
      description:
        'How the HTTP and GraphQL requests of a collection are doing, from the responses sent in the TestPion app: per request its folder, method, whether it has checks (assertions or a test script), responses recorded, how many failed, the latest status and the median time of the latest 50. Failing requests first, then the slowest; never-sent ones last. Use it to find broken, slow or untested endpoints.',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id') }, required: ['collection'] },
      run: (a) => {
        const c = findCollection(a.collection);
        const stats = new Map(store.meta.requestStats(c.id).map((s) => [s.requestId, s]));
        const rows = flatten(c.items).map(({ node, folder }) => {
          const s = stats.get(node.id);
          return {
            id: node.id,
            name: node.name,
            folder: folder || undefined,
            method: node.kind === 'http' ? node.request.method : 'GRAPHQL',
            hasChecks: !!node.assertions?.length || !!node.testScript?.trim(),
            ...(s ? { responses: s.count, failed: s.failed, lastStatus: s.lastStatus, lastOk: s.lastOk, lastAt: s.lastAt, medianMs: s.medianMs } : { responses: 0 }),
          };
        });
        const rank = (r: (typeof rows)[number]) => (!r.responses ? 2 : 'lastOk' in r && !r.lastOk ? 0 : 1);
        return rows.sort((x, y) => rank(x) - rank(y) || ((y as { medianMs?: number }).medianMs ?? 0) - ((x as { medianMs?: number }).medianMs ?? 0));
      },
    },
    {
      name: 'collection_timing',
      description: "Where the time of a collection's HTTP requests went, over the responses sent in the TestPion app: totals of DNS lookup, TCP connect, TLS handshake (new connections only), waiting for the server (TTFB) and download, and how many requests opened a new connection or reused one. Use it to tell a slow server from slow connections.",
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id') }, required: ['collection'] },
      run: (a) => collectionTiming(store, findCollection(a.collection).id) ?? { requests: 0, note: 'No responses with timing yet: send requests of this collection from the app.' },
    },
    {
      name: 'get_request',
      description: 'Show one saved request (headers, body, auth type, scripts, documentation and saved example names), or one of the collection’s gRPC calls (target, method, message, metadata) or connections (url, mode, message). Sensitive values are masked.',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id'), request: str('Request, gRPC call or connection: name or id') }, required: ['collection', 'request'] },
      run: (a) => {
        const col = findCollection(a.collection);
        // a gRPC call or connection of the collection (saved in the library, shown in the collection)
        const saved = collectionSavedItems(store, col.id);
        const ref = String(a.request);
        for (const kind of ['grpc', 'websocket'] as const) {
          const it = saved?.[kind]?.find((i) => i.id === ref) ?? saved?.[kind]?.find((i) => i.name.toLowerCase() === ref.toLowerCase());
          if (it) return { id: it.id, name: it.name, kind, folder: it.folder, ...(redactor.redact(it.data) as object) };
        }
        const { node, folder } = findRequest(col, a.request);
        const base = { id: node.id, name: node.name, folder: folder || undefined, request: redactor.redact(node.request) };
        return node.kind === 'http'
          ? { ...base, description: node.description, preRequestScript: node.preRequestScript, testScript: node.testScript, assertions: node.assertions, examples: node.examples?.map((e) => ({ name: e.name, status: e.status })) }
          : base;
      },
    },
    {
      name: 'list_environments',
      description: 'List environments and their variable names (values are not returned).',
      inputSchema: { type: 'object', properties: {} },
      run: () => store.listEnvironments().map((e) => ({ name: e.name, production: !!e.isProduction, variables: e.variables.filter((v) => v.enabled !== false).map((v) => (v.secret ? `${v.key} (secret)` : v.key)) })),
    },
    {
      name: 'collection_docs',
      description: 'Markdown documentation of a collection: description, every request with parameters, headers, body and saved examples.',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id') }, required: ['collection'] },
      run: (a) => collectionMarkdown(findCollection(a.collection), { redactor }),
    },
  ];
}
