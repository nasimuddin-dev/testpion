import type { TLSSocket, DetailedPeerCertificate, PeerCertificate } from 'node:tls';
import type { TlsCertInfo, TlsInfo } from '@testpion/shared';

/** The most certificates of a chain that are kept, and subject alternative names per certificate. */
const MAX_CHAIN = 6;
const MAX_SAN = 20;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join('/') : v);
const nameOf = (o: { CN?: string | string[]; O?: string | string[]; C?: string | string[]; OU?: string | string[] } | undefined) =>
  o ? [one(o.CN) && `CN=${one(o.CN)}`, one(o.OU) && `OU=${one(o.OU)}`, one(o.O) && `O=${one(o.O)}`, one(o.C) && `C=${one(o.C)}`].filter(Boolean).join(', ') : '';

const iso = (s: string | undefined) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

function certOf(c: PeerCertificate): TlsCertInfo {
  const san = c.subjectaltname
    ? c.subjectaltname
        .split(/,\s*/)
        .filter((x) => x.startsWith('DNS:'))
        .map((x) => x.slice(4))
        .slice(0, MAX_SAN)
    : undefined;
  return {
    subject: nameOf(c.subject),
    issuer: nameOf(c.issuer),
    validFrom: iso(c.valid_from),
    validTo: iso(c.valid_to),
    ...(san?.length ? { san } : {}),
    ...(c.fingerprint256 ? { fingerprint256: c.fingerprint256 } : {}),
    ...(c.serialNumber ? { serial: c.serialNumber } : {}),
  };
}

/** What a finished TLS handshake with the server agreed on, and the certificates it sent (undefined for a socket not encrypted). */
export function tlsInfoOf(sock: TLSSocket | undefined): TlsInfo | undefined {
  if (!sock || !sock.encrypted || typeof sock.getProtocol !== 'function') return undefined;
  const version = sock.getProtocol() ?? undefined;
  if (!version) return undefined;
  const info: TlsInfo = { version, cipher: sock.getCipher()?.name, authorized: sock.authorized };
  if (sock.alpnProtocol) info.alpn = sock.alpnProtocol;
  if (!sock.authorized && sock.authorizationError) info.authError = String(sock.authorizationError).slice(0, 200);
  try {
    const leaf = sock.getPeerCertificate(true) as DetailedPeerCertificate | undefined;
    if (leaf && leaf.subject) {
      const chain: TlsCertInfo[] = [];
      const seen = new Set<unknown>();
      for (let c: DetailedPeerCertificate | undefined = leaf; c && !seen.has(c) && chain.length < MAX_CHAIN; c = c.issuerCertificate) {
        seen.add(c);
        chain.push(certOf(c));
        // a self-signed root points to itself
        if (c.issuerCertificate === c) break;
      }
      info.chain = chain;
    }
  } catch {
    /* a certificate that cannot be read leaves the rest */
  }
  return info;
}

/** Reads the TLS details of an upstream socket once its handshake is done (a reused socket has finished it already). */
export function watchTls(sock: import('node:net').Socket, set: (t: TlsInfo | undefined) => void): void {
  const tls = sock as TLSSocket;
  const read = () => set(tlsInfoOf(tls));
  if (tls.encrypted && !sock.connecting && tls.getProtocol?.()) read();
  else sock.once('secureConnect', read);
}
