import { describe, it, expect } from 'vitest';
import { exportPostmanCollection, oauth1BaseString, signOAuth1 } from '../../packages/core/src/index.js';
import { importAny } from '../helpers-import.js';

describe('OAuth 1.0a', () => {
  it('builds the RFC 5849 §3.4.1.1 signature base string', () => {
    const url = new URL('http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b');
    const base = oauth1BaseString(
      'POST',
      url,
      { oauth_consumer_key: '9djdj82h48djs9d2', oauth_token: 'kkk9d7dh3k39sjv7', oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: '137131201', oauth_nonce: '7d8f3e4a' },
      'c2&a3=2+q',
    );
    expect(base).toBe(
      'POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7',
    );
  });

  it("matches X (Twitter)'s documented example signature", () => {
    const h = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
    signOAuth1('POST', new URL('https://api.twitter.com/1.1/statuses/update.json?include_entities=true'), h, 'status=Hello%20Ladies%20%2b%20Gentlemen%2c%20a%20signed%20OAuth%20request%21', {
      consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
      consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
      token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
      timestamp: '1318622958',
      nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    });
    expect(h.get('authorization')).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
    expect(h.get('authorization')).toMatch(/^OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", /);
  });

  it('PLAINTEXT, query placement and Postman round trip', () => {
    const url = new URL('https://api.example.com/x');
    signOAuth1('GET', url, new Headers(), undefined, { consumerKey: 'ck', consumerSecret: 'c s', tokenSecret: 't', signatureMethod: 'PLAINTEXT', addTo: 'query' });
    expect(url.searchParams.get('oauth_signature')).toBe('c%20s&t');
    const auth = { type: 'oauth1' as const, consumerKey: '{{ck}}', consumerSecret: '{{cs}}', token: '{{t}}', tokenSecret: '{{ts}}', signatureMethod: 'HMAC-SHA256' as const };
    const col = { schemaVersion: '1.0', id: 'c', name: 'O', variables: [], items: [{ kind: 'http', id: 'r', name: 'R', request: { method: 'GET', url: 'https://x/', auth } }] };
    const back = importAny(JSON.stringify(exportPostmanCollection(col as never).collection)).collection!;
    expect((back.items[0] as { request: { auth: unknown } }).request.auth).toEqual(auth);
  });
});
