import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { ROOT_DAYS, ensureRootCertificate, regenerateRootCertificate, rootStanding } from '../../packages/core/src/desktop.js';

const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'tp-root-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('the Debugger root certificate', () => {
  it('lasts one year, can sign only host certificates, and reports where it stands', () => {
    const d = dir();
    const root = ensureRootCertificate(d);
    const c = forge.pki.certificateFromPem(root.certPem);
    const days = (c.validity.notAfter.getTime() - c.validity.notBefore.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(ROOT_DAYS - 1);
    expect(days).toBeLessThan(ROOT_DAYS + 3);
    const bc = c.getExtension('basicConstraints') as { cA: boolean; pathLenConstraint?: number };
    expect(bc.cA).toBe(true);
    expect(bc.pathLenConstraint).toBe(0);
    const s = rootStanding(root.certPem);
    expect(s).toMatchObject({ longLived: false, renewSoon: false });
    expect(s.daysLeft).toBeGreaterThan(300);
  }, 60_000);

  it('a ten-year root of an earlier version keeps working and is reported as long-lived; regenerating replaces it', () => {
    const d = dir();
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const c = forge.pki.createCertificate();
    c.publicKey = keys.publicKey;
    c.serialNumber = '01aa';
    c.validity.notBefore = new Date(Date.now() - 86_400_000);
    c.validity.notAfter = new Date(Date.now() + 10 * 365 * 86_400_000);
    const subject = [{ name: 'commonName', value: 'TestPion HTTP Debugger Root' }];
    c.setSubject(subject);
    c.setIssuer(subject);
    c.setExtensions([{ name: 'basicConstraints', cA: true, critical: true }]);
    c.sign(keys.privateKey, forge.md.sha256.create());
    const certPem = forge.pki.certificateToPem(c);
    writeFileSync(join(d, 'testpion-root.pem'), certPem);
    writeFileSync(join(d, 'testpion-root.key'), forge.pki.privateKeyToPem(keys.privateKey));
    const kept = ensureRootCertificate(d);
    expect(kept.fingerprint).toBe(ensureRootCertificate(d).fingerprint);
    expect(kept.certPem).toBe(certPem); // not replaced: what is trusted stays trusted
    expect(rootStanding(kept.certPem).longLived).toBe(true);
    const fresh = regenerateRootCertificate(d);
    expect(fresh.fingerprint).not.toBe(kept.fingerprint);
    expect(rootStanding(fresh.certPem).longLived).toBe(false);
  }, 90_000);
});
