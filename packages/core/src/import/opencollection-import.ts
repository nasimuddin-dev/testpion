import { parseYaml, parseYamlShared } from '../util/lazy-yaml.js';
import type { AuthConfig, BodyConfig, CheckConfig, Collection, CollectionFolder, CollectionNode, Environment, HttpSettings, KeyValue, LibraryItem, SavedExample } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';
import { brunoAssertionScript } from '../scripts/bruno.js';
import { mapForeignAuth } from './foreign-auth.js';
import { normalizeTemplate } from './templates.js';
import { Findings, newDocument, type ImportDocument } from './model.js';
import { collectionOf, type Any } from './import-helpers.js';
import { brunoScript, brunoSettings, dotenvEnvironments, processEnvNames } from './bruno-import.js';

/**
 * OpenCollection, the YAML format Bruno uses by default since 3.1 (https://opencollection.com; types:
 * github.com/opencollection-dev/opencollection, packages/oc-types). A collection is a folder (`opencollection.yml`,
 * `folder.yml` per folder, one `.yml` per request, `environments/*.yml`) or one bundled file (`bundled: true`, nested
 * `items`). A folder is first assembled into the bundled shape (`ocFilesToBundle`), which is what the importer reads.
 * Scripts speak Bruno's API (`bru.*`, `req`, `res`) and are converted like Bruno's .bru scripts.
 */

export function isOpenCollection(d: unknown): boolean {
  return !!d && typeof d === 'object' && typeof (d as Any).opencollection === 'string';
}

const isRequestFile = (d: Any) => d && typeof d === 'object' && d.info && (d.http || d.graphql || d.grpc || d.websocket);

/** The files of an OpenCollection folder (paths relative to it, `/` separated) as one bundled document. */
export function ocFilesToBundle(files: Array<{ path: string; text: string }>, name?: string): Any {
  const norm = files.map((f) => ({ path: f.path.replace(/\\/g, '/').replace(/^\.\//, ''), text: f.text }));
  const rootFile = norm.find((f) => /^opencollection\.ya?ml$/.test(f.path));
  const root: Any = rootFile ? { ...((parseYaml(rootFile.text) as Any) ?? {}) } : { opencollection: '1.0.0' };
  root.items = [];
  root.config = { ...(root.config ?? {}), environments: [...(root.config?.environments ?? [])] };
  if (name && !root.info?.name) root.info = { ...(root.info ?? {}), name };
  const dotenv = norm.find((f) => f.path === '.env');
  if (dotenv) root.extensions = { ...(root.extensions ?? {}), dotenv: dotenv.text };
  const byPath = new Map(norm.map((f) => [f.path, f] as const)); // (each folder looked through every file for its settings)
  const folders = new Map<string, Any>([['', root]]);
  const folderOf = (dir: string): Any => {
    if (folders.has(dir)) return folders.get(dir)!;
    const parent = folderOf(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '');
    const settings = byPath.get(`${dir}/folder.yml`) ?? byPath.get(`${dir}/folder.yaml`);
    const parsed = settings ? (parseYaml(settings.text) as Any) ?? {} : {};
    const folder: Any = { ...parsed, info: { name: dir.split('/').pop(), ...(parsed.info ?? {}), type: 'folder' }, items: [] };
    parent.items.push(folder);
    folders.set(dir, folder);
    return folder;
  };
  for (const f of norm.filter((x) => /\.ya?ml$/.test(x.path)).sort((a, b) => a.path.localeCompare(b.path))) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    const file = f.path.split('/').pop()!;
    if (!dir && /^opencollection\.ya?ml$/.test(file)) continue;
    if (dir === 'environments' || dir.startsWith('environments/')) {
      const e = parseYaml(f.text) as Any;
      if (e && typeof e === 'object') root.config.environments.push({ name: file.replace(/\.ya?ml$/, ''), ...e });
      continue;
    }
    if (/^folder\.ya?ml$/.test(file)) {
      folderOf(dir);
      continue;
    }
    let item: Any;
    try {
      item = parseYaml(f.text);
    } catch {
      continue;
    }
    if (isRequestFile(item)) {
      item.info = { name: file.replace(/\.ya?ml$/, ''), ...item.info };
      folderOf(dir).items.push(item);
    }
  }
  const order = (a: Any, b: Any) => {
    const fa = Array.isArray(a.items) && a.info?.type === 'folder';
    const fb = Array.isArray(b.items) && b.info?.type === 'folder';
    return fa === fb ? (a.info?.seq ?? 0) - (b.info?.seq ?? 0) || String(a.info?.name).localeCompare(String(b.info?.name)) : fa ? 1 : -1;
  };
  for (const folder of folders.values()) folder.items.sort(order);
  return root;
}

const text = (d: unknown): string | undefined => {
  const s = typeof d === 'string' ? d : typeof (d as Any)?.content === 'string' ? (d as Any).content : undefined;
  return s?.trim() ? s : undefined;
};
const rows = (list: unknown): KeyValue[] =>
  (Array.isArray(list) ? list : []).filter((x: Any) => x?.name).map((x: Any) => ({ key: normalizeTemplate(x.name), value: normalizeTemplate(x.value ?? ''), enabled: !x.disabled, ...(text(x.description) ? { description: text(x.description) } : {}) }));

/** A variable's value: a string, a typed value, or the selected one of several. */
function valueOf(v: Any): string {
  const x = Array.isArray(v.value) ? (v.value.find((s: Any) => s.selected) ?? v.value[0])?.value : v.value;
  return typeof x === 'object' && x ? String(x.data ?? '') : String(x ?? '');
}

/** The scripts of an item: before-request is the pre-request script, after-response and tests the post-response one. */
function scriptsOf(scripts: Any[] | undefined, findings: Findings, where: string): { pre?: string; post?: string } {
  const code = (types: string[]) => (scripts ?? []).filter((s) => types.includes(s.type) && String(s.code ?? '').trim()).map((s) => String(s.code));
  const other = (scripts ?? []).filter((s) => !['before-request', 'after-response', 'tests'].includes(s.type) && String(s.code ?? '').trim());
  if (other.length) findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [where], field: 'scripts', message: `"${where}": ${other.length} script${other.length > 1 ? 's' : ''} of type ${[...new Set(other.map((s) => s.type))].join(', ')} ${other.length > 1 ? 'were' : 'was'} not imported` });
  return { pre: brunoScript(...code(['before-request'])), post: brunoScript(...code(['after-response']), ...code(['tests'])) };
}

/** `runtime.assertions` as Bruno's assertion list (`res.status`, `eq 200`). */
const assertionRows = (list: Any[] | undefined) => (list ?? []).filter((a) => a?.expression).map((a) => ({ name: a.expression, value: `${a.operator ?? 'eq'} ${a.value ?? ''}`.trim(), enabled: !a.disabled }));

/** Actions of type set-variable: `res.body.token` stored in a variable after the response. */
function actionLines(actions: Any[] | undefined, phase: string): string {
  return (actions ?? [])
    .filter((a) => a?.type === 'set-variable' && !a.disabled && (a.phase ?? 'after-response') === phase && a.selector?.expression && a.variable?.name)
    .map((a) => {
      const scope = a.variable.scope === 'environment' ? 'environment' : a.variable.scope === 'collection' ? 'collectionVariables' : 'collectionVariables';
      return `tp.${scope}.set(${JSON.stringify(a.variable.name)}, ${String(a.selector.expression)});`;
    })
    .join('\n');
}

function ocSettings(s: Any | undefined): HttpSettings | undefined {
  return brunoSettings(s);
}

/** `request:` defaults of the collection and of folders: headers, auth, variables, scripts, settings. */
function defaultsOf(req: Any | undefined, where: string, findings: Findings): Partial<CollectionFolder> {
  if (!req || typeof req !== 'object') return {};
  const a = mapForeignAuth('opencollection', req.auth, where);
  findings.notes(a.notes);
  const headers = rows(req.headers);
  const variables = (Array.isArray(req.variables) ? req.variables : []).filter((v: Any) => v?.name).map((v: Any): KeyValue => ({ key: v.name, value: normalizeTemplate(valueOf(v)), enabled: !v.disabled }));
  const s = scriptsOf(req.scripts, findings, where);
  const settings = ocSettings(req.settings?.http);
  if (req.actions?.length) findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [where], field: 'actions', message: `"${where}": ${req.actions.length} folder-level action${req.actions.length > 1 ? 's were' : ' was'} not imported` });
  return {
    ...(a.auth ? { auth: a.auth } : {}),
    ...(headers.length ? { headers } : {}),
    ...(variables.length ? { variables } : {}),
    ...(s.pre ? { preRequestScript: s.pre } : {}),
    ...(s.post ? { testScript: s.post } : {}),
    ...(settings ? { settings } : {}),
  };
}

function bodyOf(raw: Any, name: string, findings: Findings): BodyConfig | undefined {
  if (!raw) return undefined;
  // several bodies to choose from: the selected one
  let b = raw;
  if (Array.isArray(raw)) {
    b = (raw.find((v: Any) => v.selected) ?? raw[0])?.body;
    if (raw.length > 1) findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [name], field: 'body', message: `"${name}": the request has ${raw.length} bodies; the selected one was imported` });
  }
  switch (b?.type) {
    case 'json':
    case 'xml':
    case 'text':
      return { type: b.type, content: normalizeTemplate(b.data ?? '') };
    case 'sparql':
      findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [name], field: 'body', message: `"${name}": the SPARQL body was imported as a text body (set the Content-Type to application/sparql-query)` });
      return { type: 'text', content: normalizeTemplate(b.data ?? '') };
    case 'form-urlencoded':
      return { type: 'form-urlencoded', fields: rows(b.data) };
    case 'multipart-form':
      return { type: 'multipart', fields: (b.data ?? []).filter((f: Any) => f.name).map((f: Any) => ({ key: f.name, value: f.type === 'file' ? [].concat(f.value ?? []).join(',') : normalizeTemplate(f.value ?? ''), kind: f.type === 'file' ? 'file' : 'text', enabled: !f.disabled, ...(f.contentType ? { contentType: f.contentType } : {}) })) };
    case 'file': {
      const f = (b.data ?? []).find((x: Any) => x.selected) ?? b.data?.[0];
      return f?.filePath ? { type: 'binary', filePath: String(f.filePath), ...(f.contentType ? { contentType: f.contentType } : {}) } : undefined;
    }
    default:
      return undefined;
  }
}

function examplesOf(list: Any[] | undefined): SavedExample[] | undefined {
  const out = (list ?? [])
    .filter((e) => e?.response)
    .map((e): SavedExample => {
      const r = e.response;
      const body = r.body ? (typeof r.body.data === 'string' ? r.body.data : JSON.stringify(r.body.data)) : '';
      return {
        id: shortId('ex-'),
        name: String(e.name || `${r.status ?? 200}`),
        status: Number(r.status) || 200,
        statusText: r.statusText || undefined,
        headers: (r.headers ?? []).map((h: Any) => ({ key: String(h.name), value: String(h.value ?? '') })),
        body,
        request: e.request?.url ? { method: e.request.method ?? 'GET', url: e.request.url, headers: (e.request.headers ?? []).map((h: Any) => ({ key: h.name, value: h.value ?? '' })), body: typeof e.request.body?.data === 'string' ? e.request.body.data : undefined } : undefined,
      };
    });
  return out.length ? out : undefined;
}

/** An OpenCollection document (bundled) → import document. */
export function parseOpenCollection(textIn: string): ImportDocument {
  const t = textIn.trim();
  const d: Any = t.startsWith('{') ? JSON.parse(t) : (parseYamlShared(t) as Any);
  const findings = new Findings();
  const doc = newDocument('opencollection', textIn, { tool: 'Bruno (OpenCollection)', version: String(d.opencollection ?? ''), scriptTool: 'bruno' });
  const savedItems: { grpc?: LibraryItem[]; websocket?: LibraryItem[] } = {};
  const convert = (items: Any[]): CollectionNode[] =>
    [...(items ?? [])].flatMap((it: Any): CollectionNode[] => {
      if (Array.isArray(it.items) || it.info?.type === 'folder') {
        const name = it.info?.name ?? 'Folder';
        const description = text(it.docs) ?? text(it.info?.description);
        return [{ kind: 'folder', id: shortId('fld-'), name, items: convert(it.items ?? []), ...(description ? { description } : {}), ...defaultsOf(it.request, name, findings) } as CollectionFolder];
      }
      const kind = it.graphql ? 'graphql' : it.http ? 'http' : it.grpc ? 'grpc' : it.websocket ? 'websocket' : undefined;
      const name = it.info?.name ?? it.http?.url ?? 'Request';
      if (kind === 'grpc' || kind === 'websocket') {
        // a gRPC call / connection of the imported collection (a library item)
        const g = (it[kind] ?? {}) as Any;
        const meta = rows(g.metadata ?? g.headers);
        const msg = g.message ?? g.messages?.[0];
        const content = typeof msg === 'string' ? msg : typeof msg?.data === 'string' ? msg.data : typeof msg?.content === 'string' ? msg.content : '';
        const url = normalizeTemplate(String(g.url ?? ''));
        if (kind === 'grpc') {
          (savedItems.grpc ??= []).push({ id: shortId('lib-'), name, data: { target: url.replace(/^grpcs?:\/\//, ''), method: String(g.method ?? '').replace(/^\//, ''), message: normalizeTemplate(content || '{}'), metadata: meta, tls: /^grpcs:/i.test(url), protoFiles: [] } });
          findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [name], message: `"${name}": the gRPC request came over as a gRPC call without its .proto file: choose the proto file again` });
        } else (savedItems.websocket ??= []).push({ id: shortId('lib-'), name, data: { url, mode: 'websocket', message: normalizeTemplate(content), headers: meta, protocols: '' } });
        return [];
      }
      if (kind !== 'http' && kind !== 'graphql') return [];
      const h = it[kind] as Any;
      const url = normalizeTemplate(h.url ?? '');
      const headers = rows(h.headers);
      const a = mapForeignAuth('opencollection', h.auth, name);
      findings.notes(a.notes);
      headers.push(...a.headers);
      const auth: AuthConfig = a.auth ?? { type: 'inherit' };
      const rt = it.runtime ?? {};
      const vars = (rt.variables ?? []).filter((v: Any) => v?.name && !v.disabled).map((v: Any) => `tp.variables.set(${JSON.stringify(v.name)}, ${JSON.stringify(normalizeTemplate(valueOf(v)))});`);
      const s = scriptsOf(rt.scripts, findings, name);
      const after = actionLines(rt.actions, 'after-response');
      const asserted = assertionRows(rt.assertions);
      const statusOnly = (a2: Any) => a2.name === 'res.status' && /^eq\s+\d{3}$/.test(a2.value);
      const checks: CheckConfig[] = asserted.filter(statusOnly).map((x) => ({ type: 'status', expected: Number(/\d{3}/.exec(x.value)![0]) }));
      const pre = brunoScript(vars.join('\n'), s.pre?.replace(/^\/\/ Bruno script[^\n]*\n/, ''));
      const post = brunoScript(after, s.post?.replace(/^\/\/ Bruno script[^\n]*\n/, ''), brunoAssertionScript(asserted.filter((x) => !statusOnly(x))));
      const description = text(it.docs) ?? text(it.info?.description);
      const settings = ocSettings(it.settings);
      if (it.examples?.length && kind === 'graphql') findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [name], field: 'examples', message: `"${name}": examples of a GraphQL request were not imported` });
      if (kind === 'graphql') {
        let variables: Any | undefined;
        try {
          variables = h.body?.variables ? JSON.parse(h.body.variables) : undefined;
        } catch {
          variables = undefined;
        }
        return [{ kind: 'graphql', id: shortId('gql-'), name, request: { endpoint: url, query: normalizeTemplate(h.body?.query ?? ''), variables, headers, auth }, ...(pre ? { preRequestScript: pre } : {}), ...(post ? { testScript: post } : {}) }];
      }
      const params = (h.params ?? []).filter((p: Any) => p?.name);
      const pathVariables = rows(params.filter((p: Any) => p.type === 'path'));
      const examples = examplesOf(it.examples);
      return [
        {
          kind: 'http',
          id: shortId('req-'),
          name,
          ...(description ? { description } : {}),
          request: {
            method: String(h.method ?? 'GET').toUpperCase(),
            url,
            params: rows(params.filter((p: Any) => p.type !== 'path')),
            ...(pathVariables.length ? { pathVariables } : {}),
            headers,
            body: bodyOf(h.body, name, findings),
            auth,
            ...(settings ? { settings } : {}),
          },
          ...(pre ? { preRequestScript: pre } : {}),
          ...(post ? { testScript: post } : {}),
          ...(checks.length ? { assertions: checks } : {}),
          ...(examples ? { examples } : {}),
        },
      ];
    });
  const name = text(d.info?.name) ?? 'OpenCollection import';
  const root = defaultsOf(d.request, name, findings);
  const description = text(d.docs) ?? text(d.info?.summary);
  const collection: Collection = collectionOf(name, convert(d.items ?? []), {
    variables: root.variables ?? [],
    ...(root.auth ? { auth: root.auth } : {}),
    ...(root.headers ? { headers: root.headers } : {}),
    ...(root.settings ? { settings: root.settings } : {}),
    ...(root.preRequestScript ? { preRequestScript: root.preRequestScript } : {}),
    ...(root.testScript ? { testScript: root.testScript } : {}),
    ...(description ? { description } : {}),
  });
  const environments: Environment[] = (d.config?.environments ?? []).map((e: Any): Environment => {
    const variables = (e.variables ?? []).filter((v: Any) => v?.name).map((v: Any) => ({ key: v.name, value: v.secret ? '' : normalizeTemplate(valueOf(v)), enabled: !v.disabled, ...(v.secret ? { secret: true } : {}) }));
    if (e.extends) findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [e.name], message: `"${e.name}": the environment extends "${e.extends}"; the inherited variables were not copied` });
    return { id: slugify(e.name ?? 'env') || 'env', name: e.name ?? 'Environment', variables, ...(e.color ? { color: e.color } : {}) };
  });
  for (const e of environments) {
    const secrets = e.variables.filter((v) => v.secret).map((v) => v.key);
    if (secrets.length) findings.add({ code: 'VALUE_NEEDED', severity: 'changed', where: [e.name], message: `Values needed: ${secrets.join(', ')} in the "${e.name}" environment (OpenCollection keeps secret values in the app, not in the files)` });
  }
  if (d.config?.proxy || d.config?.clientCertificates?.length) findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [], message: 'The collection\'s proxy and client certificate settings were not imported (set them in Settings)' });
  const secretValues = dotenvEnvironments(typeof d.extensions?.dotenv === 'string' ? d.extensions.dotenv : undefined, processEnvNames(textIn), environments, findings);
  doc.collections.push(collection);
  if (savedItems.grpc?.length || savedItems.websocket?.length) doc.savedItems = savedItems;
  doc.environments = environments;
  if (secretValues) doc.secretValues = secretValues;
  doc.findings.push(...findings.list);
  return doc;
}
