import type { AuthConfig, BodyConfig, Collection, CollectionFolder, CollectionNode, Environment, HttpSettings, KeyValue, SavedExample, SavedGraphQLRequest, SavedHttpRequest } from '../model/types.js';
import { tpToBruno } from '../scripts/bruno.js';
import { stringifyYaml } from '../util/lazy-yaml.js';
import { slugify } from '../util/ids.js';
import { assertionsToTests, joinScripts } from './export-common.js';

/**
 * Export a collection as OpenCollection, the YAML format Bruno uses by default since 3.1 (opencollection.com): a folder with
 * `opencollection.yml`, `folder.yml` per folder, one `.yml` per request and `environments/*.yml`, or the same as one bundled
 * file. Scripts are written in Bruno's API (`tp.*` back to `bru.*` / `res`), a status check is an assertion, other checks are
 * tests in the script. The importer (`parseOpenCollection`) reads everything written here back.
 */

type Any = Record<string, any>;
export interface OcFile {
  path: string;
  text: string;
}

const y = (v: unknown) => stringifyYaml(v, { lineWidth: 0 });
const rows = (list: KeyValue[] | undefined) => (list ?? []).filter((r) => r.key).map((r) => ({ name: r.key, value: r.value ?? '', ...(r.description ? { description: r.description } : {}), ...(r.enabled === false ? { disabled: true } : {}) }));

function authOf(a: AuthConfig | undefined, notes: Set<string>, where: string): Any | string | undefined {
  if (!a) return undefined;
  switch (a.type) {
    case 'inherit':
      return 'inherit';
    case 'none':
      return 'none';
    case 'bearer':
      return { type: 'bearer', token: a.token };
    case 'basic':
      return { type: 'basic', username: a.username, password: a.password };
    case 'digest':
      return { type: 'digest', username: a.username, password: a.password };
    case 'ntlm':
      return { type: 'ntlm', username: a.username, password: a.password, ...(a.domain ? { domain: a.domain } : {}), ...(a.workstation ? { workstation: a.workstation } : {}) };
    case 'apiKey':
      return { type: 'apikey', key: a.key, value: a.value, placement: a.in === 'query' ? 'query' : 'header' };
    case 'awsv4':
      return { type: 'awsv4', accessKeyId: a.accessKey, secretAccessKey: a.secretKey, ...(a.sessionToken ? { sessionToken: a.sessionToken } : {}), region: a.region, service: a.service };
    case 'oauth2':
      return {
        type: 'oauth2',
        flow: a.grantType === 'password' ? 'resource_owner_password_credentials' : a.grantType,
        accessTokenUrl: a.tokenUrl,
        ...(a.authUrl ? { authorizationUrl: a.authUrl } : {}),
        credentials: { clientId: a.clientId, ...(a.clientSecret ? { clientSecret: a.clientSecret } : {}), ...(a.clientAuth === 'header' ? { placement: 'basic_auth_header' } : {}) },
        ...(a.scope ? { scope: a.scope } : {}),
        ...(a.username ? { resourceOwner: { username: a.username, password: a.password ?? '' } } : {}),
        ...(a.grantType === 'authorization_code' ? { pkce: { disabled: !a.usePkce } } : {}),
        ...(a.redirectUri ? { callbackUrl: a.redirectUri } : {}),
      };
    default:
      notes.add(`"${where}": ${a.type} auth has no OpenCollection equivalent and was exported as No auth`);
      return 'none';
  }
}

function bodyOf(b: BodyConfig | undefined): Any | undefined {
  if (!b || b.type === 'none') return undefined;
  switch (b.type) {
    case 'json':
    case 'xml':
    case 'text':
      return { type: b.type, data: b.content };
    case 'html':
      return { type: 'text', data: b.content };
    case 'form-urlencoded':
      return { type: 'form-urlencoded', data: rows(b.fields) };
    case 'multipart':
      return { type: 'multipart-form', data: b.fields.filter((f) => f.key).map((f) => ({ name: f.key, value: f.kind === 'file' ? [f.value] : f.value, type: f.kind === 'file' ? 'file' : 'text', ...(f.contentType ? { contentType: f.contentType } : {}), ...(f.enabled === false ? { disabled: true } : {}) })) };
    case 'binary':
      return { type: 'file', data: [{ filePath: b.filePath, selected: true, ...(b.contentType ? { contentType: b.contentType } : {}) }] };
  }
}

function settingsOf(s: HttpSettings | undefined): Any | undefined {
  if (!s) return undefined;
  const out: Any = {};
  if (s.encodeUrl === false) out.encodeUrl = false;
  if (s.followRedirects === false) out.followRedirects = false;
  if (s.maxRedirects !== undefined) out.maxRedirects = s.maxRedirects;
  if (s.followAuthorizationHeader) out.forwardAuthorizationHeader = true;
  if (s.timeoutMs !== undefined) out.timeout = s.timeoutMs;
  return Object.keys(out).length ? out : undefined;
}

function examplesOf(list: SavedExample[] | undefined): Any[] | undefined {
  if (!list?.length) return undefined;
  return list.map((e) => ({
    name: e.name,
    ...(e.request ? { request: { url: e.request.url, method: e.request.method, headers: rows(e.request.headers), ...(e.request.body ? { body: { type: 'text', data: e.request.body } } : {}) } } : {}),
    response: { status: e.status, ...(e.statusText ? { statusText: e.statusText } : {}), headers: (e.headers ?? []).map((h) => ({ name: h.key, value: h.value })), body: { type: /json/i.test(e.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '') ? 'json' : 'text', data: e.body } },
  }));
}

/** Pre/post scripts in Bruno's API as OpenCollection script entries, with the status check as an assertion. */
function runtimeOf(pre: string | undefined, post: string | undefined, assertions: SavedHttpRequest['assertions'], notes: Set<string>, where: string): Any | undefined {
  const status = (assertions ?? []).filter((a) => a.type === 'status' && typeof a.expected === 'number');
  const rest = (assertions ?? []).filter((a) => !status.includes(a));
  const tests = assertionsToTests(rest);
  if (tests.skipped.length) notes.add(`"${where}": the ${tests.skipped.join(', ')} check${tests.skipped.length > 1 ? 's' : ''} could not be written as Bruno tests and ${tests.skipped.length > 1 ? 'were' : 'was'} not exported`);
  const scripts: Any[] = [];
  const p = pre?.trim() ? tpToBruno(pre.replace(/^\/\/ Bruno script[^\n]*\n/, '')) : undefined;
  const t = joinScripts(post?.replace(/^\/\/ Bruno script[^\n]*\n/, ''), tests.code);
  if (p) scripts.push({ type: 'before-request', code: p });
  if (t) scripts.push({ type: 'after-response', code: tpToBruno(t) });
  const out: Any = {};
  if (scripts.length) out.scripts = scripts;
  if (status.length) out.assertions = status.map((a) => ({ expression: 'res.status', operator: 'eq', value: String(a.expected) }));
  return Object.keys(out).length ? out : undefined;
}

function defaultsOf(x: { auth?: AuthConfig; headers?: KeyValue[]; variables?: KeyValue[]; settings?: HttpSettings; preRequestScript?: string; testScript?: string }, notes: Set<string>, where: string): Any | undefined {
  const out: Any = {};
  const headers = rows(x.headers);
  if (headers.length) out.headers = headers;
  const auth = authOf(x.auth, notes, where);
  if (auth) out.auth = auth;
  if (x.variables?.length) out.variables = x.variables.filter((v) => v.key).map((v) => ({ name: v.key, value: v.value ?? '', ...(v.enabled === false ? { disabled: true } : {}) }));
  const rt = runtimeOf(x.preRequestScript, x.testScript, undefined, notes, where);
  if (rt?.scripts) out.scripts = rt.scripts;
  const s = settingsOf(x.settings);
  if (s) out.settings = { http: s };
  return Object.keys(out).length ? out : undefined;
}

type Req = SavedHttpRequest | SavedGraphQLRequest;
function requestItem(r: Req, seq: number, notes: Set<string>): Any {
  const rt = runtimeOf(r.preRequestScript, r.testScript, r.assertions, notes, r.name);
  if (r.kind === 'graphql') {
    const g = r.request;
    const vars = typeof g.variables === 'string' ? g.variables : g.variables ? JSON.stringify(g.variables, null, 2) : undefined;
    const auth = authOf(g.auth, notes, r.name);
    return { info: { name: r.name, type: 'graphql', seq }, graphql: { url: g.endpoint, headers: rows(g.headers), body: { query: g.query, ...(vars ? { variables: vars } : {}) }, ...(auth ? { auth } : {}) }, ...(rt ? { runtime: rt } : {}) };
  }
  const q = r.request;
  const auth = authOf(q.auth, notes, r.name);
  const params = [...(q.params ?? []).filter((p) => p.key).map((p) => ({ name: p.key, value: p.value ?? '', type: 'query', ...(p.enabled === false ? { disabled: true } : {}) })), ...(q.pathVariables ?? []).filter((p) => p.key).map((p) => ({ name: p.key, value: p.value ?? '', type: 'path' }))];
  const cookies = (q.cookies ?? []).filter((c) => c.key && c.enabled !== false);
  const headers = rows(q.headers);
  if (cookies.length) headers.push({ name: 'Cookie', value: cookies.map((c) => `${c.key}=${c.value}`).join('; ') });
  const body = bodyOf(q.body);
  const settings = settingsOf(q.settings);
  const examples = examplesOf(r.examples);
  return {
    info: { name: r.name, type: 'http', seq },
    http: { method: q.method, url: q.url, ...(headers.length ? { headers } : {}), ...(params.length ? { params } : {}), ...(body ? { body } : {}), ...(auth ? { auth } : {}) },
    ...(rt ? { runtime: rt } : {}),
    ...(settings ? { settings } : {}),
    ...(examples ? { examples } : {}),
    ...(r.description ? { docs: r.description } : {}),
  };
}

function envFile(e: Environment): Any {
  return { name: e.name, variables: e.variables.filter((v) => v.key).map((v) => ({ name: v.key, value: v.secret ? '' : v.value, ...(v.secret ? { secret: true } : {}), ...(v.enabled === false ? { disabled: true } : {}) })), ...(e.color ? { color: e.color } : {}) };
}

export interface OcExport {
  files: OcFile[];
  notes: string[];
}

/** The files of an OpenCollection folder. */
export function collectionToOpenCollection(c: Collection, envs: Environment[] = []): OcExport {
  const notes = new Set<string>();
  const files: OcFile[] = [];
  const root: Any = { opencollection: '1.0.0', info: { name: c.name }, ...(c.description ? { docs: c.description } : {}) };
  const rootReq = defaultsOf(c, notes, c.name);
  if (rootReq) root.request = rootReq;
  files.push({ path: 'opencollection.yml', text: y(root) });
  const names = (dir: string, list: CollectionNode[]) => {
    const used = new Set<string>();
    return list.map((n) => {
      let stem = slugify(n.name) || 'item';
      for (let i = 2; used.has(`${dir}${stem}`); i++) stem = `${slugify(n.name) || 'item'}-${i}`;
      used.add(`${dir}${stem}`);
      return stem;
    });
  };
  const walk = (nodes: CollectionNode[], dir: string) => {
    const stems = names(dir, nodes);
    nodes.forEach((n, i) => {
      if (n.kind === 'folder') {
        const f = n as CollectionFolder;
        const d = `${dir}${stems[i]}/`;
        const def = defaultsOf(f, notes, f.name);
        files.push({ path: `${d}folder.yml`, text: y({ info: { name: f.name, type: 'folder', seq: i + 1 }, ...(f.description ? { docs: f.description } : {}), ...(def ? { request: def } : {}) }) });
        walk(f.items, d);
      } else files.push({ path: `${dir}${stems[i]}.yml`, text: y(requestItem(n, i + 1, notes)) });
    });
  };
  walk(c.items, '');
  for (const e of envs) files.push({ path: `environments/${slugify(e.name) || 'env'}.yml`, text: y(envFile(e)) });
  if (envs.some((e) => e.variables.some((v) => v.secret))) notes.add('Secret variable values are never exported: enter them in Bruno');
  return { files, notes: [...notes] };
}

/** The same collection as one bundled OpenCollection file. */
export function collectionToOpenCollectionBundle(c: Collection, envs: Environment[] = []): { text: string; notes: string[] } {
  const notesSet = new Set<string>();
  if (envs.some((e) => e.variables.some((v) => v.secret))) notesSet.add('Secret variable values are never exported: enter them in Bruno');
  const root: Any = { opencollection: '1.0.0', bundled: true, info: { name: c.name }, ...(c.description ? { docs: c.description } : {}) };
  const rootReq = defaultsOf(c, notesSet, c.name);
  if (rootReq) root.request = rootReq;
  const item = (nodes: CollectionNode[]): Any[] =>
    nodes.map((n, i) => {
      if (n.kind !== 'folder') return requestItem(n, i + 1, notesSet);
      const def = defaultsOf(n, notesSet, n.name);
      return { info: { name: n.name, type: 'folder', seq: i + 1 }, ...(n.description ? { docs: n.description } : {}), ...(def ? { request: def } : {}), items: item(n.items) };
    });
  root.items = item(c.items);
  root.config = { environments: envs.map((e) => ({ name: e.name, ...envFile(e) })) };
  return { text: y(root), notes: [...notesSet] };
}
