import type { AuthConfig } from '../model/types.js';
import { edgegrid, grant, hawk, jwt, noteEncrypted, ntlm, ok, unsupported, withoutEncrypted, type ForeignAuth, type ForeignTool } from './foreign-auth.js';

/**
 * The auth of Thunder Client, Yaak and HTTPie requests (the tools with their own file shape; Apidog's follows
 * Postman's and is mapped in foreign-auth.ts). Same rule as the other tools: a scheme TestPion has becomes that auth,
 * one it has not is NEVER `inherit` but `none` + a disabled placeholder header + a finding.
 */

type Any = Record<string, any>;
type Norm = (s: unknown) => string;

const GRANTS: Record<string, 'client_credentials' | 'password' | 'authorization_code'> = {
  client_credentials: 'client_credentials',
  clientcredentials: 'client_credentials',
  'client-credentials': 'client_credentials',
  password: 'password',
  password_credentials: 'password',
  authorization_code: 'authorization_code',
  authorizationcode: 'authorization_code',
  'authorization-code': 'authorization_code',
  authorization_code_pkce: 'authorization_code',
  '': 'authorization_code',
};

function oauth2(tool: ForeignTool, a: Any, where: string, n: Norm): ForeignAuth {
  const notes: string[] = [];
  const g = String(a.grantType ?? a.grant_type ?? a.grant ?? '').toLowerCase();
  return ok(
    {
      type: 'oauth2',
      grantType: grant(tool, where, g, GRANTS, notes),
      tokenUrl: n(a.accessTokenUrl ?? a.accessTokenURL ?? a.tokenUrl ?? a.tokenURL ?? a.access_token_url),
      ...(a.authorizationUrl || a.authUrl || a.authorizationURL ? { authUrl: n(a.authorizationUrl ?? a.authUrl ?? a.authorizationURL) } : {}),
      clientId: n(a.clientId ?? a.client_id),
      ...(a.clientSecret || a.client_secret ? { clientSecret: n(a.clientSecret ?? a.client_secret) } : {}),
      ...(a.scope ? { scope: n(a.scope) } : {}),
      ...(a.audience ? { audience: n(a.audience) } : {}),
      ...(a.username ? { username: n(a.username) } : {}),
      ...(a.password ? { password: n(a.password) } : {}),
      ...(a.pkce === true || a.usePkce === true || g.includes('pkce') ? { usePkce: true } : {}),
    },
    notes,
  );
}

/** Thunder Client: `{ type: 'bearer', bearer: 'token' }`, `{ type: 'basic', basic: { username, password } }` … */
function thunder(a: Any, where: string, n: Norm): ForeignAuth {
  const type = String(a.type ?? '').toLowerCase();
  const b: Any = a[type] && typeof a[type] === 'object' ? a[type] : {};
  switch (type) {
    case 'none':
    case 'noauth':
      return ok({ type: 'none' });
    case 'bearer':
      return ok({ type: 'bearer', token: n(typeof a.bearer === 'string' ? a.bearer : b.token ?? b.value), ...(a.bearerPrefix && a.bearerPrefix !== 'Bearer' ? { prefix: String(a.bearerPrefix) } : {}) });
    case 'basic':
      return ok({ type: 'basic', username: n(b.username), password: n(b.password) });
    case 'digest':
      return ok({ type: 'digest', username: n(b.username), password: n(b.password) });
    case 'apikey':
    case 'api-key':
      return ok({ type: 'apiKey', key: n(b.key ?? b.name), value: n(b.value), in: /query/i.test(String(b.addTo ?? b.in ?? '')) ? 'query' : 'header' });
    case 'oauth2':
      return oauth2('thunder', b, where, n);
    case 'oauth1':
      return ok({ type: 'oauth1', consumerKey: n(b.consumerKey), consumerSecret: n(b.consumerSecret), ...(b.token ? { token: n(b.token) } : {}), ...(b.tokenSecret ? { tokenSecret: n(b.tokenSecret) } : {}) });
    case 'aws':
    case 'awsv4':
      return ok({ type: 'awsv4', accessKey: n(b.accessKey ?? b.access), secretKey: n(b.secretKey ?? b.secret), region: n(b.region), service: n(b.service), ...(b.sessionToken ? { sessionToken: n(b.sessionToken) } : {}) });
    case 'ntlm':
      return ntlm({ username: n(b.username), password: n(b.password), domain: n(b.domain), workstation: n(b.workstation) });
    case 'hawk':
      return hawk({ id: n(b.id ?? b.authId), key: n(b.key ?? b.authKey), algorithm: b.algorithm });
    default:
      return unsupported('thunder', String(a.type), where);
  }
}

/** Yaak: `authenticationType` + `authentication` (fields by the auth plugin). */
function yaak(type: string, a: Any, where: string, n: Norm): ForeignAuth {
  switch (type) {
    case 'none':
      return ok({ type: 'none' });
    case 'basic':
      return ok({ type: 'basic', username: n(a.username), password: n(a.password) });
    case 'bearer':
      return ok({ type: 'bearer', token: n(a.token), ...(a.prefix && a.prefix !== 'Bearer' ? { prefix: String(a.prefix) } : {}) });
    case 'apikey':
      return ok({ type: 'apiKey', key: n(a.key), value: n(a.value), in: /query/i.test(String(a.location ?? '')) ? 'query' : 'header' });
    case 'digest':
      return ok({ type: 'digest', username: n(a.username), password: n(a.password) });
    case 'ntlm':
      return ntlm({ username: n(a.username), password: n(a.password), domain: n(a.domain), workstation: n(a.workstation) });
    case 'jwt':
      return jwt('yaak', where, { algorithm: a.algorithm, secret: n(a.secret), payload: n(a.payload), base64Secret: a.secretBase64 === true });
    case 'oauth2':
      return oauth2('yaak', a, where, n);
    case 'oauth1':
      return ok({ type: 'oauth1', consumerKey: n(a.consumerKey), consumerSecret: n(a.consumerSecret), ...(a.token ? { token: n(a.token) } : {}), ...(a.tokenSecret ? { tokenSecret: n(a.tokenSecret) } : {}) });
    case 'awsv4':
    case 'aws':
      return ok({ type: 'awsv4', accessKey: n(a.accessKeyId ?? a.accessKey), secretKey: n(a.secretAccessKey ?? a.secretKey), region: n(a.region), service: n(a.service), ...(a.sessionToken ? { sessionToken: n(a.sessionToken) } : {}) });
    case 'hawk':
      return hawk({ id: n(a.id), key: n(a.key), algorithm: a.algorithm });
    case 'edgegrid':
    case 'akamai-edgegrid':
    case 'akamai':
      return edgegrid({ clientToken: n(a.clientToken), clientSecret: n(a.clientSecret), accessToken: n(a.accessToken) });
    default:
      // an auth type a Yaak plugin brings (Yaak loads plugins that add their own): TestPion cannot run a plugin, so it says so
      return unsupported('yaak', type, where, ' (an auth type from a Yaak plugin: TestPion does not run Yaak plugins)');
  }
}

/** HTTPie: `{ type: 'basic', credentials: { username, password } }`, `bearer` `{ token }`, `api-key` `{ name, value, in }`. */
function httpie(a: Any, where: string, n: Norm): ForeignAuth {
  const type = String(a.type ?? '').toLowerCase();
  const c: Any = a.credentials && typeof a.credentials === 'object' ? a.credentials : a;
  switch (type) {
    case 'none':
      return ok({ type: 'none' });
    case 'inherit':
      return ok({ type: 'inherit' });
    case 'basic':
      return ok({ type: 'basic', username: n(c.username), password: n(c.password) });
    case 'bearer':
      return ok({ type: 'bearer', token: n(c.token ?? c.value) });
    case 'digest':
      return ok({ type: 'digest', username: n(c.username), password: n(c.password) });
    case 'api-key':
    case 'apikey':
      return ok({ type: 'apiKey', key: n(c.name ?? c.key), value: n(c.value), in: /query/i.test(String(c.in ?? c.location ?? '')) ? 'query' : 'header' });
    case 'ntlm':
      return ntlm({ username: n(c.username), password: n(c.password), domain: n(c.domain) });
    default:
      return unsupported('httpie', String(a.type), where);
  }
}

/** The auth of a Thunder Client / Yaak / HTTPie item; `auth` is undefined when the source says nothing (the item inherits). */
export function mapMoreAuth(tool: 'thunder' | 'yaak' | 'httpie', raw: unknown, where: string, n: Norm, yaakType?: unknown): ForeignAuth {
  if (tool === 'yaak') {
    const type = typeof yaakType === 'string' ? yaakType.toLowerCase().replace(/^auth-/, '') : '';
    if (!type) return { notes: [], headers: [] };
    return yaak(type, raw && typeof raw === 'object' ? (raw as Any) : {}, where, n);
  }
  // HTTPie can export credentials in encrypted form: they are left empty and named, never copied in as a credential
  const { clean, fields } = withoutEncrypted(raw);
  const a = clean && typeof clean === 'object' ? (clean as Any) : undefined;
  if (!a || !a.type) return { notes: [], headers: [] };
  return noteEncrypted(tool === 'thunder' ? thunder(a, where, n) : httpie(a, where, n), tool, where, fields);
}

export type { AuthConfig };
