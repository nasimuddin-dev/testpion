import type { ReactNode } from 'react';
import { Empty } from '../ui';
import { adviceFor, certificateError, cookiesOf, paramsOf } from '@testpion/shared';
import type { Exchange } from './model';

// the readers are shared with the MCP tools (@testpion/shared); the window and its tests import them from here
export { adviceFor, certificateError, cookiesOf, paramsOf };

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

export function CookiesView({ e, side }: { e: Exchange; side: 'request' | 'response' }) {
  const rows = cookiesOf(e, side);
  if (!rows.length) return <Empty title="No cookies">{side === 'request' ? 'The request has no Cookie header.' : 'The response sets no cookies.'}</Empty>;
  return <Table name={`cookies-${side}`} head={['Cookie', side === 'request' ? 'Value' : 'Value and attributes']} rows={rows} />;
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
