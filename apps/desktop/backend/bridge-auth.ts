import { timingSafeEqual } from 'node:crypto';

/**
 * Who may talk to the development bridge (web-server.ts): the per-process token in the `x-aps-token` header, nowhere else.
 * A token in the URL ends up in browser history, access logs and `Referer`, so a URL that carries one is refused (not
 * accepted): the page never holds the token, the dev server's proxy adds the header (vite.config.ts).
 */
export type BridgeAuth = 'ok' | 'token-in-url' | 'forbidden';

const sameToken = (given: unknown, token: string): boolean => typeof given === 'string' && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));

export function bridgeAuth(url: URL, headers: Record<string, string | string[] | undefined>, token: string): BridgeAuth {
  if (url.searchParams.has('token')) return 'token-in-url';
  return sameToken(headers['x-aps-token'], token) ? 'ok' : 'forbidden';
}
