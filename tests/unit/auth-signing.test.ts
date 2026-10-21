import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { digestAuthorization, executeHttp, exportPostmanCollection, parseCurl, parseDigestChallenge, Redactor, signAwsV4 } from '../../packages/core/src/index.js';
import { importAny } from '../helpers-import.js';

const AWS = { accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service' };
const AT = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));

describe('AWS Signature Version 4', () => {
  // vectors from the AWS Signature Version 4 test suite
  it('get-vanilla', () => {
    const h = new Headers();
    signAwsV4('GET', new URL('https://example.amazonaws.com/'), h, undefined, AWS, AT);
    expect(h.get('x-amz-date')).toBe('20150830T123600Z');
    expect(h.get('authorization')).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('get-vanilla-query-order-key-case (query sorted by key)', () => {
    const h = new Headers();
    signAwsV4('GET', new URL('https://example.amazonaws.com/?Param2=value2&Param1=value1'), h, undefined, AWS, AT);
    expect(h.get('authorization')).toContain('Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500');
  });

  it('adds the session token and the S3 payload hash', () => {
    const h = new Headers({ 'content-type': 'application/json' });
    signAwsV4('PUT', new URL('https://bucket.s3.amazonaws.com/a b.txt'), h, '{"x":1}', { ...AWS, service: 's3', sessionToken: 'tok' }, AT);
    expect(h.get('x-amz-security-token')).toBe('tok');
    expect(h.get('x-amz-content-sha256')).toBe(createHash('sha256').update('{"x":1}').digest('hex'));
    expect(h.get('authorization')).toMatch(/SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
    expect(() => signAwsV4('GET', new URL('https://x/'), new Headers(), undefined, { ...AWS, secretKey: '' })).toThrow(/secret key/);
  });
});

describe('Digest auth', () => {
  it('matches the RFC 2617 example', () => {
    const challenge = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')!;
    const v = digestAuthorization(challenge, { username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html', cnonce: '0a4f113b', nc: 1 });
    expect(v).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(v).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    expect(parseDigestChallenge('Basic realm="x"')).toBeUndefined();
  });

  it('answers a real server challenge (and the password is redacted)', async () => {
    const nonce = 'abc123';
    const seen: string[] = [];
    const server = createServer((req: IncomingMessage, res) => {
      const auth = req.headers.authorization ?? '';
      seen.push(auth);
      const p = parseDigestChallenge(auth.replace(/^Digest/, 'Digest'));
      if (p) {
        const md5 = (s: string) => createHash('md5').update(s).digest('hex');
        const ha1 = md5(`vet:clinic:s3cret`);
        const ha2 = md5(`${req.method}:${p.uri}`);
        const expected = md5(`${ha1}:${nonce}:${p.nc}:${p.cnonce}:auth:${ha2}`);
        if (p.response === expected && p.uri === req.url) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      }
      res.writeHead(401, { 'www-authenticate': `Digest realm="clinic", qop="auth", nonce="${nonce}", opaque="o1"` }).end('no');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/patients?page=2`;
    try {
      const redactor = new Redactor([]);
      const { response, prepared } = await executeHttp({ method: 'GET', url, auth: { type: 'digest', username: 'vet', password: 's3cret' } }, { redactor });
      expect(response.status).toBe(200);
      expect(seen[0]).toBe('');
      expect(seen[1]).toMatch(/^Digest username="vet", realm="clinic"/);
      expect(JSON.stringify(prepared)).not.toContain('s3cret');
      expect(redactor.redactString(`Authorization: ${seen[1]}`)).not.toContain('response=');
      const bad = await executeHttp({ method: 'GET', url, auth: { type: 'digest', username: 'vet', password: 'wrong' } });
      expect(bad.response.status).toBe(401);
    } finally {
      server.close();
    }
  });
});

describe('import and export', () => {
  it('reads curl --digest and --aws-sigv4', () => {
    expect(parseCurl(`curl --digest -u vet:pw https://x/a`).auth).toEqual({ type: 'digest', username: 'vet', password: 'pw' });
    expect(parseCurl(`curl --aws-sigv4 "aws:amz:eu-west-1:execute-api" -u AK:SK -H "x-amz-security-token: T" https://x/a`).auth).toEqual({
      type: 'awsv4',
      accessKey: 'AK',
      secretKey: 'SK',
      region: 'eu-west-1',
      service: 'execute-api',
      sessionToken: 'T',
    });
  });

  it('round-trips through Postman collections', () => {
    const auth = { type: 'awsv4' as const, accessKey: '{{ak}}', secretKey: '{{sk}}', region: 'us-east-1', service: 's3' };
    const col = {
      schemaVersion: '1.0',
      id: 'c',
      name: 'AWS',
      variables: [],
      items: [
        { kind: 'request' as const, id: 'r1', name: 'S3', request: { method: 'GET', url: 'https://s3.amazonaws.com/', auth } },
        { kind: 'request' as const, id: 'r2', name: 'Digest', request: { method: 'GET', url: 'https://x/', auth: { type: 'digest' as const, username: 'u', password: '{{pw}}' } } },
      ],
    };
    const back = importAny(JSON.stringify(exportPostmanCollection(col as never).collection)).collection!;
    const reqs = back.items as Array<{ request: { auth: unknown } }>;
    expect(reqs[0]!.request.auth).toEqual(auth);
    expect(reqs[1]!.request.auth).toEqual({ type: 'digest', username: 'u', password: '{{pw}}' });
  });
});
