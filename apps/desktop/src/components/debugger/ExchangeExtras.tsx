import type { ReactNode } from 'react';
import { Empty } from '../ui';
import type { Exchange } from './model';

/** The inspector tabs of a selected exchange beyond headers and body: what it carried, who sent it, what went wrong. */

const cell = 'px-2 py-1 border-b border-line/60';

function Table({ head, rows, name }: { head: [string, string]; rows: Array<[string, ReactNode]>; name: string }) {
  return (
    <table className="text-xs w-full border-collapse" data-inspector-table={name}>
      <thead className="sticky top-0 bg-panel text-muted">
        <tr>
          <th className="text-left font-medium px-2 py-1 w-2/5 border-b border-line">{head[0]}</th>
          <th className="text-left font-medium px-2 py-1 border-b border-line">{head[1]}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, v], i) => (
          <tr key={`${k}-${i}`} className="hover:bg-hover">
            <td className={`${cell} whitespace-nowrap align-top`}>{k}</td>
            <td className={`${cell} mono break-all`}>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
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

const headerOf = (h: Record<string, string> | undefined, name: string) => Object.entries(h ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];

/** The query string and, for a form body, its fields: decoded, one row each. */
export function paramsOf(e: Exchange): { query: Array<[string, string]>; form: Array<[string, string]> } {
  let query: Array<[string, string]> = [];
  try {
    query = pairs(new URL(e.url).search.replace(/^\?/, ''));
  } catch {
    /* not a URL: no query */
  }
  const type = (e.requestContentType ?? headerOf(e.requestHeaders, 'content-type') ?? '').toLowerCase();
  const form = type.includes('application/x-www-form-urlencoded') && e.requestBody ? pairs(e.requestBody) : [];
  return { query, form };
}

export function ParamsView({ e }: { e: Exchange }) {
  const { query, form } = paramsOf(e);
  if (!query.length && !form.length) return <Empty title="No parameters">The URL has no query string and the body is not a form.</Empty>;
  return (
    <div data-inspector="params">
      {query.length > 0 && <Table name="query" head={['Query parameter', 'Value']} rows={query} />}
      {form.length > 0 && <Table name="form" head={['Form field', 'Value']} rows={form} />}
    </div>
  );
}

/** `Set-Cookie` headers can arrive joined by commas: split where a new `name=` starts, not inside an Expires date. */
const splitSetCookie = (v: string) => v.split(/\n|,(?=\s*[^;,=\s]+=)/).map((x) => x.trim()).filter(Boolean);

export function cookiesOf(e: Exchange, side: 'request' | 'response'): Array<[string, string]> {
  if (side === 'request') {
    const v = headerOf(e.requestHeaders, 'cookie');
    return v ? v.split(';').map((p) => p.trim()).filter(Boolean).map((p) => { const i = p.indexOf('='); return (i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]) as [string, string]; }) : [];
  }
  const v = headerOf(e.responseHeaders, 'set-cookie');
  return v
    ? splitSetCookie(v).map((c) => {
        const [first = '', ...attrs] = c.split(';');
        const i = first.indexOf('=');
        return [i < 0 ? first : first.slice(0, i), `${i < 0 ? '' : first.slice(i + 1)}${attrs.length ? `   (${attrs.map((a) => a.trim()).join('; ')})` : ''}`] as [string, string];
      })
    : [];
}

export function CookiesView({ e, side }: { e: Exchange; side: 'request' | 'response' }) {
  const rows = cookiesOf(e, side);
  if (!rows.length) return <Empty title="No cookies">{side === 'request' ? 'The request has no Cookie header.' : 'The response sets no cookies.'}</Empty>;
  return <Table name={`cookies-${side}`} head={['Cookie', side === 'request' ? 'Value' : 'Value and attributes']} rows={rows} />;
}

/** The program refused TestPion's certificate (it does not trust the root, or pins its own). */
export const certificateError = (e: Pick<Exchange, 'error'>) => /certificate/i.test(e.error ?? '');

/** What the usual error messages mean and what to do about them. */
export function adviceFor(e: Exchange): string[] {
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

export function ErrorView({ e }: { e: Exchange }) {
  const advice = adviceFor(e);
  return (
    <div className="p-3 text-sm grid gap-3" data-inspector="error">
      <div className="text-bad">{e.error ?? (e.status ? `The server answered ${e.status} ${e.statusText ?? ''}`.trim() : 'No error')}</div>
      {advice.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-muted mb-1">What to check</div>
          <ul className="list-disc pl-5 grid gap-1">
            {advice.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
