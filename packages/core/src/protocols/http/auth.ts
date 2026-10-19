import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuthConfig } from '../../model/types.js';
import { ApsError } from '../../errors.js';
import type { Redactor } from '../../util/redact.js';

export interface AuthContext {
  redactor?: Redactor;
  signal?: AbortSignal;
  /** Opens a URL in the user's browser (desktop only) — required for authorization_code flows. */
  openExternal?: (url: string) => Promise<void> | void;
  fetchImpl?: typeof fetch;
}

interface CachedToken {
  accessToken: string;
  tokenType: string;
  expiresAt: number;
  /** Used for a new access token when this one expires, so the browser isn't needed again. */
  refreshToken?: string;
}

const tokenCache = new Map<string, CachedToken>();

/** Forget cached OAuth 2.0 tokens, so the next request gets a new one. Returns how many were dropped. */
export function clearTokenCache(): number {
  const n = tokenCache.size;
  tokenCache.clear();
  return n;
}

/**
 * Apply an (already variable-resolved) auth config to request headers/url.
 * Mutates and returns the given headers map and URL.
 */
export async function applyAuth(auth: AuthConfig | undefined, headers: Headers, url: URL, ctx: AuthContext = {}): Promise<void> {
  if (!auth || auth.type === 'none' || auth.type === 'inherit') return;
  const r = ctx.redactor;
  switch (auth.type) {
    case 'apiKey': {
      r?.addSecret(auth.value);
      if (auth.in === 'query') url.searchParams.set(auth.key, auth.value);
      else headers.set(auth.key, auth.value);
      return;
    }
    case 'basic': {
      r?.addSecret(auth.password);
      const enc = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      r?.addSecret(enc);
      headers.set('Authorization', `Basic ${enc}`);
      return;
    }
    case 'bearer': {
      r?.addSecret(auth.token);
      headers.set('Authorization', `${auth.prefix ?? 'Bearer'} ${auth.token}`);
      return;
    }
    case 'jwt': {
      r?.addSecret(auth.secret);
      const token = signJwt(auth.payload, auth.secret, auth.algorithm ?? 'HS256', auth.expiresInSec);
      r?.addSecret(token);
      headers.set('Authorization', `${auth.prefix ?? 'Bearer'} ${token}`);
      return;
    }
    case 'headers': {
      for (const h of auth.headers) if (h.enabled !== false && h.key) headers.set(h.key, h.value);
      return;
    }
    // signed from the final request by the HTTP client (see signing.ts, hawk.ts, edgegrid.ts, ntlm.ts)
    case 'digest':
      r?.addSecret(auth.password);
      return;
    case 'oauth1':
      r?.addSecret(auth.consumerSecret);
      r?.addSecret(auth.tokenSecret);
      return;
    case 'awsv4':
      r?.addSecret(auth.secretKey);
      r?.addSecret(auth.sessionToken);
      return;
    case 'ntlm':
      r?.addSecret(auth.password);
      return;
    case 'hawk':
      r?.addSecret(auth.key);
      return;
    case 'edgegrid':
      r?.addSecret(auth.clientSecret);
      r?.addSecret(auth.accessToken);
      return;
    case 'oauth2': {
      const tok = await getOAuth2Token(auth, ctx);
      r?.addSecret(tok.accessToken);
      headers.set('Authorization', `${tok.tokenType || 'Bearer'} ${tok.accessToken}`);
      return;
    }
  }
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

export function signJwt(payloadJson: string, secret: string, alg: 'HS256' | 'HS384' | 'HS512', expiresInSec?: number): string {
  let payload: Record<string, unknown>;
  try {
    payload = payloadJson.trim() ? JSON.parse(payloadJson) : {};
  } catch (e) {
    throw new ApsError('ConfigurationError', 'JWT payload is not valid JSON', { cause: e });
  }
  const now = Math.floor(Date.now() / 1000);
  if (expiresInSec) {
    payload.iat ??= now;
    payload.exp ??= now + expiresInSec;
  }
  const header = b64url(JSON.stringify({ alg, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const hash = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' }[alg];
  const sig = createHmac(hash, secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

async function getOAuth2Token(auth: Extract<AuthConfig, { type: 'oauth2' }>, ctx: AuthContext): Promise<CachedToken> {
  const key = [auth.grantType, auth.tokenUrl, auth.clientId, auth.scope ?? '', auth.username ?? '', auth.audience ?? ''].join('|');
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 10_000) return cached;
  ctx.redactor?.addSecret(auth.clientSecret);
  ctx.redactor?.addSecret(auth.password);

  // an expired token with a refresh token: refresh it (no browser); if the server refuses, start over
  if (cached?.refreshToken) {
    ctx.redactor?.addSecret(cached.refreshToken);
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cached.refreshToken });
    if (auth.scope) form.set('scope', auth.scope);
    try {
      return await requestToken(auth, form, key, ctx, cached.refreshToken);
    } catch (e) {
      if ((e as ApsError).kind !== 'AuthenticationError') throw e;
      tokenCache.delete(key);
    }
  }

  const form = new URLSearchParams();
  form.set('grant_type', auth.grantType);
  if (auth.scope) form.set('scope', auth.scope);
  if (auth.audience) form.set('audience', auth.audience);

  if (auth.grantType === 'password') {
    form.set('username', auth.username ?? '');
    form.set('password', auth.password ?? '');
  } else if (auth.grantType === 'authorization_code') {
    const { code, verifier, redirectUri } = await authorizationCodeFlow(auth, ctx);
    form.set('code', code);
    form.set('redirect_uri', redirectUri);
    if (verifier) form.set('code_verifier', verifier);
  }
  return requestToken(auth, form, key, ctx);
}

/** POST to the token URL with the client's credentials (form body, or a Basic header) and cache the answer. */
async function requestToken(auth: Extract<AuthConfig, { type: 'oauth2' }>, form: URLSearchParams, key: string, ctx: AuthContext, previousRefresh?: string): Promise<CachedToken> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (auth.clientAuth === 'header') {
    // RFC 6749 §2.3.1: form-urlencode id and secret, then Basic
    const basic = Buffer.from(`${encodeURIComponent(auth.clientId)}:${encodeURIComponent(auth.clientSecret ?? '')}`).toString('base64');
    ctx.redactor?.addSecret(basic);
    headers.authorization = `Basic ${basic}`;
  } else {
    form.set('client_id', auth.clientId);
    if (auth.clientSecret) form.set('client_secret', auth.clientSecret);
  }
  const f = ctx.fetchImpl ?? fetch;
  const res = await f(auth.tokenUrl, {
    method: 'POST',
    headers,
    body: form.toString(),
    signal: ctx.signal,
  });
  const text = await res.text();
  if (!res.ok)
    throw new ApsError('AuthenticationError', `OAuth 2.0 token request failed with HTTP ${res.status}`, {
      details: { body: ctx.redactor?.redactString(text.slice(0, 2000)) ?? text.slice(0, 2000) },
      suggestions: ['Check client id/secret and token URL.', 'Check the requested scopes are allowed for this client.'],
    });
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    data = Object.fromEntries(new URLSearchParams(text));
  }
  const accessToken = String(data.access_token ?? '');
  if (!accessToken) throw new ApsError('AuthenticationError', 'OAuth 2.0 token response did not contain access_token');
  // a refresh answer may leave out the refresh token: keep using the previous one
  const refreshToken = typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : previousRefresh;
  ctx.redactor?.addSecret(refreshToken);
  const tok: CachedToken = {
    accessToken,
    tokenType: String(data.token_type ?? 'Bearer').replace(/^bearer$/i, 'Bearer'),
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    ...(refreshToken ? { refreshToken } : {}),
  };
  tokenCache.set(key, tok);
  return tok;
}

/** A callback URL the app can listen on: http on localhost / 127.0.0.1 / [::1], with an explicit port. */
export function loopbackRedirect(uri: string): { hosts: string[]; port: number; path: string } {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new ApsError('ConfigurationError', `Callback URL "${uri}" is not a URL`);
  }
  const host = u.hostname === 'localhost' ? '127.0.0.1' : u.hostname === '[::1]' ? '::1' : u.hostname;
  if (u.protocol !== 'http:' || !['127.0.0.1', '::1'].includes(host) || !u.port)
    throw new ApsError('ConfigurationError', 'The callback URL must be http://localhost:<port>/… or http://127.0.0.1:<port>/… (TestPion listens there for the redirect)', {
      suggestions: ['Register a loopback callback such as http://localhost:8080/callback with the provider.'],
    });
  return { hosts: u.hostname === 'localhost' ? ['127.0.0.1', '::1'] : [host], port: Number(u.port), path: u.pathname || '/' };
}

/** Authorization Code (+PKCE) flow using a loopback redirect listener. */
async function authorizationCodeFlow(
  auth: Extract<AuthConfig, { type: 'oauth2' }>,
  ctx: AuthContext,
): Promise<{ code: string; verifier?: string; redirectUri: string }> {
  if (!auth.authUrl) throw new ApsError('ConfigurationError', 'Authorization URL is required for the authorization_code grant');
  if (!ctx.openExternal)
    throw new ApsError('ConfigurationError', 'The authorization_code grant needs a browser and is only available in the desktop app', {
      suggestions: ['Use client_credentials in CI, or obtain a token in the desktop app and store it as a secret variable.'],
    });

  const verifier = auth.usePkce !== false ? b64url(randomBytes(32)) : undefined;
  const challenge = verifier ? b64url(createHash('sha256').update(verifier).digest()) : undefined;
  const state = b64url(randomBytes(16));
  const fixed = auth.redirectUri?.trim() ? loopbackRedirect(auth.redirectUri.trim()) : undefined;

  return new Promise((resolve, reject) => {
    const servers: Server[] = [];
    // close keep-alive connections too: a browser reusing one would reach this finished listener next time
    const closeAll = () => servers.forEach((x) => (x.close(), x.closeAllConnections()));
    let redirectUri = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeAll();
      fn();
    };
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      // only the callback path counts (a browser may also ask for /favicon.ico)
      if (u.pathname !== (fixed?.path ?? '/callback')) {
        res.writeHead(404, { connection: 'close' }).end();
        return;
      }
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html', connection: 'close' });
      res.end(`<html><body style="font-family:sans-serif"><h3>${code ? 'Authorization complete' : 'Authorization failed'}</h3><p>You can close this window and return to TestPion.</p></body></html>`);
      finish(() => {
        if (err || !code) return reject(new ApsError('AuthenticationError', `Authorization failed: ${err ?? 'no code returned'}`));
        if (u.searchParams.get('state') !== state) return reject(new ApsError('AuthenticationError', 'OAuth state mismatch'));
        resolve({ code, verifier, redirectUri });
      });
    };
    const timer = setTimeout(() => finish(() => reject(new ApsError('TimeoutError', 'Timed out waiting for the OAuth redirect'))), 5 * 60_000);
    const listen = (host: string, port: number) =>
      new Promise<number>((ok, fail) => {
        const srv = createServer(handler);
        srv.once('error', fail);
        srv.listen(port, host, () => {
          servers.push(srv);
          ok((srv.address() as AddressInfo).port);
        });
      });
    const openBrowser = (port: number) => {
      redirectUri = fixed ? auth.redirectUri!.trim() : `http://127.0.0.1:${port}/callback`;
      const u = new URL(auth.authUrl!);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', auth.clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      if (auth.scope) u.searchParams.set('scope', auth.scope);
      if (auth.audience) u.searchParams.set('audience', auth.audience);
      if (challenge) {
        u.searchParams.set('code_challenge', challenge);
        u.searchParams.set('code_challenge_method', 'S256');
      }
      Promise.resolve(ctx.openExternal!(u.toString())).catch((e) => finish(() => reject(e)));
    };
    const [first, ...more] = fixed?.hosts ?? ['127.0.0.1'];
    listen(first!, fixed?.port ?? auth.redirectPort ?? 0)
      .then(async (port) => {
        // "localhost" may resolve to ::1 in the browser: listen there too when the machine has IPv6
        for (const h of more) await listen(h, port).catch(() => undefined);
        openBrowser(port);
      })
      .catch((e: NodeJS.ErrnoException) =>
        finish(() =>
          reject(
            new ApsError('ConfigurationError', e.code === 'EADDRINUSE' ? `Port ${fixed?.port ?? auth.redirectPort} of the callback URL is in use` : `Couldn't listen for the OAuth callback: ${e.message}`, {
              suggestions: ['Close the program using that port, or use another callback URL (it must also be registered with the provider).'],
            }),
          ),
        ),
      );
  });
}
