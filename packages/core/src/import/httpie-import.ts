import type { BodyConfig, Collection, CollectionFolder, CollectionNode, KeyValue, SavedGraphQLRequest, SavedHttpRequest } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';
import { mapMoreAuth } from './foreign-auth-more.js';
import { normalizeTemplate } from './templates.js';
import { Findings, newDocument, type ImportDocument } from './model.js';
import { collectionOf, type Any } from './import-helpers.js';

/**
 * HTTPie for Desktop (and the web app) as an import document: its collection and environment exports
 * (`meta.format: "httpie"`, `entry` with `requests`, nested `collections`, `auth`, `docs`; https://httpie.io/r/export-docs).
 * Requests with query and path parameters, headers, bodies (text with its format, form and multipart, GraphQL, file),
 * auth, nested collections as folders, docs, and environments. Cookies sent by a request and the request `docs` come over
 * as far as the model has a place for them; a body read from a file path is a binary body.
 */

export function isHttpie(d: Any): boolean {
  return String(d.meta?.format ?? '').toLowerCase() === 'httpie' && !!d.entry && typeof d.entry === 'object';
}

export function parseHttpie(text: string): ImportDocument {
  const d: Any = JSON.parse(text);
  const e: Any = d.entry;
  const findings = new Findings();
  const doc = newDocument('httpie', text, { tool: 'HTTPie', ...(d.meta?.version ? { version: String(d.meta.version) } : {}) });
  const n = (s: unknown) => normalizeTemplate(s);
  const kv = (list: unknown): KeyValue[] => (Array.isArray(list) ? list : []).filter((x: Any) => x?.name).map((x: Any) => ({ key: n(x.name), value: n(x.value ?? ''), enabled: x.enabled !== false }));

  // ---- an environment export
  if (String(d.meta?.contentType ?? '') === 'environment' || (e.variables && !e.requests && !e.collections)) {
    const name = String(e.name ?? 'HTTPie environment');
    const vars = e.variables;
    const variables: KeyValue[] = Array.isArray(vars)
      ? kv(vars)
      : Object.entries((vars && typeof vars === 'object' ? vars : {}) as Any).map(([key, v]) => ({ key, value: n(typeof v === 'object' && v ? (v as Any).value ?? '' : v ?? ''), enabled: !(typeof v === 'object' && v && (v as Any).enabled === false) }));
    doc.environments.push({ id: slugify(name) || 'httpie', name, variables });
    doc.findings.push(...findings.list);
    return doc;
  }

  const authOf = (raw: unknown, where: string, headers?: KeyValue[]) => {
    const a = mapMoreAuth('httpie', raw, where, n);
    findings.notes(a.notes);
    headers?.push(...a.headers);
    return a.auth;
  };

  const body = (b: Any | undefined, name: string): BodyConfig | undefined => {
    if (!b || typeof b !== 'object') return undefined;
    if (b.text && typeof b.text === 'object') {
      const fmt = String(b.text.format ?? '').toLowerCase();
      const value = String(b.text.value ?? '');
      if (!value) return undefined;
      return { type: fmt === 'json' ? 'json' : fmt === 'xml' ? 'xml' : fmt === 'html' ? 'html' : 'text', content: n(value) };
    }
    if (b.form && typeof b.form === 'object') {
      const fields: Any[] = Array.isArray(b.form.fields) ? b.form.fields : [];
      if (b.form.isMultipart)
        return {
          type: 'multipart',
          fields: fields
            .filter((f) => f?.name)
            .map((f) => {
              const file = Array.isArray(f.values) ? f.values.find((v: Any) => v?.file || v?.path || v?.name) : undefined;
              const isFile = f.type === 'file' || !!file;
              return { key: n(f.name), value: isFile ? String(file?.path ?? file?.file ?? file?.name ?? f.value ?? '') : n(Array.isArray(f.values) ? f.values[0]?.value ?? f.values[0] ?? '' : f.value ?? ''), kind: isFile ? ('file' as const) : ('text' as const), enabled: f.enabled !== false };
            }),
        };
      return { type: 'form-urlencoded', fields: fields.filter((f) => f?.name).map((f) => ({ key: n(f.name), value: n(Array.isArray(f.values) ? f.values[0]?.value ?? f.values[0] ?? '' : f.value ?? ''), enabled: f.enabled !== false })) };
    }
    if (b.file && typeof b.file === 'object') {
      const p = String(b.file.path ?? b.file.name ?? '');
      if (p) return { type: 'binary', filePath: p };
      findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [name], field: 'body', message: `"${name}": the body is a file that the export does not name: choose it again` });
    }
    return undefined;
  };

  const request = (r: Any): SavedHttpRequest | SavedGraphQLRequest => {
    const name = String(r.name || r.url || 'Request');
    const headers = kv(r.headers);
    const auth = authOf(r.auth, name, headers) ?? { type: 'inherit' as const };
    const cookies = kv(r.cookies);
    if (r.body?.graphql && typeof r.body.graphql === 'object') {
      const g: Any = r.body.graphql;
      return { kind: 'graphql', id: shortId('gql-'), name, request: { endpoint: n(r.url), query: n(g.query ?? ''), ...(typeof g.variables === 'string' && g.variables.trim() ? { variables: n(g.variables) } : {}), headers, auth } };
    }
    const pathParams = kv(r.pathParams);
    return {
      kind: 'http',
      id: shortId('req-'),
      name,
      ...(r.docs ? { description: String(r.docs) } : {}),
      request: {
        method: String(r.method ?? 'GET').toUpperCase(),
        url: n(String(r.url ?? '').replace(/\?.*$/, '')),
        params: kv(r.queryParams),
        ...(pathParams.length ? { pathVariables: pathParams.map((p) => ({ key: p.key, value: p.value })) } : {}),
        headers,
        ...(cookies.length ? { cookies } : {}),
        body: body(r.body, name),
        auth,
      },
    };
  };

  const folder = (c: Any): CollectionFolder => {
    const name = String(c.name ?? 'Folder');
    const auth = authOf(c.auth, name);
    return { kind: 'folder', id: shortId('fld-'), name, items: items(c), ...(c.docs ? { description: String(c.docs) } : {}), ...(auth ? { auth } : {}) };
  };
  const items = (c: Any): CollectionNode[] => [...(Array.isArray(c.collections) ? c.collections : []).map(folder), ...(Array.isArray(c.requests) ? c.requests : []).map(request)];
  const name = String(e.name ?? 'HTTPie import');
  const rootAuth = authOf(e.auth, name);
  const collection: Collection = collectionOf(name, items(e), { ...(e.docs ? { description: String(e.docs) } : {}), ...(rootAuth ? { auth: rootAuth } : {}) });
  doc.collections.push(collection);
  doc.findings.push(...findings.list);
  return doc;
}
