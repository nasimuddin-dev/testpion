import type { AuthConfig, KeyValue } from '../model/types.js';
import { normalizeTemplate } from './templates.js';

/**
 * One mapping layer for the auth of imported requests, folders and collections (Postman, Insomnia, Bruno and
 * Hoppscotch). A scheme TestPion has becomes that auth; a scheme it doesn't have (Hawk, NTLM, EdgeGrid, ASAP, WSSE,
 * netrc, anything new) is NEVER `inherit` (the request would quietly send the parent's credentials): it becomes
 * `none`, a disabled placeholder header that names the lost scheme, and a note the import shows.
 */

export type ForeignTool = 'postman' | 'insomnia' | 'bruno' | 'hoppscotch';

export interface ForeignAuth {
  /** undefined: the source says nothing, so the item inherits (the caller decides: `inherit` for a request). */
  auth?: AuthConfig;
  /** What did not map, naming the item. */
  notes: string[];
  /** A disabled header naming a scheme that did not map (requests only: folders and collections have no headers). */
  headers: KeyValue[];
}

type Any = Record<string, any>;

const TOOL: Record<ForeignTool, string> = { postman: 'Postman', insomnia: 'Insomnia', bruno: 'Bruno', hoppscotch: 'Hoppscotch' };
const LABEL: Record<string, string> = {
  hawk: 'Hawk',
  ntlm: 'NTLM',
  edgegrid: 'EdgeGrid',
  'akamai-edgegrid': 'EdgeGrid',
  'akamai-eg': 'EdgeGrid',
  asap: 'ASAP',
  wsse: 'WSSE',
  netrc: 'Netrc',
  jwt: 'JWT',
  'aws-signature': 'AWS-Signature',
};
const HMAC = new Set(['HS256', 'HS384', 'HS512']);

const t = (x: unknown) => normalizeTemplate(x ?? '');
/** Postman v2.1 auth attributes are `[{ key, value }]`, v2.0 a plain object. */
const attr = (list: unknown, k: string): string => String((Array.isArray(list) ? list.find((x: Any) => x?.key === k)?.value : (list as Any | undefined)?.[k]) ?? '');

function unsupported(tool: ForeignTool, type: string, where: string, detail = ''): ForeignAuth {
  const label =
    LABEL[type] ??
    (type
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .replace(/^./, (c) => c.toUpperCase()) ||
      'Unknown');
  return {
    auth: { type: 'none' },
    notes: [
      `"${where}": ${TOOL[tool]} auth "${type}"${detail} is not supported, so it was set to No auth (not inherited) with a disabled X-Imported-Auth-${label} header as a reminder: set it up by hand`,
    ],
    headers: [{ key: `X-Imported-Auth-${label}`, value: 'needs manual setup', enabled: false }],
  };
}

const ok = (auth: AuthConfig, notes: string[] = []): ForeignAuth => ({ auth, notes, headers: [] });

/** A JWT auth (TestPion signs HS256/384/512); another algorithm (RS256, ES256 …) is unsupported. */
function jwt(tool: ForeignTool, where: string, f: { algorithm?: string; secret?: string; payload?: string; prefix?: string; addTo?: string; base64Secret?: boolean }): ForeignAuth {
  const algorithm = (f.algorithm || 'HS256').toUpperCase();
  if (!HMAC.has(algorithm)) return unsupported(tool, 'jwt', where, ` (${algorithm}: TestPion signs HS256, HS384 and HS512)`);
  const notes: string[] = [];
  if (f.addTo && !/header/i.test(f.addTo)) notes.push(`"${where}": the JWT was added to the ${f.addTo} in ${TOOL[tool]}; TestPion sends it in the Authorization header`);
  if (f.base64Secret) notes.push(`"${where}": the JWT secret is base64-encoded in ${TOOL[tool]}; TestPion uses the secret as text: decode it`);
  const prefix = f.prefix && f.prefix !== 'Bearer' ? { prefix: f.prefix } : {};
  return ok({ type: 'jwt', secret: t(f.secret), algorithm: algorithm as 'HS256' | 'HS384' | 'HS512', payload: t(f.payload || '{}'), ...prefix }, notes);
}

/** OAuth 2 grants TestPion runs; another (implicit, device …) is imported as authorization code, with a note. */
function grant(
  tool: ForeignTool,
  where: string,
  g: string,
  map: Record<string, 'client_credentials' | 'password' | 'authorization_code'>,
  notes: string[],
): 'client_credentials' | 'password' | 'authorization_code' {
  if (map[g]) return map[g]!;
  if (g) notes.push(`"${where}": ${TOOL[tool]} OAuth 2 grant "${g}" is not supported: imported as authorization code, check it`);
  return 'authorization_code';
}

/** NTLM, Hawk and EdgeGrid, which TestPion signs itself: the same mapping for every tool, from the tool's own field names. */
const ntlm = (f: { username?: unknown; password?: unknown; domain?: unknown; workstation?: unknown }): ForeignAuth =>
  ok({ type: 'ntlm', username: t(f.username), password: t(f.password), ...(f.domain ? { domain: t(f.domain) } : {}), ...(f.workstation ? { workstation: t(f.workstation) } : {}) });
const hawk = (f: { id?: unknown; key?: unknown; algorithm?: unknown; ext?: unknown; app?: unknown; dlg?: unknown; payload?: boolean }): ForeignAuth =>
  ok({
    type: 'hawk',
    id: t(f.id),
    key: t(f.key),
    algorithm: /sha1/i.test(String(f.algorithm ?? '')) ? 'sha1' : 'sha256',
    ...(f.ext ? { ext: t(f.ext) } : {}),
    ...(f.app ? { app: t(f.app) } : {}),
    ...(f.dlg ? { dlg: t(f.dlg) } : {}),
    ...(f.payload ? { includePayloadHash: true } : {}),
  });
const edgegrid = (f: { clientToken?: unknown; clientSecret?: unknown; accessToken?: unknown; headersToSign?: unknown }): ForeignAuth =>
  ok({ type: 'edgegrid', clientToken: t(f.clientToken), clientSecret: t(f.clientSecret), accessToken: t(f.accessToken), ...(f.headersToSign ? { headersToSign: t(f.headersToSign) } : {}) });

function postman(a: Any, where: string): ForeignAuth {
  const get = (k: string) => attr(a[a.type], k);
  const opt = (k: string) => get(k) || undefined;
  switch (a.type) {
    case 'noauth':
      return ok({ type: 'none' });
    case 'bearer':
      return ok({ type: 'bearer', token: get('token') });
    case 'basic':
      return ok({ type: 'basic', username: get('username'), password: get('password') });
    case 'apikey':
      return ok({ type: 'apiKey', key: get('key'), value: get('value'), in: get('in') === 'query' ? 'query' : 'header' });
    case 'digest':
      return ok({ type: 'digest', username: get('username'), password: get('password') });
    case 'oauth1': {
      const sm = get('signatureMethod');
      return ok({
        type: 'oauth1',
        consumerKey: get('consumerKey'),
        consumerSecret: get('consumerSecret'),
        ...(opt('token') ? { token: opt('token') } : {}),
        ...(opt('tokenSecret') ? { tokenSecret: opt('tokenSecret') } : {}),
        ...(sm === 'HMAC-SHA256' || sm === 'PLAINTEXT' || sm === 'HMAC-SHA1' ? { signatureMethod: sm } : {}),
        ...(opt('realm') ? { realm: opt('realm') } : {}),
        ...(get('addParamsToHeader') === 'false' ? { addTo: 'query' as const } : {}),
      });
    }
    case 'awsv4':
      return ok({
        type: 'awsv4',
        accessKey: get('accessKey'),
        secretKey: get('secretKey'),
        region: get('region'),
        service: get('service'),
        ...(get('sessionToken') ? { sessionToken: get('sessionToken') } : {}),
      });
    case 'oauth2': {
      const notes: string[] = [];
      const g = get('grant_type');
      return ok(
        {
          type: 'oauth2',
          grantType: grant(
            'postman',
            where,
            g,
            {
              client_credentials: 'client_credentials',
              password_credentials: 'password',
              authorization_code: 'authorization_code',
              authorization_code_with_pkce: 'authorization_code',
              '': 'authorization_code',
            },
            notes,
          ),
          tokenUrl: get('accessTokenUrl'),
          authUrl: opt('authUrl'),
          clientId: get('clientId'),
          clientSecret: opt('clientSecret'),
          scope: opt('scope'),
          username: opt('username'),
          password: opt('password'),
          usePkce: g === 'authorization_code_with_pkce' || undefined,
          redirectUri: opt('redirect_uri'),
          clientAuth: get('client_authentication') === 'header' ? 'header' : undefined,
        },
        notes,
      );
    }
    case 'ntlm':
      return ntlm({ username: get('username'), password: get('password'), domain: get('domain'), workstation: get('workstation') });
    case 'hawk':
      return hawk({ id: get('authId'), key: get('authKey'), algorithm: get('algorithm'), ext: get('extraData'), app: get('app'), dlg: get('delegation'), payload: get('includePayloadHash') === 'true' });
    case 'edgegrid':
      return edgegrid({ clientToken: get('clientToken'), clientSecret: get('clientSecret'), accessToken: get('accessToken'), headersToSign: get('headersToSign') });
    case 'jwt':
      return jwt('postman', where, {
        algorithm: get('algorithm'),
        secret: get('secret'),
        payload: get('payload'),
        prefix: get('headerPrefix'),
        addTo: opt('addTokenTo'),
        base64Secret: get('isSecretBase64Encoded') === 'true',
      });
    default:
      return unsupported('postman', String(a.type), where);
  }
}

function insomnia(a: Any, where: string): ForeignAuth {
  switch (a.type) {
    case 'none':
      return ok({ type: 'none' });
    case 'bearer':
      return ok({ type: 'bearer', token: t(a.token), ...(a.prefix && a.prefix !== 'Bearer' ? { prefix: a.prefix } : {}) });
    case 'basic':
      return ok({ type: 'basic', username: t(a.username), password: t(a.password) });
    case 'digest':
      return ok({ type: 'digest', username: t(a.username), password: t(a.password) });
    case 'apikey':
      return ok({ type: 'apiKey', key: t(a.key), value: t(a.value), in: a.addTo === 'queryParams' ? 'query' : 'header' });
    case 'oauth1':
      return ok({
        type: 'oauth1',
        consumerKey: t(a.consumerKey),
        consumerSecret: t(a.consumerSecret),
        token: t(a.tokenKey),
        tokenSecret: t(a.tokenSecret),
        signatureMethod: a.signatureMethod === 'HMAC-SHA256' ? 'HMAC-SHA256' : a.signatureMethod === 'PLAINTEXT' ? 'PLAINTEXT' : 'HMAC-SHA1',
      });
    case 'oauth2': {
      const notes: string[] = [];
      return ok(
        {
          type: 'oauth2',
          grantType: grant(
            'insomnia',
            where,
            String(a.grantType ?? ''),
            { password: 'password', authorization_code: 'authorization_code', client_credentials: 'client_credentials', '': 'client_credentials' },
            notes,
          ),
          tokenUrl: t(a.accessTokenUrl),
          authUrl: a.authorizationUrl ? t(a.authorizationUrl) : undefined,
          clientId: t(a.clientId),
          clientSecret: t(a.clientSecret),
          scope: a.scope ? t(a.scope) : undefined,
          username: a.username ? t(a.username) : undefined,
          password: a.password ? t(a.password) : undefined,
          usePkce: !!a.usePkce,
        },
        notes,
      );
    }
    case 'ntlm':
      return ntlm(a);
    case 'hawk':
      return hawk({ id: a.id, key: a.key, algorithm: a.algorithm, ext: a.ext, payload: !!a.validatePayload });
    case 'iam':
      return ok({
        type: 'awsv4',
        accessKey: t(a.accessKeyId),
        secretKey: t(a.secretAccessKey),
        sessionToken: a.sessionToken ? t(a.sessionToken) : undefined,
        region: t(a.region),
        service: t(a.service),
      });
    case 'jwt':
      return jwt('insomnia', where, { algorithm: a.algorithm, secret: a.secret, payload: typeof a.payload === 'string' ? a.payload : JSON.stringify(a.payload ?? {}), prefix: a.prefix });
    default:
      return unsupported('insomnia', String(a.type), where);
  }
}

function bruno(a: Any, where: string): ForeignAuth {
  switch (a.mode) {
    case 'none':
      return ok({ type: 'none' });
    case 'inherit':
      return ok({ type: 'inherit' });
    case 'bearer':
      return ok({ type: 'bearer', token: t(a.bearer?.token) });
    case 'basic':
      return ok({ type: 'basic', username: t(a.basic?.username), password: t(a.basic?.password) });
    case 'digest':
      return ok({ type: 'digest', username: t(a.digest?.username), password: t(a.digest?.password) });
    case 'apikey':
      return ok({ type: 'apiKey', key: t(a.apikey?.key), value: t(a.apikey?.value), in: a.apikey?.placement === 'queryparams' ? 'query' : 'header' });
    case 'awsv4':
      return ok({
        type: 'awsv4',
        accessKey: t(a.awsv4?.accessKeyId),
        secretKey: t(a.awsv4?.secretAccessKey),
        sessionToken: a.awsv4?.sessionToken ? t(a.awsv4.sessionToken) : undefined,
        region: t(a.awsv4?.region),
        service: t(a.awsv4?.service),
      });
    case 'oauth2': {
      const notes: string[] = [];
      const o = a.oauth2 ?? {};
      return ok(
        {
          type: 'oauth2',
          grantType: grant(
            'bruno',
            where,
            String(o.grantType ?? ''),
            { password: 'password', authorization_code: 'authorization_code', client_credentials: 'client_credentials', '': 'client_credentials' },
            notes,
          ),
          tokenUrl: t(o.accessTokenUrl),
          clientId: t(o.clientId),
          clientSecret: t(o.clientSecret),
          scope: o.scope ? t(o.scope) : undefined,
        },
        notes,
      );
    }
    case 'ntlm':
      return ntlm(a.ntlm ?? {});
    case 'akamai-edgegrid': {
      const e = a['akamai-edgegrid'] ?? {};
      return edgegrid({ clientToken: e.client_token, clientSecret: e.client_secret, accessToken: e.access_token, headersToSign: e.headers_to_sign });
    }
    case 'jwt': {
      const j = a.jwt ?? a;
      return jwt('bruno', where, { algorithm: j.algorithm, secret: j.secret, payload: j.payload, prefix: j.prefix });
    }
    default:
      return unsupported('bruno', String(a.mode), where);
  }
}

function hoppscotch(a: Any, where: string): ForeignAuth {
  if (a.authActive === false || a.authType === 'none') return ok({ type: 'none' });
  switch (a.authType) {
    case 'inherit':
      return ok({ type: 'inherit' });
    case 'bearer':
      return ok({ type: 'bearer', token: t(a.token) });
    case 'basic':
      return ok({ type: 'basic', username: t(a.username), password: t(a.password) });
    case 'digest':
      return ok({ type: 'digest', username: t(a.username), password: t(a.password) });
    case 'api-key':
      return ok({ type: 'apiKey', key: t(a.key), value: t(a.value), in: a.addTo === 'QUERY_PARAMS' ? 'query' : 'header' });
    case 'oauth-2': {
      const g = a.grantTypeInfo ?? {};
      const notes = g.grantType && g.grantType !== 'CLIENT_CREDENTIALS' ? [`"${where}": Hoppscotch OAuth 2 grant "${g.grantType}" is not supported: imported as client credentials, check it`] : [];
      return ok(
        {
          type: 'oauth2',
          grantType: 'client_credentials',
          tokenUrl: t(g.authEndpoint ?? a.accessTokenURL),
          clientId: t(g.clientID ?? a.clientID),
          clientSecret: t(g.clientSecret),
          scope: g.scopes ?? a.scope,
        },
        notes,
      );
    }
    case 'jwt':
      return jwt('hoppscotch', where, { algorithm: a.algorithm, secret: a.secret, payload: a.payload, prefix: a.headerPrefix, addTo: a.addTo === 'QUERY_PARAMS' ? 'query' : undefined });
    default:
      return unsupported('hoppscotch', String(a.authType), where);
  }
}

/**
 * The auth of an imported request, folder or collection (`where` names it in the notes). `auth` is undefined when the
 * source has none (the item inherits); an unsupported scheme gives `none` + a disabled placeholder header + a note.
 */
export function mapForeignAuth(tool: ForeignTool, raw: unknown, where: string): ForeignAuth {
  const a = raw && typeof raw === 'object' ? (raw as Any) : undefined;
  if (!a) return { notes: [], headers: [] };
  switch (tool) {
    case 'postman':
      return a.type ? postman(a, where) : { notes: [], headers: [] };
    case 'insomnia':
      // a disabled auth sends nothing; an empty one ({}) inherits
      if (a.disabled) return ok({ type: 'none' });
      return a.type ? insomnia(a, where) : { notes: [], headers: [] };
    case 'bruno':
      return a.mode ? bruno(a, where) : { notes: [], headers: [] };
    case 'hoppscotch':
      return a.authType ? hoppscotch(a, where) : { notes: [], headers: [] };
  }
}
