import type { Collection, CollectionFolder, SavedHttpRequest } from '../model/types.js';
import { shortId } from '../util/ids.js';
import { mapForeignAuth } from './foreign-auth.js';
import { normalizeTemplate } from './templates.js';
import { Findings, newDocument, type ImportDocument } from './model.js';
import { bodyFromMime, collectionOf, commented, kv, type Any } from './import-helpers.js';

/**
 * Hoppscotch collections as an import document: folders and requests, bodies, params, headers, auth. Its scripts (`pw.*`)
 * come over as comments: converting them is on the plan (planning/backlog.md B-23b).
 */
export function parseHoppscotch(text: string): ImportDocument {
  const d: Any = JSON.parse(text);
  const roots: Any[] = Array.isArray(d) ? d : [d];
  const findings = new Findings();
  const doc = newDocument('hoppscotch', text, { tool: 'Hoppscotch' });
  let commentedScripts = 0;
  const request = (r: Any): SavedHttpRequest => {
    const ct = r.body?.contentType ?? '';
    const body = typeof r.body?.body === 'string' ? bodyFromMime(ct, r.body.body, undefined) : Array.isArray(r.body?.body) ? bodyFromMime(ct, undefined, r.body.body.map((f: Any) => ({ name: f.key, value: f.value, disabled: f.active === false, type: f.isFile ? 'file' : 'text' }))) : undefined;
    const pre = commented('Hoppscotch', r.preRequestScript);
    const post = commented('Hoppscotch', r.testScript);
    if (pre || post) commentedScripts++;
    const headers = kv(r.headers, 'key', (x) => x.active !== false);
    const a = mapForeignAuth('hoppscotch', r.auth, r.name || r.endpoint);
    findings.notes(a.notes);
    headers.push(...a.headers);
    return {
      kind: 'http',
      id: shortId('req-'),
      name: r.name || r.endpoint,
      request: {
        method: String(r.method ?? 'GET').toUpperCase(),
        url: normalizeTemplate(r.endpoint),
        params: kv(r.params, 'key', (x) => x.active !== false),
        headers,
        body,
        auth: a.auth ?? { type: 'inherit' as const },
      },
      ...(pre ? { preRequestScript: pre } : {}),
      ...(post ? { testScript: post } : {}),
    };
  };
  const folder = (c: Any): CollectionFolder => {
    const a = mapForeignAuth('hoppscotch', c.auth, c.name ?? 'Folder');
    findings.notes(a.notes);
    return { kind: 'folder', id: shortId('fld-'), name: c.name ?? 'Folder', items: [...(c.folders ?? []).map(folder), ...(c.requests ?? []).map(request)], ...(a.auth ? { auth: a.auth } : {}) };
  };
  let collection: Collection;
  if (roots.length === 1) {
    const c = roots[0]!;
    const a = mapForeignAuth('hoppscotch', c.auth, c.name ?? 'Hoppscotch import');
    findings.notes(a.notes);
    collection = collectionOf(c.name ?? 'Hoppscotch import', [...(c.folders ?? []).map(folder), ...(c.requests ?? []).map(request)], { ...(a.auth ? { auth: a.auth } : {}) });
  } else collection = collectionOf('Hoppscotch import', roots.map(folder));
  if (commentedScripts) findings.add({ code: 'SCRIPT_API', severity: 'changed', where: [], message: `${commentedScripts} request${commentedScripts > 1 ? 's have' : ' has'} Hoppscotch scripts (pw.*): kept as comments, rewrite them with tp.* to run them` });
  doc.collections.push(collection);
  doc.findings.push(...findings.list);
  return doc;
}

export function importHoppscotch(text: string): { collection: Collection; notes: string[] } {
  const doc = parseHoppscotch(text);
  return { collection: doc.collections[0]!, notes: doc.findings.map((f) => f.message) };
}
