import { ApsError } from '../errors.js';
import { importOpenApi, sampleFromSchema } from '../import/importers.js';
import { isLocalHost } from '../load/load.js';
import type { AuthConfig, CollectionNode, HttpRequestSpec, KeyValue } from '../model/types.js';
import { executeHttp, type HttpExecOptions } from '../protocols/http/client.js';
import { loadOpenApi } from './contract.js';

/**
 * Fuzzing an API from its OpenAPI document (`testpion fuzz`, the API definition's Fuzz tab, the `api_fuzz` MCP tool):
 * each operation is sent its valid example, then variants that break one rule of the schema at a time (a required
 * field left out, a wrong type, a value outside its enum, range, length or format, a body that isn't JSON, a path or
 * query parameter of the wrong type). What the API does with them shows its bugs: a 5xx is a server error, a 2xx for
 * input the document forbids is a gap in validation, and a status the document doesn't list is a contract gap.
 *
 * It sends many requests, some that create or change data, so by default it only targets local or private-network
 * hosts and leaves DELETE out.
 */
type Json = Record<string, any>;

export type FuzzMutation =
  'valid' | 'missing-required' | 'wrong-type' | 'enum' | 'too-long' | 'too-short' | 'out-of-range' | 'format' | 'not-json' | 'empty-body' | 'missing-query' | 'bad-query' | 'bad-path';

export interface FuzzCase {
  id: string;
  /** `POST /patients` */
  operation: string;
  /** What this variant does: `body: "name" left out`. */
  name: string;
  mutation: FuzzMutation;
  /** Whether a correct API accepts it (the valid example) or rejects it with a 4xx. */
  expect: 'accept' | 'reject';
  request: HttpRequestSpec;
}

export type FuzzVerdict = 'server-error' | 'accepted-invalid' | 'rejected-valid' | 'undocumented-status' | 'not-authorized' | 'not-judged' | 'ok' | 'failed';

export interface FuzzResult {
  case: FuzzCase;
  status?: number;
  durationMs?: number;
  verdict: FuzzVerdict;
  message: string;
  /** The first bytes of the response body, for the report. */
  bodyPreview?: string;
}

export interface FuzzReport {
  operations: number;
  cases: number;
  results: FuzzResult[];
  counts: Record<FuzzVerdict, number>;
  /** Server errors found (exit 1 for CI). */
  serverErrors: number;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function deref(doc: Json, node: any, seen = 0): any {
  if (!node || typeof node !== 'object' || typeof node.$ref !== 'string' || seen > 20) return node;
  if (!node.$ref.startsWith('#/')) return {};
  let cur: any = doc;
  for (const p of node.$ref.slice(2).split('/')) cur = cur?.[decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~'))];
  return deref(doc, cur, seen + 1);
}

/** An object schema with allOf merged and $refs followed one level. */
function objectSchema(doc: Json, s0: any): { properties: Json; required: string[] } | undefined {
  const s = deref(doc, s0);
  if (!s || typeof s !== 'object') return undefined;
  if (s.allOf) {
    const parts = s.allOf.map((x: any) => objectSchema(doc, x)).filter(Boolean) as Array<{ properties: Json; required: string[] }>;
    return { properties: Object.assign({}, ...parts.map((p) => p.properties)), required: parts.flatMap((p) => p.required) };
  }
  if (s.type !== 'object' && !s.properties) return undefined;
  return { properties: (s.properties as Json) ?? {}, required: (s.required as string[]) ?? [] };
}

const typeOf = (s: any): string | undefined => (Array.isArray(s?.type) ? s.type.find((t: string) => t !== 'null') : s?.type);

/** A value of the wrong JSON type for a schema. */
function wrongType(s: any): unknown {
  switch (typeOf(s)) {
    case 'string':
      return 12345;
    case 'integer':
    case 'number':
      return 'not-a-number';
    case 'boolean':
      return 'not-a-boolean';
    case 'array':
      return { not: 'an array' };
    case 'object':
      return ['not', 'an', 'object'];
    default:
      return undefined;
  }
}

/** Values that break a rule other than the type: enum, length, range, format. */
function ruleBreakers(s: any): Array<{ mutation: FuzzMutation; value: unknown; why: string }> {
  const out: Array<{ mutation: FuzzMutation; value: unknown; why: string }> = [];
  if (!s || typeof s !== 'object') return out;
  if (Array.isArray(s.enum) && s.enum.length && typeOf(s) !== 'boolean')
    out.push({ mutation: 'enum', value: typeOf(s) === 'integer' || typeOf(s) === 'number' ? -987654 : 'not-one-of-the-values', why: 'outside its enum' });
  if (typeof s.maxLength === 'number' && s.maxLength < 10_000) out.push({ mutation: 'too-long', value: 'x'.repeat(s.maxLength + 1), why: `longer than maxLength ${s.maxLength}` });
  if (typeof s.minLength === 'number' && s.minLength > 0) out.push({ mutation: 'too-short', value: 'x'.repeat(s.minLength - 1), why: `shorter than minLength ${s.minLength}` });
  if (typeof s.maximum === 'number') out.push({ mutation: 'out-of-range', value: s.maximum + (typeOf(s) === 'integer' ? 1 : 0.5), why: `above maximum ${s.maximum}` });
  if (typeof s.minimum === 'number') out.push({ mutation: 'out-of-range', value: s.minimum - (typeOf(s) === 'integer' ? 1 : 0.5), why: `below minimum ${s.minimum}` });
  if (typeof s.maxItems === 'number' && typeOf(s) === 'array')
    out.push({ mutation: 'too-long', value: Array.from({ length: s.maxItems + 1 }, () => sampleFromSchema(s.items, {})), why: `more than maxItems ${s.maxItems}` });
  const badFormat: Record<string, string> = { email: 'not-an-email', uuid: 'not-a-uuid', 'date-time': 'not-a-date-time', date: 'not-a-date', uri: 'not a uri', ipv4: '999.1.1.1' };
  if (typeOf(s) === 'string' && typeof s.format === 'string' && badFormat[s.format]) out.push({ mutation: 'format', value: badFormat[s.format], why: `not a valid ${s.format}` });
  return out;
}

/** A path or query value for a parameter: its example, default, first enum value or a sample. */
function paramValue(doc: Json, p: Json): string {
  const s = deref(doc, p.schema) ?? p;
  const v = p.example ?? s?.example ?? s?.default ?? s?.enum?.[0] ?? sampleFromSchema(s, doc);
  if (v === null || v === undefined || v === 'string') return typeOf(s) === 'integer' || typeOf(s) === 'number' ? '1' : 'example';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

let seq = 0;

/** The cases for each operation of a document: the valid example, then one broken rule at a time. */
export function fuzzCases(
  text: string,
  opts: { baseUrl?: string; operations?: string[]; includeDelete?: boolean; maxPerOperation?: number } = {},
): { cases: FuzzCase[]; operations: number; baseUrl: string } {
  const doc = loadOpenApi(text) as Json;
  const v2 = !!doc.swagger;
  // auth and base URL as an import makes them ({{accessToken}}, {{apiKey}} … resolve from the environment)
  const auth = new Map<string, AuthConfig | undefined>();
  let base = '';
  try {
    const { collection } = importOpenApi(text);
    base = collection.variables.find((v) => v.key === 'baseUrl')?.value ?? '';
    const walk = (nodes: CollectionNode[]) => {
      for (const n of nodes) {
        if (n.kind === 'folder') walk(n.items);
        else if (n.kind === 'http') auth.set(`${n.request.method} ${n.request.url}`, n.request.auth);
      }
    };
    walk(collection.items);
  } catch {
    /* no auth then */
  }
  const baseUrl = (opts.baseUrl ?? base).replace(/\/$/, '');
  const max = Math.max(1, opts.maxPerOperation ?? 25);
  const wanted = opts.operations?.map((o) => o.toLowerCase());
  const cases: FuzzCase[] = [];
  let operations = 0;
  for (const [path, item0] of Object.entries((doc.paths as Json) ?? {})) {
    const item = deref(doc, item0) as Json;
    for (const method of METHODS) {
      const op = item?.[method] as Json | undefined;
      if (!op) continue;
      const label = `${method.toUpperCase()} ${path}`;
      if (method === 'delete' && !opts.includeDelete) continue;
      if (wanted && !wanted.includes(label.toLowerCase()) && !wanted.includes(String(op.operationId ?? '').toLowerCase())) continue;
      operations++;
      const own = ((op.parameters as unknown[]) ?? []).map((p) => deref(doc, p) as Json);
      const params = [...own, ...((item.parameters as unknown[]) ?? []).map((p) => deref(doc, p) as Json).filter((p) => !own.some((o) => o?.name === p?.name && o?.in === p?.in))].filter(Boolean);
      const pathParams = params.filter((p) => p.in === 'path');
      const query = params.filter((p) => p.in === 'query');
      const headerParams = params.filter((p) => p.in === 'header' && p.required);
      // the body: JSON with its schema, or none
      let bodySchema: any;
      let bodyExample: unknown;
      let bodyRequired = false;
      if (v2) {
        const bp = params.find((p) => p.in === 'body');
        if (bp) [bodySchema, bodyRequired] = [bp.schema, !!bp.required];
      } else if (op.requestBody) {
        const rb = deref(doc, op.requestBody) as Json;
        const ct = Object.keys(rb?.content ?? {}).find((k) => /json/.test(k));
        if (ct) [bodySchema, bodyExample, bodyRequired] = [rb.content[ct].schema, rb.content[ct].example, !!rb.required];
      }
      const validBody = bodySchema ? (bodyExample ?? sampleFromSchema(bodySchema, doc)) : undefined;
      const importUrl = '{{baseUrl}}' + path.replace(/\{([^}]+)\}/g, '{{$1}}');
      const reqAuth = auth.get(`${method.toUpperCase()} ${importUrl}`);

      const build = (o: { path?: Record<string, string>; query?: KeyValue[]; body?: { raw?: string; json?: unknown } | null } = {}): HttpRequestSpec => {
        const values = Object.fromEntries(pathParams.map((p) => [p.name, paramValue(doc, p)]));
        Object.assign(values, o.path ?? {});
        const url = baseUrl + path.replace(/\{([^}]+)\}/g, (_m, n: string) => encodeURIComponent(values[n] ?? 'example'));
        const q = o.query ?? query.filter((p) => p.required).map((p) => ({ key: String(p.name), value: paramValue(doc, p), enabled: true }));
        const headers: KeyValue[] = headerParams.map((p) => ({ key: String(p.name), value: paramValue(doc, p), enabled: true }));
        const b = o.body === undefined ? (validBody !== undefined ? { json: validBody } : null) : o.body;
        if (b) headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
        return { method: method.toUpperCase(), url, params: q, headers, auth: reqAuth, body: b ? { type: 'json', content: b.raw ?? JSON.stringify(b.json) } : undefined };
      };
      const mine: FuzzCase[] = [];
      const add = (name: string, mutation: FuzzMutation, request: HttpRequestSpec) =>
        mine.push({ id: `fz-${++seq}`, operation: label, name, mutation, expect: mutation === 'valid' ? 'accept' : 'reject', request });

      add('the valid example', 'valid', build());
      for (const p of pathParams) {
        const s = deref(doc, p.schema) ?? p;
        if (typeOf(s) === 'integer' || typeOf(s) === 'number') add(`path {${p.name}} not a number`, 'bad-path', build({ path: { [p.name]: 'not-a-number' } }));
        else if (s?.format === 'uuid') add(`path {${p.name}} not a uuid`, 'bad-path', build({ path: { [p.name]: 'not-a-uuid' } }));
      }
      const requiredQuery = query.filter((p) => p.required);
      for (const p of requiredQuery)
        add(`query "${p.name}" left out`, 'missing-query', build({ query: requiredQuery.filter((x) => x !== p).map((x) => ({ key: String(x.name), value: paramValue(doc, x), enabled: true })) }));
      for (const p of query) {
        const s = deref(doc, p.schema) ?? p;
        const others = requiredQuery.filter((x) => x !== p).map((x) => ({ key: String(x.name), value: paramValue(doc, x), enabled: true }));
        const wrong = typeOf(s) === 'integer' || typeOf(s) === 'number' ? 'not-a-number' : typeOf(s) === 'boolean' ? 'not-a-boolean' : undefined;
        if (wrong) add(`query "${p.name}" of the wrong type`, 'bad-query', build({ query: [...others, { key: String(p.name), value: wrong, enabled: true }] }));
        for (const r of ruleBreakers(s).slice(0, 2)) add(`query "${p.name}" ${r.why}`, 'bad-query', build({ query: [...others, { key: String(p.name), value: String(r.value), enabled: true }] }));
      }
      if (bodySchema) {
        add('a body that is not JSON', 'not-json', build({ body: { raw: '{"unfinished": ' } }));
        if (bodyRequired) add('no body', 'empty-body', build({ body: null }));
        const obj = objectSchema(doc, bodySchema);
        if (obj && validBody && typeof validBody === 'object' && !Array.isArray(validBody)) {
          const valid = validBody as Json;
          for (const k of obj.required) {
            const { [k]: _gone, ...rest } = valid;
            add(`body "${k}" left out`, 'missing-required', build({ body: { json: rest } }));
          }
          for (const [k, ps0] of Object.entries(obj.properties)) {
            const ps = deref(doc, ps0);
            const wrong = wrongType(ps);
            if (wrong !== undefined) add(`body "${k}" of the wrong type`, 'wrong-type', build({ body: { json: { ...valid, [k]: wrong } } }));
            for (const r of ruleBreakers(ps)) add(`body "${k}" ${r.why}`, r.mutation, build({ body: { json: { ...valid, [k]: r.value } } }));
          }
        } else {
          const wrong = wrongType(deref(doc, bodySchema));
          if (wrong !== undefined) add('a body of the wrong type', 'wrong-type', build({ body: { json: wrong } }));
        }
      }
      cases.push(...mine.slice(0, max));
    }
  }
  return { cases, operations, baseUrl };
}

const ERR_STATUS = /^[45]/;

/** The documented response codes of an operation (`200`, `4XX`, `default`). */
function documented(doc: Json, operation: string): string[] {
  const [m, ...rest] = operation.split(' ');
  const op = deref(doc, (doc.paths as Json)?.[rest.join(' ')])?.[m!.toLowerCase()];
  return Object.keys((op?.responses as Json) ?? {});
}

/** Send the cases and judge what came back. */
export async function runFuzz(
  text: string,
  cases: FuzzCase[],
  opts: {
    /** Fill {{variables}} (auth tokens) in a request. */
    resolve?: (r: HttpRequestSpec) => HttpRequestSpec;
    http?: HttpExecOptions;
    allowRemote?: boolean;
    concurrency?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    onResult?: (r: FuzzResult, done: number) => void;
  } = {},
): Promise<FuzzReport> {
  const doc = loadOpenApi(text) as Json;
  const resolve = opts.resolve ?? ((r) => r);
  for (const c of cases.slice(0, 1)) {
    const url = resolve(c.request).url;
    if (/\{\{/.test(url))
      throw new ApsError('ConfigurationError', `The URL ${url} still has a {{variable}}: give the base URL`, {
        suggestions: ['--base-url http://localhost:3000, or choose an environment that sets it.'],
      });
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new ApsError('ConfigurationError', `Not a full URL: ${url}`, { suggestions: ['Give the base URL of the API (--base-url http://localhost:3000): the document has none, or only a path.'] });
    }
    if (!opts.allowRemote && !isLocalHost(host))
      throw new ApsError('ConfigurationError', `Fuzzing the remote host "${host}" needs explicit opt-in`, {
        why: 'Fuzzing sends many requests with invalid data, and some create or change data.',
        suggestions: ['Fuzz a local or test copy of the API.', 'Only fuzz systems you own or are authorised to test: then allow remote hosts (--allow-remote).'],
      });
  }
  const results: FuzzResult[] = new Array(cases.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < cases.length && !opts.signal?.aborted) {
      const i = next++;
      const c = cases[i]!;
      let r: FuzzResult;
      try {
        const req = resolve(c.request);
        const { response } = await executeHttp({ ...req, settings: { ...req.settings, timeoutMs: opts.timeoutMs ?? 15_000, followRedirects: false } }, { ...opts.http, signal: opts.signal });
        const status = response.status;
        const docs = documented(doc, c.operation);
        const listed = docs.includes(String(status)) || docs.includes(`${String(status)[0]}XX`) || docs.includes(`${String(status)[0]}xx`) || docs.includes('default');
        const verdict: FuzzVerdict =
          status >= 500
            ? 'server-error'
            : c.expect === 'reject' && status < 400
              ? 'accepted-invalid'
              : c.expect === 'accept' && ERR_STATUS.test(String(status)) && ![401, 403, 404].includes(status)
                ? 'rejected-valid'
                : !listed
                  ? 'undocumented-status'
                  : 'ok';
        const message =
          verdict === 'server-error'
            ? `${status}: the server failed on ${c.name}`
            : verdict === 'accepted-invalid'
              ? `${status}: ${c.name} was accepted, though the document forbids it`
              : verdict === 'rejected-valid'
                ? `${status}: the valid example was rejected (check the example data or the auth)`
                : verdict === 'undocumented-status'
                  ? `${status} is not a documented response of ${c.operation}`
                  : `${status}`;
        r = { case: c, status, durationMs: response.durationMs, verdict, message, bodyPreview: response.bodyPreview?.slice(0, 300) };
      } catch (e) {
        r = { case: c, verdict: 'failed', message: (e as Error).message };
      }
      results[i] = r;
      opts.onResult?.(r, ++done);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, opts.concurrency ?? 4)) }, worker));
  const finished = results.filter(Boolean);
  // an operation whose valid example was refused (401 / 403) says so once: its other answers tell nothing about the input
  const refused = new Set(finished.filter((r) => r.case.mutation === 'valid' && (r.status === 401 || r.status === 403)).map((r) => r.case.operation));
  for (const r of finished) {
    if (!refused.has(r.case.operation)) continue;
    if (r.case.mutation === 'valid')
      Object.assign(r, { verdict: 'not-authorized', message: `${r.status}: the request was not authorized, so its variants were not judged (give the token: an environment, or --var accessToken=…)` });
    else if (r.status === 401 || r.status === 403) Object.assign(r, { verdict: 'not-judged', message: `${r.status}: not judged (the operation needs authorization)` });
  }
  const counts: Record<FuzzVerdict, number> = { 'server-error': 0, 'accepted-invalid': 0, 'rejected-valid': 0, 'undocumented-status': 0, 'not-authorized': 0, 'not-judged': 0, ok: 0, failed: 0 };
  for (const r of finished) counts[r.verdict]++;
  return { operations: new Set(cases.map((c) => c.operation)).size, cases: cases.length, results: finished, counts, serverErrors: counts['server-error'] };
}

/** The findings of a report as Markdown (a pull request comment, a file for the team). */
export function fuzzMarkdown(r: FuzzReport): string {
  const lines = [
    `## API fuzzing`,
    '',
    `${r.cases} requests to ${r.operations} operations: **${r.counts['server-error']} server errors**, ${r.counts['accepted-invalid']} invalid inputs accepted, ${r.counts['undocumented-status']} undocumented statuses.`,
    '',
  ];
  for (const v of ['server-error', 'accepted-invalid', 'undocumented-status', 'rejected-valid', 'not-authorized', 'failed'] as const) {
    const rows = r.results.filter((x) => x.verdict === v);
    if (!rows.length) continue;
    lines.push(
      `### ${{ 'server-error': 'Server errors', 'accepted-invalid': 'Invalid input accepted', 'undocumented-status': 'Undocumented statuses', 'rejected-valid': 'Valid example rejected', 'not-authorized': 'Not authorized', failed: 'Could not send' }[v]}`,
      '',
    );
    for (const x of rows.slice(0, 50)) lines.push(`- \`${x.case.operation}\` · ${x.case.name}: ${x.message}`);
    lines.push('');
  }
  return lines.join('\n');
}
