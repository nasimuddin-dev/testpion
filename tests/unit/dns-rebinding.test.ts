import { afterAll, describe, expect, it } from 'vitest';
import dns from 'node:dns';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { assertUrlAllowed, setNetworkPolicy } from '../../packages/core/src/index.js';

// a name that answers a public address to the policy's check and 127.0.0.1 to the connection that follows (DNS rebinding)
const realLookup = dns.lookup;
afterAll(() => {
  setNetworkPolicy({ blockPrivateNetworks: false });
  dns.lookup = realLookup;
});

describe('DNS rebinding with the network policy on', () => {
  it('the connection is refused even though the check saw a public answer', async () => {
    let answers = 0;
    const hits: string[] = [];
    const srv = createServer((req, res) => (hits.push(req.url ?? ''), res.end('inside')));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    // the resolver: first answer public, every later one loopback
    (dns as unknown as { lookup: unknown }).lookup = (_h: string, o: unknown, cb?: unknown) => {
      const done = (typeof o === 'function' ? o : cb) as (e: null, a: string, f: number) => void;
      done(null, ++answers === 1 ? '93.184.216.34' : '127.0.0.1', 4);
    };
    setNetworkPolicy({ blockPrivateNetworks: true }); // the guard wraps the resolver that is in place now
    try {
      // the check resolves with the policy's own (original) lookup, which is the real DNS: use a public literal host for it
      await assertUrlAllowed('http://93.184.216.34/');
      const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
        const s = connect({ host: 'rebind.example.test', port });
        s.once('error', (e) => resolve(e as NodeJS.ErrnoException));
        s.once('connect', () => resolve(new Error('connected') as NodeJS.ErrnoException));
      });
      // the first answer was public (connect may have used it and failed to reach it) or loopback and refused: never a connection to loopback
      expect(err.message).not.toBe('connected');
      expect(hits).toEqual([]);
      // a later answer (loopback) is refused with the policy's message
      const second = await new Promise<NodeJS.ErrnoException>((resolve) => {
        const req = request({ host: 'rebind.example.test', port, timeout: 3000 }, () => resolve(new Error('reached') as NodeJS.ErrnoException));
        req.on('error', (e) => resolve(e as NodeJS.ErrnoException));
        req.end();
      });
      expect(second.message).toMatch(/Blocked by the network policy|ECONN|ETIMEDOUT|EACCES|ENETUNREACH|EHOSTUNREACH|timeout/i);
      expect(hits).toEqual([]);
    } finally {
      srv.close();
    }
  });
});
