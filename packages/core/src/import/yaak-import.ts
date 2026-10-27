import { parseYaml } from '../util/lazy-yaml.js';
import type { BodyConfig, CollectionFolder, CollectionNode, Environment, KeyValue, LibraryItem, SavedGraphQLRequest, SavedHttpRequest } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';
import { mapMoreAuth } from './foreign-auth-more.js';
import { normalizeYaak, distinct, splitYaakUnknown } from './templates-more.js';
import { Findings, newDocument, type ImportDocument } from './model.js';
import { collectionOf, type Any } from './import-helpers.js';
import { takeParsed } from './parsed.js';

/**
 * Yaak as an import document: the workspace export (`yaakSchema`, `resources: { workspaces, environments, folders,
 * httpRequests, grpcRequests, websocketRequests }`) and a git-sync folder (one `yaak.<id>.yaml` file per model, which
 * `yaakFilesToExport` turns into the same shape). Folders, requests, params, headers, bodies (JSON, XML, text, form,
 * multipart, GraphQL, binary), auth plugins, environments (the base environment merged into the others), gRPC and
 * WebSocket requests (library items) and the `${[ … ]}` templates. A template that reads another request's response
 * stays as text and is reported (the plan: chain it like Insomnia's `{% response %}`).
 */

export function isYaak(d: Any): boolean {
  return (typeof d.yaakSchema === 'number' || typeof d.yaakVersion === 'string') && !!d.resources && typeof d.resources === 'object';
}

/** The files of a Yaak git-sync folder (`yaak.<id>.yaml`) as one export object. */
export function yaakFilesToExport(files: Array<{ path: string; text: string }>): Any {
  const resources: Record<string, Any[]> = { workspaces: [], environments: [], folders: [], httpRequests: [], grpcRequests: [], websocketRequests: [] };
  const key: Record<string, string> = { workspace: 'workspaces', environment: 'environments', folder: 'folders', http_request: 'httpRequests', grpc_request: 'grpcRequests', websocket_request: 'websocketRequests' };
  for (const f of files) {
    let y: Any;
    try {
      y = parseYaml(f.text) as Any;
    } catch {
      continue;
    }
    const k = key[String(y?.type ?? y?.model ?? '')];
    if (k) resources[k]!.push(y);
  }
  return { yaakVersion: 'folder', yaakSchema: 4, resources };
}

export function parseYaak(text: string): ImportDocument {
  const t = text.trim();
  const d: Any = t.startsWith('{') ? takeParsed(t) : (parseYaml(t) as Any);
  const r: Any = d.resources ?? {};
  const findings = new Findings();
  const doc = newDocument('yaak', text, { tool: 'Yaak', ...(d.yaakVersion ? { version: String(d.yaakVersion) } : {}), scriptTool: undefined });
  const unknown: string[] = [];
  const refs: string[] = [];
  const n = (s: unknown): string => {
    const x = normalizeYaak(s);
    // a template that reads another request's response (or another unknown function)
    for (const u of x.unknown) (/response|request/i.test(u) ? refs : unknown).push(u);
    return x.text;
  };
  const kv = (list: unknown): KeyValue[] => (Array.isArray(list) ? list : []).filter((x: Any) => x?.name).map((x: Any) => ({ key: n(x.name), value: n(x.value ?? ''), enabled: x.enabled !== false }));

  const workspaces: Any[] = Array.isArray(r.workspaces) ? r.workspaces : [];
  const folders: Any[] = Array.isArray(r.folders) ? r.folders : [];
  const requests: Any[] = Array.isArray(r.httpRequests) ? r.httpRequests : [];
  const envs: Any[] = Array.isArray(r.environments) ? r.environments : [];
  const ws = workspaces[0];
  if (workspaces.length > 1) findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [], message: `The file holds ${workspaces.length} Yaak workspaces: each becomes a folder of one collection` });
  const wsId = (x: Any) => String(x.workspaceId ?? '');

  const authOf = (x: Any, where: string, headers?: KeyValue[]) => {
    const a = mapMoreAuth('yaak', x.authentication, where, n, x.authenticationType);
    findings.notes(a.notes);
    headers?.push(...a.headers);
    return a.auth;
  };

  const body = (x: Any, name: string): BodyConfig | undefined => {
    const b: Any = x.body ?? {};
    const type = String(x.bodyType ?? '');
    if (type === 'application/x-www-form-urlencoded') return { type: 'form-urlencoded', fields: kv(b.form) };
    if (type === 'multipart/form-data')
      return {
        type: 'multipart',
        fields: (Array.isArray(b.form) ? b.form : []).filter((f: Any) => f?.name).map((f: Any) => ({ key: n(f.name), value: f.file ? String(f.file) : n(f.value ?? ''), kind: f.file ? ('file' as const) : ('text' as const), enabled: f.enabled !== false, ...(f.contentType ? { contentType: String(f.contentType) } : {}) })),
      };
    if (type === 'binary' || type === 'application/octet-stream') return b.filePath ? { type: 'binary', filePath: String(b.filePath) } : undefined;
    if (!b.text && typeof b.text !== 'string') {
      if (Object.keys(b).length && type && type !== 'graphql') findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [name], field: 'body', message: `"${name}": a ${type} body in a form TestPion does not read was not imported` });
      return undefined;
    }
    const kind = type.includes('json') ? 'json' : type.includes('xml') ? 'xml' : type.includes('html') ? 'html' : 'text';
    return { type: kind, content: n(b.text) };
  };

  const sourceIds: Record<string, string> = {};
  const request = (x: Any): SavedHttpRequest | SavedGraphQLRequest => {
    const node = requestNode(x);
    if (x.id) sourceIds[node.id] = String(x.id);
    return node;
  };
  const requestNode = (x: Any): SavedHttpRequest | SavedGraphQLRequest => {
    const name = String(x.name || x.url || 'Request');
    const headers = kv(x.headers);
    const auth = authOf(x, name, headers) ?? { type: 'inherit' as const };
    if (x.bodyType === 'graphql') {
      const g: Any = x.body ?? {};
      return { kind: 'graphql', id: shortId('gql-'), name, request: { endpoint: n(x.url), query: n(g.query ?? ''), ...(typeof g.variables === 'string' && g.variables.trim() ? { variables: n(g.variables) } : {}), headers, auth } };
    }
    // Yaak keeps the query in `urlParameters`; the URL may still carry one typed by hand (kept: it is part of the URL)
    const params = kv(x.urlParameters).filter((p) => !p.key.startsWith(':'));
    const pathVars = kv(x.urlParameters).filter((p) => p.key.startsWith(':')).map((p) => ({ key: p.key.slice(1), value: p.value }));
    return {
      kind: 'http',
      id: shortId('req-'),
      name,
      ...(x.description ? { description: String(x.description) } : {}),
      request: { method: String(x.method ?? 'GET').toUpperCase(), url: n(x.url), params, ...(pathVars.length ? { pathVariables: pathVars } : {}), headers, body: body(x, name), auth },
    };
  };

  const sortOf = (x: Any) => Number(x.sortPriority ?? 0);
  // grouped by parent folder once (each folder used to filter every folder and request)
  const groupByFolder = (list: Any[]) => {
    const m = new Map<string | null, Any[]>();
    for (const x of list) (m.get(x.folderId ?? null) ?? m.set(x.folderId ?? null, []).get(x.folderId ?? null)!).push(x);
    return m;
  };
  const foldersIn = groupByFolder(folders);
  const requestsIn = groupByFolder(requests);
  const build = (workspace: string | undefined, parent: string | null): CollectionNode[] => {
    const here = (x: Any) => workspace === undefined || wsId(x) === workspace;
    const items = [...(foldersIn.get(parent) ?? []).filter(here).map((x) => ({ x, folder: true })), ...(requestsIn.get(parent) ?? []).filter(here).map((x) => ({ x, folder: false }))].sort((a, b) => sortOf(a.x) - sortOf(b.x));
    return items.map(({ x, folder }): CollectionNode => {
      if (!folder) return request(x);
      const name = String(x.name ?? 'Folder');
      const headers = kv(x.headers);
      const auth = authOf(x, name);
      const f: CollectionFolder = { kind: 'folder', id: shortId('fld-'), name, items: build(workspace, String(x.id)), ...(x.description ? { description: String(x.description) } : {}), ...(auth ? { auth } : {}), ...(headers.length ? { headers } : {}) };
      if (x.id) sourceIds[f.id] = String(x.id);
      return f;
    });
  };
  const name = String(ws?.name ?? 'Yaak import');
  const items = workspaces.length > 1 ? workspaces.map((w): CollectionNode => ({ kind: 'folder', id: shortId('fld-'), name: String(w.name ?? 'Workspace'), items: build(String(w.id), null) })) : build(ws ? String(ws.id) : undefined, null);
  const rootHeaders = kv(ws?.headers);
  const rootAuth = ws ? authOf(ws, name) : undefined;
  doc.collections.push(collectionOf(name, items, { ...(ws?.description ? { description: String(ws.description) } : {}), ...(rootHeaders.length ? { headers: rootHeaders } : {}), ...(rootAuth ? { auth: rootAuth } : {}) }));

  // environments: the base environment is merged into the others (as for Insomnia)
  const base = envs.find((e) => e.base === true || e.parentModel === 'workspace' && !e.parentId && /base|global/i.test(String(e.name ?? '')));
  const baseVars = kv(base?.variables);
  const subs = envs.filter((e) => e !== base);
  const merge = (extra: KeyValue[]) => {
    const keys = new Set(extra.map((v) => v.key));
    return [...baseVars.filter((v) => !keys.has(v.key)), ...extra];
  };
  const environments: Environment[] = subs.length
    ? subs.map((e) => ({ id: slugify(String(e.name ?? 'env')) || 'env', name: String(e.name ?? 'Environment'), variables: merge(kv(e.variables)), ...(e.color ? { color: String(e.color) } : {}) }))
    : baseVars.length
      ? [{ id: slugify(name) || 'yaak', name, variables: baseVars }]
      : [];
  doc.environments = environments;
  if (Object.keys(sourceIds).length) doc.sourceIds = sourceIds;
  if (ws?.id) doc.sourceKey = String(ws.id);

  // gRPC and WebSocket requests → library items
  const grpc: LibraryItem[] = (Array.isArray(r.grpcRequests) ? r.grpcRequests : []).map((g: Any) => ({
    id: shortId('lib-'),
    name: String(g.name || 'gRPC call'),
    data: { target: n(g.url).replace(/^grpcs?:\/\//, ''), method: [g.service, g.method].filter(Boolean).join('/'), message: n(g.message ?? '{}'), metadata: kv(g.metadata), tls: /^grpcs:/i.test(String(g.url ?? '')), protoFiles: [] },
  }));
  const websocket: LibraryItem[] = (Array.isArray(r.websocketRequests) ? r.websocketRequests : []).map((w: Any) => ({
    id: shortId('lib-'),
    name: String(w.name || 'WebSocket'),
    data: { url: n(w.url), mode: 'websocket', message: n(w.message ?? ''), headers: kv(w.headers).map((h) => ({ ...h })), protocols: '' },
  }));
  if (grpc.length || websocket.length) doc.savedItems = { ...(grpc.length ? { grpc } : {}), ...(websocket.length ? { websocket } : {}) };
  if (grpc.length) findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [], message: `${grpc.length} Yaak gRPC request${grpc.length > 1 ? 's came' : ' came'} over as gRPC calls without their .proto files: choose the proto files again` });

  if (refs.length) findings.add({ code: 'TEMPLATE_TAG_UNSUPPORTED', severity: 'changed', where: [], message: `${distinct(refs).length} Yaak template${distinct(refs).length > 1 ? 's read' : ' reads'} another request's response (${distinct(refs).slice(0, 2).join(', ')}${distinct(refs).length > 2 ? ' …' : ''}) and stay as text: chain them with a script or a flow`, original: distinct(refs)[0] });
  const { builtIn, plugin } = splitYaakUnknown(unknown);
  if (builtIn.length) findings.add({ code: 'TEMPLATE_TAG_UNSUPPORTED', severity: 'changed', where: [], message: `${builtIn.length} Yaak function${builtIn.length > 1 ? 's have' : ' has'} no TestPion dynamic variable (${builtIn.slice(0, 3).join(', ')}) and stay as text: compute the value in a pre-request script`, original: builtIn[0] });
  if (plugin.length) findings.add({ code: 'TEMPLATE_TAG_UNSUPPORTED', severity: 'changed', where: [], message: `${plugin.length} template function${plugin.length > 1 ? 's come' : ' comes'} from a Yaak plugin (${plugin.slice(0, 3).join(', ')}) and stay as text: TestPion does not run Yaak plugins`, original: plugin[0] });
  doc.findings.push(...findings.list);
  return doc;
}
