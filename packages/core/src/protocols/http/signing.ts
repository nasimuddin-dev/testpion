import { createHash, createHmac, randomBytes } from 'node:crypto';
import { ApsError } from '../../errors.js';
import { sha256Hex } from '../../util/hash.js';

/**
 * Request signing auth that needs the final request: AWS Signature Version 4 (signs method, URL,
 * headers and body) and HTTP Digest (answers the server's 401 challenge). Both match Postman's
 * "AWS Signature" and "Digest Auth".
 */

const sha256 = sha256Hex;
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
/** RFC 3986 encoding, as AWS requires (encodeURIComponent leaves !'()* alone). */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

interface AwsV4Config {
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
  region: string;
  service: string;
}

/**
 * Add AWS Signature Version 4 headers (`authorization`, `x-amz-date`, and `x-amz-security-token` /
 * `x-amz-content-sha256` when they apply) to `headers`. `body` is the exact payload: a string or
 * bytes are hashed; a stream or form (file uploads) is sent as UNSIGNED-PAYLOAD, which S3 accepts.
 */
export function signAwsV4(method: string, url: URL, headers: Headers, body: unknown, cfg: AwsV4Config, now = new Date()): void {
  if (!cfg.accessKey || !cfg.secretKey) throw new ApsError('ConfigurationError', 'AWS Signature needs an access key and a secret key', { suggestions: ['Reference secret variables, e.g. {{awsAccessKey}} and {{awsSecretKey}}.'] });
  if (!cfg.region || !cfg.service) throw new ApsError('ConfigurationError', 'AWS Signature needs a region (e.g. us-east-1) and a service name (e.g. execute-api, s3)');
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const s3 = cfg.service === 's3';
  const payloadHash = body === undefined || body === null ? sha256('') : typeof body === 'string' || Buffer.isBuffer(body) ? sha256(body) : 'UNSIGNED-PAYLOAD';

  headers.set('x-amz-date', amzDate);
  if (cfg.sessionToken) headers.set('x-amz-security-token', cfg.sessionToken);
  if (s3) headers.set('x-amz-content-sha256', payloadHash);

  // S3 signs the path as sent; other services normalise and encode each segment again
  const path = url.pathname || '/';
  const canonicalUri = s3 ? path : path.split('/').map((seg) => rfc3986(decodeSegment(seg))).map(rfc3986).join('/');
  const query = [...url.searchParams.entries()].map(([k, v]) => [rfc3986(k), rfc3986(v)] as const).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  const canonicalQuery = query.map(([k, v]) => `${k}=${v}`).join('&');

  const signed = new Map<string, string>([['host', url.host]]);
  for (const [k, v] of headers.entries()) {
    const name = k.toLowerCase();
    if (name.startsWith('x-amz-') || name === 'content-type' || name === 'content-md5') signed.set(name, v.trim().replace(/\s+/g, ' '));
  }
  const names = [...signed.keys()].sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed.get(n)}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method.toUpperCase(), canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${date}/${cfg.region}/${cfg.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${cfg.secretKey}`, date), cfg.region), cfg.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  headers.set('authorization', `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parameters of a `WWW-Authenticate: Digest …` challenge, or undefined for other schemes. */
export function parseDigestChallenge(header: string | null | undefined): Record<string, string> | undefined {
  const m = /^\s*Digest\s+(.*)$/is.exec(header ?? '');
  if (!m) return undefined;
  const out: Record<string, string> = {};
  for (const p of m[1]!.matchAll(/([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/gi)) out[p[1]!.toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : p[3]!;
  return out;
}

/**
 * The `Authorization` value answering a Digest challenge (RFC 7616: MD5, SHA-256 and their -sess
 * variants, with qop=auth or no qop). `uri` is the request target (path and query).
 */
export function digestAuthorization(
  challenge: Record<string, string>,
  a: { username: string; password: string; method: string; uri: string; cnonce?: string; nc?: number },
): string {
  const alg = (challenge.algorithm ?? 'MD5').toUpperCase();
  const base = alg.replace(/-SESS$/, '');
  const hashName = base === 'MD5' ? 'md5' : base === 'SHA-256' ? 'sha256' : base === 'SHA-512-256' ? 'sha512-256' : undefined;
  if (!hashName) throw new ApsError('AuthenticationError', `Unsupported Digest algorithm ${challenge.algorithm}`);
  const H = (s: string) => createHash(hashName).update(s).digest('hex');
  const qops = (challenge.qop ?? '').split(',').map((q) => q.trim());
  const qop = qops.includes('auth') ? 'auth' : undefined;
  if (challenge.qop && !qop) throw new ApsError('AuthenticationError', `Unsupported Digest qop "${challenge.qop}" (only "auth" is supported)`);
  const cnonce = a.cnonce ?? randomBytes(8).toString('hex');
  const nc = (a.nc ?? 1).toString(16).padStart(8, '0');
  const realm = challenge.realm ?? '';
  const nonce = challenge.nonce ?? '';
  let ha1 = H(`${a.username}:${realm}:${a.password}`);
  if (alg.endsWith('-SESS')) ha1 = H(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = H(`${a.method.toUpperCase()}:${a.uri}`);
  const response = qop ? H(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${nonce}:${ha2}`);
  const q = (v: string) => `"${v.replace(/(["\\])/g, '\\$1')}"`;
  const parts = [`username=${q(a.username)}`, `realm=${q(realm)}`, `nonce=${q(nonce)}`, `uri=${q(a.uri)}`];
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${q(cnonce)}`);
  parts.push(`response=${q(response)}`);
  if (challenge.opaque !== undefined) parts.push(`opaque=${q(challenge.opaque)}`);
  return `Digest ${parts.join(', ')}`;
}

interface OAuth1Config {
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
  signatureMethod?: 'HMAC-SHA1' | 'HMAC-SHA256' | 'PLAINTEXT';
  realm?: string;
  /** Put the oauth_* parameters in the Authorization header (default) or in the query string. */
  addTo?: 'header' | 'query';
  /** Fixed values, for tests; normally generated per request. */
  timestamp?: string;
  nonce?: string;
}

/**
 * OAuth 1.0a (RFC 5849): signs the method, URL (with its query) and form-urlencoded body parameters,
 * and adds the oauth_* parameters to the Authorization header or the query string.
 */
export function signOAuth1(method: string, url: URL, headers: Headers, body: unknown, cfg: OAuth1Config): void {
  if (!cfg.consumerKey) throw new ApsError('ConfigurationError', 'OAuth 1.0 needs a consumer key');
  const sigMethod = cfg.signatureMethod ?? 'HMAC-SHA1';
  const oauth: Record<string, string> = {
    oauth_consumer_key: cfg.consumerKey,
    oauth_nonce: cfg.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: sigMethod,
    oauth_timestamp: cfg.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    ...(cfg.token ? { oauth_token: cfg.token } : {}),
  };
  const key = `${rfc3986(cfg.consumerSecret ?? '')}&${rfc3986(cfg.tokenSecret ?? '')}`;
  let signature: string;
  if (sigMethod === 'PLAINTEXT') signature = key;
  else {
    // form-urlencoded body parameters are signed too (other bodies are not)
    const form = typeof body === 'string' && /application\/x-www-form-urlencoded/i.test(headers.get('content-type') ?? '') ? body : undefined;
    const base = oauth1BaseString(method, url, oauth, form);
    signature = createHmac(sigMethod === 'HMAC-SHA256' ? 'sha256' : 'sha1', key).update(base).digest('base64');
  }
  oauth.oauth_signature = signature;
  if (cfg.addTo === 'query') {
    for (const [k, v] of Object.entries(oauth)) url.searchParams.set(k, v);
    return;
  }
  const parts = Object.entries(oauth).map(([k, v]) => `${k}="${rfc3986(v)}"`);
  headers.set('authorization', `OAuth ${cfg.realm ? `realm="${cfg.realm}", ` : ''}${parts.join(', ')}`);
}

/** The signature base string of a request (exposed for tests and for showing what was signed). */
export function oauth1BaseString(method: string, url: URL, params: Record<string, string>, formBody?: string): string {
  const all: Array<[string, string]> = [...url.searchParams.entries(), ...Object.entries(params), ...(formBody ? [...new URLSearchParams(formBody).entries()] : [])];
  const normalized = all
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return [method.toUpperCase(), rfc3986(`${url.protocol}//${url.host.toLowerCase()}${url.pathname}`), rfc3986(normalized)].join('&');
}
