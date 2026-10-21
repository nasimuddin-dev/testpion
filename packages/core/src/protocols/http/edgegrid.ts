import { createHash, createHmac, randomUUID } from 'node:crypto';
import { ApsError } from '../../errors.js';

/**
 * Akamai EdgeGrid (EG1-HMAC-SHA256): the Authorization header carries the client token, access token, a timestamp and a
 * nonce, and a signature over the method, scheme, host, path with query, the chosen headers, the hash of a POST body and
 * the header itself. The signing key is derived from the client secret and the timestamp.
 * https://techdocs.akamai.com/developer/docs/authenticate-with-edgegrid
 */

interface EdgeGridConfig {
  clientToken: string;
  clientSecret: string;
  accessToken: string;
  /** Names of request headers to sign, separated by commas (usually none). */
  headersToSign?: string;
  /** How many bytes of a POST body are hashed (default 131072). */
  maxBodySize?: number;
  /** Fixed values, for tests; normally generated per request. */
  timestamp?: string;
  nonce?: string;
}

/** `20140321T19:34:21+0000` */
export function edgeGridTimestamp(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, '+0000').replace(/-/g, '');
}

export function edgeGridAuthorization(method: string, url: URL, headers: Headers, body: string | Buffer | undefined, cfg: EdgeGridConfig): string {
  if (!cfg.clientToken || !cfg.clientSecret || !cfg.accessToken) throw new ApsError('ConfigurationError', 'EdgeGrid needs a client token, a client secret and an access token', { suggestions: ['Reference secret variables, e.g. {{edgegridClientSecret}}.'] });
  const timestamp = cfg.timestamp ?? edgeGridTimestamp();
  const nonce = cfg.nonce ?? randomUUID();
  const m = method.toUpperCase();
  const authHeader = `EG1-HMAC-SHA256 client_token=${cfg.clientToken};access_token=${cfg.accessToken};timestamp=${timestamp};nonce=${nonce};`;
  const signingKey = createHmac('sha256', cfg.clientSecret).update(timestamp).digest('base64');
  const canonicalHeaders = (cfg.headersToSign ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((h) => {
      const v = headers.get(h);
      return v ? [`${h}:${v.trim().replace(/\s+/g, ' ')}`] : [];
    })
    .join('\t');
  // only a POST body is hashed, up to the limit
  const max = cfg.maxBodySize && cfg.maxBodySize > 0 ? cfg.maxBodySize : 131072;
  const raw = body === undefined ? undefined : typeof body === 'string' ? Buffer.from(body) : body;
  const contentHash = m === 'POST' && raw?.length ? createHash('sha256').update(raw.subarray(0, max)).digest('base64') : '';
  const toSign = [m, url.protocol.replace(':', ''), url.host.toLowerCase(), url.pathname + url.search, canonicalHeaders, contentHash, authHeader].join('\t');
  const signature = createHmac('sha256', signingKey).update(toSign).digest('base64');
  return `${authHeader}signature=${signature}`;
}
