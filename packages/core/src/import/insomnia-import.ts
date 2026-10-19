import { parseYaml } from '../util/lazy-yaml.js';
import type { Collection, CollectionFolder, CollectionNode, Environment, HttpSettings, KeyValue, LibraryItem, SavedGraphQLRequest, SavedHttpRequest } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';
import { mapForeignAuth } from './foreign-auth.js';
import { normalizeTemplate } from './templates.js';
import { mapInsomniaTemplateTags, type InsomniaImported } from './insomnia-tags.js';
import { Findings, newDocument, type ImportDocument } from './model.js';
import { bodyFromMime, collectionOf, flattenVars, kv, type Any } from './import-helpers.js';
import { finishDocument } from './pipeline.js';
import type { ImportScriptsMode, ImportScriptsSummary } from './import-scripts.js';

/**
 * Insomnia v4 (JSON export) and v5 (YAML) as an import document. Requests, folders (with their headers, auth,
 * variables and scripts), bodies, auth, parameters, environments (the base merged into each sub-environment),
 * gRPC and WebSocket requests (as library items), design documents (API specs kept in specs/), request settings and
 * template tags (insomnia-tags.ts). Scripts stay as written: the pipeline converts `insomnia.*` to `tp.*`.
 */

type SavedItems = { grpc?: LibraryItem[]; websocket?: LibraryItem[] };

interface Ctx {
  findings: Findings;
  requests: InsomniaImported[];
  folders: CollectionFolder[];
  saved: Required<SavedItems>;
  /** Names of items by Insomnia id → for the folder path of library items (v5). */
  specs: Array<{ name: string; text: string }>;
}

/** v4 `preRequestScript` / `afterResponseScript`; v5 `scripts.preRequest` / `scripts.afterResponse`. */
const scriptsOf = (x: Any) => ({
  pre: String(x.scripts?.preRequest ?? x.preRequestScript ?? '').trim() || undefined,
  post: String(x.scripts?.afterResponse ?? x.afterResponseScript ?? '').trim() || undefined,
});

/** A folder (v4 request_group, v5 item with children): auth, headers, variables, scripts. */
function insomniaFolder(f: Any, items: CollectionNode[], ctx: Ctx): CollectionFolder {
  const name = f.name ?? 'Folder';
  const variables = flattenVars(f.environment);
  const a = mapForeignAuth('insomnia', f.authentication, name);
  ctx.findings.notes(a.notes);
  const headers = kv(f.headers);
  const s = scriptsOf(f);
  const description = String(f.description ?? f.meta?.description ?? '').trim();
  const folder: CollectionFolder = {
    kind: 'folder',
    id: shortId('fld-'),
    name,
    items,
    ...(description ? { description } : {}),
    ...(a.auth ? { auth: a.auth } : {}),
    ...(headers.length ? { headers } : {}),
    ...(variables.length ? { variables } : {}),
    ...(s.pre ? { preRequestScript: s.pre } : {}),
    ...(s.post ? { testScript: s.post } : {}),
  };
  ctx.folders.push(folder);
  return folder;
}

/** The request settings of v5 (`settings`) and v4 (`setting…`). */
function insomniaSettings(r: Any): HttpSettings | undefined {
  const s: HttpSettings = {};
  // v4 settingFollowRedirects: 'off'; v5 settings.followRedirects: 'off'
  if (r.settingFollowRedirects === 'off' || r.settings?.followRedirects === 'off') s.followRedirects = false;
  if (r.settingEncodeUrl === false || r.settings?.encodeUrl === false) s.encodeUrl = false;
  // Insomnia can send and store cookies separately; TestPion's switch is for both
  if (r.settingSendCookies === false || r.settingStoreCookies === false || r.settings?.cookies?.send === false || r.settings?.cookies?.store === false) s.disableCookieJar = true;
  return Object.keys(s).length ? s : undefined;
}

function insomniaRequest(r: Any, ctx: Ctx): SavedHttpRequest | SavedGraphQLRequest {
  const url = normalizeTemplate(r.url);
  const name = r.name || url;
  const headers = kv(r.headers);
  const a = mapForeignAuth('insomnia', r.authentication, name);
  ctx.findings.notes(a.notes);
  headers.push(...a.headers);
  const auth = a.auth ?? { type: 'inherit' as const };
  const mime = r.body?.mimeType ?? '';
  const s = scriptsOf(r);
  const id = r._id ?? r.meta?.id;
  let node: SavedHttpRequest | SavedGraphQLRequest;
  if (mime === 'application/graphql') {
    let g: Any = {};
    try {
      g = JSON.parse(r.body?.text ?? '{}');
    } catch {
      /* not JSON */
    }
    node = { kind: 'graphql', id: shortId('gql-'), name, request: { endpoint: url, query: normalizeTemplate(g.query ?? ''), variables: g.variables && Object.keys(g.variables).length ? g.variables : undefined, operationName: g.operationName || undefined, headers, auth } };
  } else {
    const pathParams = kv(r.pathParameters);
    const description = r.description ?? r.meta?.description;
    const settings = insomniaSettings(r);
    if (r.body?.fileName) ctx.findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [name], field: 'body', message: `"${name}": the body is the file ${r.body.fileName}: choose it again (binary body)` });
    node = {
      kind: 'http',
      id: shortId('req-'),
      name,
      ...(description ? { description: String(description) } : {}),
      request: {
        method: String(r.method ?? 'GET').toUpperCase(),
        url,
        params: kv(r.parameters),
        ...(pathParams.length ? { pathVariables: pathParams } : {}),
        headers,
        body: r.body?.fileName ? { type: 'binary', filePath: String(r.body.fileName) } : bodyFromMime(mime, r.body?.text, r.body?.params),
        auth,
        ...(settings ? { settings } : {}),
      },
    };
  }
  if (s.pre) node.preRequestScript = s.pre;
  if (s.post) node.testScript = s.post;
  ctx.requests.push({ id, node });
  return node;
}

function insomniaEnvironments(name: string, base: Any | undefined, subs: Any[]): Environment[] {
  const baseVars = flattenVars(base?.data ?? {});
  const merge = (extra: KeyValue[]) => {
    const keys = new Set(extra.map((v) => v.key));
    return [...baseVars.filter((v) => !keys.has(v.key)), ...extra];
  };
  if (!subs.length) return baseVars.length ? [{ id: slugify(name) || 'imported', name, variables: baseVars }] : [];
  return subs.map((s) => ({ id: slugify(s.name ?? 'env') || 'env', name: s.name ?? 'Environment', variables: merge(flattenVars(s.data ?? {})), ...(s.color ? { color: s.color } : {}) }));
}

const libKv = (list: Any[] | undefined) => (list ?? []).filter((x: Any) => x?.name).map((x: Any) => ({ key: String(x.name), value: normalizeTemplate(String(x.value ?? '')), enabled: !x.disabled }));

const grpcItem = (r: Any, folder: string | undefined, proto: { name: string; text: string } | undefined): LibraryItem => {
  const url = normalizeTemplate(String(r.url ?? ''));
  return {
    id: shortId('lib-'),
    name: String(r.name || 'gRPC call'),
    folder,
    data: { target: url.replace(/^grpcs?:\/\//, ''), method: String(r.protoMethodName ?? '').replace(/^\//, ''), message: String(r.body?.text ?? '{}'), metadata: libKv(r.metadata), tls: /^grpcs:/i.test(url), protoFiles: proto ? [proto] : [] },
  };
};
const wsItem = (r: Any, folder: string | undefined, message: unknown): LibraryItem => ({ id: shortId('lib-'), name: String(r.name || 'WebSocket'), folder, data: { url: normalizeTemplate(String(r.url ?? '')), mode: 'websocket', message: String(message ?? ''), headers: libKv(r.headers), protocols: '' } });

/**
 * Insomnia 4 exports also hold gRPC requests (with their .proto files) and WebSocket requests: they become
 * the imported collection's gRPC calls and connections (library items, see `savedItems` in workspace-import).
 */
function insomniaSavedItems(res: Any[]): SavedItems | undefined {
  const byId = new Map(res.map((r) => [r._id, r]));
  const folderOf = (parentId: string): string | undefined => {
    const names: string[] = [];
    for (let p = byId.get(parentId); p && p._type === 'request_group'; p = byId.get(p.parentId)) names.unshift(String(p.name ?? 'Folder'));
    return names.join(' / ') || undefined;
  };
  const protos = new Map(res.filter((r) => r._type === 'proto_file' && typeof r.protoText === 'string').map((r) => [r._id, { name: /\.proto$/.test(String(r.name ?? '')) ? String(r.name) : `${r.name || 'service'}.proto`, text: String(r.protoText) }]));
  const grpc = res.filter((r) => r._type === 'grpc_request').map((r) => grpcItem(r, folderOf(r.parentId), protos.get(r.protoFileId)));
  const websocket = res.filter((r) => r._type === 'websocket_request').map((r) => wsItem(r, folderOf(r.parentId), res.find((p) => p._type === 'websocket_payload' && p.parentId === r._id)?.value));
  return grpc.length || websocket.length ? { ...(grpc.length ? { grpc } : {}), ...(websocket.length ? { websocket } : {}) } : undefined;
}

/** A v5 item that is not an HTTP request: its kind (gRPC, WebSocket, Socket.IO, MCP client), or undefined. */
function v5Kind(it: Any): 'grpc' | 'websocket' | 'Socket.IO request' | 'MCP client' | undefined {
  if (it.protoFileId !== undefined || it.protoMethodName !== undefined || it.reflectionApi !== undefined) return 'grpc';
  if (it.eventListeners !== undefined) return 'Socket.IO request';
  if (it.transportType !== undefined) return 'MCP client';
  if (/^wss?:\/\//i.test(String(it.url ?? '')) && !it.method) return 'websocket';
  return undefined;
}

/** Insomnia v4 / v5 → document. */
export function parseInsomnia(text: string): ImportDocument {
  const t = text.trim();
  const d: Any = t.startsWith('{') ? JSON.parse(t) : parseYaml(t);
  const findings = new Findings();
  const v5 = String(d.type ?? '').startsWith('collection.insomnia.rest/5');
  const ctx: Ctx = { findings, requests: [], folders: [], saved: { grpc: [], websocket: [] }, specs: [] };
  const doc = newDocument('insomnia', text, { tool: 'Insomnia', version: v5 ? String(d.type).split('/')[1] : String(d.__export_format ?? 4), scriptTool: 'insomnia' });
  let collection: Collection;
  let environments: Environment[];
  if (v5) {
    // Insomnia 5 YAML: a tree under `collection`, environments with sub-environments
    const convert = (items: Any[], path: string[]): CollectionNode[] =>
      (items ?? []).flatMap((it: Any): CollectionNode[] => {
        if (Array.isArray(it.children)) return [insomniaFolder(it, convert(it.children, [...path, String(it.name ?? 'Folder')]), ctx)];
        const kind = v5Kind(it);
        const folder = path.join(' / ') || undefined;
        if (kind === 'grpc') {
          ctx.saved.grpc.push(grpcItem(it, folder, undefined));
          findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [String(it.name ?? 'gRPC call')], message: `"${it.name ?? 'gRPC call'}": a gRPC request of an Insomnia 5 file came over as a gRPC call without its .proto: choose the proto file again` });
          return [];
        }
        if (kind === 'websocket') {
          ctx.saved.websocket.push(wsItem(it, folder, it.body?.text ?? it.message));
          return [];
        }
        if (kind) {
          findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [String(it.name ?? 'Item')], message: `"${it.name ?? 'Item'}": a ${kind} in an Insomnia 5 file is not imported yet (export it from Insomnia 4 format, or recreate it)` });
          return [];
        }
        return [insomniaRequest(it, ctx)];
      });
    const name = d.name ?? 'Insomnia import';
    const env = d.environments ?? {};
    collection = collectionOf(name, convert(d.collection ?? [], []), { description: d.meta?.description });
    environments = insomniaEnvironments(name, env, env.subEnvironments ?? []);
    if (typeof d.spec?.contents === 'string' && d.spec.contents.trim()) ctx.specs.push({ name: String(d.spec.meta?.name ?? name), text: d.spec.contents });
    for (const [key, label] of [['testSuites', 'unit test suite'] as const]) {
      const n = Array.isArray(d[key]) ? d[key].length : 0;
      if (n) findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [], message: `${n} Insomnia ${label}${n > 1 ? 's were' : ' was'} not imported` });
    }
    if (Array.isArray(d.cookieJar?.cookies) && d.cookieJar.cookies.length) findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [], message: '1 Insomnia cookie jar was not imported' });
  } else {
    // Insomnia 4 export: flat resources linked by parentId
    const res: Any[] = d.resources ?? [];
    const children = new Map<string, Any[]>();
    for (const r of res) {
      const list = children.get(r.parentId);
      if (list) list.push(r);
      else children.set(r.parentId, [r]);
    }
    const order = (list: Any[]) => [...list].sort((a, b) => (a.metaSortKey ?? 0) - (b.metaSortKey ?? 0));
    const build = (parentId: string): CollectionNode[] =>
      order(children.get(parentId) ?? []).flatMap((r): CollectionNode[] => {
        if (r._type === 'request_group') return [insomniaFolder(r, build(r._id), ctx)];
        if (r._type === 'request') return [insomniaRequest(r, ctx)];
        return [];
      });
    // design documents (OpenAPI the user wrote in Insomnia) are kept in specs/
    for (const s of res.filter((r) => r._type === 'api_spec' && String(r.contents ?? '').trim())) ctx.specs.push({ name: String(s.fileName ?? s.name ?? 'Design document'), text: String(s.contents) });
    for (const kind of ['unit_test_suite', 'cookie_jar', 'mock_route'] as const) {
      const n = res.filter((r) => r._type === kind && (kind !== 'cookie_jar' || (r.cookies ?? []).length)).length;
      if (n) findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [], message: `${n} Insomnia ${{ unit_test_suite: 'unit test suite', cookie_jar: 'cookie jar', mock_route: 'mock route' }[kind]}${n > 1 ? 's were' : ' was'} not imported` });
    }
    const workspaces = res.filter((r) => r._type === 'workspace');
    const name = workspaces.length === 1 ? workspaces[0].name : 'Insomnia import';
    const items = workspaces.length === 1 ? build(workspaces[0]._id) : workspaces.length ? workspaces.map((w) => ({ kind: 'folder', id: shortId('fld-'), name: w.name, items: build(w._id) }) as CollectionFolder) : build(res.find((r) => r._type === 'request' || r._type === 'request_group')?.parentId);
    const base = res.find((r) => r._type === 'environment' && workspaces.some((w) => w._id === r.parentId)) ?? res.find((r) => r._type === 'environment' && !res.some((p) => p._id === r.parentId && p._type === 'environment'));
    const subs = base ? res.filter((r) => r._type === 'environment' && r.parentId === base._id) : [];
    collection = collectionOf(name, items, { description: workspaces[0]?.description || undefined });
    environments = insomniaEnvironments(name, base, subs);
    const saved = insomniaSavedItems(res);
    if (saved) {
      ctx.saved.grpc.push(...(saved.grpc ?? []));
      ctx.saved.websocket.push(...(saved.websocket ?? []));
    }
  }
  // template tags first (they add pre-request and post-response lines in tp.*), then the pipeline converts the scripts
  findings.notes(mapInsomniaTemplateTags(ctx.requests, ctx.folders, environments));
  doc.collections.push(collection);
  doc.environments = environments;
  if (ctx.saved.grpc.length || ctx.saved.websocket.length) doc.savedItems = { ...(ctx.saved.grpc.length ? { grpc: ctx.saved.grpc } : {}), ...(ctx.saved.websocket.length ? { websocket: ctx.saved.websocket } : {}) };
  if (ctx.specs.length) {
    const s = ctx.specs[0]!;
    doc.specFile = { path: `specs/${slugify(s.name) || 'design-document'}.openapi.${s.text.trimStart().startsWith('{') ? 'json' : 'yaml'}`, text: s.text };
    if (ctx.specs.length > 1) findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [], message: `${ctx.specs.length - 1} more Insomnia design document${ctx.specs.length > 2 ? 's were' : ' was'} not imported (only the first is kept in specs/)` });
  }
  doc.findings.push(...findings.list);
  return doc;
}

/**
 * An Insomnia v4 / v5 export. `insomnia.*` scripts become `tp.*`, or stay `pm.*` with `scripts: 'keep'`; both run.
 * `notes` lists everything that did not map one to one, naming the item.
 */
export function importInsomnia(
  text: string,
  opts: { scripts?: ImportScriptsMode } = {},
): { collection: Collection; environments: Environment[]; savedItems?: SavedItems; scripts: ImportScriptsSummary; notes: string[] } {
  const doc = finishDocument(parseInsomnia(text), { scripts: opts.scripts });
  return {
    collection: doc.collections[0]!,
    environments: doc.environments,
    ...(doc.savedItems ? { savedItems: doc.savedItems as SavedItems } : {}),
    scripts: doc.scripts ?? { converted: 0, unchanged: [] },
    notes: doc.findings.filter((f) => !f.reportOnly).map((f) => f.message),
  };
}
