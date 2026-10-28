import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookupAll } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isLocalOnlyAddress } from '../net/policy.js';

/**
 * LAN mode of the HTTP Debugger's proxy: who may use it, and what a client that is not this computer may reach through it.
 * Not on the LAN, every check says "fine" (`pairingSecret` is undefined).
 */
export function createLanGuard(lan: boolean | undefined, lanSecret: string | undefined) {
  const pairingSecret = lan ? (lanSecret ?? randomBytes(15).toString('base64url')) : undefined;
  const paired = new Map<string, number>(); // bounded: one entry per paired device address, each lapses after 8 hours
  const PAIRED_MS = 8 * 3600_000;
  const isOwnAddress = (a?: string) => !a || a === '::1' || a === '127.0.0.1' || a.startsWith('127.') || /^::ffff:127\./i.test(a);
  const secretMatches = (given: string) => {
    const a = Buffer.from(given);
    const b = Buffer.from(pairingSecret ?? '');
    return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
  };
  /** Whether a client that is not this computer is paired: its address opened the paired page lately, or it sent the secret as the password. */
  const isPaired = (address: string, header: string | string[] | undefined): boolean => {
    const until = paired.get(address);
    if (until && until > Date.now()) return true;
    const h = Array.isArray(header) ? header[0] : header;
    const m = /^(basic|bearer)\s+(.+)$/i.exec(h ?? '');
    if (!m) return false;
    const given = m[1]!.toLowerCase() === 'bearer' ? m[2]!.trim() : Buffer.from(m[2]!.trim(), 'base64').toString('utf8').replace(/^[^:]*:/, '');
    return secretMatches(given);
  };
  return {
    pairingSecret,
    isOwnAddress,
    secretMatches,
    /** The device at this address opened the paired page: it is paired for 8 hours. */
    pair: (address: string) => void paired.set(address, Date.now() + PAIRED_MS),
    /** Not this computer and not paired (always false when the proxy is not on the LAN). */
    unpaired: (socket: { remoteAddress?: string } | undefined, header: string | string[] | undefined) => !!pairingSecret && !isOwnAddress(socket?.remoteAddress) && !isPaired(socket?.remoteAddress ?? '', header),
    /** A client that is not this computer must not reach this computer's loopback or link-local addresses through the proxy. */
    async refusedTarget(socket: { remoteAddress?: string } | undefined, host: string): Promise<boolean> {
      if (!pairingSecret || isOwnAddress(socket?.remoteAddress)) return false;
      const h = host.replace(/^\[|\]$/g, '');
      if (isIP(h)) return isLocalOnlyAddress(h);
      if (/^localhost$|\.localhost$/i.test(h)) return true;
      try {
        return (await dnsLookupAll(h, { all: true })).some((a) => isLocalOnlyAddress(a.address));
      } catch {
        return false; // does not resolve: the connection fails by itself
      }
    },
  };
}
