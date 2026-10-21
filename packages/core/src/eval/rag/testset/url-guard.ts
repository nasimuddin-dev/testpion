/**
 * Fetching a document by URL, guarded (planning/rag-testing.md §4b). A document URL is not an API under test, so the guard is
 * strict even where the desktop network policy allows private networks: https only, no credentials in the URL, every address
 * the host resolves to must be public (checked before the request and again when the socket connects, so DNS rebinding
 * cannot slip in), at most 3 redirects and only to the same host, a 2 MB cap read as a stream, 30 s, text types only.
 * The fetch and the resolver are injectable: tests never touch the network.
 */
import { lookup as dnsLookup } from 'node:dns';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { ApsError } from '../../../errors.js';
import { isPrivateAddress } from '../../../net/policy.js';

export const MAX_DOC_BYTES = 2 * 1024 * 1024;
export const MAX_URLS = 20;
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const TYPES = /^(text\/html|text\/plain|text\/markdown|text\/x-markdown|application\/xhtml\+xml)\b/i;

export interface GuardDeps {
  /** Every address of a host. */
  resolve?(host: string): Promise<string[]>;
  fetchImpl?(url: string, init: { signal: AbortSignal; redirect: 'manual' }): Promise<Pick<Response, 'status' | 'headers' | 'body'>>;
}

const refuse = (url: string, why: string) =>
  new ApsError('ValidationError', `The document URL ${url} is refused: ${why}`, { suggestions: ['Only public https pages are read as documents. Save the page as a file in the workspace to use it otherwise.'] });

/** Checks a URL string and returns it parsed; throws the reason a document may not be fetched from it. */
export function checkDocumentUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw refuse(raw, 'it is not a URL');
  }
  if (u.protocol !== 'https:') throw refuse(raw, 'only https is allowed');
  if (u.username || u.password) throw refuse(raw, 'it carries a user name or password');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw refuse(raw, 'it is a local address');
  if (isIP(host) && isPrivateAddress(host)) throw refuse(raw, 'it is a private or local address');
  return u;
}

async function assertPublic(host: string, resolve: NonNullable<GuardDeps['resolve']>, url: string): Promise<void> {
  const h = host.replace(/^\[|\]$/g, '');
  const addrs = isIP(h) ? [h] : await resolve(h).catch(() => []);
  if (!addrs.length) throw refuse(url, 'the host does not resolve');
  const bad = addrs.find((a) => isPrivateAddress(a));
  if (bad) throw refuse(url, `${h} resolves to a private or local address (${bad})`);
}

/** The connect-time check: the address the socket is about to use must be public (the real defence against rebinding). */
const guardedLookup = ((hostname: string, options: object, cb: (e: NodeJS.ErrnoException | null, a: unknown, f?: number) => void) => {
  dnsLookup(hostname, options as never, ((err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => {
    if (err) return cb(err, address, family);
    const list = Array.isArray(address) ? address : [{ address, family: family ?? 4 }];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad) return cb(Object.assign(new Error(`${hostname} resolves to a private address`), { code: 'EACCES' }), address, family);
    cb(null, address, family);
  }) as never);
}) as never;

// undici loads with the first document fetched, not at startup
let agent: unknown;
const defaultFetch: NonNullable<GuardDeps['fetchImpl']> = async (url, init) => {
  const u = await import('undici');
  agent ??= new u.Agent({ connect: { lookup: guardedLookup } });
  return (await u.fetch(url, { ...init, dispatcher: agent as never })) as never;
};

async function readCapped(body: Pick<Response, 'body'>['body'], url: string): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_DOC_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw refuse(url, `it is larger than ${MAX_DOC_BYTES / 1024 / 1024} MB`);
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

/** The text of a document at a public https URL; `html` says the page must be turned into text. */
export async function fetchDocument(raw: string, deps: GuardDeps = {}): Promise<{ url: string; text: string; html: boolean }> {
  const resolve = deps.resolve ?? (async (h: string) => (await dns.lookup(h, { all: true })).map((a) => a.address));
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  let u = checkDocumentUrl(raw);
  const origin = u.hostname.toLowerCase();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      await assertPublic(u.hostname, resolve, u.href);
      const res = await fetchImpl(u.href, { signal: ac.signal, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc || hop >= MAX_REDIRECTS) throw refuse(raw, hop >= MAX_REDIRECTS ? `more than ${MAX_REDIRECTS} redirects` : 'a redirect without a location');
        const next = checkDocumentUrl(new URL(loc, u).href);
        if (next.hostname.toLowerCase() !== origin) throw refuse(raw, `it redirects to another host (${next.hostname})`);
        u = next;
        continue;
      }
      if (res.status !== 200) throw refuse(raw, `the server answered HTTP ${res.status}`);
      const type = res.headers.get('content-type') ?? '';
      if (!TYPES.test(type)) throw refuse(raw, `its type is ${type || 'unknown'}; text/html, text/plain and text/markdown are read`);
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > MAX_DOC_BYTES) throw refuse(raw, `it is larger than ${MAX_DOC_BYTES / 1024 / 1024} MB`);
      return { url: u.href, text: await readCapped(res.body, raw), html: /html/i.test(type) };
    }
  } catch (e) {
    if (e instanceof ApsError) throw e;
    throw refuse(raw, ac.signal.aborted ? 'it took longer than 30 seconds' : (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}
