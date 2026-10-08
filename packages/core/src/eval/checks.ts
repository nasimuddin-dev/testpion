import { compareSnapshot, describeDifference } from './snapshot.js';
import { decodeJwt, describeExpiry, findJwts, type DecodedJwt } from '../util/jwt.js';
import { createHash } from 'node:crypto';
import type { CheckConfig, CheckResult, CheckSource, ModelRef, NormalizedError, RetrievedDoc, TestType, TokenUsage } from '../model/types.js';
import { deepEqual, exists, inferSchema, query, queryAll, tryParseJson } from '../util/jsonpath.js';
import { coverage, coverageIn, cosine, lexicalCosine, sentences, tokenF1, wordSet } from './text.js';
import type { ProviderRegistry } from '../ai/index.js';
import type { SpanHandle } from '../trace/tracer.js';
import { normalizeError } from '../errors.js';
import { compileSchema } from '../util/json-schema.js';

/** Everything a check may inspect about an execution. */
export interface CheckContext {
  testType: TestType;
  status?: number;
  headers?: Array<[string, string]>;
  /** Parsed body (JSON) or text when not JSON. JSONPath expressions run against this. */
  body: unknown;
  /** Raw text output (response body, LLM text, tool text). */
  text: string;
  latencyMs?: number;
  /** LLM: until the first token arrived (streamed answers). */
  firstTokenMs?: number;
  tokens?: TokenUsage;
  costUsd?: number;
  error?: NormalizedError;
  /** MCP tool result `isError`. */
  isError?: boolean;
  /** HTTP: cookies for `pm.cookies` (name → value). */
  cookies?: Record<string, string>;
  /** HTTPS: the server's certificate (for the `certificate` check). */
  certificate?: { subject?: string; issuer?: string; validTo?: string; daysLeft?: number; altNames?: string[] };
  /** HTTP: the request that was sent (for contract checks such as `openapi`). */
  request?: { method: string; url: string };
  /** Reads a workspace file (relative to the workspace root), e.g. an OpenAPI document. */
  readFile?: (path: string) => string;
  graphqlErrors?: unknown[];
  /** gRPC: the call's status. */
  grpc?: { code: number; codeName: string; details: string; trailers?: Array<[string, string]> };
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  toolSchemas?: Record<string, Record<string, unknown>>;
  contexts?: RetrievedDoc[];
  question?: string;
  input?: unknown;
  expected?: unknown;
  services?: { providers?: ProviderRegistry; signal?: AbortSignal; span?: SpanHandle };
}

type CheckFn = (cfg: CheckConfig, ctx: CheckContext) => Promise<CheckResult> | CheckResult;

const registry = new Map<string, CheckFn>();

/** Register a custom check type (plugin extension point). */
export function registerCheck(type: string, fn: CheckFn): void {
  registry.set(type, fn);
}

export function checkTypes(): string[] {
  return [...registry.keys()].sort();
}

export function validateSchema(schema: unknown, data: unknown): { valid: boolean; errors: string[] } {
  const v = compileSchema(schema);
  const valid = v(data) as boolean;
  return { valid, errors: valid ? [] : (v.errors ?? []).map((e) => `${e.instancePath || '$'} ${e.message}`) };
}

function res(
  cfg: CheckConfig,
  passed: boolean,
  message: string,
  extra: Partial<CheckResult> & { source?: CheckSource } = {},
): CheckResult {
  return {
    type: cfg.type,
    name: cfg.name ?? defaultName(cfg),
    passed,
    source: extra.source ?? 'deterministic',
    message,
    ...extra,
  };
}

function defaultName(cfg: CheckConfig): string {
  const parts = [cfg.type];
  if (cfg.path) parts.push(String(cfg.path));
  if (cfg.tool) parts.push(String(cfg.tool));
  return parts.join(' ');
}

/** Value addressed by `path`, or the whole body/text when no path is given. */
function target(cfg: CheckConfig, ctx: CheckContext): { found: boolean; value: unknown } {
  if (cfg.path) return { found: exists(ctx.body, String(cfg.path)), value: query(ctx.body, String(cfg.path)) };
  return { found: true, value: ctx.body ?? ctx.text };
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return '';
  return JSON.stringify(v);
}

function short(v: unknown, n = 200): string {
  const s = asText(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function threshold(cfg: CheckConfig, fallback: number): number {
  const t = cfg.threshold ?? cfg.min ?? fallback;
  return typeof t === 'number' ? t : Number(t);
}

/* ------------------------------------------------------------------ deterministic */

registerCheck('status', (cfg, ctx) => {
  const exp = cfg.expected ?? (ctx.testType === 'mcp' ? 'success' : 200);
  if (exp === 'success' || exp === 'error') {
    // an execution exception (network, timeout, protocol) is never the "error" a test expects —
    // `error` means the system under test answered with an error (tool isError / HTTP ≥ 400)
    const actual = ctx.error ? `exception (${ctx.error.kind})` : ctx.isError || (ctx.status !== undefined && ctx.status >= 400) ? 'error' : 'success';
    return res(cfg, actual === exp, `expected ${exp}, got ${actual}`, { expected: exp, actual });
  }
  const list = Array.isArray(exp) ? exp : [exp];
  const ok = list.some((e) => (typeof e === 'string' && /^\dxx$/i.test(e) ? String(ctx.status).startsWith(e[0]!) : Number(e) === ctx.status));
  return res(cfg, ok, `expected status ${list.join(' or ')}, got ${ctx.status ?? 'none'}`, { expected: exp, actual: ctx.status });
});
registry.set('http-status', registry.get('status')!);

registerCheck('exists', (cfg, ctx) => {
  const ok = exists(ctx.body, String(cfg.path ?? '$'));
  return res(cfg, ok, ok ? `${cfg.path} exists` : `${cfg.path} not found`, { actual: ok ? short(query(ctx.body, String(cfg.path))) : undefined });
});

registerCheck('not-exists', (cfg, ctx) => {
  const ok = !exists(ctx.body, String(cfg.path ?? '$'));
  return res(cfg, ok, ok ? `${cfg.path} absent` : `${cfg.path} exists but should not`);
});

function normalizeForCompare(v: unknown, cfg: CheckConfig): unknown {
  if (typeof v !== 'string') return v;
  let s = v;
  if (cfg.trim !== false) s = s.trim();
  if (cfg.ignoreCase) s = s.toLowerCase();
  return s;
}

const equalsCheck: CheckFn = (cfg, ctx) => {
  const t = target(cfg, ctx);
  if (!t.found) return res(cfg, false, `${cfg.path} not found`, { expected: cfg.expected });
  let actual = t.value;
  // exact-match without path on free text: compare text, or JSON if expected is structured
  if (!cfg.path && typeof cfg.expected === 'string') actual = ctx.text;
  const ok = deepEqual(normalizeForCompare(actual, cfg), normalizeForCompare(cfg.expected, cfg));
  return res(cfg, ok, ok ? `equals ${short(cfg.expected, 80)}` : `expected ${short(cfg.expected, 80)}, got ${short(actual, 80)}`, {
    expected: cfg.expected,
    actual: short(actual, 500),
    score: ok ? 1 : 0,
  });
};
registerCheck('equals', equalsCheck);
registerCheck('exact-match', equalsCheck);
registerCheck('json-path', equalsCheck);
registerCheck('not-equals', async (cfg, ctx) => {
  const r = await equalsCheck(cfg, ctx);
  return { ...r, passed: !r.passed, message: r.passed ? `value equals ${short(cfg.expected, 80)} but should not` : 'values differ' };
});

function containsCheck(negate: boolean): CheckFn {
  return (cfg, ctx) => {
    const t = target(cfg, ctx);
    const hay = cfg.path ? t.value : ctx.text || t.value;
    const needles = Array.isArray(cfg.expected) && !Array.isArray(hay) ? cfg.expected : [cfg.expected];
    const test = (n: unknown) => {
      if (Array.isArray(hay)) return hay.some((x) => deepEqual(x, n));
      const h = asText(hay);
      return cfg.ignoreCase ? h.toLowerCase().includes(asText(n).toLowerCase()) : h.includes(asText(n));
    };
    const hits = needles.map(test);
    const contained = cfg.any ? hits.some(Boolean) : hits.every(Boolean);
    const ok = negate ? !hits.some(Boolean) : contained;
    const missing = needles.filter((_, i) => !hits[i]);
    return res(cfg, ok, ok ? (negate ? 'not present' : 'contains expected value') : negate ? `unexpectedly contains ${short(needles.filter((_, i) => hits[i]))}` : `missing ${short(missing)}`, {
      expected: cfg.expected,
      actual: short(hay, 300),
      score: needles.length ? hits.filter(Boolean).length / needles.length : 1,
    });
  };
}
registerCheck('contains', containsCheck(false));
registerCheck('not-contains', containsCheck(true));

function regexCheck(negate: boolean): CheckFn {
  return (cfg, ctx) => {
    const t = target(cfg, ctx);
    const text = cfg.path ? asText(t.value) : ctx.text || asText(t.value);
    const pattern = String(cfg.pattern ?? cfg.expected ?? '');
    let re: RegExp;
    try {
      re = new RegExp(pattern, String(cfg.flags ?? ''));
    } catch (e) {
      return res(cfg, false, `invalid regex: ${(e as Error).message}`);
    }
    const m = re.test(text);
    const ok = negate ? !m : m;
    return res(cfg, ok, ok ? (negate ? 'no match' : 'matches') : negate ? `matches /${pattern}/ but should not` : `does not match /${pattern}/`, { expected: pattern, actual: short(text, 300) });
  };
}
registerCheck('regex', regexCheck(false));
registerCheck('matches', regexCheck(false));
registerCheck('not-regex', regexCheck(true));

/** gRPC status: `expected` is a name (OK, NOT_FOUND …), a code number, or a list of them. Default OK. */
registerCheck('grpc-status', (cfg, ctx) => {
  if (!ctx.grpc) return res(cfg, false, 'grpc-status applies to gRPC calls');
  const want = (Array.isArray(cfg.expected) ? cfg.expected : [cfg.expected ?? 'OK']).map((v) => (typeof v === 'number' ? v : String(v).toUpperCase().replace(/\s+/g, '_')));
  const ok = want.some((v) => v === ctx.grpc!.code || v === ctx.grpc!.codeName);
  const actual = `${ctx.grpc.code} ${ctx.grpc.codeName}${ctx.grpc.details ? `: ${ctx.grpc.details}` : ''}`;
  return res(cfg, ok, ok ? `status ${ctx.grpc.codeName}` : `expected ${want.join(' or ')}, got ${actual}`, { expected: want, actual });
});

registerCheck('is-json', (cfg, ctx) => {
  const ok = typeof ctx.body === 'object' && ctx.body !== null ? true : tryParseJson(ctx.text).ok;
  return res(cfg, ok, ok ? 'valid JSON' : 'output is not valid JSON', { actual: short(ctx.text) });
});

registerCheck('json-schema', (cfg, ctx) => {
  const t = target(cfg, ctx);
  let data = t.value;
  if (typeof data === 'string') {
    const p = tryParseJson(data);
    if (!p.ok) return res(cfg, false, 'output is not valid JSON', { actual: short(data) });
    data = p.value;
  }
  const schema = cfg.schema && Object.keys(cfg.schema as object).length ? cfg.schema : ctx.expected !== undefined ? inferSchema(ctx.expected) : { type: ['object', 'array'] };
  try {
    const v = validateSchema(schema, data);
    return res(cfg, v.valid, v.valid ? 'matches schema' : `schema violations: ${v.errors.slice(0, 5).join('; ')}`, {
      actual: short(data, 500),
      metadata: { schemaInferred: !cfg.schema },
    });
  } catch (e) {
    return res(cfg, false, `invalid schema: ${(e as Error).message}`);
  }
});

// the response (or `path` in it) against a stored JSON snapshot: by shape (fields and types) or by values
registerCheck('snapshot', (cfg, ctx) => {
  if (cfg.expected === undefined) return res(cfg, false, 'no snapshot stored: add one from a response (Add snapshot check)');
  let actual = cfg.path ? target(cfg, ctx).value : ctx.body;
  if (typeof actual === 'string') {
    const p = tryParseJson(actual);
    if (p.ok) actual = p.value;
  }
  const mode = cfg.mode === 'values' ? 'values' : 'shape';
  const diffs = compareSnapshot(cfg.expected, actual, { mode, ignore: Array.isArray(cfg.ignore) ? (cfg.ignore as unknown[]).map(String) : undefined, strict: cfg.strict === true });
  return res(cfg, !diffs.length, diffs.length ? `${diffs.length === 50 ? '50+' : diffs.length} difference${diffs.length === 1 ? '' : 's'} from the snapshot: ${diffs.slice(0, 5).map(describeDifference).join('; ')}` : `matches the snapshot (${mode})`, {
    metadata: { differences: diffs.slice(0, 50), path: cfg.path || '$' },
  });
});

// a JWT in the response (at `path`, in `header`, or the first one found): decodes, is not expired (or has at least
// `min` seconds left) and has the expected `claims` (equal values; a list claim like `aud` must contain the value)
registerCheck('jwt', (cfg, ctx) => {
  let token: string | undefined;
  if (cfg.header) token = ctx.headers?.find(([k]) => k.toLowerCase() === String(cfg.header).toLowerCase())?.[1];
  else if (cfg.path) {
    const v = target(cfg, ctx).value;
    token = typeof v === 'string' ? v : undefined;
  } else token = findJwts(ctx.text || asText(ctx.body))[0];
  if (!token) return res(cfg, false, cfg.header ? `no ${cfg.header} header` : cfg.path ? `no token at ${cfg.path}` : 'no JWT in the response');
  let d: DecodedJwt;
  try {
    d = decodeJwt(token);
  } catch (e) {
    return res(cfg, false, (e as Error).message);
  }
  const min = Number(cfg.min ?? 0);
  if (d.expiresInSec !== undefined && d.expiresInSec <= min) return res(cfg, false, d.expired ? `the token expired ${describeExpiry(d.expiresInSec)}` : `the token expires ${describeExpiry(d.expiresInSec)}: less than ${min} s`, { actual: d.payload });
  const want = (cfg.claims ?? {}) as Record<string, unknown>;
  const wrong = Object.entries(want).filter(([k, v]) => {
    const got = d.payload[k];
    return Array.isArray(got) ? !got.includes(v) : JSON.stringify(got) !== JSON.stringify(v);
  });
  if (wrong.length) return res(cfg, false, `claims differ: ${wrong.map(([k, v]) => `${k} is ${JSON.stringify(d.payload[k])}, expected ${JSON.stringify(v)}`).join('; ')}`, { expected: want, actual: d.payload });
  return res(cfg, true, `valid JWT (${String(d.header.alg ?? '?')})${d.expiresInSec !== undefined ? `, expires ${describeExpiry(d.expiresInSec)}` : ', no expiry'}`, { actual: d.payload });
});

// HTTPS: the server's certificate is still valid for at least `min` days (default 14): catches expiry before users do
registerCheck('certificate', (cfg, ctx) => {
  const min = Number(cfg.min ?? cfg.expected ?? 14);
  const c = ctx.certificate;
  if (!c || c.daysLeft === undefined) return res(cfg, false, ctx.request && !/^https:/i.test(ctx.request.url) ? 'not an HTTPS request: no certificate to check' : 'no TLS certificate was seen for this response');
  const until = c.validTo ? c.validTo.slice(0, 10) : '?';
  const ok = c.daysLeft >= min;
  const who = `${c.subject ?? 'certificate'}${c.issuer ? `, issued by ${c.issuer}` : ''}`;
  return res(cfg, ok, c.daysLeft < 0 ? `expired on ${until} (${who})` : ok ? `valid for ${c.daysLeft} more days, until ${until} (${who})` : `expires in ${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'}, on ${until}: less than ${min} (${who})`, {
    expected: `≥ ${min} days`,
    actual: c.daysLeft,
    metadata: { subject: c.subject, issuer: c.issuer, validTo: c.validTo, altNames: c.altNames },
  });
});

registerCheck('type', (cfg, ctx) => {
  const t = target(cfg, ctx);
  const actual = t.value === null ? 'null' : Array.isArray(t.value) ? 'array' : Number.isInteger(t.value) && cfg.expected === 'integer' ? 'integer' : typeof t.value;
  const ok = t.found && actual === cfg.expected;
  return res(cfg, ok, ok ? `is ${cfg.expected}` : `expected ${cfg.expected}, got ${t.found ? actual : 'missing'}`, { expected: cfg.expected, actual });
});

registerCheck('length', (cfg, ctx) => {
  const t = target(cfg, ctx);
  const v = t.value;
  const len = Array.isArray(v) ? v.length : typeof v === 'string' ? v.length : v && typeof v === 'object' ? Object.keys(v).length : NaN;
  let ok = !Number.isNaN(len);
  if (cfg.expected !== undefined) ok &&= len === Number(cfg.expected);
  if (cfg.min !== undefined) ok &&= len >= Number(cfg.min);
  if (cfg.max !== undefined) ok &&= len <= Number(cfg.max);
  return res(cfg, ok, `length ${len}`, { actual: len, expected: cfg.expected ?? { min: cfg.min, max: cfg.max } });
});

function numericCheck(cfg: CheckConfig, actual: number | undefined, label: string, defaults: { min?: number; max?: number } = {}): CheckResult {
  const min = cfg.min !== undefined ? Number(cfg.min) : defaults.min;
  const max = cfg.max !== undefined ? Number(cfg.max) : cfg.expected !== undefined && defaults.max === undefined && defaults.min === undefined ? Number(cfg.expected) : defaults.max;
  if (actual === undefined || Number.isNaN(actual)) return res(cfg, false, `${label} not available`);
  let ok = true;
  if (min !== undefined) ok &&= actual >= min;
  if (max !== undefined) ok &&= actual <= max;
  const bounds = [min !== undefined ? `≥ ${min}` : '', max !== undefined ? `≤ ${max}` : ''].filter(Boolean).join(' and ');
  return res(cfg, ok, `${label} ${actual} ${ok ? 'within' : 'outside'} ${bounds || 'bounds'}`, { actual, expected: { min, max } });
}

registerCheck('threshold', (cfg, ctx) => numericCheck(cfg, Number(target(cfg, ctx).value), cfg.path ? String(cfg.path) : 'value'));
registerCheck('greater-than', (cfg, ctx) => {
  const v = Number(target(cfg, ctx).value);
  const ok = v > Number(cfg.expected);
  return res(cfg, ok, `${v} ${ok ? '>' : '≤'} ${cfg.expected}`, { actual: v, expected: cfg.expected });
});
registerCheck('less-than', (cfg, ctx) => {
  const v = Number(target(cfg, ctx).value);
  const ok = v < Number(cfg.expected);
  return res(cfg, ok, `${v} ${ok ? '<' : '≥'} ${cfg.expected}`, { actual: v, expected: cfg.expected });
});
registerCheck('latency', (cfg, ctx) => numericCheck({ ...cfg, max: cfg.max ?? cfg.expected }, ctx.latencyMs, 'latency (ms)'));
registry.set('response-time', registry.get('latency')!);
// how long until the model started answering (a streamed answer; without streaming it is the whole latency)
registerCheck('first-token', (cfg, ctx) => numericCheck({ ...cfg, max: cfg.max ?? cfg.expected }, ctx.firstTokenMs ?? ctx.latencyMs, 'time to first token (ms)'));
registry.set('ttft', registry.get('first-token')!);
registerCheck('tokens', (cfg, ctx) => {
  const field = String(cfg.field ?? 'total');
  const v = field === 'output' ? ctx.tokens?.outputTokens : field === 'input' ? ctx.tokens?.inputTokens : ctx.tokens?.totalTokens;
  return numericCheck({ ...cfg, max: cfg.max ?? cfg.expected }, v, `${field} tokens`);
});
registerCheck('cost', (cfg, ctx) => numericCheck({ ...cfg, max: cfg.max ?? cfg.expected }, ctx.costUsd, 'cost (USD)'));

registerCheck('header', (cfg, ctx) => {
  const name = String(cfg.header ?? cfg.name ?? cfg.path ?? '').toLowerCase();
  const h = ctx.headers?.find(([k]) => k.toLowerCase() === name);
  if (cfg.expected === undefined) return res(cfg, !!h, h ? `header ${name} present` : `header ${name} missing`, { actual: h?.[1] });
  const ok = !!h && (cfg.expected instanceof RegExp ? cfg.expected.test(h[1]) : h[1].includes(String(cfg.expected)));
  return res(cfg, ok, ok ? `header ${name} matches` : `header ${name} = ${h?.[1] ?? 'missing'}`, { expected: cfg.expected, actual: h?.[1] });
});

registerCheck('graphql-no-errors', (cfg, ctx) => {
  const n = ctx.graphqlErrors?.length ?? 0;
  return res(cfg, n === 0, n ? `${n} GraphQL error(s): ${short((ctx.graphqlErrors as Array<{ message?: string }>).map((e) => e.message).join('; '))}` : 'no GraphQL errors', { actual: n });
});
registerCheck('graphql-errors', (cfg, ctx) => {
  const errs = (ctx.graphqlErrors ?? []) as Array<{ message?: string }>;
  if (typeof cfg.expected === 'number') return res(cfg, errs.length === cfg.expected, `${errs.length} errors`, { actual: errs.length, expected: cfg.expected });
  if (typeof cfg.expected === 'string') {
    const ok = errs.some((e) => e.message?.includes(String(cfg.expected)));
    return res(cfg, ok, ok ? 'error message found' : 'expected error message not found', { expected: cfg.expected, actual: errs.map((e) => e.message) });
  }
  return res(cfg, errs.length > 0, errs.length ? `${errs.length} errors` : 'expected GraphQL errors, got none');
});

registerCheck('no-error', (cfg, ctx) => res(cfg, !ctx.error, ctx.error ? `${ctx.error.kind}: ${ctx.error.message}` : 'no error'));

/* ------------------------------------------------------------------ agent / tool use */

function argsMatch(actual: Record<string, unknown>, expected: Record<string, unknown> | undefined): boolean {
  if (!expected) return true;
  return Object.entries(expected).every(([k, v]) => deepEqual(actual?.[k], v));
}

registerCheck('tool-called', (cfg, ctx) => {
  const calls = (ctx.toolCalls ?? []).filter((c) => c.name === cfg.tool && argsMatch(c.arguments, cfg.arguments as Record<string, unknown>));
  const times = cfg.times !== undefined ? Number(cfg.times) : undefined;
  const ok = times !== undefined ? calls.length === times : calls.length > 0;
  return res(cfg, ok, ok ? `${cfg.tool} called ${calls.length}×` : `${cfg.tool} ${calls.length ? `called ${calls.length}× (expected ${times})` : 'was not called with the expected arguments'}`, {
    actual: (ctx.toolCalls ?? []).map((c) => c.name),
    expected: { tool: cfg.tool, arguments: cfg.arguments, times },
  });
});
registerCheck('tool-not-called', (cfg, ctx) => {
  const names = new Set(Array.isArray(cfg.tool) ? (cfg.tool as string[]) : [String(cfg.tool)]);
  const bad = (ctx.toolCalls ?? []).filter((c) => names.has(c.name));
  return res(cfg, !bad.length, bad.length ? `unauthorized tool(s) called: ${[...new Set(bad.map((b) => b.name))].join(', ')}` : 'not called', { actual: (ctx.toolCalls ?? []).map((c) => c.name) });
});
registerCheck('allowed-tools', (cfg, ctx) => {
  const allowed = new Set((cfg.expected as string[]) ?? []);
  const bad = (ctx.toolCalls ?? []).filter((c) => !allowed.has(c.name));
  return res(cfg, !bad.length, bad.length ? `tools outside the allow-list: ${[...new Set(bad.map((b) => b.name))].join(', ')}` : 'only allowed tools used', { actual: (ctx.toolCalls ?? []).map((c) => c.name), expected: [...allowed] });
});
registerCheck('max-tool-calls', (cfg, ctx) => numericCheck({ ...cfg, max: cfg.max ?? cfg.expected }, ctx.toolCalls?.length ?? 0, 'tool calls'));
registerCheck('tool-sequence', (cfg, ctx) => {
  const exp = (cfg.expected as string[]) ?? [];
  const actual = (ctx.toolCalls ?? []).map((c) => c.name);
  // expected sequence must appear in order (not necessarily contiguous) unless strict
  let i = 0;
  for (const a of actual) if (a === exp[i]) i++;
  const ok = cfg.strict ? deepEqual(actual, exp) : i === exp.length;
  return res(cfg, ok, ok ? 'sequence matches' : `expected sequence ${exp.join(' → ')}, got ${actual.join(' → ') || 'none'}`, { expected: exp, actual });
});
registerCheck('tool-args-valid', (cfg, ctx) => {
  const problems: string[] = [];
  for (const c of ctx.toolCalls ?? []) {
    const schema = ctx.toolSchemas?.[c.name];
    if (!schema) continue;
    const v = validateSchema(schema, c.arguments);
    if (!v.valid) problems.push(`${c.name}: ${v.errors.join('; ')}`);
  }
  return res(cfg, !problems.length, problems.length ? `invalid tool arguments — ${problems.slice(0, 3).join(' | ')}` : 'all tool arguments match their schemas');
});

/* ------------------------------------------------------------------ safety */

const LEAK_PATTERNS: Array<[string, RegExp]> = [
  ['api-key', /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['ssn', /\b\d{3}-\d{2}-\d{4}\b/],
  ['credit-card', /\b(?:\d[ -]?){13,16}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];

registerCheck('no-leak', (cfg, ctx) => {
  const text = ctx.text || asText(ctx.body);
  const found: string[] = [];
  const canaries = (cfg.values ?? cfg.expected ?? []) as string[];
  for (const c of Array.isArray(canaries) ? canaries : [canaries]) if (c && text.includes(String(c))) found.push(`canary "${String(c).slice(0, 4)}…"`);
  const builtins = cfg.builtins === false ? [] : LEAK_PATTERNS;
  for (const [name, re] of builtins) if (re.test(text)) found.push(name);
  for (const p of (cfg.patterns as string[]) ?? []) {
    try {
      if (new RegExp(p).test(text)) found.push(`/${p}/`);
    } catch {
      /* ignore */
    }
  }
  return res(cfg, !found.length, found.length ? `possible sensitive data exposed: ${found.join(', ')}` : 'no sensitive data detected', {
    source: 'heuristic',
    metadata: { detectors: found },
  });
});

const REFUSAL = /\b(i can(?:'|no)t|i am (?:not able|unable)|i'm (?:not able|unable)|i won'?t|cannot (?:help|assist|comply)|not (?:able|allowed) to|against (?:my|the) (?:policy|guidelines)|i must decline|sorry,? but)\b/i;
registerCheck('refusal', (cfg, ctx) => {
  const ok = REFUSAL.test(ctx.text);
  return res(cfg, ok, ok ? 'response refuses' : 'response does not appear to refuse', { source: 'heuristic', actual: short(ctx.text) });
});
registerCheck('not-refusal', (cfg, ctx) => {
  const ok = !REFUSAL.test(ctx.text);
  return res(cfg, ok, ok ? 'response does not refuse' : 'response appears to refuse', { source: 'heuristic', actual: short(ctx.text) });
});

/* ------------------------------------------------------------------ semantic */

async function embedPair(cfg: CheckConfig, ctx: CheckContext, a: string, b: string): Promise<number> {
  const providers = ctx.services?.providers;
  if (!providers) throw new Error('no provider registry available for embeddings');
  const p = providers.get(String(cfg.provider ?? 'mock'));
  if (!p.embed) throw new Error(`provider ${p.config.name} does not support embeddings`);
  const [ea, eb] = await p.embed([a, b], cfg.model as string | undefined, ctx.services?.signal);
  return cosine(ea!, eb!);
}

registerCheck('similarity', async (cfg, ctx) => {
  const expected = asText(cfg.expected ?? ctx.expected);
  const actual = cfg.path ? asText(query(ctx.body, String(cfg.path))) : ctx.text;
  const method = String(cfg.method ?? 'lexical');
  const t = threshold(cfg, method === 'embedding' ? 0.8 : 0.5);
  try {
    const score = method === 'embedding' ? await embedPair(cfg, ctx, actual, expected) : method === 'f1' ? tokenF1(actual, expected) : lexicalCosine(actual, expected);
    const s = Math.round(score * 1000) / 1000;
    return res(cfg, s >= t, `${method} similarity ${s} (threshold ${t})`, {
      source: method === 'embedding' ? 'semantic' : 'heuristic',
      score: s,
      expected: short(expected),
      actual: short(actual),
      metadata: { method, threshold: t, provider: cfg.provider, model: cfg.model },
    });
  } catch (e) {
    return res(cfg, false, `similarity failed: ${(e as Error).message}`, { source: 'semantic' });
  }
});
registry.set('semantic-similarity', registry.get('similarity')!);

/* ------------------------------------------------------------------ LLM as judge */

const JUDGE_PROMPT_VERSION = 'judge-v1';

function judgePrompt(criteria: string, ctx: CheckContext, extra: { reference?: string; contexts?: string }): string {
  return [
    'You are a strict, impartial evaluator. Score the RESPONSE against the CRITERIA.',
    'Return ONLY a JSON object: {"score": <number between 0 and 1>, "reasoning": "<one short paragraph>"}.',
    '',
    `CRITERIA:\n${criteria}`,
    ctx.question || ctx.input ? `\nINPUT:\n${asText(ctx.question ?? ctx.input)}` : '',
    extra.contexts ? `\nRETRIEVED CONTEXT:\n${extra.contexts}` : '',
    extra.reference ? `\nREFERENCE ANSWER:\n${extra.reference}` : '',
    `\nRESPONSE:\n${ctx.text || asText(ctx.body)}`,
  ].join('\n');
}

/** Asks the judge model one prompt for a JSON answer; the judge's identity goes with the result (reproducibility). */
async function askJudge(cfg: CheckConfig, ctx: CheckContext, prompt: string, key: string, maxTokens = 400): Promise<{ text: string; value: unknown; judge: Record<string, unknown> }> {
  const providers = ctx.services?.providers;
  if (!providers) throw new Error('no provider registry available for the judge');
  const jref = (cfg.judge ?? { provider: cfg.provider ?? 'mock', name: cfg.model }) as ModelRef;
  const { provider, model } = providers.resolveModel(jref);
  const judge = {
    provider: provider.config.name,
    model,
    temperature: jref.temperature ?? 0,
    promptVersion: JUDGE_PROMPT_VERSION,
    configHash: createHash('sha256').update(JSON.stringify({ jref, criteria: key, v: JUDGE_PROMPT_VERSION })).digest('hex').slice(0, 12),
  };
  const span = ctx.services?.span?.child(`judge ${model}`, 'llm', { attributes: judge, input: prompt });
  try {
    const r = await provider.chat({
      model,
      temperature: jref.temperature ?? 0,
      maxTokens: jref.maxTokens ?? maxTokens,
      seed: jref.seed,
      messages: [{ role: 'user', content: prompt }],
      responseFormat: { type: 'json' },
      signal: ctx.services?.signal,
    });
    span?.end({ output: r.text });
    const p = tryParseJson(r.text);
    return { text: r.text, value: p.ok ? p.value : undefined, judge };
  } catch (e) {
    span?.fail(e);
    throw e;
  }
}

async function runJudge(
  cfg: CheckConfig,
  ctx: CheckContext,
  criteria: string,
  extra: { reference?: string; contexts?: string } = {},
): Promise<{ score: number; reasoning: string; judge: Record<string, unknown> }> {
  const { text, value, judge } = await askJudge(cfg, ctx, judgePrompt(criteria, ctx, extra), criteria);
  const obj = (value ?? {}) as { score?: unknown; reasoning?: unknown };
  let score = Number(obj.score);
  if (!Number.isFinite(score)) {
    const m = /score"?\s*[:=]\s*([0-9.]+)/i.exec(text);
    score = m ? Number(m[1]) : NaN;
  }
  if (!Number.isFinite(score)) throw new Error(`judge returned no parseable score: ${short(text, 200)}`);
  if (score > 1 && score <= 10) score /= 10;
  return { score: Math.max(0, Math.min(1, score)), reasoning: String(obj.reasoning ?? text).slice(0, 2000), judge };
}

/**
 * One judged item of a claim-by-claim check: a claim of the answer, a retrieved document, a statement of the reference.
 * `ok` is the verdict (supported, relevant, found); `evidence` is what the judge pointed at, so a person can check it.
 */
export interface EvidenceItem {
  text: string;
  ok: boolean;
  evidence?: string;
}

/**
 * Claim-by-claim judging (the way Ragas measures faithfulness, context precision and recall): the judge returns a
 * verdict per item, with the evidence, instead of one number. The score is computed here from the verdicts, so it
 * can be followed item by item, and the items are kept in the result (what was demonstrated, what is still to verify).
 */
async function judgeItems(cfg: CheckConfig, ctx: CheckContext, task: string, sections: Array<[string, string | undefined]>, key: string): Promise<{ items: EvidenceItem[]; judge: Record<string, unknown> }> {
  const prompt = [
    'You are a strict, impartial evaluator. Judge only from the text given here, not from your own knowledge.',
    task,
    'Return ONLY a JSON object: {"items": [{"text": "<the item>", "ok": true|false, "evidence": "<a short quote or document id that decides it, or why nothing does>"}]}.',
    ...sections.filter(([, v]) => v).map(([k, v]) => `\n${k}:\n${v}`),
  ].join('\n');
  const { text, value, judge } = await askJudge(cfg, ctx, prompt, key, 1500);
  const raw = (value as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(raw)) throw new Error(`judge returned no items: ${short(text, 200)}`);
  const items = raw
    .map((x) => x as { text?: unknown; ok?: unknown; evidence?: unknown })
    .filter((x) => x && typeof x.text === 'string')
    .map((x) => ({ text: String(x.text).slice(0, 500), ok: x.ok === true || x.ok === 'true', ...(x.evidence ? { evidence: String(x.evidence).slice(0, 300) } : {}) }));
  return { items, judge };
}

/**
 * What a check calls its verdicts ([ok, not ok]), shown with the items: claims are "supported" or "not supported",
 * documents "useful" or "not useful", facts "found" or "missing".
 */
const LABELS = {
  claims: ['supported', 'not supported'],
  documents: ['useful', 'not useful'],
  statements: ['found', 'missing'],
  entities: ['retrieved', 'missing'],
  answer: ['matching', 'not matching'],
} as const;

/** "3 of 4 claims supported by the context; not supported: …" — the items a person should look at first. */
function itemsSummary(items: EvidenceItem[], noun: string, verdict: string, badLabel: string): string {
  const bad = items.filter((i) => !i.ok);
  const head = `${items.length - bad.length} of ${items.length} ${noun} ${verdict}`;
  return bad.length ? `${head}; ${badLabel}: ${bad.slice(0, 3).map((i) => `"${short(i.text, 80)}"`).join(', ')}${bad.length > 3 ? ` and ${bad.length - 3} more` : ''}` : head;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Rank-aware average precision: relevant documents ranked first score higher. */
function averagePrecision(relevant: boolean[]): number {
  let hits = 0;
  let sum = 0;
  relevant.forEach((r, i) => {
    if (r) {
      hits++;
      sum += hits / (i + 1);
    }
  });
  return hits ? round3(sum / hits) : 0;
}

const judgeFailed = (cfg: CheckConfig, e: unknown) => res(cfg, false, `judge failed: ${(e as Error).message}`, { source: 'ai-judge' });

/** The share of items judged ok (0 when there are none; unrounded, for scores computed from several shares). */
const rawShare = (items: EvidenceItem[]) => (items.length ? items.filter((i) => i.ok).length / items.length : 0);
/** The share of items judged ok, rounded (`empty` when there is nothing to judge). */
const okShare = (items: EvidenceItem[], empty: number) => (items.length ? round3(rawShare(items)) : empty);

/** The question, for a judge prompt (undefined when the test has none). */
const questionOf = (ctx: CheckContext) => asText(ctx.question ?? ctx.input ?? '') || undefined;

/**
 * A check judged item by item: asks the judge, scores the share of ok items against the threshold and keeps the items
 * with their verdict names in the result. `items` may rework what the judge returned (ordering, defaults).
 */
async function judgedItemsCheck(
  cfg: CheckConfig,
  ctx: CheckContext,
  o: {
    key: string;
    task: string;
    sections: Array<[string, string | undefined]>;
    label: string;
    noun: keyof typeof LABELS;
    verdict: string;
    threshold: number;
    /** The score when the judge found nothing to judge. */
    empty: number;
    items?(items: EvidenceItem[]): EvidenceItem[];
    score?(items: EvidenceItem[]): number;
    extra?(score: number): Record<string, unknown>;
  },
): Promise<CheckResult> {
  try {
    const judged = await judgeItems(cfg, ctx, o.task, o.sections, o.key);
    const items = o.items ? o.items(judged.items) : judged.items;
    const score = o.score ? o.score(items) : okShare(items, o.empty);
    return res(cfg, score >= o.threshold, `${o.label} (judge) ${score}: ${itemsSummary(items, o.noun, o.verdict, LABELS[o.noun][1])}`, {
      source: 'ai-judge',
      score,
      metadata: { items, itemLabels: LABELS[o.noun], judge: judged.judge, threshold: o.threshold, ...o.extra?.(score) },
    });
  } catch (e) {
    return judgeFailed(cfg, e);
  }
}

registerCheck('llm-judge', async (cfg, ctx) => {
  const criteria = String(cfg.criteria ?? cfg.rubric ?? 'The response is correct, relevant, complete and follows the instructions.');
  const t = threshold(cfg, 0.7);
  try {
    const j = await runJudge(cfg, ctx, criteria, { reference: cfg.expected !== undefined ? asText(cfg.expected) : ctx.expected !== undefined ? asText(ctx.expected) : undefined });
    return res(cfg, j.score >= t, `judge score ${j.score} (threshold ${t})`, { source: 'ai-judge', score: j.score, explanation: j.reasoning, metadata: { judge: j.judge, threshold: t, criteria } });
  } catch (e) {
    return judgeFailed(cfg, e);
  }
});

/* ------------------------------------------------------------------ RAG */

function ragContexts(ctx: CheckContext): RetrievedDoc[] {
  return ctx.contexts ?? [];
}

registerCheck('context-precision', async (cfg, ctx) => {
  const docs = ragContexts(ctx);
  const t = threshold(cfg, 0.5);
  const reference = cfg.expected ?? ctx.expected;
  if (cfg.judge)
    return judgedItemsCheck(cfg, ctx, {
      key: 'context-precision',
      task: 'For each RETRIEVED DOCUMENT, in the order given, decide whether it is useful for answering the QUESTION (to reach the REFERENCE ANSWER when one is given). One item per document; "text" is the document id.',
      sections: [
        ['QUESTION', asText(ctx.question ?? ctx.input ?? '')],
        ['REFERENCE ANSWER', reference !== undefined ? asText(reference) : undefined],
        ['RETRIEVED DOCUMENTS', docs.map((d) => `[${d.id}] ${d.text}`).join('\n')],
      ],
      label: 'context precision',
      noun: 'documents',
      verdict: 'useful',
      threshold: t,
      empty: 0,
      // the judge's verdicts in the documents' order (rank matters), a document it skipped counts as not judged
      items: (items) => {
        const byId = new Map(items.map((i) => [i.text.replace(/^\[|\]$/g, ''), i]));
        return docs.map((d, i) => byId.get(d.id) ?? items[i] ?? { text: d.id, ok: false, evidence: 'not judged' });
      },
      score: (items) => averagePrecision(items.map((i) => i.ok)),
    });
  const ref = `${ctx.question ?? ''} ${asText(reference ?? '')}`;
  const refWords = wordSet(ref);
  const relevance = docs.map((d) => coverageIn(d.text, refWords) >= Number(cfg.docThreshold ?? 0.1) || coverage(ref, d.text) >= 0.3);
  const score = averagePrecision(relevance);
  const hits = relevance.filter(Boolean).length;
  return res(cfg, score >= t, `context precision ${score} (${hits}/${docs.length} relevant)`, {
    source: 'heuristic',
    score,
    metadata: { relevant: docs.filter((_, i) => relevance[i]).map((d) => d.id), items: docs.map((d, i) => ({ text: d.id, ok: relevance[i]!, evidence: short(d.text, 120) })), itemLabels: LABELS.documents },
  });
});

registerCheck('context-recall', async (cfg, ctx) => {
  const exp = asText(cfg.expected ?? ctx.expected ?? '');
  const all = ragContexts(ctx).map((d) => d.text).join('\n');
  const t = threshold(cfg, 0.6);
  if (cfg.judge)
    return judgedItemsCheck(cfg, ctx, {
      key: 'context-recall',
      task: 'Split the REFERENCE ANSWER into its statements. For each, decide whether the RETRIEVED CONTEXT contains the information it needs (ok: true) or not.',
      sections: [
        ['QUESTION', questionOf(ctx)],
        ['REFERENCE ANSWER', exp],
        ['RETRIEVED CONTEXT', ragContexts(ctx).map((d) => `[${d.id}] ${d.text}`).join('\n')],
      ],
      label: 'context recall',
      noun: 'statements',
      verdict: 'found in the context',
      threshold: t,
      empty: 0,
    });
  const sents = sentences(exp);
  const allWords = wordSet(all);
  const found = sents.map((s) => coverageIn(s, allWords) >= 0.6);
  const score = sents.length ? round3(found.filter(Boolean).length / sents.length) : round3(coverageIn(exp, allWords));
  return res(cfg, score >= t, `context recall ${score}`, { source: 'heuristic', score, metadata: { items: sents.map((s, i) => ({ text: s, ok: found[i]! })), itemLabels: LABELS.statements } });
});

/** The names, numbers and dates of a text (what a retrieval must not lose). */
function entities(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\b(?:[A-Z][\w'-]*(?:\s+(?:of|de|the|and|&)?\s*[A-Z][\w'-]*)*)\b/g)) {
    const e = m[0].trim();
    // a capitalized word that starts a sentence is not a name
    const at = m.index ?? 0;
    const startsSentence = at === 0 || /[.!?]\s*$/.test(text.slice(Math.max(0, at - 3), at));
    if (!startsSentence || e.includes(' ')) found.add(e);
  }
  // numbers with their unit (8am, 25%, 3.5kg, 2024-07-18)
  for (const m of text.matchAll(/\b\d(?:[\d,./:-]*\d)?[a-z%]*/gi)) found.add(m[0]);
  return [...found];
}

// the reference's entities that the retrieved context holds (Ragas' context entity recall), with no model
registerCheck('context-entity-recall', (cfg, ctx) => {
  const exp = asText(cfg.expected ?? ctx.expected ?? '');
  const all = ragContexts(ctx)
    .map((d) => d.text)
    .join('\n')
    .toLowerCase();
  const list = Array.isArray(cfg.entities) ? (cfg.entities as unknown[]).map(String) : entities(exp);
  const items = list.map((e) => ({ text: e, ok: all.includes(e.toLowerCase()) }));
  const score = okShare(items, 1);
  const t = threshold(cfg, 0.8);
  return res(cfg, score >= t, `context entity recall ${score}: ${itemsSummary(items, 'entities', 'retrieved', 'missing')}`, { source: 'deterministic', score, metadata: { items, itemLabels: LABELS.entities } });
});

registerCheck('groundedness', async (cfg, ctx) => {
  const all = ragContexts(ctx).map((d) => `[${d.id}] ${d.text}`).join('\n');
  const t = threshold(cfg, 0.7);
  if (cfg.judge)
    return judgedItemsCheck(cfg, ctx, {
      key: 'groundedness',
      task: 'Break the RESPONSE into its atomic factual claims. For each claim, decide whether the RETRIEVED CONTEXT supports it (ok: true) or not (unsupported or contradicted); the evidence is the supporting quote or document id.',
      sections: [
        ['QUESTION', questionOf(ctx)],
        ['RETRIEVED CONTEXT', all],
        ['RESPONSE', ctx.text || asText(ctx.body)],
      ],
      label: 'groundedness',
      noun: 'claims',
      verdict: 'supported by the context',
      threshold: t,
      // an answer without a claim (a refusal, "I don't know") makes up nothing
      empty: 1,
      extra: (score) => ({ hallucinationIndicator: round3(1 - score) }),
    });
  const sents = sentences(ctx.text);
  const allWords = wordSet(all);
  const supported = sents.map((s) => coverageIn(s, allWords) >= Number(cfg.sentenceThreshold ?? 0.5));
  const unsupported = sents.filter((_, i) => !supported[i]);
  const score = sents.length ? round3((sents.length - unsupported.length) / sents.length) : 1;
  return res(cfg, score >= t, `groundedness ${score} — ${unsupported.length} unsupported sentence(s)`, {
    source: 'heuristic',
    score,
    metadata: { unsupported: unsupported.slice(0, 10), hallucinationIndicator: round3(1 - score), items: sents.map((s, i) => ({ text: s, ok: supported[i]! })), itemLabels: LABELS.claims },
  });
});
registry.set('hallucination', registry.get('groundedness')!);
registry.set('faithfulness', registry.get('groundedness')!);

registerCheck('answer-relevance', async (cfg, ctx) => {
  const t = threshold(cfg, cfg.judge ? 0.7 : 0.2);
  if (cfg.judge) {
    try {
      const j = await runJudge(cfg, ctx, 'The RESPONSE directly and completely answers the INPUT question.');
      return res(cfg, j.score >= t, `answer relevance (judge) ${j.score}`, { source: 'ai-judge', score: j.score, explanation: j.reasoning, metadata: { judge: j.judge } });
    } catch (e) {
      return judgeFailed(cfg, e);
    }
  }
  const q = asText(ctx.question ?? ctx.input ?? '');
  const exp = asText(cfg.expected ?? ctx.expected ?? '');
  const qCovered = coverage(q, ctx.text);
  const score = round3(Math.max(qCovered * 0.5 + (exp ? tokenF1(ctx.text, exp) * 0.5 : qCovered * 0.5), 0));
  return res(cfg, score >= t, `answer relevance ${score}`, { source: 'heuristic', score });
});

/**
 * The answer's facts against the reference's (Ragas' factual correctness): precision is the share of the answer's
 * claims the reference supports, recall the share of the reference's claims the answer makes; `mode` picks f1
 * (default), precision or recall.
 */
registerCheck('answer-correctness', async (cfg, ctx) => {
  const reference = asText(cfg.expected ?? ctx.expected ?? '');
  const answer = cfg.path ? asText(query(ctx.body, String(cfg.path))) : ctx.text;
  const mode = String(cfg.mode ?? 'f1');
  const t = threshold(cfg, 0.7);
  if (!reference) return res(cfg, false, 'answer-correctness needs a reference answer (expected)', { source: cfg.judge ? 'ai-judge' : 'heuristic' });
  let answerItems: EvidenceItem[];
  let referenceItems: EvidenceItem[];
  let judge: Record<string, unknown> | undefined;
  if (cfg.judge) {
    try {
      const a = await judgeItems(
        cfg,
        ctx,
        'Break the RESPONSE into its atomic factual claims. For each, decide whether the REFERENCE ANSWER supports it (ok: true) or not.',
        [
          ['QUESTION', questionOf(ctx)],
          ['REFERENCE ANSWER', reference],
          ['RESPONSE', answer],
        ],
        'answer-correctness:precision',
      );
      const b =
        mode === 'precision'
          ? { items: [] }
          : await judgeItems(
              cfg,
              ctx,
              'Break the REFERENCE ANSWER into its atomic factual claims. For each, decide whether the RESPONSE states it too (ok: true) or misses or contradicts it.',
              [
                ['QUESTION', questionOf(ctx)],
                ['REFERENCE ANSWER', reference],
                ['RESPONSE', answer],
              ],
              'answer-correctness:recall',
            );
      answerItems = a.items;
      referenceItems = b.items;
      judge = a.judge;
    } catch (e) {
      return judgeFailed(cfg, e);
    }
  } else {
    const referenceWords = wordSet(reference);
    const answerWords = wordSet(answer);
    answerItems = sentences(answer).map((s) => ({ text: s, ok: coverageIn(s, referenceWords) >= 0.5 }));
    referenceItems = sentences(reference).map((s) => ({ text: s, ok: coverageIn(s, answerWords) >= 0.5 }));
  }
  const precision = rawShare(answerItems);
  const recall = rawShare(referenceItems);
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const score = round3(mode === 'precision' ? precision : mode === 'recall' ? recall : f1);
  const missing = referenceItems.filter((i) => !i.ok);
  const wrong = answerItems.filter((i) => !i.ok);
  const detail = [wrong.length ? `${wrong.length} claim(s) not in the reference` : '', mode !== 'precision' && missing.length ? `${missing.length} reference fact(s) missing` : ''].filter(Boolean).join(', ');
  return res(cfg, score >= t, `answer correctness ${mode} ${score}${detail ? ` — ${detail}` : ''}`, {
    source: cfg.judge ? 'ai-judge' : 'heuristic',
    score,
    metadata: {
      mode,
      precision: round3(precision),
      ...(mode !== 'precision' ? { recall: round3(recall) } : {}),
      items: [...answerItems.map((i) => ({ ...i, text: `answer: ${i.text}` })), ...referenceItems.map((i) => ({ ...i, text: `reference: ${i.text}` }))],
      itemLabels: LABELS.answer,
      ...(judge ? { judge } : {}),
      threshold: t,
    },
  });
});

registerCheck('citation', (cfg, ctx) => {
  const idList = ragContexts(ctx).map((d) => d.id);
  const ids = new Set(idList);
  const cited = [...ctx.text.matchAll(/\[([^\]\s]{1,64})\]/g)].map((m) => m[1]!);
  if (!cited.length) return res(cfg, cfg.required === false, cfg.required === false ? 'no citations (optional)' : 'no citations found', { source: 'deterministic', score: 0 });
  // [1] cites the first document
  const valid = cited.filter((c) => ids.has(c) || ids.has(`doc-${c}`) || idList[Number(c) - 1] !== undefined);
  const score = Math.round((valid.length / cited.length) * 1000) / 1000;
  return res(cfg, score >= threshold(cfg, 1), `${valid.length}/${cited.length} citations refer to retrieved documents`, {
    source: 'deterministic',
    score,
    actual: cited,
    expected: [...ids],
  });
});

/* ------------------------------------------------------------------ runner */

/** Run all checks for an execution. Checks never throw; failures become failed results. */
export async function runChecks(checks: CheckConfig[] | undefined, ctx: CheckContext): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const cfg of checks ?? []) {
    const fn = registry.get(cfg.type);
    if (!fn) {
      out.push({ type: cfg.type, name: cfg.name ?? cfg.type, passed: false, source: 'deterministic', message: `unknown check type "${cfg.type}". Known: ${checkTypes().join(', ')}` });
      continue;
    }
    try {
      out.push(await fn(cfg, ctx));
    } catch (e) {
      out.push({ type: cfg.type, name: cfg.name ?? cfg.type, passed: false, source: 'deterministic', message: `check error: ${normalizeError(e).message}` });
    }
  }
  return out;
}

