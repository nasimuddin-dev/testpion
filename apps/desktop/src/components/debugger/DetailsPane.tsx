import { prettyBody } from '../../lib/pretty';
import { CodeBlock } from '../CodeBlock';
import { Copy } from 'lucide-react';
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge, Button, Empty, FilterInput, SectionTitle, Tabs } from '../ui';
import { JsonTree, RawView } from '../JsonView';
import { JwtView } from '../JwtView';
import { hexDump, type Exchange } from './model';
import { copyText } from '../../lib/clipboard';

/** One side of an exchange: a header table with its start line, the body, the raw text, the body as JSON, the views that fit the body, and extras. */

const parseJson = (text?: string) => {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** A body above this many characters is laid out after the pane painted (the frame is not spent on it). */
const HEAVY_BODY_CHARS = 64 * 1024;

/**
 * `fn(text)` once per text (a capture sync re-renders the panes several times a second; the body did not change). A small
 * text is laid out in the render; a big one in the next task, with the text itself shown until then.
 */
function useLaidOut(text: string | undefined, fn: (t: string) => string): string | undefined {
  const heavy = !!text && text.length > HEAVY_BODY_CHARS;
  const small = useMemo(() => (text && !heavy ? fn(text) : undefined), [text, heavy, fn]);
  const [big, setBig] = useState<{ text: string; out: string }>();
  useEffect(() => {
    if (!heavy || !text) return;
    const t = setTimeout(() => setBig({ text, out: fn(text) }), 0);
    return () => clearTimeout(t);
  }, [text, heavy, fn]);
  if (!text) return undefined;
  return heavy ? (big?.text === text ? big.out : text) : small;
}

const pretty = (t: string) => prettyBody(t);

export interface ExtraTab {
  id: string;
  label: string;
  badge?: string | number;
  render(): ReactNode;
}

/** One side of an exchange: a header table with its start line, the body, the raw text, the body as JSON, and extras. */
export function DetailsPane({
  title,
  side,
  startLabel,
  startLine,
  headers,
  trailers,
  body,
  bodyNote,
  raw,
  extra,
  initial,
  exchangeId,
}: {
  /** Another exchange starts on its first tab with no header filter, as a new pane would, without remounting the pane. */
  exchangeId: string;
  title: string;
  side: 'request' | 'response';
  startLabel: string;
  startLine: string;
  headers?: Record<string, string>;
  trailers?: Record<string, string>;
  body?: string;
  bodyNote: string;
  raw: string;
  extra: ExtraTab[];
  initial?: string;
}) {
  const [tab, setTab] = useState<string>(initial ?? 'header');
  const [find, setFind] = useState('');
  const [shownId, setShownId] = useState(exchangeId);
  if (shownId !== exchangeId) {
    setShownId(exchangeId);
    setTab(initial ?? 'header');
    setFind('');
  }
  const json = useMemo(() => (tab === 'json' ? parseJson(body) : undefined), [tab, body]);
  const content = useLaidOut(tab === 'content' ? body : undefined, pretty);
  const f = find.trim().toLowerCase();
  const rows = (h?: Record<string, string>) => Object.entries(h ?? {}).filter(([k, v]) => !f || k.toLowerCase().includes(f) || v.toLowerCase().includes(f));
  const current = extra.find((x) => x.id === tab);
  return (
    <div className="h-full flex flex-col min-h-0" data-details-pane={side}>
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line bg-panel/60 shrink-0">
        <span className="text-sm font-semibold">{title}</span>
        {tab === 'header' && <FilterInput className="ml-auto w-48" placeholder="Filter headers" label={`Filter ${side} headers`} value={find} onChange={setFind} />}
        {(tab === 'raw' || tab === 'content') && (
          <Button size="sm" variant="ghost" className="ml-auto" icon={<Copy size={12} />} onClick={() => void copyText(tab === 'raw' ? raw : (body ?? ''), `the ${tab} of the ${side}`)}>
            Copy
          </Button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {tab === 'header' && (
          <table className="text-xs w-full border-collapse" data-header-table={side}>
            <thead className="sticky top-0 bg-panel text-muted">
              <tr>
                <th className="text-left font-medium px-2 py-1 w-2/5 border-b border-line">Header</th>
                <th className="text-left font-medium px-2 py-1 border-b border-line">Value</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-line/60 font-semibold">
                <td className="px-2 py-1">{startLabel}</td>
                <td className="px-2 py-1 mono break-all">{startLine}</td>
              </tr>
              {rows(headers).map(([k, v]) => (
                <tr key={k} className="border-b border-line/60 hover:bg-hover">
                  <td className="px-2 py-1 whitespace-nowrap align-top">{k}</td>
                  <td className="px-2 py-1 mono break-all">{v}</td>
                </tr>
              ))}
              {trailers && Object.keys(trailers).length > 0 && (
                <>
                  <tr className="border-b border-line/60 font-semibold">
                    <td className="px-2 py-1" colSpan={2}>
                      [Trailers]
                    </td>
                  </tr>
                  {rows(trailers).map(([k, v]) => (
                    <tr key={`t-${k}`} className="border-b border-line/60 hover:bg-hover">
                      <td className="px-2 py-1 whitespace-nowrap align-top">{k}</td>
                      <td className="px-2 py-1 mono break-all">{v}</td>
                    </tr>
                  ))}
                </>
              )}
            </tbody>
          </table>
        )}
        {tab === 'content' && (content !== undefined ? <RawView text={content} /> : <CodeBlock className="p-3 text-xs mono whitespace-pre-wrap break-all" text={bodyNote} />)}
        {tab === 'raw' && <CodeBlock className="p-3 text-xs mono whitespace-pre-wrap break-all" language={'http'} text={raw} />}
        {tab === 'json' && (json !== undefined ? <JsonTree data={json} /> : <Empty title="Not JSON">{body ? 'The body is not JSON: see Content.' : bodyNote}</Empty>)}
        {current?.render()}
      </div>
      <Tabs label="Message details"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'header', label: 'Header', badge: Object.keys(headers ?? {}).length || undefined },
          { id: 'content', label: 'Content' },
          { id: 'raw', label: 'Raw' },
          { id: 'json', label: 'JSON' },
          ...extra.map((x) => ({ id: x.id, label: x.label, badge: x.badge })),
        ]}
      />
    </div>
  );
}

export const HexView = memo(function HexView({ text }: { text?: string }) {
  const dump = useLaidOut(text, hexDump);
  return (
    <div className="p-3 grid gap-2">
      <pre className="text-xs mono whitespace-pre rounded border border-line p-2 bg-panel overflow-auto">{dump ?? '(no body kept)'}</pre>
      <p className="text-xs text-muted">Binary bodies are counted, not kept; text bodies are shown as their UTF-8 bytes.</p>
    </div>
  );
});

/** The Auth inspector: the scheme, the user, a JWT decoded, the cookies by name; never a secret's value. */
export function AuthView({ e }: { e: Exchange }) {
  if (!e.auth) return <div className="p-3 text-sm text-muted">No credentials in this exchange: no Authorization header, no cookies.</div>;
  const names = (title: string, list: string[]) =>
    list.length > 0 && (
      <div>
        <SectionTitle size="sm" className="mb-1">{title}</SectionTitle>
        <div className="flex gap-1 flex-wrap">
          {list.map((c) => (
            <Badge key={c}>{c}</Badge>
          ))}
        </div>
      </div>
    );
  return (
    <div className="p-3 grid gap-3 text-sm">
      <div>
        <span className="text-muted">Scheme</span> <Badge tone={e.auth.scheme === 'none' ? 'default' : 'accent'}>{e.auth.scheme}</Badge>
        {e.auth.user && (
          <>
            {' '}
            <span className="text-muted">user</span> <span className="mono">{e.auth.user}</span>
          </>
        )}
      </div>
      {e.auth.note && <p className="text-xs text-warn">{e.auth.note}</p>}
      {e.auth.jwt && (
        <div className="h-80 min-h-0 rounded border border-line">
          <JwtView tokens={[e.auth.jwt]} />
        </div>
      )}
      {names('Cookies sent', e.auth.cookies)}
      {names('Cookies set by the response', e.auth.setCookies)}
      <p className="text-xs text-muted">Values are never shown here: a captured token must not leave the session by a screenshot.</p>
    </div>
  );
}
