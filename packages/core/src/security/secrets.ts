/**
 * SEC-1 — the one secret detector. `git check` (storage/git-guard.ts), the masks for logs and AI context
 * (util/redact.ts) and the export stripping (storage/bundle-secrets.ts) all ask it, so a value one of them treats as a
 * secret is a secret for all of them.
 *
 * Two signals, each with a confidence:
 *  - the **key name** (`password`, `Authorization`, `x-api-key`, `client_secret` …, the user's redact fields), and
 *  - the **value shape** (a JWT, `Bearer …`, the key formats of the big providers, a private key block, a connection
 *    string with a password).
 *
 * Never a finding: a reference (`{{variable}}`, `{{$secret.x}}`, `$secret.x`, `$env.X`, `${X}`), an empty value, and a
 * key on the allow-list of names that are known not to hold secrets (`Content-Type`, `Accept`, `User-Agent` …).
 */
import { DEFAULT_REDACT_FIELDS } from '../model/types.js';

export type SecretConfidence = 'high' | 'medium' | 'low';

interface SecretValuePattern {
  /** Stable id of the pattern (fixtures and tests name it). */
  id: string;
  /** The kind a mask writes (`[REDACTED:<kind>]`): the names logs and AI context have always used. */
  kind: string;
  re: RegExp;
  confidence: SecretConfidence;
  /** Leading groups kept when masking (`Bearer ` stays, the credential goes). */
  keep?: number;
  /**
   * A part every match must contain (its prefix, scheme or parameter name), as a regex source, matched with the pattern's own case rule.
   * All hints together are one quick test that lets a text with none of them skip every pattern (see mayHoldSecretShape).
   */
  hint: string;
}

/**
 * Value shapes, in the order masks apply them (a private key before the JWT inside it, a scheme before its token).
 * Each `re` is global; callers reset `lastIndex`.
 */
export const SECRET_VALUE_PATTERNS: readonly SecretValuePattern[] = [
  { id: 'private-key', kind: 'private-key', confidence: 'high', hint: '-----BEGIN ', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { id: 'jwt', kind: 'jwt', confidence: 'medium', hint: 'eyJ', re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g },
  // the scheme stays (groups 1–2), the credential goes; a credential has a digit or base64 padding ("Token validation" in prose is not one)
  { id: 'auth-scheme', kind: 'bearer', confidence: 'medium', keep: 2, hint: '(?:Bearer|Basic|Token|Digest|ApiKey)\\s', re: /\b(Bearer|Basic|Token|Digest|ApiKey)(\s+)(?=[A-Za-z0-9._~+/=-]*[0-9=+/])[A-Za-z0-9._~+/=-]{12,}/gi },
  { id: 'openai', kind: 'api-key', confidence: 'high', hint: 'sk-', re: /\bsk-(?:ant-|proj-|live-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'github', kind: 'api-key', confidence: 'high', hint: 'gh[pousr]_|github_pat_', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { id: 'aws-access-key', kind: 'api-key', confidence: 'high', hint: 'AKIA|ASIA', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'google-api-key', kind: 'api-key', confidence: 'high', hint: 'AIza', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { id: 'slack', kind: 'api-key', confidence: 'high', hint: 'xox[abprs]-', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'stripe', kind: 'api-key', confidence: 'high', hint: '[srp]k_(?:live|test)_', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { id: 'gitlab', kind: 'api-key', confidence: 'high', hint: 'glpat-', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { id: 'npm', kind: 'api-key', confidence: 'high', hint: 'npm_', re: /\bnpm_[A-Za-z0-9]{36}/g },
  { id: 'huggingface', kind: 'api-key', confidence: 'high', hint: 'hf_', re: /\bhf_[A-Za-z0-9]{30,}/g },
  { id: 'sendgrid', kind: 'api-key', confidence: 'high', hint: 'SG\\.', re: /\bSG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,64}/g },
  { id: 'twilio', kind: 'api-key', confidence: 'medium', hint: 'SK[0-9a-fA-F]', re: /\bSK[0-9a-fA-F]{32}\b/g },
  { id: 'pypi', kind: 'api-key', confidence: 'high', hint: 'pypi-', re: /\bpypi-[A-Za-z0-9_-]{50,}/g },
  // the password of a connection string (the scheme, user and host stay): postgres://user:pass@host/db
  {
    id: 'connection-string',
    kind: 'connection-password',
    confidence: 'high',
    keep: 1,
    hint: '(?:postgres(?:ql)?|mysql|mariadb|mssql|sqlserver|mongodb(?:\\+srv)?|amqps?|rediss?)://',
    re: /\b((?:postgres(?:ql)?|mysql|mariadb|mssql|sqlserver|mongodb(?:\+srv)?|amqps?|rediss?):\/\/[^:/?#@\s"'<>]*:)(?!\{\{)[^@/\s"'<>]+(?=@)/gi,
  },
  // credential query parameters in any URL (the name stays)
  {
    id: 'query-credential',
    kind: 'query-credential',
    confidence: 'medium',
    keep: 1,
    hint: '[?&](?:access_token|id_token|refresh_token|token|api_?key|apikey|key|sig|signature|password|passwd|secret|client_secret|code|auth)=',
    re: /([?&](?:access_token|id_token|refresh_token|token|api_?key|apikey|key|sig|signature|password|passwd|secret|client_secret|code|auth)=)[^&#\s"'<>]{4,}/gi,
  },
];

/**
 * Every pattern's hint in two regexes, matched the way the patterns match (with and without case): a text neither
 * matches holds no value shape. (One case-insensitive regex of all hints is about twice as slow on a big workspace.)
 */
const hintsOf = (ci: boolean) => new RegExp(SECRET_VALUE_PATTERNS.filter((p) => p.re.flags.includes('i') === ci).map((p) => `(?:${p.hint})`).join('|'), ci ? 'i' : '');
const ANY_SHAPE_CASE = hintsOf(false);
const ANY_SHAPE_NOCASE = hintsOf(true);

/**
 * Whether `text` may hold a value shape: one test instead of one per pattern. False means none of the patterns can
 * match (each pattern's matches contain its hint); true means the patterns are worth running. Exports, git checks and
 * masks scan every URL, script and header of a workspace, and almost none of them holds a secret.
 */
export const mayHoldSecretShape = (text: string): boolean => ANY_SHAPE_CASE.test(text) || ANY_SHAPE_NOCASE.test(text);

/** A value shape found in a text: which pattern, where, and how sure. */
interface SecretValueMatch {
  id: string;
  kind: string;
  confidence: SecretConfidence;
  index: number;
  /** The secret part only (a kept scheme or user excluded). */
  secret: string;
}

const RANK: Record<SecretConfidence, number> = { low: 0, medium: 1, high: 2 };

/** Whether `c` is at least `min` (`high` ≥ `medium` ≥ `low`). */
export const confidenceAtLeast = (c: SecretConfidence, min: SecretConfidence): boolean => RANK[c] >= RANK[min];

/**
 * A reference instead of a value: `{{name}}` anywhere in it (`Bearer {{token}}`, `postgres://u:{{pw}}@h`), or a whole
 * value that names a secret or environment variable (`$secret.x`, `$env.X`, `${X}`, `$X`, `env:X`). Never a finding.
 */
export function isSecretReference(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (/\{\{\s*[^{}]+\s*\}\}/.test(value)) return true;
  const v = value.trim();
  return /^\$(?:secret|env)[.:][\w.-]+$/i.test(v) || /^\$\{?[A-Z_][A-Z0-9_]*\}?$/.test(v) || /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(v);
}

/** Every value shape in `text` at or above `min` confidence (default: all). */
export function findSecretValues(text: unknown, min: SecretConfidence = 'low'): SecretValueMatch[] {
  if (typeof text !== 'string' || text.length < 8 || !mayHoldSecretShape(text)) return [];
  const out: SecretValueMatch[] = [];
  for (const p of SECRET_VALUE_PATTERNS) {
    if (!confidenceAtLeast(p.confidence, min)) continue;
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      const kept = p.keep ? m.slice(1, 1 + p.keep).join('') : '';
      const secret = m[0].slice(kept.length);
      if (isSecretReference(secret)) continue;
      out.push({ id: p.id, kind: p.kind, confidence: p.confidence, index: m.index! + kept.length, secret });
    }
  }
  return out;
}

/** The strongest confidence of the value shapes in `text`, or undefined. */
export function valueConfidence(text: unknown): SecretConfidence | undefined {
  let best: SecretConfidence | undefined;
  for (const m of findSecretValues(text)) if (!best || RANK[m.confidence] > RANK[best]) best = m.confidence;
  return best;
}

/**
 * `text` with every value shape at or above `min` replaced: `replace(match)` gives the new text for the secret part
 * (a kept scheme or user stays). `hit` is told each kind replaced. The masks for logs and AI context use this.
 */
export function replaceSecretValues(
  text: string,
  replace: (m: { id: string; kind: string; confidence: SecretConfidence }, secret: string) => string,
  min: SecretConfidence = 'low',
  hit?: (kind: string) => void,
): string {
  if (!text || text.length < 8 || !mayHoldSecretShape(text)) return text;
  let out = text;
  for (const p of SECRET_VALUE_PATTERNS) {
    if (!confidenceAtLeast(p.confidence, min)) continue;
    p.re.lastIndex = 0;
    if (!p.re.test(out)) continue;
    p.re.lastIndex = 0;
    out = out.replace(p.re, (...m: unknown[]) => {
      const kept = p.keep ? (m.slice(1, 1 + p.keep) as string[]).join('') : '';
      const secret = (m[0] as string).slice(kept.length);
      if (isSecretReference(secret)) return m[0] as string;
      hit?.(p.kind);
      return kept + replace(p, secret);
    });
  }
  return out;
}

/* ------------------------------------------------------------------ key names */

const normKey = (s: string): string => s.toLowerCase().replace(/[-_\s.]/g, '');

/**
 * Header, variable and environment names known not to hold a secret: never a finding, whatever the value looks like.
 * (Compared without case, `-`, `_`, `.` or spaces: `Content-Type`, `content_type` and `CONTENT_TYPE` are one name.)
 */
const NON_SECRET_KEYS: ReadonlySet<string> = new Set(
  [
    'Content-Type',
    'Content-Length',
    'Content-Encoding',
    'Content-Language',
    'Content-Disposition',
    'Accept',
    'Accept-Encoding',
    'Accept-Language',
    'Accept-Charset',
    'User-Agent',
    'Cache-Control',
    'Pragma',
    'Connection',
    'Host',
    'Origin',
    'Referer',
    'If-None-Match',
    'If-Match',
    'If-Modified-Since',
    'ETag',
    'X-Request-Id',
    'X-Correlation-Id',
    'X-Trace-Id',
    'Traceparent',
    'Tracestate',
    'X-Requested-With',
    'X-Forwarded-For',
    'X-Forwarded-Proto',
    'Mcp-Protocol-Version',
    'Idempotency-Key',
    // environment variables of a local command
    'NODE_ENV',
    'NODE_OPTIONS',
    'PATH',
    'HOME',
    'LANG',
    'TZ',
    'PORT',
    'HOST',
    'DEBUG',
    'LOG_LEVEL',
    'PYTHONUNBUFFERED',
    'PYTHONPATH',
  ].map(normKey),
);

/** Whether a key is on the allow-list of names that never hold a secret. */
export const isNonSecretKey = (key: string): boolean => NON_SECRET_KEYS.has(normKey(key));

/** The configured field names, ready for matching (built once per list). */
export interface SecretKeyFields {
  raw: Set<string>;
  norm: Set<string>;
}

export function secretKeyFields(fields: readonly string[] = DEFAULT_REDACT_FIELDS): SecretKeyFields {
  return { raw: new Set(fields.map((f) => f.toLowerCase())), norm: new Set(fields.map(normKey)) };
}

const DEFAULT_FIELDS = secretKeyFields();

/**
 * How a key matches the secret field names: `exact` (case/separator-insensitive: `password`, `X-API-Key`), `suffix`
 * (ends with a field of 5+ characters: `accessToken`, `client_secret`; `totalTokens` and `maxTokens` do not), or
 * `none`. Allow-listed names (`Content-Type` …) are always `none`.
 */
export function matchSecretKey(key: string, fields: SecretKeyFields = DEFAULT_FIELDS): KeyMatch {
  if (typeof key !== 'string' || !key) return 'none';
  // the same few names come back for every object of every result: the answer per (field list, name) is remembered
  let memo = KEY_MEMO.get(fields);
  if (!memo) KEY_MEMO.set(fields, (memo = new Map()));
  const known = memo.get(key);
  if (known) return known;
  const answer = matchKey(key, fields);
  if (memo.size >= KEY_MEMO_MAX) memo.clear();
  memo.set(key, answer);
  return answer;
}

type KeyMatch = 'exact' | 'suffix' | 'none';
/** At most this many names are remembered per field list (an object with thousands of different keys must not grow it without end). */
const KEY_MEMO_MAX = 2048;
const KEY_MEMO = new WeakMap<SecretKeyFields, Map<string, KeyMatch>>();

function matchKey(key: string, fields: SecretKeyFields): KeyMatch {
  const k = normKey(key);
  if (NON_SECRET_KEYS.has(k)) return 'none';
  if (fields.raw.has(key.toLowerCase()) || fields.norm.has(k)) return 'exact';
  for (const f of fields.norm) if (f.length >= 5 && k.endsWith(f)) return 'suffix';
  return 'none';
}

/** Whether a key names a secret (`password`, `Authorization`, `apiKey`, `client_secret` …). */
export const isSecretKey = (key: string, fields?: SecretKeyFields): boolean => matchSecretKey(key, fields) !== 'none';

/* ------------------------------------------------------------------ one key/value pair */

/** Why a key/value pair is a secret, and how sure: from its name, its value's shape, or both. */
interface SecretVerdict {
  confidence: SecretConfidence;
  reason: 'key' | 'value' | 'key+value';
  /** The value pattern that matched (`openai`, `jwt` …), when the value's shape counted. */
  pattern?: string;
}

/**
 * Whether `value` under `key` is a literal secret. A secret key name with a literal value is `high`; a value shape
 * counts at its own confidence. References, empty values and allow-listed keys never are.
 */
export function classifySecret(key: string | undefined, value: unknown, fields?: SecretKeyFields): SecretVerdict | undefined {
  if (typeof value !== 'string' || !value.trim() || isSecretReference(value)) return undefined;
  if (key && isNonSecretKey(key)) return undefined;
  const byKey = !!key && isSecretKey(key, fields);
  const shapes = findSecretValues(value);
  const best = shapes.reduce<SecretValueMatch | undefined>((b, m) => (!b || RANK[m.confidence] > RANK[b.confidence] ? m : b), undefined);
  if (byKey) return { confidence: 'high', reason: best ? 'key+value' : 'key', ...(best ? { pattern: best.id } : {}) };
  if (best) return { confidence: best.confidence, reason: 'value', pattern: best.id };
  return undefined;
}
