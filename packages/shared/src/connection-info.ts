/**
 * What the Debugger records about the TLS connection to the server (FG-10): version, cipher, ALPN, and the server certificate
 * with its chain, plus plain-words findings (expired, expiring, an old protocol, a name that does not match the host).
 */

export interface TlsCertInfo {
  subject: string;
  issuer: string;
  /** ISO times. */
  validFrom?: string;
  validTo?: string;
  /** Subject alternative names (DNS), at most 20. */
  san?: string[];
  fingerprint256?: string;
  serial?: string;
}

export interface TlsInfo {
  /** TLSv1.3, TLSv1.2 … */
  version?: string;
  cipher?: string;
  /** The protocol the client and server agreed on after TLS (h2, http/1.1). */
  alpn?: string;
  /** The chain was verified against the trusted roots. */
  authorized?: boolean;
  authError?: string;
  /** The server's certificate first, then the issuers the server sent (at most 6). */
  chain?: TlsCertInfo[];
}

export interface TlsFinding {
  level: 'bad' | 'warn' | 'ok';
  text: string;
}

const dayMs = 86_400_000;

/** Does a certificate name (with a leading wildcard label) cover the host? */
export function nameMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase().replace(/\.$/, '');
  if (p === h) return true;
  return p.startsWith('*.') && h.split('.').length === p.split('.').length && h.endsWith(p.slice(1));
}

export function tlsFindings(t: TlsInfo, host: string, now = Date.now()): TlsFinding[] {
  const out: TlsFinding[] = [];
  const leaf = t.chain?.[0];
  if (leaf?.validTo) {
    const left = (Date.parse(leaf.validTo) - now) / dayMs;
    if (!Number.isNaN(left)) {
      if (left < 0) out.push({ level: 'bad', text: `The certificate expired ${Math.ceil(-left)} day(s) ago (${leaf.validTo.slice(0, 10)}). Clients that check will refuse it.` });
      else if (left < 14) out.push({ level: 'warn', text: `The certificate expires in ${Math.floor(left)} day(s) (${leaf.validTo.slice(0, 10)}): renew it soon.` });
      else out.push({ level: 'ok', text: `The certificate is valid until ${leaf.validTo.slice(0, 10)} (${Math.floor(left)} days).` });
    }
  }
  if (leaf?.validFrom && Date.parse(leaf.validFrom) > now) out.push({ level: 'bad', text: `The certificate is not valid yet (from ${leaf.validFrom.slice(0, 10)}): check the clock of this computer and the server.` });
  if (leaf && host) {
    const names = leaf.san?.length ? leaf.san : [/CN=([^,\n]+)/.exec(leaf.subject)?.[1] ?? ''];
    if (!names.some((n) => n && nameMatches(n, host))) out.push({ level: 'bad', text: `The certificate is for ${names.slice(0, 3).join(', ') || 'another name'}, not ${host}.` });
  }
  if (t.authorized === false) out.push({ level: 'bad', text: `The certificate chain is not trusted${t.authError ? `: ${t.authError}` : ''}.` });
  if (t.version && /^(TLSv1|TLSv1\.1|SSLv.*)$/.test(t.version)) out.push({ level: 'bad', text: `${t.version} is an old protocol that modern clients refuse. Ask the server's owner to enable TLS 1.2 or 1.3.` });
  else if (t.version === 'TLSv1.2') out.push({ level: 'ok', text: 'TLS 1.2 is fine; TLS 1.3 is newer and faster to set up.' });
  if (t.cipher && /RC4|3DES|DES-CBC|NULL|EXPORT|MD5/i.test(t.cipher)) out.push({ level: 'bad', text: `${t.cipher} is a weak cipher.` });
  if (leaf && leaf.subject === leaf.issuer && (t.chain?.length ?? 0) <= 1) out.push({ level: 'warn', text: 'The certificate is self-signed: only clients that were told to trust it will accept it.' });
  return out;
}
