/**
 * The Caching inspector (FG-10): would a browser cache this response, for how long, and how will it be checked again. Read from
 * the response's headers the way RFC 9111 describes a private (browser) cache, in plain words. Pure; the Debugger's Summary
 * tab and `debugger_exchange` (view "caching") both read it.
 */
import { headerOf } from './debugger-inspect.js';

export interface CachingInput {
  method?: string;
  status?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

export type CacheVerdict = 'fresh-cacheable' | 'revalidate' | 'not-cacheable' | 'unknown';

export interface CachingReport {
  verdict: CacheVerdict;
  /** One sentence for a person. */
  summary: string;
  /** Seconds the response stays fresh from when it was generated (max-age, or Expires minus Date). */
  freshSeconds?: number;
  /** Seconds it has already been in caches (Age). */
  ageSeconds?: number;
  /** Freshness guessed (10% of the time since Last-Modified) because no lifetime was given. */
  heuristic?: boolean;
  directives: string[];
  validators: Array<{ header: string; value: string }>;
  /** What else shapes the cache: Vary, Pragma, Set-Cookie. */
  notes: string[];
}

/** Statuses a cache may store by default (RFC 9110 15.1). */
const CACHEABLE_BY_DEFAULT = new Set([200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501]);

export const cacheDuration = (s: number) => {
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round((s / 3600) * 10) / 10} h`;
  return `${Math.round((s / 86400) * 10) / 10} days`;
};
const dur = cacheDuration;

export function cachingOf(e: CachingInput): CachingReport {
  const h = e.responseHeaders;
  const rep: CachingReport = { verdict: 'unknown', summary: '', directives: [], validators: [], notes: [] };
  if (!h || e.status === undefined) return { ...rep, summary: 'No response yet, so nothing to say about caching.' };
  const cc = (headerOf(h, 'cache-control') ?? '').toLowerCase();
  const dirs = cc.split(',').map((d) => d.trim()).filter(Boolean);
  rep.directives = dirs;
  const has = (d: string) => dirs.some((x) => x === d || x.startsWith(`${d}=`));
  const num = (d: string) => {
    const m = dirs.find((x) => x.startsWith(`${d}=`));
    const n = m ? Number(m.split('=')[1]!.replace(/"/g, '')) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  for (const v of ['etag', 'last-modified']) {
    const val = headerOf(h, v);
    if (val) rep.validators.push({ header: v === 'etag' ? 'ETag' : 'Last-Modified', value: val });
  }
  const age = Number(headerOf(h, 'age'));
  if (headerOf(h, 'age') !== undefined && Number.isFinite(age) && age >= 0) rep.ageSeconds = age;
  const vary = headerOf(h, 'vary');
  if (vary) rep.notes.push(vary.trim() === '*' ? 'Vary: * means every request is different: a cache cannot reuse it.' : `Vary: ${vary}. A cached copy is only reused for a request with the same ${vary}.`);
  if (headerOf(h, 'set-cookie')) rep.notes.push('The response sets a cookie; a shared cache (CDN, proxy) will not store it unless told to.');
  if (/no-cache/i.test(headerOf(h, 'pragma') ?? '') && !cc) rep.notes.push('Pragma: no-cache is an old way to say no-cache; modern caches prefer Cache-Control.');
  const method = (e.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return { ...rep, verdict: 'not-cacheable', summary: `${method} responses are not cached by browsers.` };
  if (e.status === 304) return { ...rep, verdict: 'unknown', summary: 'Not Modified: the browser asked "has it changed?" and was told no. The copy it already had is used again.' };
  if (has('no-store')) return { ...rep, verdict: 'not-cacheable', summary: 'Cache-Control: no-store. Nothing is kept: every visit goes to the server.' };
  if (!CACHEABLE_BY_DEFAULT.has(e.status) && !has('max-age') && !has('public') && !headerOf(h, 'expires')) return { ...rep, verdict: 'not-cacheable', summary: `A ${e.status} response is not cached unless it says so (no max-age, public or Expires).` };
  if (has('no-cache')) {
    return {
      ...rep,
      verdict: 'revalidate',
      summary: rep.validators.length
        ? 'Cache-Control: no-cache. It may be kept, but the browser must ask the server (with the validator) before every reuse; a 304 answer saves the download.'
        : 'Cache-Control: no-cache and no ETag or Last-Modified: it is downloaded again every time.',
    };
  }
  const dateMs = Date.parse(headerOf(h, 'date') ?? '');
  const expiresRaw = headerOf(h, 'expires');
  const expiresMs = expiresRaw ? Date.parse(expiresRaw) : NaN;
  let fresh = num('max-age');
  if (fresh === undefined && expiresRaw) fresh = Number.isNaN(expiresMs) ? 0 : Math.max(0, Math.round((expiresMs - (Number.isNaN(dateMs) ? Date.now() : dateMs)) / 1000));
  if (fresh === undefined) {
    const lm = Date.parse(headerOf(h, 'last-modified') ?? '');
    if (!Number.isNaN(lm) && !Number.isNaN(dateMs) && dateMs > lm) {
      fresh = Math.floor((dateMs - lm) / 1000 / 10);
      rep.heuristic = true;
    }
  }
  rep.freshSeconds = fresh;
  const priv = has('private') ? ' Only the browser keeps it (private), not a shared cache.' : has('public') ? ' A shared cache may keep it too (public).' : '';
  const mustRev = has('must-revalidate') || has('proxy-revalidate') ? ' Once stale it must be checked, never served as is.' : '';
  const immut = has('immutable') ? ' Marked immutable: not even a reload checks it.' : '';
  if (fresh === undefined) {
    return {
      ...rep,
      verdict: rep.validators.length ? 'revalidate' : 'not-cacheable',
      summary: rep.validators.length ? 'No lifetime given. Browsers may guess, then check with the validator before reuse.' : 'No lifetime and no validator: a browser has no reason to keep it, so it is fetched again.',
    };
  }
  if (fresh === 0) return { ...rep, verdict: 'revalidate', summary: `Fresh for 0 seconds: stale at once.${rep.validators.length ? ' The browser checks with the validator each time.' : ''}${mustRev}` };
  const left = rep.ageSeconds !== undefined ? ` ${rep.ageSeconds >= fresh ? 'Already stale' : `${dur(fresh - rep.ageSeconds)} left`} (it has been in caches for ${dur(rep.ageSeconds)}).` : '';
  return {
    ...rep,
    verdict: 'fresh-cacheable',
    summary: `Yes: reused without asking the server for ${dur(fresh)}${rep.heuristic ? ' (a guess from Last-Modified: the server gave no lifetime)' : ''}.${left}${priv}${mustRev}${immut}`,
  };
}
