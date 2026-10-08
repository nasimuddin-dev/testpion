import { secretKeys, type SecretStore } from '../storage/secrets.js';

/** A cookie kept in the jar (RFC 6265 storage model, simplified). */
export interface StoredCookie {
  name: string;
  value: string;
  /** Lower-case domain without a leading dot. */
  domain: string;
  path: string;
  /** ISO timestamp; absent = session cookie (kept until cleared). */
  expires?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  /** true when the Set-Cookie had no Domain attribute: only sent to that exact host. */
  hostOnly?: boolean;
}

export type CookieInput = Pick<StoredCookie, 'name' | 'value'> & Partial<Omit<StoredCookie, 'name' | 'value'>>;

const isIp = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');

/** RFC 6265 §5.1.3 domain matching. */
function domainMatches(host: string, domain: string): boolean {
  host = host.toLowerCase();
  return host === domain || (!isIp(host) && host.endsWith('.' + domain));
}

/** RFC 6265 §5.1.4 path matching. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/** Default path: the request path up to (not including) its last `/`. */
function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const i = pathname.lastIndexOf('/');
  return i <= 0 ? '/' : pathname.slice(0, i);
}

/** Localhost is a "potentially trustworthy" origin: Secure cookies are sent over plain http to it. */
const trustworthy = (u: URL) => u.protocol === 'https:' || u.protocol === 'wss:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';

/** Parse one Set-Cookie header into a cookie for the jar, or undefined when it must be ignored. */
export function parseSetCookieHeader(header: string, requestUrl: string | URL, now = Date.now()): StoredCookie | undefined {
  const url = typeof requestUrl === 'string' ? new URL(requestUrl) : requestUrl;
  const [pair, ...attrs] = header.split(';');
  const eq = (pair ?? '').indexOf('=');
  const name = (eq < 0 ? '' : pair!.slice(0, eq)).trim();
  const value = (eq < 0 ? pair ?? '' : pair!.slice(eq + 1)).trim();
  if (!name && !value) return undefined;
  const host = url.hostname.toLowerCase();
  const c: StoredCookie = { name, value, domain: host, path: defaultPath(url.pathname), hostOnly: true };
  let maxAge: number | undefined;
  let expires: number | undefined;
  for (const a of attrs) {
    const i = a.indexOf('=');
    const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? '' : a.slice(i + 1).trim();
    if (k === 'domain' && v) {
      const d = v.replace(/^\./, '').toLowerCase();
      // a server may only set cookies for its own domain or a parent domain (not a bare TLD)
      if (!domainMatches(host, d) || (!d.includes('.') && d !== host)) return undefined;
      c.domain = d;
      c.hostOnly = false;
    } else if (k === 'path' && v.startsWith('/')) c.path = v;
    else if (k === 'max-age' && /^-?\d+$/.test(v)) maxAge = Number(v);
    else if (k === 'expires') {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) expires = t;
    } else if (k === 'secure') c.secure = true;
    else if (k === 'httponly') c.httpOnly = true;
    else if (k === 'samesite' && v) c.sameSite = v;
  }
  if (c.secure && !trustworthy(url)) return undefined;
  // Max-Age wins over Expires
  const exp = maxAge !== undefined ? now + maxAge * 1000 : expires;
  if (exp !== undefined) c.expires = new Date(exp).toISOString();
  return c;
}

const expired = (c: StoredCookie, now: number) => !!c.expires && Date.parse(c.expires) <= now;
const sameKey = (a: StoredCookie, b: Pick<StoredCookie, 'name' | 'domain' | 'path'>) => a.name === b.name && a.domain === b.domain && a.path === b.path;

/**
 * Per-workspace cookie jar. Stores cookies from `Set-Cookie` responses and adds matching cookies
 * to later requests (domain, path, Secure and expiry rules as in RFC 6265). `onChange` fires after
 * every modification so a host can persist the jar.
 */
export class CookieJar {
  private cookies: StoredCookie[];
  onChange?: () => void;

  constructor(cookies: StoredCookie[] = []) {
    this.cookies = cookies.filter((c) => c && c.name !== undefined && c.domain);
  }

  private changed(): void {
    this.onChange?.();
  }

  private purge(now = Date.now()): void {
    this.cookies = this.cookies.filter((c) => !expired(c, now));
  }

  private upsert(c: StoredCookie, now = Date.now()): void {
    this.cookies = this.cookies.filter((x) => !sameKey(x, c));
    // an already-expired cookie (Max-Age=0 / past Expires) is how servers delete cookies
    if (!expired(c, now)) this.cookies.push(c);
  }

  /** Store the `Set-Cookie` headers of a response to `url`. Returns how many were accepted. */
  storeFromResponse(url: string | URL, setCookieHeaders: string[]): number {
    const now = Date.now();
    let n = 0;
    for (const h of setCookieHeaders) {
      const c = parseSetCookieHeader(h, url, now);
      if (!c) continue;
      this.upsert(c, now);
      n++;
    }
    if (n) this.changed();
    return n;
  }

  /** Cookies to send with a request to `url`, longest path first (RFC 6265 §5.4). */
  cookiesFor(url: string | URL): StoredCookie[] {
    let u: URL;
    try {
      u = typeof url === 'string' ? new URL(url) : url;
    } catch {
      return [];
    }
    const now = Date.now();
    const host = u.hostname.toLowerCase();
    return this.cookies
      .filter((c) => !expired(c, now))
      .filter((c) => (c.hostOnly ? host === c.domain : domainMatches(host, c.domain)))
      .filter((c) => pathMatches(u.pathname || '/', c.path))
      .filter((c) => !c.secure || trustworthy(u))
      .sort((a, b) => b.path.length - a.path.length);
  }

  /** `Cookie` header value for `url` ('' when none match). */
  headerFor(url: string | URL, exclude?: Set<string>): string {
    return this.cookiesFor(url)
      .filter((c) => !exclude?.has(c.name))
      .map((c) => (c.name ? `${c.name}=${c.value}` : c.value))
      .join('; ');
  }

  /** All live cookies (optionally for one domain), sorted by domain, then name. */
  list(domain?: string): StoredCookie[] {
    this.purge();
    const d = domain?.replace(/^\./, '').toLowerCase();
    return this.cookies
      .filter((c) => !d || c.domain === d)
      .map((c) => ({ ...c }))
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }

  domains(): string[] {
    return [...new Set(this.list().map((c) => c.domain))];
  }

  /** Add or replace a cookie (Cookies dialog, `pm.cookies.jar().set`). */
  set(input: CookieInput): StoredCookie {
    const domain = (input.domain ?? '').replace(/^\./, '').trim().toLowerCase();
    if (!domain) throw new Error('A cookie needs a domain');
    if (!input.name?.trim()) throw new Error('A cookie needs a name');
    const c: StoredCookie = {
      name: input.name.trim(),
      value: input.value ?? '',
      domain,
      path: input.path?.startsWith('/') ? input.path : '/',
      expires: input.expires || undefined,
      secure: input.secure || undefined,
      httpOnly: input.httpOnly || undefined,
      sameSite: input.sameSite || undefined,
      hostOnly: input.hostOnly ?? false,
    };
    this.upsert(c);
    this.changed();
    return { ...c };
  }

  /** Remove cookies by name on a domain (every path unless `path` is given). */
  remove(domain: string, name: string, path?: string): number {
    const d = domain.replace(/^\./, '').toLowerCase();
    const before = this.cookies.length;
    this.cookies = this.cookies.filter((c) => !(c.domain === d && c.name === name && (path === undefined || c.path === path)));
    const n = before - this.cookies.length;
    if (n) this.changed();
    return n;
  }

  /** Remove all cookies, or all cookies of one domain. */
  clear(domain?: string): number {
    const d = domain?.replace(/^\./, '').toLowerCase();
    const before = this.cookies.length;
    this.cookies = d ? this.cookies.filter((c) => c.domain !== d) : [];
    const n = before - this.cookies.length;
    if (n) this.changed();
    return n;
  }

  toJSON(): StoredCookie[] {
    this.purge();
    return this.cookies.map((c) => ({ ...c }));
  }
}

/**
 * Read a cookie jar file: TestPion' own format (`{ cookies: [...] }` or a plain list) or the
 * tough-cookie JSON that Newman's `--export-cookie-jar` writes (`key` instead of `name`).
 */
export function cookiesFromJson(data: unknown): StoredCookie[] {
  const list = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { cookies?: unknown }).cookies) ? (data as { cookies: unknown[] }).cookies : undefined;
  if (!list) throw new Error('Not a cookie jar file: expected a list of cookies or { "cookies": [...] }');
  const out: StoredCookie[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const name = String(c.name ?? c.key ?? '');
    const domain = String(c.domain ?? '').replace(/^\./, '').toLowerCase();
    if (!domain) continue;
    const exp = c.expires;
    const expires = typeof exp === 'string' && exp !== 'Infinity' && !Number.isNaN(Date.parse(exp)) ? new Date(exp).toISOString() : typeof exp === 'number' ? new Date(exp).toISOString() : undefined;
    out.push({
      name,
      value: String(c.value ?? ''),
      domain,
      path: typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/',
      expires,
      secure: c.secure === true || undefined,
      httpOnly: c.httpOnly === true || undefined,
      sameSite: typeof c.sameSite === 'string' && c.sameSite !== 'none' ? c.sameSite : undefined,
      hostOnly: c.hostOnly === true || undefined,
    });
  }
  return out;
}

/** A change a script made through `pm.cookies.jar()`, applied by the host after the script ends. */
export type CookieJarOp = { op: 'set'; url: string; name: string; value: string; path?: string } | { op: 'unset'; url: string; name: string } | { op: 'clear'; url: string };

/** Apply the jar changes a script recorded. The domain is the host of the URL the script passed. */
export function applyCookieJarOps(jar: CookieJar, ops: CookieJarOp[] | undefined): void {
  for (const o of ops ?? []) {
    let host: string;
    try {
      host = new URL(o.url.includes('://') ? o.url : `http://${o.url}`).hostname;
    } catch {
      continue;
    }
    if (o.op === 'set') jar.set({ name: o.name, value: o.value, domain: host, path: o.path, hostOnly: true });
    else if (o.op === 'unset') jar.remove(host, o.name);
    else jar.clear(host);
  }
}

/**
 * Keeps a workspace's cookie jar on this machine. The whole jar is one value in the secret store,
 * so it is encrypted at rest (OS credential store) and never written to workspace files. With a
 * read-only secret store (CLI) the jar lives in memory for the run only.
 */
export class CookieJarStore {
  readonly jar: CookieJar;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private secrets: SecretStore,
    private workspaceId: string,
    private debounceMs = 250,
  ) {
    let cookies: StoredCookie[] = [];
    try {
      const raw = secrets.get(secretKeys.cookies(workspaceId));
      if (raw) cookies = JSON.parse(raw) as StoredCookie[];
    } catch {
      /* unreadable jar: start empty */
    }
    this.jar = new CookieJar(Array.isArray(cookies) ? cookies : []);
    this.jar.onChange = () => this.schedule();
  }

  /** true when the jar survives a restart (a writable store that is not memory-only). */
  get persistent(): boolean {
    return this.secrets.writable && !/^memory\b/.test(this.secrets.kind);
  }

  private schedule(): void {
    if (!this.secrets.writable) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /** Write pending changes now. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.secrets.writable) return;
    const cookies = this.jar.toJSON();
    if (cookies.length) await this.secrets.set(secretKeys.cookies(this.workspaceId), JSON.stringify(cookies));
    else await this.secrets.delete(secretKeys.cookies(this.workspaceId));
  }
}
