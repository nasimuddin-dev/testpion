/**
 * Check a host's TLS certificate directly (one TLS handshake, no HTTP request): who it is for, who issued it, how long
 * it is still valid and whether this machine trusts it. For CI checks and agents; the network policy applies.
 */
import { connect, type PeerCertificate as TlsPeerCertificate } from 'node:tls';
import { assertUrlAllowed } from './policy.js';
import { trustedCa } from './proxy.js';

interface CertificateCheck {
  host: string;
  port: number;
  subject?: string;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
  daysLeft?: number;
  altNames?: string[];
  /** Whether the chain is trusted here (with the extra certificate authorities of Settings). */
  trusted: boolean;
  /** Why it is not trusted (e.g. CERT_HAS_EXPIRED, DEPTH_ZERO_SELF_SIGNED_CERT, ERR_TLS_CERT_ALTNAME_INVALID). */
  trustError?: string;
  protocol?: string;
  handshakeMs: number;
}

/** Connect to `target` (a host, host:port or https URL) and read its certificate. */
export async function checkCertificate(target: string, opts: { timeoutMs?: number; now?: number } = {}): Promise<CertificateCheck> {
  const url = new URL(/^[a-z][\w+.-]*:\/\//i.test(target) ? target : `https://${target}`);
  if (url.protocol !== 'https:' && url.protocol !== 'wss:') throw new Error(`${target} is not an https address`);
  await assertUrlAllowed(url);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port) || 443;
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername: /^[\d.:]+$/.test(host) ? undefined : host, ca: trustedCa(), rejectUnauthorized: false, ALPNProtocols: ['h2', 'http/1.1'] });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`No TLS handshake with ${host}:${port} within ${opts.timeoutMs ?? 10_000} ms`));
    }, opts.timeoutMs ?? 10_000);
    socket.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const c = socket.getPeerCertificate(false) as TlsPeerCertificate | undefined;
      const name = (n?: Record<string, string | string[]>) => {
        const v = n ? (n.CN ?? n.O ?? Object.values(n)[0]) : undefined;
        return Array.isArray(v) ? v[0] : v;
      };
      const to = c?.valid_to ? new Date(c.valid_to) : undefined;
      const from = c?.valid_from ? new Date(c.valid_from) : undefined;
      const now = opts.now ?? Date.now();
      resolve({
        host,
        port,
        subject: name(c?.subject as unknown as Record<string, string>),
        issuer: [c?.issuer?.CN, c?.issuer?.O].filter(Boolean).join(', ') || undefined,
        validFrom: from && !isNaN(+from) ? from.toISOString() : undefined,
        validTo: to && !isNaN(+to) ? to.toISOString() : undefined,
        daysLeft: to && !isNaN(+to) ? Math.floor((+to - now) / 864e5) : undefined,
        altNames: c?.subjectaltname
          ?.split(/,\s*/)
          .map((s) => s.replace(/^DNS:/, ''))
          .slice(0, 20),
        trusted: socket.authorized,
        trustError: socket.authorized ? undefined : String(socket.authorizationError ?? 'not trusted'),
        protocol: socket.getProtocol() ?? undefined,
        handshakeMs: Math.round(performance.now() - started),
      });
      socket.end();
    });
  });
}
