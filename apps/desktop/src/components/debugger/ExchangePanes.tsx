import { Bot, ChevronDown, Copy, ExternalLink, Pause, Play, Scale, Star, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { formatBytes } from '@testpion/shared';
import { useApp } from '../../store';
import { Badge, Button, Empty, Input, Menu, Split, statusTone, Tabs } from '../ui';
import { JsonTree } from '../JsonView';
import { JwtView } from '../JwtView';
import { EventsView, FramesView, GrpcView } from '../DebuggerTools';
import { curlOf, hexDump, rawOf, versionOf, type Exchange } from './model';

const toast = (m: string) => useApp.getState().toast(m, 'success');
const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => toast(`Copied ${what}`));
const parseJson = (text?: string) => {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** What can be done with the exchange shown: a captured one has every action; a request a mock server received only the first three. */
export interface ExchangeActions {
  onOpen(): void;
  onAsk(): void;
  onResend?(): void;
  onBookmark?(): void;
  onDelete?(): void;
  onCompare?(): void;
  onRule?(preset: string): void;
}

/**
 * The selected exchange, the HTTP Debugger Pro way: its actions on one line, then Request Details and Response Details
 * side by side. Each pane is a header table (the start line first, a filter on top) with Header / Content / Raw / JSON
 * tabs at the bottom, plus what the exchange has: credentials and bytes on the request, gRPC messages, WebSocket frames
 * or events on the response.
 */
export function ExchangePanes({ e, ...a }: { e: Exchange } & ExchangeActions) {
  const raw = useMemo(() => rawOf(e), [e]);
  const path = (() => {
    try {
      const u = new URL(e.url);
      return u.pathname + u.search;
    } catch {
      return e.url;
    }
  })();
  const version = versionOf(e);
  const tunnel = e.kind === 'tunnel';
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line text-sm shrink-0 whitespace-nowrap overflow-hidden">
        <Badge tone={e.error ? 'bad' : statusTone(e.status)}>{e.error ? 'error' : `${e.status ?? '…'} ${e.statusText ?? ''}`}</Badge>
        <span className="mono text-xs truncate" title={e.url}>
          {e.method} {e.url}
        </span>
        <span className="ml-auto flex items-center gap-1 shrink-0">
          <Button size="sm" variant="ghost" icon={<ExternalLink size={12} />} onClick={a.onOpen} title="Edit & Submit: open it as a request in a tab, to change and send">
            Open
          </Button>
          {a.onResend && (
            <Button size="sm" variant="ghost" icon={<Play size={12} />} onClick={a.onResend} title="Send it again as it was">
              Resend
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => copy(curlOf(e), 'as cURL')}>
            cURL
          </Button>
          <Button size="sm" variant="ghost" icon={<Bot size={12} />} onClick={a.onAsk} title="Ask the AI assistant what this exchange does, why it failed, what to check (sent redacted)">
            Ask AI
          </Button>
          {a.onCompare && (
            <Button size="sm" variant="ghost" icon={<Scale size={12} />} onClick={a.onCompare} title="Compare with another exchange: click it next">
              Compare
            </Button>
          )}
          {a.onRule && (
            <Menu
              width={280}
              items={[
                { label: `Reply with this response from now on`, icon: <Play size={14} />, onSelect: () => a.onRule!('reply-with-this') },
                { label: `Filter out ${e.host}`, onSelect: () => a.onRule!('ignore') },
                { label: `Capture only ${e.host}`, onSelect: () => a.onRule!('only') },
                { label: `Highlight ${e.host}`, onSelect: () => a.onRule!('highlight') },
                { label: `Offline: reply 503 for ${e.host}`, onSelect: () => a.onRule!('offline') },
                { label: `Slow down ${e.host} by 2 s`, onSelect: () => a.onRule!('slow') },
                { label: `Allow CORS for ${e.host}`, onSelect: () => a.onRule!('cors') },
                { label: `Pause every request to ${e.host}`, icon: <Pause size={14} />, onSelect: () => a.onRule!('break-request') },
              ]}
              trigger={
                <Button size="sm" variant="ghost" title="Add a rule for this exchange's host">
                  Rule <ChevronDown size={12} />
                </Button>
              }
            />
          )}
          {a.onBookmark && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Star size={12} className={e.bookmarked ? 'fill-current text-warn' : ''} />}
              onClick={a.onBookmark}
              title={e.bookmarked ? 'Remove the bookmark' : 'Bookmark'}
            >
              {e.bookmarked ? 'Bookmarked' : 'Bookmark'}
            </Button>
          )}
          {a.onDelete && (
            <Button size="sm" variant="ghost" icon={<X size={12} />} onClick={a.onDelete} title="Remove from the session">
              Delete
            </Button>
          )}
        </span>
      </div>
      {e.error && <div className="px-3 py-2 text-sm text-bad border-b border-line">{e.error}</div>}
      {(e.rules?.length || e.redirectedTo || e.repliedByRule || e.edited) && (
        <div className="px-3 py-1.5 text-xs border-b border-line flex gap-2 flex-wrap items-center text-muted">
          <Scale size={12} />
          {e.repliedByRule && <Badge tone="warn">answered by a rule</Badge>}
          {e.redirectedTo && (
            <Badge tone="warn" title={e.redirectedTo}>
              redirected to {e.redirectedTo.replace(/^https?:\/\//, '').split('/')[0]}
            </Badge>
          )}
          {e.edited && <Badge tone="warn">edited at a breakpoint</Badge>}
          {e.rules?.map((r) => (
            <Badge key={r}>{r}</Badge>
          ))}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <Split id="debugger-panes" initial={50}>
          <DetailsPane
            key={`req-${e.id}`}
            title="Request Details"
            side="request"
            startLabel="[Request]"
            startLine={tunnel ? `CONNECT ${e.host}` : `${e.method} ${path} ${version}`}
            headers={e.requestHeaders}
            body={e.requestBody}
            bodyNote={e.requestBodyBytes ? `(${formatBytes(e.requestBodyBytes)}, ${e.bodiesDropped ? 'let go to keep the session within its memory budget' : 'not kept'})` : '(no body)'}
            raw={raw.request}
            extra={[
              {
                id: 'auth',
                label: 'Auth',
                badge: e.auth && e.auth.scheme !== 'none' ? e.auth.scheme.split(' ')[0] : undefined,
                render: () => <AuthView e={e} />,
              },
              { id: 'hex', label: 'Hex', render: () => <HexView text={e.requestBody} /> },
            ]}
          />
          <DetailsPane
            key={`res-${e.id}`}
            title="Response Details"
            side="response"
            startLabel="[Response]"
            startLine={e.error ? `error: ${e.error}` : e.status ? `${version} ${e.status} ${e.statusText ?? ''}`.trim() : '(waiting for the response)'}
            headers={e.responseHeaders}
            trailers={e.trailers}
            body={e.responseBody}
            bodyNote={
              tunnel
                ? `An HTTPS tunnel: ${formatBytes(e.requestBodyBytes)} sent, ${formatBytes(e.responseBodyBytes)} received, encrypted end to end. Turn on HTTPS tunnel ▸ Decrypt HTTPS and trust the TestPion root certificate to see the requests inside.`
                : e.responseBodyBytes
                  ? `(${formatBytes(e.responseBodyBytes)} of ${e.contentType ?? 'binary'}, not kept)`
                  : '(empty)'
            }
            raw={raw.response}
            initial={e.grpc ? 'grpc' : e.frames ? 'frames' : e.events?.length ? 'events' : undefined}
            extra={[
              { id: 'hex', label: 'Hex', render: () => <HexView text={e.responseBody} /> },
              ...(e.grpc ? [{ id: 'grpc', label: 'gRPC', badge: e.grpc.requests.length + e.grpc.responses.length, render: () => <GrpcView call={e.grpc!} open={e.open} /> }] : []),
              ...(e.frames ? [{ id: 'frames', label: 'Frames', badge: e.frames.length, render: () => <FramesView frames={e.frames!} open={e.open} /> }] : []),
              ...(e.events ? [{ id: 'events', label: 'Events', badge: e.events.length, render: () => <EventsView events={e.events!} open={e.open} /> }] : []),
            ]}
          />
        </Split>
      </div>
    </div>
  );
}

interface ExtraTab {
  id: string;
  label: string;
  badge?: string | number;
  render(): ReactNode;
}

/** One side of an exchange: a header table with its start line, the body, the raw text, the body as JSON, and extras. */
function DetailsPane({
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
}: {
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
  const json = useMemo(() => parseJson(body), [body]);
  const f = find.trim().toLowerCase();
  const rows = (h?: Record<string, string>) => Object.entries(h ?? {}).filter(([k, v]) => !f || k.toLowerCase().includes(f) || v.toLowerCase().includes(f));
  const current = extra.find((x) => x.id === tab);
  return (
    <div className="h-full flex flex-col min-h-0" data-details-pane={side}>
      <div className="flex items-center gap-2 px-3 h-8 border-b border-line bg-panel/60 shrink-0">
        <span className="text-sm font-semibold">{title}</span>
        {tab === 'header' && <Input className="ml-auto w-48 h-6 text-xs" placeholder="Filter headers" aria-label={`Filter ${side} headers`} value={find} onChange={(ev) => setFind(ev.target.value)} />}
        {(tab === 'raw' || tab === 'content') && (
          <Button size="sm" variant="ghost" className="ml-auto" icon={<Copy size={12} />} onClick={() => copy(tab === 'raw' ? raw : (body ?? ''), `the ${tab} of the ${side}`)}>
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
        {tab === 'content' && <pre className="p-3 text-xs mono whitespace-pre-wrap break-all">{body ?? bodyNote}</pre>}
        {tab === 'raw' && <pre className="p-3 text-xs mono whitespace-pre-wrap break-all">{raw}</pre>}
        {tab === 'json' && (json !== undefined ? <JsonTree data={json} /> : <Empty title="Not JSON">{body ? 'The body is not JSON: see Content.' : bodyNote}</Empty>)}
        {current?.render()}
      </div>
      <Tabs
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

function HexView({ text }: { text?: string }) {
  return (
    <div className="p-3 grid gap-2">
      <pre className="text-xs mono whitespace-pre rounded border border-line p-2 bg-panel overflow-auto">{text ? hexDump(text) : '(no body kept)'}</pre>
      <p className="text-xs text-muted">Binary bodies are counted, not kept; text bodies are shown as their UTF-8 bytes.</p>
    </div>
  );
}

/** The Auth inspector: the scheme, the user, a JWT decoded, the cookies by name; never a secret's value. */
function AuthView({ e }: { e: Exchange }) {
  if (!e.auth) return <div className="p-3 text-sm text-muted">No credentials in this exchange: no Authorization header, no cookies.</div>;
  const names = (title: string, list: string[]) =>
    list.length > 0 && (
      <div>
        <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">{title}</div>
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
