/**
 * Contract drift (AI-9), the deterministic half: what real traffic does that an OpenAPI document does not say.
 *
 * Exchanges (from History, a HAR file or a recorded run) are mapped to the document's operations and checked, one by
 * one, for: an endpoint the document does not have, a status it does not document, a content type it does not
 * document, and — in a JSON response body walked against the documented schema — a field the schema does not have,
 * a type that differs, a required field that is missing, a null where the schema forbids one, and a value outside an
 * enum. The same finding on many exchanges is one finding with a count and a few examples.
 *
 * No model is involved: the findings are facts about the traffic. The AI half (ai/contract-drift.ts) explains their
 * impact and proposes the spec or test fix; the patches themselves are made by spec-patch.ts from what was observed.
 */
import { createHash } from 'node:crypto';
import type { ItemRef } from '@testpion/shared';
import { findOperation, type OpenApiDoc } from './contract.js';

type Json = Record<string, unknown>;

/** One request and its response, whatever it came from. */
export interface DriftExchange {
  /** A stable id of the exchange in its source (a history id, a HAR entry number, a run result id). */
  id: string;
  method: string;
  url: string;
  status: number;
  contentType?: string;
  /** The response body, parsed when it is JSON (else the text, or nothing). */
  body?: unknown;
  /** The ISO time it happened, when the source knows. */
  at?: string;
  /** The saved request it was sent from (History), for a test fix. */
  request?: { collectionId: string; requestId: string };
  /** The item it can be opened as. */
  ref?: ItemRef;
}

export type DriftKind = 'undocumented-endpoint' | 'undocumented-status' | 'undocumented-content-type' | 'undocumented-field' | 'type-change' | 'missing-required' | 'nullable' | 'enum-value';

export const DRIFT_KINDS: readonly DriftKind[] = ['undocumented-endpoint', 'undocumented-status', 'undocumented-content-type', 'undocumented-field', 'type-change', 'missing-required', 'nullable', 'enum-value'];

/** A kind of drift in words (the report, the review). */
export const DRIFT_TITLES: Record<DriftKind, string> = {
  'undocumented-endpoint': 'An endpoint the document does not have',
  'undocumented-status': 'A status the document does not list',
  'undocumented-content-type': 'A content type the document does not list',
  'undocumented-field': 'A field the schema does not have',
  'type-change': 'A type that differs from the schema',
  'missing-required': 'A required field that is missing',
  nullable: 'A null where the schema forbids one',
  'enum-value': 'A value outside the schema’s enum',
};

export interface DriftFinding {
  /** Stable for the same finding (kind, operation, status, place): `d-3f9a1c`. */
  id: string;
  kind: DriftKind;
  /** The kind in words (DRIFT_TITLES), for lists. */
  title: string;
  /** `GET /patients/{id}` as the document names it; for an undocumented endpoint, the request's own path. */
  operation: string;
  status?: string;
  /** Where in the body: `$.items[].price` (an array's elements are `[]`). */
  pointer?: string;
  /** What the schema says (a type, an enum, the documented statuses). */
  expected?: string;
  /** What the traffic did: the types or statuses seen (at most 5). */
  observed: string[];
  /** How many exchanges had it, out of `of` for this operation and status. */
  count: number;
  of: number;
  /** A few values seen (at most 3, short); they leave the machine only at the full privacy level. */
  examples: Array<{ exchange: string; value: unknown }>;
  /** The first value seen at the place (at most 2 KB), kept for patching the document; never sent to a model. */
  sample?: unknown;
  /** type-change: every JSON type seen at the place, conforming ones too. */
  seenTypes?: string[];
  /** The exchanges that had it (at most 5), and the saved requests they were sent from. */
  exchanges: string[];
  requests: Array<{ collectionId: string; requestId: string }>;
}

export interface DriftReport {
  exchanges: number;
  /** Exchanges that map to an operation of the document. */
  matched: number;
  findings: DriftFinding[];
  byKind: Partial<Record<DriftKind, number>>;
  operations: Array<{ operation: string; exchanges: number; findings: number }>;
}

/* ------------------------------------------------------------------ schemas */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** A local `$ref` (#/components/…, #/definitions/…) followed to what it points at, and the path it was found at. */
export function resolveRef(doc: OpenApiDoc, schema: unknown): { schema: Json; path?: string[] } | undefined {
  let s = schema;
  let path: string[] | undefined;
  for (let i = 0; i < 12 && isObj(s) && typeof s.$ref === 'string'; i++) {
    const ref = s.$ref;
    if (!ref.startsWith('#/')) return undefined;
    const parts = ref
      .slice(2)
      .split('/')
      .map((p) => decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~')));
    let at: unknown = doc;
    for (const p of parts) at = isObj(at) || Array.isArray(at) ? (at as Json)[p] : undefined;
    path = parts;
    s = at;
  }
  return isObj(s) ? { schema: s, path } : undefined;
}

/** The type names a schema allows (`type` as a string or a list; OpenAPI 3.0 `nullable`); empty: any. */
function typesOf(s: Json): { types: string[]; nullable: boolean } {
  const t = Array.isArray(s.type) ? (s.type as unknown[]).map(String) : typeof s.type === 'string' ? [s.type] : [];
  const nullable = s.nullable === true || t.includes('null');
  return { types: t.filter((x) => x !== 'null'), nullable };
}

/** The JSON type of a value, with integers apart from other numbers. */
export function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

const typeOk = (want: string[], value: unknown): boolean => {
  const t = jsonType(value);
  return want.some((w) => w === t || (w === 'number' && t === 'integer'));
};

interface Seen {
  kind: DriftKind;
  pointer: string;
  expected?: string;
  observed: string;
  value?: unknown;
  /** The raw value (for inferring a schema), bounded. */
  raw?: unknown;
}

const short = (v: unknown): unknown => (typeof v === 'string' ? (v.length > 60 ? `${v.slice(0, 57)}…` : v) : Array.isArray(v) || isObj(v) ? JSON.stringify(v).slice(0, 60) : v);

/** The schema's own properties, required list and the parts of an allOf merged. */
function shapeOf(doc: OpenApiDoc, schema: Json, depth = 0): { props: Record<string, unknown>; required: string[]; types: string[]; nullable: boolean; enumValues?: unknown[]; extra: unknown; hasProps: boolean; any: boolean } {
  const out = { props: {} as Record<string, unknown>, required: [] as string[], types: [] as string[], nullable: false, enumValues: undefined as unknown[] | undefined, extra: undefined as unknown, hasProps: false, any: false };
  const take = (s: Json) => {
    const r = resolveRef(doc, s)?.schema ?? s;
    const t = typesOf(r);
    if (t.types.length) out.types = [...new Set([...out.types, ...t.types])];
    if (t.nullable) out.nullable = true;
    if (isObj(r.properties)) {
      out.hasProps = true;
      Object.assign(out.props, r.properties);
    }
    if (Array.isArray(r.required)) out.required.push(...r.required.map(String));
    if (Array.isArray(r.enum)) out.enumValues = r.enum;
    if (r.additionalProperties !== undefined) out.extra = r.additionalProperties;
    if (depth < 6 && Array.isArray(r.allOf)) for (const p of r.allOf) if (isObj(p)) Object.assign(out, mergeInto(out, shapeOf(doc, p, depth + 1)));
    if (r.items !== undefined && !out.types.length) out.types = ['array'];
    if (!r.type && !r.properties && !r.items && !r.allOf && !r.oneOf && !r.anyOf && !r.enum && !r.$ref) out.any = true;
  };
  take(schema);
  return out;
}

function mergeInto(a: ReturnType<typeof shapeOf>, b: ReturnType<typeof shapeOf>): ReturnType<typeof shapeOf> {
  return {
    props: { ...a.props, ...b.props },
    required: [...a.required, ...b.required],
    types: [...new Set([...a.types, ...b.types])],
    nullable: a.nullable || b.nullable,
    enumValues: b.enumValues ?? a.enumValues,
    extra: b.extra ?? a.extra,
    hasProps: a.hasProps || b.hasProps,
    any: a.any && b.any,
  };
}

/** Walk a body against a schema, collecting what differs (see the module comment). Bounded: depth 8, 20 array elements, 200 findings. */
export function walkBody(doc: OpenApiDoc, schema: unknown, value: unknown, pointer = '$', seen: Seen[] = [], depth = 0, onValue?: (pointer: string, type: string) => void): Seen[] {
  if (seen.length >= 200 || depth > 8 || !isObj(schema)) return seen;
  const resolved = resolveRef(doc, schema);
  if (!resolved) return seen;
  const s = resolved.schema;
  // a choice: the variant that fits best (fewest differences) is the one compared
  const variants = (Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : undefined)?.filter(isObj);
  if (variants?.length) {
    let best: Seen[] | undefined;
    for (const v of variants) {
      const trial = walkBody(doc, v, value, pointer, [], depth + 1, undefined);
      if (!best || trial.length < best.length) best = trial;
      if (!trial.length) break;
    }
    seen.push(...(best ?? []));
    return seen;
  }
  const shape = shapeOf(doc, s);
  onValue?.(pointer, jsonType(value));
  if (value === null) {
    if (!shape.nullable && (shape.types.length || shape.hasProps) && !shape.any) seen.push({ kind: 'nullable', pointer, expected: shape.types.join(' | ') || 'object', observed: 'null' });
    return seen;
  }
  const t = jsonType(value);
  if (shape.types.length && !typeOk(shape.types, value)) {
    seen.push({ kind: 'type-change', pointer, expected: shape.types.join(' | '), observed: t, value: short(value), raw: value });
    return seen;
  }
  if (shape.enumValues && !shape.enumValues.some((e) => JSON.stringify(e) === JSON.stringify(value)) && typeof value !== 'object') {
    seen.push({ kind: 'enum-value', pointer, expected: shape.enumValues.map((e) => JSON.stringify(e)).join(', '), observed: String(value), value: short(value), raw: value });
  }
  if (Array.isArray(value)) {
    const items = isObj(s.items) ? s.items : shape.hasProps ? undefined : undefined;
    if (items) for (const el of value.slice(0, 20)) walkBody(doc, items, el, `${pointer}[]`, seen, depth + 1, onValue);
    return seen;
  }
  if (isObj(value)) {
    const obj = value;
    if (shape.hasProps || isObj(shape.extra) || shape.extra === false) {
      for (const k of shape.required) if (!(k in obj)) seen.push({ kind: 'missing-required', pointer: `${pointer}.${k}`, expected: 'present', observed: 'absent' });
      for (const [k, v] of Object.entries(obj)) {
        if (k in shape.props) walkBody(doc, shape.props[k], v, `${pointer}.${k}`, seen, depth + 1, onValue);
        else if (isObj(shape.extra)) walkBody(doc, shape.extra, v, `${pointer}.${k}`, seen, depth + 1, onValue);
        else if (shape.hasProps) seen.push({ kind: 'undocumented-field', pointer: `${pointer}.${k}`, observed: jsonType(v), value: short(v), raw: v });
      }
    }
  }
  return seen;
}

/* ------------------------------------------------------------------ analysis */

const responseFor = (op: Json, status: number): { key: string; response: Json } | undefined => {
  const responses = (isObj(op.responses) ? op.responses : {}) as Record<string, Json>;
  const code = String(status);
  for (const k of [code, `${code[0]}XX`, `${code[0]}xx`, 'default']) if (isObj(responses[k])) return { key: k, response: responses[k] };
  return undefined;
};

/** The schema documented for a response body of this content type (OpenAPI 3 content map; Swagger 2 schema), and the media type key it was found under. */
export function schemaFor(doc: OpenApiDoc, response: Json, contentType: string | undefined): { schema?: unknown; media?: string; contentKnown: boolean } {
  const ct = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const content = response.content;
  if (isObj(content) && Object.keys(content).length) {
    const type = ct.split('/')[0];
    const media = content[ct] !== undefined ? ct : content[`${type}/*`] !== undefined ? `${type}/*` : content['*/*'] !== undefined ? '*/*' : /[+/]json$/.test(ct) ? Object.keys(content).find((k) => /json/.test(k)) : undefined;
    if (!media) return { contentKnown: false };
    return { schema: (content[media] as Json | undefined)?.schema, media, contentKnown: true };
  }
  return { schema: doc.swagger ? response.schema : undefined, contentKnown: true };
}

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 6);

/** The id of a finding: the same drift in another run has the same id. */
export const driftId = (f: Pick<DriftFinding, 'kind' | 'operation' | 'status' | 'pointer' | 'expected'>): string => `d-${hash([f.kind, f.operation, f.status ?? '', f.pointer ?? '', f.expected ?? ''].join('|'))}`;

const pathOf = (url: string): string => {
  try {
    return new URL(url, 'http://base.invalid').pathname || '/';
  } catch {
    return url;
  }
};

/**
 * Check exchanges against an OpenAPI document (see the module comment). Exchanges with no usable status are left
 * out; a response body is walked only when it is JSON and the document has a schema for it.
 */
export function analyseDrift(doc: OpenApiDoc, exchanges: DriftExchange[], o: { maxFindings?: number } = {}): DriftReport {
  type Acc = DriftFinding & { _ex: Set<string> };
  const acc = new Map<string, Acc>();
  const perOp = new Map<string, { exchanges: number; findings: Set<string> }>();
  const totals = new Map<string, number>();
  /** Every JSON type seen at a place (conforming or not): a field that is both an integer and a string is not a type to document. */
  const typesAt = new Map<string, Set<string>>();
  let matched = 0;
  let used = 0;
  const note = (f: Omit<DriftFinding, 'id' | 'title' | 'count' | 'observed' | 'examples' | 'exchanges' | 'requests' | 'sample'>, e: DriftExchange, observed: string, value?: unknown, raw?: unknown) => {
    const id = driftId(f);
    let a = acc.get(id);
    if (!a) acc.set(id, (a = { ...f, id, title: DRIFT_TITLES[f.kind], count: 0, observed: [], examples: [], exchanges: [], requests: [], _ex: new Set() }));
    if (!a._ex.has(e.id)) {
      a._ex.add(e.id);
      a.count++;
      if (a.exchanges.length < 5) a.exchanges.push(e.id);
      if (e.request && a.requests.length < 5 && !a.requests.some((r) => r.requestId === e.request!.requestId && r.collectionId === e.request!.collectionId)) a.requests.push(e.request);
      if (a.examples.length < 3 && value !== undefined) a.examples.push({ exchange: e.id, value });
      if (a.sample === undefined && raw !== undefined && JSON.stringify(raw).length <= 2000) a.sample = clone(raw);
    }
    if (!a.observed.includes(observed) && a.observed.length < 5) a.observed.push(observed);
    const p = perOp.get(f.operation) ?? { exchanges: 0, findings: new Set<string>() };
    p.findings.add(id);
    perOp.set(f.operation, p);
  };
  for (const e of exchanges) {
    if (!Number.isFinite(e.status) || e.status <= 0) continue;
    used++;
    const op = findOperation(doc, e.method, e.url);
    if (!op) {
      note({ kind: 'undocumented-endpoint', operation: `${e.method.toUpperCase()} ${pathOf(e.url)}`, of: 0 }, e, String(e.status));
      continue;
    }
    matched++;
    const name = `${op.method.toUpperCase()} ${op.path}`;
    const key = `${name}|${e.status}`;
    totals.set(key, (totals.get(key) ?? 0) + 1);
    const po = perOp.get(name) ?? { exchanges: 0, findings: new Set<string>() };
    po.exchanges++;
    perOp.set(name, po);
    const found = responseFor(op.operation, e.status);
    if (!found) {
      const documented = Object.keys((isObj(op.operation.responses) ? op.operation.responses : {}) as object);
      note({ kind: 'undocumented-status', operation: name, status: String(e.status), expected: documented.join(', ') || 'none', of: 0 }, e, String(e.status), e.body === undefined ? undefined : short(e.body), e.body);
      continue;
    }
    const { schema, contentKnown } = schemaFor(doc, found.response, e.contentType);
    if (!contentKnown) {
      note({ kind: 'undocumented-content-type', operation: name, status: String(e.status), expected: Object.keys((found.response.content ?? {}) as object).join(', '), of: 0 }, e, (e.contentType ?? 'none').split(';')[0]!.trim() || 'none');
      continue;
    }
    if (!schema || e.body === undefined || typeof e.body === 'string') continue;
    for (const s of walkBody(doc, schema, e.body, '$', [], 0, (pointer, type) => {
      const k = `${name}|${e.status}|${pointer}`;
      const set = typesAt.get(k) ?? new Set<string>();
      set.add(type);
      typesAt.set(k, set);
    })) note({ kind: s.kind, operation: name, status: String(e.status), pointer: s.pointer, ...(s.expected !== undefined ? { expected: s.expected } : {}), of: 0 }, e, s.observed, s.value, s.raw);
  }
  const findings = [...acc.values()]
    .map(({ _ex, ...f }) => ({
      ...f,
      of: f.kind === 'undocumented-endpoint' ? f.count : (totals.get(`${f.operation}|${f.status}`) ?? f.count),
      ...(f.kind === 'type-change' || f.kind === 'nullable' ? { seenTypes: [...(typesAt.get(`${f.operation}|${f.status}|${f.pointer}`) ?? [])].sort() } : {}),
    }))
    .sort((a, b) => b.count - a.count || b.count / Math.max(1, b.of) - a.count / Math.max(1, a.of) || a.operation.localeCompare(b.operation) || (a.pointer ?? '').localeCompare(b.pointer ?? ''))
    .slice(0, o.maxFindings ?? 300);
  const byKind: DriftReport['byKind'] = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  return {
    exchanges: used,
    matched,
    findings,
    byKind,
    operations: [...perOp.entries()].map(([operation, p]) => ({ operation, exchanges: p.exchanges, findings: p.findings.size })).sort((a, b) => b.findings - a.findings || a.operation.localeCompare(b.operation)),
  };
}

/** The report as Markdown (the CLI prints it, MCP returns it). */
export function driftMarkdown(r: DriftReport, spec: string): string {
  const lines = [`# Contract drift: ${spec}`, '', `${r.exchanges} exchanges, ${r.matched} matched an operation of the document: ${r.findings.length ? `${r.findings.length} kinds of drift.` : 'no drift.'}`, ''];
  for (const f of r.findings) {
    lines.push(`- **${DRIFT_TITLES[f.kind]}** — ${f.operation}${f.status ? ` ${f.status}` : ''}${f.pointer ? ` ${f.pointer}` : ''}: seen ${f.observed.join(', ')}${f.expected ? ` (document: ${f.expected})` : ''} in ${f.count} of ${f.of} responses`);
  }
  return lines.join('\n');
}

/** A copy of a drift report's finding list for a context (examples only when `examples`). */
export const driftFindingsForModel = (r: DriftReport, o: { examples: boolean; max: number }): Array<Record<string, unknown>> =>
  r.findings.slice(0, o.max).map((f) => ({
    id: f.id,
    kind: f.kind,
    operation: f.operation,
    ...(f.status ? { status: f.status } : {}),
    ...(f.pointer ? { pointer: f.pointer } : {}),
    ...(f.expected ? { expected: f.expected } : {}),
    observed: f.observed,
    count: f.count,
    of: f.of,
    ...(o.examples && f.examples.length ? { examples: f.examples.map((x) => x.value) } : {}),
  }));

