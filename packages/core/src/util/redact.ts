import { DEFAULT_REDACT_FIELDS } from '../model/types.js';

export const REDACTED = '[REDACTED]';

/**
 * Redacts secrets from arbitrary data before it is logged, traced, reported or exported.
 *
 * Two mechanisms are combined:
 *  1. Field names (case-insensitive) configured by the user, e.g. `password`, `authorization`.
 *  2. Known secret *values* registered at resolution time — any occurrence inside any string is masked,
 *     which catches secrets embedded in URLs, bodies or error messages.
 */
export class Redactor {
  private fields: Set<string>;
  private normFields: Set<string>;
  private values = new Set<string>();
  private valueRegex?: RegExp;

  constructor(fields: string[] = DEFAULT_REDACT_FIELDS) {
    this.fields = new Set(fields.map((f) => f.toLowerCase()));
    this.normFields = new Set(fields.map(norm));
  }

  setFields(fields: string[]): void {
    this.fields = new Set(fields.map((f) => f.toLowerCase()));
    this.normFields = new Set(fields.map(norm));
  }

  /** Register a secret value; values shorter than 4 characters are ignored to avoid over-masking. */
  addSecret(value: string | undefined | null): void {
    if (!value || typeof value !== 'string' || value.length < 4 || this.values.has(value)) return;
    this.values.add(value);
    const sorted = [...this.values].sort((a, b) => b.length - a.length).map(escapeRegex);
    this.valueRegex = new RegExp(sorted.join('|'), 'g');
  }

  /**
   * Exact match (case/separator-insensitive), or the key *ends with* a configured field:
   * `accessToken`, `x-api-key`, `client_secret` match; `totalTokens`, `maxTokens` do not.
   */
  /** Headers with the values of the sensitive ones (authorization, cookie, api keys …) masked as `***`. */
  redactHeaders(headers: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, this.isSensitiveKey(k) ? '***' : v]));
  }

  isSensitiveKey(key: string): boolean {
    return this.matchKey(key) !== 'none';
  }

  private matchKey(key: string): 'exact' | 'suffix' | 'none' {
    const k = norm(key);
    if (this.fields.has(key.toLowerCase()) || this.normFields.has(k)) return 'exact';
    for (const f of this.normFields) if (f.length >= 5 && k.endsWith(f)) return 'suffix';
    return 'none';
  }

  redactString(s: string): string {
    if (!this.valueRegex || !s) return s;
    return s.replace(this.valueRegex, REDACTED);
  }

  /** Deep-copy `data`, masking sensitive keys and known secret values. */
  redact<T>(data: T, depth = 0): T {
    if (data == null || depth > 64) return data;
    if (typeof data === 'string') return this.redactString(data) as T;
    if (typeof data !== 'object') return data;
    if (Array.isArray(data)) {
      // [key, value] header tuples
      if (data.length === 2 && typeof data[0] === 'string' && typeof data[1] === 'string' && this.isSensitiveKey(data[0]))
        return [data[0], REDACTED] as T;
      return data.map((v) => this.redact(v, depth + 1)) as T;
    }
    if (data instanceof Uint8Array || data instanceof ArrayBuffer) return data;
    const out: Record<string, unknown> = {};
    const obj = data as Record<string, unknown>;
    // { key, value } pairs (headers, params, variables)
    const kv = typeof obj.key === 'string' && 'value' in obj;
    for (const [k, v] of Object.entries(obj)) {
      if (kv && k === 'value' && (this.isSensitiveKey(obj.key as string) || obj.secret === true)) out[k] = v ? REDACTED : v;
      else if (typeof v === 'string' && this.isSensitiveKey(k)) out[k] = REDACTED;
      // numbers are only masked on exact field matches (e.g. `ssn`), never on suffix matches like `totalTokens`
      else if (typeof v === 'number' && this.matchKey(k) === 'exact') out[k] = REDACTED;
      else out[k] = this.redact(v, depth + 1);
    }
    return out as T;
  }

  /** Redact query-string values of sensitive parameters in a URL. */
  redactUrl(url: string): string {
    try {
      const u = new URL(url);
      let changed = false;
      for (const k of [...u.searchParams.keys()]) {
        if (this.isSensitiveKey(k)) {
          u.searchParams.set(k, 'REDACTED');
          changed = true;
        }
      }
      if (u.password) {
        u.password = 'REDACTED';
        changed = true;
      }
      return this.redactString(changed ? u.toString() : url);
    } catch {
      return this.redactString(url);
    }
  }
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[-_\s.]/g, '');
}

/** A string as a literal for a RegExp source: every special character escaped. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------ pattern detectors (AI context) */

/** What was masked and where (`response.body.user.email`), for "What will be sent". */
export interface Redaction {
  path: string;
  kind: string;
}

/** Luhn checksum of a card number's digits. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** ISO 13616 check of an IBAN (mod 97 = 1). */
function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/**
 * Credentials found by their shape, wherever they are (a body field called `t`, a query string, a log line): private
 * keys, JWTs, Authorization schemes, the key formats of the big providers, and credential query parameters. Each
 * replaces only the secret part (`Bearer [REDACTED:bearer]`), so the text still reads.
 */
const SECRET_PATTERNS: Array<{ kind: string; re: RegExp; keep?: number }> = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g },
  // the scheme stays (group 1), the credential goes
  // (a credential has a digit or base64 padding: "Token validation" in prose is not one)
  { kind: 'bearer', re: /\b(Bearer|Basic|Token|Digest|ApiKey)(\s+)(?=[A-Za-z0-9._~+/=-]*[0-9=+/])[A-Za-z0-9._~+/=-]{12,}/gi, keep: 2 },
  { kind: 'api-key', re: /\bsk-(?:ant-|proj-|live-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'api-key', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: 'api-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'api-key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'api-key', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'api-key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'api-key', re: /\b(?:glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,})/g },
  // credential query parameters in any URL (the name stays)
  { kind: 'query-credential', re: /([?&](?:access_token|id_token|refresh_token|token|api_?key|apikey|key|sig|signature|password|passwd|secret|client_secret|code|auth)=)[^&#\s"'<>]{4,}/gi, keep: 1 },
];

const PII_PATTERNS: Array<{ kind: string; re: RegExp; valid?: (m: string) => boolean }> = [
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'iban', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, valid: ibanValid },
  {
    kind: 'card-number',
    re: /\b\d(?:[ -]?\d){12,18}\b/g,
    valid: (m) => {
      const d = m.replace(/\D/g, '');
      return d.length >= 13 && d.length <= 19 && luhn(d);
    },
  },
  {
    // a phone number with separators or a country code (9–15 digits); dates, times and plain ids do not match
    kind: 'phone',
    re: /(?<![\w.:/-]|\d[ .-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{3,4}[ .-]\d{3,4}(?![\w.:/-]|[ .-]\d)/g,
    valid: (m) => {
      const n = m.replace(/\D/g, '').length;
      return n >= 9 && n <= 15 && !/^\d{4}-\d{2}-\d{2}/.test(m);
    },
  },
];

/**
 * Mask credentials (always) and personal data (`pii`, default on) found by their shape in a text. `hit` is told each
 * kind found. Known secret values and sensitive field names are the Redactor's job; this is what neither catches.
 */
export function maskSensitiveText(s: string, opts: { pii?: boolean } = {}, hit?: (kind: string) => void): string {
  if (!s || s.length < 8) return s;
  let out = s;
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    if (!p.re.test(out)) continue;
    p.re.lastIndex = 0;
    out = out.replace(p.re, (...m: unknown[]) => {
      hit?.(p.kind);
      const kept = p.keep ? (m.slice(1, 1 + p.keep) as string[]).join('') : '';
      return `${kept}[REDACTED:${p.kind}]`;
    });
  }
  if (opts.pii !== false)
    for (const p of PII_PATTERNS) {
      p.re.lastIndex = 0;
      if (!p.re.test(out)) continue;
      p.re.lastIndex = 0;
      out = out.replace(p.re, (m: string) => {
        if (p.valid && !p.valid(m)) return m;
        hit?.(p.kind);
        return `[REDACTED:${p.kind}]`;
      });
    }
  return out;
}

const MAX_REDACTIONS = 200;

/**
 * Data made safe to send to an AI model: sensitive field names (`password`, `authorization`, the user's list) and known
 * secret values (secret variables, keys the engine resolved) by the Redactor, then credentials and personal data found
 * by their shape in every string (JSON inside a string included). Returns the copy and what was masked where.
 */
export function redactForAi<T>(data: T, redactor: Redactor, opts: { pii?: boolean } = {}): { value: T; redactions: Redaction[]; total: number } {
  const redactions: Redaction[] = [];
  let total = 0;
  const note = (path: string, kind: string) => {
    total++;
    if (redactions.length < MAX_REDACTIONS && !redactions.some((r) => r.path === path && r.kind === kind)) redactions.push({ path: path || '(root)', kind });
  };
  const text = (s: string, path: string): string => {
    const known = redactor.redactString(s);
    if (known !== s) note(path, 'secret-value');
    // JSON inside a string (a body, a message): its field names count too
    if (known.length > 1 && known.length < 1_000_000 && /^\s*[{[]/.test(known)) {
      try {
        const parsed = JSON.parse(known) as unknown;
        if (parsed && typeof parsed === 'object') return JSON.stringify(walk(parsed, path, 1));
      } catch {
        /* not JSON */
      }
    }
    return maskSensitiveText(known, opts, (kind) => note(path, kind));
  };
  const walk = (v: unknown, path: string, depth: number): unknown => {
    if (v == null || depth > 64) return v;
    if (typeof v === 'string') return text(v, path);
    if (typeof v !== 'object') return v;
    if (v instanceof Uint8Array || v instanceof ArrayBuffer) return '[binary]';
    if (Array.isArray(v)) {
      // [key, value] header tuples
      if (v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && redactor.isSensitiveKey(v[0])) {
        if (v[1]) note(`${path}.${v[0]}`, 'field');
        return [v[0], v[1] ? REDACTED : v[1]];
      }
      return v.map((x, i) => walk(x, `${path}[${i}]`, depth + 1));
    }
    const obj = v as Record<string, unknown>;
    const kv = typeof obj.key === 'string' && 'value' in obj;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (kv && k === 'value' && (redactor.isSensitiveKey(obj.key as string) || obj.secret === true)) {
        if (x) note(`${path}.${String(obj.key)}`, obj.secret === true ? 'secret-variable' : 'field');
        out[k] = x ? REDACTED : x;
      } else if (typeof x === 'string' && x && redactor.isSensitiveKey(k)) {
        note(p, 'field');
        out[k] = REDACTED;
      } else if (typeof x === 'number' && /^(ssn|creditcard|cardnumber|pin|cvv|cvc)$/i.test(k.replace(/[-_\s.]/g, ''))) {
        // numbers only on exact identity fields, never `totalTokens`
        note(p, 'field');
        out[k] = REDACTED;
      } else out[k] = walk(x, p, depth + 1);
    }
    return out;
  };
  return { value: walk(data, '', 0) as T, redactions, total };
}

/**
 * Literal secret values in data about to be saved in a workspace file: `{ key, value }` rows (headers,
 * metadata) with a sensitive key, and sensitive-looking properties (token, password, secret …), whose
 * value is typed in rather than a {{variable}}. Returns where they are, e.g. `headers.Authorization`.
 */
export function findLiteralSecrets(data: unknown, redactor: Redactor, path = ''): string[] {
  const out: string[] = [];
  const literal = (v: unknown): v is string => typeof v === 'string' && v.trim().length >= 6 && !/\{\{[^}]+\}\}/.test(v);
  const walk = (v: unknown, p: string, depth: number) => {
    if (depth > 6 || out.length > 20 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const [i, item] of v.entries()) {
        const row = item as { key?: unknown; value?: unknown; enabled?: unknown };
        if (row && typeof row === 'object' && typeof row.key === 'string' && 'value' in row) {
          // "Bearer " / "Basic " prefixes still count as a literal credential
          if (row.enabled !== false && redactor.isSensitiveKey(row.key) && literal(String(row.value).replace(/^(Bearer|Basic|Token)\s+/i, 'x'.repeat(6)))) out.push(`${p}.${row.key}`);
        } else walk(item, `${p}[${i}]`, depth + 1);
      }
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const q = p ? `${p}.${k}` : k;
      if (typeof x === 'string') {
        if (redactor.isSensitiveKey(k) && literal(x)) out.push(q);
        // JSON text (a message, an auth payload) may hold secrets too
        else if (/^\s*[{[]/.test(x) && x.length < 100_000) {
          try {
            walk(JSON.parse(x), q, depth + 1);
          } catch {
            /* not JSON */
          }
        }
      } else walk(x, q, depth + 1);
    }
  };
  walk(data, path, 0);
  return out;
}
