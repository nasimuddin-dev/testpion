/** The root certificate counts as trusted only when this very certificate is in the store, not another root of the same name. */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trustListHas } from '../../packages/core/src/debugger/certificate.js';

// two fixed roots of the same name (tests/fixtures/debugger-roots, valid until 2126): no keys are made on each run
const pem = (n: 'a' | 'b') => readFileSync(join(__dirname, '../fixtures/debugger-roots', `root-${n}.pem`), 'utf8');
const sha1 = (p: string) => createHash('sha1').update(Buffer.from(p.replace(/-----[^-]+-----|\s/g, ''), 'base64')).digest('hex');
/** The store listing certutil prints: the hash in groups of two. */
const listing = (p: string) => `Cert Hash(sha1): ${sha1(p).replace(/(..)/g, '$1 ').trim()}\n  Subject: CN=TestPion HTTP Debugger Root`;

describe('root certificate trust', () => {
  it('matches by hash: the old root of the same name is not the new one', () => {
    const a = pem('a');
    const b = pem('b');
    expect(a).not.toBe(b);
    expect(trustListHas(listing(a), a)).toBe(true);
    expect(trustListHas(listing(a), b)).toBe(false);
    expect(trustListHas(`${listing(a)}\n${listing(b)}`, b)).toBe(true);
  });

  it('reads the macOS listing too (colon-separated hash lines)', () => {
    const a = pem('a');
    expect(trustListHas(`SHA-1 hash: ${sha1(a).toUpperCase().replace(/(..)(?!$)/g, '$1:')}`, a)).toBe(true);
  });
});
