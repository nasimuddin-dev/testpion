import { afterEach, describe, expect, it } from 'vitest';
import { policyLookup, setDnsResolverForTests } from '../../packages/core/src/net/policy.js';

// N-1: every new connection did its own getaddrinfo
afterEach(() => setDnsResolverForTests());

describe('lookups for connections', () => {
  it('1,000 lookups of one host hit the resolver once', async () => {
    let calls = 0;
    setDnsResolverForTests((_host, _options, cb) => {
      calls++;
      setTimeout(() => cb(null, [{ address: '93.184.216.34', family: 4 }], undefined), 5);
    });
    const one = () => new Promise<unknown>((resolve, reject) => policyLookup('api.example.test', { all: true }, (e, a) => (e ? reject(e) : resolve(a))));
    // 500 at once share the one under way, then 500 more come from the cache
    await Promise.all(Array.from({ length: 500 }, one));
    for (let i = 0; i < 500; i++) expect(await one()).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(calls).toBe(1);
  });

  it('a failure is not remembered', async () => {
    let calls = 0;
    setDnsResolverForTests((_h, _o, cb) => {
      calls++;
      cb(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }) as NodeJS.ErrnoException, '' as never, undefined);
    });
    const one = () => new Promise<unknown>((resolve) => policyLookup('gone.example.test', {}, (e) => resolve(e)));
    expect(await one()).toBeTruthy();
    expect(await one()).toBeTruthy();
    expect(calls).toBe(2);
  });
});
