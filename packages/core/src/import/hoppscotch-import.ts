import type { Collection, CollectionFolder, CollectionNode, Environment, KeyValue, SavedExample, SavedGraphQLRequest, SavedHttpRequest } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';
import { mapForeignAuth } from './foreign-auth.js';
import { normalizeHoppscotch } from './templates-more.js';
import { Findings, newDocument, type ImportDocument } from './model.js';
import { bodyFromMime, collectionOf, type Any } from './import-helpers.js';

/**
 * Hoppscotch as an import document: collection exports (folders, requests, headers, params, bodies, auth, request
 * variables, scripts, GraphQL requests, saved responses) and environment exports (`[{ name, variables }]`, with their
 * secret flags). Scripts are `pw.*` (and the newer `hopp.*` and its `pm.*` layer): the pipeline converts them to `tp.*`
 * (scripts/convert/rules.ts). Collection and folder headers, variables and scripts stay on the collection and folder.
 */

/** The `{{name}}` form of a Hoppscotch string (`<<name>>`, `<<$guid>>`). */
const n = (s: unknown) => normalizeHoppscotch(s);

const hkv = (list: unknown): KeyValue[] =>
  (Array.isArray(list) ? list : []).filter((x: Any) => x?.key).map((x: Any) => ({ key: n(x.key), value: n(x.value ?? ''), enabled: x.active !== false, ...(x.description ? { description: String(x.description) } : {}) }));

/** True for an environment export: a list of `{ name, variables: [] }`. */
export function isHoppscotchEnvironments(d: unknown): boolean {
  const list = Array.isArray(d) ? d : d && typeof d === 'object' ? [d] : [];
  // (TestPion's own environment files also have name + variables: Hoppscotch's carry a version `v` or initial / current values)
  const hopp = (e: Any) => typeof e.v === 'number' || e.variables.some((v: Any) => v && ('initialValue' in v || 'currentValue' in v)) || (!('id' in e) && !e.variables.some((v: Any) => v && 'enabled' in v));
  return list.length > 0 && list.every((e: Any) => e && typeof e.name === 'string' && Array.isArray(e.variables) && !('requests' in e) && !('folders' in e) && hopp(e));
}

function environments(d: unknown, findings: Findings): { envs: Environment[]; secrets: Record<string, Record<string, string>> } {
  const list: Any[] = Array.isArray(d) ? d : [d as Any];
  const envs: Environment[] = [];
  const secrets: Record<string, Record<string, string>> = {};
  for (const e of list) {
    const name = String(e.name ?? 'Hoppscotch environment');
    const id = slugify(name) || 'env';
    const needed: string[] = [];
    const variables = (e.variables as Any[]).filter((v) => v?.key).map((v) => {
      // v2 has initialValue / currentValue, v1 value
      const value = String(v.currentValue ?? v.value ?? v.initialValue ?? '');
      if (v.secret) {
        if (value) (secrets[id] ??= {})[String(v.key)] = n(value);
        else needed.push(String(v.key));
        return { key: String(v.key), value: '', secret: true, enabled: true };
      }
      return { key: String(v.key), value: n(value), enabled: true };
    });
    envs.push({ id, name, variables });
    if (needed.length) findings.add({ code: 'VALUE_NEEDED', severity: 'changed', where: [name], message: `Values needed: ${needed.join(', ')} in the "${name}" environment (Hoppscotch keeps secret values in the app, not in the export)` });
  }
  return { envs, secrets };
}

function examples(responses: unknown): SavedExample[] | undefined {
  if (!responses || typeof responses !== 'object') return undefined;
  const out: SavedExample[] = Object.values(responses as Any)
    .filter((r: Any) => r && typeof r === 'object')
    .map((r: Any) => ({
      id: shortId('ex-'),
      name: String(r.name ?? (`${r.code ?? ''} ${r.status ?? ''}`.trim() || 'Example')),
      status: Number(r.code) || 200,
      ...(r.status ? { statusText: String(r.status) } : {}),
      headers: (Array.isArray(r.headers) ? r.headers : []).filter((h: Any) => h?.key).map((h: Any) => ({ key: String(h.key), value: String(h.value ?? '') })),
      body: typeof r.body === 'string' ? r.body : '',
    }));
  return out.length ? out : undefined;
}

export function parseHoppscotch(text: string): ImportDocument {
  const d: Any = JSON.parse(text);
  const findings = new Findings();
  const doc = newDocument('hoppscotch', text, { tool: 'Hoppscotch', scriptTool: 'hoppscotch' });

  if (isHoppscotchEnvironments(d)) {
    const r = environments(d, findings);
    doc.environments = r.envs;
    if (Object.keys(r.secrets).length) doc.secretValues = r.secrets;
    doc.findings.push(...findings.list);
    return doc;
  }

  const roots: Any[] = Array.isArray(d) ? d : [d];
  const sourceIds: Record<string, string> = {};
  const request = (r: Any): SavedHttpRequest | SavedGraphQLRequest => {
    const node = requestNode(r);
    if (r._ref_id) sourceIds[node.id] = String(r._ref_id);
    return node;
  };
  const requestNode = (r: Any): SavedHttpRequest | SavedGraphQLRequest => {
    const name = String(r.name || r.endpoint || r.url || 'Request');
    const headers = hkv(r.headers);
    const a = mapForeignAuth('hoppscotch', r.auth, name);
    findings.notes(a.notes);
    headers.push(...a.headers);
    const auth = a.auth ?? { type: 'inherit' as const };
    // request variables (`<<name>>` placeholders of this request only) as lines that set them before the request
    const vars = (Array.isArray(r.requestVariables) ? r.requestVariables : []).filter((v: Any) => v?.key && v.active !== false);
    const preLines = vars.map((v: Any) => `tp.variables.set(${JSON.stringify(String(v.key))}, ${JSON.stringify(n(v.value ?? ''))});`);
    const pre = [preLines.join('\n'), String(r.preRequestScript ?? '').trim()].filter(Boolean).join('\n') || undefined;
    const post = String(r.testScript ?? '').trim() || undefined;
    const ex = examples(r.responses);
    // GraphQL collection: { url, query, variables }
    if (typeof r.query === 'string' && !r.endpoint) {
      return {
        kind: 'graphql',
        id: shortId('gql-'),
        name,
        request: { endpoint: n(r.url), query: n(r.query), ...(typeof r.variables === 'string' && r.variables.trim() ? { variables: n(r.variables) } : {}), headers, auth },
        ...(pre ? { preRequestScript: pre } : {}),
        ...(post ? { testScript: post } : {}),
      };
    }
    const ct = r.body?.contentType ?? '';
    const body =
      typeof r.body?.body === 'string'
        ? bodyFromMime(ct, n(r.body.body), undefined)
        : Array.isArray(r.body?.body)
          ? bodyFromMime(ct, undefined, r.body.body.map((f: Any) => ({ name: f.key, value: n(f.value), disabled: f.active === false, type: f.isFile ? 'file' : 'text' })))
          : undefined;
    return {
      kind: 'http',
      id: shortId('req-'),
      name,
      request: { method: String(r.method ?? 'GET').toUpperCase(), url: n(r.endpoint), params: hkv(r.params), headers, body, auth },
      ...(pre ? { preRequestScript: pre } : {}),
      ...(post ? { testScript: post } : {}),
      ...(ex ? { examples: ex } : {}),
    };
  };
  const common = (c: Any, where: string) => {
    const a = mapForeignAuth('hoppscotch', c.auth, where);
    findings.notes(a.notes);
    const headers = hkv(c.headers);
    const variables: KeyValue[] = (Array.isArray(c.variables) ? c.variables : []).filter((v: Any) => v?.key).map((v: Any) => ({ key: String(v.key), value: n(v.value ?? v.initialValue ?? ''), enabled: true }));
    const secretVars = (Array.isArray(c.variables) ? c.variables : []).filter((v: Any) => v?.key && v.secret);
    if (secretVars.length) findings.add({ code: 'VALUE_NEEDED', severity: 'changed', where: [where], message: `Values needed: ${secretVars.map((v: Any) => v.key).join(', ')} (secret variables of "${where}": Hoppscotch keeps their values in the app, not in the export)` });
    const pre = String(c.preRequestScript ?? '').trim();
    const post = String(c.testScript ?? '').trim();
    return {
      ...(a.auth ? { auth: a.auth } : {}),
      ...(headers.length ? { headers } : {}),
      ...(variables.length ? { variables: variables.map((v) => (secretVars.some((s: Any) => s.key === v.key) ? { ...v, value: '' } : v)) } : {}),
      ...(pre ? { preRequestScript: pre } : {}),
      ...(post ? { testScript: post } : {}),
    };
  };
  const folder = (c: Any): CollectionFolder => {
    const name = String(c.name ?? 'Folder');
    const f: CollectionFolder = { kind: 'folder', id: shortId('fld-'), name, items: [...(c.folders ?? []).map(folder), ...(c.requests ?? []).map(request)] as CollectionNode[], ...common(c, name) };
    if (c._ref_id) sourceIds[f.id] = String(c._ref_id);
    return f;
  };
  let collection: Collection;
  if (roots.length === 1) {
    const c = roots[0]!;
    const name = String(c.name ?? 'Hoppscotch import');
    const { variables, ...rest } = common(c, name);
    collection = collectionOf(name, [...(c.folders ?? []).map(folder), ...(c.requests ?? []).map(request)], { ...rest, ...(variables ? { variables } : {}) });
  } else collection = collectionOf('Hoppscotch import', roots.map(folder));
  doc.collections.push(collection);
  if (Object.keys(sourceIds).length) doc.sourceIds = sourceIds;
  if (roots.length === 1 && roots[0]!._ref_id) doc.sourceKey = String(roots[0]!._ref_id);
  doc.findings.push(...findings.list);
  return doc;
}

export function importHoppscotch(text: string): { collection: Collection; notes: string[] } {
  const doc = parseHoppscotch(text);
  return { collection: doc.collections[0]!, notes: doc.findings.map((f) => f.message) };
}
