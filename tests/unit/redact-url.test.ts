import { describe, expect, it } from 'vitest';
import { Redactor } from '../../packages/core/src/util/redact.js';

/** The URL redaction reads the text where it can (the Debugger redacts thousands of URLs per sync): it must give what the URL parser gave. */
function viaParser(r: Redactor, url: string): string {
  try {
    const u = new URL(url);
    let changed = false;
    for (const k of [...u.searchParams.keys()]) {
      if (r.isSensitiveKey(k)) {
        u.searchParams.set(k, 'REDACTED');
        changed = true;
      }
    }
    if (u.password) {
      u.password = 'REDACTED';
      changed = true;
    }
    return r.redactString(changed ? u.toString() : url);
  } catch {
    return r.redactString(url);
  }
}

describe('Redactor.redactUrl', () => {
  const r = new Redactor();
  r.addSecret('s3cr3t-value');
  const urls = [
    'https://api.test/v1/items/1?page=2',
    'https://api.test/v1/items/1?page=2&token=abc',
    'https://api.test/v1/items/1?Token=abc&x=1',
    'https://api.test/?api_key=zzz#frag',
    'https://api.test/#frag?token=abc',
    'https://user:pw@api.test/x',
    'https://user@api.test/x?a=1',
    'https://api.test/x?a=1&to%6Ben=abc',
    'https://api.test/x?a+b=1&password=1',
    'https://api.test/x?s3cr3t-value=1&b=s3cr3t-value',
    'https://api.test/s3cr3t-value?x=1',
    'http://[::1]:8080/a?b=c',
    'not a url ?token=1',
    '/relative/path?token=1',
    'ws://h.test:99/sock?access_token=1&&&=x',
    'https://h.test?client_secret=1',
    'https://h.test/x?',
    'HTTPS://H.TEST/X?Authorization=a',
    '',
  ];
  for (const u of urls)
    it(`${JSON.stringify(u)} is what the parser gives`, () => {
      expect(r.redactUrl(u)).toBe(viaParser(r, u));
    });
  it('masks a sensitive key and leaves the others', () => {
    expect(r.redactUrl('https://api.test/x?page=1&token=abc')).toBe('https://api.test/x?page=1&token=REDACTED');
  });
});
