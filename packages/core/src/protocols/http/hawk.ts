import { createHash, createHmac, randomBytes } from 'node:crypto';
import { ApsError } from '../../errors.js';

/**
 * Hawk (https://github.com/mozilla/hawk, protocol version 1): `Authorization: Hawk id="…", ts="…", nonce="…", [hash="…",]
 * [ext="…",] mac="…"`. The MAC covers the timestamp, nonce, method, path with query, host, port, the payload hash and the
 * application data, so the server can tell the request was not changed on the way.
 */

interface HawkConfig {
  id: string;
  key: string;
  algorithm?: 'sha256' | 'sha1';
  /** Application-specific data, signed with the request. */
  ext?: string;
  app?: string;
  dlg?: string;
  /** Sign the body too (needs the payload as text or bytes and its content type). */
  includePayloadHash?: boolean;
  /** Fixed values, for tests; normally generated per request. */
  timestamp?: number;
  nonce?: string;
}

/** The hash of a payload: `hawk.1.payload`, the content type without parameters (lower case), the payload, each ended by a newline. */
export function hawkPayloadHash(payload: string | Buffer, contentType: string, algorithm: 'sha256' | 'sha1' = 'sha256'): string {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return createHash(algorithm)
    .update('hawk.1.payload\n' + type + '\n')
    .update(payload)
    .update('\n')
    .digest('base64');
}

const escapeExt = (ext: string) => ext.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

/** The Authorization header value for a request (the payload is `undefined` for a request without a body). */
export function hawkAuthorization(method: string, url: URL, payload: string | Buffer | undefined, contentType: string, cfg: HawkConfig): string {
  if (!cfg.id || !cfg.key) throw new ApsError('ConfigurationError', 'Hawk needs an id and a key', { suggestions: ['Reference secret variables, e.g. {{hawkId}} and {{hawkKey}}.'] });
  const algorithm = cfg.algorithm ?? 'sha256';
  const ts = String(cfg.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = cfg.nonce ?? randomBytes(6).toString('base64url').slice(0, 6);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const hash = cfg.includePayloadHash && payload !== undefined ? hawkPayloadHash(payload, contentType, algorithm) : '';
  const ext = cfg.ext ?? '';
  const lines = ['hawk.1.header', ts, nonce, method.toUpperCase(), url.pathname + url.search, url.hostname.toLowerCase(), port, hash, escapeExt(ext)];
  if (cfg.app) lines.push(cfg.app, cfg.dlg ?? '');
  const mac = createHmac(algorithm, cfg.key).update(lines.join('\n') + '\n').digest('base64');
  const q = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const parts = [`id="${q(cfg.id)}"`, `ts="${ts}"`, `nonce="${nonce}"`];
  if (hash) parts.push(`hash="${hash}"`);
  if (ext) parts.push(`ext="${q(ext)}"`);
  parts.push(`mac="${mac}"`);
  if (cfg.app) {
    parts.push(`app="${q(cfg.app)}"`);
    if (cfg.dlg) parts.push(`dlg="${q(cfg.dlg)}"`);
  }
  return `Hawk ${parts.join(', ')}`;
}
