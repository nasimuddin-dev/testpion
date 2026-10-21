import type { BodyConfig, CheckConfig, Collection, CollectionFolder, CollectionNode, Environment, EnvironmentVariable, HttpSettings, LibraryItem, SavedExample } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';
import { bruFilesToBrunoExport, looksLikeBru } from './bru.js';
import { brunoAssertionScript } from '../scripts/bruno.js';
import { mapForeignAuth } from './foreign-auth.js';
import { normalizeTemplate } from './templates.js';
import { parseDotenv } from './dotenv.js';
import { Findings, newDocument, type ImportDocument } from './model.js';
import { collectionOf, kv, type Any } from './import-helpers.js';
import { finishDocument } from './pipeline.js';
import type { ImportScriptsMode, ImportScriptsSummary } from './import-scripts.js';

/**
 * Bruno (collection export JSON, a single .bru request, a collection folder read by bru.ts) as an import document.
 * Folder and collection headers stay folder and collection headers. Scripts keep Bruno's `bru.*` / `req` / `res` API
 * with a marker line: the pipeline rewrites `bru.*` to `tp.*`, `req` / `res` / `test` / `expect` run through the shim.
 */

/** Bruno assertions like `res.status: eq 200` become status checks; others become generated tests. */
function brunoAssertions(list: Any[] | undefined): CheckConfig[] | undefined {
  const out: CheckConfig[] = [];
  for (const a of list ?? []) {
    if (a.enabled === false) continue;
    const m = /^eq\s+(\d{3})$/.exec(String(a.value ?? '').trim());
    if (a.name === 'res.status' && m) out.push({ type: 'status', expected: Number(m[1]) });
  }
  return out.length ? out : undefined;
}

/** Bruno response examples (`example` blocks of a .bru file, `examples` of an export) as saved examples. */
function brunoExamples(list: Any[] | undefined): SavedExample[] | undefined {
  const out = (list ?? [])
    .filter((e) => e?.response)
    .map((e): SavedExample => {
      const r = e.response;
      const q = e.request;
      const content = r.body?.content;
      return {
        id: shortId('ex-'),
        name: String(e.name || `${r.status ?? 200}`),
        status: Number(r.status) || 200,
        ...(r.statusText ? { statusText: String(r.statusText) } : {}),
        headers: (r.headers ?? []).filter((h: Any) => h?.name).map((h: Any) => ({ key: String(h.name), value: String(h.value ?? '') })),
        body: typeof content === 'string' ? content : content === undefined ? '' : JSON.stringify(content),
        ...(q?.url ? { request: { method: String(q.method ?? 'GET').toUpperCase(), url: String(q.url), headers: (q.headers ?? []).filter((h: Any) => h?.name).map((h: Any) => ({ key: String(h.name), value: String(h.value ?? '') })), ...(typeof q.body?.content === 'string' ? { body: q.body.content } : {}) } } : {}),
      };
    });
  return out.length ? out : undefined;
}

/** A Bruno gRPC / WebSocket request as a library item (the imported collection's gRPC call / connection). */
function realtimeItem(it: Any, folder: string | undefined): { kind: 'grpc' | 'websocket'; item: LibraryItem } {
  const r = it.request ?? {};
  const meta = (r.headers ?? []).filter((h: Any) => h?.name).map((h: Any) => ({ key: String(h.name), value: normalizeTemplate(h.value ?? ''), enabled: h.enabled !== false }));
  if (it.type === 'grpc-request') {
    const url = normalizeTemplate(String(r.url ?? ''));
    const first = r.body?.grpc?.[0]?.content;
    return { kind: 'grpc', item: { id: shortId('lib-'), name: String(it.name || 'gRPC call'), folder, data: { target: url.replace(/^grpcs?:\/\//, ''), method: String(r.method ?? '').replace(/^\//, ''), message: normalizeTemplate(typeof first === 'string' ? first : '{}'), metadata: meta, tls: /^grpcs:/i.test(url), protoFiles: [] } } };
  }
  const first = r.body?.ws?.[0]?.content;
  return { kind: 'websocket', item: { id: shortId('lib-'), name: String(it.name || 'WebSocket'), folder, data: { url: normalizeTemplate(String(r.url ?? '')), mode: 'websocket', message: normalizeTemplate(typeof first === 'string' ? first : ''), headers: meta, protocols: '' } } };
}

/** The first line of every imported Bruno script: it also loads the shim that runs Bruno's req / res / test (scripts/bruno.ts). */
export const BRUNO_HEADER = "// Bruno script: converted to tp.* (bru, req, res, test and expect; TODO(import) marks what has no equivalent)";

/** A Bruno script: its `bru.*`, `req.*` and `res.*` are rewritten to `tp.*` afterwards (scripts/convert); the shim (scripts/bruno.ts) still runs what is left. */
export function brunoScript(...parts: Array<string | undefined>): string | undefined {
  const s = parts.map((p) => String(p ?? '').trim()).filter(Boolean).join('\n\n');
  return s ? `${BRUNO_HEADER}\n${s}` : undefined;
}

/** A request's vars:pre-request (request variables) and vars:post-response (values taken from the response). */
function brunoVars(vars: Any | undefined): { pre?: string; post?: string } {
  const on = (l: Any[] | undefined) => (l ?? []).filter((v: Any) => v?.name && v.enabled !== false);
  const pre = on(vars?.req).map((v: Any) => `tp.variables.set(${JSON.stringify(v.name)}, ${JSON.stringify(normalizeTemplate(v.value ?? ''))});`);
  // post-response values are expressions over res, e.g. res.body.token (runtime variables: they last for the run, like Bruno's)
  const post = on(vars?.res).map((v: Any) => `tp.collectionVariables.set(${JSON.stringify(v.name)}, ${String(v.value ?? 'undefined')});`);
  return { pre: pre.join('\n') || undefined, post: post.join('\n') || undefined };
}

/** Request settings of a .bru `settings` block / OpenCollection `settings`. */
export function brunoSettings(s: Any | undefined): HttpSettings | undefined {
  if (!s || typeof s !== 'object') return undefined;
  const out: HttpSettings = {};
  if (s.encodeUrl === false || s.encodeUrl === 'false') out.encodeUrl = false;
  if (s.followRedirects === false || s.followRedirects === 'false') out.followRedirects = false;
  if (typeof s.maxRedirects === 'number') out.maxRedirects = s.maxRedirects;
  if (s.forwardAuthorizationHeader === true || s.forwardAuthorizationHeader === 'true') out.followAuthorizationHeader = true;
  const timeout = Number(s.timeout);
  if (Number.isFinite(timeout) && timeout > 0 && s.timeout !== 'inherit') out.timeoutMs = timeout;
  return Object.keys(out).length ? out : undefined;
}

/** Folder and collection settings (Bruno's folder.bru / collection.bru "root"): auth, headers, variables, scripts. */
function brunoRoot(root: Any | undefined, where: string, findings: Findings): Partial<CollectionFolder> {
  const r = root?.request;
  if (!r) return {};
  const vars = brunoVars(r.vars);
  const pre = brunoScript(r.script?.req);
  const post = brunoScript(vars.post, r.script?.res, r.tests);
  const variables = kv(r.vars?.req, 'name', (x) => x.enabled !== false);
  const headers = kv(r.headers, 'name', (x) => x.enabled !== false);
  const a = mapForeignAuth('bruno', r.auth, where);
  findings.notes(a.notes);
  const description = String(root.docs ?? '').trim();
  return {
    ...(a.auth ? { auth: a.auth } : {}),
    ...(headers.length ? { headers } : {}),
    ...(variables.length ? { variables } : {}),
    ...(pre ? { preRequestScript: pre } : {}),
    ...(post ? { testScript: post } : {}),
    ...(description ? { description } : {}),
  };
}

/**
 * The collection's .env file (read by readBrunoFolder / the app's folder picker) and every `{{process.env.X}}` /
 * `bru.getProcessEnv('X')`: the values become secret variables (values for the secret store, never workspace files)
 * of a "Bruno .env" environment and of each imported environment (whichever is active, `{{X}}` resolves).
 * Names without a value are listed as values needed.
 */
export function dotenvEnvironments(dotenv: string | undefined, used: Set<string>, environments: Environment[], findings: Findings): Record<string, Record<string, string>> | undefined {
  const values = new Map(typeof dotenv === 'string' ? parseDotenv(dotenv).map((e) => [e.key, e.value] as const) : []);
  const names = [...new Set([...values.keys(), ...used])];
  if (!names.length) return undefined;
  const env: Environment = { id: 'bruno-env', name: 'Bruno .env', variables: [] };
  const secretValues: Record<string, Record<string, string>> = {};
  for (const e of [env, ...environments]) {
    const has = new Set(e.variables.map((v) => v.key));
    const added = names.filter((n) => !has.has(n));
    e.variables.push(...added.map((key): EnvironmentVariable => ({ key, value: '', secret: true, enabled: true })));
    const set = Object.fromEntries(added.filter((n) => values.get(n)).map((n) => [n, values.get(n)!]));
    if (Object.keys(set).length) secretValues[e.id] = set;
  }
  environments.push(env);
  const stored = names.filter((n) => values.get(n));
  if (stored.length) findings.add({ code: 'SECRET_VALUES', severity: 'info', where: [], message: `.env: ${stored.length} value${stored.length > 1 ? 's' : ''} (${stored.join(', ')}) became secret variables of the "Bruno .env" environment and of each imported environment ({{process.env.X}} is now {{X}}); the values go to the secret store, never into workspace files` });
  const missing = names.filter((n) => !values.get(n));
  if (missing.length) findings.add({ code: 'VALUE_NEEDED', severity: 'changed', where: [], message: `Values needed: ${missing.join(', ')} (${typeof dotenv === 'string' ? 'used as process.env but not set in the .env file' : "used as process.env; import the collection folder with its .env file, or set them"}) in the "Bruno .env" environment` });
  return Object.keys(secretValues).length ? secretValues : undefined;
}

/** The names a text uses as `{{process.env.X}}` or `bru.getProcessEnv('X')`. */
export function processEnvNames(text: string): Set<string> {
  const used = new Set<string>();
  for (const m of text.matchAll(/process\.env\.([A-Za-z_][\w.-]*)|getProcessEnv\(\s*\\?["']([A-Za-z_][\w.-]*)\\?["']/g)) used.add(m[1] ?? m[2]!);
  return used;
}

/** Bruno JSON export / .bru file → document. */
export function parseBruno(text: string): ImportDocument {
  // a single .bru request file, or a Bruno JSON export
  const d: Any = looksLikeBru(text) ? bruFilesToBrunoExport([{ path: 'request.bru', text }], 'Bruno import') : JSON.parse(text);
  const findings = new Findings();
  const doc = newDocument('bruno', text, { tool: 'Bruno', scriptTool: 'bruno' });
  const saved: { grpc: LibraryItem[]; websocket: LibraryItem[] } = { grpc: [], websocket: [] };
  const convert = (items: Any[], path: string[] = []): CollectionNode[] =>
    [...(items ?? [])]
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .flatMap((it: Any): CollectionNode[] => {
        if (it.type === 'folder') return [{ kind: 'folder', id: shortId('fld-'), name: it.name ?? 'Folder', items: convert(it.items, [...path, it.name ?? 'Folder']), ...brunoRoot(it.root, it.name ?? 'Folder', findings) } as CollectionFolder];
        const r = it.request ?? {};
        const url = normalizeTemplate(r.url);
        const name = it.name || url;
        if (it.type === 'grpc-request' || it.type === 'ws-request') {
          const r2 = realtimeItem(it, path.join(' / ') || undefined);
          saved[r2.kind].push(r2.item);
          if (r2.kind === 'grpc') findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [name], message: `"${name}": the Bruno gRPC request came over as a gRPC call without its .proto file${r.protoPath ? ` (${r.protoPath})` : ''}: choose the proto file again` });
          return [];
        }
        if (it.type !== 'http-request' && it.type !== 'graphql-request') {
          findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [name], message: `"${name}": a Bruno ${String(it.type ?? 'item').replace(/-request$/, '')} request is not imported yet` });
          return [];
        }
        const headers = kv(r.headers, 'name', (x) => x.enabled !== false);
        const a = mapForeignAuth('bruno', r.auth, name);
        findings.notes(a.notes);
        headers.push(...a.headers);
        const auth = a.auth ?? { type: 'inherit' as const };
        const examples = it.type === 'http-request' ? brunoExamples(r.examples ?? it.examples) : undefined;
        const exampleCount = (r.examples ?? it.examples ?? []).length;
        if (it.type === 'http-request' && exampleCount > (examples?.length ?? 0)) {
          const n = exampleCount - (examples?.length ?? 0);
          findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [name], field: 'examples', message: `"${name}": ${n} Bruno response example${n > 1 ? 's' : ''} had no response and ${n > 1 ? 'were' : 'was'} not imported` });
        }
        if (it.type === 'graphql-request' && (r.examples?.length || it.examples?.length)) findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [name], field: 'examples', message: `"${name}": the response examples of a GraphQL request were not imported` });
        const settings = brunoSettings(r.settings ?? it.settings);
        if (it.type === 'graphql-request') {
          const gPre = brunoScript(brunoVars(r.vars).pre, r.script?.req);
          const gPost = brunoScript(brunoVars(r.vars).post, r.script?.res, brunoAssertionScript(r.assertions ?? []), r.tests);
          let variables: Any | undefined;
          try {
            variables = r.body?.graphql?.variables ? JSON.parse(r.body.graphql.variables) : undefined;
          } catch {
            variables = undefined;
          }
          return [{ kind: 'graphql', id: shortId('gql-'), name, request: { endpoint: url, query: normalizeTemplate(r.body?.graphql?.query ?? ''), variables, headers, auth }, ...(gPre ? { preRequestScript: gPre } : {}), ...(gPost ? { testScript: gPost } : {}) }];
        }
        const b = r.body ?? {};
        let body: BodyConfig | undefined =
          b.mode === 'json' ? { type: 'json', content: normalizeTemplate(b.json ?? '') }
          : b.mode === 'xml' ? { type: 'xml', content: normalizeTemplate(b.xml ?? '') }
          : b.mode === 'text' ? { type: 'text', content: normalizeTemplate(b.text ?? '') }
          : b.mode === 'formUrlEncoded' ? { type: 'form-urlencoded', fields: kv(b.formUrlEncoded, 'name', (x) => x.enabled !== false) }
          : b.mode === 'multipartForm' ? { type: 'multipart', fields: (b.multipartForm ?? []).filter((f: Any) => f.name).map((f: Any) => ({ key: f.name, value: f.type === 'file' ? [].concat(f.value ?? []).join(',') : normalizeTemplate(f.value ?? ''), kind: f.type === 'file' ? 'file' : 'text', enabled: f.enabled !== false })) }
          : undefined;
        // SPARQL is a query sent as text; a file body picks the file the request selected
        if (!body && b.mode === 'sparql') {
          body = { type: 'text', content: normalizeTemplate(b.sparql ?? '') };
          findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [name], field: 'body', message: `"${name}": the Bruno SPARQL body was imported as a text body (set the Content-Type to application/sparql-query)` });
        } else if (!body && b.mode === 'file') {
          const file = (Array.isArray(b.file) ? b.file : []).find((f: Any) => f.selected) ?? (Array.isArray(b.file) ? b.file[0] : undefined);
          if (file?.filePath) body = { type: 'binary', filePath: String(file.filePath), ...(file.contentType ? { contentType: String(file.contentType) } : {}) };
        }
        if (b.mode && b.mode !== 'none' && !body) findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [name], field: 'body', message: `"${name}": the Bruno body type "${b.mode}" is not imported yet` });
        const params = (r.params ?? []) as Any[];
        const vars = brunoVars(r.vars);
        // assertions other than a plain status check become tests
        const asserted = (r.assertions ?? []).filter((x: Any) => !(x.name === 'res.status' && /^eq\s+\d{3}$/.test(String(x.value ?? '').trim())));
        const pre = brunoScript(vars.pre, r.script?.req);
        const post = brunoScript(vars.post, r.script?.res, brunoAssertionScript(asserted), r.tests);
        const pathVariables = kv(params.filter((p) => p.type === 'path'), 'name', (x) => x.enabled !== false);
        return [
          {
            kind: 'http',
            id: shortId('req-'),
            name,
            ...(r.docs ? { description: String(r.docs) } : {}),
            request: {
              method: String(r.method ?? 'GET').toUpperCase(),
              // query parameters are listed separately, so the URL keeps only its path
              url: params.some((p) => p.type !== 'path') ? url.split('?')[0]! : url,
              params: kv(params.filter((p) => p.type !== 'path'), 'name', (x) => x.enabled !== false),
              ...(pathVariables.length ? { pathVariables } : {}),
              headers,
              body,
              auth,
              ...(settings ? { settings } : {}),
            },
            ...(pre ? { preRequestScript: pre } : {}),
            ...(post ? { testScript: post } : {}),
            ...(brunoAssertions(r.assertions) ? { assertions: brunoAssertions(r.assertions) } : {}),
            ...(examples ? { examples } : {}),
          },
        ];
      });
  const environments: Environment[] = (d.environments ?? []).map((e: Any) => ({
    id: slugify(e.name ?? 'env') || 'env',
    name: e.name ?? 'Environment',
    // secret values stay out of workspace files: they become empty secret variables
    variables: (e.variables ?? []).filter((v: Any) => v.name).map((v: Any) => ({ key: v.name, value: v.secret ? '' : normalizeTemplate(v.value ?? ''), enabled: v.enabled !== false, ...(v.secret ? { secret: true } : {}) })),
  }));
  for (const e of environments) {
    const secrets = e.variables.filter((v) => v.secret).map((v) => v.key);
    if (secrets.length) findings.add({ code: 'VALUE_NEEDED', severity: 'changed', where: [e.name], message: `Values needed: ${secrets.join(', ')} in the "${e.name}" environment (Bruno keeps secret values in the app, not in the export)` });
  }
  const collectionName = d.name ?? 'Bruno import';
  const root = brunoRoot(d.root, collectionName, findings);
  const items = convert(d.items);
  const collection: Collection = collectionOf(collectionName, items, {
    variables: root.variables ?? [],
    ...(root.auth ? { auth: root.auth } : {}),
    ...(root.headers ? { headers: root.headers } : {}),
    ...(root.preRequestScript ? { preRequestScript: root.preRequestScript } : {}),
    ...(root.testScript ? { testScript: root.testScript } : {}),
    ...(root.description ? { description: root.description } : {}),
  });
  doc.collections.push(collection);
  if (saved.grpc.length || saved.websocket.length) doc.savedItems = { ...(saved.grpc.length ? { grpc: saved.grpc } : {}), ...(saved.websocket.length ? { websocket: saved.websocket } : {}) };
  const secretValues = dotenvEnvironments(typeof d.dotenv === 'string' ? d.dotenv : undefined, processEnvNames(text), environments, findings);
  doc.environments = environments;
  if (secretValues) doc.secretValues = secretValues;
  doc.findings.push(...findings.list);
  return doc;
}

export function importBruno(text: string, opts: { scripts?: ImportScriptsMode } = {}): { collection: Collection; environments: Environment[]; scripts: ImportScriptsSummary; notes: string[]; secretValues?: Record<string, Record<string, string>> } {
  const doc = finishDocument(parseBruno(text), { scripts: opts.scripts });
  return {
    collection: doc.collections[0]!,
    environments: doc.environments,
    scripts: doc.scripts ?? { converted: 0, unchanged: [] },
    notes: doc.findings.filter((f) => !f.reportOnly).map((f) => f.message),
    ...(doc.secretValues ? { secretValues: doc.secretValues } : {}),
  };
}
