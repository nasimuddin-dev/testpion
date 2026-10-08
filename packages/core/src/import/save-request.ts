import type { AuthConfig, Collection, CollectionFolder, CollectionNode, HttpRequestSpec, KeyValue, SavedHttpRequest } from '../model/types.js';
import { ApsError } from '../errors.js';
import { shortId } from '../util/ids.js';
import { matchCollection } from '../storage/env-edit.js';
import type { Redactor } from '../util/redact.js';
import { detectRequestSnippet, parseRequestSnippet } from './snippet.js';

/** A secret value that was replaced by a `{{variable}}` so it is not written to workspace files. */
export interface SecretPlaceholder {
  variable: string;
  /** Where it was: `header Authorization`, `auth token`, `cookie session`, `query api_key`, `body password` … */
  where: string;
}

const isTemplate = (v: string) => /^\s*\{\{[^}]+\}\}\s*$/.test(v);
/** `X-Api-Key` → `xApiKey`, `session_id` → `sessionId`. */
const varName = (s: string) => {
  const parts = s.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const name = parts.map((p, i) => (i ? p[0]!.toUpperCase() + p.slice(1) : p[0]!.toLowerCase() + p.slice(1))).join('');
  return /^[A-Za-z_]/.test(name) ? name : `v${name}`;
};

/**
 * Replace secret values in a request (sensitive headers, auth credentials, cookies, sensitive query
 * parameters and body fields) with `{{variables}}`, so the request can be saved to a collection
 * without writing secrets to disk. Returns the rewritten request and the variables to define
 * (as secret environment variables). Values that are already `{{templates}}` are kept.
 */
export function externalizeSecrets(spec: HttpRequestSpec, redactor: Redactor): { request: HttpRequestSpec; placeholders: SecretPlaceholder[] } {
  const placeholders: SecretPlaceholder[] = [];
  const used = new Set<string>();
  const take = (name: string, where: string) => {
    let v = varName(name) || 'secret';
    for (let i = 2; used.has(v); i++) v = `${varName(name)}${i}`;
    used.add(v);
    placeholders.push({ variable: v, where });
    return `{{${v}}}`;
  };
  const kv = (rows: KeyValue[] | undefined, where: string, sensitive: (k: string) => boolean) =>
    rows?.map((r) => (r.value && !isTemplate(r.value) && sensitive(r.key) ? { ...r, value: take(r.key, `${where} ${r.key}`) } : r));

  const request: HttpRequestSpec = { ...spec };
  request.headers = kv(spec.headers, 'header', (k) => redactor.isSensitiveKey(k));
  request.params = kv(spec.params, 'query', (k) => redactor.isSensitiveKey(k));
  // cookies copied from a browser are session credentials
  request.cookies = kv(spec.cookies, 'cookie', () => true);

  if (spec.auth) {
    const auth = { ...spec.auth } as Record<string, unknown>;
    for (const [k, v] of Object.entries(auth)) {
      if (k === 'type' || typeof v !== 'string' || !v || isTemplate(v)) continue;
      const secret = redactor.isSensitiveKey(k) || /token|password|secret/i.test(k) || (spec.auth.type === 'apiKey' && k === 'value');
      if (secret) auth[k] = take(k === 'value' ? 'apiKey' : k === 'token' ? 'accessToken' : k, `auth ${k}`);
    }
    request.auth = auth as AuthConfig;
  }

  const body = spec.body;
  if (body?.type === 'json') {
    try {
      const walk = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object')
          return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' && x && !isTemplate(x) && redactor.isSensitiveKey(k) ? take(k, `body ${k}`) : walk(x)]));
        return v;
      };
      request.body = { ...body, content: JSON.stringify(walk(JSON.parse(body.content)), null, 2) };
    } catch {
      /* not JSON after all: keep as is */
    }
  } else if (body?.type === 'form-urlencoded' || body?.type === 'multipart') {
    request.body = { ...body, fields: body.fields.map((f) => ((!('kind' in f) || f.kind !== 'file') && f.value && !isTemplate(f.value) && redactor.isSensitiveKey(f.key) ? { ...f, value: take(f.key, `body ${f.key}`) } : f)) } as typeof body;
  }
  return { request, placeholders };
}

/**
 * Add a request to a collection (found by id or name, created when `create` is set), inside a
 * folder path such as `Auth / Tokens` (folders are created as needed). Returns the updated collection
 * and the new request node; the caller saves the collection.
 */
export function addRequestToCollection(
  collections: Collection[],
  opts: { collection: string; folder?: string; name: string; request: HttpRequestSpec; description?: string; create?: boolean },
): { collection: Collection; node: SavedHttpRequest; created: boolean } {
  let col = matchCollection(collections, opts.collection);
  let created = false;
  if (!col) {
    if (!opts.create) throw new ApsError('ConfigurationError', `No collection "${opts.collection}". Available: ${collections.map((c) => c.name).join(', ') || 'none'} (set create to make a new one)`);
    col = { schemaVersion: '1.0', id: shortId('col-'), name: opts.collection.trim(), version: 0, variables: [], items: [], updatedAt: new Date().toISOString() } as Collection;
    created = true;
  }
  const next: Collection = structuredClone(col);
  let items: CollectionNode[] = next.items;
  for (const part of (opts.folder ?? '').split('/').map((p) => p.trim()).filter(Boolean)) {
    let f = items.find((n): n is CollectionFolder => n.kind === 'folder' && n.name.toLowerCase() === part.toLowerCase());
    if (!f) {
      f = { kind: 'folder', id: shortId('fld-'), name: part, items: [] };
      items.push(f);
    }
    items = f.items;
  }
  const node: SavedHttpRequest = { kind: 'http', id: shortId('req-'), name: opts.name.trim() || `${opts.request.method} ${opts.request.url}`, request: opts.request, ...(opts.description ? { description: opts.description } : {}) };
  items.push(node);
  return { collection: next, node, created };
}

/**
 * Import a copied cURL / fetch / PowerShell command as a saved request (CLI `testpion import` and the
 * Import dialog): secrets become `{{variables}}`, the request is named after its method and path.
 */
export function importRequestSnippet(
  collections: Collection[],
  text: string,
  redactor: Redactor,
  opts: { collection?: string; folder?: string; name?: string } = {},
): { format: string; collection: Collection; node: SavedHttpRequest; created: boolean; placeholders: SecretPlaceholder[] } {
  const format = detectRequestSnippet(text);
  if (!format) throw new ApsError('ValidationError', 'Not a cURL, fetch or PowerShell request');
  const parsed = parseRequestSnippet(text);
  const { request, placeholders } = externalizeSecrets(parsed, redactor);
  let path = parsed.url;
  try {
    path = new URL(parsed.url).pathname;
  } catch {
    /* keep the URL */
  }
  const r = addRequestToCollection(collections, { collection: opts.collection ?? 'Imported', create: true, folder: opts.folder, name: opts.name || `${parsed.method} ${path}`, request });
  return { format, ...r, placeholders };
}
