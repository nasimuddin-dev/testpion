import { createHash } from 'node:crypto';
import type { ValidateFunction } from 'ajv';
import { parseYaml } from '../util/lazy-yaml.js';
import { ApsError } from '../errors.js';
import { registerCheck, type CheckContext } from '../eval/checks.js';
import type { CheckConfig, CheckResult } from '../model/types.js';
import { compileSchema } from '../util/json-schema.js';
import { BoundedMap } from '../util/collections.js';

/**
 * Contract testing against an OpenAPI 3.x (or Swagger 2.0) document: the response of a request must
 * be documented for its operation (status code, content type) and its body must match the schema.
 * Used by the `openapi` check.
 */

type Json = Record<string, unknown>;
export interface OpenApiDoc extends Json {
  openapi?: string;
  swagger?: string;
  paths?: Record<string, Json>;
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
/** Parsed documents by content hash: the newest 20 (a spec can be megabytes). */
const docs = new BoundedMap<string, OpenApiDoc>(20);

/** Parse an OpenAPI / Swagger document (YAML or JSON), cached by content. */
export function loadOpenApi(text: string): OpenApiDoc {
  const key = createHash('sha1').update(text).digest('hex');
  let d = docs.get(key);
  if (!d) {
    let parsed: unknown;
    try {
      parsed = parseYaml(text);
    } catch (e) {
      throw new ApsError('ValidationError', `The OpenAPI document is not valid YAML or JSON: ${(e as Error).message}`);
    }
    d = parsed as OpenApiDoc;
    if (!d || typeof d !== 'object' || !(d.openapi || d.swagger) || !d.paths) throw new ApsError('ValidationError', 'Not an OpenAPI 3 or Swagger 2 document (no "openapi"/"swagger" version or no "paths")');
    if (docs.size > 20) docs.clear();
    docs.set(key, d);
  }
  return d;
}

/** Base paths the API is served under (from `servers` or Swagger's `basePath`), longest first. */
function basePaths(doc: OpenApiDoc): string[] {
  const out = new Set<string>(['']);
  if (typeof doc.basePath === 'string') out.add(doc.basePath.replace(/\/$/, ''));
  for (const s of (doc.servers as Array<{ url?: string; variables?: Record<string, { default?: string }> }>) ?? []) {
    if (!s?.url) continue;
    const url = s.url.replace(/\{(\w+)\}/g, (_m, v: string) => s.variables?.[v]?.default ?? '');
    try {
      out.add(new URL(url, 'http://base.invalid').pathname.replace(/\/$/, ''));
    } catch {
      /* malformed server URL */
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export interface OpenApiOperation {
  path: string;
  method: string;
  operationId?: string;
  operation: Json;
  /** Path parameters taken from the URL. */
  params: Record<string, string>;
}

/** The operation a request maps to: literal paths win over templated ones (`/pets/mine` before `/pets/{id}`). */
export function findOperation(doc: OpenApiDoc, method: string, url: string): OpenApiOperation | undefined {
  let pathname: string;
  try {
    pathname = new URL(url, 'http://base.invalid').pathname;
  } catch {
    return undefined;
  }
  const m = method.toLowerCase();
  const candidates: Array<OpenApiOperation & { score: number }> = [];
  for (const base of basePaths(doc)) {
    if (base && !(pathname === base || pathname.startsWith(`${base}/`))) continue;
    const rest = pathname.slice(base.length) || '/';
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      const op = item?.[m] as Json | undefined;
      if (!op) continue;
      const names: string[] = [];
      // escape everything but the {param} placeholders, which match one path segment (not escapeRegex: the braces must stay as they are for the replace that follows)
      const re = new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{([^}]+)\}/g, (_x, name: string) => (names.push(name), '([^/]+)'))}/?$`);
      const hit = re.exec(rest);
      if (!hit) continue;
      const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(hit[i + 1]!)]));
      candidates.push({ path, method: m, operationId: op.operationId as string | undefined, operation: op, params, score: names.length * 1000 - base.length });
    }
    if (candidates.length) break;
  }
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  if (!best) return undefined;
  const { score: _s, ...op } = best;
  return op;
}

/** An operation by its operationId. */
function operationById(doc: OpenApiDoc, operationId: string): OpenApiOperation | undefined {
  for (const [path, item] of Object.entries(doc.paths ?? {}))
    for (const m of METHODS) {
      const op = item?.[m] as Json | undefined;
      if (op?.operationId === operationId) return { path, method: m, operationId, operation: op, params: {} };
    }
  return undefined;
}

/** OpenAPI 3.0 schema → JSON Schema: `nullable` becomes a null type; everything else is compatible. */
function toJsonSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (!s || typeof s !== 'object') return s;
  const o = Object.fromEntries(Object.entries(s as Json).map(([k, v]) => [k, toJsonSchema(v)])) as Json;
  if (o.nullable === true) {
    delete o.nullable;
    if (typeof o.type === 'string') o.type = [o.type, 'null'];
    else if (Array.isArray(o.type)) o.type = [...new Set([...(o.type as string[]), 'null'])];
    else return { anyOf: [o, { type: 'null' }] };
  }
  return o;
}

/** What is wrong with a value against a schema of the document (empty when it matches); for the linter's example checks. */
export function schemaProblems(doc: OpenApiDoc, schema: unknown, value: unknown): string[] {
  // the schema's $refs resolve against the document's sections, so they are part of the key
  const key = 'v:' + createHash('sha1').update(JSON.stringify([schema, doc.components ?? null, doc.definitions ?? null])).digest('hex');
  const v = validator(doc, schema, key);
  if (v(value)) return [];
  return (v.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || '(the value)'} ${e.message ?? 'is not valid'}`.trim());
}

function validator(doc: OpenApiDoc, schema: unknown, key: string): ValidateFunction {
  // references (#/components/…, #/definitions/…) resolve against the document's own sections
  return compileSchema(() => ({ ...(toJsonSchema(schema) as Json), components: toJsonSchema(doc.components ?? {}), definitions: toJsonSchema(doc.definitions ?? {}) }), key);
}

export interface ContractResult {
  passed: boolean;
  message: string;
  operation?: string;
  errors: string[];
}

/** Check a response against the operation's documented responses. */
export function validateAgainstOpenApi(
  doc: OpenApiDoc,
  req: { method: string; url: string },
  res: { status: number; contentType?: string; body: unknown; text?: string },
  opts: { operationId?: string } = {},
): ContractResult {
  const op = opts.operationId ? operationById(doc, opts.operationId) : findOperation(doc, req.method, req.url);
  if (!op) {
    const what = opts.operationId ? `operationId "${opts.operationId}"` : `${req.method.toUpperCase()} ${safePath(req.url)}`;
    return { passed: false, message: `${what} is not in the OpenAPI document`, errors: [] };
  }
  const label = `${op.method.toUpperCase()} ${op.path}${op.operationId ? ` (${op.operationId})` : ''}`;
  const responses = (op.operation.responses ?? {}) as Record<string, Json>;
  const code = String(res.status);
  const documented = responses[code] ?? responses[`${code[0]}XX`] ?? responses[`${code[0]}xx`] ?? responses.default;
  if (!documented) return { passed: false, operation: label, errors: [], message: `status ${res.status} is not documented for ${label} (documented: ${Object.keys(responses).join(', ') || 'none'})` };

  // OpenAPI 3: content by media type; Swagger 2: one schema
  let schema: unknown;
  const ct = (res.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const content = documented.content as Record<string, Json> | undefined;
  if (content && Object.keys(content).length) {
    const type = ct.split('/')[0];
    const media = content[ct] ?? content[`${type}/*`] ?? content['*/*'] ?? (/[+/]json$/.test(ct) ? Object.entries(content).find(([k]) => /json/.test(k))?.[1] : undefined);
    if (!media) {
      const empty = res.text === '' || res.body === '' || res.body === undefined;
      if (empty && !ct) return { passed: true, operation: label, errors: [], message: `status ${res.status} documented for ${label} (no body)` };
      return { passed: false, operation: label, errors: [], message: `content type "${ct || 'none'}" is not documented for ${label} ${res.status} (documented: ${Object.keys(content).join(', ')})` };
    }
    schema = media.schema;
  } else if (doc.swagger) schema = documented.schema;
  if (!schema) return { passed: true, operation: label, errors: [], message: `status ${res.status} documented for ${label} (no schema to check the body against)` };

  let data = res.body;
  if (typeof data === 'string' && /json/.test(ct)) {
    try {
      data = JSON.parse(data);
    } catch {
      return { passed: false, operation: label, errors: [], message: `the body is not valid JSON, but ${label} documents a JSON schema` };
    }
  }
  const pointer = `${op.path}|${op.method}|${code}|${ct}`;
  const v = validator(doc, schema, `${createHash('sha1').update(JSON.stringify(doc.info ?? {}) + JSON.stringify(schema)).digest('hex')}|${pointer}`);
  const ok = v(data) as boolean;
  const errors = ok ? [] : (v.errors ?? []).map((e) => `${e.instancePath || '$'} ${e.message}${e.params && 'additionalProperty' in e.params ? ` (${String(e.params.additionalProperty)})` : ''}${e.params && 'allowedValues' in e.params ? `: ${(e.params.allowedValues as unknown[]).join(', ')}` : ''}`);
  return {
    passed: ok,
    operation: label,
    errors,
    message: ok ? `matches ${label} ${documented === responses[code] ? res.status : 'response'} schema` : `does not match ${label} ${res.status} schema: ${errors.slice(0, 5).join('; ')}`,
  };
}

const safePath = (url: string) => {
  try {
    return new URL(url, 'http://base.invalid').pathname;
  } catch {
    return url;
  }
};

/**
 * `openapi` check: `spec` is a workspace file (openapi.yaml) or the document itself; `operationId`
 * is optional (by default the operation is found from the request's method and URL).
 */
registerCheck('openapi', (cfg: CheckConfig, ctx: CheckContext): CheckResult => {
  const res = (passed: boolean, message: string, extra: Partial<CheckResult> = {}): CheckResult => ({ type: cfg.type, name: cfg.name ?? 'OpenAPI contract', passed, source: 'deterministic', message, ...extra });
  if (!ctx.request) return res(false, 'The openapi check applies to HTTP requests');
  let doc: OpenApiDoc;
  try {
    if (cfg.spec && typeof cfg.spec === 'object') doc = cfg.spec as OpenApiDoc;
    else if (typeof cfg.spec === 'string' && cfg.spec.trim()) {
      if (!ctx.readFile) return res(false, 'OpenAPI files can only be read inside a workspace; put the document inline in "spec"');
      doc = loadOpenApi(ctx.readFile(cfg.spec));
    } else return res(false, 'Set "spec" to the OpenAPI document (a workspace file such as openapi.yaml)');
  } catch (e) {
    return res(false, `Could not load the OpenAPI document: ${(e as Error).message}`);
  }
  const r = validateAgainstOpenApi(doc, ctx.request, { status: ctx.status ?? 0, contentType: ctx.headers?.find(([k]) => k.toLowerCase() === 'content-type')?.[1], body: ctx.body, text: ctx.text }, { operationId: typeof cfg.operationId === 'string' ? cfg.operationId : undefined });
  return res(r.passed, r.message, { metadata: { operation: r.operation, errors: r.errors.slice(0, 50) } });
});

/**
 * The JSON Schema of the body a request should send, from the operation its method and URL map to: an OpenAPI 3
 * `requestBody` (application/json, or the first JSON-like content type) or a Swagger 2 body parameter. `$ref`s stay
 * as written, with the document's components / definitions beside the schema, so a JSON editor can follow them.
 */
export function requestBodySchema(doc: OpenApiDoc, method: string, url: string): { schema: Json; contentType: string; operationId?: string; path: string; summary?: string } | undefined {
  const op = findOperation(doc, method, url);
  if (!op) return undefined;
  const o = op.operation;
  let schema: Json | undefined;
  let contentType = 'application/json';
  const content = (o.requestBody as { content?: Record<string, { schema?: Json }> } | undefined)?.content;
  if (content) {
    const ct = Object.keys(content).find((k) => /json/i.test(k)) ?? Object.keys(content)[0];
    if (ct) {
      contentType = ct;
      schema = content[ct]?.schema;
    }
  } else {
    const body = ((o.parameters as Array<{ in?: string; schema?: Json }> | undefined) ?? []).find((p) => p.in === 'body');
    schema = body?.schema;
  }
  if (!schema || typeof schema !== 'object') return undefined;
  const extra: Json = {};
  if (doc.components) extra.components = doc.components;
  if (doc.definitions) extra.definitions = doc.definitions;
  return { schema: { ...schema, ...extra }, contentType, operationId: op.operationId, path: `${op.method.toUpperCase()} ${op.path}`, summary: typeof o.summary === 'string' ? o.summary : undefined };
}
