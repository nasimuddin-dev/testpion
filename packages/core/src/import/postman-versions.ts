import { parseYaml } from '../util/lazy-yaml.js';
import { Findings, type ImportDocument } from './model.js';
import { parsePostman } from './postman-import.js';
import type { Any } from './import-helpers.js';

/**
 * The Postman collection formats beside v2.0 / v2.1: **v1** (the first export format: `requests` + `order` + `folders`,
 * headers as one string, `dataMode`) and **v3** (the file-based format Postman's Git integration writes: a folder with
 * one `*.request.yaml` per request, `definition.yaml` for the collection and its folders, `.resources/` beside them).
 * Both are rewritten as a v2.1 collection and read by the one Postman importer, so auth, settings, scripts and examples
 * map the same way; what the rewrite cannot carry becomes a finding.
 */

const V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/* ------------------------------------------------------------------ v1 */

export function isPostmanV1(d: Any): boolean {
  return !d.info && Array.isArray(d.requests) && Array.isArray(d.order) && d.requests.every((r: Any) => r && typeof r === 'object' && 'id' in r && ('method' in r || 'url' in r));
}

/** v1 `currentHelper` / `helperAttributes` → a v2.1 auth object (undefined: none). */
function v1Auth(r: Any): Any | undefined {
  const h = String(r.currentHelper ?? '');
  const a: Any = r.helperAttributes ?? {};
  const list = (o: Any) => Object.entries(o).filter(([k]) => k !== 'id').map(([key, value]) => ({ key, value, type: 'string' }));
  if (!h || h === 'normal') return undefined;
  if (h === 'basicAuth') return { type: 'basic', basic: list({ username: a.username, password: a.password }) };
  if (h === 'digestAuth') return { type: 'digest', digest: list({ username: a.username, password: a.password, realm: a.realm, nonce: a.nonce, algorithm: a.algorithm, qop: a.qop, opaque: a.opaque }) };
  if (h === 'oAuth1') return { type: 'oauth1', oauth1: list({ consumerKey: a.consumerKey, consumerSecret: a.consumerSecret, token: a.token, tokenSecret: a.tokenSecret, signatureMethod: a.signatureMethod, realm: a.realm }) };
  if (h === 'bearerToken') return { type: 'bearer', bearer: list({ token: a.token }) };
  // the OAuth 2 helper only added the stored access token to the request
  if (h === 'oAuth2') return a.accessToken ? { type: 'bearer', bearer: list({ token: a.accessToken }) } : undefined;
  if (h === 'hawkAuth') return { type: 'hawk', hawk: list({ authId: a.hawk_id ?? a.id, authKey: a.hawk_key ?? a.key, algorithm: a.algorithm }) };
  if (h === 'awsSigV4') return { type: 'awsv4', awsv4: list({ accessKey: a.accessKey, secretKey: a.secretKey, region: a.region, service: a.service, sessionToken: a.sessionToken }) };
  // hawk, oAuth2 helpers and anything else: the Postman importer reports an unknown type
  return { type: h.replace(/Auth$/, '').toLowerCase() };
}

/** A v1 collection as a v2.1 collection object. */
export function postmanV1ToV21(d: Any): Any {
  const reqs = new Map<string, Any>((d.requests as Any[]).map((r) => [String(r.id), r]));
  const item = (r: Any): Any => {
    const raw = String(r.url ?? '');
    const qs = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
    const query = qs ? qs.split('&').filter(Boolean).map((p) => ({ key: decodeURIComponent(p.split('=')[0] ?? ''), value: decodeURIComponent(p.includes('=') ? p.slice(p.indexOf('=') + 1) : '') })) : [];
    const headers = typeof r.headers === 'string' ? r.headers.split(/\r?\n/).filter((l: string) => l.includes(':')).map((l: string) => ({ key: l.slice(0, l.indexOf(':')).trim(), value: l.slice(l.indexOf(':') + 1).trim() })) : [];
    const data = Array.isArray(r.data) ? r.data : [];
    let body: Any | undefined;
    if (r.dataMode === 'raw') body = { mode: 'raw', raw: String(r.rawModeData ?? '') };
    else if (r.dataMode === 'urlencoded') body = { mode: 'urlencoded', urlencoded: data.map((f: Any) => ({ key: f.key, value: f.value })) };
    else if (r.dataMode === 'params') body = { mode: 'formdata', formdata: data.map((f: Any) => ({ key: f.key, value: f.value, type: f.type === 'file' ? 'file' : 'text' })) };
    else if (r.dataMode === 'binary') body = { mode: 'file', file: { src: '' } };
    const auth = v1Auth(r);
    const events: Any[] = [];
    if (r.preRequestScript) events.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: String(r.preRequestScript).split('\n') } });
    if (r.tests) events.push({ listen: 'test', script: { type: 'text/javascript', exec: String(r.tests).split('\n') } });
    return {
      name: r.name,
      request: { method: r.method ?? 'GET', url: query.length ? { raw, query } : raw, header: headers, ...(body ? { body } : {}), ...(auth ? { auth } : {}), ...(r.description ? { description: r.description } : {}) },
      ...(events.length ? { event: events } : {}),
      response: (Array.isArray(r.responses) ? r.responses : []).map((x: Any) => ({ name: x.name, code: x.responseCode?.code ?? x.code, status: x.responseCode?.name ?? x.status, header: x.headers ?? x.header, body: x.text ?? x.body })),
    };
  };
  const placed = new Set<string>();
  const byOrder = (ids: unknown): Any[] =>
    (Array.isArray(ids) ? ids : []).flatMap((id) => {
      const r = reqs.get(String(id));
      if (!r) return [];
      placed.add(String(id));
      return [item(r)];
    });
  const folders: Any[] = Array.isArray(d.folders) ? d.folders : [];
  const folderOrder: unknown[] = Array.isArray(d.folders_order) ? d.folders_order : folders.map((f) => f.id);
  const folderItems = folderOrder.flatMap((id) => {
    const f = folders.find((x) => String(x.id) === String(id));
    return f ? [{ name: f.name, ...(f.description ? { description: f.description } : {}), item: byOrder(f.order) }] : [];
  });
  const rest = byOrder(d.order);
  // requests that no order lists (a damaged export): kept at the end
  const loose = [...reqs.values()].filter((r) => !placed.has(String(r.id))).map(item);
  return { info: { name: d.name ?? 'Postman v1 import', _postman_id: d.id, schema: V21, ...(d.description ? { description: d.description } : {}) }, item: [...folderItems, ...rest, ...loose] };
}

export function parsePostmanV1(text: string): ImportDocument {
  const doc = parsePostman(JSON.stringify(postmanV1ToV21(JSON.parse(text))));
  doc.version = '1';
  doc.findings.unshift({ code: 'NOTE', severity: 'info', where: [], message: 'A Postman collection v1 file (the first export format): it was converted to the current structure. Re-export it from Postman as v2.1 if you still have the app', reportOnly: true });
  return doc;
}

/* ------------------------------------------------------------------ v3 */

interface V3File {
  path: string;
  text: string;
}

/** The marker of a v3 bundle (the files of a collection folder, assembled by inputs.ts). */
export const isPostmanV3Bundle = (d: Any): boolean => d.postmanV3 === 1 && Array.isArray(d.files);

const base = (p: string) => p.split('/').at(-1)!;
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const isRequestFile = (p: string) => /\.request\.ya?ml$/i.test(p);
const isDefinition = (p: string) => /(^|\/)(\.resources\/)?definition\.ya?ml$/i.test(p);

/** Is this folder of files a v3 collection (a `*.request.yaml` or a `definition.yaml` marked as a collection)? */
export function looksLikePostmanV3(files: V3File[]): boolean {
  if (files.some((f) => isRequestFile(f.path))) return true;
  return files.some((f) => {
    if (!isDefinition(f.path)) return false;
    try {
      const y = parseYaml(f.text) as Any;
      return /^collection$/i.test(String(y?.$kind ?? y?.type ?? ''));
    } catch {
      return false;
    }
  });
}

const fieldList = (x: unknown): Any[] => (Array.isArray(x) ? x : []).filter((v) => v && typeof v === 'object');

/** v3 `credentials` (a list of `{ key, value }` or a plain object) as the v2.1 attribute list. */
const credentialList = (c: unknown): Any[] =>
  Array.isArray(c) ? c.map((x: Any) => ({ key: x.key, value: x.value, type: 'string' })) : c && typeof c === 'object' ? Object.entries(c as Any).map(([key, value]) => ({ key, value, type: 'string' })) : [];

function v3Auth(a: unknown): Any | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const o = a as Any;
  const type = String(o.type ?? '');
  if (!type) return undefined;
  if (type === 'noauth' || type === 'none') return { type: 'noauth' };
  if (type === 'inherit') return undefined;
  return { type, [type]: credentialList(o.credentials ?? o.attributes ?? o[type]) };
}

function v3Scripts(list: unknown): Any[] {
  const events: Any[] = [];
  for (const s of fieldList(list)) {
    const t = String(s.type ?? s.listen ?? '').toLowerCase();
    const listen = /before|pre/.test(t) ? 'prerequest' : /after|test|post/.test(t) ? 'test' : undefined;
    const code = Array.isArray(s.code) ? s.code.join('\n') : String(s.code ?? s.content ?? '');
    if (listen && code.trim()) events.push({ listen, script: { type: 'text/javascript', exec: code.split('\n') } });
  }
  return events;
}

/** v3 `body` → v2.1 body. */
function v3Body(b: unknown): Any | undefined {
  if (!b || typeof b !== 'object') return undefined;
  const o = b as Any;
  const type = String(o.type ?? o.mode ?? '').toLowerCase();
  const content = o.content ?? o.raw ?? o.data;
  switch (type) {
    case 'json':
    case 'xml':
    case 'html':
    case 'text':
    case 'javascript':
    case 'raw':
      return { mode: 'raw', raw: typeof content === 'string' ? content : JSON.stringify(content ?? ''), options: { raw: { language: type === 'raw' ? 'text' : type } } };
    case 'urlencoded':
    case 'x-www-form-urlencoded':
      return { mode: 'urlencoded', urlencoded: fieldList(content ?? o.fields).map((f) => ({ key: f.key, value: f.value, ...(f.disabled ? { disabled: true } : {}) })) };
    case 'formdata':
    case 'form-data':
      return { mode: 'formdata', formdata: fieldList(content ?? o.fields).map((f) => ({ key: f.key, value: f.value, type: f.type === 'file' ? 'file' : 'text', ...(f.type === 'file' ? { src: f.src ?? f.value } : {}), ...(f.contentType ? { contentType: f.contentType } : {}), ...(f.disabled ? { disabled: true } : {}) })) };
    case 'graphql':
      return { mode: 'graphql', graphql: { query: String(o.query ?? content?.query ?? ''), variables: typeof (o.variables ?? content?.variables) === 'string' ? o.variables ?? content?.variables : JSON.stringify(o.variables ?? content?.variables ?? '') } };
    case 'file':
    case 'binary':
      return { mode: 'file', file: { src: String(o.src ?? o.path ?? content ?? '') } };
    default:
      return undefined;
  }
}

/** One `*.request.yaml` as a v2.1 item. */
function v3Item(y: Any, examples: Any[], findings: Findings, where: string): Any {
  const query = fieldList(y.queryParams ?? y.query ?? y.params);
  const headers = fieldList(y.headers ?? y.header);
  const variables = fieldList(y.pathVariables ?? y.pathParams);
  const url = String(y.url ?? '');
  const known = new Set(['$kind', 'type', 'name', 'method', 'url', 'order', 'description', 'headers', 'header', 'queryParams', 'query', 'params', 'pathVariables', 'pathParams', 'body', 'auth', 'scripts', 'variables', 'settings', 'protocolProfileBehavior', 'protocol', 'id', 'examples', 'tags']);
  const extra = Object.keys(y).filter((k) => !known.has(k));
  if (extra.length) findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [where], message: `"${where}": the v3 field${extra.length > 1 ? 's' : ''} ${extra.join(', ')} ${extra.length > 1 ? 'are' : 'is'} not read by TestPion and ${extra.length > 1 ? 'were' : 'was'} not imported` });
  if (y.protocol && !/^https?$/i.test(String(y.protocol)) && !/http/i.test(String(y.$kind ?? y.type ?? 'http')))
    findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [where], message: `"${where}": a ${y.protocol} request in a Postman v3 collection is not imported (only HTTP and GraphQL requests)` });
  const auth = v3Auth(y.auth);
  return {
    name: y.name,
    ...(y.id ? { id: y.id } : {}),
    request: {
      method: y.method ?? 'GET',
      url: { raw: url, query: query.map((q) => ({ key: q.key, value: q.value, ...(q.disabled ? { disabled: true } : {}), ...(q.description ? { description: q.description } : {}) })), variable: variables.map((v) => ({ key: v.key, value: v.value })) },
      header: headers.map((h) => ({ key: h.key, value: h.value, ...(h.disabled ? { disabled: true } : {}), ...(h.description ? { description: h.description } : {}) })),
      ...(v3Body(y.body) ? { body: v3Body(y.body) } : {}),
      ...(auth ? { auth } : {}),
      ...(y.description ? { description: y.description } : {}),
    },
    ...(v3Scripts(y.scripts).length ? { event: v3Scripts(y.scripts) } : {}),
    ...(y.settings || y.protocolProfileBehavior ? { protocolProfileBehavior: y.protocolProfileBehavior ?? y.settings } : {}),
    response: examples.map((e) => ({
      name: e.name,
      code: e.response?.code ?? e.response?.statusCode ?? e.code ?? e.statusCode,
      status: e.response?.status ?? e.status,
      header: fieldList(e.response?.headers ?? e.headers).map((h) => ({ key: h.key, value: h.value })),
      body: typeof (e.response?.body ?? e.body) === 'string' ? e.response?.body ?? e.body : JSON.stringify(e.response?.body ?? e.body ?? ''),
    })),
  };
}

/** The files of a v3 collection folder (paths relative to its root) as a v2.1 collection object. */
function postmanV3ToV21(files: V3File[], name: string, findings: Findings): Any {
  const byPath = new Map(files.map((f) => [f.path, f]));
  /**
   * `{ $ref: "../shared/auth.yaml" }` (or `#/pointer` after the path): the value is the other file's content. The path is
   * resolved against the file that holds the reference and must stay inside the folder that was given - the importer reads
   * the files it was handed and nothing else. A reference to a file outside the folder, a missing one or a loop is reported
   * and left out; the rest of the file is imported.
   */
  const resolveRefs = (v: unknown, from: string, seen: readonly string[], depth: number): unknown => {
    if (Array.isArray(v)) return v.map((x) => resolveRefs(x, from, seen, depth + 1));
    if (!v || typeof v !== 'object') return v;
    const o = v as Any;
    if (typeof o.$ref === 'string' && Object.keys(o).length === 1) {
      const [rel, pointer = ''] = o.$ref.split('#') as [string, string?];
      const parts = dirOf(from).split('/').filter(Boolean);
      for (const seg of rel.split('/')) {
        if (seg === '..') {
          if (!parts.length) {
            findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [from], message: `${from} refers to ${rel}, a file outside the collection folder: it was not imported (import the whole folder, with the shared files inside it)` });
            return undefined;
          }
          parts.pop();
        } else if (seg && seg !== '.') parts.push(seg);
      }
      const target = parts.join('/');
      const file = byPath.get(target);
      if (!file) {
        findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [from], message: `${from} refers to ${rel}, which is not in the folder: it was not imported` });
        return undefined;
      }
      if (seen.includes(target) || depth > 20) {
        findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [from], message: `${from} refers to ${rel}, which refers back to it: the reference was not followed` });
        return undefined;
      }
      let doc: unknown;
      try {
        doc = parseYaml(file.text);
      } catch {
        findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [from], message: `${target} is not valid YAML, so the reference to it in ${from} was not followed` });
        return undefined;
      }
      for (const key of pointer.split('/').filter(Boolean)) doc = doc && typeof doc === 'object' ? (doc as Any)[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
      return resolveRefs(doc, target, [...seen, target], depth + 1);
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolveRefs(x, from, seen, depth + 1)]));
  };
  const yaml = (f: V3File): Any => {
    try {
      const y = parseYaml(f.text);
      return y && typeof y === 'object' ? (resolveRefs(y, f.path, [f.path], 0) as Any) : {};
    } catch (e) {
      findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [], message: `${f.path} is not valid YAML and was not imported: ${(e as Error).message.split('\n')[0]}` });
      return {};
    }
  };
  // directory → its definition (name, description, auth, scripts, variables, order)
  const defs = new Map<string, Any>();
  for (const f of files) if (isDefinition(f.path)) defs.set(dirOf(f.path).replace(/(^|\/)\.resources$/, ''), yaml(f));
  // request examples: <name>.resources/examples/*.yaml
  const exampleFiles = new Map<string, Any[]>();
  for (const f of files) {
    const m = /^(.*)\.resources\/examples\/[^/]+\.ya?ml$/i.exec(f.path);
    if (m) (exampleFiles.get(m[1]!) ?? exampleFiles.set(m[1]!, []).get(m[1]!)!).push(yaml(f));
  }
  const requests = files.filter((f) => isRequestFile(f.path));
  const order = (y: Any, fallback: string) => {
    const o = y.order;
    return typeof o === 'number' ? o : typeof o === 'string' ? o : fallback;
  };
  const sortKey = (a: { o: number | string; n: string }, b: { o: number | string; n: string }) => (typeof a.o === 'number' && typeof b.o === 'number' ? a.o - b.o : String(a.o).localeCompare(String(b.o))) || a.n.localeCompare(b.n);
  const build = (dir: string): Any[] => {
    const here: Array<{ o: number | string; n: string; node: Any }> = [];
    for (const f of requests.filter((x) => dirOf(x.path) === dir)) {
      const y = yaml(f);
      const fname = base(f.path).replace(/\.request\.ya?ml$/i, '');
      const name = String(y.name ?? fname);
      here.push({ o: order(y, ''), n: name, node: v3Item({ ...y, name }, exampleFiles.get(f.path.replace(/\.request\.ya?ml$/i, '')) ?? [], findings, name) });
    }
    const subdirs = new Set<string>();
    for (const f of files) {
      if (!f.path.startsWith(dir ? `${dir}/` : '')) continue;
      const rest = dir ? f.path.slice(dir.length + 1) : f.path;
      const first = rest.split('/')[0]!;
      if (rest.includes('/') && !first.endsWith('.resources') && first !== '.resources') subdirs.add(dir ? `${dir}/${first}` : first);
    }
    for (const sub of subdirs) {
      // a folder of shared files (what a `$ref` points to) is no folder of the collection: it needs a definition or a request below it
      if (!defs.has(sub) && !requests.some((r) => r.path.startsWith(`${sub}/`))) continue;
      const def = defs.get(sub) ?? {};
      const auth = v3Auth(def.auth);
      here.push({
        o: order(def, ''),
        n: String(def.name ?? base(sub)),
        node: {
          name: String(def.name ?? base(sub)),
          ...(def.description ? { description: def.description } : {}),
          ...(auth ? { auth } : {}),
          ...(v3Scripts(def.scripts).length ? { event: v3Scripts(def.scripts) } : {}),
          ...(fieldList(def.variables).length ? { variable: fieldList(def.variables).map((v) => ({ key: v.key, value: v.value })) } : {}),
          item: build(sub),
        },
      });
    }
    return here.sort(sortKey).map((x) => x.node);
  };
  const root = defs.get('') ?? {};
  const auth = v3Auth(root.auth);
  return {
    info: { name: String(root.name ?? name), _postman_id: root.id ?? undefined, schema: V21, ...(root.description ? { description: root.description } : {}) },
    ...(auth ? { auth } : {}),
    ...(v3Scripts(root.scripts).length ? { event: v3Scripts(root.scripts) } : {}),
    ...(fieldList(root.variables).length ? { variable: fieldList(root.variables).map((v) => ({ key: v.key, value: v.value, ...(v.disabled ? { disabled: true } : {}) })) } : {}),
    item: build(''),
  };
}

export function parsePostmanV3(text: string): ImportDocument {
  const d = JSON.parse(text) as { postmanV3: 1; name?: string; key?: string; files: V3File[] };
  const findings = new Findings();
  const v21 = postmanV3ToV21(d.files, d.name ?? 'Postman collection', findings);
  const doc = parsePostman(JSON.stringify(v21));
  doc.version = '3';
  if (d.key) doc.sourceKey = d.key;
  doc.fileCount = d.files.length;
  doc.bytes = Buffer.byteLength(text);
  doc.findings.unshift(...findings.list);
  return doc;
}
