/**
 * Cookies carried from one turn of a conversation to the next (a RAG target with `conversation: { mode: 'server-session',
 * cookies: true }`). Some systems keep the session in a cookie the first answer sets, not in the body or a header the mapping
 * could read: the cookies each response sets are kept for the conversation and sent back as the `Cookie` header of the next
 * turn. Only this conversation: nothing is shared between conversations, nothing is kept after it, nothing is written to a
 * result; the values are registered with the redactor as secrets, so a log or a trace shows them masked.
 */

/** `name=value` of one Set-Cookie header, or the name to forget (an expired cookie or `Max-Age=0`). */
export function parseSetCookie(header: string): { name: string; value?: string } | undefined {
  const [pair = '', ...attrs] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return undefined;
  const name = pair.slice(0, eq).trim();
  if (!name || /[\s()<>@,;:\\"/[\]?={}]/.test(name)) return undefined;
  const value = pair.slice(eq + 1).trim();
  for (const a of attrs) {
    const [k = '', v = ''] = a.split('=');
    const key = k.trim().toLowerCase();
    if (key === 'max-age' && Number(v.trim()) <= 0) return { name };
    if (key === 'expires') {
      const t = Date.parse(v.trim());
      if (Number.isFinite(t) && t <= Date.now()) return { name };
    }
  }
  return value === '' ? { name } : { name, value };
}

/** The cookies of one conversation. */
export class ConversationCookies {
  private jar = new Map<string, string>();

  /** Takes the Set-Cookie headers of a response (headers as the check context holds them: pairs, names in any case). */
  take(headers: Array<[string, string]> | undefined): void {
    for (const [k, v] of headers ?? []) {
      if (k.toLowerCase() !== 'set-cookie') continue;
      // one header line may hold several cookies only as a joined list; the client keeps them apart, so each entry is one cookie
      const c = parseSetCookie(v);
      if (!c) continue;
      if (c.value === undefined) this.jar.delete(c.name);
      else this.jar.set(c.name, c.value);
    }
  }

  get size(): number {
    return this.jar.size;
  }

  /** The `Cookie` header value for the next request, or '' when the conversation has no cookie. */
  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** The cookie values (for the redactor). */
  values(): string[] {
    return [...this.jar.values()];
  }
}

/** The headers of a step with the conversation's cookies added to any `Cookie` the target writes itself. */
export function withCookieHeader(headers: unknown, cookie: string): unknown {
  if (!cookie) return headers;
  if (Array.isArray(headers)) {
    const at = headers.findIndex((h) => h && typeof h === 'object' && String((h as { key?: unknown }).key ?? '').toLowerCase() === 'cookie');
    if (at < 0) return [...headers, { key: 'Cookie', value: cookie }];
    return headers.map((h, i) => (i === at ? { ...(h as object), value: `${String((h as { value?: unknown }).value ?? '')}; ${cookie}`.replace(/^; /, '') } : h));
  }
  const map = headers && typeof headers === 'object' ? { ...(headers as Record<string, unknown>) } : {};
  const own = Object.keys(map).find((k) => k.toLowerCase() === 'cookie');
  if (own) map[own] = `${String(map[own] ?? '')}; ${cookie}`.replace(/^; /, '');
  else map.Cookie = cookie;
  return map;
}
