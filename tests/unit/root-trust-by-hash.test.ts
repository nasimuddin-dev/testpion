/** The root certificate counts as trusted only when this very certificate is in the store, not another root of the same name. */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureRootCertificate, regenerateRootCertificate, trustListHas } from '../../packages/core/src/debugger/certificate.js';

describe('root certificate trust', () => {
  it('matches by hash: the old root of the same name is not the new one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-root-'));
    try {
      const a = ensureRootCertificate(dir);
      const listing = (pem: string) => {
        const hex = createHash('sha1').update(Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64')).digest('hex');
        return `Cert Hash(sha1): ${hex.replace(/(..)/g, '$1 ').trim()}\n  Subject: CN=TestPion HTTP Debugger Root`;
      };
      expect(trustListHas(listing(a.certPem), a.certPem)).toBe(true);
      const b = regenerateRootCertificate(dir);
      expect(b.certPem).not.toBe(a.certPem);
      expect(trustListHas(listing(a.certPem), b.certPem)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
