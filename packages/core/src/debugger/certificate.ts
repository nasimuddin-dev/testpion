import forge from 'node-forge';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ApsError } from '../errors.js';

/**
 * The HTTP Debugger's root certificate (planning/http-debugger.md, DBG-4): created on this computer, kept in the data
 * folder, never leaves it. Programs that trust it let the proxy decrypt their HTTPS: for every host the proxy signs a
 * certificate of its own with this root (cached), so the program talks TLS to TestPion and TestPion talks TLS to the
 * server. Installing it into the user's trust store is one command per platform; removing it is another.
 */
export interface RootCertificate {
  certPem: string;
  keyPem: string;
  /** SHA-256 of the DER certificate, as trust stores show it. */
  fingerprint: string;
  notAfter: string;
  path: string;
}

/** Where the CLI and the MCP server keep the root (the desktop app keeps its own in its data folder). */
export const debuggerCertDir = () => process.env.TESTPION_DEBUGGER_CERTS || join(homedir(), '.testpion', 'debugger');

export interface LeafCertificate {
  cert: string;
  key: string;
}

const ROOT_FILE = 'testpion-root.pem';
const KEY_FILE = 'testpion-root.key';
const SUBJECT = [
  { name: 'commonName', value: 'TestPion HTTP Debugger Root' },
  { name: 'organizationName', value: 'TestPion' },
];

const fingerprintOf = (certPem: string) => {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(certPem))).getBytes();
  return createHash('sha256')
    .update(Buffer.from(der, 'binary'))
    .digest('hex')
    .toUpperCase()
    .replace(/(..)(?=.)/g, '$1:');
};

/** Read the root certificate of this computer, or create it (RSA 2048, ten years). */
export function ensureRootCertificate(dir: string): RootCertificate {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ROOT_FILE);
  const keyPath = join(dir, KEY_FILE);
  if (existsSync(path) && existsSync(keyPath)) {
    const certPem = readFileSync(path, 'utf8');
    const cert = forge.pki.certificateFromPem(certPem);
    if (cert.validity.notAfter.getTime() > Date.now() + 24 * 3600_000)
      return { certPem, keyPem: readFileSync(keyPath, 'utf8'), fingerprint: fingerprintOf(certPem), notAfter: cert.validity.notAfter.toISOString(), path };
  }
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 30);
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600_000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600_000);
  cert.setSubject(SUBJECT);
  cert.setIssuer(SUBJECT);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  writeFileSync(path, certPem);
  writeFileSync(keyPath, keyPem, { mode: 0o600 });
  return { certPem, keyPem, fingerprint: fingerprintOf(certPem), notAfter: cert.validity.notAfter.toISOString(), path };
}

/** A fresh root (the old one stops working everywhere it was installed). */
export function regenerateRootCertificate(dir: string): RootCertificate {
  for (const f of [ROOT_FILE, KEY_FILE]) {
    const p = join(dir, f);
    if (existsSync(p)) writeFileSync(p, '');
  }
  return ensureRootCertificate(dir);
}

/** Certificates for hosts, signed by the root; one key pair for all of them (fast), one certificate per host (cached). */
export function leafSigner(root: RootCertificate): (host: string) => LeafCertificate {
  const rootCert = forge.pki.certificateFromPem(root.certPem);
  const rootKey = forge.pki.privateKeyFromPem(root.keyPem);
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const cache = new Map<string, LeafCertificate>();
  return (host: string) => {
    const name = host.replace(/:\d+$/, '').toLowerCase();
    const hit = cache.get(name);
    if (hit) return hit;
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber =
      '02' +
      createHash('sha1')
        .update(name + Date.now())
        .digest('hex')
        .slice(0, 30);
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600_000);
    cert.validity.notAfter = new Date(Date.now() + 398 * 24 * 3600_000);
    cert.setSubject([{ name: 'commonName', value: name }]);
    cert.setIssuer(rootCert.subject.attributes);
    const ip = /^\d+\.\d+\.\d+\.\d+$/.test(name) || name.includes(':');
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: ip ? [{ type: 7, ip: name }] : [{ type: 2, value: name }, ...(name.split('.').length > 2 ? [] : [{ type: 2, value: `*.${name}` }])] },
      // the root's key identifier, so verifiers match the chain (forge's `true` would use the leaf's own key)
      { name: 'authorityKeyIdentifier', keyIdentifier: rootCert.generateSubjectKeyIdentifier().getBytes() },
    ]);
    cert.sign(rootKey, forge.md.sha256.create());
    const leaf = { cert: forge.pki.certificateToPem(cert), key: keyPem };
    cache.set(name, leaf);
    if (cache.size > 2000) cache.clear();
    return leaf;
  };
}

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { timeout: 20_000, windowsHide: true }, (err, out, errOut) => (err ? reject(new Error(String(errOut || out || err.message).trim())) : resolve(String(out))));
  });

/** How to trust the root here, for the UI when the one-click install is not possible. */
export function trustInstructions(path: string): string[] {
  if (process.platform === 'win32')
    return [
      `certutil -user -addstore Root "${path}"`,
      'Or: double-click the file ▸ Install Certificate ▸ Current User ▸ Place in "Trusted Root Certification Authorities".',
      'Firefox: Settings ▸ Privacy & Security ▸ Certificates ▸ View ▸ Authorities ▸ Import (or enable security.enterprise_roots.enabled).',
    ];
  if (process.platform === 'darwin')
    return [
      `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${path}"`,
      'Or: open the file in Keychain Access ▸ login ▸ double-click it ▸ Trust ▸ Always Trust.',
      'Firefox: Settings ▸ Privacy & Security ▸ Certificates ▸ View ▸ Authorities ▸ Import.',
    ];
  return [
    `sudo cp "${path}" /usr/local/share/ca-certificates/testpion-root.crt && sudo update-ca-certificates`,
    `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "TestPion HTTP Debugger Root" -i "${path}"   # Chrome / Chromium`,
    'Firefox: Settings ▸ Privacy & Security ▸ Certificates ▸ View ▸ Authorities ▸ Import.',
  ];
}

/** Install the root into the user's trust store (no administrator rights: the current user's store). */
export async function installRootCertificate(root: RootCertificate): Promise<{ where: string }> {
  try {
    if (process.platform === 'win32') {
      await run('certutil', ['-user', '-addstore', 'Root', root.path]);
      return { where: 'the current user’s Trusted Root Certification Authorities (Windows, Chrome, Edge; Firefox needs its own import)' };
    }
    if (process.platform === 'darwin') {
      await run('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', `${process.env.HOME}/Library/Keychains/login.keychain-db`, root.path]);
      return { where: 'the login keychain (Safari, Chrome; Firefox needs its own import)' };
    }
    await run('certutil', ['-d', `sql:${process.env.HOME}/.pki/nssdb`, '-A', '-t', 'C,,', '-n', 'TestPion HTTP Debugger Root', '-i', root.path]);
    return { where: 'the NSS database (Chrome / Chromium; the system store and Firefox need their own import)' };
  } catch (e) {
    throw new ApsError('ConfigurationError', `Could not install the root certificate: ${(e as Error).message}`, { suggestions: trustInstructions(root.path) });
  }
}

/** Remove the root from the user's trust store. */
export async function removeRootCertificate(root: RootCertificate): Promise<void> {
  try {
    if (process.platform === 'win32') await run('certutil', ['-user', '-delstore', 'Root', 'TestPion HTTP Debugger Root']);
    else if (process.platform === 'darwin') await run('security', ['delete-certificate', '-c', 'TestPion HTTP Debugger Root', `${process.env.HOME}/Library/Keychains/login.keychain-db`]);
    else await run('certutil', ['-d', `sql:${process.env.HOME}/.pki/nssdb`, '-D', '-n', 'TestPion HTTP Debugger Root']);
  } catch (e) {
    throw new ApsError('ConfigurationError', `Could not remove the root certificate: ${(e as Error).message}`, {
      suggestions: ['Remove "TestPion HTTP Debugger Root" by hand from the trust store it was installed in.'],
    });
  }
}

/** Is the root in the user's trust store? Best effort (Windows and macOS; elsewhere unknown). */
export async function rootCertificateTrusted(root: RootCertificate): Promise<boolean | undefined> {
  try {
    if (process.platform === 'win32') return /TestPion HTTP Debugger Root/.test(await run('certutil', ['-user', '-store', 'Root']));
    if (process.platform === 'darwin')
      return /TestPion HTTP Debugger Root/.test(await run('security', ['find-certificate', '-c', 'TestPion HTTP Debugger Root', `${process.env.HOME}/Library/Keychains/login.keychain-db`]));
  } catch {
    return false;
  }
  return undefined;
}
