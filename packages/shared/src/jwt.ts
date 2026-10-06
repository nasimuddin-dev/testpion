/**
 * JSON Web Tokens: decode (never verify: no keys are involved) and find them in text. Times are reported in ISO
 * and relative to now, so a test or a person sees at once whether a token has expired. Runs in the browser and in
 * Node (base64 through atob, text through TextDecoder: both are everywhere).
 */

export interface DecodedJwt {
  /** The token itself (without a `Bearer ` prefix). */
  token: string;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** The signature part is present (it is not checked). */
  signed: boolean;
  issuedAt?: string;
  expiresAt?: string;
  notBefore?: string;
  /** Seconds until `exp` (negative once it has passed). */
  expiresInSec?: number;
  expired?: boolean;
}

const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;

function b64urlJson(part: string): Record<string, unknown> {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  const v = JSON.parse(json) as unknown;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a JSON object');
  return v as Record<string, unknown>;
}

/** Decode a JWT (a `Bearer ` prefix is ignored). Throws when it is not one. */
export function decodeJwt(token: string, now = Date.now()): DecodedJwt {
  const t = token.trim().replace(/^Bearer\s+/i, '');
  const parts = t.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1]) throw new Error('A JWT has three parts separated by dots: header.payload.signature');
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch (e) {
    throw new Error(`Not a JWT: ${(e as Error).message}`);
  }
  const iso = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000).toISOString() : undefined);
  const out: DecodedJwt = { token: t, header, payload, signed: !!parts[2] };
  const iat = iso(payload.iat);
  const exp = iso(payload.exp);
  const nbf = iso(payload.nbf);
  if (iat) out.issuedAt = iat;
  if (nbf) out.notBefore = nbf;
  if (exp) {
    out.expiresAt = exp;
    out.expiresInSec = Math.round((payload.exp as number) - now / 1000);
    out.expired = out.expiresInSec <= 0;
  }
  return out;
}

/** decodeJwt, or undefined when the text is not a JWT. */
export function tryDecodeJwt(token: string, now = Date.now()): DecodedJwt | undefined {
  try {
    return decodeJwt(token, now);
  } catch {
    return undefined;
  }
}

/** JWTs that appear in a text (a body, a header value), each once, in order. */
export function findJwts(text: string, limit = 10): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(JWT_RE)) {
    if (out.includes(m[0])) continue;
    if (tryDecodeJwt(m[0])) out.push(m[0]);
    if (out.length >= limit) break;
  }
  return out;
}

/** The decoded JWTs in several texts (a body and header values), each once, at most `limit`. */
export function findDecodedJwts(texts: string[], limit = 10): DecodedJwt[] {
  const out: DecodedJwt[] = [];
  for (const t of texts)
    for (const token of findJwts(t, limit)) {
      if (out.some((d) => d.token === token)) continue;
      const d = tryDecodeJwt(token);
      if (d) out.push(d);
      if (out.length >= limit) return out;
    }
  return out;
}

/** "in 5 min", "2 h ago": a token's expiry for people. */
export function describeExpiry(sec: number): string {
  const a = Math.abs(sec);
  const v = a < 120 ? `${a} s` : a < 7200 ? `${Math.round(a / 60)} min` : a < 172800 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} days`;
  return sec > 0 ? `in ${v}` : `${v} ago`;
}
