import { compareSnapshot, describeDifference } from './snapshot.js';
import { decodeJwt, describeExpiry, findJwts, type DecodedJwt } from '../util/jwt.js';
import type { CheckConfig, CheckResult } from '../model/types.js';
import { deepEqual, exists, inferSchema, query, tryParseJson } from '../util/jsonpath.js';
import { cosine, lexicalCosine, tokenF1 } from './text.js';
import { normalizeError } from '../errors.js';
import { aliasCheck, documentCheck, registerCheck, resolveCheck, checkTypes, res, target, asText, short, threshold, validateSchema, type CheckContext, type CheckFn } from './check-registry.js';
import { runJudge, judgeFailed } from './check-judge.js';
import './legacy-rag-checks.js';

// the registry is in check-registry.ts; this file is its public face
export { registerCheck, overrideCheck, unregisterCheck, checkFn, setCheckResolver, documentCheck, checkAliases, checkDocs, checkTypes, validateSchema } from './check-registry.js';
export type { CheckContext, CheckDoc, CheckResolver } from './check-registry.js';
export type { EvidenceItem } from './legacy-rag-checks.js';

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
aliasCheck('http-status', 'status');

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
aliasCheck('response-time', 'latency');
// how long until the model started answering (a streamed answer; without streaming it is the whole latency)
registerCheck('first-token', (cfg, ctx) => numericCheck({ ...cfg, max: cfg.max ?? cfg.expected }, ctx.firstTokenMs ?? ctx.latencyMs, 'time to first token (ms)'));
aliasCheck('ttft', 'first-token');
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

// the checks of a response (status, headers, body): what each reads, for models writing checks and for lint hints
for (const [type, fields, example] of [
  ['status', 'expected: 201, a list [200, 204] or a class "2xx"', { type: 'status', expected: 201 }],
  ['exists', 'path (a JSONPath into the body)', { type: 'exists', path: '$.id' }],
  ['not-exists', 'path', { type: 'not-exists', path: '$.password' }],
  ['equals', 'path, expected', { type: 'equals', path: '$.name', expected: 'Rex' }],
  ['json-path', 'path, expected', { type: 'json-path', path: '$.status', expected: 'active' }],
  ['contains', 'expected: text in the body, or an item of the list at path', { type: 'contains', path: '$.tags', expected: 'new' }],
  ['regex', 'pattern; path optional', { type: 'regex', path: '$.createdAt', pattern: '^\\d{4}-\\d{2}-\\d{2}' }],
  ['type', 'path, expected: string | number | integer | boolean | array | object | null', { type: 'type', path: '$.id', expected: 'number' }],
  ['length', 'path, expected or min / max', { type: 'length', path: '$.items', min: 1 }],
  ['greater-than', 'path, expected (a number)', { type: 'greater-than', path: '$.total', expected: 0 }],
  ['less-than', 'path, expected (a number)', { type: 'less-than', path: '$.price', expected: 1000 }],
  ['latency', 'max: milliseconds', { type: 'latency', max: 2000 }],
  ['header', 'header, expected (optional: text it contains)', { type: 'header', header: 'content-type', expected: 'json' }],
  ['is-json', 'nothing: the body is JSON', { type: 'is-json' }],
  ['json-schema', 'schema: a JSON Schema (or a file path)', { type: 'json-schema', schema: { type: 'object', required: ['id'] } }],
] as Array<[string, string, CheckConfig]>)
  documentCheck(type, { fields, example });

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
aliasCheck('semantic-similarity', 'similarity');

/* ------------------------------------------------------------------ LLM as judge */

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

// the older name of the claim-by-claim groundedness check (registered in legacy-rag-checks.ts)
aliasCheck('faithfulness', 'groundedness');

/* ------------------------------------------------------------------ runner */

/** Run all checks for an execution. Checks never throw; failures become failed results. */
export async function runChecks(checks: CheckConfig[] | undefined, ctx: CheckContext): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const cfg0 of checks ?? []) {
    const found = resolveCheck(cfg0);
    if (!found) {
      out.push({ type: cfg0.type, name: cfg0.name ?? cfg0.type, passed: false, source: 'deterministic', message: `unknown check type "${cfg0.type}". Known: ${checkTypes().join(', ')}` });
      continue;
    }
    const cfg = found.cfg;
    try {
      out.push(await found.fn(cfg, ctx));
    } catch (e) {
      out.push({ type: cfg.type, name: cfg.name ?? cfg.type, passed: false, source: 'deterministic', message: `check error: ${normalizeError(e).message}` });
    }
  }
  return out;
}

