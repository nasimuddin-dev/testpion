import { bundleWsdl, isWsdl } from './wsdl.js';
import { assertUrlAllowed, isPlainHttpAllowed } from '../net/policy.js';
import { ApsError } from '../errors.js';

/** Largest document fetched for an import. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
/** Redirects followed for one link. */
const MAX_REDIRECTS = 5;

/**
 * The URL to download for an import link: GitHub / GitLab / Bitbucket "view file" pages become their raw
 * file, so a link copied from the browser works.
 */
export function rawImportUrl(link: string): string {
  const u = new URL(link.trim());
  if (u.hostname === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u.pathname);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  }
  if (u.hostname === 'gitlab.com' && u.pathname.includes('/-/blob/')) return `${u.origin}${u.pathname.replace('/-/blob/', '/-/raw/')}`;
  if (u.hostname === 'bitbucket.org' && /\/src\//.test(u.pathname)) return `${u.origin}${u.pathname.replace(/\/src\//, '/raw/')}`;
  return u.toString();
}

/**
 * Download an API definition or collection from a link (OpenAPI URL, a Postman collection link, a raw
 * GitHub file …) for import. http(s) only, at most 20 MB, through the app's proxy settings; the text
 * then goes through the normal importers. Returns the text and a file name taken from the URL.
 */
export async function fetchImportText(link: string, opts: { signal?: AbortSignal; timeoutMs?: number; noWsdlImports?: boolean } = {}): Promise<{ text: string; url: string; fileName?: string }> {
  let url: string;
  try {
    url = rawImportUrl(link);
  } catch {
    throw new ApsError('ValidationError', `"${link}" is not a URL`, { suggestions: ['Paste a link starting with https://'] });
  }
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  let res!: Response;
  // redirects are followed by hand: the network policy is asked about the link and about every hop (a public address can
  // redirect to cloud metadata or localhost); the connection itself is checked again at connect time (policyLookup)
  for (let hop = 0; ; hop++) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new ApsError('ValidationError', 'Only http and https links can be imported', { suggestions: [] });
    if (u.protocol === 'http:' && !isPlainHttpAllowed(u)) throw new ApsError('ConfigurationError', `Blocked by the network policy: ${u.hostname} is not allowed over plain http`, { suggestions: ['Use an https:// link.'] });
    await assertUrlAllowed(u);
    try {
      res = await fetch(url, {
        headers: { accept: 'application/json, application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.5' },
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
        redirect: 'manual',
      });
    } catch (e) {
      throw new ApsError('NetworkError', `Couldn't download ${url}: ${(e as Error).message}`, { suggestions: ['Check the link, the internet connection, and the proxy in Settings ▸ Proxy.'] });
    }
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => undefined);
    if (!location) throw new ApsError('NetworkError', `${url} answered a redirect with no address`, { suggestions: [] });
    if (hop >= MAX_REDIRECTS) throw new ApsError('NetworkError', `${link} redirects too many times`, { suggestions: [] });
    try {
      url = new URL(location, url).toString();
    } catch {
      throw new ApsError('NetworkError', `${u.hostname} redirected to something that is not a link`, { suggestions: [] });
    }
  }
  if (!res.ok) {
    throw new ApsError(res.status === 401 || res.status === 403 || res.status === 404 ? 'ValidationError' : 'NetworkError', `${url} answered HTTP ${res.status}`, {
      suggestions: res.status === 401 || res.status === 403 || res.status === 404 ? ['A private file needs to be downloaded and imported as a file.'] : [],
    });
  }
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_IMPORT_BYTES) throw new ApsError('ValidationError', `The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB`, { suggestions: [] });
  // read with a running limit: content-length can be missing or wrong
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  for (;;) {
    const r = reader ? await reader.read() : { done: true as const, value: undefined };
    if (r.done) break;
    size += r.value.byteLength;
    if (size > MAX_IMPORT_BYTES) {
      await reader?.cancel();
      throw new ApsError('ValidationError', `The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB`, { suggestions: [] });
    }
    chunks.push(r.value);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  if (/^\s*<(!doctype html|html)/i.test(text))
    throw new ApsError('ValidationError', 'The link opens a web page, not a file', { suggestions: ['Use the link of the raw file (for example the "Raw" button on GitHub).'] });
  const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  const finalUrl = url;
  // a WSDL's imported schemas (…?xsd=1) and WSDLs: fetched from the same site only, like the WSDL itself
  if (!opts.noWsdlImports && isWsdl(text)) {
    const origin = new URL(finalUrl).origin;
    const bundled = await bundleWsdl(text, finalUrl, async (loc) => {
      if (new URL(loc).origin !== origin) return undefined;
      await assertUrlAllowed(loc);
      return (await fetchImportText(loc, { ...opts, noWsdlImports: true })).text;
    });
    return { text: bundled, url: finalUrl, fileName: last || undefined };
  }
  return { text: unwrapPostmanApi(text), url: finalUrl, fileName: last || undefined };
}

/** Postman's API (a collection's "share via API" link) wraps the document: {"collection": {...}} / {"environment": {...}}. */
function unwrapPostmanApi(text: string): string {
  if (!/^\s*\{\s*"(collection|environment)"\s*:/.test(text)) return text;
  try {
    const d = JSON.parse(text) as { collection?: { info?: unknown }; environment?: { values?: unknown } };
    const inner = d.collection?.info ? d.collection : Array.isArray(d.environment?.values) ? d.environment : undefined;
    return inner && Object.keys(d).length === 1 ? JSON.stringify(inner) : text;
  } catch {
    return text;
  }
}
