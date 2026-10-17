import { parseYaml } from '../util/lazy-yaml.js';
import type { AuthConfig, BodyConfig, CheckConfig, Collection, CollectionFolder, CollectionNode, Environment, EnvironmentVariable, KeyValue, LibraryItem, SavedGraphQLRequest, SavedHttpRequest } from '../model/types.js';
import { SCHEMA_VERSION } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';
import { bruFilesToBrunoExport, looksLikeBru } from './bru.js';
import { brunoAssertionScript, brunoToTp } from '../scripts/bruno.js';
import { importForeignScriptsToTp, importScriptsToTp, type ImportScriptsMode, type ImportScriptsSummary } from './import-scripts.js';
import { mapForeignAuth, type ForeignTool } from './foreign-auth.js';
import { normalizeTemplate } from './templates.js';
import { mapInsomniaTemplateTags, type InsomniaImported } from './insomnia-tags.js';
import { parseDotenv } from './dotenv.js';

export { normalizeTemplate } from './templates.js';

/**
 * Importers for other API clients' exports: Insomnia (v4 JSON export, v5 YAML), Bruno (collection
 * export JSON, folder) and Hoppscotch (collection JSON). Requests, folders, bodies, auth, headers, parameters,
 * variables, environments and scripts come over (Insomnia's and Bruno's script APIs as tp.*; Hoppscotch's as
 * comments); whatever does not map is listed in the import's notes, naming the item.
 */

type Any = Record<string, any>;

/** The auth of an imported item through the shared mapping layer: its notes are collected, a placeholder header goes to `headers`. */
function authInto(tool: ForeignTool, raw: unknown, where: string, notes: string[], headers?: KeyValue[]): AuthConfig | undefined {
  const a = mapForeignAuth(tool, raw, where);
  notes.push(...a.notes);
  headers?.push(...a.headers);
  return a.auth;
}

/** Notes for scripts that call an API TestPion doesn't have (marked `// TODO(import)` in the script). */
const scriptWarningNotes = (s: ImportScriptsSummary): string[] => (s.warnings ?? []).map((w) => `${w.where}: ${w.api} has no TestPion equivalent yet (marked TODO(import) in the script)`);

const collectionOf = (name: string, items: CollectionNode[], extra: Partial<Collection> = {}): Collection => ({
  schemaVersion: SCHEMA_VERSION,
  id: `${slugify(name) || 'import'}-${shortId().slice(-4)}`,
  name,
  version: 0,
  variables: [],
  items,
  updatedAt: new Date().toISOString(),
  ...extra,
});

/** Nested variable objects become dotted keys: `{ api: { url } }` → `api.url`. */
function flattenVars(data: unknown, prefix = ''): KeyValue[] {
  if (!data || typeof data !== 'object') return [];
  return Object.entries(data as Any).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? flattenVars(v, `${prefix}${k}.`) : [{ key: `${prefix}${k}`, value: typeof v === 'string' ? normalizeTemplate(v) : JSON.stringify(v), enabled: true }],
  );
}

const kv = (list: unknown, name = 'name', enabled = (x: Any) => !x.disabled): KeyValue[] =>
  (Array.isArray(list) ? list : []).filter((x: Any) => x && x[name]).map((x: Any) => ({ key: normalizeTemplate(x[name]), value: normalizeTemplate(x.value ?? ''), enabled: enabled(x) }));

/** Another tool's script, kept as comments (its API is not TestPion's `pm.*` / `tp.*`). */
function commented(tool: string, script: unknown): string | undefined {
  const s = String(script ?? '').trim();
  if (!s) return undefined;
  return [`// ${tool} script (not converted: it uses ${tool}'s own script API). Rewrite it with pm.* / tp.* to run it.`, ...s.split('\n').map((l) => `// ${l}`)].join('\n');
}

/** `insomnia.*` APIs TestPion has nothing for: the line gets a `// TODO(import)` above it (it would fail when run). */
const INSOMNIA_MISSING = /\binsomnia\.(parentFolders|request\.auth\.update|request\.proxy|request\.certificate)\b/;

/**
 * An Insomnia script, kept runnable: Insomnia's scripting API (`insomnia.test`, `insomnia.expect`,
 * `insomnia.environment`, `insomnia.response` …) follows Postman's, so `insomnia.` becomes `pm.`
 * (and then `tp.`, TestPion's own name, when the import converts scripts: the default, see `importInsomnia`).
 * A plain JavaScript script (no `insomnia.`) stays as it is. The base environment is merged into every imported
 * environment, so `insomnia.baseEnvironment` / `insomnia.collectionVariables` read the environment. `notes` gets a
 * line for each change a user should know about.
 */
export function insomniaScript(script: unknown, alias: 'pm' | 'tp' = 'pm', notes?: string[], where = 'A request'): string | undefined {
  const s = String(script ?? '').trim();
  if (!s) return undefined;
  // (comments don't count: a plain script that mentions insomnia.* in a comment stays as it is)
  if (!/\binsomnia\./.test(s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''))) return s;
  let code = s;
  if (/\binsomnia\.(baseEnvironment|collectionVariables)\./.test(code)) {
    code = code.replace(/\binsomnia\.(baseEnvironment|collectionVariables)\./g, 'insomnia.environment.');
    notes?.push(`"${where}": insomnia.baseEnvironment / collectionVariables became ${alias}.environment (the base environment is merged into each imported environment)`);
  }
  const lines = code.split('\n').flatMap((l) => {
    const m = INSOMNIA_MISSING.exec(l);
    if (!m) return [l];
    notes?.push(`"${where}": insomnia.${m[1]} has no TestPion equivalent (marked TODO(import) in the script)`);
    return [`${/^\s*/.exec(l)![0]}// TODO(import): Insomnia's ${m[1]} has no TestPion equivalent: rewrite this line`, l];
  });
  return `// Insomnia script: insomnia.* runs as ${alias}.* (the same API)\n${lines.join('\n').replace(/\binsomnia\./g, 'pm.')}`;
}

function bodyFromMime(mime: string, text: string | undefined, params: Any[] | undefined): BodyConfig | undefined {
  const m = (mime ?? '').toLowerCase();
  if (m.includes('x-www-form-urlencoded')) return { type: 'form-urlencoded', fields: kv(params) };
  if (m.includes('multipart/form-data'))
    return { type: 'multipart', fields: (params ?? []).filter((p) => p.name).map((p) => ({ key: p.name, value: p.type === 'file' ? p.fileName ?? '' : normalizeTemplate(p.value ?? ''), kind: p.type === 'file' ? 'file' : 'text', enabled: !p.disabled })) };
  if (text === undefined || text === '') return undefined;
  const content = normalizeTemplate(text);
  return { type: m.includes('json') ? 'json' : m.includes('xml') ? 'xml' : m.includes('html') ? 'html' : 'text', content };
}

/* ------------------------------------------------------------------ Insomnia */

/** What an Insomnia import collects while it converts: notes, and every request with its Insomnia id (for `{% response %}` chaining). */
interface InsomniaCtx {
  alias: 'pm' | 'tp';
  notes: string[];
  requests: InsomniaImported[];
  folders: CollectionFolder[];
}

/** An Insomnia folder's headers (Insomnia 9+), sent with every request inside: TestPion folders have no headers yet (0.56), so they are flattened. */
function folderHeaders(f: Any, ctx: InsomniaCtx): KeyValue[] {
  const headers = kv(f.headers);
  if (headers.length) ctx.notes.push(`Folder "${f.name ?? 'Folder'}": its ${headers.length === 1 ? 'header was' : `${headers.length} headers were`} added to each request inside (TestPion folders have no headers yet)`);
  return headers;
}

/** v4 `preRequestScript` / `afterResponseScript`; v5 `scripts.preRequest` / `scripts.afterResponse`. */
const scriptsOf = (x: Any, ctx: InsomniaCtx, where: string) => ({
  pre: insomniaScript(x.scripts?.preRequest ?? x.preRequestScript, ctx.alias, ctx.notes, where),
  post: insomniaScript(x.scripts?.afterResponse ?? x.afterResponseScript, ctx.alias, ctx.notes, where),
});

/** A folder (v4 request_group, v5 item with children): auth, variables, scripts. */
function insomniaFolder(f: Any, items: CollectionNode[], ctx: InsomniaCtx): CollectionFolder {
  const name = f.name ?? 'Folder';
  const variables = flattenVars(f.environment);
  const auth = authInto('insomnia', f.authentication, name, ctx.notes);
  const s = scriptsOf(f, ctx, name);
  const folder: CollectionFolder = { kind: 'folder', id: shortId('fld-'), name, items, ...(auth ? { auth } : {}), ...(variables.length ? { variables } : {}), ...(s.pre ? { preRequestScript: s.pre } : {}), ...(s.post ? { testScript: s.post } : {}) };
  ctx.folders.push(folder);
  return folder;
}

function insomniaRequest(r: Any, ctx: InsomniaCtx, inherited: KeyValue[] = []): SavedHttpRequest | SavedGraphQLRequest {
  const url = normalizeTemplate(r.url);
  const name = r.name || url;
  const own = kv(r.headers);
  const names = new Set(own.map((h) => h.key.toLowerCase()));
  // folder headers come after the request's own (the request's win)
  const headers = [...own, ...inherited.filter((h) => !names.has(h.key.toLowerCase()))];
  const auth = authInto('insomnia', r.authentication, name, ctx.notes, headers) ?? { type: 'inherit' as const };
  const mime = r.body?.mimeType ?? '';
  const s = scriptsOf(r, ctx, name);
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
    // v4 settingFollowRedirects: 'off'; v5 settings.followRedirects: 'off'
    const noRedirects = r.settingFollowRedirects === 'off' || r.settings?.followRedirects === 'off';
    if (r.body?.fileName) ctx.notes.push(`"${name}": the body is the file ${r.body.fileName}: choose it again (binary body)`);
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
        ...(noRedirects ? { settings: { followRedirects: false } } : {}),
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

/**
 * Insomnia 4 exports also hold gRPC requests (with their .proto files) and WebSocket requests: they become
 * the imported collection's gRPC calls and connections (library items, see `savedItems` in workspace-import).
 */
function insomniaSavedItems(res: Any[]): { grpc?: LibraryItem[]; websocket?: LibraryItem[] } | undefined {
  const byId = new Map(res.map((r) => [r._id, r]));
  const folderOf = (parentId: string): string | undefined => {
    const names: string[] = [];
    for (let p = byId.get(parentId); p && p._type === 'request_group'; p = byId.get(p.parentId)) names.unshift(String(p.name ?? 'Folder'));
    return names.join(' / ') || undefined;
  };
  const kv = (list: Any[] | undefined) => (list ?? []).filter((x: Any) => x?.name).map((x: Any) => ({ key: String(x.name), value: normalizeTemplate(String(x.value ?? '')), enabled: !x.disabled }));
  const protos = new Map(res.filter((r) => r._type === 'proto_file' && typeof r.protoText === 'string').map((r) => [r._id, { name: /\.proto$/.test(String(r.name ?? '')) ? String(r.name) : `${r.name || 'service'}.proto`, text: String(r.protoText) }]));
  const grpc: LibraryItem[] = res
    .filter((r) => r._type === 'grpc_request')
    .map((r) => {
      const url = normalizeTemplate(String(r.url ?? ''));
      const proto = protos.get(r.protoFileId);
      return {
        id: shortId('lib-'),
        name: String(r.name || 'gRPC call'),
        folder: folderOf(r.parentId),
        data: { target: url.replace(/^grpcs?:\/\//, ''), method: String(r.protoMethodName ?? '').replace(/^\//, ''), message: String(r.body?.text ?? '{}'), metadata: kv(r.metadata), tls: /^grpcs:/i.test(url), protoFiles: proto ? [proto] : [] },
      };
    });
  const websocket: LibraryItem[] = res
    .filter((r) => r._type === 'websocket_request')
    .map((r) => {
      const payload = res.find((p) => p._type === 'websocket_payload' && p.parentId === r._id);
      return { id: shortId('lib-'), name: String(r.name || 'WebSocket'), folder: folderOf(r.parentId), data: { url: normalizeTemplate(String(r.url ?? '')), mode: 'websocket', message: String(payload?.value ?? ''), headers: kv(r.headers), protocols: '' } };
    });
  return grpc.length || websocket.length ? { ...(grpc.length ? { grpc } : {}), ...(websocket.length ? { websocket } : {}) } : undefined;
}

/** A v5 item that is not an HTTP request (gRPC, WebSocket, Socket.IO, MCP client): not imported from v5 yet, with a note. */
function v5Other(it: Any): string | undefined {
  if (it.protoFileId !== undefined || it.protoMethodName !== undefined || it.reflectionApi !== undefined) return 'gRPC request';
  if (it.eventListeners !== undefined) return 'Socket.IO request';
  if (it.transportType !== undefined) return 'MCP client';
  if (/^wss?:\/\//i.test(String(it.url ?? '')) && !it.method) return 'WebSocket request';
  return undefined;
}

/**
 * An Insomnia v4 / v5 export. `insomnia.*` scripts become `tp.*` (via `pm.*`, then the same conversion
 * as a Postman import), or stay `pm.*` with `scripts: 'keep'`; both run. Template tags are mapped (insomnia-tags.ts).
 * `notes` lists everything that did not map one to one, naming the item.
 */
export function importInsomnia(
  text: string,
  opts: { scripts?: ImportScriptsMode } = {},
): { collection: Collection; environments: Environment[]; savedItems?: { grpc?: LibraryItem[]; websocket?: LibraryItem[] }; scripts: ImportScriptsSummary; notes: string[] } {
  const ctx: InsomniaCtx = { alias: opts.scripts === 'keep' ? 'pm' : 'tp', notes: [], requests: [], folders: [] };
  const t = text.trim();
  const d: Any = t.startsWith('{') ? JSON.parse(t) : parseYaml(t);
  const finish = (collection: Collection, environments: Environment[], savedItems?: { grpc?: LibraryItem[]; websocket?: LibraryItem[] }) => {
    // template tags first (they add pre-request and post-response lines in tp.*), then the scripts' pm.* → tp.*
    ctx.notes.push(...mapInsomniaTemplateTags(ctx.requests, ctx.folders, environments));
    const r = importScriptsToTp(collection, opts.scripts);
    return { collection: r.collection, environments, ...(savedItems ? { savedItems } : {}), scripts: r.scripts, notes: ctx.notes };
  };
  if (String(d.type ?? '').startsWith('collection.insomnia.rest/5')) {
    // Insomnia 5 YAML: a tree under `collection`, environments with sub-environments
    const convert = (items: Any[], inherited: KeyValue[]): CollectionNode[] =>
      (items ?? []).flatMap((it: Any): CollectionNode[] => {
        if (Array.isArray(it.children)) {
          const headers = folderHeaders(it, ctx);
          const names = new Set(headers.map((h) => h.key.toLowerCase()));
          return [insomniaFolder(it, convert(it.children, [...headers, ...inherited.filter((h) => !names.has(h.key.toLowerCase()))]), ctx)];
        }
        const other = v5Other(it);
        if (other) {
          ctx.notes.push(`"${it.name ?? 'Item'}": a ${other} in an Insomnia 5 file is not imported yet (export it from Insomnia 4 format, or recreate it)`);
          return [];
        }
        return [insomniaRequest(it, ctx, inherited)];
      });
    const name = d.name ?? 'Insomnia import';
    const env = d.environments ?? {};
    const collection = collectionOf(name, convert(d.collection ?? [], []), { description: d.meta?.description });
    return finish(collection, insomniaEnvironments(name, env, env.subEnvironments ?? []));
  }
  // Insomnia 4 export: flat resources linked by parentId
  const res: Any[] = d.resources ?? [];
  const children = new Map<string, Any[]>();
  for (const r of res) {
    const list = children.get(r.parentId);
    if (list) list.push(r);
    else children.set(r.parentId, [r]);
  }
  const order = (list: Any[]) => [...list].sort((a, b) => (a.metaSortKey ?? 0) - (b.metaSortKey ?? 0));
  const build = (parentId: string, inherited: KeyValue[]): CollectionNode[] =>
    order(children.get(parentId) ?? []).flatMap((r): CollectionNode[] => {
      if (r._type === 'request_group') {
        const headers = folderHeaders(r, ctx);
        const names = new Set(headers.map((h) => h.key.toLowerCase()));
        return [insomniaFolder(r, build(r._id, [...headers, ...inherited.filter((h) => !names.has(h.key.toLowerCase()))]), ctx)];
      }
      if (r._type === 'request') return [insomniaRequest(r, ctx, inherited)];
      return [];
    });
  for (const kind of ['api_spec', 'unit_test_suite', 'cookie_jar', 'mock_route'] as const) {
    const n = res.filter((r) => r._type === kind && (kind !== 'api_spec' || String(r.contents ?? '').trim()) && (kind !== 'cookie_jar' || (r.cookies ?? []).length)).length;
    if (n) ctx.notes.push(`${n} Insomnia ${{ api_spec: 'design document (API spec)', unit_test_suite: 'unit test suite', cookie_jar: 'cookie jar', mock_route: 'mock route' }[kind]}${n > 1 ? 's were' : ' was'} not imported`);
  }
  const workspaces = res.filter((r) => r._type === 'workspace');
  const name = workspaces.length === 1 ? workspaces[0].name : 'Insomnia import';
  const items = workspaces.length === 1 ? build(workspaces[0]._id, []) : workspaces.length ? workspaces.map((w) => ({ kind: 'folder', id: shortId('fld-'), name: w.name, items: build(w._id, []) }) as CollectionFolder) : build(res.find((r) => r._type === 'request' || r._type === 'request_group')?.parentId, []);
  const base = res.find((r) => r._type === 'environment' && workspaces.some((w) => w._id === r.parentId)) ?? res.find((r) => r._type === 'environment' && !res.some((p) => p._id === r.parentId && p._type === 'environment'));
  const subs = base ? res.filter((r) => r._type === 'environment' && r.parentId === base._id) : [];
  return finish(collectionOf(name, items, { description: workspaces[0]?.description || undefined }), insomniaEnvironments(name, base, subs), insomniaSavedItems(res));
}

/* ------------------------------------------------------------------ Bruno */

/** Bruno assertions like `res.status: eq 200` become status checks; others stay in the comments. */
function brunoAssertions(list: Any[] | undefined): CheckConfig[] | undefined {
  const out: CheckConfig[] = [];
  for (const a of list ?? []) {
    if (a.enabled === false) continue;
    const m = /^eq\s+(\d{3})$/.exec(String(a.value ?? '').trim());
    if (a.name === 'res.status' && m) out.push({ type: 'status', expected: Number(m[1]) });
  }
  return out.length ? out : undefined;
}

/** The first line of every imported Bruno script: it also loads the shim that runs Bruno's req / res / test (scripts/bruno.ts). */
const BRUNO_HEADER = "// Bruno script: bru.* became tp.*; req, res and test run as in Bruno";

/** A Bruno script, kept runnable: its `bru.*` calls are rewritten to `tp.*` afterwards (brunoToTp), req / res run through the shim. */
function brunoScript(...parts: Array<string | undefined>): string | undefined {
  const s = parts.map((p) => String(p ?? '').trim()).filter(Boolean).join('\n\n');
  return s ? `${BRUNO_HEADER}\n${s}` : undefined;
}

/** A request's vars:pre-request (request variables) and vars:post-response (values taken from the response). */
function brunoVars(vars: Any | undefined): { pre?: string; post?: string } {
  const on = (l: Any[] | undefined) => (l ?? []).filter((v: Any) => v?.name && v.enabled !== false);
  const pre = on(vars?.req).map((v: Any) => `tp.variables.set(${JSON.stringify(v.name)}, ${JSON.stringify(normalizeTemplate(v.value ?? ''))});`);
  // post-response values are expressions over res, e.g. res.body.token (runtime variables: they last for the run, like Bruno's)
  const post = on(vars?.res).map((v: Any) => `tp.collectionVariables.set(${JSON.stringify(v.name)}, ${String(v.value ?? 'undefined')});`);
  return { pre: pre.join('\n') || undefined, post: post.join('\n') || undefined };
}

/** Folder and collection settings (Bruno's folder.bru / collection.bru "root"): auth, headers, variables, scripts. */
function brunoRoot(root: Any | undefined, where: string, notes: string[]): Partial<CollectionFolder> {
  const r = root?.request;
  if (!r) return {};
  const pre = brunoScript(r.script?.req);
  const post = brunoScript(r.script?.res, r.tests);
  const variables = kv(r.vars?.req, 'name', (x) => x.enabled !== false);
  const auth = authInto('bruno', r.auth, where, notes);
  return {
    ...(auth ? { auth } : {}),
    ...(variables.length ? { variables } : {}),
    ...(pre ? { preRequestScript: pre } : {}),
    ...(post ? { testScript: post } : {}),
  };
}

/**
 * The collection's .env file (read by readBrunoFolder / the app's folder picker) and every `{{process.env.X}}` /
 * `bru.getProcessEnv('X')`: the values become secret variables (values for the secret store, never workspace files)
 * of a "Bruno .env" environment and of each imported environment (whichever is active, `{{X}}` resolves).
 * Names without a value are listed as values needed.
 */
function brunoDotenv(d: Any, text: string, environments: Environment[], notes: string[]): Record<string, Record<string, string>> | undefined {
  const values = new Map(typeof d.dotenv === 'string' ? parseDotenv(d.dotenv).map((e) => [e.key, e.value] as const) : []);
  const used = new Set<string>();
  for (const m of text.matchAll(/process\.env\.([A-Za-z_][\w.-]*)|getProcessEnv\(\s*\\?["']([A-Za-z_][\w.-]*)\\?["']/g)) used.add(m[1] ?? m[2]!);
  const names = [...new Set([...values.keys(), ...used])];
  if (!names.length) return undefined;
  const env: Environment = { id: 'bruno-env', name: 'Bruno .env', variables: [] };
  const secretValues: Record<string, Record<string, string>> = {};
  for (const e of [env, ...environments]) {
    const has = new Set(e.variables.map((v) => v.key));
    const added = names.filter((n) => !has.has(n));
    e.variables.push(...added.map((key): EnvironmentVariable => ({ key, value: '', secret: true, enabled: true })));
    const set = Object.fromEntries(added.filter((n) => values.get(n)).map((n) => [n, values.get(n)!]));
    if (Object.keys(set).length) secretValues[e.id] = set;
  }
  environments.push(env);
  const stored = names.filter((n) => values.get(n));
  if (stored.length) notes.push(`.env: ${stored.length} value${stored.length > 1 ? 's' : ''} (${stored.join(', ')}) became secret variables of the "Bruno .env" environment and of each imported environment ({{process.env.X}} is now {{X}}); the values go to the secret store, never into workspace files`);
  const missing = names.filter((n) => !values.get(n));
  if (missing.length) notes.push(`Values needed: ${missing.join(', ')} (${typeof d.dotenv === 'string' ? 'used as process.env but not set in the .env file' : "used as process.env; import the collection folder with its .env file, or set them"}) in the "Bruno .env" environment`);
  return Object.keys(secretValues).length ? secretValues : undefined;
}

export function importBruno(text: string, opts: { scripts?: ImportScriptsMode } = {}): { collection: Collection; environments: Environment[]; scripts: ImportScriptsSummary; notes: string[]; secretValues?: Record<string, Record<string, string>> } {
  // a single .bru request file, or a Bruno JSON export
  const d: Any = looksLikeBru(text) ? bruFilesToBrunoExport([{ path: 'request.bru', text }], 'Bruno import') : JSON.parse(text);
  const notes: string[] = [];
  const withHeaders = (headers: KeyValue[], root: Any[]): KeyValue[] => {
    // folder and collection headers are sent with every request inside (the request's own win)
    const names = new Set(headers.map((h) => h.key.toLowerCase()));
    const extra = root.flatMap((r) => kv(r?.request?.headers, 'name', (x) => x.enabled !== false)).filter((h) => !names.has(h.key.toLowerCase()) && (names.add(h.key.toLowerCase()), true));
    return [...headers, ...extra];
  };
  const convert = (items: Any[], roots: Any[]): CollectionNode[] =>
    [...(items ?? [])]
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .flatMap((it: Any): CollectionNode[] => {
        if (it.type === 'folder') return [{ kind: 'folder', id: shortId('fld-'), name: it.name ?? 'Folder', items: convert(it.items, [it.root, ...roots]), ...brunoRoot(it.root, it.name ?? 'Folder', notes) } as CollectionFolder];
        const r = it.request ?? {};
        const url = normalizeTemplate(r.url);
        const name = it.name || url;
        if (it.type !== 'http-request' && it.type !== 'graphql-request') {
          notes.push(`"${name}": a Bruno ${String(it.type ?? 'item').replace(/-request$/, '')} request is not imported yet`);
          return [];
        }
        const headers = withHeaders(kv(r.headers, 'name', (x) => x.enabled !== false), roots);
        const auth = authInto('bruno', r.auth, name, notes, headers) ?? { type: 'inherit' as const };
        if (it.type === 'graphql-request') {
          const gPre = brunoScript(brunoVars(r.vars).pre, r.script?.req);
          const gPost = brunoScript(brunoVars(r.vars).post, r.script?.res, brunoAssertionScript(r.assertions ?? []), r.tests);
          let variables: Any | undefined;
          try {
            variables = r.body?.graphql?.variables ? JSON.parse(r.body.graphql.variables) : undefined;
          } catch {
            variables = undefined;
          }
          return [{ kind: 'graphql', id: shortId('gql-'), name, request: { endpoint: url, query: normalizeTemplate(r.body?.graphql?.query ?? ''), variables, headers, auth }, ...(gPre ? { preRequestScript: gPre } : {}), ...(gPost ? { testScript: gPost } : {}) }];
        }
        const b = r.body ?? {};
        const body: BodyConfig | undefined =
          b.mode === 'json' ? { type: 'json', content: normalizeTemplate(b.json ?? '') }
          : b.mode === 'xml' ? { type: 'xml', content: normalizeTemplate(b.xml ?? '') }
          : b.mode === 'text' ? { type: 'text', content: normalizeTemplate(b.text ?? '') }
          : b.mode === 'formUrlEncoded' ? { type: 'form-urlencoded', fields: kv(b.formUrlEncoded, 'name', (x) => x.enabled !== false) }
          : b.mode === 'multipartForm' ? { type: 'multipart', fields: (b.multipartForm ?? []).filter((f: Any) => f.name).map((f: Any) => ({ key: f.name, value: f.type === 'file' ? [].concat(f.value ?? []).join(',') : normalizeTemplate(f.value ?? ''), kind: f.type === 'file' ? 'file' : 'text', enabled: f.enabled !== false })) }
          : undefined;
        if (b.mode && b.mode !== 'none' && !body) notes.push(`"${name}": the Bruno body type "${b.mode}" is not imported yet`);
        const params = (r.params ?? []) as Any[];
        const vars = brunoVars(r.vars);
        // assertions other than a plain status check become tests
        const asserted = (r.assertions ?? []).filter((a: Any) => !(a.name === 'res.status' && /^eq\s+\d{3}$/.test(String(a.value ?? '').trim())));
        const pre = brunoScript(vars.pre, r.script?.req);
        const post = brunoScript(vars.post, r.script?.res, brunoAssertionScript(asserted), r.tests);
        const pathVariables = kv(params.filter((p) => p.type === 'path'), 'name', (x) => x.enabled !== false);
        return [
          {
            kind: 'http',
            id: shortId('req-'),
            name,
            ...(r.docs ? { description: String(r.docs) } : {}),
            request: {
              method: String(r.method ?? 'GET').toUpperCase(),
              // query parameters are listed separately, so the URL keeps only its path
              url: params.some((p) => p.type !== 'path') ? url.split('?')[0]! : url,
              params: kv(params.filter((p) => p.type !== 'path'), 'name', (x) => x.enabled !== false),
              ...(pathVariables.length ? { pathVariables } : {}),
              headers,
              body,
              auth,
            },
            ...(pre ? { preRequestScript: pre } : {}),
            ...(post ? { testScript: post } : {}),
            ...(brunoAssertions(r.assertions) ? { assertions: brunoAssertions(r.assertions) } : {}),
          },
        ];
      });
  const environments: Environment[] = (d.environments ?? []).map((e: Any) => ({
    id: slugify(e.name ?? 'env') || 'env',
    name: e.name ?? 'Environment',
    // secret values stay out of workspace files: they become empty secret variables
    variables: (e.variables ?? []).filter((v: Any) => v.name).map((v: Any) => ({ key: v.name, value: v.secret ? '' : normalizeTemplate(v.value ?? ''), enabled: v.enabled !== false, ...(v.secret ? { secret: true } : {}) })),
  }));
  for (const e of environments) {
    const secrets = e.variables.filter((v) => v.secret).map((v) => v.key);
    if (secrets.length) notes.push(`Values needed: ${secrets.join(', ')} in the "${e.name}" environment (Bruno keeps secret values in the app, not in the export)`);
  }
  const collectionName = d.name ?? 'Bruno import';
  const root = brunoRoot(d.root, collectionName, notes);
  const collection = collectionOf(collectionName, convert(d.items, [d.root]), {
    variables: root.variables ?? [],
    ...(root.auth ? { auth: root.auth } : {}),
    ...(root.preRequestScript ? { preRequestScript: root.preRequestScript } : {}),
    ...(root.testScript ? { testScript: root.testScript } : {}),
    ...(d.root?.docs ? { description: String(d.root.docs) } : {}),
  });
  const secretValues = brunoDotenv(d, text, environments, notes);
  // bru.* → tp.* in every script (the shim still runs req / res / test), then the usual pm.* → tp.* pass
  const r = importForeignScriptsToTp(collection, (code) => (code.startsWith(BRUNO_HEADER) ? brunoToTp(code) : { code, changed: 0, warnings: [] }), opts.scripts);
  notes.push(...scriptWarningNotes(r.scripts));
  return { collection: r.collection, environments, scripts: r.scripts, notes, ...(secretValues ? { secretValues } : {}) };
}

/* ------------------------------------------------------------------ Hoppscotch */

export function importHoppscotch(text: string): { collection: Collection; notes: string[] } {
  const d: Any = JSON.parse(text);
  const roots: Any[] = Array.isArray(d) ? d : [d];
  const notes: string[] = [];
  let commentedScripts = 0;
  const request = (r: Any): SavedHttpRequest => {
    const ct = r.body?.contentType ?? '';
    const body = typeof r.body?.body === 'string' ? bodyFromMime(ct, r.body.body, undefined) : Array.isArray(r.body?.body) ? bodyFromMime(ct, undefined, r.body.body.map((f: Any) => ({ name: f.key, value: f.value, disabled: f.active === false, type: f.isFile ? 'file' : 'text' }))) : undefined;
    const pre = commented('Hoppscotch', r.preRequestScript);
    const post = commented('Hoppscotch', r.testScript);
    if (pre || post) commentedScripts++;
    const headers = kv(r.headers, 'key', (x) => x.active !== false);
    const auth = authInto('hoppscotch', r.auth, r.name || r.endpoint, notes, headers) ?? { type: 'inherit' as const };
    return {
      kind: 'http',
      id: shortId('req-'),
      name: r.name || r.endpoint,
      request: {
        method: String(r.method ?? 'GET').toUpperCase(),
        url: normalizeTemplate(r.endpoint),
        params: kv(r.params, 'key', (x) => x.active !== false),
        headers,
        body,
        auth,
      },
      ...(pre ? { preRequestScript: pre } : {}),
      ...(post ? { testScript: post } : {}),
    };
  };
  const folder = (c: Any): CollectionFolder => {
    const auth = authInto('hoppscotch', c.auth, c.name ?? 'Folder', notes);
    return { kind: 'folder', id: shortId('fld-'), name: c.name ?? 'Folder', items: [...(c.folders ?? []).map(folder), ...(c.requests ?? []).map(request)], ...(auth ? { auth } : {}) };
  };
  let collection: Collection;
  if (roots.length === 1) {
    const c = roots[0]!;
    const auth = authInto('hoppscotch', c.auth, c.name ?? 'Hoppscotch import', notes);
    collection = collectionOf(c.name ?? 'Hoppscotch import', [...(c.folders ?? []).map(folder), ...(c.requests ?? []).map(request)], { ...(auth ? { auth } : {}) });
  } else collection = collectionOf('Hoppscotch import', roots.map(folder));
  if (commentedScripts) notes.push(`${commentedScripts} request${commentedScripts > 1 ? 's have' : ' has'} Hoppscotch scripts (pw.*): kept as comments, rewrite them with tp.* to run them`);
  return { collection, notes };
}

/* ------------------------------------------------------------------ detection */

export function detectOtherTool(d: unknown): 'insomnia' | 'bruno' | 'hoppscotch' | undefined {
  if (!d || typeof d !== 'object') return undefined;
  const o = d as Any;
  if (o._type === 'export' && Array.isArray(o.resources)) return 'insomnia';
  if (String(o.type ?? '').startsWith('collection.insomnia.rest/')) return 'insomnia';
  if (Array.isArray(o.items) && (o.brunoConfig || o.items.some((i: Any) => /^(http|graphql)-request$|^folder$/.test(i?.type ?? '')))) return 'bruno';
  const hopp = (c: Any) => c && typeof c === 'object' && Array.isArray(c.folders) && Array.isArray(c.requests);
  if (hopp(o) || (Array.isArray(o) && o.length > 0 && o.every(hopp))) return 'hoppscotch';
  return undefined;
}
