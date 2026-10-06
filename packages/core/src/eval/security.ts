import type { AuthConfig, CheckConfig, CheckResult, Collection, KeyValue } from '../model/types.js';
import { registerCheck, type CheckContext } from './checks.js';
import { collectionRequests } from '../runner/collection-run.js';
import { Redactor } from '../util/redact.js';

/**
 * API security basics.
 * - `security-headers` check: the response sets HSTS (on https), `X-Content-Type-Options: nosniff`, a
 *   clickjacking defence (X-Frame-Options or CSP frame-ancestors), doesn't allow any origin together
 *   with credentials, and doesn't reveal server versions. `values` lists items to skip.
 * - `securityLint(collection)`: request definitions that leak or weaken: hard-coded secrets, secrets in
 *   query strings, plain http to non-local hosts, disabled TLS verification, Basic auth over http.
 */
export const SECURITY_HEADER_ITEMS = ['hsts', 'nosniff', 'frame', 'cors', 'server-version'] as const;

registerCheck('security-headers', (cfg: CheckConfig, ctx: CheckContext): CheckResult => {
  const skip = new Set((Array.isArray(cfg.values) ? cfg.values : []).map((v) => String(v).toLowerCase()));
  const get = (n: string) => ctx.headers?.find(([k]) => k.toLowerCase() === n)?.[1];
  const https = /^https:/i.test(ctx.request?.url ?? '');
  const problems: string[] = [];
  if (!skip.has('hsts') && https && !get('strict-transport-security')) problems.push('no Strict-Transport-Security');
  if (!skip.has('nosniff') && !/nosniff/i.test(get('x-content-type-options') ?? '')) problems.push('no X-Content-Type-Options: nosniff');
  const html = /text\/html/i.test(get('content-type') ?? '');
  if (!skip.has('frame') && html && !get('x-frame-options') && !/frame-ancestors/i.test(get('content-security-policy') ?? '')) problems.push('HTML without X-Frame-Options or CSP frame-ancestors');
  if (!skip.has('cors') && get('access-control-allow-origin') === '*' && /true/i.test(get('access-control-allow-credentials') ?? '')) problems.push('CORS allows any origin with credentials');
  const server = [get('server'), get('x-powered-by'), get('x-aspnet-version')].filter(Boolean).join(', ');
  if (!skip.has('server-version') && /\d+\.\d+/.test(server)) problems.push(`server version exposed (${server})`);
  return {
    type: 'security-headers',
    name: cfg.name ?? 'security headers',
    passed: problems.length === 0,
    source: 'deterministic',
    message: problems.length ? problems.join('; ') : 'security headers look good',
  };
});

export interface SecurityFinding {
  severity: 'high' | 'medium' | 'low';
  where: string;
  message: string;
  requestId?: string;
  /** What kind of finding: a security weakness, or a variable nothing defines. */
  category?: 'security' | 'variables';
  /** For a value typed in: which part of the request holds it, and which field (header name, body key, auth field). */
  part?: 'auth' | 'headers' | 'params' | 'body';
  field?: string;
}

const SET_RE = /(?:pm|tp|aps)\.(?:environment|globals|collectionVariables|variables)\.set\(\s*['"`]([\w.-]+)['"`]/g;
const USE_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * Variables a collection's requests use that nothing defines: not in the environment / collection /
 * folder / workspace variables (`known`) and not set by a script of an earlier request. A variable set
 * only by a later request's script is reported as an order problem.
 */
export function variableFlow(collection: Collection, known: Iterable<string>): SecurityFinding[] {
  const defined = new Set(known);
  for (const v of collection.variables ?? []) if (v.key) defined.add(v.key);
  const refs = collectionRequests(collection);
  const setBy = new Map<string, number>();
  const scriptsOf = (i: number) => {
    const r = refs[i]!;
    return [collection.preRequestScript, collection.testScript, ...r.folders.flatMap((f) => [f.preRequestScript, f.testScript]), 'preRequestScript' in r.node ? r.node.preRequestScript : undefined, 'testScript' in r.node ? r.node.testScript : undefined].filter(Boolean).join('\n');
  };
  refs.forEach((_, i) => {
    for (const m of scriptsOf(i).matchAll(SET_RE)) if (!setBy.has(m[1]!)) setBy.set(m[1]!, i);
  });
  const out: SecurityFinding[] = [];
  refs.forEach((r, i) => {
    const folderVars = new Set(r.folders.flatMap((f) => (f.variables ?? []).map((v) => v.key)));
    const { preRequestScript: _p, testScript: _t, ...fields } = r.node as unknown as Record<string, unknown>;
    const used = new Set<string>();
    for (const m of JSON.stringify({ ...fields, auth: r.auth }).matchAll(USE_RE)) used.add(m[1]!);
    const where = [collection.name, ...r.path, r.name].join(' › ');
    for (const name of used) {
      if (name.startsWith('$') || defined.has(name) || folderVars.has(name) || name === 'workspaceDir') continue;
      const setter = setBy.get(name);
      // set by a pre-request script of the same request, or by any script of an earlier one
      if (setter !== undefined && setter < i) continue;
      if (setter === i && /\.set\(/.test(String(_p ?? '') + (collection.preRequestScript ?? '') + r.folders.map((f) => f.preRequestScript ?? '').join(''))) continue;
      if (setter !== undefined)
        out.push({ severity: 'low', category: 'variables', where, message: `{{${name}}} is set by a script of "${[...refs[setter]!.path, refs[setter]!.name].join(' / ')}", which runs after this request`, requestId: r.id });
      else out.push({ severity: 'medium', category: 'variables', where, message: `{{${name}}} is not defined anywhere (environment, collection, folder or workspace variables) and no script sets it`, requestId: r.id });
    }
  });
  return out;
}

const isVar = (s: string | undefined) => !!s && /^\s*\{\{[^}]+\}\}\s*$/.test(s);
const hasVar = (s: string | undefined) => !!s && /\{\{[^}]+\}\}/.test(s);
const localHost = (host: string) => /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|0\.0\.0\.0)/i.test(host) || /\.(test|local|localhost)$/i.test(host);

/** Secrets typed as plain values in auth settings (they belong in secret variables). */
/** The auth fields that hold a secret typed in: a label for people and the field's name (see AUTH_SECRET_FIELDS). */
export function literalAuthSecrets(auth: AuthConfig | undefined): Array<{ label: string; field: string }> {
  if (!auth) return [];
  const out: Array<{ label: string; field: string }> = [];
  const check = (label: string, field: string, v: string | undefined) => {
    if (v && !hasVar(v)) out.push({ label, field });
  };
  switch (auth.type) {
    case 'bearer':
      check('bearer token', 'token', auth.token);
      break;
    case 'basic':
    case 'digest':
      check('password', 'password', auth.password);
      break;
    case 'apiKey':
      check(`API key ${auth.key}`, 'value', auth.value);
      break;
    case 'jwt':
      check('JWT secret', 'secret', auth.secret);
      break;
    case 'oauth2':
      check('client secret', 'clientSecret', auth.clientSecret);
      check('password', 'password', auth.password);
      break;
    case 'oauth1':
      check('consumer secret', 'consumerSecret', auth.consumerSecret);
      check('token secret', 'tokenSecret', auth.tokenSecret);
      break;
    case 'awsv4':
      check('secret key', 'secretKey', auth.secretKey);
      break;
  }
  return out;
}

function literalSecrets(auth: AuthConfig | undefined): string[] {
  return literalAuthSecrets(auth).map((x) => x.label);
}

/**
 * Certificates of the collection's HTTPS hosts (as recorded when responses came back) that expire within 30 days:
 * one finding per host, high under 7 days. `resolve` turns a request URL with {{variables}} into a real one.
 */
export function certificateLint(collection: Collection, resolve: (url: string) => string, certs: Array<{ host: string; daysLeft?: number; validTo?: string; issuer?: string }>): SecurityFinding[] {
  const byHost = new Map(certs.map((c) => [c.host, c]));
  const seen = new Set<string>();
  const out: SecurityFinding[] = [];
  for (const ref of collectionRequests(collection)) {
    if (ref.node.kind !== 'http') continue;
    let host: string;
    try {
      const u = new URL(resolve(ref.node.request.url));
      if (u.protocol !== 'https:') continue;
      host = u.host;
    } catch {
      continue;
    }
    if (seen.has(host)) continue;
    seen.add(host);
    const c = byHost.get(host);
    if (!c || c.daysLeft === undefined || c.daysLeft >= 30) continue;
    const when = c.validTo ? ` (${c.validTo.slice(0, 10)})` : '';
    out.push({
      category: 'security',
      severity: c.daysLeft < 7 ? 'high' : 'medium',
      where: [collection.name, ...ref.path, ref.name].join(' › '),
      message: c.daysLeft < 0 ? `The TLS certificate of ${host} has expired${when}` : `The TLS certificate of ${host} expires in ${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'}${when}: renew it before clients start failing`,
      requestId: ref.id,
    });
  }
  return out;
}

/** Security findings in a collection's request definitions, most severe first. */
export function securityLint(collection: Collection, redactFields?: string[]): SecurityFinding[] {
  const red = new Redactor(redactFields);
  const out: SecurityFinding[] = [];
  const add = (f: SecurityFinding) => out.push({ category: 'security', ...f });
  for (const s of literalAuthSecrets(collection.auth)) add({ severity: 'high', where: collection.name, message: `The collection's auth has a ${s.label} typed in: use a secret variable`, part: 'auth', field: s.field });
  for (const ref of collectionRequests(collection)) {
    const where = [collection.name, ...ref.path, ref.name].join(' › ');
    if (ref.node.kind !== 'http') continue;
    const r = ref.node.request;
    const own = r.auth && r.auth.type !== 'inherit' ? r.auth : undefined;
    for (const s of literalAuthSecrets(own)) add({ severity: 'high', where, message: `A ${s.label} is typed into the request: use a secret variable`, requestId: ref.id, part: 'auth', field: s.field });
    const kvSecret = (rows: KeyValue[] | undefined) => (rows ?? []).filter((h) => h.enabled !== false && h.key && h.value && red.isSensitiveKey(h.key) && !hasVar(h.value));
    for (const h of kvSecret(r.headers)) add({ severity: 'high', where, message: `Header ${h.key} holds a value typed in: use a secret variable`, requestId: ref.id, part: 'headers', field: h.key });
    const querySecrets = [...kvSecret(r.params), ...(r.params ?? []).filter((p) => p.enabled !== false && red.isSensitiveKey(p.key) && isVar(p.value))];
    for (const p of querySecrets) add({ severity: 'medium', where, message: `The secret "${p.key}" is sent in the query string, where proxies and server logs keep it: send it in a header`, requestId: ref.id });
    let host = '';
    let protocol = '';
    const m = /^([a-z]+):\/\/([^/:?#]+)/i.exec(r.url);
    if (m) {
      protocol = m[1]!.toLowerCase();
      host = m[2]!;
    }
    if (protocol === 'http' && host && !localHost(host)) {
      add({ severity: 'medium', where, message: `Plain http to ${host}: requests and credentials travel unencrypted`, requestId: ref.id });
      if (ref.auth && ['basic', 'bearer', 'apiKey', 'digest', 'oauth2'].includes(ref.auth.type)) add({ severity: 'high', where, message: `Credentials (${ref.auth.type}) over plain http to ${host}`, requestId: ref.id });
    }
    if (r.settings?.insecure) add({ severity: 'medium', where, message: 'TLS certificate verification is turned off for this request', requestId: ref.id });
    if (r.body && 'content' in r.body && r.body.type === 'json') {
      try {
        const walk = (v: unknown, key = ''): void => {
          if (typeof v === 'string' && key && red.isSensitiveKey(key) && v && !hasVar(v)) add({ severity: 'high', where, message: `The body field "${key}" holds a value typed in: use a secret variable`, requestId: ref.id, part: 'body', field: key });
          else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, Array.isArray(v) ? key : k);
        };
        walk(JSON.parse(r.body.content));
      } catch {
        /* not JSON (variables in it) */
      }
    }
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
