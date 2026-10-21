import { afterEach, describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpSession, WebSocketSession, assertUrlAllowed, executeHttp, fetchImportText, isPlainHttpAllowed, isPrivateAddress, policyFromEnv, setNetworkPolicy } from '../../packages/core/src/index.js';

describe('network policy (for shared / hosted servers)', () => {
  afterEach(() => setNetworkPolicy({ blockPrivateNetworks: false, allowHosts: [], allowProcesses: true }));

  it('classifies private, local and metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('sees the IPv4 address inside every IPv6 costume (mapped in hex, compatible, NAT64, 6to4)', () => {
    const hidden = [
      '::ffff:7f00:1', // 127.0.0.1 as the URL parser writes ::ffff:127.0.0.1
      '::ffff:a9fe:a9fe', // 169.254.169.254
      '::ffff:0a00:0001',
      '0:0:0:0:0:ffff:c0a8:101',
      '::7f00:1', // IPv4-compatible
      '::127.0.0.1',
      '::10.0.0.1',
      '64:ff9b::7f00:1', // NAT64
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::169.254.169.254',
      '2002:7f00:1::', // 6to4 of 127.0.0.1
      '2002:a9fe:a9fe::1',
      '2002:c0a8:101:5::2',
      '::', // unspecified
      '0:0:0:0:0:0:0:1',
      'fe80::1%eth0',
      'febf::1',
      'fc00::1',
      'fdff::1',
      'ff02::1',
    ];
    for (const ip of hidden) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1', '::8.8.8.8', '2001:db8::1', '2a00:1450::1']) expect(isPrivateAddress(ip), ip).toBe(false);
    // the URL parser's own spelling reaches the same verdict
    expect(isPrivateAddress(new URL('http://[::ffff:127.0.0.1]/').hostname.replace(/^\[|\]$/g, ''))).toBe(true);
  });

  it('allows everything by default (desktop) and blocks private hosts when switched on', async () => {
    await expect(assertUrlAllowed('http://127.0.0.1:1/x')).resolves.toBeUndefined();
    setNetworkPolicy({ blockPrivateNetworks: true });
    await expect(assertUrlAllowed('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/network policy/);
    await expect(assertUrlAllowed('http://localhost:8080/')).rejects.toThrow(/network policy/);
    await expect(assertUrlAllowed('http://[::1]:8080/')).rejects.toThrow(/network policy/);
    setNetworkPolicy({ allowHosts: ['127.0.0.1'] });
    await expect(assertUrlAllowed('http://127.0.0.1:8080/')).resolves.toBeUndefined();
    await expect(assertUrlAllowed('http://[::ffff:7f00:1]:8080/')).rejects.toThrow(/network policy/);
    await expect(assertUrlAllowed('http://[64:ff9b::a9fe:a9fe]/')).rejects.toThrow(/network policy/);
  });

  it('URL import asks the policy about the link and every redirect, by hand, and wants https where private networks are blocked', async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      if (req.url === '/to-metadata') return res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
      if (req.url === '/to-mapped') return res.writeHead(302, { location: 'http://[::ffff:7f00:1]:1/x' }).end();
      if (req.url === '/loop') return res.writeHead(302, { location: '/loop' }).end();
      res.writeHead(200, { 'content-type': 'text/plain' }).end('openapi: 3.0.0 # spec');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // desktop: nothing blocked, redirects still followed (and capped)
      await expect(fetchImportText(`${base}/ok`)).resolves.toMatchObject({ text: 'openapi: 3.0.0 # spec' });
      await expect(fetchImportText(`${base}/loop`)).rejects.toThrow(/redirects too many times/);
      // server: the first link is refused before a connection
      setNetworkPolicy({ blockPrivateNetworks: true });
      hits = 0;
      await expect(fetchImportText(`${base}/ok`)).rejects.toThrow(/network policy/);
      await expect(fetchImportText('http://169.254.169.254/latest/meta-data/iam/security-credentials/')).rejects.toThrow(/network policy/);
      await expect(fetchImportText('http://[::ffff:7f00:1]/')).rejects.toThrow(/network policy/);
      expect(hits).toBe(0);
      // plain http to an allowed host is refused: https only
      setNetworkPolicy({ allowHosts: ['127.0.0.1'] });
      expect(isPlainHttpAllowed(`${base}/ok`)).toBe(true);
      expect(isPlainHttpAllowed('http://example.com/')).toBe(false);
      // an allowed host that redirects to a private address is stopped at the hop
      await expect(fetchImportText(`${base}/to-metadata`)).rejects.toThrow(/network policy/);
      await expect(fetchImportText(`${base}/to-mapped`)).rejects.toThrow(/network policy/);
      expect(hits).toBe(2);
      await expect(fetchImportText('http://example.com/spec.yaml')).rejects.toThrow(/plain http/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('reads the policy from the environment', () => {
    expect(policyFromEnv({})).toBeUndefined();
    expect(policyFromEnv({ TESTPION_BLOCK_PRIVATE_NETWORKS: '1', TESTPION_ALLOW_HOSTS: 'a.internal, b', TESTPION_ALLOW_PROCESSES: '0' })).toEqual({ blockPrivateNetworks: true, allowHosts: ['a.internal', 'b'], allowProcesses: false });
  });

  it('blocks HTTP requests and redirects into private networks', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/secret` });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('internal data');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await executeHttp({ method: 'GET', url: `${base}/ok` })).response.status).toBe(200);
      setNetworkPolicy({ blockPrivateNetworks: true });
      await expect(executeHttp({ method: 'GET', url: `${base}/ok` })).rejects.toThrow(/network policy/);
      // an allowed host that redirects to a private one is stopped at the redirect
      setNetworkPolicy({ allowHosts: ['127.0.0.1'] });
      expect((await executeHttp({ method: 'GET', url: `${base}/ok` })).response.status).toBe(200);
      await expect(executeHttp({ method: 'GET', url: `${base}/redirect` })).rejects.toThrow(/network policy/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('blocks WebSocket handshakes and MCP stdio servers', async () => {
    setNetworkPolicy({ blockPrivateNetworks: true, allowProcesses: false });
    await expect(new WebSocketSession('ws://127.0.0.1:1/socket').connect(2000)).rejects.toThrow(/network policy/);
    await expect(new McpSession({ id: 's', name: 'local tool', transport: 'stdio', command: 'node', args: ['-e', ''] }).connect(2000)).rejects.toThrow(/starting local programs/);
  });
});
