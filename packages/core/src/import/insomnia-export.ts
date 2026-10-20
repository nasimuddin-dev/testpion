import type { AuthConfig, BodyConfig, Collection, CollectionNode, Environment, HttpSettings, KeyValue, SavedGraphQLRequest, SavedHttpRequest } from '../model/types.js';
import { retargetScript } from '../scripts/convert/retarget.js';
import { stringifyYaml } from '../util/lazy-yaml.js';
import { assertionsToTests, joinScripts, pushCollectionDefaultsDown, stableId } from './export-common.js';

/**
 * Export a collection as an Insomnia file: **v5 YAML** (what Insomnia 10+ exports and imports; `collection.insomnia.rest/5.0`)
 * or the older **v4 JSON** (`_type: export`, flat `resources`). Folders keep their headers, auth, variables and scripts;
 * `{{x}}` becomes `{{ _.x }}` and the dynamic variables become template tags (`{{$guid}}` → `{% uuid 'v4' %}`); `tp.*` scripts
 * become `insomnia.*`, and TestPion's assertions become `insomnia.test` code. What Insomnia has no place for (examples,
 * JWT and EdgeGrid auth, the collection's own headers / scripts) is copied where it can be or listed in the notes.
 * The importer reads everything written here back (the round trip is tested).
 */

type Any = Record<string, any>;

/** `{{name}}` → `{{ _.name }}`, dynamic variables → tags. */
export function toInsomniaTemplate(s: string | undefined, notes?: Set<string>): string {
  return String(s ?? '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (all, name: string) => {
    if (name === '$guid' || name === '$uuid' || name === '$randomUUID') return "{% uuid 'v4' %}";
    if (name === '$timestamp') return "{% now 'unix' %}";
    if (name === '$timestampMs') return "{% now 'millis' %}";
    if (name === '$isoTimestamp') return "{% now 'iso-8601' %}";
    if (/^\$random[A-Z]\w*$/.test(name)) return `{% faker '${name.slice(1)}' %}`;
    if (name.startsWith('$')) {
      notes?.add(`{{${name}}} has no Insomnia tag and stays as written`);
      return all;
    }
    return /^[A-Za-z_][\w]*$/.test(name) ? `{{ _.${name} }}` : `{{ _['${name}'] }}`;
  });
}

function authOf(a: AuthConfig | undefined, notes: Set<string>, where: string, t: (s: string | undefined) => string): Any | undefined {
  if (!a || a.type === 'inherit') return undefined;
  switch (a.type) {
    case 'none':
      return { type: 'none' };
    case 'bearer':
      return { type: 'bearer', token: t(a.token), ...(a.prefix ? { prefix: a.prefix } : {}), disabled: false };
    case 'basic':
      return { type: 'basic', username: t(a.username), password: t(a.password), useISO88591: false, disabled: false };
    case 'apiKey':
      return { type: 'apikey', key: t(a.key), value: t(a.value), addTo: a.in === 'query' ? 'queryParams' : 'header', disabled: false };
    case 'digest':
      return { type: 'digest', username: t(a.username), password: t(a.password), disabled: false };
    case 'oauth1':
      return { type: 'oauth1', signatureMethod: a.signatureMethod ?? 'HMAC-SHA1', consumerKey: t(a.consumerKey), consumerSecret: t(a.consumerSecret), tokenKey: t(a.token), tokenSecret: t(a.tokenSecret), realm: a.realm ?? '', disabled: false };
    case 'oauth2':
      return {
        type: 'oauth2',
        grantType: a.grantType,
        accessTokenUrl: t(a.tokenUrl),
        authorizationUrl: t(a.authUrl),
        clientId: t(a.clientId),
        clientSecret: t(a.clientSecret),
        scope: t(a.scope),
        username: t(a.username),
        password: t(a.password),
        usePkce: !!a.usePkce,
        disabled: false,
      };
    case 'awsv4':
      return { type: 'iam', accessKeyId: t(a.accessKey), secretAccessKey: t(a.secretKey), sessionToken: t(a.sessionToken), region: t(a.region), service: t(a.service), disabled: false };
    case 'ntlm':
      return { type: 'ntlm', username: t(a.username), password: t(a.password), disabled: false };
    case 'hawk':
      return { type: 'hawk', id: t(a.id), key: t(a.key), algorithm: a.algorithm ?? 'sha256', ext: t(a.ext), validatePayload: !!a.includePayloadHash, disabled: false };
    case 'jwt':
      return { type: 'jwt', algorithm: a.algorithm ?? 'HS256', secret: t(a.secret), payload: t(a.payload), prefix: a.prefix ?? 'Bearer', disabled: false };
    default:
      notes.add(`"${where}": ${a.type} auth has no Insomnia equivalent and was exported as No auth`);
      return { type: 'none' };
  }
}

const rows = (list: KeyValue[] | undefined, t: (s: string | undefined) => string) => (list ?? []).filter((r) => r.key).map((r) => ({ name: t(r.key), value: t(r.value), ...(r.description ? { description: r.description } : {}), disabled: r.enabled === false }));

function bodyOf(b: BodyConfig | undefined, t: (s: string | undefined) => string): Any | undefined {
  if (!b || b.type === 'none') return undefined;
  switch (b.type) {
    case 'json':
      return { mimeType: 'application/json', text: t(b.content) };
    case 'xml':
      return { mimeType: 'application/xml', text: t(b.content) };
    case 'html':
      return { mimeType: 'text/html', text: t(b.content) };
    case 'text':
      return { mimeType: 'text/plain', text: t(b.content) };
    case 'form-urlencoded':
      return { mimeType: 'application/x-www-form-urlencoded', params: rows(b.fields, t) };
    case 'multipart':
      return { mimeType: 'multipart/form-data', params: b.fields.filter((f) => f.key).map((f) => (f.kind === 'file' ? { name: f.key, type: 'file', fileName: f.value, disabled: f.enabled === false } : { name: t(f.key), value: t(f.value), type: 'text', disabled: f.enabled === false })) };
    case 'binary':
      return { mimeType: 'application/octet-stream', fileName: b.filePath };
  }
}

function settingsOf(s: HttpSettings | undefined): Any | undefined {
  if (!s) return undefined;
  const out: Any = {};
  if (s.followRedirects === false) out.followRedirects = 'off';
  if (s.encodeUrl === false) out.encodeUrl = false;
  if (s.disableCookieJar) out.cookies = { send: false, store: false };
  return Object.keys(out).length ? out : undefined;
}

/** A script for Insomnia: `tp.*` → `insomnia.*`, with TestPion's assertions as tests after it. */
function scriptsOf(pre: string | undefined, post: string | undefined, assertions: SavedHttpRequest['assertions'], notes: Set<string>, where: string): { preRequest?: string; afterResponse?: string } {
  const tests = assertionsToTests(assertions);
  if (tests.skipped.length) notes.add(`"${where}": the ${tests.skipped.join(', ')} check${tests.skipped.length > 1 ? 's' : ''} could not be written as Insomnia tests and ${tests.skipped.length > 1 ? 'were' : 'was'} not exported`);
  const conv = (code: string | undefined) => {
    if (!code?.trim()) return undefined;
    const r = retargetScript(code, 'insomnia');
    for (const u of r.unsupported) notes.add(`"${where}": ${u} has no Insomnia equivalent (the script keeps the call)`);
    return r.code;
  };
  const preRequest = conv(pre);
  const afterResponse = conv(joinScripts(post, tests.code));
  return { ...(preRequest ? { preRequest } : {}), ...(afterResponse ? { afterResponse } : {}) };
}

interface Ctx {
  notes: Set<string>;
  t: (s: string | undefined) => string;
}

type Req = SavedHttpRequest | SavedGraphQLRequest;

/** The request as an Insomnia request object (the fields v4 and v5 share), plus its scripts. */
function requestFields(r: Req, ctx: Ctx): { fields: Any; scripts: { preRequest?: string; afterResponse?: string } } {
  const { t, notes } = ctx;
  const scripts = scriptsOf(r.preRequestScript, r.testScript, r.assertions, notes, r.name);
  if (r.kind === 'http' && r.examples?.length) notes.add(`"${r.name}": ${r.examples.length} saved example${r.examples.length > 1 ? 's' : ''} (Insomnia has none)`);
  const headers = rows(r.request.headers, t);
  const auth = authOf(r.request.auth, notes, r.name, t);
  if (r.kind === 'graphql') {
    const g = r.request;
    const vars = typeof g.variables === 'string' ? (() => { try { return JSON.parse(g.variables as string); } catch { return {}; } })() : g.variables ?? {};
    return {
      fields: { name: r.name, url: t(g.endpoint), method: 'POST', body: { mimeType: 'application/graphql', text: JSON.stringify({ query: t(g.query), variables: vars, ...(g.operationName ? { operationName: g.operationName } : {}) }) }, headers: [{ name: 'Content-Type', value: 'application/json' }, ...headers], parameters: [], ...(auth ? { authentication: auth } : {}) },
      scripts,
    };
  }
  const q = r.request;
  const settings = settingsOf(q.settings);
  const cookies = (q.cookies ?? []).filter((c) => c.key && c.enabled !== false);
  const extra = cookies.length ? [{ name: 'Cookie', value: cookies.map((c) => `${c.key}=${t(c.value)}`).join('; '), disabled: false }] : [];
  return {
    fields: {
      name: r.name,
      ...(r.description ? { description: r.description } : {}),
      url: t(q.url),
      method: q.method,
      ...(bodyOf(q.body, t) ? { body: bodyOf(q.body, t) } : {}),
      parameters: rows(q.params, t),
      ...(q.pathVariables?.length ? { pathParameters: rows(q.pathVariables, t) } : {}),
      headers: [...headers, ...extra],
      ...(auth ? { authentication: auth } : {}),
      ...(settings ? { settings } : {}),
    },
    scripts,
  };
}

const envData = (vars: KeyValue[] | Environment['variables'], t: (s: string | undefined) => string): Record<string, string> =>
  Object.fromEntries(vars.filter((v) => v.key && v.enabled !== false).map((v) => [v.key, t(v.value)]));

function environments(c: Collection, envs: Environment[], ctx: Ctx): { base: Record<string, string>; subs: Array<{ name: string; data: Record<string, string>; color?: string }> } {
  const secrets = envs.flatMap((e) => e.variables.filter((v) => v.secret).map((v) => `${e.name} › ${v.key}`));
  if (secrets.length) ctx.notes.add(`Secret variable values are never exported (${secrets.slice(0, 4).join(', ')}${secrets.length > 4 ? ' …' : ''}): enter them in Insomnia`);
  return { base: envData(c.variables ?? [], ctx.t), subs: envs.map((e) => ({ name: e.name, data: envData(e.variables, ctx.t), ...(e.color ? { color: e.color } : {}) })) };
}

export interface ExportResult {
  text: string;
  /** What did not map one to one. */
  notes: string[];
}

/** Insomnia v5 YAML. */
export function collectionToInsomniaV5(c: Collection, envs: Environment[] = []): ExportResult {
  const ctx: Ctx = { notes: new Set(), t: (s) => toInsomniaTemplate(s, ctx.notes) };
  const { t, notes } = ctx;
  const moved: string[] = [];
  const items = pushCollectionDefaultsDown(c, moved);
  moved.forEach((m) => notes.add(m));
  const wrk = stableId('wrk', c.id);
  const now = Date.parse(c.updatedAt) || 0;
  const meta = (id: string, sort: number) => ({ id, created: now, modified: now, isPrivate: false, sortKey: -sort });
  let sort = 0;
  const convert = (nodes: CollectionNode[]): Any[] =>
    nodes.map((n): Any => {
      sort += 1000;
      if (n.kind === 'folder') {
        const auth = authOf(n.auth, notes, n.name, t);
        const s = scriptsOf(n.preRequestScript, n.testScript, undefined, notes, n.name);
        const headers = rows(n.headers, t);
        return {
          name: n.name,
          meta: { ...meta(stableId('fld', n.id), sort), ...(n.description ? { description: n.description } : {}) },
          children: convert(n.items),
          ...(headers.length ? { headers } : {}),
          ...(auth ? { authentication: auth } : {}),
          ...(Object.keys(s).length ? { scripts: s } : {}),
          ...(n.variables?.length ? { environment: envData(n.variables, t) } : {}),
        };
      }
      const { fields, scripts } = requestFields(n, ctx);
      const settings = fields.settings as Any | undefined;
      delete fields.settings;
      return { url: fields.url, name: fields.name, meta: { ...meta(stableId('req', n.id), sort), description: fields.description ?? '' }, method: fields.method, ...(fields.body ? { body: fields.body } : {}), ...(fields.parameters.length ? { parameters: fields.parameters } : {}), ...(fields.pathParameters ? { pathParameters: fields.pathParameters } : {}), ...(fields.headers.length ? { headers: fields.headers } : {}), ...(fields.authentication ? { authentication: fields.authentication } : {}), ...(Object.keys(scripts).length ? { scripts } : {}), settings: { renderRequestBody: true, encodeUrl: true, followRedirects: 'global', cookies: { send: true, store: true }, rebuildPath: true, ...(settings ?? {}) } };
    });
  const env = environments(c, envs, ctx);
  const doc: Any = {
    type: 'collection.insomnia.rest/5.0',
    schema_version: '5.1',
    name: c.name,
    meta: { id: wrk, created: now, modified: now, ...(c.description ? { description: c.description } : {}) },
    collection: convert(items),
    cookieJar: { name: 'Default Jar', meta: { id: stableId('jar', c.id), created: now, modified: now }, cookies: [] },
    environments: { name: 'Base Environment', meta: { id: stableId('env', c.id), created: now, modified: now, isPrivate: false }, data: env.base, ...(env.subs.length ? { subEnvironments: env.subs.map((e) => ({ name: e.name, meta: { id: stableId('env', `${c.id}/${e.name}`), created: now, modified: now, isPrivate: false }, data: e.data, ...(e.color ? { color: e.color } : {}) })) } : {}) },
  };
  return { text: stringifyYaml(doc, { lineWidth: 0 }), notes: [...notes] };
}

/** Insomnia v4 JSON (flat resources linked by `parentId`). */
export function collectionToInsomniaV4(c: Collection, envs: Environment[] = []): ExportResult {
  const ctx: Ctx = { notes: new Set(), t: (s) => toInsomniaTemplate(s, ctx.notes) };
  const { t, notes } = ctx;
  const moved: string[] = [];
  const items = pushCollectionDefaultsDown(c, moved);
  moved.forEach((m) => notes.add(m));
  const wrk = stableId('wrk', c.id);
  const resources: Any[] = [{ _id: wrk, _type: 'workspace', parentId: null, name: c.name, description: c.description ?? '', scope: 'collection' }];
  let sort = 0;
  const walk = (nodes: CollectionNode[], parent: string) => {
    for (const n of nodes) {
      sort += 1000;
      if (n.kind === 'folder') {
        const id = stableId('fld', n.id);
        const auth = authOf(n.auth, notes, n.name, t);
        const s = scriptsOf(n.preRequestScript, n.testScript, undefined, notes, n.name);
        const headers = rows(n.headers, t);
        resources.push({ _id: id, _type: 'request_group', parentId: parent, name: n.name, description: n.description ?? '', environment: n.variables?.length ? envData(n.variables, t) : {}, metaSortKey: sort, ...(headers.length ? { headers } : {}), ...(auth ? { authentication: auth } : {}), ...(s.preRequest ? { preRequestScript: s.preRequest } : {}), ...(s.afterResponse ? { afterResponseScript: s.afterResponse } : {}) });
        walk(n.items, id);
        continue;
      }
      const { fields, scripts } = requestFields(n, ctx);
      const s = (fields.settings ?? {}) as Any;
      delete fields.settings;
      resources.push({ _id: stableId('req', n.id), _type: 'request', parentId: parent, ...fields, metaSortKey: sort, ...(scripts.preRequest ? { preRequestScript: scripts.preRequest } : {}), ...(scripts.afterResponse ? { afterResponseScript: scripts.afterResponse } : {}), ...(s.followRedirects === 'off' ? { settingFollowRedirects: 'off' } : {}), ...(s.encodeUrl === false ? { settingEncodeUrl: false } : {}), ...(s.cookies ? { settingSendCookies: false, settingStoreCookies: false } : {}) });
    }
  };
  walk(items, wrk);
  const env = environments(c, envs, ctx);
  const baseId = stableId('env', c.id);
  resources.push({ _id: baseId, _type: 'environment', parentId: wrk, name: 'Base Environment', data: env.base, isPrivate: false });
  for (const e of env.subs) resources.push({ _id: stableId('env', `${c.id}/${e.name}`), _type: 'environment', parentId: baseId, name: e.name, data: e.data, isPrivate: false, ...(e.color ? { color: e.color } : {}) });
  const doc = { _type: 'export', __export_format: 4, __export_date: c.updatedAt, __export_source: 'testpion', resources };
  return { text: JSON.stringify(doc, null, 2) + '\n', notes: [...notes] };
}
