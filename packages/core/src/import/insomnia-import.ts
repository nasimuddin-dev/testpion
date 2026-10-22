import { parseYamlShared } from '../util/lazy-yaml.js';
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
  /** Insomnia ids by node id (re-import matches on them). */
  sourceIds: Record<string, string>;
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
  const sid = f._id ?? f.meta?.id;
  if (sid) (ctx.sourceIds[folder.id] = String(sid));
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
  if (id) ctx.sourceIds[node.id] = String(id);
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
  const payloadOf = new Map<unknown, unknown>();
  for (const p of res) if (p._type === 'websocket_payload' && !payloadOf.has(p.parentId)) payloadOf.set(p.parentId, p.value);
  const websocket = res.filter((r) => r._type === 'websocket_request').map((r) => wsItem(r, folderOf(r.parentId), payloadOf.get(r._id) as never));
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

/** Insomnia's expiry (an ISO string, a millisecond number or empty) as an ISO string. */
const cookieExpiry = (e: unknown): string | undefined => {
  if (e === null || e === undefined || e === '') return undefined;
  const d = new Date(typeof e === 'number' ? e : String(e));
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
};

/** The cookies of an Insomnia cookie jar (v4 `cookie_jar.cookies`, v5 `cookieJar.cookies`) as jar entries. */
function jarCookies(list: unknown): NonNullable<ImportDocument['cookies']> {
  const out: NonNullable<ImportDocument['cookies']> = [];
  for (const c of Array.isArray(list) ? list : []) {
    const a = c as Any;
    if (!a?.key || !a.domain) continue;
    const expires = cookieExpiry(a.expires);
    out.push({ name: String(a.key), value: String(a.value ?? ''), domain: String(a.domain), path: String(a.path ?? '/'), ...(expires ? { expires } : {}), ...(a.secure ? { secure: true } : {}), ...(a.httpOnly ? { httpOnly: true } : {}), ...(a.hostOnly ? { hostOnly: true } : {}) });
  }
  return out;
}

/**
 * Insomnia's unit tests (v4 `unit_test_suite` + `unit_test`, v5 `testSuites[].tests`) as TestPion tests of the request each
 * one sends: a `tp.test` appended to the request's test script. Insomnia's test code calls `insomnia.send()` and reads the
 * answer (`response.status`, `JSON.parse(response.data)`); here `send` answers the response the request just got, so the same
 * code runs after the request. A test with no request, or one the file does not have, is reported.
 */
function unitTests(tests: Array<{ suite: string; name: string; code: string; requestId?: string }>, requests: InsomniaImported[], findings: Findings): number {
  let added = 0;
  const byId = new Map(requests.filter((r) => r.id).map((r) => [r.id!, r.node]));
  for (const t of tests) {
    const node = t.requestId ? byId.get(t.requestId) : undefined;
    const label = `${t.suite ? `${t.suite}: ` : ''}${t.name}`;
    if (!node) {
      findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [], field: 'unit test', message: `The Insomnia unit test "${label}" was not imported: ${t.requestId ? 'its request is not in the file' : 'it sends no request of the collection'}` });
      continue;
    }
    const body = t.code
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n');
    const code = [
      `// Insomnia unit test "${label}": insomnia.send() answers the response of this request`,
      `tp.test(${JSON.stringify(label)}, async function () {`,
      `  const expect = tp.expect;`,
      `  const insomnia = { send: async () => ({ status: tp.response.code, statusMessage: tp.response.status, data: tp.response.text(), headers: tp.response.headers.toObject() }) };`,
      body,
      `});`,
    ].join('\n');
    node.testScript = [node.testScript, code].filter(Boolean).join('\n\n');
    added++;
  }
  return added;
}

/** Insomnia v4 / v5 → document. */
export function parseInsomnia(text: string): ImportDocument {
  const t = text.trim();
  const d: Any = t.startsWith('{') ? JSON.parse(t) : (parseYamlShared(t) as Any);
  const findings = new Findings();
  const v5 = String(d.type ?? '').startsWith('collection.insomnia.rest/5');
  const ctx: Ctx = { findings, requests: [], folders: [], saved: { grpc: [], websocket: [] }, specs: [], sourceIds: {} };
  const doc = newDocument('insomnia', text, { tool: 'Insomnia', version: v5 ? String(d.type).split('/')[1] : String(d.__export_format ?? 4), scriptTool: 'insomnia' });
  const pendingTests: Array<{ suite: string; name: string; code: string; requestId?: string }> = [];
  const cookies: NonNullable<ImportDocument['cookies']> = [];
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
    pendingTests.push(...(Array.isArray(d.testSuites) ? d.testSuites : []).flatMap((s: Any) => (Array.isArray(s?.tests) ? s.tests : []).map((t: Any) => ({ suite: String(s.name ?? ''), name: String(t.name ?? 'Test'), code: String(t.code ?? ''), requestId: t.requestId ? String(t.requestId) : undefined }))));
    cookies.push(...jarCookies(d.cookieJar?.cookies));
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
    for (const kind of ['mock_route'] as const) {
      const n = res.filter((r) => r._type === kind).length;
      if (n) findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [], message: `${n} Insomnia mock route${n > 1 ? 's were' : ' was'} not imported (TestPion's mock server serves the saved examples)` });
    }
    for (const jar of res.filter((r) => r._type === 'cookie_jar')) cookies.push(...jarCookies(jar.cookies));
    const suites = new Map(res.filter((r) => r._type === 'unit_test_suite').map((s) => [s._id, s]));
    for (const t of res.filter((r) => r._type === 'unit_test')) pendingTests.push({ suite: String(suites.get(t.parentId)?.name ?? ''), name: String(t.name ?? 'Test'), code: String(t.code ?? ''), requestId: t.requestId ? String(t.requestId) : undefined });
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
  if (pendingTests.length) {
    const n = unitTests(pendingTests, ctx.requests, findings);
    if (n) findings.add({ code: 'NOTE', severity: 'info', where: [], message: `${n} Insomnia unit test${n > 1 ? 's' : ''} became test${n > 1 ? 's' : ''} of the request${n > 1 ? 's' : ''} they send (tp.test in the request's test script)`, reportOnly: true });
  }
  if (cookies.length) doc.cookies = cookies;
  doc.collections.push(collection);
  if (Object.keys(ctx.sourceIds).length) doc.sourceIds = ctx.sourceIds;
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
