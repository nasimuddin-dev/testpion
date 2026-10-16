/**
 * Compare two HTTP responses of the same request (response history → Compare). Structured, so the UI,
 * the CLI (`testpion history diff --json`) and AI agents (MCP `compare_responses`) get the same result.
 */
export interface ComparableResponse {
  status?: number | string;
  durationMs?: number;
  size?: number;
  headers?: Array<[string, string]>;
  /** Body text (may be a preview of a large body). */
  body?: string;
}

export interface BodyChange {
  /** JSONPath-style location, e.g. `$.items[0].name`. */
  path: string;
  kind: 'added' | 'removed' | 'changed' | 'type';
  before?: unknown;
  after?: unknown;
}

export interface HeaderChange {
  name: string;
  kind: 'added' | 'removed' | 'changed';
  before?: string;
  after?: string;
  /** Changes on every response (date, request ids …); shown but not counted as a real difference. */
  volatile: boolean;
}

export interface ResponseDiff {
  status: { before?: number | string; after?: number | string; changed: boolean };
  durationMs: { before?: number; after?: number; deltaMs?: number };
  size: { before?: number; after?: number };
  headers: HeaderChange[];
  body: {
    format: 'json' | 'text' | 'none';
    identical: boolean;
    /** JSON bodies: every changed location (capped at `maxChanges`). */
    changes: BodyChange[];
    /** Text bodies: a unified-style line diff (capped). */
    lines?: Array<{ op: ' ' | '+' | '-'; text: string }>;
    truncated: boolean;
  };
  /** Status, non-volatile headers or body differ. */
  different: boolean;
  summary: string;
}

const VOLATILE = /^(date|age|expires|last-modified|etag|x-request-id|x-correlation-id|request-id|traceparent|x-amzn-requestid|x-amzn-trace-id|cf-ray|x-served-by|x-cache|x-timer|server-timing|set-cookie|x-runtime|x-response-time)$/i;

function parseJson(s: string | undefined): { ok: true; value: unknown } | { ok: false } {
  if (s === undefined || !/^\s*[[{"\d-tfn]/.test(s)) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`);
const kindOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function diffJson(a: unknown, b: unknown, path: string, out: BodyChange[], max: number): void {
  if (out.length >= max) return;
  if (Object.is(a, b)) return;
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka !== kb) {
    out.push({ path, kind: 'type', before: a, after: b });
    return;
  }
  if (ka === 'array') {
    const x = a as unknown[];
    const y = b as unknown[];
    const n = Math.max(x.length, y.length);
    for (let i = 0; i < n && out.length < max; i++) {
      if (i >= x.length) out.push({ path: `${path}[${i}]`, kind: 'added', after: y[i] });
      else if (i >= y.length) out.push({ path: `${path}[${i}]`, kind: 'removed', before: x[i] });
      else diffJson(x[i], y[i], `${path}[${i}]`, out, max);
    }
    return;
  }
  if (ka === 'object') {
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (out.length >= max) return;
      if (!(k in y)) out.push({ path: path + key(k), kind: 'removed', before: x[k] });
      else if (!(k in x)) out.push({ path: path + key(k), kind: 'added', after: y[k] });
      else diffJson(x[k], y[k], path + key(k), out, max);
    }
    return;
  }
  out.push({ path, kind: 'changed', before: a, after: b });
}

/** Line diff (LCS) for text bodies; falls back to a head/tail comparison for very large inputs. */
function diffLines(a: string, b: string, maxLines: number): { lines: Array<{ op: ' ' | '+' | '-'; text: string }>; truncated: boolean } {
  const x = a.split(/\r?\n/);
  const y = b.split(/\r?\n/);
  if (x.length * y.length > 4_000_000) {
    // too large for a full LCS: report the lines that differ position by position
    const lines: Array<{ op: ' ' | '+' | '-'; text: string }> = [];
    for (let i = 0; i < Math.max(x.length, y.length) && lines.length < maxLines; i++)
      if (x[i] !== y[i]) {
        if (x[i] !== undefined) lines.push({ op: '-', text: x[i]! });
        if (y[i] !== undefined) lines.push({ op: '+', text: y[i]! });
      }
    return { lines, truncated: true };
  }
  const m = x.length;
  const n = y.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const lines: Array<{ op: ' ' | '+' | '-'; text: string }> = [];
  let i = 0;
  let j = 0;
  while ((i < m || j < n) && lines.length < maxLines) {
    if (i < m && j < n && x[i] === y[j]) lines.push({ op: ' ', text: x[i++]! }), j++;
    // removals before additions, like a unified diff
    else if (i < m && (j >= n || dp[i + 1]![j]! >= dp[i]![j + 1]!)) lines.push({ op: '-', text: x[i++]! });
    else lines.push({ op: '+', text: y[j++]! });
  }
  return { lines, truncated: i < m || j < n };
}

export function diffResponses(before: ComparableResponse, after: ComparableResponse, opts: { maxChanges?: number; maxLines?: number } = {}): ResponseDiff {
  const maxChanges = opts.maxChanges ?? 500;
  const headersOf = (r: ComparableResponse) => {
    const m = new Map<string, string>();
    for (const [k, v] of r.headers ?? []) m.set(k.toLowerCase(), m.has(k.toLowerCase()) ? `${m.get(k.toLowerCase())}, ${v}` : v);
    return m;
  };
  const ha = headersOf(before);
  const hb = headersOf(after);
  const headers: HeaderChange[] = [];
  for (const name of [...new Set([...ha.keys(), ...hb.keys()])].sort()) {
    const a = ha.get(name);
    const b = hb.get(name);
    if (a === b) continue;
    headers.push({ name, kind: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed', before: a, after: b, volatile: VOLATILE.test(name) });
  }

  const ja = parseJson(before.body);
  const jb = parseJson(after.body);
  let body: ResponseDiff['body'];
  if (before.body === undefined && after.body === undefined) body = { format: 'none', identical: true, changes: [], truncated: false };
  else if (ja.ok && jb.ok) {
    const changes: BodyChange[] = [];
    diffJson(ja.value, jb.value, '$', changes, maxChanges + 1);
    body = { format: 'json', identical: changes.length === 0, changes: changes.slice(0, maxChanges), truncated: changes.length > maxChanges };
  } else {
    const a = before.body ?? '';
    const b = after.body ?? '';
    const d = a === b ? { lines: [], truncated: false } : diffLines(a, b, opts.maxLines ?? 400);
    body = { format: 'text', identical: a === b, changes: [], lines: d.lines, truncated: d.truncated };
  }

  const statusChanged = String(before.status) !== String(after.status);
  const realHeaders = headers.filter((h) => !h.volatile).length;
  const different = statusChanged || realHeaders > 0 || !body.identical;
  const parts: string[] = [];
  if (statusChanged) parts.push(`status ${before.status} → ${after.status}`);
  if (body.format === 'json' && !body.identical) parts.push(`${body.changes.length}${body.truncated ? '+' : ''} body change${body.changes.length === 1 ? '' : 's'}`);
  if (body.format === 'text' && !body.identical) parts.push(`body text differs (${body.lines?.filter((l) => l.op !== ' ').length ?? 0} lines)`);
  if (realHeaders) parts.push(`${realHeaders} header change${realHeaders === 1 ? '' : 's'}`);
  const deltaMs = before.durationMs !== undefined && after.durationMs !== undefined ? after.durationMs - before.durationMs : undefined;
  return {
    status: { before: before.status, after: after.status, changed: statusChanged },
    durationMs: { before: before.durationMs, after: after.durationMs, deltaMs },
    size: { before: before.size, after: after.size },
    headers,
    body,
    different,
    summary: different ? parts.join(', ') : 'Identical (apart from volatile headers such as date)',
  };
}

/**
 * Mask secrets in a diff for AI agents and CLI output: a change whose last path segment is a
 * sensitive name (token, password …) has its values masked, and nested values are redacted too.
 */
export function redactDiff<T extends { diff: ResponseDiff }>(result: T, redactor: { redact<V>(v: V): V; isSensitiveKey(k: string): boolean; redactString(s: string): string }): T {
  /** The last property name of a path: `$.a.token` → token, `$["x-key"]` → x-key, `$.a[2]` → (none). */
  const lastName = (path: string): string => {
    if (path.endsWith('"]')) {
      const i = path.lastIndexOf('["');
      try {
        return i >= 0 ? (JSON.parse(path.slice(i + 1, -1)) as string) : '';
      } catch {
        return '';
      }
    }
    if (path.endsWith(']')) return '';
    return path.slice(path.lastIndexOf('.') + 1);
  };
  const mask = (v: unknown) => (v === undefined ? v : '[REDACTED]');
  const changes = result.diff.body.changes.map((c) => {
    const name = lastName(c.path);
    return name && redactor.isSensitiveKey(name) ? { ...c, before: mask(c.before), after: mask(c.after) } : { ...c, before: redactor.redact(c.before), after: redactor.redact(c.after) };
  });
  const headers = result.diff.headers.map((h) => (redactor.isSensitiveKey(h.name) ? { ...h, before: mask(h.before) as string | undefined, after: mask(h.after) as string | undefined } : h));
  const lines = result.diff.body.lines?.map((l) => ({ ...l, text: redactor.redactString(l.text) }));
  return { ...result, diff: { ...result.diff, headers, body: { ...result.diff.body, changes, ...(lines ? { lines } : {}) } } };
}
