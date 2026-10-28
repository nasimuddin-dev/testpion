import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureRootCertificate,
  installRootCertificate,
  parseTrustListing,
  regenerateRootCertificate,
  removeRootCertificate,
  rootCertificateTrust,
  setCertificateTestHooks,
  trustChecker,
  type RootCertificate,
} from '../../packages/core/src/debugger/certificate.js';

// The root certificate: install adds the new root FIRST and then removes older roots of the name by hash; trust is a tri-state read
// from the labelled hash lines of certutil / security listings (never a substring search), cached for 30 s.

const hashes = (pem: string) => {
  const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  return { sha1: createHash('sha1').update(der).digest('hex'), sha256: createHash('sha256').update(der).digest('hex') };
};
const spaced = (hex: string) => hex.replace(/(..)/g, '$1 ').trim();
const upper = (hex: string) => hex.toUpperCase();

/** A `certutil -user -store Root` listing of these certificates, and one other root. */
const certutilListing = (pems: string[]) =>
  [
    'Root "Trusted Root Certification Authorities"',
    ...pems.map((pem, i) => {
      const h = hashes(pem);
      return `================ Certificate ${i} ================\nSerial Number: 0${i}\nIssuer: CN=TestPion HTTP Debugger Root, O=TestPion\n Subject: CN=TestPion HTTP Debugger Root, O=TestPion\nCert Hash(sha1): ${spaced(h.sha1)}\n`;
    }),
    '================ Certificate 9 ================\nSerial Number: 99\nIssuer: CN=Some Other Root\n Subject: CN=Some Other Root\nCert Hash(sha1): aa bb cc dd ee ff 00 11 22 33 44 55 66 77 88 99 aa bb cc dd\n',
    'CertUtil: -store command completed successfully.',
  ].join('\n');

/** A `security find-certificate -a -Z -c NAME` listing. */
const securityListing = (pems: string[]) =>
  pems
    .map((pem) => {
      const h = hashes(pem);
      return `SHA-256 hash: ${upper(h.sha256)}\nSHA-1 hash: ${upper(h.sha1)}\nkeychain: "/Users/x/Library/Keychains/login.keychain-db"\nattributes:\n    "labl"<blob>="TestPion HTTP Debugger Root"\n`;
    })
    .join('');

let dir: string;
let a: RootCertificate;
let b: RootCertificate;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tp-trust-'));
  a = ensureRootCertificate(dir);
  b = { ...regenerateRootCertificate(dir) }; // b is the current root, a the older one
  return () => rmSync(dir, { recursive: true, force: true });
});
afterEach(() => setCertificateTestHooks());

describe('parsing a trust listing', () => {
  it('reads certutil blocks (sha1 with spaces) and security blocks (SHA-1 and SHA-256, upper case)', () => {
    expect(parseTrustListing(certutilListing([a.certPem, b.certPem])).map((c) => [c.sha1, c.ours])).toEqual([
      [hashes(a.certPem).sha1, true],
      [hashes(b.certPem).sha1, true],
      ['aabbccddeeff00112233445566778899aabbccdd', false],
    ]);
    const mac = parseTrustListing(securityListing([a.certPem]));
    expect(mac).toEqual([{ sha1: hashes(a.certPem).sha1, sha256: hashes(a.certPem).sha256, ours: true }]);
  });

  it('a hash that only appears inside other text is not a certificate', () => {
    const text = `Some note mentioning ${hashes(b.certPem).sha1} in passing\nSubject: CN=TestPion HTTP Debugger Root`;
    expect(parseTrustListing(text)).toEqual([]);
  });
});

describe('is the root trusted: true, false, or not known', () => {
  it('Windows: this very certificate counts, an older root of the name does not', async () => {
    setCertificateTestHooks({ platform: 'win32', run: async () => certutilListing([a.certPem]) });
    expect(await rootCertificateTrust(b)).toEqual({ trusted: false, known: true });
    setCertificateTestHooks({ platform: 'win32', run: async () => certutilListing([a.certPem, b.certPem]) });
    expect(await rootCertificateTrust(b)).toEqual({ trusted: true, known: true });
  });

  it('macOS: SHA-1 or SHA-256 lines; "no such certificate" is a plain no', async () => {
    setCertificateTestHooks({ platform: 'darwin', run: async () => securityListing([b.certPem]) });
    expect(await rootCertificateTrust(b)).toEqual({ trusted: true, known: true });
    setCertificateTestHooks({
      platform: 'darwin',
      run: async () => {
        throw new Error('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.');
      },
    });
    expect(await rootCertificateTrust(b)).toEqual({ trusted: false, known: true });
  });

  it('a command that fails is "not known", never "no"; so is Linux', async () => {
    setCertificateTestHooks({
      platform: 'win32',
      run: async () => {
        throw new Error('certutil: access denied');
      },
    });
    expect(await rootCertificateTrust(b)).toEqual({ known: false });
    setCertificateTestHooks({ platform: 'linux', run: async () => '' });
    expect(await rootCertificateTrust(b)).toEqual({ known: false });
  });

  it('the answer is kept for 30 s per certificate and dropped by invalidate()', async () => {
    let asked = 0;
    let t = 1000;
    setCertificateTestHooks({
      platform: 'win32',
      run: async () => {
        asked++;
        return certutilListing([b.certPem]);
      },
    });
    const checker = trustChecker(30_000, () => t);
    await checker.check(b);
    await checker.check(b);
    expect(asked).toBe(1);
    t += 29_000;
    await checker.check(b);
    expect(asked).toBe(1);
    t += 2_000;
    await checker.check(b);
    expect(asked).toBe(2);
    checker.invalidate();
    await checker.check(b);
    expect(asked).toBe(3);
  });

  it('an unknown answer is not kept', async () => {
    let asked = 0;
    setCertificateTestHooks({
      platform: 'win32',
      run: async () => {
        asked++;
        throw new Error('busy');
      },
    });
    const checker = trustChecker();
    await checker.check(b);
    await checker.check(b);
    expect(asked).toBe(2);
  });
});

describe('install and remove', () => {
  it('Windows: adds the new root first, then removes the older roots of the name by their hash (not the new one)', async () => {
    const calls: string[] = [];
    setCertificateTestHooks({
      platform: 'win32',
      run: async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        return args.includes('-store') ? certutilListing([a.certPem, b.certPem]) : '';
      },
    });
    const r = await installRootCertificate(b);
    expect(calls[0]).toBe(`certutil -user -addstore Root ${b.path}`);
    expect(calls).toContain(`certutil -user -delstore Root ${hashes(a.certPem).sha1}`);
    expect(calls.some((c) => c.includes(hashes(b.certPem).sha1))).toBe(false);
    expect(calls.some((c) => c.endsWith('TestPion HTTP Debugger Root'))).toBe(false); // no longer "delete everything of that name"
    expect(r).toMatchObject({ removedOld: 1, leftOld: 0 });
  });

  it('a failed add leaves the older root alone (nothing was removed first)', async () => {
    const calls: string[] = [];
    setCertificateTestHooks({
      platform: 'win32',
      run: async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        if (args.includes('-addstore')) throw new Error('denied');
        return '';
      },
    });
    await expect(installRootCertificate(b)).rejects.toThrow(/Could not install the root certificate/);
    expect(calls).toHaveLength(1);
  });

  it('an older root that cannot be removed is reported, not fatal', async () => {
    setCertificateTestHooks({
      platform: 'win32',
      run: async (_cmd, args) => {
        if (args.includes('-delstore')) throw new Error('in use');
        return args.includes('-store') ? certutilListing([a.certPem, b.certPem]) : '';
      },
    });
    expect(await installRootCertificate(b)).toMatchObject({ removedOld: 0, leftOld: 1 });
  });

  it('macOS: add-trusted-cert first, then delete-certificate -Z <sha1> for the others', async () => {
    const calls: string[] = [];
    setCertificateTestHooks({
      platform: 'darwin',
      run: async (cmd, args) => {
        calls.push(`${cmd} ${args[0]} ${args[1] ?? ''}`);
        return args[0] === 'find-certificate' ? securityListing([a.certPem, b.certPem]) : '';
      },
    });
    process.env.HOME ??= '/home/x';
    await installRootCertificate(b);
    expect(calls[0]).toMatch(/^security add-trusted-cert/);
    expect(calls).toContain(`security delete-certificate -Z`);
  });

  it('Linux: an NSS root of the name is replaced only when it is a different certificate', async () => {
    const calls: string[] = [];
    let installed = a.certPem;
    setCertificateTestHooks({
      platform: 'linux',
      run: async (_cmd, args) => {
        calls.push(args.filter((x) => /^-[A-Za-z]$/.test(x)).join(' '));
        return args.includes('-L') ? installed : '';
      },
    });
    await installRootCertificate(b);
    expect(calls.join('|')).toMatch(/-L.*\|-d -D.*\|-d -A/);
    calls.length = 0;
    installed = b.certPem; // already this one
    await installRootCertificate(b);
    expect(calls.join('|')).not.toMatch(/-D|-A/);
  });

  it('remove names the certificate by hash on Windows and macOS', async () => {
    const calls: string[] = [];
    setCertificateTestHooks({ platform: 'win32', run: async (cmd, args) => (calls.push(`${cmd} ${args.join(' ')}`), '') });
    await removeRootCertificate(b);
    expect(calls[0]).toBe(`certutil -user -delstore Root ${hashes(b.certPem).sha1}`);
  });
});
