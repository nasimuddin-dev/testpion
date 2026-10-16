import type { ItemRef, RequestProtocol } from '@testpion/shared';
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

/** The editor of each request protocol (SOAP is edited as HTTP). */
export const PROTOCOL_VIEW: Record<RequestProtocol, ViewId> = { http: 'rest', soap: 'rest', graphql: 'graphql', grpc: 'grpc', websocket: 'websocket' };

/** The view of each library's items. */
export const LIBRARY_VIEW: Readonly<Record<string, ViewId>> = { grpc: 'grpc', websocket: 'websocket', 'ai-prompts': 'ai', 'load-tests': 'load', evaluations: 'evaluations', monitors: 'monitors' };

/** The target of a ref; undefined only for a library this version doesn't know. */
export function refTarget(ref: ItemRef, opts: TargetOptions = {}): RefTarget | undefined {
  const tab = opts.newTab ? { newDoc: true } : {};
  const go = (view: ViewId, payload: Record<string, unknown> = {}): RefTarget => ({ view, payload: { ...payload, ...tab } });
  switch (ref.kind) {
    case 'request':
      return go(PROTOCOL_VIEW[ref.protocol ?? 'http'] ?? 'rest', { collectionId: ref.collectionId, requestId: ref.requestId, ...(opts.noReveal ? { noReveal: true } : {}), ...(opts.preview ? { preview: true } : {}) });
    case 'collection':
      return go('collections', { collectionId: ref.collectionId, ...(ref.tab === 'run' ? { run: true } : ref.tab === 'mock' ? { mock: true } : ref.tab ? { tab: ref.tab } : {}) });
    case 'folder':
      // a folder's settings live in its collection's page; Run there runs the folder
      return go('collections', { collectionId: ref.collectionId, folderId: ref.folderId });
    case 'mock':
      return go('collections', { collectionId: ref.collectionId, mock: true });
    case 'saved': {
      const view = LIBRARY_VIEW[ref.library];
      if (!view) return undefined;
      return view === 'monitors' ? go('monitors', { monitorId: ref.itemId }) : go(view, { savedId: ref.itemId });
    }
    case 'monitor':
      return go('monitors', { monitorId: ref.monitorId });
    case 'environment':
      if (ref.environmentId) return go('environments', { environmentId: ref.environmentId });
      return go('environments', ref.scope === 'collection' ? { tab: 'collection', collectionId: ref.collectionId } : ref.scope ? { tab: ref.scope } : {});
    case 'variable':
      return ref.environmentId ? go('environments', { environmentId: ref.environmentId, variable: ref.key }) : { dialog: 'variableUsages', key: ref.key };
    case 'test':
      return go('tests', { path: ref.path, ...(ref.step ? { step: ref.step } : {}), ...(ref.line ? { line: Number(ref.line) } : {}) });
    case 'flow':
      return go('tests', { path: ref.path, flow: true, ...(ref.step ? { step: ref.step } : {}) });
    case 'test-case':
      return go('tests', { testId: ref.testId });
    case 'run':
      return go('tests', { runId: ref.runId, ...(ref.resultId ? { resultId: ref.resultId } : {}) });
    case 'history':
      return go('history', { historyId: ref.historyId });
    case 'trace':
      return go('traces', { traceId: ref.traceId });
    case 'capture':
      return go('debugger', { session: ref.name });
    case 'exchange':
      return go('debugger', { exchangeId: ref.exchangeId });
    case 'mcp-server':
      return go('mcp', { serverId: ref.serverId });
    case 'provider':
      return go('ai', { providerId: ref.providerId });
    case 'spec':
      return go('apidef', { spec: ref.path });
    case 'dataset':
      return go('dataset', { dataset: ref.name });
    case 'certificate':
      return go('settings', { tab: 'certificates', host: ref.host });
    case 'git-file':
      return go('git', { file: ref.path, ...(ref.line ? { line: Number(ref.line) } : {}) });
    case 'doc':
      return { external: ref.url };
  }
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
