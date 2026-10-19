import { createHmac, randomBytes } from 'node:crypto';
import { ApsError } from '../../errors.js';

/**
 * Windows NTLM authentication, version 2 ([MS-NLMP]): the client sends a Negotiate message (type 1), the server answers
 * 401 with a Challenge (type 2), the client answers that with an Authenticate message (type 3) on the SAME connection.
 * Only the messages are built here (pure functions, tested against the vectors of [MS-NLMP] 4.2.4); the handshake over
 * one connection is in client.ts. No signing or sealing is negotiated, so no session key is needed.
 */

const SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1');
const FLAG = {
  UNICODE: 0x00000001,
  OEM: 0x00000002,
  REQUEST_TARGET: 0x00000004,
  NTLM: 0x00000200,
  OEM_DOMAIN_SUPPLIED: 0x00001000,
  OEM_WORKSTATION_SUPPLIED: 0x00002000,
  ALWAYS_SIGN: 0x00008000,
  EXTENDED_SESSION_SECURITY: 0x00080000,
  TARGET_INFO: 0x00800000,
  BITS_128: 0x20000000,
  BITS_56: 0x80000000,
};

/* ------------------------------------------------------------------ MD4 (OpenSSL 3 no longer offers it) */

const rol = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;

/** MD4 (RFC 1320): the NT hash of a password is MD4 of its UTF-16LE bytes. */
export function md4(input: Buffer): Buffer {
  const len = input.length;
  const padded = Buffer.alloc(((len + 8) >> 6 << 6) + 64);
  input.copy(padded);
  padded[len] = 0x80;
  padded.writeUInt32LE((len * 8) >>> 0, padded.length - 8);
  padded.writeUInt32LE(Math.floor((len * 8) / 0x100000000) >>> 0, padded.length - 4);
  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const x = new Array<number>(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) x[i] = padded.readUInt32LE(off + i * 4);
    const [aa, bb, cc, dd] = [a, b, c, d];
    const F = (p: number, q: number, r: number) => ((p & q) | (~p & r)) >>> 0;
    const G = (p: number, q: number, r: number) => ((p & q) | (p & r) | (q & r)) >>> 0;
    const H = (p: number, q: number, r: number) => (p ^ q ^ r) >>> 0;
    // round 1
    for (let i = 0; i < 16; i += 4) {
      a = rol((a + F(b, c, d) + x[i]!) >>> 0, 3);
      d = rol((d + F(a, b, c) + x[i + 1]!) >>> 0, 7);
      c = rol((c + F(d, a, b) + x[i + 2]!) >>> 0, 11);
      b = rol((b + F(c, d, a) + x[i + 3]!) >>> 0, 19);
    }
    // round 2
    for (let i = 0; i < 4; i++) {
      a = rol((a + G(b, c, d) + x[i]! + 0x5a827999) >>> 0, 3);
      d = rol((d + G(a, b, c) + x[i + 4]! + 0x5a827999) >>> 0, 5);
      c = rol((c + G(d, a, b) + x[i + 8]! + 0x5a827999) >>> 0, 9);
      b = rol((b + G(c, d, a) + x[i + 12]! + 0x5a827999) >>> 0, 13);
    }
    // round 3
    for (const i of [0, 2, 1, 3]) {
      a = rol((a + H(b, c, d) + x[i]! + 0x6ed9eba1) >>> 0, 3);
      d = rol((d + H(a, b, c) + x[i + 8]! + 0x6ed9eba1) >>> 0, 9);
      c = rol((c + H(d, a, b) + x[i + 4]! + 0x6ed9eba1) >>> 0, 11);
      b = rol((b + H(c, d, a) + x[i + 12]! + 0x6ed9eba1) >>> 0, 15);
    }
    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }
  const out = Buffer.alloc(16);
  [a, b, c, d].forEach((v, i) => out.writeUInt32LE(v, i * 4));
  return out;
}

const hmacMd5 = (key: Buffer, data: Buffer) => createHmac('md5', key).update(data).digest();
const utf16 = (s: string) => Buffer.from(s, 'utf16le');

/** NTOWFv1: the NT hash of the password. */
export const ntHash = (password: string): Buffer => md4(utf16(password));
/** NTOWFv2: HMAC-MD5 keyed with the NT hash over the upper-cased user name and the domain. */
export const ntlmV2Hash = (username: string, password: string, domain: string): Buffer => hmacMd5(ntHash(password), utf16(username.toUpperCase() + domain));

/* ------------------------------------------------------------------ messages */

/** A security buffer pointer inside a message: length, allocated length, offset. */
function field(buf: Buffer, at: number, len: number, offset: number) {
  buf.writeUInt16LE(len, at);
  buf.writeUInt16LE(len, at + 2);
  buf.writeUInt32LE(offset, at + 4);
}

/** Message 1 (Negotiate), base64 for `Authorization: NTLM …`. A domain / workstation is sent when given (OEM text). */
export function ntlmNegotiate(o: { domain?: string; workstation?: string } = {}): string {
  const domain = Buffer.from((o.domain ?? '').toUpperCase(), 'latin1');
  const workstation = Buffer.from((o.workstation ?? '').toUpperCase(), 'latin1');
  let flags = FLAG.UNICODE | FLAG.REQUEST_TARGET | FLAG.NTLM | FLAG.ALWAYS_SIGN | FLAG.EXTENDED_SESSION_SECURITY | FLAG.BITS_128 | FLAG.BITS_56;
  if (domain.length) flags |= FLAG.OEM_DOMAIN_SUPPLIED;
  if (workstation.length) flags |= FLAG.OEM_WORKSTATION_SUPPLIED;
  const head = Buffer.alloc(32);
  SIGNATURE.copy(head);
  head.writeUInt32LE(1, 8);
  head.writeUInt32LE(flags >>> 0, 12);
  field(head, 16, domain.length, 32);
  field(head, 24, workstation.length, 32 + domain.length);
  return Buffer.concat([head, domain, workstation]).toString('base64');
}

export interface NtlmChallenge {
  serverChallenge: Buffer;
  flags: number;
  /** The server's AV pairs, sent back unchanged in the client's response (they include the server's timestamp, when it has one). */
  targetInfo: Buffer;
  /** MsvAvTimestamp (a FILETIME), when the server sent one. */
  timestamp?: Buffer;
}

/** Parse message 2 (Challenge) from the base64 after `WWW-Authenticate: NTLM `. */
export function parseNtlmChallenge(b64: string): NtlmChallenge {
  const m = Buffer.from(b64, 'base64');
  if (m.length < 32 || !m.subarray(0, 8).equals(SIGNATURE) || m.readUInt32LE(8) !== 2) throw new ApsError('AuthenticationError', 'The server sent an NTLM challenge TestPion cannot read');
  const flags = m.readUInt32LE(20);
  const serverChallenge = Buffer.from(m.subarray(24, 32));
  let targetInfo = Buffer.alloc(0);
  if (m.length >= 48) {
    const len = m.readUInt16LE(40);
    const off = m.readUInt32LE(44);
    if (len && off + len <= m.length) targetInfo = Buffer.from(m.subarray(off, off + len));
  }
  let timestamp: Buffer | undefined;
  for (let i = 0; i + 4 <= targetInfo.length; ) {
    const id = targetInfo.readUInt16LE(i);
    const len = targetInfo.readUInt16LE(i + 2);
    if (id === 0) break;
    if (id === 7 && len === 8) timestamp = Buffer.from(targetInfo.subarray(i + 4, i + 12));
    i += 4 + len;
  }
  return { serverChallenge, flags, targetInfo, timestamp };
}

/** The NTLMv2 responses to a challenge: `ntChallengeResponse` (NTProofStr + the client blob) and `lmChallengeResponse`. */
export function ntlmV2Responses(c: { username: string; password: string; domain: string }, ch: NtlmChallenge, o: { clientChallenge?: Buffer; time?: Buffer } = {}) {
  const clientChallenge = o.clientChallenge ?? randomBytes(8);
  // FILETIME: 100 ns ticks since 1601-01-01; the server's own timestamp wins (it checks the response against it)
  const time = ch.timestamp ?? o.time ?? (() => {
    const t = Buffer.alloc(8);
    t.writeBigUInt64LE((BigInt(Date.now()) + 11644473600000n) * 10000n);
    return t;
  })();
  const key = ntlmV2Hash(c.username, c.password, c.domain);
  const blob = Buffer.concat([Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]), time, clientChallenge, Buffer.alloc(4), ch.targetInfo, Buffer.alloc(4)]);
  const ntProofStr = hmacMd5(key, Buffer.concat([ch.serverChallenge, blob]));
  const lm = Buffer.concat([hmacMd5(key, Buffer.concat([ch.serverChallenge, clientChallenge])), clientChallenge]);
  return { ntProofStr, ntChallengeResponse: Buffer.concat([ntProofStr, blob]), lmChallengeResponse: lm };
}

/** Message 3 (Authenticate), base64 for `Authorization: NTLM …`. */
export function ntlmAuthenticate(c: { username: string; password: string; domain?: string; workstation?: string }, ch: NtlmChallenge, o: { clientChallenge?: Buffer; time?: Buffer } = {}): string {
  const unicode = !!(ch.flags & FLAG.UNICODE);
  const text = (s: string) => (unicode ? utf16(s) : Buffer.from(s, 'latin1'));
  const domain = c.domain ?? '';
  const r = ntlmV2Responses({ username: c.username, password: c.password, domain }, ch, o);
  const parts = [r.lmChallengeResponse, r.ntChallengeResponse, text(domain), text(c.username), text(c.workstation ?? ''), Buffer.alloc(0)];
  const head = Buffer.alloc(64);
  SIGNATURE.copy(head);
  head.writeUInt32LE(3, 8);
  let offset = 64;
  parts.forEach((p, i) => {
    field(head, 12 + i * 8, p.length, offset);
    offset += p.length;
  });
  // the flags the server offered that we also asked for (no key exchange, signing or sealing)
  const flags = ch.flags & (FLAG.UNICODE | FLAG.OEM | FLAG.REQUEST_TARGET | FLAG.NTLM | FLAG.ALWAYS_SIGN | FLAG.EXTENDED_SESSION_SECURITY | FLAG.TARGET_INFO | FLAG.BITS_128 | FLAG.BITS_56);
  head.writeUInt32LE(flags >>> 0, 60);
  return Buffer.concat([head, ...parts]).toString('base64');
}

/** The type-2 token of a `WWW-Authenticate` header (it may list several schemes), or undefined. */
export function ntlmTokenOf(header: string | null | undefined): string | undefined {
  return /(?:^|[\s,])NTLM\s+([A-Za-z0-9+/=]{16,})/i.exec(header ?? '')?.[1];
}
