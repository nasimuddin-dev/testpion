import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { ApsError } from '../errors.js';

/**
 * Network policy for outbound connections (requests, tp.sendRequest, GraphQL, WebSocket, MCP over
 * HTTP, AI providers, remote datasets) and for starting local processes (MCP stdio servers).
 *
 * On the desktop everything is allowed: testing APIs on localhost and the private network is the
 * point. A shared server (the planned online version, or `testpion mcp-server` exposed to agents)
 * turns on `blockPrivateNetworks` so users can't reach internal services or cloud metadata
 * endpoints (SSRF), and `allowProcesses: false` so they can't start programs on the server.
 */
export interface NetworkPolicy {
  /** Refuse loopback, private (RFC 1918 / ULA), link-local (incl. 169.254.169.254), CGNAT and unspecified addresses. */
  blockPrivateNetworks: boolean;
  /** Host names or IPs that stay reachable even when private networks are blocked. */
  allowHosts?: string[];
  /** Start local processes (MCP stdio servers). */
  allowProcesses: boolean;
}

const DEFAULT: NetworkPolicy = { blockPrivateNetworks: false, allowProcesses: true };
let current: NetworkPolicy = policyFromEnv(process.env) ?? DEFAULT;

/** `TESTPION_BLOCK_PRIVATE_NETWORKS=1`, `TESTPION_ALLOW_HOSTS=a,b`, `TESTPION_ALLOW_PROCESSES=0` for server deployments. */
export function policyFromEnv(env: NodeJS.ProcessEnv): NetworkPolicy | undefined {
  const block = env.TESTPION_BLOCK_PRIVATE_NETWORKS;
  const procs = env.TESTPION_ALLOW_PROCESSES;
  if (block === undefined && procs === undefined) return undefined;
  return {
    blockPrivateNetworks: /^(1|true|yes)$/i.test(block ?? ''),
    allowHosts: env.TESTPION_ALLOW_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean),
    allowProcesses: procs === undefined ? true : /^(1|true|yes)$/i.test(procs),
  };
}

export function setNetworkPolicy(p: Partial<NetworkPolicy>): NetworkPolicy {
  current = { ...current, ...p };
  return current;
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
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x);
  }
  return true; // not an IP: treat as unsafe
}

const allowed = (host: string) => current.allowHosts?.some((h) => h.toLowerCase() === host.toLowerCase()) ?? false;

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
