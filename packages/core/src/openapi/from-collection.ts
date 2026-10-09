import { stringifyYaml } from '../util/lazy-yaml.js';
import type { AuthConfig, BodyConfig, Collection, SavedExample } from '../model/types.js';
import { collectionRequests } from '../runner/collection-run.js';

/**
 * An OpenAPI 3.1 document from a collection (like Postman's "generate a spec from a collection"): paths
 * and methods from the HTTP requests (`{{id}}` / `:id` segments become path parameters), query and
 * header parameters, request bodies with an example and an inferred schema, saved examples as
 * documented responses, folders as tags, and the auth in use as security schemes. Secret-looking
 * values are never copied: parameter examples are omitted when they hold `{{variables}}`.
 */
type Json = Record<string, any>;

/** JSON Schema of an example value (integers stay integers; object fields present are required). */
function schemaOf(v: unknown): Json {
  if (v === null) return { type: 'null' };
  if (Array.isArray(v)) return { type: 'array', items: v.length ? schemaOf(v[0]) : {} };
  switch (typeof v) {
    case 'string':
      return /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})?$/.test(v) ? { type: 'string', format: 'date-time' } : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? { type: 'string', format: 'uuid' } : { type: 'string' };
    case 'number':
      return { type: Number.isInteger(v) ? 'integer' : 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object': {
      const properties: Json = {};
      for (const [k, x] of Object.entries(v as object)) properties[k] = schemaOf(x);
      return { type: 'object', properties, ...(Object.keys(properties).length ? { required: Object.keys(properties) } : {}) };
    }
    default:
      return {};
  }
}

const parseJson = (s: string | undefined): { ok: boolean; value?: unknown } => {
  if (s === undefined || !s.trim()) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
};
const hasVar = (s: string | undefined) => !!s && /\{\{[^}]+\}\}/.test(s);

/** `{{baseUrl}}/pets/:id/{{tagId}}?x=1` → `/pets/{id}/{tagId}` and the names of the path parameters. */
function pathOf(url: string): { path: string; params: string[] } {
  let rest = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').replace(/^\{\{[^}]+\}\}/, '');
  if (!rest.startsWith('/') && !rest.startsWith('?')) rest = rest.replace(/^[^/?#]*/, '');
  const params: string[] = [];
  const segs = rest.split(/[?#]/)[0]!.split('/').filter(Boolean).map((s) => {
    const m = /^:(\w+)$/.exec(s) ?? /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(s);
    if (!m) return s;
    params.push(m[1]!);
    return `{${m[1]}}`;
  });
  return { path: '/' + segs.join('/'), params };
}

function securityFor(auth: AuthConfig | undefined, schemes: Json): Json[] | undefined {
  if (!auth || auth.type === 'none' || auth.type === 'inherit') return undefined;
  switch (auth.type) {
    case 'bearer':
    case 'jwt':
      schemes.bearerAuth = { type: 'http', scheme: 'bearer' };
      return [{ bearerAuth: [] }];
    case 'basic':
      schemes.basicAuth = { type: 'http', scheme: 'basic' };
      return [{ basicAuth: [] }];
    case 'digest':
      schemes.digestAuth = { type: 'http', scheme: 'digest' };
      return [{ digestAuth: [] }];
    case 'apiKey': {
      const name = `apiKey_${auth.key.replace(/[^\w]/g, '')}`;
      schemes[name] = { type: 'apiKey', in: auth.in === 'query' ? 'query' : 'header', name: auth.key };
      return [{ [name]: [] }];
    }
    case 'oauth2': {
      const scopes = Object.fromEntries((auth.scope ?? '').split(/\s+/).filter(Boolean).map((s) => [s, '']));
      const flow =
        auth.grantType === 'authorization_code'
          ? { authorizationCode: { authorizationUrl: auth.authUrl ?? '', tokenUrl: auth.tokenUrl, scopes } }
          : auth.grantType === 'password'
            ? { password: { tokenUrl: auth.tokenUrl, scopes } }
            : { clientCredentials: { tokenUrl: auth.tokenUrl, scopes } };
      schemes.oauth2 = { type: 'oauth2', flows: { ...(schemes.oauth2?.flows ?? {}), ...flow } };
      return [{ oauth2: Object.keys(scopes) }];
    }
    default:
      return undefined;
  }
}

function requestBody(b: BodyConfig | undefined): Json | undefined {
  if (!b || b.type === 'none') return undefined;
  if (b.type === 'json') {
    const j = parseJson(b.content);
    return { content: { 'application/json': j.ok ? { schema: schemaOf(j.value), ...(hasVar(b.content) ? {} : { example: j.value }) } : { schema: {} } } };
  }
  if (b.type === 'xml' || b.type === 'text' || b.type === 'html') {
    const ct = b.type === 'xml' ? 'application/xml' : b.type === 'html' ? 'text/html' : 'text/plain';
    return { content: { [ct]: { schema: { type: 'string' }, ...(b.content && !hasVar(b.content) ? { example: b.content } : {}) } } };
  }
  if (b.type === 'form-urlencoded' || b.type === 'multipart') {
    const properties: Json = {};
    for (const f of b.fields.filter((x) => x.key && x.enabled !== false)) properties[f.key] = b.type === 'multipart' && (f as { kind?: string }).kind === 'file' ? { type: 'string', format: 'binary' } : { type: 'string' };
    return { content: { [b.type === 'multipart' ? 'multipart/form-data' : 'application/x-www-form-urlencoded']: { schema: { type: 'object', properties } } } };
  }
  if (b.type === 'binary') return { content: { [b.contentType ?? 'application/octet-stream']: { schema: { type: 'string', format: 'binary' } } } };
  return undefined;
}

function responseOf(ex: SavedExample): Json {
  const ct = ex.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value.split(';')[0]?.trim();
  const j = parseJson(ex.body);
  const type = ct ?? (j.ok ? 'application/json' : ex.body ? 'text/plain' : undefined);
  return {
    description: ex.name || `${ex.status} response`,
    ...(type && ex.body ? { content: { [type]: j.ok ? { schema: schemaOf(j.value), example: j.value } : { schema: { type: 'string' }, example: ex.body } } } : {}),
  };
}

const opId = (name: string, taken: Set<string>) => {
  const base = name.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toLowerCase()) || 'operation';
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}${i}`;
  taken.add(id);
  return id;
};

const SKIP_HEADERS = /^(authorization|content-type|accept|cookie|content-length|host|user-agent)$/i;

/** Build the OpenAPI 3.1 document (as an object). */
export function collectionToOpenApi(collection: Collection, opts: { serverUrl?: string } = {}): Json {
  const paths: Json = {};
  const schemes: Json = {};
  const ids = new Set<string>();
  const tags = new Set<string>();
  let skipped = 0;
  for (const ref of collectionRequests(collection)) {
    const n = ref.node;
    if (n.kind !== 'http') {
      skipped++;
      continue;
    }
    const r = n.request;
    const method = (r.method || 'GET').toLowerCase();
    if (!['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(method)) continue;
    const { path, params: pathParams } = pathOf(r.url);
    const pathItem = (paths[path] ??= {});
    if (pathItem[method]) {
      // two requests for the same operation: keep the first, add the other's examples as responses
      for (const ex of n.examples ?? []) pathItem[method].responses[String(ex.status)] ??= responseOf(ex);
      continue;
    }
    const parameters: Json[] = [
      ...pathParams.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
      ...(r.params ?? []).filter((p) => p.key).map((p) => ({ name: p.key, in: 'query', required: p.enabled !== false, schema: { type: 'string' }, ...(p.description ? { description: p.description } : {}), ...(p.value && !hasVar(p.value) ? { example: p.value } : {}) })),
      ...(r.headers ?? []).filter((h) => h.key && h.enabled !== false && !SKIP_HEADERS.test(h.key)).map((h) => ({ name: h.key, in: 'header', required: true, schema: { type: 'string' }, ...(h.value && !hasVar(h.value) ? { example: h.value } : {}) })),
    ];
    const responses: Json = {};
    for (const ex of n.examples ?? []) responses[String(ex.status)] ??= responseOf(ex);
    const status = n.assertions?.find((a) => a.type === 'status') as { expected?: unknown } | undefined;
    if (!Object.keys(responses).length) responses[String(typeof status?.expected === 'number' ? status.expected : 200)] = { description: 'Success' };
    const tag = ref.path[0];
    if (tag) tags.add(tag);
    const security = securityFor(ref.auth, schemes);
    const body = requestBody(r.body);
    pathItem[method] = {
      operationId: opId(n.name, ids),
      summary: n.name,
      ...(n.description ? { description: n.description } : {}),
      ...(tag ? { tags: [tag] } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(body ? { requestBody: body } : {}),
      responses,
      ...(security ? { security } : {}),
    };
  }
  const baseUrl = opts.serverUrl ?? collection.variables?.find((v) => v.key === 'baseUrl' && v.value && !hasVar(v.value))?.value;
  return {
    openapi: '3.1.0',
    info: { title: collection.name, version: `${collection.version ?? 1}.0.0`, ...(collection.description ? { description: collection.description } : {}) },
    ...(baseUrl ? { servers: [{ url: baseUrl }] } : {}),
    ...(tags.size ? { tags: [...tags].map((name) => ({ name })) } : {}),
    paths,
    ...(Object.keys(schemes).length ? { components: { securitySchemes: schemes } } : {}),
    ...(skipped ? { 'x-testpion-note': `${skipped} GraphQL request(s) are not described (GraphQL has its own schema).` } : {}),
  };
}

/** The document as YAML (or JSON with `format: 'json'`). */
export function collectionToOpenApiText(collection: Collection, opts: { format?: 'yaml' | 'json'; serverUrl?: string } = {}): string {
  const doc = collectionToOpenApi(collection, opts);
  return opts.format === 'json' ? JSON.stringify(doc, null, 2) + '\n' : stringifyYaml(doc, { lineWidth: 120 });
}
