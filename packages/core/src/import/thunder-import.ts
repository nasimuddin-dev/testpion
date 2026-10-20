import type { BodyConfig, CheckConfig, Collection, CollectionFolder, CollectionNode, Environment, KeyValue, SavedGraphQLRequest, SavedHttpRequest } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';
import { mapMoreAuth } from './foreign-auth-more.js';
import { normalizeThunder, distinct } from './templates-more.js';
import { Findings, newDocument, type ImportDocument } from './model.js';
import { collectionOf, type Any } from './import-helpers.js';

/**
 * Thunder Client (the VS Code extension) as an import document: a collection export (`clientName: "Thunder Client"`,
 * `folders` + `requests` linked by `containerId`) and an environment export (`data: [{ name, value }]`). Requests,
 * folders, params and path params, headers, bodies (json, xml, text, form, form-data, graphql, binary), auth,
 * `{{#guid}}`-style generators, the GUI tests (response code / time / body / header / JSON query: simple ones become
 * TestPion assertions, the others a test script) and the `tc.*` scripts (converted to `tp.*` by the pipeline).
 */

const sortOf = (x: Any) => Number(x.sortNum ?? 0);

/** True for a Thunder Client export (collection or environment). */
export function isThunder(d: Any): boolean {
  if (String(d.clientName ?? '').toLowerCase().includes('thunder')) return true;
  return Array.isArray(d.requests) && d.requests.length > 0 && d.requests.every((r: Any) => r && typeof r === 'object' && 'colId' in r) && !('order' in d);
}

/** The comparison of a GUI test as chai, for a test script. */
const CHAI: Record<string, (v: string) => string> = {
  equal: (v) => `.to.equal(${v})`,
  '=': (v) => `.to.equal(${v})`,
  notequal: (v) => `.to.not.equal(${v})`,
  '!=': (v) => `.to.not.equal(${v})`,
  contains: (v) => `.to.include(${v})`,
  notcontains: (v) => `.to.not.include(${v})`,
  '>': (v) => `.to.be.above(${v})`,
  '>=': (v) => `.to.be.at.least(${v})`,
  '<': (v) => `.to.be.below(${v})`,
  '<=': (v) => `.to.be.at.most(${v})`,
  startswith: (v) => `.to.satisfy((s) => String(s).startsWith(${v}))`,
  istype: (v) => `.to.be.a(${v})`,
  isjson: () => `.to.be.an('object')`,
  regex: (v) => `.to.match(new RegExp(${v}))`,
};

interface ThunderTest {
  type: string;
  custom?: string;
  action: string;
  value?: string;
}

function numeric(v: unknown): number | undefined {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : undefined;
}

/** The JSONPath of a Thunder `json-query` (`json.data.id`, `json.items[0].id`). */
function queryPath(q: string): string {
  const p = q.trim().replace(/^json\.?/, '');
  return p ? `$.${p}` : '$';
}

/** GUI tests: the simple ones as assertions, the rest as one `tp.test` each in a script. */
function thunderTests(tests: unknown, where: string, findings: Findings): { assertions: CheckConfig[]; script: string } {
  const assertions: CheckConfig[] = [];
  const lines: string[] = [];
  for (const raw of Array.isArray(tests) ? tests : []) {
    const t = raw as ThunderTest;
    const action = String(t.action ?? '').toLowerCase();
    const value = String(t.value ?? '');
    const custom = String(t.custom ?? '');
    const num = numeric(value);
    if (t.type === 'res-code' && action === 'equal' && num !== undefined) {
      assertions.push({ type: 'status', expected: num });
      continue;
    }
    if (t.type === 'res-time' && (action === '<' || action === '<=') && num !== undefined) {
      assertions.push({ type: 'latency', max: num });
      continue;
    }
    if (t.type === 'res-header' && (action === 'equal' || action === 'contains') && custom) {
      assertions.push({ type: 'header', header: custom, expected: value });
      continue;
    }
    if (t.type === 'res-body' && action === 'contains') {
      assertions.push({ type: 'contains', expected: value });
      continue;
    }
    if (t.type === 'json-query' && action === 'equal' && custom) {
      assertions.push({ type: 'equals', path: queryPath(custom), expected: num !== undefined && String(num) === value.trim() ? num : value === 'true' ? true : value === 'false' ? false : value });
      continue;
    }
    const cmp = CHAI[action];
    const lit = JSON.stringify(num !== undefined && ['>', '>=', '<', '<=', 'equal', '=', 'notequal', '!='].includes(action) ? num : value);
    let actual: string | undefined;
    if (t.type === 'res-code') actual = 'tp.response.code';
    else if (t.type === 'res-time') actual = 'tp.response.responseTime';
    else if (t.type === 'res-body') actual = 'tp.response.text()';
    else if (t.type === 'res-header') actual = `tp.response.headers.get(${JSON.stringify(custom)})`;
    else if (t.type === 'json-query') {
      const p = queryPath(custom)
        .slice(1)
        .replace(/\.([A-Za-z_$][\w$]*)/g, '?.$1')
        .replace(/\[(\d+)\]/g, '?.[$1]');
      actual = `tp.response.json()${p}`;
    }
    if (!actual || !cmp) {
      findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [where], field: 'tests', message: `"${where}": the Thunder Client test "${t.type} ${t.action}" has no TestPion equivalent and was not imported` });
      continue;
    }
    lines.push(`tp.test(${JSON.stringify(`${t.type.replace(/^res-/, 'response ')} ${t.action} ${value}`.trim())}, function () { tp.expect(${actual})${cmp(lit)}; });`);
  }
  return { assertions, script: lines.join('\n') };
}

/** A script field: a string, a list of lines, or `{ script: … }` entries. */
function scriptText(x: unknown): string {
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map(scriptText).filter(Boolean).join('\n');
  if (x && typeof x === 'object') return scriptText((x as Any).script ?? (x as Any).runScript ?? (x as Any).code);
  return '';
}

/** Post-request "set environment variable" actions (`{ key, value: 'json.token' }`) as script lines. */
function setEnvLines(list: unknown, where: string, findings: Findings): string {
  const out: string[] = [];
  for (const a of Array.isArray(list) ? list : []) {
    const key = String((a as Any)?.key ?? (a as Any)?.name ?? '');
    const v = String((a as Any)?.value ?? '').trim();
    if (!key) continue;
    let expr: string | undefined;
    if (/^json(\.|\[|$)/.test(v)) expr = `tp.response.json()${v.slice(4).replace(/\.([A-Za-z_$][\w$]*)/g, '?.$1').replace(/\[(\d+)\]/g, '?.[$1]')}`;
    else if (/^header\./i.test(v)) expr = `tp.response.headers.get(${JSON.stringify(v.slice(7))})`;
    else if (/^cookie\./i.test(v)) expr = `tp.cookies.get(${JSON.stringify(v.slice(7))})`;
    else if (v === 'body' || v === 'text') expr = 'tp.response.text()';
    else if (v === 'status') expr = 'tp.response.code';
    if (expr) out.push(`tp.environment.set(${JSON.stringify(key)}, ${expr});`);
    else findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [where], field: 'script:post-response', message: `"${where}": the post-request action "set ${key} = ${v}" is not a form TestPion reads (json.…, header.…, cookie.…); set it with a script` });
  }
  return out.join('\n');
}

export function parseThunder(text: string): ImportDocument {
  const d: Any = JSON.parse(text);
  const findings = new Findings();
  const doc = newDocument('thunder', text, { tool: 'Thunder Client', ...(d.version ? { version: String(d.version) } : {}), scriptTool: 'thunder' });
  const unknown: string[] = [];
  const n = (s: unknown): string => {
    const r = normalizeThunder(s);
    unknown.push(...r.unknown);
    return r.text;
  };
  const kv = (list: unknown, name = 'name'): KeyValue[] =>
    (Array.isArray(list) ? list : []).filter((x: Any) => x?.[name]).map((x: Any) => ({ key: n(x[name]), value: n(x.value ?? ''), enabled: x.isDisabled !== true && x.disabled !== true }));

  // an environment export
  if (Array.isArray(d.data) && !Array.isArray(d.requests)) {
    const name = String(d.environmentName ?? d.name ?? 'Thunder Client environment');
    doc.environments.push({ id: slugify(name) || 'thunder', name, variables: kv(d.data) });
    if (unknown.length) findings.add({ code: 'TEMPLATE_TAG_UNSUPPORTED', severity: 'changed', where: [name], message: `"${name}": ${distinct(unknown).join(', ')} has no TestPion dynamic variable and stays as text` });
    doc.findings.push(...findings.list);
    return doc;
  }

  const folders: Any[] = Array.isArray(d.folders) ? d.folders : [];
  const requests: Any[] = Array.isArray(d.requests) ? d.requests : [];
  const authOf = (raw: unknown, where: string, headers?: KeyValue[]) => {
    const a = mapMoreAuth('thunder', raw, where, n);
    findings.notes(a.notes);
    headers?.push(...a.headers);
    return a.auth;
  };
  const rootSettings: Any = d.settings && typeof d.settings === 'object' ? d.settings : {};

  const body = (r: Any): BodyConfig | undefined => {
    const b: Any = r.body ?? {};
    switch (b.type) {
      case 'json':
      case 'xml':
      case 'text':
        return b.raw ? { type: b.type, content: n(b.raw) } : undefined;
      case 'x-www-form-urlencoded':
      case 'form-urlencoded':
        return { type: 'form-urlencoded', fields: kv(b.form) };
      case 'formdata':
      case 'form-data':
        return {
          type: 'multipart',
          fields: [...kv(b.form).map((f) => ({ ...f, kind: 'text' as const })), ...(Array.isArray(b.files) ? b.files : []).filter((f: Any) => f?.name).map((f: Any) => ({ key: String(f.name), value: String(f.value ?? ''), kind: 'file' as const, enabled: f.isDisabled !== true }))],
        };
      case 'binary':
        return b.binary ? { type: 'binary', filePath: String(b.binary) } : undefined;
      default:
        return undefined;
    }
  };

  const sourceIds: Record<string, string> = {};
  const request = (r: Any): SavedHttpRequest | SavedGraphQLRequest => {
    const node = requestNode(r);
    if (r._id) sourceIds[node.id] = String(r._id);
    return node;
  };
  const requestNode = (r: Any): SavedHttpRequest | SavedGraphQLRequest => {
    const name = String(r.name ?? r.url ?? 'Request');
    const headers = kv(r.headers);
    const auth = authOf(r.auth, name, headers) ?? { type: 'inherit' as const };
    const params = (Array.isArray(r.params) ? r.params : []).filter((p: Any) => p?.name);
    const t = thunderTests(r.tests, name, findings);
    const pre = [scriptText(r.preReq?.inlineScripts ?? r.preReq?.runScript ?? r.preReq?.script)].filter(Boolean).join('\n');
    const post = [scriptText(r.postReq?.inlineScripts ?? r.postReq?.runScript ?? r.postReq?.script), setEnvLines(r.postReq?.setEnvVar ?? r.postReq?.setEnv, name, findings), t.script].filter(Boolean).join('\n');
    const base = {
      ...(pre ? { preRequestScript: pre } : {}),
      ...(post ? { testScript: post } : {}),
      ...(t.assertions.length ? { assertions: t.assertions } : {}),
    };
    if (r.body?.type === 'graphql') {
      const g: Any = r.body.graphql ?? {};
      let variables: string | Record<string, unknown> | undefined;
      if (typeof g.variables === 'string' && g.variables.trim()) variables = n(g.variables);
      return { kind: 'graphql', id: shortId('gql-'), name, request: { endpoint: n(r.url), query: n(g.query ?? ''), variables, headers, auth }, ...base };
    }
    return {
      kind: 'http',
      id: shortId('req-'),
      name,
      ...(r.docs ? { description: String(r.docs) } : {}),
      request: {
        method: String(r.method ?? 'GET').toUpperCase(),
        url: n(r.url).replace(/\?.*$/, params.some((p: Any) => !p.isPath) ? '' : '$&'),
        params: params.filter((p: Any) => !p.isPath).map((p: Any) => ({ key: n(p.name), value: n(p.value ?? ''), enabled: p.isDisabled !== true })),
        ...(params.some((p: Any) => p.isPath) ? { pathVariables: params.filter((p: Any) => p.isPath).map((p: Any) => ({ key: n(p.name), value: n(p.value ?? '') })) } : {}),
        headers,
        body: body(r),
        auth,
      },
      ...base,
    };
  };

  const folderHeaders = (f: Any) => kv(f.settings?.headers ?? f.headers);
  const build = (parent: string): CollectionNode[] => {
    const subs = folders.filter((f) => String(f.containerId ?? '') === parent).map((f) => ({ sort: sortOf(f), node: f as Any }));
    const reqs = requests.filter((r) => String(r.containerId ?? '') === parent).map((r) => ({ sort: sortOf(r), node: r as Any }));
    // folders and requests share one order (sortNum)
    const items = [...subs.map((x) => ({ ...x, folder: true })), ...reqs.map((x) => ({ ...x, folder: false }))].sort((a, b) => a.sort - b.sort);
    return items.map((it): CollectionNode => {
      if (!it.folder) return request(it.node);
      const f = it.node;
      const name = String(f.name ?? 'Folder');
      const headers = folderHeaders(f);
      const auth = authOf(f.settings?.auth ?? f.auth, name);
      const pre = scriptText(f.settings?.preReq ?? f.preReq);
      const folder: CollectionFolder = { kind: 'folder', id: shortId('fld-'), name, items: build(String(f._id)), ...(auth ? { auth } : {}), ...(headers.length ? { headers } : {}), ...(pre ? { preRequestScript: pre } : {}) };
      if (f._id) sourceIds[folder.id] = String(f._id);
      return folder;
    });
  };
  // requests of a collection export with no folder id match: the ones at the root have containerId ''
  const items = build('');
  const orphans = requests.filter((r) => String(r.containerId ?? '') !== '' && !folders.some((f) => String(f._id) === String(r.containerId)));
  if (orphans.length) {
    findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [], message: `${orphans.length} request${orphans.length > 1 ? 's name' : ' names'} a folder that is not in the file: ${orphans.length > 1 ? 'they were' : 'it was'} put at the top of the collection` });
    items.push(...orphans.map(request));
  }
  const name = String(d.collectionName ?? d.name ?? 'Thunder Client import');
  const rootHeaders = kv(rootSettings.headers);
  const rootAuth = authOf(rootSettings.auth, name);
  const collection: Collection = collectionOf(name, items, { ...(rootHeaders.length ? { headers: rootHeaders } : {}), ...(rootAuth ? { auth: rootAuth } : {}) });
  const baseUrl = rootSettings.options?.baseUrl;
  if (typeof baseUrl === 'string' && baseUrl.trim()) findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [], message: `The collection's base URL (${baseUrl}) is not applied to relative request URLs: put it in a variable such as {{baseUrl}}` });
  doc.collections.push(collection);
  if (Object.keys(sourceIds).length) doc.sourceIds = sourceIds;
  if (d.collectionId) doc.sourceKey = String(d.collectionId);
  if (unknown.length) findings.add({ code: 'TEMPLATE_TAG_UNSUPPORTED', severity: 'changed', where: [], message: `${distinct(unknown).join(', ')} ${distinct(unknown).length > 1 ? 'have' : 'has'} no TestPion dynamic variable and ${distinct(unknown).length > 1 ? 'stay' : 'stays'} as text` });
  doc.findings.push(...findings.list);
  return doc;
}

export type { Environment };
