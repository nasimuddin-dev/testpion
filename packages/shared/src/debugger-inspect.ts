/**
 * What a captured exchange carried, read for a person or an agent: the query string and form fields, the cookies, and the
 * advice for the usual errors. The Debugger's inspector tabs (Params, Cookies, Error) and the `debugger_exchanges` tool both
 * read these, so they say the same. Pure; an exchange is only the fields it looks at.
 */

export interface InspectedExchange {
  url: string;
  status?: number;
  error?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  /** In the Debugger's list the headers come as sizes only: the content type is kept apart. */
  requestContentType?: string;
  /** The names of the cookies, when the headers' values are masked (the Debugger keeps them apart). */
  auth?: { cookies?: string[]; setCookies?: string[] };
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};
const pairs = (query: string): Array<[string, string]> =>
  query
    .split('&')
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? [decode(p), ''] : [decode(p.slice(0, i)), decode(p.slice(i + 1))];
    });

export const headerOf = (h: Record<string, string> | undefined, name: string) => Object.entries(h ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];

/** The query string and, for a form body, its fields: decoded, one row each. */
export function paramsOf(e: InspectedExchange): { query: Array<[string, string]>; form: Array<[string, string]> } {
  // (no URL class in this package: the query is what follows the first ? up to a #)
  const q = /^[a-z][a-z0-9+.-]*:\/\//i.test(e.url) ? e.url.split('#')[0]!.split('?').slice(1).join('?') : '';
  const query = pairs(q);
  const type = (e.requestContentType ?? headerOf(e.requestHeaders, 'content-type') ?? '').toLowerCase();
  const form = type.includes('application/x-www-form-urlencoded') && e.requestBody ? pairs(e.requestBody) : [];
  return { query, form };
}

/**
 * `Set-Cookie` values can arrive joined: split on a new line, or on a comma and a space before the next `name=`, never inside an
 * `Expires` date or a value such as `prefs=a=1,b=2`.
 */
export const splitSetCookie = (v: string) => v.split(/\n|,(?=\s+[^;,=\s]+=)/).map((x) => x.trim()).filter(Boolean);

const MASK = '***';
const isMasked = (v: string | undefined) => !!v && /^\*+$/.test(v.trim());

export function cookiesOf(e: InspectedExchange, side: 'request' | 'response'): Array<[string, string]> {
  if (side === 'request') {
    const v = headerOf(e.requestHeaders, 'cookie');
    // a masked header (secrets are never shown) has no names to split: the names come from the exchange's own list, the values stay masked
    if (isMasked(v) && e.auth?.cookies?.length) return e.auth.cookies.map((n) => [n, MASK] as [string, string]);
    return v
      ? v
          .split(';')
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => {
            const i = p.indexOf('=');
            return (i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]) as [string, string];
          })
      : [];
  }
  const v = headerOf(e.responseHeaders, 'set-cookie');
  if (isMasked(v) && e.auth?.setCookies?.length) return e.auth.setCookies.map((n) => [n, MASK] as [string, string]);
  return v
    ? splitSetCookie(v).map((c) => {
        const [first = '', ...attrs] = c.split(';');
        const i = first.indexOf('=');
        return [i < 0 ? first : first.slice(0, i), `${i < 0 ? '' : first.slice(i + 1)}${attrs.length ? `   (${attrs.map((a) => a.trim()).join('; ')})` : ''}`] as [string, string];
      })
    : [];
}

/** The program refused TestPion's certificate (it does not trust the root, or pins its own). */
export const certificateError = (e: Pick<InspectedExchange, 'error'>) => /certificate/i.test(e.error ?? '');

/** What the usual error messages mean and what to do about them. */
export function adviceFor(e: InspectedExchange): string[] {
  const m = `${e.error ?? ''}`.toLowerCase();
  if (certificateError(e))
    return [
      'The program refused the certificate TestPion presents for HTTPS. Click HTTPS ▸ See inside HTTPS… (TestPion asks once to trust its certificate) and restart the program.',
      'Some programs ignore the system certificate store or pin their own certificate (OneDrive, banking, many apps): keep that host encrypted (right-click the row ▸ Keep this host encrypted).',
    ];
  if (/econnrefused|refused/.test(m)) return ['Nothing is listening at that address and port. Check the server is running and the port is right.', 'A firewall or a rule that redirects this host can also refuse it.'];
  if (/enotfound|getaddrinfo|dns/.test(m)) return ['The host name could not be found. Check the spelling and the network (VPN, DNS).'];
  if (/timed out|timeout|etimedout/.test(m)) return ['The server did not answer in time. Check the server and the network; a slow-down rule would cause this too.'];
  if (/econnreset|socket hang up|closed/.test(m)) return ['The connection was closed before the answer arrived. The server may have crashed, or a proxy or firewall cut it.'];
  if (e.status && e.status >= 500) return ['The server failed. Look at the response body for its message, and at the server log.'];
  if (e.status === 401 || e.status === 403) return ['The server refused the credentials. See the Auth tab: is the token there, not expired, for the right audience or scope?'];
  if (e.status === 404) return ['The path was not found. Compare the URL (Params and Summary tabs) with what the API expects.'];
  if (e.status && e.status >= 400) return ['The server rejected the request. Its response body usually says why (Content tab); then check the request headers and the body.'];
  return [];
}
