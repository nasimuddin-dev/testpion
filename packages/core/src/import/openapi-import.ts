import type { AuthConfig, BodyConfig, Collection, CollectionFolder, CollectionNode, Environment, KeyValue, SavedExample, SavedHttpRequest } from '../model/types.js';
import { SCHEMA_VERSION } from '../model/types.js';
import { parseYaml } from '../util/lazy-yaml.js';
import { ApsError } from '../errors.js';
import { shortId, slugify } from '../util/ids.js';
import { deref } from '../util/json-ref.js';
import { successCode } from '../openapi/outline.js';
import { newDocument, type ImportDocument } from './model.js';

function newCollection(name: string, items: CollectionNode[], extra: Partial<Collection> = {}): Collection {
  return { schemaVersion: SCHEMA_VERSION, id: slugify(name) + '-' + shortId().slice(-4), name, version: 0, variables: [], items, updatedAt: new Date().toISOString(), ...extra };
}

/** OpenAPI 2 / 3 / 3.1 (JSON or YAML) as an import document: a request per operation, folders by tag, saved examples from the responses. */
export function parseOpenApi(text: string, format: 'openapi' | 'swagger' = 'openapi'): ImportDocument {
  const r = importOpenApi(text);
  return newDocument(format, text, { tool: format === 'swagger' ? 'Swagger' : 'OpenAPI', collections: [r.collection] });
}

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

