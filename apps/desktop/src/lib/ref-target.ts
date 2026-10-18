import { REQUEST_PROTOCOL_VIEW, kindOfRef, liveKinds, viewOfKind, type ItemKindInfo, type ItemRef, type RequestProtocol } from '@testpion/shared';
import type { ViewId } from '../store';

/**
 * Where an ItemRef opens: a view and the intent payload its handler understands, a dialog, or a page outside the app.
 * The one table of "this kind of thing opens there" (openRef uses it; nothing else routes items). Pure, so the mapping of
 * every kind is unit tested (tests/unit/open-ref.test.ts).
 */
export type RefTarget = { view: ViewId; payload: Record<string, unknown> } | { dialog: 'variableUsages'; key: string } | { external: string };

export interface TargetOptions {
  /** A new tab (editors with tabs), not the one on screen. */
  newTab?: boolean;
  /** Leave the explorer as it is (a click in the explorer itself). */
  noReveal?: boolean;
  /** A preview tab (WF-19: a single click in the explorer): the next one opened that way replaces it. */
  preview?: boolean;
}

/** The editor of each request protocol (SOAP is edited as HTTP): the item-kind registry's. */
export const PROTOCOL_VIEW = REQUEST_PROTOCOL_VIEW as Readonly<Record<RequestProtocol, ViewId>>;

/** The view of each library's items: where the registry says each library kind opens. */
export const LIBRARY_VIEW: Readonly<Record<string, ViewId>> = Object.fromEntries(liveKinds().flatMap((k) => (k.library && viewOfKind(k.id) ? [[k.library, viewOfKind(k.id) as ViewId]] : [])));

type Payload = Record<string, unknown> | { dialog: 'variableUsages'; key: string };
type RefOf<K extends ItemRef['kind']> = Extract<ItemRef, { kind: K }>;

/**
 * What each kind's intent handler reads beyond the view (the registry's `opens` names the view): one pure function per
 * kind whose handler needs a payload. A kind without one opens its view with an empty payload.
 */
const PAYLOAD: { [K in ItemRef['kind']]?: (ref: RefOf<K>, opts: TargetOptions, info: ItemKindInfo) => Payload } = {
  request: (r, o) => ({ collectionId: r.collectionId, requestId: r.requestId, ...(o.noReveal ? { noReveal: true } : {}), ...(o.preview ? { preview: true } : {}) }),
  collection: (r) => ({ collectionId: r.collectionId, ...(r.tab === 'run' ? { run: true } : r.tab === 'mock' ? { mock: true } : r.tab ? { tab: r.tab } : {}) }),
  // a folder's settings live in its collection's page; Run there runs the folder
  folder: (r) => ({ collectionId: r.collectionId, folderId: r.folderId }),
  mock: (r) => ({ collectionId: r.collectionId, mock: true }),
  saved: (r, _o, info) => (info.id === 'monitor' ? { monitorId: r.itemId } : { savedId: r.itemId }),
  monitor: (r) => ({ monitorId: r.monitorId }),
  environment: (r) => (r.environmentId ? { environmentId: r.environmentId } : r.scope === 'collection' ? { tab: 'collection', collectionId: r.collectionId } : r.scope ? { tab: r.scope } : {}),
  variable: (r) => (r.environmentId ? { environmentId: r.environmentId, variable: r.key } : { dialog: 'variableUsages', key: r.key }),
  test: (r) => ({ path: r.path, ...(r.step ? { step: r.step } : {}), ...(r.line ? { line: Number(r.line) } : {}) }),
  flow: (r) => ({ path: r.path, flow: true, ...(r.step ? { step: r.step } : {}) }),
  'test-case': (r) => ({ testId: r.testId }),
  run: (r) => ({ runId: r.runId, ...(r.resultId ? { resultId: r.resultId } : {}) }),
  history: (r) => ({ historyId: r.historyId }),
  trace: (r) => ({ traceId: r.traceId }),
  capture: (r) => ({ session: r.name }),
  exchange: (r) => ({ exchangeId: r.exchangeId }),
  'mcp-server': (r) => ({ serverId: r.serverId }),
  provider: (r) => ({ providerId: r.providerId }),
  spec: (r) => ({ spec: r.path }),
  dataset: (r) => ({ dataset: r.name }),
  certificate: (r) => ({ tab: 'certificates', host: r.host }),
  'git-file': (r) => ({ file: r.path, ...(r.line ? { line: Number(r.line) } : {}) }),
};

/** The target of a ref; undefined only for a library this version doesn't know. */
export function refTarget(ref: ItemRef, opts: TargetOptions = {}): RefTarget | undefined {
  const info = kindOfRef(ref as ItemRef & { library?: string });
  if (!info || info.since) return undefined;
  if (info.opens === 'external') return { external: (ref as RefOf<'doc'>).url };
  const view = ref.kind === 'request' ? (PROTOCOL_VIEW[ref.protocol ?? 'http'] ?? 'rest') : (viewOfKind(info.id) as ViewId | undefined);
  if (!view) return undefined;
  const payload = (PAYLOAD[ref.kind] as ((r: ItemRef, o: TargetOptions, i: ItemKindInfo) => Payload) | undefined)?.(ref, opts, info) ?? {};
  if ('dialog' in payload && payload.dialog === 'variableUsages') return payload as { dialog: 'variableUsages'; key: string };
  return { view, payload: { ...payload, ...(opts.newTab ? { newDoc: true } : {}) } };
}

/**
 * A history entry as the editor that sends it again, with what was sent: HTTP and gRPC requests, a GraphQL query with
 * its variables, an MCP tool call (server, tool, arguments), an LLM prompt. Undefined for an entry without a request.
 */
export function historyEditorTarget(e: { kind: string; name?: string; request?: unknown }): RefTarget | undefined {
  const r = e.request as Record<string, unknown> | undefined;
  if (!r || typeof r !== 'object') return undefined;
  switch (e.kind) {
    case 'http':
      return { view: 'rest', payload: { request: r, name: e.name } };
    case 'graphql':
      return { view: 'graphql', payload: { request: r, name: e.name, newDoc: true } };
    case 'grpc':
      return { view: 'grpc', payload: { request: r, newDoc: true } };
    case 'websocket':
      return { view: 'websocket', payload: { request: r, newDoc: true } };
    case 'mcp':
      return typeof r.serverId === 'string' ? { view: 'mcp', payload: { serverId: r.serverId, call: { tool: r.tool, args: r.args ?? {} } } } : undefined;
    case 'llm':
      return { view: 'ai', payload: { prompt: r } };
    default:
      return undefined;
  }
}
