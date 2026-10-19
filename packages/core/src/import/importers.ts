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
import { mapForeignAuth } from './foreign-auth.js';
import { importGraphqlSdl } from './graphql-sdl.js';
import { ensureUniqueIds } from '../storage/node-ids.js';
import type { ImportFormat } from '@testpion/shared';

function newCollection(name: string, items: CollectionNode[], extra: Partial<Collection> = {}): Collection {
  return { schemaVersion: SCHEMA_VERSION, id: slugify(name) + '-' + shortId().slice(-4), name, version: 0, variables: [], items, updatedAt: new Date().toISOString(), ...extra };
}

/** Which format a text is in; every format it returns has its file extensions in IMPORT_FORMATS (the pickers' filter). */
export function detectFormat(text: string): ImportFormat | 'unknown' {
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
    case 'number': {
      // an example inside the documented range (the document's own limits make the sample valid)
      const lo = typeof schema.minimum === 'number' ? schema.minimum + (schema.exclusiveMinimum === true ? 1 : 0) : typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum + 1 : undefined;
      const hi = typeof schema.maximum === 'number' ? schema.maximum - (schema.exclusiveMaximum === true ? 1 : 0) : typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum - 1 : undefined;
      if (lo !== undefined && lo > 0) return lo;
      if (hi !== undefined && hi < 0) return hi;
      return 0;
    }
    case 'boolean':
      return false;
    case 'string': {
      if (schema.format === 'date-time') return new Date(0).toISOString();
      if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
      if (schema.format === 'email') return 'user@example.com';
      // within the documented length
      let v = 'string';
      if (typeof schema.minLength === 'number' && v.length < schema.minLength) v = v.padEnd(Math.min(schema.minLength, 10_000), 'x');
      if (typeof schema.maxLength === 'number' && v.length > schema.maxLength) v = v.slice(0, Math.max(0, schema.maxLength));
      return v;
    }
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
export function importPostman(text: string, opts: { scripts?: ImportScriptsMode } = {}): { collection: Collection; scripts: ImportScriptsSummary; notes: string[] } {
  const d = JSON.parse(text);
  const notes: string[] = [];
  /** The item's auth (undefined: inherits); an unsupported scheme adds a note and, for a request, a disabled placeholder header. */
  const authOf = (raw: unknown, where: string, headers?: KeyValue[]): AuthConfig | undefined => {
    const a = mapForeignAuth('postman', raw, where);
    notes.push(...a.notes);
    headers?.push(...a.headers);
    return a.auth;
  };
  const convert = (items: any[]): CollectionNode[] =>
    (items ?? []).map((it: any): CollectionNode => {
      if (Array.isArray(it.item)) {
        const variables: KeyValue[] = (it.variable ?? []).filter((v: any) => v.key).map((v: any) => ({ key: v.key, value: String(v.value ?? ''), enabled: !v.disabled }));
        return {
          kind: 'folder',
          id: shortId('fld-'),
          name: it.name,
          items: convert(it.item),
          auth: authOf(it.auth, it.name ?? 'Folder'),
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
      const auth = authOf(r.auth, it.name ?? url, headers) ?? { type: 'inherit' as const };
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
    auth: authOf(d.auth, d.info?.name ?? 'Postman import'),
    preRequestScript: pmScript(d.event, 'prerequest'),
    testScript: pmScript(d.event, 'test'),
  });
  return { ...importScriptsToTp(collection, opts.scripts), notes };
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

/** The response a HAR entry recorded, kept as a saved example when it is a small JSON or text body (it lets a tidy chain ids and a mock answer). */
function harExample(res: any): { examples?: SavedExample[] } {
  const content = res?.content;
  const status = Number(res?.status);
  if (!status || typeof content?.text !== 'string' || content.encoding === 'base64' || content.text.length > 32_768) return {};
  if (!/json|text|xml/i.test(String(content.mimeType ?? ''))) return {};
  return { examples: [{ id: shortId('ex-'), name: `Captured ${status}`, status, ...(res.statusText ? { statusText: String(res.statusText) } : {}), headers: [], body: content.text }] };
}

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
      ...harExample(e.response),
    };
  });
  return { collection: newCollection(`HAR import ${new Date().toISOString().slice(0, 10)}`, items) };
}

export interface ImportAnyResult {
  format: string;
  collection?: Collection;
  environment?: Environment;
  environments?: Environment[];
  secretValues?: Record<string, Record<string, string>>;
  savedItems?: unknown;
  /** Everything that did not map one to one (unsupported auth, template tags, script APIs, values needed …), naming the item. */
  notes?: string[];
  scripts?: ImportScriptsSummary;
  flows?: ArazzoFlowFile[];
  /** A schema or definition to keep in the workspace (a GraphQL SDL: specs/graphql/<name>.graphql), relative to the workspace. */
  specFile?: { path: string; text: string };
}

/**
 * Import any supported document into a collection (and optionally an environment). Node ids (folders, requests) are
 * made unique: against `takenIds` (the workspace's other collections, `workspaceNodeIds`) and within the file, so an
 * imported collection never shares ids with another one (a TestPion file imported twice, say); a note says how many changed.
 */
export function importAny(text: string, opts: { name?: string; scripts?: ImportScriptsMode; takenIds?: Iterable<string> } = {}): ImportAnyResult {
  const r = importDocument(text, opts);
  if (!r.collection) return r;
  const { collection, renamed } = ensureUniqueIds(r.collection, opts.takenIds ?? []);
  if (!renamed.size) return r;
  const note = `${renamed.size} request and folder id${renamed.size === 1 ? ' was' : 's were'} renamed because another collection of the workspace (or the file itself) uses them`;
  return { ...r, collection, notes: [...(r.notes ?? []), note] };
}

function importDocument(text: string, opts: { name?: string; scripts?: ImportScriptsMode }): ImportAnyResult {
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
      return { format, collection: r.collection, environment: r.environments[0], environments: r.environments, savedItems: r.savedItems, scripts: r.scripts, ...(r.notes.length ? { notes: r.notes } : {}) };
    }
    case 'bruno': {
      const r = importBruno(text, { scripts: opts.scripts });
      return { format, collection: r.collection, environment: r.environments[0], environments: r.environments, scripts: r.scripts, ...(r.notes.length ? { notes: r.notes } : {}), ...(r.secretValues ? { secretValues: r.secretValues } : {}) };
    }
    case 'hoppscotch': {
      const r = importHoppscotch(text);
      return { format, collection: r.collection, ...(r.notes.length ? { notes: r.notes } : {}) };
    }
    case 'graphql-sdl': {
      const r = importGraphqlSdl(text, opts.name);
      return { format, collection: r.collection, notes: r.notes, specFile: r.specFile };
    }
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
      // a native import keeps its node ids: importAny makes them unique in the workspace (ensureUniqueIds)
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
        suggestions: ['Supported: OpenAPI 3 / Swagger 2 (JSON or YAML), Postman v2.1 collections & environments, Insomnia (v4 export, v5 YAML), Bruno collections (folder, .bru file or export), Hoppscotch collections, WSDL 1.1 and 2.0 (SOAP), AsyncAPI 2 and 3 (Kafka, MQTT, WebSocket), .http / .rest files (REST Client, JetBrains), .env files, HAR, GraphQL schemas (SDL), TestPion collections and workspace exports, Arazzo 1.0 workflows (as flow files).'],
      });
    }
  }
}
