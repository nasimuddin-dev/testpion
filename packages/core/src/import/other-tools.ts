import { parseYaml } from '../util/lazy-yaml.js';
import type { AuthConfig, BodyConfig, CheckConfig, Collection, CollectionFolder, CollectionNode, Environment, KeyValue, LibraryItem, SavedGraphQLRequest, SavedHttpRequest } from '../model/types.js';
import { SCHEMA_VERSION } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';
import { bruFilesToBrunoExport, looksLikeBru } from './bru.js';
import { brunoAssertionScript } from '../scripts/bruno.js';
import { importScriptsToTp, type ImportScriptsMode, type ImportScriptsSummary } from './import-scripts.js';

/**
 * Importers for other API clients' exports: Insomnia (v4 JSON export, v5 YAML), Bruno (collection
 * export JSON) and Hoppscotch (collection JSON). Requests, folders, bodies, auth, headers, parameters,
 * variables and environments come over; each tool's own script API does not (scripts are kept as
 * comments so nothing is lost).
 */

type Any = Record<string, any>;

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

/** `{{ _.baseUrl }}`, `{{ baseUrl }}` (Insomnia) and `<<baseUrl>>` (Hoppscotch) → `{{baseUrl}}`. */
export function normalizeTemplate(s: unknown): string {
  return String(s ?? '')
    .replace(/\{\{\s*_\.([\w.-]+)\s*\}\}/g, '{{$1}}')
    .replace(/\{\{\s+([\w.$-]+)\s*\}\}|\{\{([\w.$-]+)\s+\}\}/g, (_, a, b) => `{{${a ?? b}}}`)
    .replace(/<<([\w.-]+)>>/g, '{{$1}}');
}

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

/**
 * An Insomnia script, kept runnable: Insomnia's scripting API (`insomnia.test`, `insomnia.expect`,
 * `insomnia.environment`, `insomnia.response` …) follows Postman's, so `insomnia.` becomes `pm.`
 * (and then `tp.`, TestPion's own name, when the import converts scripts: the default, see `importInsomnia`).
 * A script that uses nothing of it stays as comments.
 */
export function insomniaScript(script: unknown, alias: 'pm' | 'tp' = 'pm'): string | undefined {
  const s = String(script ?? '').trim();
  if (!s) return undefined;
  if (!/\binsomnia\./.test(s)) return commented('Insomnia', s);
  return `// Insomnia script: insomnia.* runs as ${alias}.* (the same API)\n${s.replace(/\binsomnia\./g, 'pm.')}`;
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

function insomniaAuth(a: Any | undefined): AuthConfig | undefined {
  if (!a || !a.type || a.disabled) return a?.disabled ? { type: 'none' } : undefined;
  const t = (x: unknown) => normalizeTemplate(x ?? '');
  switch (a.type) {
    case 'bearer':
      return { type: 'bearer', token: t(a.token), ...(a.prefix && a.prefix !== 'Bearer' ? { prefix: a.prefix } : {}) };
    case 'basic':
      return { type: 'basic', username: t(a.username), password: t(a.password) };
    case 'digest':
      return { type: 'digest', username: t(a.username), password: t(a.password) };
    case 'apikey':
      return { type: 'apiKey', key: t(a.key), value: t(a.value), in: a.addTo === 'queryParams' ? 'query' : 'header' };
    case 'oauth1':
      return { type: 'oauth1', consumerKey: t(a.consumerKey), consumerSecret: t(a.consumerSecret), token: t(a.tokenKey), tokenSecret: t(a.tokenSecret), signatureMethod: a.signatureMethod === 'HMAC-SHA256' ? 'HMAC-SHA256' : a.signatureMethod === 'PLAINTEXT' ? 'PLAINTEXT' : 'HMAC-SHA1' };
    case 'oauth2':
      return {
        type: 'oauth2',
        grantType: a.grantType === 'password' ? 'password' : a.grantType === 'authorization_code' ? 'authorization_code' : 'client_credentials',
        tokenUrl: t(a.accessTokenUrl),
        authUrl: a.authorizationUrl ? t(a.authorizationUrl) : undefined,
        clientId: t(a.clientId),
        clientSecret: t(a.clientSecret),
        scope: a.scope ? t(a.scope) : undefined,
        username: a.username ? t(a.username) : undefined,
        password: a.password ? t(a.password) : undefined,
        usePkce: !!a.usePkce,
      };
    case 'iam':
      return { type: 'awsv4', accessKey: t(a.accessKeyId), secretKey: t(a.secretAccessKey), sessionToken: a.sessionToken ? t(a.sessionToken) : undefined, region: t(a.region), service: t(a.service) };
    case 'none':
      return { type: 'none' };
    default:
      return undefined;
  }
}

function insomniaRequest(r: Any, alias: 'pm' | 'tp' = 'pm'): SavedHttpRequest | SavedGraphQLRequest {
  const url = normalizeTemplate(r.url);
  const headers = kv(r.headers);
  const auth = insomniaAuth(r.authentication) ?? { type: 'inherit' as const };
  const mime = r.body?.mimeType ?? '';
  if (mime === 'application/graphql') {
    let g: Any = {};
    try {
      g = JSON.parse(r.body?.text ?? '{}');
    } catch {
      /* not JSON */
    }
    return { kind: 'graphql', id: shortId('gql-'), name: r.name || url, request: { endpoint: url, query: normalizeTemplate(g.query ?? ''), variables: g.variables && Object.keys(g.variables).length ? g.variables : undefined, operationName: g.operationName || undefined, headers, auth } };
  }
  const pathParams = kv(r.pathParameters);
  const testScript = insomniaScript(r.afterResponseScript, alias);
  const preRequestScript = insomniaScript(r.preRequestScript, alias);
  return {
    kind: 'http',
    id: shortId('req-'),
    name: r.name || url,
    ...(r.description ? { description: String(r.description) } : {}),
    request: {
      method: String(r.method ?? 'GET').toUpperCase(),
      url,
      params: kv(r.parameters),
      ...(pathParams.length ? { pathVariables: pathParams } : {}),
      headers,
      body: bodyFromMime(mime, r.body?.text, r.body?.params),
      auth,
      ...(r.settingFollowRedirects === 'off' ? { settings: { followRedirects: false } } : {}),
    },
    ...(preRequestScript ? { preRequestScript } : {}),
    ...(testScript ? { testScript } : {}),
  };
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

/**
 * An Insomnia v4 / v5 export. `insomnia.*` scripts become `tp.*` (via `pm.*`, then the same conversion
 * as a Postman import), or stay `pm.*` with `scripts: 'keep'`; both run.
 */
export function importInsomnia(
  text: string,
  opts: { scripts?: ImportScriptsMode } = {},
): { collection: Collection; environments: Environment[]; savedItems?: { grpc?: LibraryItem[]; websocket?: LibraryItem[] }; scripts: ImportScriptsSummary } {
  const alias = opts.scripts === 'keep' ? 'pm' : 'tp';
  const t = text.trim();
  const d: Any = t.startsWith('{') ? JSON.parse(t) : parseYaml(t);
  if (String(d.type ?? '').startsWith('collection.insomnia.rest/5')) {
    // Insomnia 5 YAML: a tree under `collection`, environments with sub-environments
    const convert = (items: Any[]): CollectionNode[] =>
      (items ?? []).map((it: Any): CollectionNode =>
        Array.isArray(it.children)
          ? ({ kind: 'folder', id: shortId('fld-'), name: it.name ?? 'Folder', items: convert(it.children), auth: insomniaAuth(it.authentication), ...(flattenVars(it.environment).length ? { variables: flattenVars(it.environment) } : {}) } as CollectionFolder)
          : insomniaRequest(it, alias),
      );
    const name = d.name ?? 'Insomnia import';
    const env = d.environments ?? {};
    const v5 = importScriptsToTp(collectionOf(name, convert(d.collection ?? []), { description: d.meta?.description }), opts.scripts);
    return { collection: v5.collection, environments: insomniaEnvironments(name, env, env.subEnvironments ?? []), scripts: v5.scripts };
  }
  // Insomnia 4 export: flat resources linked by parentId
  const res: Any[] = d.resources ?? [];
  const children = new Map<string, Any[]>();
  for (const r of res) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r]);
  const order = (list: Any[]) => [...list].sort((a, b) => (a.metaSortKey ?? 0) - (b.metaSortKey ?? 0));
  const build = (parentId: string): CollectionNode[] =>
    order(children.get(parentId) ?? []).flatMap((r): CollectionNode[] => {
      if (r._type === 'request_group') {
        const variables = flattenVars(r.environment);
        return [{ kind: 'folder', id: shortId('fld-'), name: r.name ?? 'Folder', items: build(r._id), ...(insomniaAuth(r.authentication) ? { auth: insomniaAuth(r.authentication) } : {}), ...(variables.length ? { variables } : {}) } as CollectionFolder];
      }
      if (r._type === 'request') return [insomniaRequest(r, alias)];
      return [];
    });
  const workspaces = res.filter((r) => r._type === 'workspace');
  const name = workspaces.length === 1 ? workspaces[0].name : workspaces.length ? 'Insomnia import' : 'Insomnia import';
  const items = workspaces.length === 1 ? build(workspaces[0]._id) : workspaces.length ? workspaces.map((w) => ({ kind: 'folder', id: shortId('fld-'), name: w.name, items: build(w._id) }) as CollectionFolder) : build(res.find((r) => r._type === 'request' || r._type === 'request_group')?.parentId);
  const base = res.find((r) => r._type === 'environment' && workspaces.some((w) => w._id === r.parentId)) ?? res.find((r) => r._type === 'environment' && !res.some((p) => p._id === r.parentId && p._type === 'environment'));
  const subs = base ? res.filter((r) => r._type === 'environment' && r.parentId === base._id) : [];
  const v4 = importScriptsToTp(collectionOf(name, items, { description: workspaces[0]?.description || undefined }), opts.scripts);
  return { collection: v4.collection, environments: insomniaEnvironments(name, base, subs), savedItems: insomniaSavedItems(res), scripts: v4.scripts };
}

/* ------------------------------------------------------------------ Bruno */

function brunoAuth(a: Any | undefined): AuthConfig | undefined {
  if (!a?.mode) return undefined;
  const t = (x: unknown) => normalizeTemplate(x ?? '');
  switch (a.mode) {
    case 'none':
      return { type: 'none' };
    case 'inherit':
      return { type: 'inherit' };
    case 'bearer':
      return { type: 'bearer', token: t(a.bearer?.token) };
    case 'basic':
      return { type: 'basic', username: t(a.basic?.username), password: t(a.basic?.password) };
    case 'digest':
      return { type: 'digest', username: t(a.digest?.username), password: t(a.digest?.password) };
    case 'apikey':
      return { type: 'apiKey', key: t(a.apikey?.key), value: t(a.apikey?.value), in: a.apikey?.placement === 'queryparams' ? 'query' : 'header' };
    case 'awsv4':
      return { type: 'awsv4', accessKey: t(a.awsv4?.accessKeyId), secretKey: t(a.awsv4?.secretAccessKey), sessionToken: a.awsv4?.sessionToken ? t(a.awsv4.sessionToken) : undefined, region: t(a.awsv4?.region), service: t(a.awsv4?.service) };
    case 'oauth2':
      return { type: 'oauth2', grantType: a.oauth2?.grantType === 'password' ? 'password' : a.oauth2?.grantType === 'authorization_code' ? 'authorization_code' : 'client_credentials', tokenUrl: t(a.oauth2?.accessTokenUrl), clientId: t(a.oauth2?.clientId), clientSecret: t(a.oauth2?.clientSecret), scope: a.oauth2?.scope ? t(a.oauth2.scope) : undefined };
    default:
      return undefined;
  }
}

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

/** A Bruno script, kept runnable: Bruno's bru / req / res API works in TestPion's sandbox. */
function brunoScript(...parts: Array<string | undefined>): string | undefined {
  const s = parts.map((p) => String(p ?? '').trim()).filter(Boolean).join('\n\n');
  return s ? `// Bruno script: runs with Bruno's bru, req and res API\n${s}` : undefined;
}

/** A request's vars:pre-request (request variables) and vars:post-response (values taken from the response). */
function brunoVars(vars: Any | undefined): { pre?: string; post?: string } {
  const on = (l: Any[] | undefined) => (l ?? []).filter((v: Any) => v?.name && v.enabled !== false);
  const pre = on(vars?.req).map((v: Any) => `pm.variables.set(${JSON.stringify(v.name)}, ${JSON.stringify(normalizeTemplate(v.value ?? ''))});`);
  // post-response values are expressions over res, e.g. res.body.token
  const post = on(vars?.res).map((v: Any) => `bru.setVar(${JSON.stringify(v.name)}, ${String(v.value ?? 'undefined')});`);
  return { pre: pre.join('\n') || undefined, post: post.join('\n') || undefined };
}

/** Folder and collection settings (Bruno's folder.bru / collection.bru "root"): auth, headers, variables, scripts. */
function brunoRoot(root: Any | undefined): Partial<CollectionFolder> {
  const r = root?.request;
  if (!r) return {};
  const pre = brunoScript(r.script?.req);
  const post = brunoScript(r.script?.res, r.tests);
  const variables = kv(r.vars?.req, 'name', (x) => x.enabled !== false);
  return {
    ...(brunoAuth(r.auth) ? { auth: brunoAuth(r.auth) } : {}),
    ...(variables.length ? { variables } : {}),
    ...(pre ? { preRequestScript: pre } : {}),
    ...(post ? { testScript: post } : {}),
  };
}

export function importBruno(text: string): { collection: Collection; environments: Environment[] } {
  // a single .bru request file, or a Bruno JSON export
  const d: Any = looksLikeBru(text) ? bruFilesToBrunoExport([{ path: 'request.bru', text }], 'Bruno import') : JSON.parse(text);
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
        if (it.type === 'folder') return [{ kind: 'folder', id: shortId('fld-'), name: it.name ?? 'Folder', items: convert(it.items, [it.root, ...roots]), ...brunoRoot(it.root) } as CollectionFolder];
        const r = it.request ?? {};
        const headers = withHeaders(kv(r.headers, 'name', (x) => x.enabled !== false), roots);
        const auth = brunoAuth(r.auth) ?? { type: 'inherit' as const };
        const url = normalizeTemplate(r.url);
        if (it.type === 'graphql-request') {
          const gPre = brunoScript(brunoVars(r.vars).pre, r.script?.req);
          const gPost = brunoScript(brunoVars(r.vars).post, r.script?.res, brunoAssertionScript(r.assertions ?? []), r.tests);
          let variables: Any | undefined;
          try {
            variables = r.body?.graphql?.variables ? JSON.parse(r.body.graphql.variables) : undefined;
          } catch {
            variables = undefined;
          }
          return [{ kind: 'graphql', id: shortId('gql-'), name: it.name || url, request: { endpoint: url, query: normalizeTemplate(r.body?.graphql?.query ?? ''), variables, headers, auth }, ...(gPre ? { preRequestScript: gPre } : {}), ...(gPost ? { testScript: gPost } : {}) }];
        }
        if (it.type !== 'http-request') return [];
        const b = r.body ?? {};
        const body: BodyConfig | undefined =
          b.mode === 'json' ? { type: 'json', content: normalizeTemplate(b.json ?? '') }
          : b.mode === 'xml' ? { type: 'xml', content: normalizeTemplate(b.xml ?? '') }
          : b.mode === 'text' ? { type: 'text', content: normalizeTemplate(b.text ?? '') }
          : b.mode === 'formUrlEncoded' ? { type: 'form-urlencoded', fields: kv(b.formUrlEncoded, 'name', (x) => x.enabled !== false) }
          : b.mode === 'multipartForm' ? { type: 'multipart', fields: (b.multipartForm ?? []).filter((f: Any) => f.name).map((f: Any) => ({ key: f.name, value: f.type === 'file' ? [].concat(f.value ?? []).join(',') : normalizeTemplate(f.value ?? ''), kind: f.type === 'file' ? 'file' : 'text', enabled: f.enabled !== false })) }
          : undefined;
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
            name: it.name || url,
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
  const root = brunoRoot(d.root);
  return {
    collection: collectionOf(d.name ?? 'Bruno import', convert(d.items, [d.root]), {
      variables: root.variables ?? [],
      ...(root.auth ? { auth: root.auth } : {}),
      ...(root.preRequestScript ? { preRequestScript: root.preRequestScript } : {}),
      ...(root.testScript ? { testScript: root.testScript } : {}),
      ...(d.root?.docs ? { description: String(d.root.docs) } : {}),
    }),
    environments,
  };
}

/* ------------------------------------------------------------------ Hoppscotch */

function hoppAuth(a: Any | undefined): AuthConfig | undefined {
  if (!a?.authType) return undefined;
  if (a.authActive === false || a.authType === 'none') return { type: 'none' };
  const t = (x: unknown) => normalizeTemplate(x ?? '');
  switch (a.authType) {
    case 'inherit':
      return { type: 'inherit' };
    case 'bearer':
      return { type: 'bearer', token: t(a.token) };
    case 'basic':
      return { type: 'basic', username: t(a.username), password: t(a.password) };
    case 'digest':
      return { type: 'digest', username: t(a.username), password: t(a.password) };
    case 'api-key':
      return { type: 'apiKey', key: t(a.key), value: t(a.value), in: a.addTo === 'QUERY_PARAMS' ? 'query' : 'header' };
    case 'oauth-2':
      return { type: 'oauth2', grantType: 'client_credentials', tokenUrl: t(a.grantTypeInfo?.authEndpoint ?? a.accessTokenURL), clientId: t(a.grantTypeInfo?.clientID ?? a.clientID), clientSecret: t(a.grantTypeInfo?.clientSecret), scope: a.grantTypeInfo?.scopes ?? a.scope };
    default:
      return undefined;
  }
}

export function importHoppscotch(text: string): { collection: Collection } {
  const d: Any = JSON.parse(text);
  const roots: Any[] = Array.isArray(d) ? d : [d];
  const request = (r: Any): SavedHttpRequest => {
    const ct = r.body?.contentType ?? '';
    const body = typeof r.body?.body === 'string' ? bodyFromMime(ct, r.body.body, undefined) : Array.isArray(r.body?.body) ? bodyFromMime(ct, undefined, r.body.body.map((f: Any) => ({ name: f.key, value: f.value, disabled: f.active === false, type: f.isFile ? 'file' : 'text' }))) : undefined;
    const pre = commented('Hoppscotch', r.preRequestScript);
    const post = commented('Hoppscotch', r.testScript);
    return {
      kind: 'http',
      id: shortId('req-'),
      name: r.name || r.endpoint,
      request: {
        method: String(r.method ?? 'GET').toUpperCase(),
        url: normalizeTemplate(r.endpoint),
        params: kv(r.params, 'key', (x) => x.active !== false),
        headers: kv(r.headers, 'key', (x) => x.active !== false),
        body,
        auth: hoppAuth(r.auth) ?? { type: 'inherit' },
      },
      ...(pre ? { preRequestScript: pre } : {}),
      ...(post ? { testScript: post } : {}),
    };
  };
  const folder = (c: Any): CollectionFolder => ({ kind: 'folder', id: shortId('fld-'), name: c.name ?? 'Folder', items: [...(c.folders ?? []).map(folder), ...(c.requests ?? []).map(request)], ...(hoppAuth(c.auth) ? { auth: hoppAuth(c.auth) } : {}) });
  if (roots.length === 1) {
    const c = roots[0]!;
    return { collection: collectionOf(c.name ?? 'Hoppscotch import', [...(c.folders ?? []).map(folder), ...(c.requests ?? []).map(request)], { ...(hoppAuth(c.auth) ? { auth: hoppAuth(c.auth) } : {}) }) };
  }
  return { collection: collectionOf('Hoppscotch import', roots.map(folder)) };
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
