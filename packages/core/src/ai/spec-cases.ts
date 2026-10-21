/**
 * AI-4 · the deterministic half of the tests from an OpenAPI document (spec-tests.ts is the task around it): what a case is,
 * how its request and expected status are built from the document's valid example, how a case (or a step of a test file) is
 * validated against the document, the checks that come from the document, and the cases that close the gaps without a model.
 */
import type { HttpRequestSpec, KeyValue } from '../model/types.js';
import { type FuzzCase } from '../openapi/fuzz.js';
import { findOperation, schemaProblems, type OpenApiDoc } from '../openapi/contract.js';
import { successCode } from '../openapi/outline.js';
import { stepRequestKeys } from '../openapi/tests-from-spec.js';
import { bodySchemaOf, matchUrl, propertiesOf, SPEC_CATEGORIES, specOperations, type ExistingRequest, type SpecCategory, type SpecGapReport, type SpecOperation } from '../openapi/spec-gaps.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { deref, typeOf } from '../util/json-ref.js';

export type Json = Record<string, any>;

/** At most this many tests are proposed in one go (the review stays readable; ask again for the rest). */
export const SPEC_MAX_CASES = 120;
/** At most this many operations are described to the model. */
export const MAX_CONTEXT_OPERATIONS = 40;
export const MAX_SPEC_BYTES = 3 * 1024 * 1024;

/** A test to propose: a request built from the document's valid example, the status to expect and why. */
export interface SpecCase {
  operation: string;
  category: SpecCategory;
  name: string;
  /** valid, missing-required, wrong-type …, at-limit, no-auth, not-found, or `ai`. */
  mutation: string;
  request: HttpRequestSpec;
  /** The statuses the response may have: `201`, `4xx`, `[401, 403]`. */
  expect: Array<number | string>;
  /** The request should be accepted (a 2xx) rather than refused. */
  accept: boolean;
  origin: 'draft' | 'ai';
  why?: string;
}

export interface SpecTestOptions {
  categories?: SpecCategory[];
  /** Operations (`POST /patients`, an operationId) the tests are for; default every operation with a gap. */
  operations?: string[];
  /** Only what the gaps need (default). False: every category for every operation in scope. */
  gapsOnly?: boolean;
  /** DELETE operations get tests too (they destroy data). */
  includeDelete?: boolean;
}

/** What `prepare` keeps on this computer for building the files (never sent). */
export interface SpecLocal {
  /** The workspace the files are named against (a file that exists is never the default target). */
  store?: WorkspaceStore;
  spec: string;
  text: string;
  api: string;
  existing: ExistingRequest[];
  report: SpecGapReport;
  options: Required<Omit<SpecTestOptions, 'operations'>> & { operations?: string[] };
  /** The operations in scope, by key. */
  scope: string[];
  ops: Map<string, SpecOperation>;
  /** The valid example of each operation (fuzz). */
  valid: Map<string, FuzzCase>;
  /** The whole fuzz set by operation, for the deterministic cases. */
  fuzz: FuzzCase[];
  draft: SpecCase[];
  path?: string;
}

/* ------------------------------------------------------------------ the request, the expectation */

export const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** The JSON body of a request, when it has one. */
export function jsonBody(r: HttpRequestSpec): unknown {
  const b = r.body as { type?: string; content?: string } | undefined;
  if (!b || typeof b.content !== 'string') return undefined;
  try {
    return JSON.parse(b.content);
  } catch {
    return undefined;
  }
}
export const withJsonBody = (r: HttpRequestSpec, v: unknown): HttpRequestSpec => ({ ...r, body: { type: 'json', content: JSON.stringify(v) } as HttpRequestSpec['body'] });

/** The URL of an operation with its path values replaced (the host stays {{baseUrl}}). */
export function urlWithPath(op: SpecOperation, values: Record<string, string>): string {
  return '{{baseUrl}}' + op.path.replace(/\{([^}]+)\}/g, (_m, n: string) => encodeURIComponent(values[n] ?? 'example'));
}

/** What the document documents for a success: `201`, else a `2xx` class. */
export function successExpect(op: SpecOperation): Array<number | string> {
  const c = successCode(op.responses);
  if (!c) return ['2xx'];
  return /^\d{3}$/.test(c) ? [Number(c)] : ['2xx'];
}

/** The expected status of a model's case made one the document allows: documented, or a class; `undefined` when it cannot fit the category. */
export function normalizeExpect(raw: unknown, op: SpecOperation, accept: boolean): { expect: Array<number | string>; note?: string } | undefined {
  const list = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (!list.length) return undefined;
  const out: Array<number | string> = [];
  let note: string | undefined;
  for (const s of list) {
    if (/^[1-5]xx$/.test(s)) out.push(s);
    else if (/^\d{3}$/.test(s)) {
      const documented = op.responses.some((r) => r === s || (/^\dxx$/i.test(r) && r[0] === s[0]));
      if (documented) out.push(Number(s));
      else {
        out.push(`${s[0]}xx`);
        note = `status ${s} is not documented for ${op.key}: ${s[0]}xx is asserted instead`;
      }
    } else return undefined;
  }
  const uniq = [...new Set(out)];
  if (accept ? !uniq.every((s) => String(s).startsWith('2')) : !uniq.every((s) => String(s).startsWith('4'))) return undefined;
  return { expect: uniq, note };
}

/* ------------------------------------------------------------------ validating a case against the document */

/** A request reduced to what the validation reads (from a built case or a step of a test file). */
export interface CaseView {
  method: string;
  url: string;
  query: Record<string, string>;
  headers: string[];
  body: unknown;
  hasAuth: boolean;
  expect: Array<number | string>;
  category: SpecCategory;
  accept: boolean;
}

const urlQuery = (url: string): Record<string, string> => {
  const q = url.split('#')[0]!.split('?')[1];
  const out: Record<string, string> = {};
  if (q) for (const p of q.split('&')) if (p) out[decodeURIComponent(p.split('=')[0]!)] = decodeURIComponent((p.split('=')[1] ?? '').replace(/\+/g, ' '));
  return out;
};
const kvMap = (kv: KeyValue[] | undefined): Record<string, string> => Object.fromEntries((kv ?? []).filter((p) => p.enabled !== false && p.key).map((p) => [p.key, p.value]));

export function viewOfCase(c: SpecCase): CaseView {
  const r = c.request;
  return {
    method: r.method,
    url: r.url,
    query: { ...urlQuery(r.url), ...kvMap(r.params) },
    headers: (r.headers ?? []).filter((h) => h.enabled !== false).map((h) => h.key.toLowerCase()),
    body: jsonBody(r) ?? (r.body && (r.body as { content?: string }).content !== undefined ? (r.body as { content: string }).content : undefined),
    hasAuth: (!!r.auth && r.auth.type !== 'none' && r.auth.type !== 'inherit') || (r.headers ?? []).some((h) => h.key.toLowerCase() === 'authorization'),
    expect: c.expect,
    category: c.category,
    accept: c.accept,
  };
}

/** A step of a test file as a view; the category is its tag, else read from the statuses it expects. */
export function viewOfStep(step: Json): CaseView | undefined {
  const r = (step.request && typeof step.request === 'object' ? { ...step, ...step.request } : step) as Json;
  if (typeof r.method !== 'string' || typeof r.url !== 'string') return undefined;
  const checks = (Array.isArray(step.assertions) ? step.assertions : []) as Json[];
  const statuses = checks.filter((a) => a?.type === 'status' || a?.type === 'http-status').flatMap((a) => (Array.isArray(a.expected) ? a.expected : [a.expected ?? 200]));
  const expect = statuses.map((s) => (typeof s === 'number' ? s : String(s).toLowerCase())) as Array<number | string>;
  const tags = (Array.isArray(step.tags) ? step.tags : []).map(String);
  const accept = expect.length ? expect.every((s) => String(s).startsWith('2')) : true;
  const tagged = tags.find((t) => (SPEC_CATEGORIES as readonly string[]).includes(t)) as SpecCategory | undefined;
  const params = r.params;
  const headers = r.headers && typeof r.headers === 'object' ? (Array.isArray(r.headers) ? (r.headers as KeyValue[]).map((h) => h.key) : Object.keys(r.headers)) : [];
  let body: unknown = r.body;
  if (body && typeof body === 'object' && 'content' in (body as object) && typeof (body as { content?: unknown }).content === 'string') {
    try {
      body = JSON.parse((body as { content: string }).content);
    } catch {
      body = (body as { content: string }).content;
    }
  }
  const auth = r.auth as { type?: string } | undefined;
  return {
    method: r.method.toUpperCase(),
    url: r.url,
    query: { ...urlQuery(r.url), ...(Array.isArray(params) ? kvMap(params as KeyValue[]) : params && typeof params === 'object' ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) : {}) },
    headers: headers.map((h) => h.toLowerCase()),
    body,
    hasAuth: (!!auth && auth.type !== 'none' && auth.type !== 'inherit') || headers.some((h) => h.toLowerCase() === 'authorization'),
    expect,
    category: tagged ?? (accept ? 'positive' : 'negative'),
    accept,
  };
}

export interface CaseIssue {
  level: 'fail' | 'warn';
  message: string;
}

const coerce = (schema: Json | undefined, v: string): unknown => {
  const t = typeOf(schema);
  if (t === 'integer' || t === 'number') return v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
  if (t === 'boolean') return v === 'true' ? true : v === 'false' ? false : v;
  return v;
};

/** Everything wrong (fail) or doubtful (warn) with a case, judged by the document alone. */
export function caseIssues(doc: OpenApiDoc, view: CaseView, valid?: CaseView): { op?: SpecOperation; issues: CaseIssue[] } {
  const issues: CaseIssue[] = [];
  const hit = findOperation(doc, view.method, matchUrl(view.url));
  if (!hit) return { issues: [{ level: 'fail', message: `${view.method} ${matchUrl(view.url).replace('http://api.local', '') || '/'} is not an operation of the document` }] };
  const ops = specOperations(doc);
  const op = ops.find((o) => o.key === `${hit.method.toUpperCase()} ${hit.path}`);
  if (!op) return { issues: [{ level: 'fail', message: `${hit.method.toUpperCase()} ${hit.path} is not an operation of the document` }] };
  const d = doc as Json;
  if (!view.expect.length) issues.push({ level: 'fail', message: 'it checks no status' });
  else if (view.accept ? !view.expect.every((s) => String(s).startsWith('2')) : !view.expect.every((s) => /^4/.test(String(s)))) issues.push({ level: 'fail', message: `a ${view.accept ? 'valid' : 'refused'} request cannot expect ${view.expect.join(' or ')}` });
  for (const s of view.expect)
    if (typeof s === 'number' && !op.responses.some((r) => r === String(s) || (/^\dxx$/i.test(r) && r[0] === String(s)[0])) && view.accept)
      issues.push({ level: 'warn', message: `status ${s} is not documented for ${op.key}` });
  const body = bodySchemaOf(d, op.op, op.item);
  const required = op.params.filter((p) => p.required && p.in !== 'path');
  const bodyProblems = (): string[] => {
    if (!body) return [];
    if (view.body === undefined) return body.required ? ['the body is required and missing'] : [];
    if (typeof view.body === 'string') return ['the body is not JSON'];
    return schemaProblems(doc, body.schema, view.body);
  };
  const paramProblems = (): string[] => {
    const out: string[] = [];
    for (const p of required) {
      if (p.in === 'query' && !(p.name in view.query)) out.push(`required query parameter "${p.name}" is missing`);
      if (p.in === 'header' && !view.headers.includes(p.name.toLowerCase())) out.push(`required header "${p.name}" is missing`);
    }
    const all = [...asArray(op.op.parameters), ...asArray(op.item.parameters)].map((p) => deref(d, p) as Json).filter(Boolean);
    for (const p of all)
      if (p.in === 'query' && p.name in view.query && !/\{\{.*\}\}/.test(view.query[p.name]!)) {
        const s = deref(d, p.schema ?? p) as Json;
        const probs = schemaProblems(doc, s, coerce(s, view.query[p.name]!));
        if (probs.length) out.push(`query "${p.name}": ${probs[0]}`);
      }
    // a path value in the URL itself
    for (const [name, value] of Object.entries(hit.params)) {
      if (/\{\{.*\}\}/.test(value)) continue;
      const p = all.find((x) => x.in === 'path' && x.name === name);
      if (!p) continue;
      const s = deref(d, p.schema ?? p) as Json;
      const probs = schemaProblems(doc, s, coerce(s, value));
      if (probs.length) out.push(`path {${name}}: ${probs[0]}`);
    }
    return out;
  };
  if (view.category === 'security') {
    if (view.hasAuth) issues.push({ level: 'fail', message: 'a security case must send no credentials' });
    if (!op.secured) issues.push({ level: 'warn', message: `${op.key} is not secured in the document: a 401/403 is not documented` });
    return { op, issues };
  }
  if (view.accept) {
    for (const m of [...bodyProblems(), ...paramProblems()]) issues.push({ level: 'fail', message: `it should be accepted but breaks the document: ${m}` });
    if (op.secured && !view.hasAuth) issues.push({ level: 'warn', message: 'it sends no credentials, and the operation is secured' });
  } else {
    const broken = [...bodyProblems(), ...paramProblems()];
    const same = valid && JSON.stringify([view.url, view.query, view.headers, view.body]) === JSON.stringify([valid.url, valid.query, valid.headers, valid.body]);
    if (same) issues.push({ level: 'fail', message: 'it sends the same request as the valid example, so it cannot be refused' });
    // an id that does not exist is the rule itself (404 on a path with an id)
    else if (!broken.length && !(view.expect.every((s) => s === 404) && Object.keys(hit.params).length)) issues.push({ level: 'warn', message: 'the request satisfies the document: a 4xx needs a rule the document does not state (a duplicate, a state, a permission)' });
  }
  return { op, issues };
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/* ------------------------------------------------------------------ the checks, from the document */

/** A shallow JSON Schema of the success response (type, required fields and their types): the `json-schema` check. */
export function shallowSchema(doc: OpenApiDoc, op: SpecOperation): Json | undefined {
  const d = doc as Json;
  const code = successCode(op.responses);
  if (!code) return undefined;
  const resp = deref(d, (op.op.responses as Json)[code]) as Json | undefined;
  let schema: Json | undefined;
  if (d.swagger) schema = resp?.schema;
  else {
    const ct = Object.keys(resp?.content ?? {}).find((k) => /json/.test(k));
    schema = ct ? resp?.content[ct]?.schema : undefined;
  }
  const s = deref(d, schema) as Json | undefined;
  if (!s || typeof s !== 'object') return undefined;
  const t = typeOf(s, { infer: true });
  if (t === 'array') return { type: 'array' };
  if (t !== 'object') return undefined;
  const { properties, required } = propertiesOf(d, s);
  const props: Json = {};
  for (const [k, v] of Object.entries(properties)) {
    const ps = deref(d, v) as Json;
    const pt = typeOf(ps, { infer: true });
    if (pt) props[k] = { type: ps.nullable === true ? [pt, 'null'] : pt };
  }
  return { type: 'object', ...(required.length ? { required: [...new Set(required)] } : {}), ...(Object.keys(props).length ? { properties: props } : {}) };
}

/** The checks of a case: the status, and for an accepted one the contract, the shallow schema and a latency limit. */
function checksOf(c: SpecCase, op: SpecOperation | undefined, doc: OpenApiDoc, spec: string): Array<Record<string, unknown>> {
  const status = { type: 'status', expected: c.expect.length === 1 ? c.expect[0] : c.expect };
  if (!c.accept) return [status];
  const out: Array<Record<string, unknown>> = [status, { type: 'openapi', spec }];
  const schema = op ? shallowSchema(doc, op) : undefined;
  if (schema) out.push({ type: 'json-schema', schema });
  out.push({ type: 'latency', max: 2000 });
  return out;
}

/** The step of a test file for a case. */
export function stepOf(c: SpecCase, id: string, op: SpecOperation | undefined, doc: OpenApiDoc, spec: string): Record<string, unknown> {
  const r = c.request;
  const body = jsonBody(r);
  const headers = (r.headers ?? []).filter((h) => h.enabled !== false && (h.key.toLowerCase() !== 'content-type' || (body === undefined && !!r.body && r.body.type !== 'none')));
  const raw = r.body && 'content' in r.body ? (r.body as { content: string }).content : undefined;
  return {
    id,
    name: c.name,
    tags: ['spec-gap', c.category, ...(c.origin === 'ai' ? ['ai'] : [])],
    ...stepRequestKeys(r, headers),
    ...(body !== undefined ? { body } : raw !== undefined ? { body: { type: 'json', content: raw } } : {}),
    assertions: checksOf(c, op, doc, spec),
  };
}

/* ------------------------------------------------------------------ the deterministic cases */

export const titleOf = (op: SpecOperation) => op.summary ?? op.operationId ?? op.key;

/** Cases that put a value at a documented limit (accepted) — the beyond-the-limit ones are the fuzz set's. */
function atLimitCases(doc: OpenApiDoc, op: SpecOperation, valid: FuzzCase): SpecCase[] {
  const d = doc as Json;
  const out: SpecCase[] = [];
  const expect = successExpect(op);
  const limits = (s: Json): Array<{ value: unknown; why: string }> => {
    const t = typeOf(s, { infer: true });
    const l: Array<{ value: unknown; why: string }> = [];
    if (t === 'string' && typeof s.maxLength === 'number' && s.maxLength > 0 && s.maxLength <= 1000 && !s.enum && !s.format) l.push({ value: 'x'.repeat(s.maxLength), why: `exactly maxLength ${s.maxLength}` });
    if (t === 'string' && typeof s.minLength === 'number' && s.minLength > 0 && s.minLength <= 1000 && !s.enum && !s.format) l.push({ value: 'x'.repeat(s.minLength), why: `exactly minLength ${s.minLength}` });
    if ((t === 'integer' || t === 'number') && typeof s.maximum === 'number' && !s.exclusiveMaximum) l.push({ value: s.maximum, why: `exactly maximum ${s.maximum}` });
    if ((t === 'integer' || t === 'number') && typeof s.minimum === 'number' && !s.exclusiveMinimum) l.push({ value: s.minimum, why: `exactly minimum ${s.minimum}` });
    return l;
  };
  const body = jsonBody(valid.request);
  const bs = bodySchemaOf(d, op.op, op.item);
  if (bs && body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [k, ps0] of Object.entries(propertiesOf(d, bs.schema).properties)) {
      const ps = deref(d, ps0) as Json;
      for (const l of limits(ps)) out.push({ operation: op.key, category: 'boundary', name: `${titleOf(op)}: body "${k}" ${l.why}`, mutation: 'at-limit', request: withJsonBody(clone(valid.request), { ...(body as Json), [k]: l.value }), expect, accept: true, origin: 'draft' });
    }
  }
  for (const p of op.params.filter((x) => x.in === 'query')) {
    const raw = [...asArray(op.op.parameters), ...asArray(op.item.parameters)].map((x) => deref(d, x) as Json).find((x) => x?.in === 'query' && x.name === p.name);
    const ps = deref(d, raw?.schema ?? raw) as Json;
    for (const l of limits(ps ?? {})) {
      const r = clone(valid.request);
      r.params = [...(r.params ?? []).filter((x) => x.key !== p.name), { key: p.name, value: String(l.value), enabled: true }];
      out.push({ operation: op.key, category: 'boundary', name: `${titleOf(op)}: query "${p.name}" ${l.why}`, mutation: 'at-limit', request: r, expect, accept: true, origin: 'draft' });
    }
  }
  return out.slice(0, 3);
}

/** The id an unknown resource has: a UUID, a number, or a word. */
function missingId(doc: OpenApiDoc, op: SpecOperation, name: string): string {
  const d = doc as Json;
  const p = [...asArray(op.op.parameters), ...asArray(op.item.parameters)].map((x) => deref(d, x) as Json).find((x) => x?.in === 'path' && x.name === name);
  const s = deref(d, p?.schema ?? p) as Json | undefined;
  if (s?.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
  const t = typeOf(s);
  return t === 'integer' || t === 'number' ? '999999999' : 'does-not-exist';
}

const NEGATIVE_MUTATIONS = ['missing-required', 'wrong-type', 'enum', 'format', 'not-json', 'empty-body', 'missing-query', 'bad-query', 'bad-path'];
const BOUNDARY_MUTATIONS = ['too-long', 'too-short', 'out-of-range'];

/** What an operation's gaps ask for. */
function wanted(gaps: Array<{ category?: SpecCategory; kind: string; status?: string }>): { categories: Set<SpecCategory>; notFound: boolean } {
  const categories = new Set<SpecCategory>();
  let notFound = false;
  for (const g of gaps) {
    if (g.kind === 'param') continue;
    if (g.kind === 'status') {
      if (g.status === '404') notFound = true;
      else if (g.status && /^(401|403)$/.test(g.status)) categories.add('security');
      else if (g.category) categories.add(g.category);
    } else if (g.category) categories.add(g.category);
  }
  return { categories, notFound };
}

/** The tests TestPion makes without a model for the operations in scope (see the module comment). */
export function deterministicCases(doc: OpenApiDoc, local: Pick<SpecLocal, 'report' | 'ops' | 'valid' | 'fuzz' | 'options' | 'scope'>): SpecCase[] {
  const out: SpecCase[] = [];
  const cats = new Set(local.options.categories);
  for (const key of local.scope) {
    const op = local.ops.get(key)!;
    const valid = local.valid.get(key);
    if (!valid) continue;
    const gap = local.report.operations.find((o) => o.operation === key);
    const need = local.options.gapsOnly ? wanted(gap?.gaps ?? []) : { categories: new Set<SpecCategory>(SPEC_CATEGORIES), notFound: true };
    const mine = local.fuzz.filter((c) => c.operation === key && c.mutation !== 'valid');
    const title = titleOf(op);
    const add = (c: Omit<SpecCase, 'operation' | 'origin'>) => out.push({ ...c, operation: key, origin: 'draft' });
    if (cats.has('positive') && need.categories.has('positive')) add({ category: 'positive', name: title, mutation: 'valid', request: clone(valid.request), expect: successExpect(op), accept: true });
    if (cats.has('negative') && need.categories.has('negative')) {
      const picked: FuzzCase[] = [];
      for (const m of NEGATIVE_MUTATIONS) {
        const c = mine.find((x) => x.mutation === m && !picked.includes(x));
        if (c) picked.push(c);
        if (picked.length >= 3) break;
      }
      for (const c of picked) add({ category: 'negative', name: `${title} rejects ${c.name}`, mutation: c.mutation, request: clone(c.request), expect: ['4xx'], accept: false });
    }
    if (cats.has('negative') && need.notFound && op.responses.includes('404') && /\{[^}]+\}/.test(op.path)) {
      const ids = Object.fromEntries([...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => [m[1]!, missingId(doc, op, m[1]!)]));
      const r = clone(valid.request);
      r.url = urlWithPath(op, ids);
      add({ category: 'negative', name: `${title}: an unknown id is not found`, mutation: 'not-found', request: r, expect: [404], accept: false });
    }
    if (cats.has('boundary') && need.categories.has('boundary')) {
      for (const c of mine.filter((x) => BOUNDARY_MUTATIONS.includes(x.mutation)).slice(0, 2)) add({ category: 'boundary', name: `${title} rejects ${c.name}`, mutation: c.mutation, request: clone(c.request), expect: ['4xx'], accept: false });
      for (const c of atLimitCases(doc, op, valid)) add(c);
    }
    if (cats.has('security') && need.categories.has('security') && op.secured) {
      const r = clone(valid.request);
      r.auth = undefined;
      r.headers = (r.headers ?? []).filter((h) => h.key.toLowerCase() !== 'authorization');
      add({ category: 'security', name: `${title} without credentials is refused`, mutation: 'no-auth', request: r, expect: [401, 403], accept: false });
    }
  }
  return out;
}
