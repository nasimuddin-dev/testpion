import type { BodyConfig, Collection, CollectionFolder, CollectionNode, Environment, KeyValue, SavedExample, SavedHttpRequest } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';
import { mapForeignAuth } from './foreign-auth.js';
import { normalizeTemplate } from './templates.js';
import { sampleFromSchema } from './openapi-import.js';
import { Findings, newDocument, type ImportDocument } from './model.js';
import { collectionOf, type Any } from './import-helpers.js';

/**
 * Apidog as an import document: its project export ("Apidog" format, `apidogProject`, also written by Apifox as
 * `apifoxProject`): an `apiCollection` tree of folders and endpoints (`api`: method, path, parameters, request body,
 * responses and response examples), `environments` and global variables. An endpoint is a design (a path and
 * schemas), so a request is built from it: the path under `{{baseUrl}}`, parameters with their examples, a body
 * sampled from its JSON schema (or its example), the documented responses as examples. Apidog's other exports (OpenAPI,
 * Postman) already import through their own formats.
 */

export function isApidog(d: Any): boolean {
  return (typeof d.apidogProject === 'string' || typeof d.apifoxProject === 'string') && Array.isArray(d.apiCollection);
}

const n = (s: unknown) => normalizeTemplate(s);

/** Schemas by id, so `#/definitions/<id>` references resolve (`sampleFromSchema` walks a spec document). */
function schemaSpec(d: Any): Any {
  const definitions: Record<string, unknown> = {};
  const walk = (list: unknown) => {
    for (const s of Array.isArray(list) ? list : []) {
      if (s?.id !== undefined && s.jsonSchema) definitions[String(s.id)] = s.jsonSchema;
      if (Array.isArray(s?.items)) walk(s.items);
    }
  };
  walk(d.schemaCollection);
  return { definitions, components: { schemas: definitions } };
}

export function parseApidog(text: string): ImportDocument {
  const d: Any = JSON.parse(text);
  const findings = new Findings();
  const doc = newDocument('apidog', text, { tool: String(d.apifoxProject ? 'Apifox' : 'Apidog'), version: String(d.apidogProject ?? d.apifoxProject ?? '') });
  const spec = schemaSpec(d);
  const name = String(d.info?.name ?? d.projectName ?? 'Apidog import');
  let usesBaseUrl = false;

  const params = (list: unknown): KeyValue[] =>
    (Array.isArray(list) ? list : []).filter((p: Any) => p?.name).map((p: Any) => ({ key: String(p.name), value: p.example !== undefined ? String(p.example) : p.defaultValue !== undefined ? String(p.defaultValue) : '', enabled: p.required !== false, ...(p.description ? { description: String(p.description) } : {}) }));

  const body = (b: Any | undefined, where: string): BodyConfig | undefined => {
    if (!b || typeof b !== 'object' || !b.type || b.type === 'none') return undefined;
    const type = String(b.type);
    if (type.includes('json') || type.includes('xml') || type.startsWith('text/') || type === 'raw') {
      let content: string | undefined;
      if (typeof b.example === 'string' && b.example.trim()) content = b.example;
      else if (Array.isArray(b.examples) && b.examples[0]?.value !== undefined) content = typeof b.examples[0].value === 'string' ? b.examples[0].value : JSON.stringify(b.examples[0].value, null, 2);
      else if (b.jsonSchema) content = JSON.stringify(sampleFromSchema(b.jsonSchema, spec), null, 2);
      if (content === undefined) return undefined;
      return { type: type.includes('xml') ? 'xml' : type.includes('json') ? 'json' : 'text', content: n(content) };
    }
    if (type.includes('x-www-form-urlencoded')) return { type: 'form-urlencoded', fields: params(b.parameters) };
    if (type.includes('multipart')) return { type: 'multipart', fields: (b.parameters ?? []).filter((p: Any) => p?.name).map((p: Any) => ({ key: String(p.name), value: p.example !== undefined ? String(p.example) : '', kind: p.type === 'file' ? ('file' as const) : ('text' as const), enabled: p.required !== false })) };
    findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [where], field: 'body', message: `"${where}": a ${type} body was not imported` });
    return undefined;
  };

  const examples = (api: Any): SavedExample[] | undefined => {
    const out: SavedExample[] = [];
    for (const ex of Array.isArray(api.responseExamples) ? api.responseExamples : []) {
      const resp = (api.responses ?? []).find((r: Any) => String(r.id) === String(ex.responseId));
      out.push({ id: shortId('ex-'), name: String(ex.name ?? resp?.name ?? 'Example'), status: Number(resp?.code) || 200, headers: resp?.contentType ? [{ key: 'Content-Type', value: /json/.test(resp.contentType) ? 'application/json' : String(resp.contentType) }] : [], body: typeof ex.data === 'string' ? ex.data : JSON.stringify(ex.data ?? '') });
    }
    // no written example: the response schema's sample
    if (!out.length)
      for (const resp of Array.isArray(api.responses) ? api.responses : []) {
        if (!resp?.jsonSchema || !Number(resp.code)) continue;
        out.push({ id: shortId('ex-'), name: String(resp.name ?? resp.code), status: Number(resp.code), headers: [{ key: 'Content-Type', value: 'application/json' }], body: JSON.stringify(sampleFromSchema(resp.jsonSchema, spec), null, 2) });
      }
    return out.length ? out : undefined;
  };

  const request = (it: Any): SavedHttpRequest => {
    const api: Any = it.api ?? {};
    const rname = String(it.name ?? api.name ?? api.path ?? 'Endpoint');
    const p: Any = api.parameters ?? {};
    const path = String(api.path ?? '');
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
    if (!absolute) usesBaseUrl = true;
    const a = mapForeignAuth('apidog', api.auth && Object.keys(api.auth).length ? api.auth : undefined, rname);
    findings.notes(a.notes);
    const pathVars = params(p.path);
    const headers = params(p.header);
    headers.push(...a.headers);
    const cookies = params(p.cookie);
    const description = [api.summary, api.description].filter((x) => typeof x === 'string' && x.trim()).join('\n\n');
    const req: SavedHttpRequest = {
      kind: 'http',
      id: shortId('req-'),
      name: rname,
      ...(description ? { description } : {}),
      request: {
        method: String(api.method ?? 'get').toUpperCase(),
        url: absolute ? n(path) : `{{baseUrl}}${n(path.startsWith('/') || !path ? path : `/${path}`).replace(/\{([A-Za-z_][\w-]*)\}/g, ':$1')}`,
        params: params(p.query),
        ...(pathVars.length ? { pathVariables: pathVars.map((v) => ({ key: v.key, value: v.value })) } : {}),
        headers,
        ...(cookies.length ? { cookies } : {}),
        body: body(api.requestBody, rname),
        auth: a.auth ?? { type: 'inherit' as const },
      },
    };
    const ex = examples(api);
    if (ex) req.examples = ex;
    const pre = (Array.isArray(api.preProcessors) ? api.preProcessors : []).filter((x: Any) => x?.enable !== false && x?.type === 'customScript');
    const post = (Array.isArray(api.postProcessors) ? api.postProcessors : []).filter((x: Any) => x?.enable !== false && x?.type === 'customScript');
    if (pre.length || post.length) {
      // Apidog's custom scripts speak Postman's pm.* (pm.environment …): kept, they run (pm is an alias of tp)
      if (pre.length) req.preRequestScript = pre.map((x: Any) => String(x.data ?? '')).join('\n');
      if (post.length) req.testScript = post.map((x: Any) => String(x.data ?? '')).join('\n');
    }
    const other = [...(Array.isArray(api.preProcessors) ? api.preProcessors : []), ...(Array.isArray(api.postProcessors) ? api.postProcessors : [])].filter((x: Any) => x?.enable !== false && x?.type && x.type !== 'customScript');
    if (other.length) findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [rname], field: 'script', message: `"${rname}": ${other.length} Apidog pre/post operation${other.length > 1 ? 's' : ''} (${[...new Set(other.map((x: Any) => x.type))].join(', ')}) ${other.length > 1 ? 'were' : 'was'} not imported: only custom scripts come over` });
    return req;
  };

  const build = (list: unknown): CollectionNode[] =>
    (Array.isArray(list) ? list : []).map((it: Any): CollectionNode => {
      if (it?.api) return request(it);
      const a = mapForeignAuth('apidog', it?.auth && Object.keys(it.auth).length ? it.auth : undefined, String(it?.name ?? 'Folder'));
      findings.notes(a.notes);
      const f: CollectionFolder = { kind: 'folder', id: shortId('fld-'), name: String(it?.name ?? 'Folder'), items: build(it?.items), ...(it?.description ? { description: String(it.description) } : {}), ...(a.auth ? { auth: a.auth } : {}) };
      return f;
    });

  // the top-level entries of apiCollection are the project's root folders
  const tree = build(d.apiCollection);
  const collection: Collection = collectionOf(name, tree.length === 1 && tree[0]!.kind === 'folder' && /^(root|root folder)$/i.test(tree[0]!.name) ? (tree[0] as CollectionFolder).items : tree, d.info?.description ? { description: String(d.info.description) } : {});
  if (usesBaseUrl) collection.variables = [{ key: 'baseUrl', value: '', enabled: true }];

  // environments: each with its own base URL and variables
  const envs: Environment[] = [];
  for (const e of Array.isArray(d.environments) ? d.environments : []) {
    const ename = String(e?.name ?? 'Environment');
    const variables: KeyValue[] = [];
    const base = e.baseUrl ?? e.servers?.[0]?.url ?? e.baseUrls?.default;
    if (typeof base === 'string' && base.trim()) variables.push({ key: 'baseUrl', value: n(base).replace(/\/$/, ''), enabled: true });
    for (const v of Array.isArray(e.variables) ? e.variables : []) if (v?.name) variables.push({ key: String(v.name), value: n(v.currentValue ?? v.value ?? v.initialValue ?? ''), enabled: true });
    envs.push({ id: slugify(ename) || 'env', name: ename, variables });
  }
  const globals = (Array.isArray(d.globalVariables) ? d.globalVariables : []).filter((v: Any) => v?.name);
  if (globals.length) {
    // global variables are visible to every environment
    for (const e of envs) for (const v of globals) if (!e.variables.some((x) => x.key === v.name)) e.variables.push({ key: String(v.name), value: n(v.currentValue ?? v.value ?? v.initialValue ?? ''), enabled: true });
    if (!envs.length) envs.push({ id: 'apidog-globals', name: `${name} globals`, variables: globals.map((v: Any) => ({ key: String(v.name), value: n(v.currentValue ?? v.value ?? v.initialValue ?? ''), enabled: true })) });
  }
  doc.environments = envs;
  if (usesBaseUrl && !envs.some((e) => e.variables.some((v) => v.key === 'baseUrl')))
    findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [], message: 'The endpoints are paths: set the collection variable {{baseUrl}} to the server (the export holds no server URL)' });
  doc.collections.push(collection);
  doc.findings.push(...findings.list);
  return doc;
}
