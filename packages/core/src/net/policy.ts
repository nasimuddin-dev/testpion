import dnsModule, { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { ApsError } from '../errors.js';
import { relativeInside } from '../storage/fsutil.js';

/**
 * Network policy for outbound connections (requests, tp.sendRequest, GraphQL, WebSocket, MCP over
 * HTTP, AI providers, remote datasets) and for starting local processes (MCP stdio servers).
 *
 * On the desktop everything is allowed: testing APIs on localhost and the private network is the
 * point. A shared server (the planned online version, or `testpion mcp-server` exposed to agents)
 * turns on `blockPrivateNetworks` so users can't reach internal services or cloud metadata
 * endpoints (SSRF), and `allowProcesses: false` so they can't start programs on the server.
 */
interface NetworkPolicy {
  /** Refuse loopback, private (RFC 1918 / ULA), link-local (incl. 169.254.169.254), CGNAT and unspecified addresses. */
  blockPrivateNetworks: boolean;
  /** Host names or IPs that stay reachable even when private networks are blocked. */
  allowHosts?: string[];
  /** Start local processes (MCP stdio servers). */
  allowProcesses: boolean;
  /**
   * Read and write files at any absolute path of this computer (a certificate, a data file, a folder to clone into): the
   * desktop's default, where the person picked them. A shared server turns it off: files are then only reachable inside
   * `localFileRoots` (the user's own folder), through `assertHostPath`.
   */
  allowLocalFiles?: boolean;
  /** Where files stay reachable when `allowLocalFiles` is off. */
  localFileRoots?: string[];
}

const DEFAULT: NetworkPolicy = { blockPrivateNetworks: false, allowProcesses: true };
let current: NetworkPolicy = policyFromEnv(process.env) ?? DEFAULT;

/** `TESTPION_BLOCK_PRIVATE_NETWORKS=1`, `TESTPION_ALLOW_HOSTS=a,b`, `TESTPION_ALLOW_PROCESSES=0`, `TESTPION_ALLOW_LOCAL_FILES=0` (+ `TESTPION_LOCAL_FILE_ROOTS=a,b`) for server deployments. */
export function policyFromEnv(env: NodeJS.ProcessEnv): NetworkPolicy | undefined {
  const block = env.TESTPION_BLOCK_PRIVATE_NETWORKS;
  const procs = env.TESTPION_ALLOW_PROCESSES;
  const files = env.TESTPION_ALLOW_LOCAL_FILES;
  if (block === undefined && procs === undefined && files === undefined) return undefined;
  return {
    blockPrivateNetworks: /^(1|true|yes)$/i.test(block ?? ''),
    allowHosts: env.TESTPION_ALLOW_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean),
    allowProcesses: procs === undefined ? true : /^(1|true|yes)$/i.test(procs),
    ...(files === undefined ? {} : { allowLocalFiles: /^(1|true|yes)$/i.test(files) }),
    ...(env.TESTPION_LOCAL_FILE_ROOTS ? { localFileRoots: env.TESTPION_LOCAL_FILE_ROOTS.split(',').map((h) => h.trim()).filter(Boolean) } : {}),
  };
}

/**
 * The one gate for a path on the host computer that a request, a script or a parameter named (a client certificate, a data
 * file, a folder to clone into or to open, a shell's working folder). The desktop allows them all: the person chose the file.
 * Where local files are off (a shared server) only paths inside the configured roots pass, links resolved. Answers the path.
 */
export function assertHostPath(path: string, what: string): string {
  if (current.allowLocalFiles !== false) return path;
  const roots = current.localFileRoots ?? [];
  if (roots.some((r) => relativeInside(resolve(r), resolve(path), { orSame: true }) !== undefined)) return path;
  throw new ApsError('ValidationError', `${what}: this server does not read or write files on its own computer outside your folder`, {
    suggestions: ['Use a file inside the workspace (a relative path), or upload it.'],
    details: { hostPath: true },
  });
}

/** Whether a text names a place on the host computer rather than an item of the workspace: an absolute path, ~, a UNC or file: path. */
export function looksLikeHostPath(text: string): boolean {
  return isAbsolute(text) || /^[a-z]:[\\/]/i.test(text) || text.startsWith('~') || /^\\\\/.test(text) || /^file:/i.test(text);
}

export function setNetworkPolicy(p: Partial<NetworkPolicy>): NetworkPolicy {
  current = { ...current, ...p };
  syncDnsGuard();
  return current;
}

/*
 * `assertUrlAllowed` resolves a name and checks the answers; the connection that follows resolves it again, and a name that
 * answers differently the second time (DNS rebinding) would reach a private address. So while private networks are blocked,
 * the process's own `dns.lookup` (what net.connect, tls, undici and every client use when no `lookup` is given) refuses private
 * answers too: the address that is connected to is the one that was checked, whatever resolved first.
 */
let originalLookup: typeof dnsModule.lookup | undefined;
function syncDnsGuard(): void {
  if (current.blockPrivateNetworks && !originalLookup) {
    const orig = (originalLookup = dnsModule.lookup);
    const guarded = function (this: unknown, hostname: string, options: unknown, callback?: unknown) {
      const cb = (typeof options === 'function' ? options : callback) as (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
      const opts = typeof options === 'function' ? {} : options;
      (orig as unknown as (h: string, o: unknown, c: unknown) => void).call(dnsModule, hostname, opts, (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => {
        if (err || !current.blockPrivateNetworks || allowed(hostname)) return cb(err, address, family);
        const list = Array.isArray(address) ? address : [{ address, family: family ?? 4 }];
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) return cb(Object.assign(blockedError(hostname, bad.address), { code: 'EACCES' }) as unknown as NodeJS.ErrnoException, address, family);
        cb(null, address, family);
      });
    };
    (dnsModule as unknown as { lookup: unknown }).lookup = guarded;
  } else if (!current.blockPrivateNetworks && originalLookup) {
    (dnsModule as unknown as { lookup: unknown }).lookup = originalLookup;
    originalLookup = undefined;
  }
}

export function getNetworkPolicy(): NetworkPolicy {
  return current;
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
];

/** Whether an IP address is loopback, private, link-local or otherwise not a public internet address. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => ((n ^ ipv4ToInt(base)) >>> (32 - bits)) === 0);
  }
  if (v === 6) {
    const b = ipv6Bytes(ip);
    if (!b) return true;
    const embedded = (at: number) => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;
    const zeros = (n: number) => b.slice(0, n).every((x) => x === 0);
    // the same IPv4 address in another costume is still that address: mapped (::ffff:a.b.c.d, also written ::ffff:7f00:1),
    // compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002:a.b.c.d::/16)
    if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return isPrivateAddress(embedded(12));
    if (zeros(12) && b.slice(12).some((x) => x !== 0)) return isPrivateAddress(embedded(12));
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return isPrivateAddress(embedded(12));
    if (b[0] === 0x20 && b[1] === 0x02) return isPrivateAddress(embedded(2));
    // unspecified and loopback (::, ::1), unique local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8)
    return zeros(16) || (zeros(15) && b[15] === 1) || (b[0]! & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) || b[0] === 0xff;
  }
  return true; // not an IP: treat as unsafe
}

/**
 * Whether an IP address reaches only this computer or its cloud metadata: loopback, unspecified or link-local (169.254/16, fe80::/10),
 * with the IPv6 costumes of IPv4 addresses. What a client on the LAN must not be able to reach through a proxy that runs here.
 */
export function isLocalOnlyAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const n = ipv4ToInt(ip);
    return (['0.0.0.0', '127.0.0.0'] as const).some((base) => ((n ^ ipv4ToInt(base)) >>> 24) === 0) || ((n ^ ipv4ToInt('169.254.0.0')) >>> 16) === 0;
  }
  if (v === 6) {
    const b = ipv6Bytes(ip);
    if (!b) return true;
    const embedded = (at: number) => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;
    const zeros = (n: number) => b.slice(0, n).every((x) => x === 0);
    if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return isLocalOnlyAddress(embedded(12));
    if (zeros(12) && b.slice(12).some((x) => x !== 0)) return isLocalOnlyAddress(embedded(12));
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return isLocalOnlyAddress(embedded(12));
    if (b[0] === 0x20 && b[1] === 0x02) return isLocalOnlyAddress(embedded(2));
    return zeros(16) || (zeros(15) && b[15] === 1) || (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80);
  }
  return true;
}

/** The 16 bytes of an IPv6 address (any notation `isIP` accepts, including a trailing IPv4 part and a %zone), or undefined. */
function ipv6Bytes(ip: string): number[] | undefined {
  let s = ip.toLowerCase().split('%')[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = v4[1]!.split('.').map(Number);
    s = s.slice(0, -v4[1]!.length) + (((o[0]! << 8) | o[1]!).toString(16) + ':' + ((o[2]! << 8) | o[3]!).toString(16));
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const side = (t: string) => (t ? t.split(':') : []);
  const head = side(halves[0]!);
  const tail = halves.length === 2 ? side(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<string>(Math.max(fill, 0)).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]);
}

const allowed = (host: string) => current.allowHosts?.some((h) => h.toLowerCase() === host.toLowerCase()) ?? false;

/** Whether a plain http:// link may be fetched on the server's behalf: always on the desktop; where private networks are blocked, only for hosts the administrator allowed (localhost included, by name). */
export function isPlainHttpAllowed(url: string | URL): boolean {
  if (!current.blockPrivateNetworks) return true;
  const u = typeof url === 'string' ? new URL(url) : url;
  return allowed(u.hostname.replace(/^\[|\]$/g, ''));
}

function blockedError(host: string, ip?: string): ApsError {
  return new ApsError('ConfigurationError', `Blocked by the network policy: ${host}${ip && ip !== host ? ` (${ip})` : ''} is a private or local address`, {
    suggestions: ['This TestPion server only allows requests to public internet addresses.', 'An administrator can allow specific hosts (TESTPION_ALLOW_HOSTS).'],
  });
}

/**
 * Check a URL before connecting. Host names are resolved and every address must be public.
 * No-op when private networks are allowed (the desktop default).
 */
export async function assertUrlAllowed(url: string | URL): Promise<void> {
  if (!current.blockPrivateNetworks) return;
  const u = typeof url === 'string' ? new URL(url) : url;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (allowed(host)) return;
  if (host === 'localhost' || host.endsWith('.localhost')) throw blockedError(host);
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw blockedError(host);
    return;
  }
  const addrs = await new Promise<LookupAddress[]>((ok, fail) => dnsLookup(host, { all: true }, (e, a) => (e ? fail(e) : ok(a))));
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) throw blockedError(host, bad.address);
}

/**
 * A `lookup` for socket connections that refuses private addresses at connect time. Used by the HTTP
 * client's connection pool, so redirects and DNS rebinding can't reach a private address either.
 */
export function policyLookup(hostname: string, options: object, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  dnsLookup(hostname, options as never, ((err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => {
    if (err || !current.blockPrivateNetworks || allowed(hostname)) return callback(err, address, family);
    const list = Array.isArray(address) ? address : [{ address, family: family ?? 4 }];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad) return callback(Object.assign(blockedError(hostname, bad.address), { code: 'EACCES' }) as unknown as NodeJS.ErrnoException, address, family);
    callback(null, address, family);
  }) as never);
}

/** Refuse to start local processes when the policy forbids it (MCP stdio servers on a shared server). */
export function assertProcessesAllowed(what: string): void {
  if (!current.allowProcesses) throw new ApsError('ConfigurationError', `Blocked by the network policy: starting local programs (${what}) is disabled on this server`, { suggestions: ['Use an MCP server over Streamable HTTP or SSE instead of stdio.'] });
}

// a policy set by the environment (TESTPION_BLOCK_PRIVATE_NETWORKS) guards name lookups from the start
syncDnsGuard();
