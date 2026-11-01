/**
 * Endpoints that said they are going away (deprecationOf in @testpion/shared), seen per method and URL: every response (sent from the app,
 * a test run, a monitor or an agent) with a Deprecation, Sunset or Warning 299 header records it here, so the workspace can
 * list what to move away from (Needs attention, `testpion problems`). Kept in `runs/deprecations.json`: method, URL
 * without its query, the headers' dates and link, when last seen; at most one write per endpoint an hour unless it changed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeprecationInfo } from '@testpion/shared';
import { readJson } from './fsutil.js';
import type { WorkspaceStore } from './workspace.js';

export interface SeenDeprecation {
  method: string;
  /** The URL without its query string. */
  url: string;
  deprecation?: string | true;
  sunset?: string;
  link?: string;
  warning?: string;
  /** When a response last said so (ISO). */
  lastSeen: string;
}

const MAX = 500;
const cache = new WeakMap<WorkspaceStore, Map<string, SeenDeprecation>>();
const file = (store: WorkspaceStore) => store.path('runs', 'deprecations.json');
const keyOf = (method: string, url: string) => `${method.toUpperCase()} ${url}`;

function load(store: WorkspaceStore): Map<string, SeenDeprecation> {
  let m = cache.get(store);
  if (m) return m;
  m = new Map();
  try {
    for (const d of readJson<SeenDeprecation[]>(file(store), [])) if (d?.url && d.method) m.set(keyOf(d.method, d.url), d);
  } catch {
    /* unreadable: start over */
  }
  cache.set(store, m);
  return m;
}

/** Record what a response from `method url` said about its endpoint going away (nothing: nothing recorded). */
export function recordDeprecation(store: WorkspaceStore, method: string, url: string, info: DeprecationInfo | undefined, now = Date.now()): void {
  if (!info) return;
  let clean: string;
  try {
    const u = new URL(url);
    clean = `${u.origin}${u.pathname}`;
  } catch {
    return;
  }
  const m = load(store);
  const key = keyOf(method, clean);
  const prev = m.get(key);
  const same = prev && prev.sunset === info.sunset && prev.deprecation === info.deprecation && prev.link === info.link && prev.warning === info.warning;
  if (same && now - Date.parse(prev.lastSeen) < 3600_000) return;
  m.set(key, { method: method.toUpperCase(), url: clean, ...(info.deprecation !== undefined ? { deprecation: info.deprecation } : {}), ...(info.sunset ? { sunset: info.sunset } : {}), ...(info.link ? { link: info.link } : {}), ...(info.warning ? { warning: info.warning } : {}), lastSeen: new Date(now).toISOString() });
  if (m.size > MAX) {
    const oldest = [...m.entries()].sort((a, b) => a[1].lastSeen.localeCompare(b[1].lastSeen)).slice(0, m.size - MAX);
    for (const [k] of oldest) m.delete(k);
  }
  try {
    mkdirSync(dirname(file(store)), { recursive: true });
    writeFileSync(file(store), JSON.stringify([...m.values()], null, 1));
  } catch {
    /* read-only workspace: keep it in memory */
  }
}

/** Endpoints seen going away, the soonest sunset first (then by name), each with the days left to its sunset. */
export function listDeprecations(store: WorkspaceStore, now = Date.now()): Array<SeenDeprecation & { sunsetInDays?: number }> {
  return [...load(store).values()]
    .map((d) => ({ ...d, ...(d.sunset ? { sunsetInDays: Math.floor((Date.parse(d.sunset) - now) / 864e5) } : {}) }))
    .sort((a, b) => (a.sunsetInDays ?? Infinity) - (b.sunsetInDays ?? Infinity) || a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
}

/** Forget an endpoint (it was moved away from, or the server stopped saying so). */
export function forgetDeprecation(store: WorkspaceStore, method: string, url: string): boolean {
  const m = load(store);
  const ok = m.delete(keyOf(method, url));
  if (ok)
    try {
      writeFileSync(file(store), JSON.stringify([...m.values()], null, 1));
    } catch {
      /* in memory only */
    }
  return ok;
}
