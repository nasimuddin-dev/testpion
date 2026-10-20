import type { AuthConfig, BodyConfig, Collection, CollectionNode, Environment, HttpSettings, KeyValue, SavedExample } from '../model/types.js';
import { SCHEMA_VERSION } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';
import { mapForeignAuth } from './foreign-auth.js';
import { finishDocument } from './pipeline.js';
import { Findings, newDocument, type ImportDocument } from './model.js';
import type { ImportScriptsMode, ImportScriptsSummary } from './import-scripts.js';
import { parseYaml } from '../util/lazy-yaml.js';

/** A Postman v2.0 / v2.1 collection, and its environment and globals files, as import documents. */

type Any = Record<string, any>;

type PmEvent = { listen: string; script?: { exec?: string[] | string } };
/** Script of a Postman `event` list (`prerequest` or `test`). */
function pmScript(events: PmEvent[] | undefined, listen: string): string | undefined {
  const e = (events ?? []).find((x) => x.listen === listen)?.script?.exec;
  const s = Array.isArray(e) ? e.join('\n') : e;
  return s?.trim() ? s : undefined;
}

/** Postman descriptions are a string or `{ content, type }`. */
function pmDescription(d: any): string | undefined {
  const s = typeof d === 'string' ? d : typeof d?.content === 'string' ? d.content : undefined;
  return s?.trim() ? s : undefined;
}

/** Postman saved responses (`item.response[]`) → examples. */
function pmExamples(responses: any, parent?: { method?: string; url?: string }): SavedExample[] | undefined {
  if (!Array.isArray(responses) || !responses.length) return undefined;
  return responses.map((r: any) => {
    const url0 = typeof r.originalRequest?.url === 'string' ? r.originalRequest.url : r.originalRequest?.url?.raw;
    // an original request identical to the saved request adds nothing
    const same = parent && url0 === parent.url && (r.originalRequest?.method ?? 'GET') === (parent.method ?? 'GET') && !r.originalRequest?.body;
    const o = same ? undefined : r.originalRequest;
    const url = typeof o?.url === 'string' ? o.url : o?.url?.raw;
    return {
      id: shortId('ex-'),
      name: String(r.name || `${r.code ?? ''} ${r.status ?? ''}`.trim() || 'Example'),
      status: Number(r.code) || 200,
      statusText: r.status || undefined,
      headers: (Array.isArray(r.header) ? r.header : []).map((h: any) => ({ key: String(h.key), value: String(h.value ?? '') })),
      body: typeof r.body === 'string' ? r.body : '',
      request: o && url ? { method: o.method ?? 'GET', url, headers: (o.header ?? []).map((h: any) => ({ key: h.key, value: h.value ?? '' })), body: o.body?.mode === 'raw' ? o.body.raw : undefined } : undefined,
    };
  });
}

/** What Postman's `protocolProfileBehavior` has that a request setting of TestPion does not (listed in the report, never dropped silently). */
const BEHAVIOR_DROPPED = ['disableBodyPruning', 'disabledSystemHeaders', 'insecureHTTPParser', 'tlsPreferServerCiphers', 'tlsCipherSelection', 'removeRefererHeaderOnRedirect'];

/** `protocolProfileBehavior` (on a request, folder or collection) as TestPion's request settings. */
function pmSettings(b: Any | undefined, where: string, findings: Findings): HttpSettings | undefined {
  if (!b || typeof b !== 'object') return undefined;
  const s: HttpSettings = {};
  if (b.followRedirects === false) s.followRedirects = false;
  if (typeof b.maxRedirects === 'number') s.maxRedirects = b.maxRedirects;
  if (b.strictSSL === false) s.insecure = true;
  if (b.disableCookies === true) s.disableCookieJar = true;
  if (b.followOriginalHttpMethod === true) s.followOriginalMethod = true;
  if (b.followAuthorizationHeader === true) s.followAuthorizationHeader = true;
  if (b.removeRefererHeaderOnRedirect === true) s.removeRefererOnRedirect = true;
  if (b.disableUrlEncoding === true) s.encodeUrl = false;
  if (b.protocolVersion === 'http1') s.http1Only = true;
  // "TLS protocols disabled during handshake": the oldest version that is still allowed
  if (Array.isArray(b.tlsDisabledProtocols) && b.tlsDisabledProtocols.length) {
    const order = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'] as const;
    const min = order.find((v) => !b.tlsDisabledProtocols.includes(v));
    if (min && min !== 'TLSv1') s.tlsMinVersion = min;
  }
  const dropped = BEHAVIOR_DROPPED.filter((k) => k !== 'removeRefererHeaderOnRedirect' && b[k] !== undefined && b[k] !== false);
  if (dropped.length) findings.add({ code: 'SETTING_DROPPED', severity: 'changed', where: [where], field: 'settings', message: `"${where}": Postman setting${dropped.length > 1 ? 's' : ''} ${dropped.join(', ')} ${dropped.length > 1 ? 'have' : 'has'} no TestPion equivalent and ${dropped.length > 1 ? 'were' : 'was'} not imported` });
  return Object.keys(s).length ? s : undefined;
}

/** Postman v2.1 / v2.0 → document. `{{vault:x}}` references and mock-server URLs are reported. */
export function parsePostman(text: string): ImportDocument {
  const d = JSON.parse(text);
  const findings = new Findings();
  const version = /\/v?(\d+\.\d+(?:\.\d+)?)\//.exec(String(d.info?.schema ?? ''))?.[1];
  const doc = newDocument('postman', text, { tool: 'Postman', ...(version ? { version } : {}), scriptTool: 'postman' });

  /** The item's auth (undefined: inherits); an unsupported scheme adds a note and, for a request, a disabled placeholder header. */
  const authOf = (raw: unknown, where: string, headers?: KeyValue[]): AuthConfig | undefined => {
    const a = mapForeignAuth('postman', raw, where);
    findings.notes(a.notes);
    headers?.push(...a.headers);
    return a.auth;
  };
  const convert = (items: any[]): CollectionNode[] =>
    (items ?? []).map((it: any): CollectionNode => {
      if (Array.isArray(it.item)) {
        const variables: KeyValue[] = (it.variable ?? []).filter((v: any) => v.key).map((v: any) => ({ key: v.key, value: String(v.value ?? ''), enabled: !v.disabled }));
        const settings = pmSettings(it.protocolProfileBehavior, it.name ?? 'Folder', findings);
        const description = pmDescription(it.description);
        const fid = shortId('fld-');
        if (it.id) (doc.sourceIds ??= {})[fid] = String(it.id);
        return {
          kind: 'folder',
          id: fid,
          name: it.name,
          items: convert(it.item),
          auth: authOf(it.auth, it.name ?? 'Folder'),
          ...(description ? { description } : {}),
          ...(settings ? { settings } : {}),
          ...(variables.length ? { variables } : {}),
          ...(pmScript(it.event, 'prerequest') ? { preRequestScript: pmScript(it.event, 'prerequest') } : {}),
          ...(pmScript(it.event, 'test') ? { testScript: pmScript(it.event, 'test') } : {}),
        };
      }
      const r = typeof it.request === 'string' ? { url: it.request } : it.request ?? {};
      const url = typeof r.url === 'string' ? r.url : r.url?.raw ?? '';
      const [base, qs] = url.split('?');
      const params: KeyValue[] = (r.url?.query ?? []).map((q: any) => ({ key: q.key, value: q.value ?? '', enabled: !q.disabled, ...(q.description ? { description: pmDescription(q.description) } : {}) }));
      const pathVariables: KeyValue[] = (r.url?.variable ?? []).filter((v: any) => v.key).map((v: any) => ({ key: v.key, value: String(v.value ?? ''), ...(v.description ? { description: pmDescription(v.description) } : {}) }));
      // v2.0 also allows headers as one "Name: value" string per line
      const rawHeaders = typeof r.header === 'string' ? r.header.split(/\r?\n/).filter((l: string) => l.includes(':')).map((l: string) => ({ key: l.slice(0, l.indexOf(':')).trim(), value: l.slice(l.indexOf(':') + 1).trim() })) : r.header;
      const headers: KeyValue[] = (rawHeaders ?? []).map((h: any) => ({ key: h.key, value: h.value ?? '', enabled: !h.disabled, ...(h.description ? { description: pmDescription(h.description) } : {}) }));
      const auth = authOf(r.auth, it.name ?? url, headers) ?? { type: 'inherit' as const };
      if (r.body?.mode === 'graphql') {
        const g = r.body.graphql ?? {};
        const gid = shortId('gql-');
        if (it.id) (doc.sourceIds ??= {})[gid] = String(it.id);
        return {
          kind: 'graphql',
          id: gid,
          name: it.name ?? url,
          request: { endpoint: url, query: g.query ?? '', variables: typeof g.variables === 'string' && g.variables.trim() ? g.variables : undefined, headers, auth },
          ...(pmScript(it.event, 'prerequest') ? { preRequestScript: pmScript(it.event, 'prerequest') } : {}),
          ...(pmScript(it.event, 'test') ? { testScript: pmScript(it.event, 'test') } : {}),
        };
      }
      let body: BodyConfig | undefined;
      if (r.body?.disabled === true && r.body.mode) findings.add({ code: 'NOT_IMPORTED', severity: 'not-imported', where: [it.name ?? url], field: 'body', message: `"${it.name ?? url}": the body is switched off in Postman (disabled) and was not imported` });
      else if (r.body?.mode === 'raw') {
        const lang = r.body.options?.raw?.language;
        body = { type: lang === 'json' || (!lang && /^\s*[{[]/.test(r.body.raw ?? '')) ? 'json' : lang === 'xml' ? 'xml' : lang === 'html' ? 'html' : 'text', content: r.body.raw ?? '' };
      } else if (r.body?.mode === 'urlencoded') body = { type: 'form-urlencoded', fields: r.body.urlencoded.map((f: any) => ({ key: f.key, value: f.value ?? '', enabled: !f.disabled })) };
      else if (r.body?.mode === 'formdata')
        body = {
          type: 'multipart',
          fields: r.body.formdata.map((f: any) => {
            // several files in one field (src is an array): the first one, the others are reported
            const files = Array.isArray(f.src) ? f.src : undefined;
            if (files && files.length > 1) findings.add({ code: 'NOT_IMPORTED', severity: 'changed', where: [it.name ?? url], field: 'body', message: `"${it.name ?? url}": the form field "${f.key}" has ${files.length} files; only the first was imported` });
            return { key: f.key, value: f.type === 'file' ? (files ? files[0] ?? '' : f.src ?? '') : f.value ?? '', kind: f.type === 'file' ? 'file' : 'text', enabled: !f.disabled, ...(f.contentType ? { contentType: f.contentType } : {}) };
          }),
        };
      else if (r.body?.mode === 'file' && r.body.file?.src) body = { type: 'binary', filePath: r.body.file.src };
      const settings = pmSettings(it.protocolProfileBehavior, it.name ?? url, findings);
      const rid = shortId('req-');
      if (it.id) (doc.sourceIds ??= {})[rid] = String(it.id);
      return {
        kind: 'http',
        id: rid,
        name: it.name ?? url,
        request: {
          method: r.method ?? 'GET',
          url: params.length ? base! : qs ? url : base!,
          params,
          ...(pathVariables.length ? { pathVariables } : {}),
          headers,
          body,
          auth,
          ...(settings ? { settings } : {}),
        },
        description: pmDescription(r.description ?? it.description),
        preRequestScript: pmScript(it.event, 'prerequest'),
        testScript: pmScript(it.event, 'test'),
        examples: pmExamples(it.response, { method: r.method, url }),
      };
    });
  const items = convert(d.item);
  const collectionSettings = pmSettings(d.protocolProfileBehavior, d.info?.name ?? 'Postman import', findings);
  const collection: Collection = {
    schemaVersion: SCHEMA_VERSION,
    id: slugify(d.info?.name ?? 'Postman import') + '-' + shortId().slice(-4),
    name: d.info?.name ?? 'Postman import',
    version: 0,
    items,
    updatedAt: new Date().toISOString(),
    description: pmDescription(d.info?.description),
    variables: (d.variable ?? []).map((v: any) => ({ key: v.key, value: String(v.value ?? ''), enabled: !v.disabled })),
    auth: authOf(d.auth, d.info?.name ?? 'Postman import'),
    ...(collectionSettings ? { settings: collectionSettings } : {}),
    preRequestScript: pmScript(d.event, 'prerequest'),
    testScript: pmScript(d.event, 'test'),
  };
  doc.collections.push(collection);
  if (d.info?._postman_id) doc.sourceKey = String(d.info._postman_id);
  // Postman Vault: the export carries the reference, never the secret
  const vault = [...new Set([...text.matchAll(/\{\{vault:([^}]+)\}\}/g)].map((m) => m[1]!.trim()))];
  for (const name of vault) findings.add({ code: 'VALUE_NEEDED', severity: 'changed', where: [], message: `Values needed: Postman Vault secret "${name}" (the export holds only the reference {{vault:${name}}}): create a secret variable ${name} and use {{${name}}}` });
  const mocks = (text.match(/https?:\/\/[\w.-]+\.mock\.pstmn\.io/g) ?? []).length;
  if (mocks) findings.add({ code: 'NOTE', severity: 'info', where: [], message: `${mocks} URL${mocks === 1 ? ' points' : 's point'} at a Postman mock server (*.mock.pstmn.io): the mock is not exported; TestPion's mock server serves the saved examples (Collection ▸ Mock)`, reportOnly: true });
  doc.findings.push(...findings.list);
  return doc;
}

/**
 * A Postman v2 / v2.1 collection. Its `pm.*` scripts become `tp.*` unless `scripts` is `'keep'`
 * (`pm.*` still runs: it is an alias of `tp`).
 */
export function importPostman(text: string, opts: { scripts?: ImportScriptsMode } = {}): { collection: Collection; scripts: ImportScriptsSummary; notes: string[] } {
  const doc = finishDocument(parsePostman(text), { scripts: opts.scripts });
  return { collection: doc.collections[0]!, scripts: doc.scripts ?? { converted: 0, unchanged: [] }, notes: doc.findings.filter((f) => !f.reportOnly).map((f) => f.message) };
}

/** A Postman environment (or globals) file: secret values go to the secret store, the ones the file does not hold are listed as values needed. */
export function parsePostmanEnvironment(text: string): ImportDocument {
  // (a JSON file of the app, or the YAML environment / globals file of Postman's Git integration)
  const t = text.trim();
  const d = t.startsWith('{') ? JSON.parse(t) : parseYaml(t);
  const id = slugify(d.name ?? 'imported');
  const doc = newDocument('postman-env', text, { tool: 'Postman' });
  // the globals file: values for the workspace's globals (on this computer), not an environment
  if (d._postman_variable_scope === 'globals') {
    const globals: NonNullable<ImportDocument['globals']> = [];
    const needed: string[] = [];
    for (const v of d.values ?? []) {
      if (!v?.key || v.enabled === false) continue;
      const secret = v.type === 'secret';
      if (secret && !v.value) needed.push(String(v.key));
      else globals.push({ key: String(v.key), value: String(v.value ?? ''), ...(secret ? { secret: true } : {}) });
    }
    doc.globals = globals;
    if (needed.length) doc.findings.push({ code: 'VALUE_NEEDED', severity: 'changed', where: [], message: `Values needed: ${needed.join(', ')} (secret globals: Postman keeps their values in the app, not in the export)` });
    return doc;
  }
  const secrets: Record<string, string> = {};
  const needed: string[] = [];
  const variables = (d.values ?? []).map((v: any) => {
    const secret = v.type === 'secret';
    if (secret) {
      if (v.value) secrets[v.key] = String(v.value);
      else needed.push(v.key);
    }
    return { key: v.key, value: secret ? '' : String(v.value ?? ''), secret, enabled: v.enabled !== false };
  });
  doc.environments.push({ id, name: d.name ?? 'Imported', variables });
  if (Object.keys(secrets).length) doc.secretValues = { [id]: secrets };
  if (needed.length) doc.findings.push({ code: 'VALUE_NEEDED', severity: 'changed', where: [d.name ?? 'Imported'], message: `Values needed: ${needed.join(', ')} in the "${d.name ?? 'Imported'}" environment (Postman keeps secret values in the app, not in the export)` });
  return doc;
}

export function importPostmanEnvironment(text: string): Environment {
  return parsePostmanEnvironment(text).environments[0]!;
}
