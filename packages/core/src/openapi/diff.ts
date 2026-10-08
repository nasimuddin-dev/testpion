import { loadOpenApi, type OpenApiDoc } from './contract.js';
import { deref, typeOf as schemaType } from '../util/json-ref.js';

/**
 * Breaking-change report between two versions of an OpenAPI 3 / Swagger 2 document, for CI
 * (`testpion openapi-diff old.yaml new.yaml --fail-on-breaking`) and AI agents (MCP `openapi_diff`).
 *
 * Breaking means an existing client can fail: an operation or a documented success response is gone,
 * a request needs something new (a required parameter or body field), a type changed, a response
 * field clients may read was removed or became optional, or a request enum lost a value.
 */
export interface ApiChange {
  level: 'breaking' | 'non-breaking';
  /** Machine-readable kind, e.g. `operation-removed`, `parameter-required`, `response-property-removed`. */
  kind: string;
  /** `GET /pets/{id}`, or the operation plus where inside it. */
  where: string;
  message: string;
}

export interface OpenApiDiff {
  breaking: ApiChange[];
  nonBreaking: ApiChange[];
  operations: { old: number; new: number; added: number; removed: number };
}

type Json = Record<string, any>;
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const MAX_DEPTH = 10;

/** Every non-null type of a schema (`string|integer`), inferred from properties / items when it does not say. */
const typeOf = (s: any) => (s && typeof s === 'object' ? schemaType(s, { infer: true, all: true }) : undefined);

/** Operations by `METHOD /path` with path parameters normalised (`/pets/{id}` = `/pets/{petId}`). */
function operations(doc: OpenApiDoc): Map<string, { label: string; op: Json; pathItem: Json }> {
  const out = new Map<string, { label: string; op: Json; pathItem: Json }>();
  for (const [path, item0] of Object.entries(doc.paths ?? {})) {
    const item = deref(doc, item0) as Json;
    for (const m of METHODS) {
      const op = item?.[m];
      if (!op) continue;
      out.set(`${m.toUpperCase()} ${path.replace(/\{[^}]+\}/g, '{}')}`, { label: `${m.toUpperCase()} ${path}`, op, pathItem: item });
    }
  }
  return out;
}

function parameters(doc: OpenApiDoc, pathItem: Json, op: Json): Map<string, Json> {
  const out = new Map<string, Json>();
  for (const p0 of [...(pathItem.parameters ?? []), ...(op.parameters ?? [])]) {
    const p = deref(doc, p0);
    if (!p?.name || !p.in || p.in === 'body') continue;
    // path parameters are matched by position, not name
    out.set(p.in === 'path' ? `path:#${[...out.keys()].filter((k) => k.startsWith('path:')).length}` : `${p.in}:${String(p.name).toLowerCase()}`, p);
  }
  return out;
}

/** The JSON schema of a request body (OpenAPI 3 requestBody, Swagger 2 body parameter). */
function requestSchema(doc: OpenApiDoc, pathItem: Json, op: Json): { schema?: any; required: boolean } {
  if (op.requestBody) {
    const rb = deref(doc, op.requestBody);
    const content = rb?.content ?? {};
    const ct = Object.keys(content).find((k) => /json/.test(k)) ?? Object.keys(content)[0];
    return { schema: ct ? content[ct]?.schema : undefined, required: !!rb?.required };
  }
  const body = [...(pathItem.parameters ?? []), ...(op.parameters ?? [])].map((p) => deref(doc, p)).find((p) => p?.in === 'body');
  return body ? { schema: body.schema, required: !!body.required } : { required: false };
}

function responseSchema(doc: OpenApiDoc, response: any): any {
  const r = deref(doc, response);
  if (!r) return undefined;
  if (r.schema) return r.schema;
  const content = r.content ?? {};
  const ct = Object.keys(content).find((k) => /json/.test(k)) ?? Object.keys(content)[0];
  return ct ? content[ct]?.schema : undefined;
}

/**
 * Compare two schemas. `direction` decides what breaks: in a request, new required fields and
 * narrowed enums break clients; in a response, removed fields (or fields that became optional) do.
 */
function compareSchemas(a: { doc: OpenApiDoc; s: any }, b: { doc: OpenApiDoc; s: any }, direction: 'request' | 'response', where: string, push: (c: Omit<ApiChange, 'where'> & { at: string }) => void, depth = 0, seen = new Set<string>()): void {
  if (depth > MAX_DEPTH) return;
  // a recursive schema: compare each $ref pair once
  const key = `${a.s?.$ref ?? ''}|${b.s?.$ref ?? ''}|${direction}`;
  if (a.s?.$ref && b.s?.$ref) {
    if (seen.has(key)) return;
    seen = new Set(seen).add(key);
  }
  const x = deref(a.doc, a.s);
  const y = deref(b.doc, b.s);
  if (!x || !y) return;
  const tx = typeOf(x);
  const ty = typeOf(y);
  if (tx && ty && tx !== ty && !(tx === 'integer' && ty === 'number' && direction === 'request') && !(tx === 'number' && ty === 'integer' && direction === 'response')) {
    push({ level: 'breaking', kind: `${direction}-type-changed`, at: where, message: `type changed from ${tx} to ${ty}` });
    return;
  }
  if (Array.isArray(x.enum) && Array.isArray(y.enum)) {
    const removed = x.enum.filter((v: unknown) => !y.enum.some((w: unknown) => JSON.stringify(w) === JSON.stringify(v)));
    const added = y.enum.filter((v: unknown) => !x.enum.some((w: unknown) => JSON.stringify(w) === JSON.stringify(v)));
    if (direction === 'request' && removed.length) push({ level: 'breaking', kind: 'request-enum-narrowed', at: where, message: `no longer accepts ${removed.map((v: unknown) => JSON.stringify(v)).join(', ')}` });
    if (direction === 'response' && added.length) push({ level: 'non-breaking', kind: 'response-enum-widened', at: where, message: `can now return ${added.map((v: unknown) => JSON.stringify(v)).join(', ')} (clients with a closed list of values may need an update)` });
  }
  if ((tx ?? ty) === 'array') {
    compareSchemas({ doc: a.doc, s: x.items }, { doc: b.doc, s: y.items }, direction, `${where}[]`, push, depth + 1, seen);
    return;
  }
  const px: Json = x.properties ?? {};
  const py: Json = y.properties ?? {};
  const rx = new Set<string>(x.required ?? []);
  const ry = new Set<string>(y.required ?? []);
  const field = (k: string) => (where ? `${where}.${k}` : k);
  for (const k of Object.keys(px)) {
    if (!(k in py)) {
      if (direction === 'response') push({ level: 'breaking', kind: 'response-property-removed', at: field(k), message: 'removed from the response' });
      else push({ level: 'non-breaking', kind: 'request-property-removed', at: field(k), message: 'no longer documented in the request' });
      continue;
    }
    if (direction === 'response' && rx.has(k) && !ry.has(k)) push({ level: 'breaking', kind: 'response-property-optional', at: field(k), message: 'was always returned, now optional' });
    if (direction === 'request' && !rx.has(k) && ry.has(k)) push({ level: 'breaking', kind: 'request-property-required', at: field(k), message: 'is now required' });
    compareSchemas({ doc: a.doc, s: px[k] }, { doc: b.doc, s: py[k] }, direction, field(k), push, depth + 1, seen);
  }
  for (const k of Object.keys(py)) {
    if (k in px) continue;
    if (direction === 'request' && ry.has(k)) push({ level: 'breaking', kind: 'request-property-required', at: field(k), message: 'new required field' });
    else push({ level: 'non-breaking', kind: `${direction}-property-added`, at: field(k), message: direction === 'request' ? 'new optional field' : 'new field' });
  }
}

/** Compare two OpenAPI / Swagger documents (YAML or JSON text). */
export function diffOpenApi(oldText: string, newText: string): OpenApiDiff {
  const a = loadOpenApi(oldText);
  const b = loadOpenApi(newText);
  const changes: ApiChange[] = [];
  const oa = operations(a);
  const ob = operations(b);
  let added = 0;
  let removed = 0;
  for (const [key, o] of oa) {
    const n = ob.get(key);
    if (!n) {
      removed++;
      changes.push({ level: 'breaking', kind: 'operation-removed', where: o.label, message: 'operation removed' });
      continue;
    }
    const where = n.label;
    const at = (c: Omit<ApiChange, 'where'> & { at: string }, prefix: string) => changes.push({ level: c.level, kind: c.kind, where: `${where} ${prefix}${c.at ? ` ${c.at}` : ''}`.trim(), message: c.message });
    if (!o.op.deprecated && n.op.deprecated) changes.push({ level: 'non-breaking', kind: 'operation-deprecated', where, message: 'deprecated' });

    // parameters
    const pa = parameters(a, o.pathItem, o.op);
    const pb = parameters(b, n.pathItem, n.op);
    for (const [k, p] of pa) {
      const q = pb.get(k);
      if (!q) {
        if (p.in !== 'path') changes.push({ level: 'non-breaking', kind: 'parameter-removed', where, message: `${p.in} parameter "${p.name}" removed` });
        continue;
      }
      if (!p.required && q.required) changes.push({ level: 'breaking', kind: 'parameter-required', where, message: `${q.in} parameter "${q.name}" is now required` });
      const t1 = typeOf(p.schema ?? p);
      const t2 = typeOf(q.schema ?? q);
      if (t1 && t2 && t1 !== t2) changes.push({ level: 'breaking', kind: 'parameter-type-changed', where, message: `${q.in} parameter "${q.name}" type changed from ${t1} to ${t2}` });
      const e1 = (p.schema ?? p).enum;
      const e2 = (q.schema ?? q).enum;
      if (Array.isArray(e1) && Array.isArray(e2)) {
        const gone = e1.filter((v: unknown) => !e2.includes(v));
        if (gone.length) changes.push({ level: 'breaking', kind: 'parameter-enum-narrowed', where, message: `${q.in} parameter "${q.name}" no longer accepts ${gone.map((v: unknown) => JSON.stringify(v)).join(', ')}` });
      }
    }
    for (const [k, q] of pb) {
      if (pa.has(k)) continue;
      if (q.required) changes.push({ level: 'breaking', kind: 'parameter-required', where, message: `new required ${q.in} parameter "${q.name}"` });
      else changes.push({ level: 'non-breaking', kind: 'parameter-added', where, message: `new optional ${q.in} parameter "${q.name}"` });
    }

    // request body
    const ra = requestSchema(a, o.pathItem, o.op);
    const rb = requestSchema(b, n.pathItem, n.op);
    if (!ra.required && rb.required) changes.push({ level: 'breaking', kind: 'request-body-required', where, message: 'the request body is now required' });
    if (ra.schema && rb.schema) compareSchemas({ doc: a, s: ra.schema }, { doc: b, s: rb.schema }, 'request', '', (c) => at(c, 'request body'));

    // responses
    const resA: Json = o.op.responses ?? {};
    const resB: Json = n.op.responses ?? {};
    for (const code of Object.keys(resA)) {
      if (!(code in resB)) {
        if (/^2/.test(code)) changes.push({ level: 'breaking', kind: 'response-removed', where, message: `the ${code} response is no longer documented` });
        else changes.push({ level: 'non-breaking', kind: 'response-removed', where, message: `the ${code} response is no longer documented` });
        continue;
      }
      const sa = responseSchema(a, resA[code]);
      const sb = responseSchema(b, resB[code]);
      if (sa && sb) compareSchemas({ doc: a, s: sa }, { doc: b, s: sb }, 'response', '', (c) => at(c, `response ${code}`));
    }
    for (const code of Object.keys(resB)) if (!(code in resA)) changes.push({ level: 'non-breaking', kind: 'response-added', where, message: `new ${code} response` });
  }
  for (const [key, n] of ob)
    if (!oa.has(key)) {
      added++;
      changes.push({ level: 'non-breaking', kind: 'operation-added', where: n.label, message: 'new operation' });
    }
  return {
    breaking: changes.filter((c) => c.level === 'breaking'),
    nonBreaking: changes.filter((c) => c.level === 'non-breaking'),
    operations: { old: oa.size, new: ob.size, added, removed },
  };
}
