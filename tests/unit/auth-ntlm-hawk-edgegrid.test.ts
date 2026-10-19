import { describe, it, expect } from 'vitest';
import { createServer } from 'node:net';
import { md4, ntHash, ntlmV2Hash, ntlmV2Responses, ntlmNegotiate, ntlmAuthenticate, parseNtlmChallenge, ntlmTokenOf } from '../../packages/core/src/protocols/http/ntlm.js';
import { hawkAuthorization, hawkPayloadHash } from '../../packages/core/src/protocols/http/hawk.js';
import { edgeGridAuthorization, edgeGridTimestamp } from '../../packages/core/src/protocols/http/edgegrid.js';
import { executeHttp, prepareHttpRequest } from '../../packages/core/src/protocols/http/client.js';

const hex = (b: Buffer) => b.toString('hex');

describe('MD4 and NTLMv2 against [MS-NLMP] 4.2.4 and RFC 1320', () => {
  it('MD4 matches the RFC 1320 test suite', () => {
    const md4s = (s: string) => hex(md4(Buffer.from(s)));
    expect(md4s('')).toBe('31d6cfe0d16ae931b73c59d7e0c089c0');
    expect(md4s('a')).toBe('bde52cb31de33e46245e05fbdbd6fb24');
    expect(md4s('abc')).toBe('a448017aaf21d8525fc10ae87aa6729d');
    expect(md4s('message digest')).toBe('d9130a8164549fe818874806e1c7014b');
    expect(md4s('abcdefghijklmnopqrstuvwxyz')).toBe('d79e1c308aa5bbcdeea8ed63df412da9');
    expect(md4s('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toBe('e33b4ddc9c38f2199c3e7b164fcc0536');
  });

  it('the NT hash and the NTLMv2 hash of the spec user', () => {
    expect(hex(ntHash('Password'))).toBe('a4f49c406510bdcab6824ee7c30fd852');
    expect(hex(ntlmV2Hash('User', 'Password', 'Domain'))).toBe('0c868a403bfd7a93a3001ef22ef02e3f');
  });

  it('the NTLMv2 proof and the LMv2 response of [MS-NLMP] 4.2.4.2', () => {
    // ServerName = the AV pairs NbDomainName "Domain", NbComputerName "Server", end of list
    const targetInfo = Buffer.from('02000c0044006f006d00610069006e0001000c0053006500720076006500720000000000', 'hex');
    const ch = { serverChallenge: Buffer.from('0123456789abcdef', 'hex'), flags: 0, targetInfo };
    const r = ntlmV2Responses({ username: 'User', password: 'Password', domain: 'Domain' }, ch, { clientChallenge: Buffer.alloc(8, 0xaa), time: Buffer.alloc(8) });
    expect(hex(r.ntProofStr)).toBe('68cd0ab851e51c96aabc927bebef6a1c');
    expect(hex(r.lmChallengeResponse)).toBe('86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa');
  });

  it('builds a negotiate message and answers a challenge with a well-formed authenticate message', () => {
    const t1 = Buffer.from(ntlmNegotiate({ domain: 'Domain', workstation: 'PC' }), 'base64');
    expect(t1.subarray(0, 8).toString('latin1')).toBe('NTLMSSP\0');
    expect(t1.readUInt32LE(8)).toBe(1);
    // a challenge as an IIS server sends it: target info with a timestamp
    const info = Buffer.concat([Buffer.from('0700080000000000', 'hex').subarray(0, 4), Buffer.from('0102030405060708', 'hex'), Buffer.alloc(4)]);
    const head = Buffer.alloc(48);
    head.write('NTLMSSP\0', 0, 'latin1');
    head.writeUInt32LE(2, 8);
    head.writeUInt32LE(0xa2898215 >>> 0, 20);
    Buffer.from('0123456789abcdef', 'hex').copy(head, 24);
    head.writeUInt16LE(info.length, 40);
    head.writeUInt16LE(info.length, 42);
    head.writeUInt32LE(48, 44);
    const type2 = Buffer.concat([head, info]).toString('base64');
    const ch = parseNtlmChallenge(type2);
    expect(hex(ch.serverChallenge)).toBe('0123456789abcdef');
    expect(hex(ch.timestamp!)).toBe('0102030405060708');
    const t3 = Buffer.from(ntlmAuthenticate({ username: 'User', password: 'Password', domain: 'Domain', workstation: 'PC' }, ch, { clientChallenge: Buffer.alloc(8, 1) }), 'base64');
    expect(t3.readUInt32LE(8)).toBe(3);
    // the domain, user and workstation fields point at UTF-16 text
    const at = (i: number) => t3.subarray(t3.readUInt32LE(12 + i * 8 + 4), t3.readUInt32LE(12 + i * 8 + 4) + t3.readUInt16LE(12 + i * 8));
    expect(at(2).toString('utf16le')).toBe('Domain');
    expect(at(3).toString('utf16le')).toBe('User');
    expect(at(4).toString('utf16le')).toBe('PC');
    expect(at(0).length).toBe(24);
    expect(ntlmTokenOf('Negotiate, NTLM ' + type2)).toBe(type2);
    expect(ntlmTokenOf('NTLM')).toBeUndefined();
  });

  it('rejects something that is not a challenge', () => {
    expect(() => parseNtlmChallenge(Buffer.from('hello world, this is not ntlm at all!').toString('base64'))).toThrow(/cannot read/);
  });
});

describe('Hawk against the protocol examples', () => {
  const url = new URL('http://example.com:8000/resource/1?b=1&a=2');
  it('the MAC of the Hawk README request', () => {
    const h = hawkAuthorization('GET', url, undefined, '', { id: 'dh37fgj492je', key: 'werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn', algorithm: 'sha256', ext: 'some-app-ext-data', timestamp: 1353832234, nonce: 'j4h3g2' });
    expect(h).toBe('Hawk id="dh37fgj492je", ts="1353832234", nonce="j4h3g2", ext="some-app-ext-data", mac="6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE="');
  });
  it('the payload hash of the Hawk README response', () => {
    expect(hawkPayloadHash('Thank you for flying Hawk', 'text/plain')).toBe('Yi9LfIIFRtBEPt74PVmbTF/xVAwPn7ub15ePICfgnuY=');
    // the content type's parameters do not count
    expect(hawkPayloadHash('Thank you for flying Hawk', 'Text/Plain; charset=utf-8')).toBe('Yi9LfIIFRtBEPt74PVmbTF/xVAwPn7ub15ePICfgnuY=');
  });
  it('adds the payload hash, app and dlg when asked, and needs an id and a key', () => {
    const h = hawkAuthorization('POST', new URL('https://api.example.com/x'), '{"a":1}', 'application/json', { id: 'i', key: 'k', includePayloadHash: true, app: 'a1', dlg: 'd1', timestamp: 1, nonce: 'n' });
    expect(h).toMatch(/^Hawk id="i", ts="1", nonce="n", hash="[A-Za-z0-9+/]{43}=", mac="[A-Za-z0-9+/]{43}=", app="a1", dlg="d1"$/);
    expect(() => hawkAuthorization('GET', url, undefined, '', { id: '', key: '' })).toThrow(/id and a key/);
  });
});

describe('EdgeGrid against the AkamaiOPEN-edgegrid-python test data', () => {
  const base = { clientToken: 'akab-client-token-xxx-xxxxxxxxxxxxxxxx', clientSecret: 'x'.repeat(43) + '=', accessToken: 'akab-access-token-xxx-xxxxxxxxxxxxxxxx', maxBodySize: 2048, timestamp: '20140321T19:34:21+0000', nonce: 'nonce-xx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' };
  const host = 'https://akaa-baseurl-xxxxxxxxxxx-xxxxxxxxxxxxx.luna.akamaiapis.net';
  it('the JSON POST of testdata.json (jsontest_hash)', () => {
    const h = edgeGridAuthorization('POST', new URL(host + '/testapi/v1/t3?extended=true'), new Headers(), '{"key": "value"}', base);
    expect(h).toBe('EG1-HMAC-SHA256 client_token=akab-client-token-xxx-xxxxxxxxxxxxxxxx;access_token=akab-access-token-xxx-xxxxxxxxxxxxxxxx;timestamp=20140321T19:34:21+0000;nonce=nonce-xx-xxxx-xxxx-xxxx-xxxxxxxxxxxx;signature=nONuDe50qGrPius4Rg4D2jfi/2zDZWAYRUG6RudJLNM=');
  });
  it('the timestamp format', () => {
    expect(edgeGridTimestamp(new Date('2014-03-21T19:34:21.123Z'))).toBe('20140321T19:34:21+0000');
  });
  it('a GET body is not hashed, a POST body is cut at the limit, and a header to sign is canonicalised', () => {
    const h = new Headers({ 'X-Test': '  a   b ' });
    const u = new URL(host + '/x?y=1');
    const withHeader = edgeGridAuthorization('GET', u, h, 'ignored', { ...base, headersToSign: 'x-test, x-missing' });
    const without = edgeGridAuthorization('GET', u, h, undefined, base);
    expect(withHeader).not.toBe(without);
    expect(edgeGridAuthorization('GET', u, h, 'ignored', base)).toBe(without);
    const cut = (n: number) => edgeGridAuthorization('POST', u, h, 'a'.repeat(n), { ...base, maxBodySize: 10 });
    expect(cut(10)).toBe(cut(10));
    expect(edgeGridAuthorization('POST', u, h, 'a'.repeat(10) + 'zzz', { ...base, maxBodySize: 10 })).toBe(cut(10));
  });
});

describe('the HTTP client signs with Hawk and EdgeGrid, and runs the NTLM handshake', () => {
  it('prepareHttpRequest puts the Hawk and EdgeGrid headers on the request', async () => {
    const hawk = await prepareHttpRequest({ method: 'GET', url: 'http://example.com:8000/resource/1?b=1&a=2', auth: { type: 'hawk', id: 'dh37fgj492je', key: 'k', ext: 'e' } });
    expect(hawk.headers.get('authorization')).toMatch(/^Hawk id="dh37fgj492je", ts="\d+", nonce="[\w-]{6}", ext="e", mac="/);
    const eg = await prepareHttpRequest({ method: 'POST', url: 'https://h.example.net/p?q=1', body: { type: 'json', content: '{}' }, auth: { type: 'edgegrid', clientToken: 'c', clientSecret: 's', accessToken: 'a' } });
    expect(eg.headers.get('authorization')).toMatch(/^EG1-HMAC-SHA256 client_token=c;access_token=a;timestamp=\d{8}T\d\d:\d\d:\d\d\+0000;nonce=[\w-]+;signature=/);
  });

  it('NTLM: negotiate without the body, then authenticate with it, on one connection', async () => {
    const seen: Array<{ line: string; auth: string; connection: number }> = [];
    let connections = 0;
    const server = createServer((socket) => {
      const id = ++connections;
      let buf = '';
      socket.on('data', (d) => {
        buf += d.toString('latin1');
        for (;;) {
          const end = buf.indexOf('\r\n\r\n');
          if (end < 0) return;
          const head = buf.slice(0, end);
          const len = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
          if (buf.length < end + 4 + len) return;
          buf = buf.slice(end + 4 + len);
          const auth = /^authorization:\s*(.*)$/im.exec(head)?.[1] ?? '';
          seen.push({ line: head.split('\r\n')[0]!, auth: auth.slice(0, 5), connection: id });
          if (!auth) socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: NTLM\r\nContent-Length: 0\r\n\r\n');
          else if (/^NTLM TlRM/.test(auth) && Buffer.from(auth.slice(5), 'base64').readUInt32LE(8) === 1) {
            const info = Buffer.alloc(4);
            const t2 = Buffer.alloc(48);
            t2.write('NTLMSSP\0', 0, 'latin1');
            t2.writeUInt32LE(2, 8);
            t2.writeUInt32LE(0xa2898215 >>> 0, 20);
            Buffer.from('0123456789abcdef', 'hex').copy(t2, 24);
            t2.writeUInt16LE(4, 40);
            t2.writeUInt32LE(48, 44);
            socket.write(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: NTLM ${Buffer.concat([t2, info]).toString('base64')}\r\nContent-Length: 0\r\n\r\n`);
          } else {
            const type = Buffer.from(auth.slice(5), 'base64').readUInt32LE(8);
            const ok = type === 3 && len === 5;
            socket.write(`HTTP/1.1 ${ok ? 200 : 403} OK\r\nContent-Length: 2\r\nContent-Type: text/plain\r\n\r\nok`);
          }
        }
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const { response } = await executeHttp({ method: 'POST', url: `http://127.0.0.1:${port}/ntlm`, body: { type: 'text', content: 'hello' }, auth: { type: 'ntlm', username: 'User', password: 'Password', domain: 'Domain' } }, { timeoutMs: 5000 });
      expect(response.status).toBe(200);
      expect(response.bodyPreview).toBe('ok');
      // the negotiate message and the answer to the challenge went over the same connection
      expect(new Set(seen.map((s) => s.connection)).size).toBe(1);
      expect(seen.map((s) => s.auth)).toEqual(['NTLM ', 'NTLM ']);
    } finally {
      server.close();
    }
  });
});
