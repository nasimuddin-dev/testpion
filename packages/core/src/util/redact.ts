import { escapeRegex } from '@testpion/shared';
import { DEFAULT_REDACT_FIELDS } from '../model/types.js';
import { ibanValid, luhn } from './checksums.js';
import { isSecretReference, matchSecretKey, replaceSecretValues, secretKeyFields, type SecretKeyFields } from '../security/secrets.js';

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
  private fields: SecretKeyFields;
  private values = new Set<string>();
  /** The one regex of every secret value, built when a string is first masked after a secret was added (not once per secret). */
  private valueRegex?: RegExp;
  private valuesChanged = false;
  /** Moves on whenever what is masked changes (a secret added, the field names set): a cached redaction made before is out of date. */
  generation = 0;

  constructor(fields: string[] = DEFAULT_REDACT_FIELDS) {
    this.fields = secretKeyFields(fields);
  }

  setFields(fields: string[]): void {
    this.fields = secretKeyFields(fields);
    this.generation++;
  }

  /** Register a secret value; values shorter than 4 characters are ignored to avoid over-masking. */
  addSecret(value: string | undefined | null): void {
    if (!value || typeof value !== 'string' || value.length < 4 || this.values.has(value)) return;
    this.values.add(value);
    this.valuesChanged = true;
    this.generation++;
  }

  private regex(): RegExp | undefined {
    if (this.valuesChanged) {
      this.valuesChanged = false;
      const sorted = [...this.values].sort((a, b) => b.length - a.length).map(escapeRegex);
      this.valueRegex = new RegExp(sorted.join('|'), 'g');
    }
    return this.valueRegex;
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

  /** The shared key-name rule (security/secrets.ts) with this redactor's fields. */
  private matchKey(key: string): 'exact' | 'suffix' | 'none' {
    return matchSecretKey(key, this.fields);
  }

  redactString(s: string): string {
    const re = this.regex();
    if (!re || !s) return s;
    return s.replace(re, REDACTED);
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

  /**
   * An absolute URL with no credentials and no sensitive query key, told by reading the text (a `new URL` per call costs
   * about 6 microseconds, and the Debugger redacts the URL of thousands of rows). Anything unusual (an escaped or `+` key,
   * no scheme) is left to the parser, so the answer is always the parser's.
   */
  private cleanUrl(url: string): boolean {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url);
    if (!m || m[1]!.includes('@')) return false;
    const q = url.indexOf('?', m[0].length);
    if (q < 0) return true;
    const hash = url.indexOf('#', q);
    const query = url.slice(q + 1, hash < 0 ? url.length : hash);
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      if (/[%+]/.test(key) || this.isSensitiveKey(key)) return false;
    }
    return true;
  }

  /** Redact query-string values of sensitive parameters in a URL. */
  redactUrl(url: string): string {
    if (this.cleanUrl(url)) return this.redactString(url);
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

export { escapeRegex } from '@testpion/shared';

/* ------------------------------------------------------------ pattern detectors (AI context) */

/** What was masked and where (`response.body.user.email`), for "What will be sent". */
export interface Redaction {
  path: string;
  kind: string;
}

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
    re: /(?<![\w.:/-]|\d[ .-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{3,4}[ .-]\d{3,4}(?![\w:/-]|\.\w|[ .-]\d)/g,
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
  // credentials by their shape (private keys, JWTs, Authorization schemes, provider keys, connection-string passwords,
  // credential query parameters): the one detector, security/secrets.ts; only the secret part goes, so the text still reads
  let out = replaceSecretValues(s, (p) => `[REDACTED:${p.kind}]`, 'low', hit);
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
  const literal = (v: unknown): v is string => typeof v === 'string' && v.trim().length >= 6 && !isSecretReference(v);
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

/**
 * The first `max` characters of a long text, redacted, without redacting (or copying) the rest: the text is cut a little past
 * `max` (a secret that starts before the cut ends inside the margin, so it is still recognised whole), redacted, then cut to `max`.
 * `rest` is how many characters of the original are not in `head`.
 */
export function redactedHead(redactor: { redactString(s: string): string }, text: string, max: number, margin = 4096): { head: string; rest: number } {
  if (text.length <= max) return { head: redactor.redactString(text), rest: 0 };
  const head = redactor.redactString(text.slice(0, max + margin)).slice(0, max);
  return { head, rest: text.length - max };
}
