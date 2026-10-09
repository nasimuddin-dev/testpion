import { parseYaml } from '../util/lazy-yaml.js';
import type { AuthConfig, BodyConfig, Collection, CollectionFolder, CollectionNode, Environment, KeyValue, SavedExample, SavedHttpRequest } from '../model/types.js';
import { SCHEMA_VERSION } from '../model/types.js';
import { ApsError } from '../errors.js';
import { shortId, slugify } from '../util/ids.js';
import { WORKSPACE_FORMATS } from '../storage/workspace.js';
import { deref } from '../util/json-ref.js';
import { successCode } from '../openapi/outline.js';
import { looksLikeBru } from './bru.js';
import { importWsdl, isWsdl } from './wsdl.js';
import { detectOtherTool, importBruno, importHoppscotch, importInsomnia } from './other-tools.js';
import { importDotenv, isDotenv } from './dotenv.js';
import { importAsyncApi, isAsyncApi } from './asyncapi.js';
import { importHttpFile, isHttpFile } from './http-file.js';
import { importScriptsToTp, type ImportScriptsMode, type ImportScriptsSummary } from './import-scripts.js';
import { importArazzo, isArazzo, type ArazzoFlowFile } from './arazzo.js';

function newCollection(name: string, items: CollectionNode[], extra: Partial<Collection> = {}): Collection {
  return { schemaVersion: SCHEMA_VERSION, id: slugify(name) + '-' + shortId().slice(-4), name, version: 0, variables: [], items, updatedAt: new Date().toISOString(), ...extra };
}

export function detectFormat(text: string): 'openapi' | 'swagger' | 'postman' | 'postman-env' | 'har' | 'aps-collection' | 'aps-workspace' | 'graphql-sdl' | 'insomnia' | 'bruno' | 'hoppscotch' | 'dotenv' | 'wsdl' | 'asyncapi' | 'http-file' | 'arazzo' | 'unknown' {
  const t = text.trim();
  if (isWsdl(t)) return 'wsdl';
  // an .http / .rest file (VS Code REST Client, JetBrains HTTP Client)
  if (isHttpFile(t)) return 'http-file';
  // a single Bruno .bru request file
  if (looksLikeBru(t)) return 'bruno';
  if (/^(type|schema|interface|enum|input|scalar|union|directive|extend)\s/m.test(t) && !t.startsWith('{')) return 'graphql-sdl';
  if (!t.startsWith('{') && !t.startsWith('[') && isDotenv(t)) return 'dotenv';
  let d: Record<string, any>;
  try {
    d = t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : parseYaml(t);
  } catch {
    return 'unknown';
  }
  if (!d || typeof d !== 'object') return 'unknown';
  // an Arazzo workflow description (arazzo: 1.0.x): its workflows become flow files under tests/
  if (isArazzo(d)) return 'arazzo';
  const other = detectOtherTool(d);
  if (other) return other;
  if (isAsyncApi(d)) return 'asyncapi';
  if (d.openapi) return 'openapi';
  if (d.swagger) return 'swagger';
  if (d.info?._postman_id || String(d.info?.schema ?? '').includes('postman')) return 'postman';
  if (d._postman_variable_scope === 'environment' || d._postman_variable_scope === 'globals' || (Array.isArray(d.values) && d.name)) return 'postman-env';
  if (d.log?.entries) return 'har';
  if (WORKSPACE_FORMATS.has(d.format)) return 'aps-workspace';
  if (d.schemaVersion && Array.isArray(d.items)) return 'aps-collection';
  return 'unknown';
}

/* ------------------------------------------------------------------ OpenAPI */

export function sampleFromSchema(schema: any, spec: any, depth = 0): unknown {
  if (!schema || depth > 6) return null;
  if (schema.$ref) return sampleFromSchema(deref(spec, schema), spec, depth + 1);
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s: unknown) => sampleFromSchema(s, spec, depth + 1)));
  if (schema.oneOf || schema.anyOf) return sampleFromSchema((schema.oneOf ?? schema.anyOf)[0], spec, depth + 1);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type ?? (schema.properties ? 'object' : undefined);
  switch (type) {
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) o[k] = sampleFromSchema(v, spec, depth + 1);
      return o;
    }
    case 'array':
      return [sampleFromSchema(schema.items, spec, depth + 1)];
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'string':
      return schema.format === 'date-time' ? new Date(0).toISOString() : schema.format === 'uuid' ? '00000000-0000-0000-0000-000000000000' : schema.format === 'email' ? 'user@example.com' : 'string';
    default:
      return null;
  }
}

export function importOpenApi(text: string): { collection: Collection; environment?: Environment } {
  let spec: any;
  try {
    spec = text.trim().startsWith('{') ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new ApsError('ValidationError', `Invalid OpenAPI document: ${(e as Error).message}`);
  }
  const isV2 = !!spec.swagger;
  const name = spec.info?.title ?? 'Imported API';
  let baseUrl = 'http://localhost';
  if (isV2) baseUrl = `${(spec.schemes ?? ['https'])[0]}://${spec.host ?? 'localhost'}${spec.basePath ?? ''}`;
  else if (spec.servers?.[0]?.url) {
    baseUrl = String(spec.servers[0].url);
    for (const [k, v] of Object.entries<any>(spec.servers[0].variables ?? {})) baseUrl = baseUrl.replace(`{${k}}`, v.default ?? '');
  }
  const folders = new Map<string, CollectionFolder>();
  const root: CollectionNode[] = [];
  const securitySchemes = isV2 ? spec.securityDefinitions ?? {} : spec.components?.securitySchemes ?? {};

  const authFor = (security: any[] | undefined): AuthConfig | undefined => {
    const first = security?.[0] ? Object.keys(security[0])[0] : undefined;
    const s = first ? securitySchemes[first] : undefined;
    if (!s) return undefined;
    if ((s.type === 'http' && s.scheme === 'bearer') || s.type === 'oauth2' || s.type === 'openIdConnect') return { type: 'bearer', token: '{{accessToken}}' };
    if (s.type === 'http' && s.scheme === 'basic') return { type: 'basic', username: '{{username}}', password: '{{password}}' };
    if (s.type === 'apiKey') return { type: 'apiKey', key: s.name, value: '{{apiKey}}', in: s.in === 'query' ? 'query' : 'header' };
    return undefined;
  };

  for (const [path, ops] of Object.entries<any>(spec.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const op = ops?.[method];
      if (!op) continue;
      const params = [...(ops.parameters ?? []), ...(op.parameters ?? [])].map((p: any) => (p.$ref ? sampleRef(p.$ref, spec) : p));
      const query: KeyValue[] = params.filter((p: any) => p.in === 'query').map((p: any) => ({ key: p.name, value: String(p.example ?? p.schema?.example ?? ''), enabled: !!p.required, description: p.description }));
      const headers: KeyValue[] = params.filter((p: any) => p.in === 'header').map((p: any) => ({ key: p.name, value: String(p.example ?? ''), enabled: !!p.required }));
      const url = '{{baseUrl}}' + path.replace(/\{([^}]+)\}/g, '{{$1}}');
      let body: BodyConfig | undefined;
      if (isV2) {
        const bp = params.find((p: any) => p.in === 'body');
        if (bp) body = { type: 'json', content: JSON.stringify(sampleFromSchema(bp.schema, spec), null, 2) };
      } else if (op.requestBody) {
        const rb = op.requestBody.$ref ? sampleRef(op.requestBody.$ref, spec) : op.requestBody;
        const content = rb?.content ?? {};
        const ct = Object.keys(content)[0];
        if (ct && /json/.test(ct)) body = { type: 'json', content: JSON.stringify(content[ct].example ?? sampleFromSchema(content[ct].schema, spec), null, 2) };
        else if (ct === 'application/x-www-form-urlencoded')
          body = { type: 'form-urlencoded', fields: Object.keys(content[ct].schema?.properties ?? {}).map((k) => ({ key: k, value: '' })) };
        else if (ct === 'multipart/form-data') body = { type: 'multipart', fields: Object.keys(content[ct].schema?.properties ?? {}).map((k) => ({ key: k, value: '' })) };
        else if (ct) body = { type: 'text', content: '' };
      }
      const examples = openApiExamples(op.responses, spec, isV2, op.produces ?? spec.produces);
      const req: SavedHttpRequest = {
        kind: 'http',
        id: shortId('req-'),
        name: op.summary ?? op.operationId ?? `${method.toUpperCase()} ${path}`,
        request: { method: method.toUpperCase(), url, params: query, headers, body, auth: authFor(op.security ?? spec.security) ?? { type: 'inherit' } },
        assertions: [{ type: 'status', expected: Number(successCode(Object.keys(op.responses ?? {})) ?? 200) }],
        ...(examples.length ? { examples } : {}),
      };
      const tag = op.tags?.[0];
      if (tag) {
        let f = folders.get(tag);
        if (!f) {
          f = { kind: 'folder', id: shortId('fld-'), name: tag, items: [] };
          folders.set(tag, f);
          root.push(f);
        }
        f.items.push(req);
      } else root.push(req);
    }
  }
  const collection = newCollection(name, root, { description: spec.info?.description, variables: [{ key: 'baseUrl', value: baseUrl, enabled: true }] });
  return { collection };
}

/**
 * Saved examples from an operation's documented responses (success first, at most 5): the response's
 * own example, its first named example, or a sample built from the schema. They make the imported
 * collection mockable right away (`testpion mock`, the app's mock server).
 */
function openApiExamples(responses: any, spec: any, isV2: boolean, produces?: string[]): SavedExample[] {
  const codes = Object.keys(responses ?? {})
    .filter((c) => /^\d{3}$/.test(c))
    .sort((a, b) => Number(!/^2/.test(a)) - Number(!/^2/.test(b)) || Number(a) - Number(b))
    .slice(0, 5);
  const out: SavedExample[] = [];
  for (const code of codes) {
    const r0 = responses[code];
    const r = r0?.$ref ? sampleRef(r0.$ref, spec) : r0;
    if (!r) continue;
    let ct: string | undefined;
    let body: unknown;
    if (isV2) {
      ct = (produces ?? []).find((p) => /json/.test(p)) ?? (r.schema ? 'application/json' : undefined);
      const ex = r.examples?.[ct ?? ''] ?? r.examples?.['application/json'];
      body = ex !== undefined ? ex : r.schema ? sampleFromSchema(r.schema, spec) : undefined;
    } else {
      const content = r.content ?? {};
      ct = Object.keys(content).find((k) => /json/.test(k)) ?? Object.keys(content)[0];
      const media = ct ? content[ct] : undefined;
      if (media) {
        const named = media.examples ? Object.values<any>(media.examples)[0] : undefined;
        const namedValue = named?.$ref ? sampleRef(named.$ref, spec)?.value : named?.value;
        body = media.example !== undefined ? media.example : namedValue !== undefined ? namedValue : media.schema ? sampleFromSchema(media.schema, spec) : undefined;
      }
    }
    const text = body === undefined ? '' : typeof body === 'string' && !/json/.test(ct ?? '') ? body : JSON.stringify(body, null, 2);
    out.push({
      id: shortId('ex-'),
      name: `${code} ${String(r.description ?? '').split('\n')[0]!.slice(0, 60)}`.trim(),
      status: Number(code),
      headers: ct && text ? [{ key: 'Content-Type', value: ct, enabled: true }] : [],
      body: text,
    });
  }
  return out;
}

function sampleRef(ref: string, spec: any): any {
  let cur = spec;
  for (const p of ref.replace(/^#\//, '').split('/')) cur = cur?.[p];
  return cur;
}

/* ------------------------------------------------------------------ Postman */

function pmAuth(a: any): AuthConfig | undefined {
  if (!a) return undefined;
  // v2.1 stores auth attributes as [{ key, value }]; v2.0 as a plain object ({ token: "…" })
  const get = (arr: any[] | Record<string, unknown> | undefined, k: string) =>
    String((Array.isArray(arr) ? arr.find((x: any) => x.key === k)?.value : (arr as Record<string, unknown> | undefined)?.[k]) ?? '');
  switch (a.type) {
    case 'noauth':
      return { type: 'none' };
    case 'bearer':
      return { type: 'bearer', token: get(a.bearer, 'token') };
    case 'basic':
      return { type: 'basic', username: get(a.basic, 'username'), password: get(a.basic, 'password') };
    case 'apikey':
      return { type: 'apiKey', key: get(a.apikey, 'key'), value: get(a.apikey, 'value'), in: get(a.apikey, 'in') === 'query' ? 'query' : 'header' };
    case 'digest':
      return { type: 'digest', username: get(a.digest, 'username'), password: get(a.digest, 'password') };
    case 'oauth1': {
      const opt = (k: string) => get(a.oauth1, k) || undefined;
      const sm = get(a.oauth1, 'signatureMethod');
      return {
        type: 'oauth1',
        consumerKey: get(a.oauth1, 'consumerKey'),
        consumerSecret: get(a.oauth1, 'consumerSecret'),
        ...(opt('token') ? { token: opt('token') } : {}),
        ...(opt('tokenSecret') ? { tokenSecret: opt('tokenSecret') } : {}),
        ...(sm === 'HMAC-SHA256' || sm === 'PLAINTEXT' ? { signatureMethod: sm } : sm === 'HMAC-SHA1' ? { signatureMethod: 'HMAC-SHA1' as const } : {}),
        ...(opt('realm') ? { realm: opt('realm') } : {}),
        ...(get(a.oauth1, 'addParamsToHeader') === 'false' ? { addTo: 'query' as const } : {}),
      };
    }
    case 'awsv4':
      return {
        type: 'awsv4',
        accessKey: get(a.awsv4, 'accessKey'),
        secretKey: get(a.awsv4, 'secretKey'),
        region: get(a.awsv4, 'region'),
        service: get(a.awsv4, 'service'),
        ...(get(a.awsv4, 'sessionToken') ? { sessionToken: get(a.awsv4, 'sessionToken') } : {}),
      };
    case 'oauth2': {
      const g = get(a.oauth2, 'grant_type');
      const opt = (k: string) => get(a.oauth2, k) || undefined;
      return {
        type: 'oauth2',
        grantType: g === 'client_credentials' ? 'client_credentials' : g === 'password_credentials' ? 'password' : 'authorization_code',
        tokenUrl: get(a.oauth2, 'accessTokenUrl'),
        authUrl: opt('authUrl'),
        clientId: get(a.oauth2, 'clientId'),
        clientSecret: opt('clientSecret'),
        scope: opt('scope'),
        username: opt('username'),
        password: opt('password'),
        usePkce: g === 'authorization_code_with_pkce' || undefined,
        redirectUri: opt('redirect_uri'),
        clientAuth: get(a.oauth2, 'client_authentication') === 'header' ? 'header' : undefined,
      };
    }
    default:
      return undefined;
  }
}

type PmEvent = { listen: string; script?: { exec?: string[] | string } };
/** Script of a Postman `event` list (`prerequest` or `test`). */
function pmScript(events: PmEvent[] | undefined, listen: string): string | undefined {
  const e = (events ?? []).find((x) => x.listen === listen)?.script?.exec;
  const s = Array.isArray(e) ? e.join('\n') : e;
  return s?.trim() ? s : undefined;
}

/** Postman descriptions are a string or `{ content, type }`. */
function pmDescription(d: any): string | undefined {
  const s = typeof d === 'string' ? d : typeof d?.content === 'string' ? d.content : undefined;
  return s?.trim() ? s : undefined;
}

/** Postman saved responses (`item.response[]`) → examples. */
function pmExamples(responses: any, parent?: { method?: string; url?: string }): SavedExample[] | undefined {
  if (!Array.isArray(responses) || !responses.length) return undefined;
  return responses.map((r: any) => {
    const url0 = typeof r.originalRequest?.url === 'string' ? r.originalRequest.url : r.originalRequest?.url?.raw;
    // an original request identical to the saved request adds nothing
    const same = parent && url0 === parent.url && (r.originalRequest?.method ?? 'GET') === (parent.method ?? 'GET') && !r.originalRequest?.body;
    const o = same ? undefined : r.originalRequest;
    const url = typeof o?.url === 'string' ? o.url : o?.url?.raw;
    return {
      id: shortId('ex-'),
      name: String(r.name || `${r.code ?? ''} ${r.status ?? ''}`.trim() || 'Example'),
      status: Number(r.code) || 200,
      statusText: r.status || undefined,
      headers: (Array.isArray(r.header) ? r.header : []).map((h: any) => ({ key: String(h.key), value: String(h.value ?? '') })),
      body: typeof r.body === 'string' ? r.body : '',
      request: o && url ? { method: o.method ?? 'GET', url, headers: (o.header ?? []).map((h: any) => ({ key: h.key, value: h.value ?? '' })), body: o.body?.mode === 'raw' ? o.body.raw : undefined } : undefined,
    };
  });
}

/**
 * A Postman v2 / v2.1 collection. Its `pm.*` scripts become `tp.*` unless `scripts` is `'keep'`
 * (`pm.*` still runs: it is an alias of `tp`).
 */
export function importPostman(text: string, opts: { scripts?: ImportScriptsMode } = {}): { collection: Collection; scripts: ImportScriptsSummary } {
  const d = JSON.parse(text);
  const convert = (items: any[]): CollectionNode[] =>
    (items ?? []).map((it: any): CollectionNode => {
      if (Array.isArray(it.item)) {
        const variables: KeyValue[] = (it.variable ?? []).filter((v: any) => v.key).map((v: any) => ({ key: v.key, value: String(v.value ?? ''), enabled: !v.disabled }));
        return {
          kind: 'folder',
          id: shortId('fld-'),
          name: it.name,
          items: convert(it.item),
          auth: pmAuth(it.auth),
          ...(variables.length ? { variables } : {}),
          ...(pmScript(it.event, 'prerequest') ? { preRequestScript: pmScript(it.event, 'prerequest') } : {}),
          ...(pmScript(it.event, 'test') ? { testScript: pmScript(it.event, 'test') } : {}),
        };
      }
      const r = typeof it.request === 'string' ? { url: it.request } : it.request ?? {};
      const url = typeof r.url === 'string' ? r.url : r.url?.raw ?? '';
      const [base, qs] = url.split('?');
      const params: KeyValue[] = (r.url?.query ?? []).map((q: any) => ({ key: q.key, value: q.value ?? '', enabled: !q.disabled, ...(q.description ? { description: pmDescription(q.description) } : {}) }));
      const pathVariables: KeyValue[] = (r.url?.variable ?? []).filter((v: any) => v.key).map((v: any) => ({ key: v.key, value: String(v.value ?? ''), ...(v.description ? { description: pmDescription(v.description) } : {}) }));
      // v2.0 also allows headers as one "Name: value" string per line
      const rawHeaders = typeof r.header === 'string' ? r.header.split(/\r?\n/).filter((l: string) => l.includes(':')).map((l: string) => ({ key: l.slice(0, l.indexOf(':')).trim(), value: l.slice(l.indexOf(':') + 1).trim() })) : r.header;
      const headers: KeyValue[] = (rawHeaders ?? []).map((h: any) => ({ key: h.key, value: h.value ?? '', enabled: !h.disabled, ...(h.description ? { description: pmDescription(h.description) } : {}) }));
      const auth = pmAuth(r.auth) ?? { type: 'inherit' as const };
      if (r.body?.mode === 'graphql') {
        const g = r.body.graphql ?? {};
        return {
          kind: 'graphql',
          id: shortId('gql-'),
          name: it.name ?? url,
          request: { endpoint: url, query: g.query ?? '', variables: typeof g.variables === 'string' && g.variables.trim() ? g.variables : undefined, headers, auth },
          ...(pmScript(it.event, 'prerequest') ? { preRequestScript: pmScript(it.event, 'prerequest') } : {}),
          ...(pmScript(it.event, 'test') ? { testScript: pmScript(it.event, 'test') } : {}),
        };
      }
      let body: BodyConfig | undefined;
      if (r.body?.mode === 'raw') {
        const lang = r.body.options?.raw?.language;
        body = { type: lang === 'json' || (!lang && /^\s*[{[]/.test(r.body.raw ?? '')) ? 'json' : lang === 'xml' ? 'xml' : lang === 'html' ? 'html' : 'text', content: r.body.raw ?? '' };
      } else if (r.body?.mode === 'urlencoded') body = { type: 'form-urlencoded', fields: r.body.urlencoded.map((f: any) => ({ key: f.key, value: f.value ?? '', enabled: !f.disabled })) };
      else if (r.body?.mode === 'formdata')
        body = { type: 'multipart', fields: r.body.formdata.map((f: any) => ({ key: f.key, value: f.type === 'file' ? f.src ?? '' : f.value ?? '', kind: f.type === 'file' ? 'file' : 'text', enabled: !f.disabled })) };
      else if (r.body?.mode === 'file' && r.body.file?.src) body = { type: 'binary', filePath: r.body.file.src };
      const behavior = it.protocolProfileBehavior ?? {};
      const settings = { ...(behavior.followRedirects === false ? { followRedirects: false } : {}), ...(behavior.strictSSL === false ? { insecure: true } : {}) };
      return {
        kind: 'http',
        id: shortId('req-'),
        name: it.name ?? url,
        request: {
          method: r.method ?? 'GET',
          url: params.length ? base! : qs ? url : base!,
          params,
          ...(pathVariables.length ? { pathVariables } : {}),
          headers,
          body,
          auth,
          ...(Object.keys(settings).length ? { settings } : {}),
        },
        description: pmDescription(r.description ?? it.description),
        preRequestScript: pmScript(it.event, 'prerequest'),
        testScript: pmScript(it.event, 'test'),
        examples: pmExamples(it.response, { method: r.method, url }),
      };
    });
  const collection = newCollection(d.info?.name ?? 'Postman import', convert(d.item), {
    description: pmDescription(d.info?.description),
    variables: (d.variable ?? []).map((v: any) => ({ key: v.key, value: String(v.value ?? ''), enabled: !v.disabled })),
    auth: pmAuth(d.auth),
    preRequestScript: pmScript(d.event, 'prerequest'),
    testScript: pmScript(d.event, 'test'),
  });
  return importScriptsToTp(collection, opts.scripts);
}

export function importPostmanEnvironment(text: string): Environment {
  const d = JSON.parse(text);
  return {
    id: slugify(d.name ?? 'imported'),
    name: d.name ?? 'Imported',
    variables: (d.values ?? []).map((v: any) => ({ key: v.key, value: v.type === 'secret' ? '' : String(v.value ?? ''), secret: v.type === 'secret', enabled: v.enabled !== false })),
  };
}

/* ------------------------------------------------------------------ HAR */

export function importHar(text: string): { collection: Collection } {
  const d = JSON.parse(text);
  const items: CollectionNode[] = (d.log?.entries ?? []).map((e: any): SavedHttpRequest => {
    const r = e.request;
    const u = new URL(r.url);
    const mime = r.postData?.mimeType ?? '';
    let body: BodyConfig | undefined;
    if (r.postData?.params?.length && /urlencoded/.test(mime)) body = { type: 'form-urlencoded', fields: r.postData.params.map((p: any) => ({ key: p.name, value: p.value ?? '' })) };
    else if (r.postData?.text !== undefined) body = { type: /json/.test(mime) ? 'json' : /xml/.test(mime) ? 'xml' : 'text', content: r.postData.text };
    return {
      kind: 'http',
      id: shortId('req-'),
      name: `${r.method} ${u.pathname}`,
      request: {
        method: r.method,
        url: `${u.origin}${u.pathname}`,
        params: [...u.searchParams].map(([key, value]) => ({ key, value })),
        headers: (r.headers ?? []).filter((h: any) => !/^(:|content-length|host|connection|accept-encoding|cookie)/i.test(h.name)).map((h: any) => ({ key: h.name, value: h.value })),
        cookies: (r.cookies ?? []).map((c: any) => ({ key: c.name, value: c.value })),
        body,
      },
      assertions: e.response?.status ? [{ type: 'status', expected: e.response.status }] : undefined,
    };
  });
  return { collection: newCollection(`HAR import ${new Date().toISOString().slice(0, 10)}`, items) };
}

/** Import any supported document into a collection (and optionally an environment). */
export function importAny(
  text: string,
  opts: { name?: string; scripts?: ImportScriptsMode } = {},
): { format: string; collection?: Collection; environment?: Environment; environments?: Environment[]; secretValues?: Record<string, Record<string, string>>; savedItems?: unknown; notes?: string[]; scripts?: ImportScriptsSummary; flows?: ArazzoFlowFile[] } {
  const format = detectFormat(text);
  switch (format) {
    case 'openapi':
    case 'swagger':
      return { format, ...importOpenApi(text) };
    case 'postman':
      return { format, ...importPostman(text, { scripts: opts.scripts }) };
    case 'postman-env':
      return { format, environment: importPostmanEnvironment(text) };
    case 'har':
      return { format, ...importHar(text) };
    case 'insomnia': {
      const r = importInsomnia(text, { scripts: opts.scripts });
      return { format, collection: r.collection, environment: r.environments[0], environments: r.environments, savedItems: r.savedItems, scripts: r.scripts };
    }
    case 'bruno': {
      const r = importBruno(text);
      return { format, collection: r.collection, environment: r.environments[0], environments: r.environments };
    }
    case 'hoppscotch':
      return { format, ...importHoppscotch(text) };
    case 'wsdl':
      return { format, ...importWsdl(text) };
    case 'http-file': {
      const r = importHttpFile(text, { name: opts.name?.replace(/\.(http|rest)$/i, '') || undefined });
      return { format, collection: r.collection, notes: r.notes };
    }
    case 'asyncapi': {
      const r = importAsyncApi(text);
      return { format, collection: r.collection, environment: r.environment, environments: r.environment ? [r.environment] : undefined, savedItems: r.savedItems };
    }
    case 'dotenv': {
      const r = importDotenv(text, opts.name);
      return { format, environment: r.environment, environments: [r.environment], secretValues: { [r.environment.id]: r.secretValues } };
    }
    case 'arazzo': {
      // without the OpenAPI documents (importIntoWorkspace finds them): operationPath steps still convert
      const r = importArazzo(text);
      return { format, flows: r.flows, notes: r.notes };
    }
    case 'aps-collection': {
      // `savedItems` (its gRPC calls and connections) are restored by importIntoWorkspace, not kept in the collection
      const { savedItems: _items, ...c } = JSON.parse(text) as Collection & { savedItems?: unknown };
      return { format, collection: { ...c, id: c.id || shortId('col-') } };
    }
    default: {
      // a file that is meant to be JSON but doesn't parse: say where, not just "unknown format"
      const t = text.trimStart();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          JSON.parse(t);
        } catch (e) {
          const msg = (e as Error).message;
          const pos = /position (\d+)/.exec(msg);
          const at = pos ? (() => { const before = t.slice(0, Number(pos[1])).split('\n'); return ` (line ${before.length}, column ${before.at(-1)!.length + 1})`; })() : '';
          throw new ApsError('ValidationError', `The file is not valid JSON${at}: ${msg.replace(/ in JSON at position \d+.*$/s, '')}`, {
            suggestions: ['Fix the JSON (a stray backslash or a missing comma is common), then import it again.'],
          });
        }
      }
      throw new ApsError('ValidationError', `Unrecognised import format (${format})`, {
        suggestions: ['Supported: OpenAPI 3 / Swagger 2 (JSON or YAML), Postman v2.1 collections & environments, Insomnia (v4 export, v5 YAML), Bruno collections (folder, .bru file or export), Hoppscotch collections, WSDL 1.1 and 2.0 (SOAP), AsyncAPI 2 and 3 (Kafka, MQTT, WebSocket), .http / .rest files (REST Client, JetBrains), .env files, HAR, TestPion collections and workspace exports, Arazzo 1.0 workflows (as flow files).'],
      });
    }
  }
}
