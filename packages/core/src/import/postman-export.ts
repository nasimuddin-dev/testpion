import { toPostmanScript } from '../scripts/aliases.js';
import { createHash } from 'node:crypto';
import type { AuthConfig, BodyConfig, CheckConfig, Collection, CollectionNode, Environment, HttpSettings, KeyValue, SavedExample, SavedGraphQLRequest, SavedHttpRequest } from '../model/types.js';
import { inheritedHeaders, withInheritedHeaders } from '../runner/folder-defaults.js';

/**
 * Export to the Postman v2.1 collection and environment formats, so collections move to and from
 * Postman / Newman without loss where the formats overlap. The importer (`importPostman`) reads
 * everything written here back.
 *
 * Not representable in Postman: TestPion assertions other than `status` (the status check becomes
 * a `pm.test`), JWT auth, per-request cookies tables (sent as a Cookie header), and non-HTTP requests
 * other than GraphQL. `postmanExportNotes` lists what was left out.
 */

export const POSTMAN_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/** Deterministic UUID-shaped id, so re-exporting the same collection gives the same ids. */
export function stableUuid(seed: string): string {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const kv = (rows: KeyValue[] | undefined) =>
  (rows ?? []).filter((r) => r.key).map((r) => ({ key: r.key, value: r.value ?? '', ...(r.enabled === false ? { disabled: true } : {}), ...(r.description ? { description: r.description } : {}) }));

const lines = (script: string | undefined) => (script ?? '').split(/\r?\n/);

type PmAuth = { type: string; [k: string]: unknown } | undefined;

function pmAuth(a: AuthConfig | undefined, notes: string[], where: string): PmAuth {
  const attr = (o: Record<string, string | undefined>) => Object.entries(o).filter(([, v]) => v !== undefined).map(([key, value]) => ({ key, value, type: 'string' }));
  if (!a || a.type === 'inherit') return undefined;
  switch (a.type) {
    case 'none':
      return { type: 'noauth' };
    case 'bearer':
      return { type: 'bearer', bearer: attr({ token: a.token }) };
    case 'basic':
      return { type: 'basic', basic: attr({ username: a.username, password: a.password }) };
    case 'apiKey':
      return { type: 'apikey', apikey: attr({ key: a.key, value: a.value, in: a.in }) };
    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: attr({
          grant_type: a.grantType === 'client_credentials' ? 'client_credentials' : a.grantType === 'password' ? 'password_credentials' : 'authorization_code',
          accessTokenUrl: a.tokenUrl,
          authUrl: a.authUrl,
          clientId: a.clientId,
          clientSecret: a.clientSecret,
          scope: a.scope,
          username: a.username,
          password: a.password,
          ...(a.usePkce ? { grant_type: 'authorization_code_with_pkce' } : {}),
          redirect_uri: a.redirectUri,
          client_authentication: a.clientAuth === 'header' ? 'header' : undefined,
        }),
      };
    case 'digest':
      return { type: 'digest', digest: attr({ username: a.username, password: a.password, algorithm: 'MD5' }) };
    case 'oauth1':
      return {
        type: 'oauth1',
        oauth1: attr({
          consumerKey: a.consumerKey,
          consumerSecret: a.consumerSecret,
          token: a.token,
          tokenSecret: a.tokenSecret,
          signatureMethod: a.signatureMethod ?? 'HMAC-SHA1',
          realm: a.realm,
          version: '1.0',
          addParamsToHeader: a.addTo === 'query' ? 'false' : 'true',
        }),
      };
    case 'ntlm':
      return { type: 'ntlm', ntlm: attr({ username: a.username, password: a.password, domain: a.domain, workstation: a.workstation }) };
    case 'hawk':
      return { type: 'hawk', hawk: attr({ authId: a.id, authKey: a.key, algorithm: a.algorithm ?? 'sha256', extraData: a.ext, app: a.app, delegation: a.dlg, includePayloadHash: a.includePayloadHash ? 'true' : 'false' }) };
    case 'edgegrid':
      return { type: 'edgegrid', edgegrid: attr({ clientToken: a.clientToken, clientSecret: a.clientSecret, accessToken: a.accessToken, headersToSign: a.headersToSign }) };
    case 'awsv4':
      return { type: 'awsv4', awsv4: attr({ accessKey: a.accessKey, secretKey: a.secretKey, region: a.region, service: a.service, sessionToken: a.sessionToken }) };
    case 'headers':
      notes.push(`${where}: "custom headers" auth was exported as request headers`);
      return undefined;
    default:
      notes.push(`${where}: ${a.type} auth has no Postman equivalent and was left out`);
      return undefined;
  }
}

function pmBody(b: BodyConfig | undefined): Record<string, unknown> | undefined {
  if (!b || b.type === 'none') return undefined;
  switch (b.type) {
    case 'json':
    case 'xml':
    case 'text':
    case 'html':
      return { mode: 'raw', raw: b.content, options: { raw: { language: b.type === 'json' ? 'json' : b.type === 'xml' ? 'xml' : b.type === 'html' ? 'html' : 'text' } } };
    case 'form-urlencoded':
      return { mode: 'urlencoded', urlencoded: kv(b.fields) };
    case 'multipart':
      return { mode: 'formdata', formdata: b.fields.filter((f) => f.key).map((f) => (f.kind === 'file' ? { key: f.key, type: 'file', src: f.value, ...(f.enabled === false ? { disabled: true } : {}) } : { key: f.key, value: f.value, type: 'text', ...(f.enabled === false ? { disabled: true } : {}) })) };
    case 'binary':
      return { mode: 'file', file: { src: b.filePath } };
  }
}

/** A Postman URL object: `{{baseUrl}}/pets/:id?x=1` → raw, host, path, query, variable. */
export function pmUrl(url: string, params?: KeyValue[], pathVariables?: KeyValue[]): Record<string, unknown> {
  const [beforeHash] = url.split('#');
  const [base = '', qs] = beforeHash!.split('?');
  const query = params?.length
    ? kv(params)
    : (qs ?? '')
        .split('&')
        .filter(Boolean)
        .map((p) => {
          const i = p.indexOf('=');
          return { key: i < 0 ? p : p.slice(0, i), value: i < 0 ? '' : p.slice(i + 1) };
        });
  const live = query.filter((q) => !('disabled' in q));
  const raw = base + (live.length ? '?' + live.map((q) => (q.value === '' ? q.key : `${q.key}=${q.value}`)).join('&') : '');
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(.*)$/i.exec(base);
  let host: string[];
  let path: string[];
  let protocol: string | undefined;
  if (m) {
    protocol = m[1];
    host = m[2]!.split('.');
    path = m[3]!.split('/').filter(Boolean);
  } else {
    const [h = '', ...rest] = base.split('/');
    host = [h];
    path = rest.filter(Boolean);
  }
  return {
    raw,
    ...(protocol ? { protocol } : {}),
    host,
    path,
    ...(query.length ? { query } : {}),
    ...(pathVariables?.length ? { variable: pathVariables.filter((v) => v.key).map((v) => ({ key: v.key, value: v.value ?? '', ...(v.description ? { description: v.description } : {}) })) } : {}),
  };
}

function statusTests(assertions: CheckConfig[] | undefined, notes: string[], where: string): string[] {
  const out: string[] = [];
  const skipped = new Set<string>();
  for (const a of assertions ?? []) {
    const c = a as CheckConfig & { expected?: unknown };
    if (c.type === 'status' && (typeof c.expected === 'number' || /^\d+$/.test(String(c.expected)))) out.push(`pm.test("Status code is ${c.expected}", function () {`, `  pm.response.to.have.status(${Number(c.expected)});`, '});');
    else skipped.add(c.type);
  }
  if (skipped.size) notes.push(`${where}: assertions of type ${[...skipped].join(', ')} have no Postman equivalent and were left out`);
  return out;
}

function events(preScript: string | undefined, testScript: string | undefined, extraTests: string[] = []) {
  // Postman has no `tp`: TestPion's name for the script API becomes `pm`
  const pre = toPostmanScript(preScript);
  const test = toPostmanScript(testScript);
  const ev: Array<Record<string, unknown>> = [];
  if (pre?.trim()) ev.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: lines(pre) } });
  const t = [...(test?.trim() ? lines(test) : []), ...(extraTests.length && test?.trim() ? [''] : []), ...extraTests];
  if (t.length) ev.push({ listen: 'test', script: { type: 'text/javascript', exec: t } });
  return ev.length ? { event: ev } : {};
}

function pmExample(ex: SavedExample, req: SavedHttpRequest): Record<string, unknown> {
  const ct = ex.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '';
  // Postman requires an original request; without one of its own, the example belongs to the saved request
  const q = req.request;
  const originalRequest = ex.request
    ? { method: ex.request.method, header: kv(ex.request.headers), url: pmUrl(ex.request.url), ...(ex.request.body ? { body: { mode: 'raw', raw: ex.request.body } } : {}) }
    : { method: (q.method || 'GET').toUpperCase(), header: kv(q.headers), url: pmUrl(q.url, q.params, q.pathVariables) };
  return {
    name: ex.name,
    originalRequest,
    status: ex.statusText ?? '',
    code: ex.status,
    _postman_previewlanguage: /json/i.test(ct) ? 'json' : /html/i.test(ct) ? 'html' : /xml/i.test(ct) ? 'xml' : 'text',
    header: ex.headers.map((h) => ({ key: h.key, value: h.value })),
    cookie: [],
    body: ex.body,
  };
}

/** Request settings as Postman's protocolProfileBehavior (the ones both tools have). */
export function pmBehavior(s: HttpSettings | undefined): Record<string, unknown> | undefined {
  if (!s) return undefined;
  const b: Record<string, unknown> = {
    ...(s.followRedirects === false ? { followRedirects: false } : {}),
    ...(s.maxRedirects !== undefined ? { maxRedirects: s.maxRedirects } : {}),
    ...(s.insecure ? { strictSSL: false } : {}),
    ...(s.disableCookieJar ? { disableCookies: true } : {}),
    ...(s.followOriginalMethod ? { followOriginalHttpMethod: true } : {}),
    ...(s.followAuthorizationHeader ? { followAuthorizationHeader: true } : {}),
    ...(s.removeRefererOnRedirect ? { removeRefererHeaderOnRedirect: true } : {}),
    ...(s.encodeUrl === false ? { disableUrlEncoding: true } : {}),
  };
  return Object.keys(b).length ? b : undefined;
}

function httpItem(n: SavedHttpRequest, notes: string[], inherited: KeyValue[] = []): Record<string, unknown> {
  const q = n.request;
  // Postman has no folder or collection headers: they go on each request (the request's own win)
  const headers = [...kv(withInheritedHeaders(q.headers, inherited))];
  if (q.auth?.type === 'headers') headers.push(...kv(q.auth.headers));
  const cookies = (q.cookies ?? []).filter((c) => c.key && c.enabled !== false);
  if (cookies.length) headers.push({ key: 'Cookie', value: cookies.map((c) => `${c.key}=${c.value}`).join('; ') });
  const auth = pmAuth(q.auth, notes, n.name);
  const description = n.description ?? q.description;
  const settings = q.settings ?? {};
  return {
    name: n.name,
    ...events(n.preRequestScript, n.testScript, statusTests(n.assertions, notes, n.name)),
    ...(pmBehavior(settings) ? { protocolProfileBehavior: pmBehavior(settings) } : {}),
    request: {
      method: (q.method || 'GET').toUpperCase(),
      header: headers,
      ...(pmBody(q.body) ? { body: pmBody(q.body) } : {}),
      url: pmUrl(q.url, q.params, q.pathVariables),
      ...(auth ? { auth } : {}),
      ...(description ? { description } : {}),
    },
    response: (n.examples ?? []).map((ex) => pmExample(ex, n)),
  };
}

function graphqlItem(n: SavedGraphQLRequest, notes: string[], inherited: KeyValue[] = []): Record<string, unknown> {
  const q = n.request;
  const auth = pmAuth(q.auth, notes, n.name);
  const variables = q.variables === undefined ? '' : typeof q.variables === 'string' ? q.variables : JSON.stringify(q.variables, null, 2);
  return {
    name: n.name,
    ...events(n.preRequestScript, n.testScript, statusTests(n.assertions, notes, n.name)),
    request: {
      method: 'POST',
      header: kv(withInheritedHeaders(q.headers, inherited)),
      body: { mode: 'graphql', graphql: { query: q.query, variables } },
      url: pmUrl(q.endpoint),
      ...(auth ? { auth } : {}),
    },
    response: [],
  };
}

/** Convert a collection to a Postman v2.1 collection object. */
export function exportPostmanCollection(c: Collection): { collection: Record<string, unknown>; notes: string[] } {
  const notes: string[] = [];
  const items = (nodes: CollectionNode[], inherited: KeyValue[]): Array<Record<string, unknown>> =>
    nodes.map((n) => {
      if (n.kind === 'folder') {
        const below = inheritedHeaders({ headers: inherited }, [n]);
        const behavior = pmBehavior(n.settings);
        const auth = pmAuth(n.auth, notes, n.name);
        const variable = (n.variables ?? []).filter((v) => v.key).map((v) => ({ key: v.key, value: v.value ?? '', type: 'string', ...(v.enabled === false ? { disabled: true } : {}) }));
        return { name: n.name, ...(n.description ? { description: n.description } : {}), item: items(n.items, below), ...(auth ? { auth } : {}), ...events(n.preRequestScript, n.testScript), ...(variable.length ? { variable } : {}), ...(behavior ? { protocolProfileBehavior: behavior } : {}) };
      }
      return n.kind === 'graphql' ? graphqlItem(n, notes, inherited) : httpItem(n, notes, inherited);
    });
  const auth = pmAuth(c.auth, notes, c.name);
  const collection = {
    info: {
      _postman_id: stableUuid(c.id),
      name: c.name,
      ...(c.description ? { description: c.description } : {}),
      schema: POSTMAN_SCHEMA,
    },
    item: items(c.items, inheritedHeaders(c, [])),
    ...(auth ? { auth } : {}),
    ...events(c.preRequestScript, c.testScript),
    variable: c.variables.filter((v) => v.key).map((v) => ({ key: v.key, value: v.value ?? '', type: 'string', ...(v.enabled === false ? { disabled: true } : {}) })),
  };
  return { collection, notes };
}

/**
 * Convert an environment to the Postman environment format. Secret variables are exported as
 * `type: "secret"` with an empty value: their values stay in the OS credential store.
 */
export function exportPostmanEnvironment(env: Environment): Record<string, unknown> {
  return {
    id: stableUuid(env.id),
    name: env.name,
    values: env.variables.filter((v) => v.key).map((v) => ({ key: v.key, value: v.secret ? '' : v.value ?? '', type: v.secret ? 'secret' : 'default', enabled: v.enabled !== false })),
    _postman_variable_scope: 'environment',
    _postman_exported_using: 'TestPion',
  };
}
