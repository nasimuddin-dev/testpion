/**
 * Gaps between an API definition and the tests that exist for it (AI-4, deterministic: no model, usable without a
 * provider). Every HTTP request of the workspace's test files (tests/**.yaml) and saved collection requests is matched
 * to the operation it calls (`findOperation`), and each operation is judged on what those requests prove:
 *
 * - is it called at all, and with which of its documented statuses asserted (`status` checks)
 * - is there a negative test (invalid input → 4xx), a boundary test (a value at or beyond a documented limit), a
 *   security test (no token → 401/403), and is a response ever checked against the document (`openapi` / `json-schema`)
 * - which documented parameters no request ever sends
 *
 * The report is what `testpion generate gaps`, the MCP tool `spec_gaps` and the app's "Generate tests from this spec"
 * dialog show; the AI task `tests-from-spec` starts from it, and computes coverage before → after from the same function
 * with the proposed tests added, so "coverage went up" is never a claim of the model.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from '../util/lazy-yaml.js';
import { deref } from '../util/json-ref.js';
import type { CollectionNode } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { findOperation, loadOpenApi, type OpenApiDoc } from './contract.js';

type Json = Record<string, any>;

export type SpecCategory = 'positive' | 'negative' | 'boundary' | 'security';
export const SPEC_CATEGORIES: readonly SpecCategory[] = ['positive', 'negative', 'boundary', 'security'];

/** A request that exists in the workspace (a test step or a saved request), reduced to what the gap analysis reads. */
export interface ExistingRequest {
  /** `tests/smoke/patients.yaml#create` or `collection Veterinary / Create a patient`. */
  source: string;
  name: string;
  method: string;
  url: string;
  /** Names of the query parameters, headers and top-level body fields it sends. */
  query: string[];
  headers: string[];
  bodyFields: string[];
  hasAuth: boolean;
  /** Numeric statuses and `4xx`-style classes its `status` checks expect. */
  statuses: string[];
  /** A check compares the response with the document (`openapi`, `json-schema`). */
  contract: boolean;
  tags: string[];
}

export type SpecGapKind = 'no-test' | 'status' | 'negative' | 'boundary' | 'security' | 'contract' | 'param';

export interface SpecGap {
  kind: SpecGapKind;
  message: string;
  /** The category of test that closes it. */
  category?: SpecCategory;
  /** status: the documented code. */
  status?: string;
}

export interface SpecParam {
  name: string;
  in: string;
  required: boolean;
  /** `maxLength 50`, `minimum 0`, `enum a|b|c`, `format uuid` … */
  constraints: string[];
}

export interface SpecOperationGap {
  operation: string;
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  tag: string;
  deprecated: boolean;
  /** DELETE: generated tests leave it out unless asked. */
  destructive: boolean;
  secured: boolean;
  /** Existing requests that call it (at most 5 listed). */
  tests: Array<{ source: string; name: string; statuses: string[] }>;
  calls: number;
  documentedStatuses: string[];
  assertedStatuses: string[];
  untestedStatuses: string[];
  categories: Record<SpecCategory, number>;
  contractChecked: boolean;
  parameters: SpecParam[];
  /** Body fields with a documented constraint, as `name: maxLength 50`. */
  bodyConstraints: string[];
  untestedParams: string[];
  covered: boolean;
  gaps: SpecGap[];
}

export interface SpecGapReport {
  schemaVersion: '1';
  spec: string;
  title?: string;
  version?: string;
  summary: {
    operations: number;
    covered: number;
    operationPct: number;
    documentedStatuses: number;
    assertedStatuses: number;
    statusPct: number;
    gaps: number;
    withNegative: number;
    withBoundary: number;
    withSecurity: number;
    existingRequests: number;
    /** Existing requests that call something the document does not describe. */
    unmatched: number;
  };
  operations: SpecOperationGap[];
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 100);

/* ------------------------------------------------------------------ the requests that exist */

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const namesOf = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.flatMap((x) => (x && typeof x === 'object' && typeof (x as { key?: unknown }).key === 'string' && (x as { enabled?: boolean }).enabled !== false ? [(x as { key: string }).key] : []));
  if (v && typeof v === 'object') return Object.keys(v);
  return [];
};
const bodyFieldsOf = (b: unknown): string[] => {
  let v = b;
  if (v && typeof v === 'object' && 'content' in (v as object) && typeof (v as { content?: unknown }).content === 'string') v = (v as { content: string }).content;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [];
};

/** The `status` checks of a list of checks: `201`, `4xx`. */
function statusesOf(assertions: unknown): string[] {
  const out: string[] = [];
  for (const a of asList(assertions)) {
    if (!a || typeof a !== 'object') continue;
    const type = String((a as { type?: unknown }).type ?? '');
    if (type !== 'status' && type !== 'http-status') continue;
    for (const e of asList((a as { expected?: unknown }).expected ?? 200)) if (typeof e === 'number' || typeof e === 'string') out.push(String(e).toLowerCase());
  }
  return out;
}
const hasContract = (assertions: unknown) => asList(assertions).some((a) => a && typeof a === 'object' && ['openapi', 'json-schema'].includes(String((a as { type?: unknown }).type)));

const queryOfUrl = (url: string): string[] => {
  const q = url.split('#')[0]!.split('?')[1];
  return q ? q.split('&').map((p) => decodeURIComponent(p.split('=')[0]!.replace(/\+/g, ' '))).filter(Boolean) : [];
};

/** The HTTP requests in the YAML of a test file (steps with a method and a URL). */
export function requestsOfTestFile(path: string, text: string): ExistingRequest[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return [];
  }
  const root = (Array.isArray(doc) ? { tests: doc } : doc) as Json | null;
  if (!root || typeof root !== 'object') return [];
  const defaults = (root.defaults && typeof root.defaults === 'object' ? root.defaults : {}) as Json;
  const steps: Json[] = Array.isArray(root.tests) ? root.tests.filter((s: unknown): s is Json => !!s && typeof s === 'object') : root.method || root.request ? [root] : [];
  const out: ExistingRequest[] = [];
  for (const s0 of steps) {
    const s = { ...defaults, ...s0 } as Json;
    const r = (s.request && typeof s.request === 'object' ? { ...s, ...s.request } : s) as Json;
    const method = typeof r.method === 'string' ? r.method.toUpperCase() : undefined;
    const url = typeof r.url === 'string' ? r.url : undefined;
    if (!method || !url || (s.type && s.type !== 'http')) continue;
    const auth = r.auth ?? s.auth;
    out.push({
      source: `tests/${path.replace(/^tests[\\/]/, '')}#${String(s0.id ?? s0.name ?? out.length + 1)}`,
      name: String(s0.name ?? s0.id ?? `${method} ${url}`),
      method,
      url,
      query: [...queryOfUrl(url), ...namesOf(r.params ?? r.query)],
      headers: namesOf(r.headers),
      bodyFields: bodyFieldsOf(r.body),
      hasAuth: !!auth && (auth as { type?: string }).type !== 'none' && (auth as { type?: string }).type !== 'inherit' ? true : namesOf(r.headers).some((h) => /^authorization$/i.test(h)),
      statuses: statusesOf(s.assertions ?? s.expect),
      contract: hasContract(s.assertions),
      tags: asList(s.tags).map(String),
    });
  }
  return out;
}

const walkFiles = (dir: string, out: string[] = [], depth = 0): string[] => {
  if (depth > 8 || !existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out, depth + 1);
    else if (/\.ya?ml$/i.test(e.name)) out.push(p);
  }
  return out;
};

/** Every HTTP request of the workspace that a gap analysis reads: test files and saved collection requests. */
export function existingRequests(store: WorkspaceStore): ExistingRequest[] {
  const out: ExistingRequest[] = [];
  const root = store.path('tests');
  for (const f of walkFiles(root).sort()) {
    try {
      if (statSync(f).size > 2 * 1024 * 1024) continue;
      out.push(...requestsOfTestFile(f.slice(root.length + 1).replace(/\\/g, '/'), readFileSync(f, 'utf8')));
    } catch {
      /* unreadable: skipped */
    }
  }
  for (const meta of store.listCollections()) {
    let c;
    try {
      c = store.getCollection(meta.id);
    } catch {
      continue;
    }
    const walk = (nodes: CollectionNode[], path: string[]) => {
      for (const n of nodes) {
        if (n.kind === 'folder') walk(n.items, [...path, n.name]);
        else if (n.kind === 'http') {
          const r = n.request;
          out.push({
            source: `collection ${[c.name, ...path, n.name].join(' / ')}`,
            name: n.name,
            method: r.method.toUpperCase(),
            url: r.url,
            query: [...queryOfUrl(r.url), ...namesOf(r.params)],
            headers: namesOf(r.headers),
            bodyFields: bodyFieldsOf(r.body),
            hasAuth: (!!r.auth && r.auth.type !== 'none' && r.auth.type !== 'inherit') || namesOf(r.headers).some((h) => /^authorization$/i.test(h)) || (!!c.auth && c.auth.type !== 'none'),
            statuses: statusesOf(n.assertions),
            contract: hasContract(n.assertions),
            tags: [],
          });
        }
      }
    };
    walk(c.items, []);
  }
  return out;
}

/* ------------------------------------------------------------------ the document's side */

const constraintsOf = (doc: Json, s0: unknown): string[] => {
  const s = deref(doc, s0) as Json | undefined;
  if (!s || typeof s !== 'object') return [];
  const c: string[] = [];
  for (const k of ['minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'pattern', 'format'])
    if (s[k] !== undefined && typeof s[k] !== 'object') c.push(`${k} ${String(s[k])}`);
  if (Array.isArray(s.enum) && s.enum.length) c.push(`enum ${s.enum.slice(0, 8).join('|')}`);
  return c;
};

/** The JSON body schema of an operation (OpenAPI 3 or Swagger 2), dereferenced one level. */
export function bodySchemaOf(doc: Json, op: Json, item: Json): { schema: Json; required: boolean } | undefined {
  if (doc.swagger) {
    const bp = [...asList(op.parameters), ...asList(item.parameters)].map((p) => deref(doc, p) as Json).find((p) => p?.in === 'body');
    return bp?.schema ? { schema: deref(doc, bp.schema) as Json, required: !!bp.required } : undefined;
  }
  const rb = deref(doc, op.requestBody) as Json | undefined;
  const ct = Object.keys(rb?.content ?? {}).find((k) => /json/.test(k));
  return ct && rb?.content[ct]?.schema ? { schema: deref(doc, rb.content[ct].schema) as Json, required: !!rb.required } : undefined;
}

/** Properties of an object schema (allOf merged). */
export function propertiesOf(doc: Json, s0: unknown): { properties: Json; required: string[] } {
  const s = deref(doc, s0) as Json | undefined;
  if (!s || typeof s !== 'object') return { properties: {}, required: [] };
  if (Array.isArray(s.allOf)) {
    const parts = s.allOf.map((x: unknown) => propertiesOf(doc, x));
    return { properties: Object.assign({}, ...parts.map((p: { properties: Json }) => p.properties)), required: parts.flatMap((p: { required: string[] }) => p.required) };
  }
  return { properties: (s.properties as Json) ?? {}, required: (s.required as string[]) ?? [] };
}

/** An operation of the document with what the gap analysis needs. */
export interface SpecOperation {
  key: string;
  method: string;
  path: string;
  op: Json;
  item: Json;
  operationId?: string;
  summary?: string;
  tag: string;
  params: SpecParam[];
  bodyConstraints: string[];
  hasBody: boolean;
  /** Documented response codes (`default` left out). */
  responses: string[];
  secured: boolean;
  securitySchemes: string[];
}

export function specOperations(doc: OpenApiDoc): SpecOperation[] {
  const out: SpecOperation[] = [];
  const d = doc as Json;
  for (const [path, item0] of Object.entries((d.paths as Json) ?? {})) {
    const item = deref(d, item0) as Json;
    if (!item || typeof item !== 'object') continue;
    for (const m of METHODS) {
      const op = item[m] as Json | undefined;
      if (!op || typeof op !== 'object') continue;
      const own = asList(op.parameters).map((p) => deref(d, p) as Json);
      const params = [...own, ...asList(item.parameters).map((p) => deref(d, p) as Json).filter((p) => !own.some((o) => o?.name === p?.name && o?.in === p?.in))].filter((p) => p && p.in !== 'body' && p.name);
      const body = bodySchemaOf(d, op, item);
      const bodyProps = body ? propertiesOf(d, body.schema) : { properties: {}, required: [] as string[] };
      const security = (op.security ?? d.security ?? []) as Json[];
      const schemes = [...new Set(security.flatMap((s) => Object.keys(s ?? {})))];
      out.push({
        key: `${m.toUpperCase()} ${path}`,
        method: m.toUpperCase(),
        path,
        op,
        item,
        operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
        summary: typeof op.summary === 'string' ? op.summary : undefined,
        tag: String((op.tags as string[] | undefined)?.[0] ?? 'default'),
        params: params.map((p) => ({ name: String(p.name), in: String(p.in), required: p.required === true || p.in === 'path', constraints: constraintsOf(d, p.schema ?? p) })),
        bodyConstraints: Object.entries(bodyProps.properties).flatMap(([k, s]) => constraintsOf(d, s).map((c) => `${k}: ${c}`)),
        hasBody: !!body,
        responses: Object.keys((op.responses as Json) ?? {}).filter((r) => r !== 'default'),
        secured: security.length > 0 && !security.every((s) => Object.keys(s ?? {}).length === 0),
        securitySchemes: schemes,
      });
    }
  }
  return out;
}

/** Does an asserted status (`404`, `4xx`) cover a documented response key (`404`, `4XX`)? */
const covers = (asserted: string, documented: string): boolean => {
  const a = asserted.toLowerCase();
  const d = documented.toLowerCase();
  if (a === d) return true;
  if (/^\dxx$/.test(a)) return d[0] === a[0];
  if (/^\dxx$/.test(d)) return a[0] === d[0];
  return false;
};

/** What an existing request proves: positive (expects a 2xx), negative (a 4xx), security (401/403), boundary (tagged). */
export function categoriesOf(r: ExistingRequest): SpecCategory[] {
  const out = new Set<SpecCategory>();
  for (const t of r.tags) if ((SPEC_CATEGORIES as readonly string[]).includes(t)) out.add(t as SpecCategory);
  for (const s of r.statuses) {
    if (/^2/.test(s)) out.add('positive');
    else if (/^4/.test(s)) {
      out.add('negative');
      if (/^(401|403)$/.test(s)) out.add('security');
    }
  }
  if (!r.statuses.length && !out.size) out.add('positive');
  return [...out];
}

/** The URL a request is matched on: its query and fragment cut, a leading `{{variable}}` origin made an origin. */
export const matchUrl = (url: string): string => url.trim().split(/[?#]/)[0]!.replace(/^\{\{[^}]+\}\}/, 'http://api.local');

/**
 * The gap report of a document against the requests that exist. `existing` defaults to the workspace's; the AI task
 * passes the existing requests plus the proposed ones to compute coverage after.
 */
export function specGapReport(doc: OpenApiDoc, existing: ExistingRequest[], o: { spec: string }): SpecGapReport {
  const ops = specOperations(doc);
  const byKey = new Map<string, ExistingRequest[]>();
  let unmatched = 0;
  for (const r of existing) {
    const hit = findOperation(doc, r.method, matchUrl(r.url));
    if (!hit) {
      unmatched++;
      continue;
    }
    const k = `${hit.method.toUpperCase()} ${hit.path}`;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const operations: SpecOperationGap[] = ops.map((o2) => {
    const mine = byKey.get(o2.key) ?? [];
    const cats: Record<SpecCategory, number> = { positive: 0, negative: 0, boundary: 0, security: 0 };
    for (const r of mine) for (const c of categoriesOf(r)) cats[c]++;
    const asserted = [...new Set(mine.flatMap((r) => r.statuses))];
    const tested = o2.responses.filter((d) => asserted.some((a) => covers(a, d)));
    const untested = o2.responses.filter((d) => !tested.includes(d));
    const sent = { query: new Set(mine.flatMap((r) => r.query)), headers: new Set(mine.flatMap((r) => r.headers.map((h) => h.toLowerCase()))) };
    const untestedParams = o2.params.filter((p) => p.in !== 'path' && !(p.in === 'query' ? sent.query.has(p.name) : p.in === 'header' ? sent.headers.has(p.name.toLowerCase()) : true)).map((p) => `${p.in} ${p.name}`);
    const contractChecked = mine.some((r) => r.contract);
    const hasSuccessSchema = o2.responses.some((r) => /^2/.test(r));
    const gaps: SpecGap[] = [];
    const canBreak = o2.hasBody || o2.params.length > 0;
    const constraints = o2.bodyConstraints.length + o2.params.reduce((n, p) => n + p.constraints.filter((c) => !c.startsWith('format')).length, 0);
    if (!mine.length) gaps.push({ kind: 'no-test', category: 'positive', message: 'no test or saved request calls it' });
    else if (!cats.positive) gaps.push({ kind: 'no-test', category: 'positive', message: 'no test expects a successful status' });
    for (const s of untested) if (!/^2/.test(s) || mine.length) gaps.push({ kind: 'status', status: s, category: /^[45]/.test(s) ? 'negative' : 'positive', message: `documented ${s} is never asserted` });
    if (canBreak && !cats.negative) gaps.push({ kind: 'negative', category: 'negative', message: 'no test sends invalid input and expects a 4xx' });
    if (constraints && !cats.boundary) gaps.push({ kind: 'boundary', category: 'boundary', message: `documented limits are never tested (${[...o2.bodyConstraints, ...o2.params.flatMap((p) => p.constraints.filter((c) => !c.startsWith('format')).map((c) => `${p.name}: ${c}`))].slice(0, 3).join('; ')})` });
    if (o2.secured && !cats.security) gaps.push({ kind: 'security', category: 'security', message: `requires ${o2.securitySchemes.join(' or ') || 'authentication'}, and no test calls it without credentials (401/403)` });
    if (mine.length && hasSuccessSchema && !contractChecked) gaps.push({ kind: 'contract', category: 'positive', message: 'no test checks the response against the document (openapi / json-schema check)' });
    if (untestedParams.length) gaps.push({ kind: 'param', message: `documented parameters never sent: ${untestedParams.slice(0, 5).join(', ')}` });
    return {
      operation: o2.key,
      method: o2.method,
      path: o2.path,
      operationId: o2.operationId,
      summary: o2.summary,
      tag: o2.tag,
      deprecated: o2.op.deprecated === true,
      destructive: o2.method === 'DELETE',
      secured: o2.secured,
      tests: mine.slice(0, 5).map((r) => ({ source: r.source, name: r.name, statuses: r.statuses })),
      calls: mine.length,
      documentedStatuses: o2.responses,
      assertedStatuses: tested,
      untestedStatuses: untested,
      categories: cats,
      contractChecked,
      parameters: o2.params,
      bodyConstraints: o2.bodyConstraints,
      untestedParams,
      covered: mine.length > 0,
      gaps,
    };
  });
  const documented = operations.reduce((n, x) => n + x.documentedStatuses.length, 0);
  const asserted = operations.reduce((n, x) => n + x.assertedStatuses.length, 0);
  const covered = operations.filter((x) => x.covered).length;
  const info = ((doc as Json).info ?? {}) as { title?: string; version?: string };
  return {
    schemaVersion: '1',
    spec: o.spec,
    title: info.title,
    version: info.version,
    summary: {
      operations: operations.length,
      covered,
      operationPct: pct(covered, operations.length),
      documentedStatuses: documented,
      assertedStatuses: asserted,
      statusPct: pct(asserted, documented),
      gaps: operations.reduce((n, x) => n + x.gaps.length, 0),
      withNegative: operations.filter((x) => x.categories.negative > 0).length,
      withBoundary: operations.filter((x) => x.categories.boundary > 0).length,
      withSecurity: operations.filter((x) => x.categories.security > 0).length,
      existingRequests: existing.length,
      unmatched,
    },
    operations,
  };
}

/** The gap report of a spec file of the workspace (specs/…) against its tests and collections. */
export function workspaceSpecGaps(store: WorkspaceStore, spec: string): SpecGapReport {
  const text = readFileSync(store.safePath(spec), 'utf8');
  return specGapReport(loadOpenApi(text), existingRequests(store), { spec });
}

/** A short Markdown report (CLI, MCP, pull requests). */
export function specGapMarkdown(r: SpecGapReport): string {
  const s = r.summary;
  const lines = [
    `# Test gaps${r.title ? `: ${r.title}` : ''}${r.version ? ` ${r.version}` : ''}`,
    '',
    `- **Operations covered:** ${s.covered} of ${s.operations} (${s.operationPct}%)`,
    `- **Documented statuses asserted:** ${s.assertedStatuses} of ${s.documentedStatuses} (${s.statusPct}%)`,
    `- **With a negative / boundary / security test:** ${s.withNegative} / ${s.withBoundary} / ${s.withSecurity} of ${s.operations}`,
    `- **Open gaps:** ${s.gaps} (from ${s.existingRequests} requests in tests and collections${s.unmatched ? `, ${s.unmatched} not in the document` : ''})`,
    '',
  ];
  for (const o of r.operations) {
    lines.push(`## ${o.covered ? (o.gaps.length ? '◐' : '✓') : '✗'} \`${o.operation}\`${o.summary ? ` ${o.summary}` : ''}`);
    if (!o.gaps.length) lines.push('', 'No gaps.', '');
    else lines.push('', ...o.gaps.map((g) => `- ${g.message}`), '');
  }
  return lines.join('\n');
}

/** Constraint text of a schema, for the model's context. */
export const schemaConstraints = (doc: Json, s: unknown): string[] => constraintsOf(doc, s);
