import { nodeRequire } from '../util/lazy-require.js';
import { createHash } from 'node:crypto';
import { execFileChecked } from '../net/process.js';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ApsError } from '../errors.js';
import { sha1Hex, sha256Hex } from '../util/hash.js';

// node-forge (800 KB) loads with the first certificate made or read, not at startup (see util/lazy-require.ts)
let forgeMod: typeof import('node-forge') | undefined;
const forge = (): typeof import('node-forge') => (forgeMod ??= typeof require === 'function' ? require('node-forge') : nodeRequire('node-forge'));

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

const NAME = 'TestPion HTTP Debugger Root';

/** The two hashes trust stores list a certificate by, lower-case hex without separators. */
const hashesOf = (certPem: string) => {
  const der = Buffer.from(forge().asn1.toDer(forge().pki.certificateToAsn1(forge().pki.certificateFromPem(certPem))).getBytes(), 'binary');
  return { sha1: sha1Hex(der), sha256: sha256Hex(der) };
};

/** One certificate of a `certutil -store` / `security find-certificate -Z` listing. */
export interface ListedCertificate {
  sha1?: string;
  sha256?: string;
  /** The listing says it is a root of the name TestPion gives its root. */
  ours: boolean;
}

const hexOf = (v: string) => v.replace(/[\s:]/g, '').toLowerCase();

/**
 * The certificates of a listing, read by their labelled lines: `Cert Hash(sha1):` / `Cert Hash(sha256):` (Windows certutil, one
 * block per certificate under a `==== Certificate N ====` line) and `SHA-1 hash:` / `SHA-256 hash:` (macOS security, a block
 * per `SHA-256 hash:` line). Nothing is matched by searching the text for a hash.
 */
export function parseTrustListing(listing: string): ListedCertificate[] {
  const blocks = listing.split(/^(?==+ .*Certificate.* =+\s*$)|^(?=SHA-256 hash:)/m);
  const out: ListedCertificate[] = [];
  for (const block of blocks) {
    const sha1 = /^\s*(?:Cert Hash\(sha1\)|SHA-1 hash):[ \t]*([0-9A-Fa-f :]+?)\s*$/m.exec(block)?.[1];
    const sha256 = /^\s*(?:Cert Hash\(sha256\)|SHA-256 hash):[ \t]*([0-9A-Fa-f :]+?)\s*$/m.exec(block)?.[1];
    if (!sha1 && !sha256) continue;
    out.push({ ...(sha1 ? { sha1: hexOf(sha1) } : {}), ...(sha256 ? { sha256: hexOf(sha256) } : {}), ours: block.includes(NAME) });
  }
  return out;
}

/** Is this very certificate (not another root of the same name, from an earlier install) in a `certutil` / `security` listing? Compared by SHA-1, else SHA-256. */
export const trustListHas = (listing: string, certPem: string) => {
  const h = hashesOf(certPem);
  return parseTrustListing(listing).some((c) => (c.sha1 ? c.sha1 === h.sha1 : c.sha256 === h.sha256));
};

const fingerprintOf = (certPem: string) => {
  const der = forge().asn1.toDer(forge().pki.certificateToAsn1(forge().pki.certificateFromPem(certPem))).getBytes();
  return createHash('sha256')
    .update(Buffer.from(der, 'binary'))
    .digest('hex')
    .toUpperCase()
    .replace(/(..)(?=.)/g, '$1:');
};

/** How long a new root is valid. Earlier versions made roots valid for ten years: those keep working (re-trusting would break trusted installs) and are reported as long-lived, with the advice to make a new one. */
export const ROOT_DAYS = 365;
/** A root valid longer than this (days) is a long-lived one of earlier versions. */
const LONG_LIVED_DAYS = 400;
/** The app shows a notice this many days before the root expires. */
export const RENEW_NOTICE_DAYS = 30;

/** Where the root stands: days left, whether it is one of the ten-year roots, whether it is time to renew. */
export function rootStanding(certPem: string): { daysLeft: number; longLived: boolean; renewSoon: boolean } {
  const c = forge().pki.certificateFromPem(certPem);
  const daysLeft = Math.floor((c.validity.notAfter.getTime() - Date.now()) / 86_400_000);
  const span = (c.validity.notAfter.getTime() - c.validity.notBefore.getTime()) / 86_400_000;
  return { daysLeft, longLived: span > LONG_LIVED_DAYS, renewSoon: daysLeft <= RENEW_NOTICE_DAYS };
}

/** Read the root certificate of this computer, or create it (RSA 2048, valid ROOT_DAYS; renewed when it has a day left). */
export function ensureRootCertificate(dir: string): RootCertificate {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ROOT_FILE);
  const keyPath = join(dir, KEY_FILE);
  if (existsSync(path) && existsSync(keyPath)) {
    const certPem = readFileSync(path, 'utf8');
    const cert = forge().pki.certificateFromPem(certPem);
    if (cert.validity.notAfter.getTime() > Date.now() + 24 * 3600_000)
      return { certPem, keyPem: readFileSync(keyPath, 'utf8'), fingerprint: fingerprintOf(certPem), notAfter: cert.validity.notAfter.toISOString(), path };
  }
  const keys = forge().pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge().pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + sha1Hex(String(Date.now())).slice(0, 30);
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600_000);
  cert.validity.notAfter = new Date(Date.now() + ROOT_DAYS * 24 * 3600_000);
  cert.setSubject(SUBJECT);
  cert.setIssuer(SUBJECT);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge().md.sha256.create());
  const certPem = forge().pki.certificateToPem(cert);
  const keyPem = forge().pki.privateKeyToPem(keys.privateKey);
  writeFileSync(path, certPem);
  writeFileSync(keyPath, keyPem, { mode: 0o600 });
  return { certPem, keyPem, fingerprint: fingerprintOf(certPem), notAfter: cert.validity.notAfter.toISOString(), path };
}

/** A fresh root (the old one stops working everywhere it was installed). */
export function regenerateRootCertificate(dir: string): RootCertificate {
  for (const f of [ROOT_FILE, KEY_FILE]) {
    const p = join(dir, f);
    rmSync(p, { force: true });
  }
  return ensureRootCertificate(dir);
}

/** Certificates for hosts, signed by the root; one key pair for all of them (fast), one certificate per host (cached). */
export function leafSigner(root: RootCertificate): (host: string) => LeafCertificate {
  const rootCert = forge().pki.certificateFromPem(root.certPem);
  const rootKey = forge().pki.privateKeyFromPem(root.keyPem);
  const keys = forge().pki.rsa.generateKeyPair({ bits: 2048 });
  const keyPem = forge().pki.privateKeyToPem(keys.privateKey);
  const cache = new Map<string, LeafCertificate>();
  return (host: string) => {
    const name = host.replace(/:\d+$/, '').toLowerCase();
    const hit = cache.get(name);
    if (hit) return hit;
    const cert = forge().pki.createCertificate();
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
    cert.sign(rootKey, forge().md.sha256.create());
    const leaf = { cert: forge().pki.certificateToPem(cert), key: keyPem };
    cache.set(name, leaf);
    if (cache.size > 2000) cache.clear();
    return leaf;
  };
}

type Run = (cmd: string, args: string[]) => Promise<string>;
const defaultRun: Run = (cmd, args) =>
  new Promise<string>((resolve, reject) => {
    execFileChecked(`certificate tool ${cmd}`, cmd, args, { timeout: 20_000, windowsHide: true }, (err, out, errOut) => (err ? reject(new Error(String(errOut || out || err.message).trim())) : resolve(String(out))));
  });
let hooks: { run?: Run; platform?: NodeJS.Platform } = {}; // bounded: one object; only tests set it
/** For tests: a scripted `run` (the certificate tool) and a platform. No argument restores. */
export function setCertificateTestHooks(h: typeof hooks = {}): void {
  hooks = h;
}
const run: Run = (cmd, args) => (hooks.run ?? defaultRun)(cmd, args);
const plat = () => hooks.platform ?? process.platform;
const keychain = () => `${process.env.HOME}/Library/Keychains/login.keychain-db`;
const nssDb = () => `sql:${process.env.HOME}/.pki/nssdb`;

/** How to trust the root here, for the UI when the one-click install is not possible. */
export function trustInstructions(path: string): string[] {
  const platform = plat();
  if (platform === 'win32')
    return [
      `certutil -user -addstore Root "${path}"`,
      'Or: double-click the file ▸ Install Certificate ▸ Current User ▸ Place in "Trusted Root Certification Authorities".',
      'Firefox: Settings ▸ Privacy & Security ▸ Certificates ▸ View ▸ Authorities ▸ Import (or enable security.enterprise_roots.enabled).',
    ];
  if (platform === 'darwin')
    return [
      `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${path}"`,
      'Or: open the file in Keychain Access ▸ login ▸ double-click it ▸ Trust ▸ Always Trust.',
      'Firefox: Settings ▸ Privacy & Security ▸ Certificates ▸ View ▸ Authorities ▸ Import.',
    ];
  return [
    `sudo cp "${path}" /usr/local/share/ca-certificates/testpion-root.crt && sudo update-ca-certificates`,
    `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "${NAME}" -i "${path}"   # Chrome / Chromium`,
    'Firefox: Settings ▸ Privacy & Security ▸ Certificates ▸ View ▸ Authorities ▸ Import.',
  ];
}

/** Roots of TestPion's name in a store that are not `root` itself: what an earlier install left, trusted but signing nothing the proxy makes. */
const otherRoots = (listing: string, root: RootCertificate) => {
  const mine = hashesOf(root.certPem);
  return parseTrustListing(listing).filter((c) => c.ours && c.sha1 && c.sha1 !== mine.sha1);
};

/**
 * Install the root into the user's trust store (no administrator rights: the current user's store). The new root is added
 * FIRST; only when that worked are other roots of the same name taken out, one by one by their hash, so a failed install
 * never leaves the computer with no TestPion root at all. Taking an old one out is best effort (`removedOld`, `leftOld`).
 */
export async function installRootCertificate(root: RootCertificate): Promise<{ where: string; removedOld: number; leftOld: number }> {
  const platform = plat();
  let removedOld = 0;
  let leftOld = 0;
  const sweep = async (list: () => Promise<string>, remove: (sha1: string) => Promise<unknown>) => {
    let old: ListedCertificate[] = [];
    try {
      old = otherRoots(await list(), root);
    } catch {
      return; // not listed: nothing is taken out
    }
    for (const c of old) {
      try {
        await remove(c.sha1!);
        removedOld++;
      } catch {
        leftOld++;
      }
    }
  };
  try {
    if (platform === 'win32') {
      await run('certutil', ['-user', '-addstore', 'Root', root.path]);
      await sweep(
        () => run('certutil', ['-user', '-store', 'Root']),
        (sha1) => run('certutil', ['-user', '-delstore', 'Root', sha1]),
      );
      return { where: 'the current user’s Trusted Root Certification Authorities (Windows, Chrome, Edge; Firefox needs its own import)', removedOld, leftOld };
    }
    if (platform === 'darwin') {
      await run('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', keychain(), root.path]);
      await sweep(
        () => run('security', ['find-certificate', '-a', '-Z', '-c', NAME, keychain()]),
        (sha1) => run('security', ['delete-certificate', '-Z', sha1, keychain()]),
      );
      return { where: 'the login keychain (Safari, Chrome; Firefox needs its own import)', removedOld, leftOld };
    }
    // NSS keeps one certificate per nickname: an older root of the name goes first, and only when it is not this one
    const present = await run('certutil', ['-d', nssDb(), '-L', '-n', NAME, '-a']).catch(() => undefined);
    if (present !== undefined && /-----BEGIN CERTIFICATE-----/.test(present)) {
      let same = false;
      try {
        same = hashesOf(present.slice(present.indexOf('-----BEGIN CERTIFICATE-----'))).sha1 === hashesOf(root.certPem).sha1;
      } catch {
        /* not readable: replaced */
      }
      if (same) return { where: 'the NSS database (Chrome / Chromium; the system store and Firefox need their own import)', removedOld, leftOld };
      await run('certutil', ['-d', nssDb(), '-D', '-n', NAME]);
      removedOld++;
    }
    await run('certutil', ['-d', nssDb(), '-A', '-t', 'C,,', '-n', NAME, '-i', root.path]);
    return { where: 'the NSS database (Chrome / Chromium; the system store and Firefox need their own import)', removedOld, leftOld };
  } catch (e) {
    throw new ApsError('ConfigurationError', `Could not install the root certificate: ${(e as Error).message}`, { suggestions: trustInstructions(root.path) });
  }
}

/** Remove the root from the user's trust store (this very certificate, by its hash, where the tool can; else by the name). */
export async function removeRootCertificate(root: RootCertificate): Promise<void> {
  const platform = plat();
  const sha1 = hashesOf(root.certPem).sha1;
  try {
    if (platform === 'win32') await run('certutil', ['-user', '-delstore', 'Root', sha1]);
    else if (platform === 'darwin') await run('security', ['delete-certificate', '-Z', sha1, keychain()]);
    else await run('certutil', ['-d', nssDb(), '-D', '-n', NAME]);
  } catch (e) {
    throw new ApsError('ConfigurationError', `Could not remove the root certificate: ${(e as Error).message}`, {
      suggestions: [`Remove "${NAME}" by hand from the trust store it was installed in.`],
    });
  }
}

/** Whether the computer trusts the root: `known` is false when the answer could not be had (Linux, a tool that failed), and then `trusted` is absent. */
export interface RootTrust {
  trusted?: boolean;
  known: boolean;
}

/**
 * Is the root in the user's trust store? Windows and macOS; elsewhere, and whenever the tool fails, unknown (never "no"
 * only because a command did not run). This very certificate counts, by hash; another root of the same name does not.
 */
export async function rootCertificateTrust(root: RootCertificate): Promise<RootTrust> {
  const platform = plat();
  try {
    if (platform === 'win32') return { trusted: trustListHas(await run('certutil', ['-user', '-store', 'Root']), root.certPem), known: true };
    if (platform === 'darwin') return { trusted: trustListHas(await run('security', ['find-certificate', '-a', '-Z', '-c', NAME, keychain()]), root.certPem), known: true };
  } catch (e) {
    // security exits with an error when the keychain has no certificate of that name: that is a plain "not trusted"
    if (platform === 'darwin' && /could not be found|item not found/i.test((e as Error).message)) return { trusted: false, known: true };
    return { known: false };
  }
  return { known: false };
}

/**
 * `rootCertificateTrust` with the answer kept for `ttlMs` (30 s) per certificate: the settings page asks on every open and a
 * `certutil -store` of a large store takes a second. `invalidate()` after an install, a removal or a new root.
 */
export function trustChecker(ttlMs = 30_000, now: () => number = Date.now): { check(root: RootCertificate): Promise<RootTrust>; invalidate(): void } {
  const cache = new Map<string, { at: number; value: RootTrust }>(); // bounded: one entry per root of this session (cleared on every change)
  return {
    async check(root) {
      const hit = cache.get(root.fingerprint);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      const value = await rootCertificateTrust(root);
      // an unknown answer (a tool that failed) is asked again next time
      if (value.known) {
        cache.clear();
        cache.set(root.fingerprint, { at: now(), value });
      }
      return value;
    },
    invalidate: () => cache.clear(),
  };
}
