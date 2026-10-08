/**
 * TLS certificates seen per host: every HTTPS response (sent from the app, a test run, a monitor or an agent) records
 * the server's certificate here, so the workspace can list which ones expire soon. Kept in `runs/certificates.json`
 * (names and dates only), at most one write per host an hour unless the certificate changed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WorkspaceStore } from './workspace.js';
import { readJson } from './fsutil.js';

export interface SeenCertificate {
  /** host[:port] */
  host: string;
  subject?: string;
  issuer?: string;
  validTo?: string;
  altNames?: string[];
  /** When a response last came with it (ISO). */
  lastSeen: string;
}

const MAX_HOSTS = 500;
const cache = new WeakMap<WorkspaceStore, Map<string, SeenCertificate>>();
const file = (store: WorkspaceStore) => store.path('runs', 'certificates.json');

function load(store: WorkspaceStore): Map<string, SeenCertificate> {
  let m = cache.get(store);
  if (m) return m;
  m = new Map();
  try {
    for (const c of readJson<SeenCertificate[]>(file(store), [])) if (c?.host) m.set(c.host, c);
  } catch {
    /* unreadable: start over */
  }
  cache.set(store, m);
  return m;
}

/** Record the certificate a response from `url` came with. */
export function recordCertificate(store: WorkspaceStore, url: string, c: { subject?: string; issuer?: string; validTo?: string; altNames?: string[] } | undefined, now = Date.now()): void {
  if (!c?.validTo) return;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  const m = load(store);
  const prev = m.get(host);
  if (prev && prev.validTo === c.validTo && now - Date.parse(prev.lastSeen) < 3600_000) return;
  m.set(host, { host, subject: c.subject, issuer: c.issuer, validTo: c.validTo, altNames: c.altNames?.slice(0, 10), lastSeen: new Date(now).toISOString() });
  if (m.size > MAX_HOSTS) {
    const oldest = [...m.values()].sort((a, b) => a.lastSeen.localeCompare(b.lastSeen)).slice(0, m.size - MAX_HOSTS);
    for (const o of oldest) m.delete(o.host);
  }
  try {
    mkdirSync(dirname(file(store)), { recursive: true });
    writeFileSync(file(store), JSON.stringify([...m.values()], null, 1));
  } catch {
    /* read-only workspace: keep it in memory */
  }
}

/** Certificates seen, soonest to expire first, with the days left. */
export function listCertificates(store: WorkspaceStore, now = Date.now()): Array<SeenCertificate & { daysLeft?: number }> {
  return [...load(store).values()]
    .map((c) => ({ ...c, daysLeft: c.validTo ? Math.floor((Date.parse(c.validTo) - now) / 864e5) : undefined }))
    .sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || a.host.localeCompare(b.host));
}
